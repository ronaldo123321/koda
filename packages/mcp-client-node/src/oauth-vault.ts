import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";

import { ThreadLease } from "@koda/runtime-node";
import { z } from "zod";

const MAX_FILE_BYTES = 1_048_576;
const MAX_PLAINTEXT_BYTES = 524_288;
const AAD = Buffer.from("KODA_MCP_OAUTH_V1", "utf8");
const entrySchema = z
  .object({
    serverId: z.string().regex(/^[a-z][a-z0-9_-]{0,23}$/u),
    endpoint: z.url(),
    state: z.unknown(),
  })
  .strict();
const payloadSchema = z
  .object({
    version: z.literal(1),
    entries: z.record(z.string().regex(/^[a-f0-9]{64}$/u), entrySchema),
  })
  .strict();
const envelopeSchema = z
  .object({
    version: z.literal(1),
    nonce: z.string(),
    ciphertext: z.string(),
    tag: z.string(),
  })
  .strict();

type VaultPayload = z.infer<typeof payloadSchema>;

export class McpOAuthVault {
  private constructor(
    private readonly root: string,
    private key: Buffer,
  ) {}

  public static async open(
    kodaHome: string,
    keyBase64: string,
  ): Promise<McpOAuthVault> {
    if (process.platform !== "darwin") {
      throw new Error(
        "MCP OAuth credentials are currently available on macOS only.",
      );
    }
    const root = join(await realpath(kodaHome), "mcp-oauth");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || !ownedByCurrentUser(info.uid)) {
      throw new Error("MCP OAuth vault directory is unsafe.");
    }
    await chmod(root, 0o700);
    const vault = new McpOAuthVault(root, parseKey(keyBase64));
    await vault.read();
    return vault;
  }

  public async load(serverId: string, endpoint: string): Promise<unknown> {
    const id = entryId(serverId, endpoint);
    const entry = (await this.read()).entries[id];
    if (entry === undefined) return undefined;
    if (entry.serverId !== serverId || entry.endpoint !== endpoint) {
      throw new Error("MCP OAuth vault entry does not match its server.");
    }
    return entry.state;
  }

  public async save(
    serverId: string,
    endpoint: string,
    state: unknown,
  ): Promise<void> {
    await this.update(serverId, endpoint, () => state);
  }

  public async remove(serverId: string, endpoint: string): Promise<void> {
    await this.update(serverId, endpoint, () => undefined);
  }

  public async update(
    serverId: string,
    endpoint: string,
    change: (state: unknown) => unknown,
  ): Promise<void> {
    const id = entryId(serverId, endpoint);
    await this.edit((payload) => {
      const current = payload.entries[id];
      if (
        current !== undefined &&
        (current.serverId !== serverId || current.endpoint !== endpoint)
      ) {
        throw new Error("MCP OAuth vault entry does not match its server.");
      }
      const state = change(current?.state);
      if (state === undefined) {
        delete payload.entries[id];
      } else {
        payload.entries[id] = entrySchema.parse({ serverId, endpoint, state });
      }
    });
  }

  public async rotateKey(newKeyBase64: string): Promise<void> {
    const newKey = parseKey(newKeyBase64);
    const lease = await ThreadLease.acquire(this.filePath());
    try {
      const payload = await this.read();
      await this.write(payload, newKey);
      this.key = newKey;
    } finally {
      await lease.release();
    }
  }

  private filePath(): string {
    return join(this.root, "vault.json");
  }

  private async edit(change: (payload: VaultPayload) => void): Promise<void> {
    const lease = await ThreadLease.acquire(this.filePath());
    try {
      const payload = await this.read();
      change(payload);
      await this.write(payload, this.key);
    } finally {
      await lease.release();
    }
  }

  private async read(): Promise<VaultPayload> {
    let handle;
    try {
      handle = await open(
        this.filePath(),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { version: 1, entries: {} };
      throw error;
    }
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        !ownedByCurrentUser(info.uid) ||
        (info.mode & 0o077) !== 0 ||
        info.size > MAX_FILE_BYTES
      ) {
        throw new Error("MCP OAuth vault file is unsafe.");
      }
      const content = await handle.readFile("utf8");
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
        throw new Error("MCP OAuth vault file is too large.");
      }
      try {
        const envelope = envelopeSchema.parse(JSON.parse(content));
        const nonce = parseBase64(envelope.nonce, 12);
        const tag = parseBase64(envelope.tag, 16);
        const ciphertext = parseBase64(envelope.ciphertext);
        const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
        decipher.setAAD(AAD);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]);
        if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
          throw new Error("MCP OAuth vault payload is too large.");
        }
        return payloadSchema.parse(JSON.parse(plaintext.toString("utf8")));
      } catch {
        throw new Error("MCP OAuth vault could not be decrypted or validated.");
      }
    } finally {
      await handle.close();
    }
  }

  private async write(payload: VaultPayload, key: Buffer): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
      throw new Error("MCP OAuth vault payload is too large.");
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const content = JSON.stringify({
      version: 1,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    });
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
      throw new Error("MCP OAuth vault file is too large.");
    }
    const temporary = join(this.root, `vault.${randomUUID()}.tmp`);
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.filePath());
      const directory = await open(this.root, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function entryId(serverId: string, endpoint: string): string {
  if (!/^[a-z][a-z0-9_-]{0,23}$/u.test(serverId)) {
    throw new Error("MCP OAuth server ID is invalid.");
  }
  const url = new URL(endpoint);
  if (
    url.protocol !== "https:" ||
    url.href !== endpoint ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("MCP OAuth endpoint is invalid.");
  }
  return createHash("sha256").update(`${serverId}\n${endpoint}`).digest("hex");
}

function parseKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength !== 32 || key.toString("base64") !== encoded) {
    throw new Error(
      "MCP OAuth vault key must be 32 bytes of canonical Base64.",
    );
  }
  return key;
}

function parseBase64(encoded: string, size?: number): Buffer {
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.toString("base64") !== encoded ||
    (size !== undefined && bytes.byteLength !== size)
  ) {
    throw new Error("MCP OAuth vault envelope is invalid.");
  }
  return bytes;
}

function ownedByCurrentUser(uid: number): boolean {
  return process.getuid === undefined || uid === process.getuid();
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
