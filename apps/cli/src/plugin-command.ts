import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  buildSignedPluginCatalog,
  discoverPluginCatalog,
  installManagedPluginPackage,
  installPluginFromCatalog,
  listManagedPlugins,
  rollbackManagedPlugin,
  setManagedPluginEnabled,
  updatePluginFromCatalog,
  verifyLocalPluginPackage,
} from "@koda/plugin-host-node";
import { pluginCapabilitySchema, type PluginCapability } from "@koda/protocol";

import { resolveKodaHome } from "./config.js";
import type { TextWriter } from "./console-event-sink.js";

interface PluginCommandContext {
  environment: NodeJS.ProcessEnv;
  processDirectory: string;
  stdout: TextWriter;
  stderr: TextWriter;
}

export async function runPluginVerifyCommand(
  directory: string,
  options: { keyId: string; key: string },
  context: { processDirectory: string; stdout: TextWriter; stderr: TextWriter },
): Promise<number> {
  try {
    const publicKeyPem = await readPublisherKey(
      options.key,
      context.processDirectory,
    );
    const verified = await verifyLocalPluginPackage(
      resolve(context.processDirectory, directory),
      { keyId: options.keyId, publicKeyPem },
    );
    context.stdout.write(
      `Verified ${verified.id}@${verified.version} (${verified.manifestSha256}) with ${verified.keyId}\n`,
    );
    return 0;
  } catch (error) {
    context.stderr.write(
      `Plugin verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

export async function runPluginInstallCommand(
  directory: string,
  options: { keyId: string; key: string; capabilities: string },
  context: PluginCommandContext,
): Promise<number> {
  try {
    const capabilities = parseCapabilities(options.capabilities);
    const publicKeyPem = await readPublisherKey(
      options.key,
      context.processDirectory,
    );
    const installed = await installManagedPluginPackage({
      kodaHome: resolveKodaHome(context.environment),
      sourceDirectory: resolve(context.processDirectory, directory),
      trustRoot: { keyId: options.keyId, publicKeyPem },
      capabilities,
    });
    context.stdout.write(
      `Installed ${installed.id}@${installed.version}; disabled until explicitly enabled.\n`,
    );
    return 0;
  } catch (error) {
    return fail(context, error);
  }
}

export async function runPluginDiscoverCommand(
  options: { catalog: string; keyId: string; key: string },
  context: PluginCommandContext,
): Promise<number> {
  try {
    const publicKeyPem = await readPublisherKey(
      options.key,
      context.processDirectory,
    );
    const catalog = await discoverPluginCatalog({
      catalogUrl: options.catalog,
      trustRoot: { keyId: options.keyId, publicKeyPem },
    });
    for (const entry of catalog.packages) {
      context.stdout.write(
        `${entry.id}\t${entry.version}\t${entry.manifestSha256}\n`,
      );
    }
    return 0;
  } catch (error) {
    return fail(context, error);
  }
}

export async function runPluginPublishCatalogCommand(
  directory: string,
  options: { keyId: string; privateKey: string; expiresAt: string },
  context: PluginCommandContext,
): Promise<number> {
  try {
    const rootDirectory = resolve(context.processDirectory, directory);
    const privateKeyPem = await readPublisherPrivateKey(
      options.privateKey,
      context.processDirectory,
    );
    const { bytes, catalog } = await buildSignedPluginCatalog({
      rootDirectory,
      keyId: options.keyId,
      privateKeyPem,
      expiresAt: options.expiresAt,
    });
    const temporary = join(rootDirectory, `.catalog-${randomUUID()}`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, join(rootDirectory, "catalog.json"));
    } finally {
      await rm(temporary, { force: true });
    }
    context.stdout.write(
      `Published ${catalog.packages.length} signed plugin package(s) to ${join(rootDirectory, "catalog.json")} (${catalog.catalogSha256}).\n`,
    );
    return 0;
  } catch (error) {
    return fail(context, error);
  }
}

export async function runPluginInstallRemoteCommand(
  id: string,
  options: {
    version: string;
    catalog: string;
    keyId: string;
    key: string;
    capabilities: string;
  },
  context: PluginCommandContext,
): Promise<number> {
  try {
    const capabilities = parseCapabilities(options.capabilities);
    const publicKeyPem = await readPublisherKey(
      options.key,
      context.processDirectory,
    );
    const installed = await installPluginFromCatalog({
      catalogUrl: options.catalog,
      trustRoot: { keyId: options.keyId, publicKeyPem },
      kodaHome: resolveKodaHome(context.environment),
      id,
      version: options.version,
      capabilities,
    });
    context.stdout.write(
      `Installed ${installed.id}@${installed.version} from signed catalog; ${installed.enabled ? "enabled" : "disabled until explicitly enabled"}.\n`,
    );
    return 0;
  } catch (error) {
    return fail(context, error);
  }
}

export async function runPluginUpdateCommand(
  id: string,
  context: PluginCommandContext,
): Promise<number> {
  try {
    const installed = await updatePluginFromCatalog({
      kodaHome: resolveKodaHome(context.environment),
      id,
    });
    context.stdout.write(
      installed === null
        ? `${id}: already at the latest stable catalog version.\n`
        : `Installed ${installed.id}@${installed.version} from signed catalog; disabled until explicitly enabled.\n`,
    );
    return 0;
  } catch (error) {
    return fail(context, error);
  }
}

export async function runPluginListCommand(
  context: PluginCommandContext,
): Promise<number> {
  try {
    const rows = await listManagedPlugins(resolveKodaHome(context.environment));
    for (const row of rows) {
      context.stdout.write(
        `${row.id}\t${row.version}\t${row.enabled ? "enabled" : "disabled"}\t${row.keyId}\t${row.catalogSha256 ?? "local"}\n`,
      );
    }
    return 0;
  } catch (error) {
    return fail(context, error);
  }
}

export async function runPluginStateCommand(
  id: string,
  operation: "enable" | "disable" | "rollback",
  context: PluginCommandContext,
): Promise<number> {
  try {
    const home = resolveKodaHome(context.environment);
    const result =
      operation === "rollback"
        ? await rollbackManagedPlugin(home, id)
        : await setManagedPluginEnabled(home, id, operation === "enable");
    context.stdout.write(
      `${result.id}@${result.version}: ${result.enabled ? "enabled" : "disabled"}\n`,
    );
    return 0;
  } catch (error) {
    return fail(context, error);
  }
}

async function readPublisherKey(
  path: string,
  processDirectory: string,
): Promise<string> {
  const key = await open(
    resolve(processDirectory, path),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await key.stat();
    if (!info.isFile() || info.size > 8_192)
      throw new Error("Invalid publisher key file.");
    return await key.readFile({ encoding: "utf8" });
  } finally {
    await key.close();
  }
}

async function readPublisherPrivateKey(
  path: string,
  processDirectory: string,
): Promise<string> {
  const key = await open(
    resolve(processDirectory, path),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await key.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (process.getuid !== undefined && info.uid !== process.getuid()) ||
      (info.mode & 0o077) !== 0 ||
      info.size > 8_192
    ) {
      throw new Error("Publisher private key file is unsafe.");
    }
    return await key.readFile({ encoding: "utf8" });
  } finally {
    await key.close();
  }
}

function parseCapabilities(input: string): PluginCapability[] {
  const values = input
    .split(",")
    .map((value) => pluginCapabilitySchema.parse(value.trim()));
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(
      "Plugin capabilities must be a unique comma-separated list.",
    );
  }
  return values;
}

function fail(context: PluginCommandContext, error: unknown): number {
  context.stderr.write(
    `Plugin command failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  return 1;
}
