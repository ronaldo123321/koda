import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sha256CanonicalJson } from "@koda/agent-core";
import {
  MAX_PLUGINS,
  pluginCapabilitySchema,
  pluginIdSchema,
  type PluginCapability,
} from "@koda/protocol";
import { ThreadLease } from "@koda/runtime-node";
import { z } from "zod";

import type { PluginConfiguration } from "./config.js";
import { connectPluginStdio } from "./connection.js";
import { PluginHostError } from "./errors.js";
import {
  verifyLocalPluginPackage,
  type PluginPublisherTrustRoot,
  type VerifiedPluginPackage,
} from "./package-verification.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const packageRecordSchema = z
  .object({
    version: z.string().min(1).max(64),
    manifest_sha256: digestSchema,
    key_id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
    public_key_pem: z.string().min(1).max(8_192),
    capabilities: z.array(pluginCapabilitySchema).min(1).max(3),
    provenance: z
      .object({
        catalog_url: z.string().url().max(2_048),
        catalog_sha256: digestSchema,
        manifest_path: z.string().min(1).max(300),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (record) =>
      new Set(record.capabilities).size === record.capabilities.length,
  );
const managedEntrySchema = z
  .object({
    active: packageRecordSchema,
    previous: packageRecordSchema.optional(),
    enabled: z.boolean(),
  })
  .strict();
const managedStateSchema = z
  .object({
    schema_version: z.literal(1),
    plugins: z.record(pluginIdSchema, managedEntrySchema),
  })
  .strict();
type ManagedState = z.infer<typeof managedStateSchema>;
type PackageRecord = z.infer<typeof packageRecordSchema>;

export interface ManagedPluginStatus {
  id: string;
  version: string;
  enabled: boolean;
  manifestSha256: string;
  keyId: string;
  previousVersion?: string;
  catalogSha256?: string;
}

export interface ManagedPluginUpdateSource {
  readonly catalogUrl: string;
  readonly trustRoot: PluginPublisherTrustRoot;
  readonly capabilities: readonly PluginCapability[];
  readonly currentVersion: string;
  readonly stateSha256: string;
}

export async function installManagedPluginPackage(options: {
  kodaHome: string;
  sourceDirectory: string;
  trustRoot: PluginPublisherTrustRoot;
  capabilities: readonly PluginCapability[];
  provenance?: {
    catalogUrl: string;
    catalogSha256: string;
    manifestPath: string;
  };
  rotation?: { previousTrustRoot: PluginPublisherTrustRoot };
  expectedStateSha256?: string;
}): Promise<ManagedPluginStatus> {
  const capabilities = validateCapabilities(options.capabilities);
  const verified = await verifyLocalPluginPackage(
    options.sourceDirectory,
    options.trustRoot,
  );
  const root = storeRoot(options.kodaHome);
  await ensureStoreRoot(root);
  const lease = await ThreadLease.acquire(statePath(root));
  try {
    const state = await readState(root);
    const old = state.plugins[verified.id];
    if (
      options.expectedStateSha256 !== undefined &&
      (old === undefined ||
        sha256CanonicalJson(old) !== options.expectedStateSha256)
    ) {
      throw invalidState("Managed plugin changed during update.");
    }
    if (old === undefined && Object.keys(state.plugins).length >= MAX_PLUGINS) {
      throw invalidState("Managed plugin limit reached.");
    }
    if (old !== undefined) {
      await checkPackageParent(root, verified.id);
      await checkPackage(
        packagePath(root, verified.id, old.active.manifest_sha256),
        verified.id,
        old.active,
      );
    }
    const keyChanged =
      old !== undefined &&
      (old.active.key_id !== options.trustRoot.keyId ||
        old.active.public_key_pem !== options.trustRoot.publicKeyPem);
    if (keyChanged !== (options.rotation !== undefined))
      throw invalidState(
        "Plugin publisher key change requires an explicit matching rotation.",
      );
    if (options.rotation !== undefined) {
      if (
        old === undefined ||
        old.active.key_id !== options.rotation.previousTrustRoot.keyId ||
        old.active.public_key_pem !==
          options.rotation.previousTrustRoot.publicKeyPem
      ) {
        throw invalidState("Current plugin publisher key does not match.");
      }
    }
    const needsPreflight =
      old !== undefined &&
      (keyChanged || old.active.manifest_sha256 !== verified.manifestSha256);
    const candidate: PackageRecord = {
      version: verified.version,
      manifest_sha256: verified.manifestSha256,
      key_id: options.trustRoot.keyId,
      public_key_pem: options.trustRoot.publicKeyPem,
      capabilities,
    };
    const target = packagePath(root, verified.id, verified.manifestSha256);
    await ensurePackageParent(root, verified.id);
    if (await exists(target)) {
      await checkPackage(target, verified.id, candidate);
      if (needsPreflight) {
        const staging = await mkdtemp(join(root, ".stage-"));
        try {
          const copied = join(staging, "package");
          await cp(target, copied, { recursive: true, dereference: false });
          await preflightPackage(copied, verified, capabilities);
          await checkPackage(copied, verified.id, candidate);
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
      }
    } else {
      const staging = await mkdtemp(join(root, ".stage-"));
      try {
        const copied = join(staging, "package");
        await cp(options.sourceDirectory, copied, {
          recursive: true,
          dereference: false,
        });
        await checkPackage(copied, verified.id, candidate);
        if (needsPreflight) {
          await preflightPackage(copied, verified, capabilities);
          await checkPackage(copied, verified.id, candidate);
        }
        await rename(copied, target);
        await syncDirectory(dirname(target));
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    const active: PackageRecord = {
      ...candidate,
      ...(options.provenance === undefined
        ? {}
        : {
            provenance: {
              catalog_url: options.provenance.catalogUrl,
              catalog_sha256: options.provenance.catalogSha256,
              manifest_path: options.provenance.manifestPath,
            },
          }),
    };
    const unchanged =
      old?.active.manifest_sha256 === active.manifest_sha256 &&
      JSON.stringify(old.active.capabilities) ===
        JSON.stringify(active.capabilities);
    const entry =
      options.rotation !== undefined
        ? { active, enabled: false }
        : unchanged
          ? { ...old, active }
          : {
              active,
              ...(old === undefined ? {} : { previous: old.active }),
              enabled: false,
            };
    state.plugins[verified.id] = entry;
    await writeState(root, state);
    return projectStatus(verified.id, entry);
  } finally {
    await lease.release();
  }
}

export async function listManagedPlugins(
  kodaHome: string,
): Promise<ManagedPluginStatus[]> {
  const state = await readState(storeRoot(kodaHome));
  return Object.entries(state.plugins)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, entry]) => projectStatus(id, entry));
}

export async function readManagedPluginUpdateSource(
  kodaHome: string,
  id: string,
): Promise<ManagedPluginUpdateSource> {
  pluginIdSchema.parse(id);
  const root = storeRoot(kodaHome);
  const state = await readState(root);
  const entry = state.plugins[id];
  if (entry === undefined)
    throw invalidState("Managed plugin has no signed catalog source.");
  const provenance = entry.active.provenance;
  if (provenance === undefined)
    throw invalidState("Managed plugin has no signed catalog source.");
  const active = entry.active;
  await checkPackageParent(root, id);
  await checkPackage(packagePath(root, id, active.manifest_sha256), id, active);
  return {
    catalogUrl: provenance.catalog_url,
    trustRoot: { keyId: active.key_id, publicKeyPem: active.public_key_pem },
    capabilities: active.capabilities,
    currentVersion: active.version,
    stateSha256: sha256CanonicalJson(entry),
  };
}

export async function setManagedPluginEnabled(
  kodaHome: string,
  id: string,
  enabled: boolean,
): Promise<ManagedPluginStatus> {
  pluginIdSchema.parse(id);
  const root = storeRoot(kodaHome);
  await ensureStoreRoot(root);
  const lease = await ThreadLease.acquire(statePath(root));
  try {
    const state = await readState(root);
    const entry = state.plugins[id];
    if (entry === undefined)
      throw invalidState("Managed plugin is not installed.");
    if (enabled) {
      await checkPackageParent(root, id);
      await checkPackage(
        packagePath(root, id, entry.active.manifest_sha256),
        id,
        entry.active,
      );
    }
    state.plugins[id] = { ...entry, enabled };
    await writeState(root, state);
    return projectStatus(id, state.plugins[id]);
  } finally {
    await lease.release();
  }
}

export async function rollbackManagedPlugin(
  kodaHome: string,
  id: string,
): Promise<ManagedPluginStatus> {
  pluginIdSchema.parse(id);
  const root = storeRoot(kodaHome);
  await ensureStoreRoot(root);
  const lease = await ThreadLease.acquire(statePath(root));
  try {
    const state = await readState(root);
    const entry = state.plugins[id];
    if (entry?.previous === undefined)
      throw invalidState("No previous plugin version is available.");
    await checkPackageParent(root, id);
    await checkPackage(
      packagePath(root, id, entry.previous.manifest_sha256),
      id,
      entry.previous,
    );
    state.plugins[id] = {
      active: entry.previous,
      previous: entry.active,
      enabled: false,
    };
    await writeState(root, state);
    return projectStatus(id, state.plugins[id]);
  } finally {
    await lease.release();
  }
}

export async function loadManagedPluginConfigurations(
  kodaHome: string,
): Promise<PluginConfiguration[]> {
  const root = storeRoot(kodaHome);
  const state = await readState(root);
  const plugins: PluginConfiguration[] = [];
  for (const [id, entry] of Object.entries(state.plugins).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (!entry.enabled) continue;
    await checkPackageParent(root, id);
    const directory = packagePath(root, id, entry.active.manifest_sha256);
    const verified = await checkPackage(directory, id, entry.active);
    plugins.push({
      id,
      command: process.execPath,
      args: [join(directory, ...verified.entrypoint.split("/"))],
      cwd: directory,
      environmentNames: [],
      required: true,
      capabilities: [...entry.active.capabilities],
      tools: {},
      startupTimeoutMs: 15_000,
      callTimeoutMs: 60_000,
      shutdownTimeoutMs: 5_000,
      manifestSha256: sha256CanonicalJson({ id, ...entry.active }),
    });
  }
  return plugins;
}

function storeRoot(kodaHome: string): string {
  return join(kodaHome, "managed-plugins");
}
async function ensureStoreRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory())
    throw invalidState("Managed plugin store is invalid.");
}
function statePath(root: string): string {
  return join(root, "state.json");
}
function packagePath(root: string, id: string, digest: string): string {
  return join(root, "packages", id, digest);
}

async function ensurePackageParent(root: string, id: string): Promise<void> {
  const packages = join(root, "packages");
  await createManagedDirectory(packages, root);
  await createManagedDirectory(join(packages, id), packages);
}

async function createManagedDirectory(
  path: string,
  parent: string,
): Promise<void> {
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  await checkManagedDirectory(path);
  if (created) await syncDirectory(parent);
}

async function checkPackageParent(root: string, id: string): Promise<void> {
  await checkManagedDirectory(join(root, "packages"));
  await checkManagedDirectory(join(root, "packages", id));
}

async function checkManagedDirectory(path: string): Promise<void> {
  try {
    if (!(await lstat(path)).isDirectory())
      throw invalidState("Managed plugin package directory is invalid.");
  } catch (error) {
    if (error instanceof PluginHostError) throw error;
    throw invalidState("Managed plugin package directory is invalid.");
  }
}

async function checkPackage(
  directory: string,
  id: string,
  record: PackageRecord,
) {
  const verified = await verifyLocalPluginPackage(directory, {
    keyId: record.key_id,
    publicKeyPem: record.public_key_pem,
  });
  if (
    verified.id !== id ||
    verified.version !== record.version ||
    verified.manifestSha256 !== record.manifest_sha256
  )
    throw invalidState("Installed plugin identity changed.");
  return verified;
}

async function preflightPackage(
  directory: string,
  verified: VerifiedPluginPackage,
  capabilities: PluginCapability[],
): Promise<void> {
  const configuration: PluginConfiguration = {
    id: verified.id,
    command: process.execPath,
    args: [join(directory, ...verified.entrypoint.split("/"))],
    cwd: directory,
    environmentNames: [],
    required: true,
    capabilities,
    tools: {},
    startupTimeoutMs: 15_000,
    callTimeoutMs: 60_000,
    shutdownTimeoutMs: 5_000,
    manifestSha256: verified.manifestSha256,
  };
  const signal = new AbortController().signal;
  const connection = await connectPluginStdio(configuration, {}, signal);
  try {
    const initialized = await connection.initialize(signal);
    if (initialized.plugin.version !== verified.version) {
      throw invalidState(
        "Plugin initialize version differs from signed package.",
      );
    }
  } finally {
    await connection.close();
  }
}

function validateCapabilities(
  input: readonly PluginCapability[],
): PluginCapability[] {
  const values = z.array(pluginCapabilitySchema).min(1).max(3).parse(input);
  if (new Set(values).size !== values.length)
    throw invalidState("Plugin capabilities must be unique.");
  return [...values].sort();
}

async function readState(root: string): Promise<ManagedState> {
  try {
    if (!(await lstat(root)).isDirectory())
      throw invalidState("Managed plugin store is invalid.");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { schema_version: 1, plugins: {} };
    if (error instanceof PluginHostError) throw error;
    throw invalidState("Managed plugin store is invalid.");
  }
  let handle;
  try {
    handle = await open(
      statePath(root),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { schema_version: 1, plugins: {} };
    throw invalidState("Could not read managed plugin state.");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1_048_576)
      throw invalidState("Managed plugin state is invalid.");
    const state = managedStateSchema.parse(
      JSON.parse(await handle.readFile("utf8")) as unknown,
    );
    if (Object.keys(state.plugins).length > MAX_PLUGINS)
      throw invalidState("Managed plugin limit exceeded.");
    return state;
  } catch (error) {
    if (error instanceof PluginHostError) throw error;
    throw invalidState("Managed plugin state is invalid.");
  } finally {
    await handle.close();
  }
}

async function writeState(root: string, state: ManagedState): Promise<void> {
  const temporary = join(root, `.state-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, statePath(root));
    await syncDirectory(root);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    // Some filesystems reject directory fsync.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function projectStatus(
  id: string,
  entry: ManagedState["plugins"][string],
): ManagedPluginStatus {
  return {
    id,
    version: entry.active.version,
    enabled: entry.enabled,
    manifestSha256: entry.active.manifest_sha256,
    keyId: entry.active.key_id,
    ...(entry.previous === undefined
      ? {}
      : { previousVersion: entry.previous.version }),
    ...(entry.active.provenance === undefined
      ? {}
      : {
          catalogSha256: entry.active.provenance.catalog_sha256,
        }),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function invalidState(message: string): PluginHostError {
  return new PluginHostError("PLUGIN_PACKAGE_INVALID", message);
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
