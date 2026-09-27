import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

import {
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
