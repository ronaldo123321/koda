import {
  createHash,
  createPublicKey,
  verify,
  type KeyObject,
} from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";

import { sha256CanonicalJson } from "@koda/agent-core";
import { pluginIdSchema } from "@koda/protocol";
import { z } from "zod";

import { PluginHostError } from "./errors.js";

const MAX_MANIFEST_BYTES = 64 * 1_024;
const MAX_FILE_BYTES = 16 * 1_024 * 1_024;
const MAX_PACKAGE_BYTES = 64 * 1_024 * 1_024;
const MAX_ENTRIES = 512;
const SIGNING_DOMAIN = Buffer.from("KODA_PLUGIN_MANIFEST_V1\0", "utf8");
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const filePathSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
  .refine((path) =>
    path
      .split("/")
      .every((part) => part !== "." && part !== ".." && part !== ""),
  );
const fileSchema = z
  .object({
    path: filePathSchema,
    bytes: z.number().int().min(0).max(MAX_FILE_BYTES),
    sha256: sha256Schema,
  })
  .strict();
const packageManifestSchema = z
  .object({
    schema_version: z.literal(1),
    id: pluginIdSchema,
    version: z
      .string()
      .max(64)
      .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9.-]+)?$/u),
    entrypoint: filePathSchema,
    files: z.array(fileSchema).min(1).max(256),
    signature: z
      .object({
        key_id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
        ed25519: z.string().min(1).max(128),
      })
      .strict(),
  })
  .strict();

export interface PluginPublisherTrustRoot {
  readonly keyId: string;
  readonly publicKeyPem: string;
}

export interface VerifiedPluginPackage {
  readonly id: string;
  readonly version: string;
  readonly entrypoint: string;
  readonly keyId: string;
  readonly manifestSha256: string;
  readonly totalBytes: number;
}

export interface VerifiedPluginManifest extends VerifiedPluginPackage {
  readonly files: readonly { path: string; bytes: number; sha256: string }[];
}

export function parsePublisherPublicKey(pem: string): KeyObject {
  const key = createPublicKey(pem);
  const canonical = key.export({ type: "spki", format: "pem" }).toString();
  if (
    key.asymmetricKeyType !== "ed25519" ||
    pem.replaceAll("\r\n", "\n").trimEnd() + "\n" !== canonical
  ) {
    throw new Error(
      "Publisher key must contain exactly one Ed25519 public key.",
    );
  }
  return key;
}

export function verifySignedPluginManifest(
  manifestBytes: Buffer,
  trustRoot: PluginPublisherTrustRoot,
): VerifiedPluginManifest {
  try {
    if (manifestBytes.length > MAX_MANIFEST_BYTES) throw invalidPackage();
    const manifest = packageManifestSchema.parse(
      JSON.parse(manifestBytes.toString("utf8")) as unknown,
    );
    const paths = manifest.files.map((file) => file.path);
    if (
      manifest.signature.key_id !== trustRoot.keyId ||
      !paths.includes(manifest.entrypoint) ||
      paths.some((path, index) => index > 0 && paths[index - 1]! >= path) ||
      new Set(paths.map((path) => path.toLowerCase())).size !== paths.length
    ) {
      throw invalidPackage();
    }
    const totalBytes = manifest.files.reduce(
      (sum, file) => sum + file.bytes,
      0,
    );
    if (totalBytes > MAX_PACKAGE_BYTES) throw invalidPackage();
    const { signature, ...signed } = manifest;
    const digest = sha256CanonicalJson(signed);
    const signatureBytes = Buffer.from(signature.ed25519, "base64");
    const key = parsePublisherPublicKey(trustRoot.publicKeyPem);
    if (
      signatureBytes.length !== 64 ||
      signatureBytes.toString("base64") !== signature.ed25519 ||
      !verify(
        null,
        Buffer.concat([SIGNING_DOMAIN, Buffer.from(digest, "hex")]),
        key,
        signatureBytes,
      )
    ) {
      throw invalidPackage();
    }
    return {
      id: manifest.id,
      version: manifest.version,
      entrypoint: manifest.entrypoint,
      keyId: trustRoot.keyId,
      manifestSha256: sha256CanonicalJson(manifest),
      totalBytes,
      files: manifest.files,
    };
  } catch (error) {
    if (error instanceof PluginHostError) throw error;
    throw invalidPackage();
  }
}

export async function verifyLocalPluginPackage(
  directory: string,
  trustRoot: PluginPublisherTrustRoot,
): Promise<VerifiedPluginPackage> {
  try {
    if (!(await lstat(directory)).isDirectory()) throw invalidPackage();
    const manifestBytes = await readRegularFile(
      join(directory, "manifest.json"),
      MAX_MANIFEST_BYTES,
    );
    const manifest = verifySignedPluginManifest(manifestBytes, trustRoot);
    const paths = manifest.files.map((file) => file.path);
    const actual = await listPackageFiles(directory);
    if (
      actual.length !== paths.length + 1 ||
      !actual.includes("manifest.json")
    ) {
      throw invalidPackage();
    }
    const expected = new Set(["manifest.json", ...paths]);
    if (actual.some((path) => !expected.has(path))) throw invalidPackage();
    for (const file of manifest.files) {
      const content = await readRegularFile(
        join(directory, ...file.path.split("/")),
        MAX_FILE_BYTES,
      );
      if (
        content.length !== file.bytes ||
        createHash("sha256").update(content).digest("hex") !== file.sha256
      ) {
        throw invalidPackage();
      }
    }
    return {
      id: manifest.id,
      version: manifest.version,
      entrypoint: manifest.entrypoint,
      keyId: manifest.keyId,
      manifestSha256: manifest.manifestSha256,
      totalBytes: manifest.totalBytes,
    };
  } catch (error) {
    if (error instanceof PluginHostError) throw error;
    throw invalidPackage();
  }
}

async function listPackageFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  let entries = 0;
  async function visit(directory: string, relative: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_ENTRIES) throw invalidPackage();
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (!filePathSchema.safeParse(path).success) throw invalidPackage();
      const info = await lstat(join(directory, entry.name));
      if (info.isDirectory()) {
        await visit(join(directory, entry.name), path);
      } else if (info.isFile() && info.nlink === 1) {
        files.push(path);
      } else {
        throw invalidPackage();
      }
    }
  }
  await visit(root, "");
  return files;
}

async function readRegularFile(
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maximumBytes)
      throw invalidPackage();
    const content = await handle.readFile();
    if (content.length !== info.size) throw invalidPackage();
    return content;
  } finally {
    await handle.close();
  }
}

function invalidPackage(): PluginHostError {
  return new PluginHostError(
    "PLUGIN_PACKAGE_INVALID",
    "Plugin package signature or file inventory is invalid.",
  );
}
