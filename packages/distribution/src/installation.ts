import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_SERVER_PROTOCOL_VERSION } from "@koda/protocol";

import {
  integrityInventoryDigest,
  integrityInventorySchema,
  type IntegrityFile,
  type IntegrityInventory,
  releaseRelativePathSchema,
  runtimeManifestSchema,
  type RuntimeManifest,
} from "./contracts.js";
import { distributionError } from "./errors.js";
import {
  INTEGRITY_INVENTORY_NAME,
  listImmutablePayloadPaths,
  RUNTIME_MANIFEST_NAME,
} from "./inventory.js";
import { KODA_VERSION, NATIVE_EXECUTOR_PROTOCOL_VERSION } from "./version.js";

const MAXIMUM_MANIFEST_BYTES = 64 * 1_024;
const MAXIMUM_INVENTORY_BYTES = 16 * 1_024 * 1_024;
const MAXIMUM_ANCESTOR_DEPTH = 16;

export interface DevelopmentInstallation {
  readonly mode: "development";
  readonly anchorPath: string;
}

export interface ReleaseInstallation {
  readonly mode: "release";
  readonly root: string;
  readonly manifestPath: string;
  readonly integrityPath: string;
  readonly manifest: RuntimeManifest;
  readonly integrity: IntegrityInventory;
}

export type KodaInstallation = DevelopmentInstallation | ReleaseInstallation;

export interface ResolveKodaInstallationOptions {
  anchor: string | URL;
  expectedPlatform?: NodeJS.Platform;
  expectedArch?: NodeJS.Architecture;
  verifyCriticalFiles?: boolean;
}

export async function resolveKodaInstallation(
  options: ResolveKodaInstallationOptions,
): Promise<KodaInstallation> {
  const anchorPath = await canonicalAnchorPath(options.anchor);
  let directory = (await lstat(anchorPath)).isDirectory()
    ? anchorPath
    : dirname(anchorPath);

  for (let depth = 0; depth <= MAXIMUM_ANCESTOR_DEPTH; depth += 1) {
    const manifestPath = join(directory, RUNTIME_MANIFEST_NAME);
    const integrityPath = join(directory, INTEGRITY_INVENTORY_NAME);
    const [manifestExists, integrityExists] = await Promise.all([
      pathExists(manifestPath),
      pathExists(integrityPath),
    ]);
    if (manifestExists || integrityExists) {
      if (!manifestExists || !integrityExists) {
        throw distributionError("KODA_BUNDLE_MANIFEST_INVALID");
      }
      return loadReleaseInstallation(directory, options);
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  return { mode: "development", anchorPath };
}

export async function loadReleaseInstallation(
  rootInput: string,
  options: Omit<ResolveKodaInstallationOptions, "anchor"> = {},
): Promise<ReleaseInstallation> {
  let root: string;
  try {
    root = await realpath(rootInput);
  } catch (error) {
    throw distributionError("KODA_BUNDLE_COMPONENT_MISSING", error);
  }
  const manifestPath = join(root, RUNTIME_MANIFEST_NAME);
  const integrityPath = join(root, INTEGRITY_INVENTORY_NAME);
  const manifest = await readManifest(manifestPath);
  const integrity = await readIntegrity(integrityPath);

  validateCompatibility(
    manifest,
    options.expectedPlatform ?? process.platform,
    options.expectedArch ?? process.arch,
  );
  if (integrityInventoryDigest(integrity) !== manifest.integrity_sha256) {
    throw distributionError("KODA_BUNDLE_INTEGRITY_FAILED");
  }

  const installation: ReleaseInstallation = {
    mode: "release",
    root,
    manifestPath,
    integrityPath,
    manifest,
    integrity,
  };
  validateCriticalInventory(installation);
  if (options.verifyCriticalFiles !== false) {
    await verifyCriticalIntegrity(installation);
  }
  return installation;
}

export function resolveInstallationPath(
  installation: ReleaseInstallation,
  path: string,
): string {
  const parsed = releaseRelativePathSchema.parse(path);
  const absolute = resolve(installation.root, parsed);
  const containedPrefix = installation.root.endsWith(sep)
    ? installation.root
    : `${installation.root}${sep}`;
  if (absolute === installation.root || !absolute.startsWith(containedPrefix)) {
    throw distributionError("KODA_BUNDLE_MANIFEST_INVALID");
  }
  return absolute;
}

export function resolveNativeExecutorPath(
  installation: KodaInstallation,
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (installation.mode === "release") {
    return resolveInstallationPath(
      installation,
      installation.manifest.native_executor.path,
    );
  }
  const configured = environment.KODA_EXEC_PATH?.trim();
  return configured === undefined || configured.length === 0
    ? undefined
    : configured;
}

export function resolveInstallationEnvironment(
  installation: KodaInstallation,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const resolved = { ...environment };
  if (installation.mode === "release") {
    resolved.KODA_EXEC_PATH = resolveInstallationPath(
      installation,
      installation.manifest.native_executor.path,
    );
  }
  return resolved;
}

export async function verifyCriticalIntegrity(
  installation: ReleaseInstallation,
): Promise<void> {
  const records = inventoryRecordMap(installation.integrity);
  for (const path of criticalRelativePaths(installation.manifest)) {
    const record = records.get(path);
    if (record === undefined) {
      throw distributionError("KODA_BUNDLE_MANIFEST_INVALID");
    }
    await verifyFileRecord(installation, record);
  }
}

export async function verifyFullIntegrity(
  installation: ReleaseInstallation,
): Promise<void> {
  const expected = inventoryRecordMap(installation.integrity);
  const discovered = await discoverPayloadFiles(installation.root);
  if (discovered.size !== expected.size) {
    throw distributionError("KODA_BUNDLE_INTEGRITY_FAILED");
  }
  for (const [path, record] of expected) {
    if (!discovered.has(path)) {
      throw distributionError("KODA_BUNDLE_COMPONENT_MISSING");
    }
    await verifyFileRecord(installation, record);
  }
}

function validateCompatibility(
  manifest: RuntimeManifest,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): void {
  if (platform !== manifest.platform) {
    throw distributionError("KODA_BUNDLE_PLATFORM_MISMATCH");
  }
  if (arch !== manifest.arch) {
    throw distributionError("KODA_BUNDLE_ARCH_MISMATCH");
  }
  if (
    manifest.version !== KODA_VERSION ||
    manifest.protocols.app_server !== APP_SERVER_PROTOCOL_VERSION ||
    manifest.protocols.native_executor !== NATIVE_EXECUTOR_PROTOCOL_VERSION
  ) {
    throw distributionError("KODA_BUNDLE_VERSION_MISMATCH");
  }
}

function validateCriticalInventory(installation: ReleaseInstallation): void {
  const records = inventoryRecordMap(installation.integrity);
  for (const path of criticalRelativePaths(installation.manifest)) {
    if (!records.has(path)) {
      throw distributionError("KODA_BUNDLE_MANIFEST_INVALID");
    }
  }
}

function criticalRelativePaths(manifest: RuntimeManifest): readonly string[] {
  return [
    manifest.node.path,
    manifest.entrypoints.dispatcher,
    manifest.entrypoints.cli,
    manifest.entrypoints.tui,
    manifest.entrypoints.app_server,
    manifest.entrypoints.doctor,
    manifest.native_executor.path,
  ].filter((path, index, paths) => paths.indexOf(path) === index);
}

function inventoryRecordMap(
  inventory: IntegrityInventory,
): ReadonlyMap<string, IntegrityFile> {
  return new Map(inventory.files.map((record) => [record.path, record]));
}

async function verifyFileRecord(
  installation: ReleaseInstallation,
  record: IntegrityFile,
): Promise<void> {
  const path = resolveInstallationPath(installation, record.path);
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw distributionError("KODA_BUNDLE_COMPONENT_MISSING", error);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw distributionError("KODA_BUNDLE_INTEGRITY_FAILED");
  }
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch (error) {
    throw distributionError("KODA_BUNDLE_COMPONENT_MISSING", error);
  }
  if (canonicalPath !== path) {
    throw distributionError("KODA_BUNDLE_INTEGRITY_FAILED");
  }
  if (
    metadata.size !== record.bytes ||
    (await sha256File(path)) !== record.sha256
  ) {
    throw distributionError("KODA_BUNDLE_INTEGRITY_FAILED");
  }
}

async function discoverPayloadFiles(
  root: string,
): Promise<ReadonlySet<string>> {
  try {
    return new Set(await listImmutablePayloadPaths(root));
  } catch (error) {
    throw distributionError("KODA_BUNDLE_INTEGRITY_FAILED", error);
  }
}

async function readManifest(path: string): Promise<RuntimeManifest> {
  try {
    return runtimeManifestSchema.parse(
      JSON.parse(await readBoundedUtf8(path, MAXIMUM_MANIFEST_BYTES)),
    );
  } catch (error) {
    throw distributionError("KODA_BUNDLE_MANIFEST_INVALID", error);
  }
}

async function readIntegrity(path: string): Promise<IntegrityInventory> {
  try {
    return integrityInventorySchema.parse(
      JSON.parse(await readBoundedUtf8(path, MAXIMUM_INVENTORY_BYTES)),
    );
  } catch (error) {
    throw distributionError("KODA_BUNDLE_MANIFEST_INVALID", error);
  }
}

async function readBoundedUtf8(
  path: string,
  maximumBytes: number,
): Promise<string> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > maximumBytes
  ) {
    throw new Error("Invalid bounded release metadata file.");
  }
  const handle = await open(path, "r");
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function canonicalAnchorPath(anchor: string | URL): Promise<string> {
  let path: string;
  try {
    path =
      anchor instanceof URL
        ? fileURLToPath(anchor)
        : anchor.startsWith("file:")
          ? fileURLToPath(new URL(anchor))
          : anchor;
  } catch (error) {
    throw distributionError("KODA_BUNDLE_MANIFEST_INVALID", error);
  }
  if (!isAbsolute(path)) {
    throw distributionError("KODA_BUNDLE_MANIFEST_INVALID");
  }
  try {
    return await realpath(path);
  } catch (error) {
    throw distributionError("KODA_BUNDLE_COMPONENT_MISSING", error);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw distributionError("KODA_BUNDLE_MANIFEST_INVALID", error);
  }
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) {
      digest.update(chunk as Buffer);
    }
  } catch (error) {
    throw distributionError("KODA_BUNDLE_COMPONENT_MISSING", error);
  }
  return digest.digest("hex");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
