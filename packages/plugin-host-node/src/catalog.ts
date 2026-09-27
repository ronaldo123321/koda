import { verify } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { sha256CanonicalJson } from "@koda/agent-core";
import { pluginIdSchema, type PluginCapability } from "@koda/protocol";
import { z } from "zod";

import { PluginHostError } from "./errors.js";
import {
  installManagedPluginPackage,
  readManagedPluginUpdateSource,
  type ManagedPluginStatus,
} from "./managed-packages.js";
import {
  parsePublisherPublicKey,
  verifySignedPluginManifest,
  type PluginPublisherTrustRoot,
} from "./package-verification.js";

const MAX_CATALOG_BYTES = 1_048_576;
const MAX_MANIFEST_BYTES = 64 * 1_024;
const MAX_FILE_BYTES = 16 * 1_024 * 1_024;
const MAX_CATALOG_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const SIGNING_DOMAIN = Buffer.from("KODA_PLUGIN_CATALOG_V1\0", "utf8");

export function pluginCatalogSigningPayload(signed: object): Buffer {
  return Buffer.concat([
    SIGNING_DOMAIN,
    Buffer.from(sha256CanonicalJson(signed), "hex"),
  ]);
}
const versionSchema = z
  .string()
  .max(64)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9.-]+)?$/u);
const pathSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
  .refine((path) =>
    path
      .split("/")
      .every((part) => part !== "." && part !== ".." && part !== ""),
  );
const packageSchema = z
  .object({
    id: pluginIdSchema,
    version: versionSchema,
    manifest_path: pathSchema.refine((path) => path.endsWith("/manifest.json")),
    manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
const catalogSchema = z
  .object({
    schema_version: z.literal(1),
    generated_at: z.string(),
    expires_at: z.string(),
    packages: z.array(packageSchema).max(256),
    signature: z
      .object({
        key_id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
        ed25519: z.string().min(1).max(128),
      })
      .strict(),
  })
  .strict();

export interface PluginCatalogEntry {
  readonly id: string;
  readonly version: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
}

export interface VerifiedPluginCatalog {
  readonly catalogSha256: string;
  readonly generatedAt: string;
  readonly expiresAt: string;
  readonly packages: readonly PluginCatalogEntry[];
}

export function verifySignedPluginCatalog(
  bytes: Buffer,
  trustRoot: PluginPublisherTrustRoot,
  nowMs = Date.now(),
): VerifiedPluginCatalog {
  try {
    if (bytes.length > MAX_CATALOG_BYTES) throw invalidCatalog();
    const catalog = catalogSchema.parse(
      JSON.parse(bytes.toString("utf8")) as unknown,
    );
    const generated = strictTimestamp(catalog.generated_at);
    const expires = strictTimestamp(catalog.expires_at);
    if (
      generated > nowMs + 5 * 60_000 ||
      expires <= nowMs ||
      expires <= generated ||
      expires - generated > MAX_CATALOG_AGE_MS ||
      catalog.signature.key_id !== trustRoot.keyId
    )
      throw invalidCatalog();
    const keys = catalog.packages.map(
      (entry) => `${entry.id}\0${entry.version}`,
    );
    if (
      keys.some((key, index) => index > 0 && keys[index - 1]! >= key) ||
      new Set(
        catalog.packages.map((entry) => entry.manifest_path.toLowerCase()),
      ).size !== catalog.packages.length
    ) {
      throw invalidCatalog();
    }
    const { signature, ...signed } = catalog;
    const signatureBytes = Buffer.from(signature.ed25519, "base64");
    const key = parsePublisherPublicKey(trustRoot.publicKeyPem);
    if (
      signatureBytes.length !== 64 ||
      signatureBytes.toString("base64") !== signature.ed25519 ||
      !verify(null, pluginCatalogSigningPayload(signed), key, signatureBytes)
    ) {
      throw invalidCatalog();
    }
    return {
      catalogSha256: sha256CanonicalJson(catalog),
      generatedAt: catalog.generated_at,
      expiresAt: catalog.expires_at,
      packages: catalog.packages.map((entry) => ({
        id: entry.id,
        version: entry.version,
        manifestPath: entry.manifest_path,
        manifestSha256: entry.manifest_sha256,
      })),
    };
  } catch (error) {
    if (error instanceof PluginHostError) throw error;
    throw invalidCatalog();
  }
}

export async function discoverPluginCatalog(options: {
  catalogUrl: string;
  trustRoot: PluginPublisherTrustRoot;
  ca?: Buffer;
  nowMs?: number;
}): Promise<VerifiedPluginCatalog> {
  const url = catalogUrl(options.catalogUrl);
  const bytes = await download(url, MAX_CATALOG_BYTES, options.ca);
  return verifySignedPluginCatalog(bytes, options.trustRoot, options.nowMs);
}

export async function installPluginFromCatalog(options: {
  catalogUrl: string;
  trustRoot: PluginPublisherTrustRoot;
  kodaHome: string;
  id: string;
  version: string;
  capabilities: readonly PluginCapability[];
  ca?: Buffer;
  nowMs?: number;
}): Promise<ManagedPluginStatus> {
  const catalog = await discoverPluginCatalog(options);
  const entry = catalog.packages.find(
    (item) => item.id === options.id && item.version === options.version,
  );
  if (entry === undefined) throw invalidCatalog();
  return installCatalogEntry(options, catalog, entry);
}

async function installCatalogEntry(
  options: {
    catalogUrl: string;
    trustRoot: PluginPublisherTrustRoot;
    kodaHome: string;
    capabilities: readonly PluginCapability[];
    ca?: Buffer;
  },
  catalog: VerifiedPluginCatalog,
  entry: PluginCatalogEntry,
): Promise<ManagedPluginStatus> {
  const base = catalogUrl(options.catalogUrl);
  const manifestUrl = sameOriginUrl(base, entry.manifestPath);
  const manifestBytes = await download(
    manifestUrl,
    MAX_MANIFEST_BYTES,
    options.ca,
  );
  const manifest = verifySignedPluginManifest(manifestBytes, options.trustRoot);
  if (
    manifest.id !== entry.id ||
    manifest.version !== entry.version ||
    manifest.manifestSha256 !== entry.manifestSha256
  )
    throw invalidCatalog();
  const staging = await mkdtemp(join(tmpdir(), "koda-plugin-download-"));
  try {
    const packageDirectory = join(staging, "package");
    await mkdir(packageDirectory, { mode: 0o700 });
    await writeFile(join(packageDirectory, "manifest.json"), manifestBytes, {
      flag: "wx",
      mode: 0o600,
    });
    for (const file of manifest.files) {
      const url = sameOriginUrl(manifestUrl, file.path);
      const content = await download(
        url,
        Math.min(file.bytes, MAX_FILE_BYTES),
        options.ca,
      );
      const destination = join(packageDirectory, ...file.path.split("/"));
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, content, { flag: "wx", mode: 0o600 });
    }
    return await installManagedPluginPackage({
      kodaHome: options.kodaHome,
      sourceDirectory: packageDirectory,
      trustRoot: options.trustRoot,
      capabilities: options.capabilities,
      provenance: {
        catalogUrl: base.href,
        catalogSha256: catalog.catalogSha256,
        manifestPath: entry.manifestPath,
      },
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function updatePluginFromCatalog(options: {
  kodaHome: string;
  id: string;
  ca?: Buffer;
  nowMs?: number;
}): Promise<ManagedPluginStatus | null> {
  const current = await readManagedPluginUpdateSource(
    options.kodaHome,
    options.id,
  );
  const catalog = await discoverPluginCatalog({
    catalogUrl: current.catalogUrl,
    trustRoot: current.trustRoot,
    ...(options.ca === undefined ? {} : { ca: options.ca }),
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
  });
  const newer = catalog.packages
    .filter(
      (entry) =>
        entry.id === options.id && /^\d+\.\d+\.\d+$/u.test(entry.version),
    )
    .filter(
      (entry) =>
        compareStableVersions(entry.version, current.currentVersion) > 0,
    )
    .sort((a, b) => compareStableVersions(b.version, a.version))[0];
  if (newer === undefined) return null;
  return installCatalogEntry(
    {
      catalogUrl: current.catalogUrl,
      trustRoot: current.trustRoot,
      kodaHome: options.kodaHome,
      capabilities: current.capabilities,
      ...(options.ca === undefined ? {} : { ca: options.ca }),
    },
    catalog,
    newer,
  );
}

function compareStableVersions(left: string, right: string): number {
  const a = left.split("-")[0]!.split(".").map(BigInt);
  const b = right.split("-")[0]!.split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! > b[index]!) return 1;
    if (a[index]! < b[index]!) return -1;
  }
  return right.includes("-") && !left.includes("-") ? 1 : 0;
}

function catalogUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalidCatalog();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw invalidCatalog();
  return url;
}

function sameOriginUrl(base: URL, relative: string): URL {
  const url = new URL(relative, base);
  if (
    url.origin !== base.origin ||
    url.protocol !== "https:" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw invalidCatalog();
  return url;
}

function strictTimestamp(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
    throw invalidCatalog();
  return time;
}

async function download(
  url: URL,
  maximumBytes: number,
  ca?: Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = get(
      url,
      {
        ...(ca === undefined ? {} : { ca }),
        rejectUnauthorized: true,
        timeout: 10_000,
        signal: AbortSignal.timeout(20_000),
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(invalidCatalog());
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maximumBytes) request.destroy(invalidCatalog());
          else chunks.push(chunk);
        });
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(invalidCatalog()));
    request.on("error", reject);
  });
}

function invalidCatalog(): PluginHostError {
  return new PluginHostError(
    "PLUGIN_CATALOG_INVALID",
    "Plugin catalog, transport, or package record is invalid.",
  );
}
