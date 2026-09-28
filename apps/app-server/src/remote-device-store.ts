import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import {
  RemoteAccessDeniedError,
  remotePermissionSchema,
  type RemotePrincipal,
  type RemoteWorkspaceGrant,
} from "./remote-access.js";

const DEVICE_FILE_MAX_BYTES = 16 * 1_024;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const idSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const deviceIdSchema = z.string().regex(/^device-[a-f0-9]{32}$/u);
const grantSchema = z
  .object({
    workspaceId: idSchema,
    permissions: z.array(remotePermissionSchema).min(1).max(8),
    mcpServerIds: z
      .array(z.string().regex(/^[a-z][a-z0-9_-]{0,23}$/u))
      .min(1)
      .max(16)
      .optional(),
  })
  .strict()
  .refine(
    (grant) =>
      grant.permissions.includes("mcp:invoke") ===
        (grant.mcpServerIds !== undefined) &&
      (grant.mcpServerIds === undefined ||
        new Set(grant.mcpServerIds).size === grant.mcpServerIds.length),
  );
const deviceFileSchema = z
  .object({
    version: z.literal(1),
    ownerId: idSchema,
    deviceId: deviceIdSchema,
    label: z.string().min(1).max(128),
    secretSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    expiresAt: z.string().datetime({ offset: true }),
    grants: z.array(grantSchema).min(1).max(32),
  })
  .strict();

export interface RemoteDeviceGrantInput {
  workspaceId: string;
  permissions: readonly z.infer<typeof remotePermissionSchema>[];
  mcpServerIds?: readonly string[];
}

export interface IssuedRemoteDevice {
  deviceId: string;
  token: string;
  expiresAt: string;
}

export interface VerifiedRemoteDevice {
  principal: RemotePrincipal;
  grants: RemoteWorkspaceGrant[];
}

export class RemoteDeviceStore {
  private constructor(
    private readonly root: string,
    private readonly ownerId: string,
    private readonly now: () => number,
  ) {}

  public static async open(
    kodaHome: string,
    ownerId: string,
    now: () => number = Date.now,
  ): Promise<RemoteDeviceStore> {
    if (process.platform === "win32") {
      throw new Error("Remote device credentials are unavailable on Windows.");
    }
    idSchema.parse(ownerId);
    const root = join(resolve(kodaHome), "remote", "devices");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || !ownedByCurrentUser(info.uid)) {
      throw new Error("Remote device directory is unsafe.");
    }
    await chmod(root, 0o700);
    return new RemoteDeviceStore(root, ownerId, now);
  }

  public async issue(
    label: string,
    grants: readonly RemoteDeviceGrantInput[],
    ttlMs = 7 * 24 * 60 * 60 * 1_000,
  ): Promise<IssuedRemoteDevice> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > MAX_TTL_MS) {
      throw new RangeError("Remote device lifetime is invalid.");
    }
    const deviceId = `device-${randomUUID().replaceAll("-", "")}`;
    const secret = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now() + ttlMs).toISOString();
    const uniqueWorkspaces = new Set(grants.map((grant) => grant.workspaceId));
    if (
      uniqueWorkspaces.size !== grants.length ||
      grants.some(
        (grant) => new Set(grant.permissions).size !== grant.permissions.length,
      )
    ) {
      throw new Error("Remote device grants are invalid.");
    }
    const file = deviceFileSchema.parse({
      version: 1,
      ownerId: this.ownerId,
      deviceId,
      label,
      secretSha256: sha256(secret),
      expiresAt,
      grants,
    });
    const content = JSON.stringify(file);
    if (Buffer.byteLength(content, "utf8") > DEVICE_FILE_MAX_BYTES) {
      throw new Error("Remote device configuration is too large.");
    }
    await this.writeNewFile(this.filePath(deviceId), content);
    return {
      deviceId,
      token: `koda-r1.${deviceId}.${secret}`,
      expiresAt,
    };
  }

  public async verify(token: string): Promise<VerifiedRemoteDevice> {
    const match = /^koda-r1\.(device-[a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/u.exec(
      token,
    );
    if (match === null) {
      throw new RemoteAccessDeniedError();
    }
    const [, deviceId, secret] = match;
    if (deviceId === undefined || secret === undefined) {
      throw new RemoteAccessDeniedError();
    }
    try {
      const file = deviceFileSchema.parse(
        JSON.parse(await this.readDeviceFile(this.filePath(deviceId))),
      );
      if (
        file.ownerId !== this.ownerId ||
        file.deviceId !== deviceId ||
        Date.parse(file.expiresAt) <= this.now() ||
        (await this.isRevoked(deviceId))
      ) {
        throw new RemoteAccessDeniedError();
      }
      const expected = Buffer.from(file.secretSha256, "hex");
      if (!timingSafeEqual(expected, Buffer.from(sha256(secret), "hex"))) {
        throw new RemoteAccessDeniedError();
      }
      return {
        principal: { ownerId: file.ownerId, deviceId },
        grants: file.grants.map((grant) => ({
          ownerId: file.ownerId,
          deviceId,
          workspaceId: grant.workspaceId,
          permissions: grant.permissions,
          ...(grant.mcpServerIds === undefined
            ? {}
            : { mcpServerIds: grant.mcpServerIds }),
        })),
      };
    } catch {
      throw new RemoteAccessDeniedError();
    }
  }

  public async revoke(deviceId: string): Promise<void> {
    deviceIdSchema.parse(deviceId);
    await this.readDeviceFile(this.filePath(deviceId));
    try {
      await this.writeNewFile(this.revokedPath(deviceId), "");
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
    }
  }

  private filePath(deviceId: string): string {
    return join(this.root, `${deviceId}.json`);
  }

  private revokedPath(deviceId: string): string {
    return join(this.root, `${deviceId}.revoked`);
  }

  private async isRevoked(deviceId: string): Promise<boolean> {
    try {
      await lstat(this.revokedPath(deviceId));
      return true;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
  }

  private async readDeviceFile(path: string): Promise<string> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        !ownedByCurrentUser(info.uid) ||
        (info.mode & 0o077) !== 0 ||
        info.size > DEVICE_FILE_MAX_BYTES
      ) {
        throw new Error("Remote device file is unsafe.");
      }
      const content = await handle.readFile("utf8");
      if (Buffer.byteLength(content, "utf8") > DEVICE_FILE_MAX_BYTES) {
        throw new Error("Remote device file is too large.");
      }
      return content;
    } finally {
      await handle.close();
    }
  }

  private async writeNewFile(path: string, content: string): Promise<void> {
    const handle = await open(
      path,
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
    try {
      const directory = await open(this.root, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // File synchronization succeeded; directory sync is best effort.
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
