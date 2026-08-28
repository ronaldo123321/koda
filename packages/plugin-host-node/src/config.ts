import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { sha256CanonicalJson, type ToolEffect } from "@koda/agent-core";
import {
  MAX_PLUGINS,
  pluginCapabilitySchema,
  pluginIdSchema,
  type PluginCapability,
  type PluginId,
} from "@koda/protocol";
import { z } from "zod";

import { PluginHostError, errorMessage } from "./errors.js";

const MAX_CONFIG_BYTES = 1_048_576;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 4_096;
const MAX_TOTAL_ARGUMENT_BYTES = 32_768;
const MAX_ENVIRONMENT_VARIABLES = 64;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

const safeString = z
  .string()
  .min(1)
  .max(MAX_ARGUMENT_BYTES)
  .refine((value) => !value.includes("\0"), "Cannot contain a null byte.");

const environmentNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
  .max(128);

const configuredToolSchema = z.object({ effect: z.literal("read") }).strict();

const pluginSchema = z
  .object({
    command: safeString,
    args: z
      .array(safeString)
      .max(MAX_ARGUMENTS)
      .default([])
      .superRefine((arguments_, context) => {
        const bytes = arguments_.reduce(
          (total, argument) => total + Buffer.byteLength(argument, "utf8"),
          0,
        );
        if (bytes > MAX_TOTAL_ARGUMENT_BYTES) {
          context.addIssue({
            code: "custom",
            message: `Arguments exceed the ${MAX_TOTAL_ARGUMENT_BYTES}-byte total limit.`,
          });
        }
      }),
    cwd: safeString.optional(),
    env: z
      .array(environmentNameSchema)
      .max(MAX_ENVIRONMENT_VARIABLES)
      .default([])
      .superRefine((names, context) => {
        if (new Set(names).size !== names.length) {
          context.addIssue({
            code: "custom",
            message: "Environment variable names must be unique.",
          });
        }
      }),
    required: z.boolean().default(true),
    capabilities: z
      .array(pluginCapabilitySchema)
      .min(1)
      .max(3)
      .superRefine((capabilities, context) => {
        if (new Set(capabilities).size !== capabilities.length) {
          context.addIssue({
            code: "custom",
            message: "Capabilities must be unique.",
          });
        }
      }),
    tools: z
      .record(z.string().min(1).max(64), configuredToolSchema)
      .default({}),
    startup_timeout_ms: z
      .number()
      .int()
      .min(MIN_TIMEOUT_MS)
      .max(MAX_TIMEOUT_MS)
      .default(DEFAULT_STARTUP_TIMEOUT_MS),
    call_timeout_ms: z
      .number()
      .int()
      .min(MIN_TIMEOUT_MS)
      .max(MAX_TIMEOUT_MS)
      .default(DEFAULT_CALL_TIMEOUT_MS),
    shutdown_timeout_ms: z
      .number()
      .int()
      .min(MIN_TIMEOUT_MS)
      .max(MAX_TIMEOUT_MS)
      .default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
  })
  .strict()
  .superRefine((plugin, context) => {
    if (
      Object.keys(plugin.tools).length > 0 &&
      !plugin.capabilities.includes("tools")
    ) {
      context.addIssue({
        code: "custom",
        path: ["tools"],
        message: "Reviewed tools require the 'tools' capability.",
      });
    }
  });

const configurationSchema = z
  .object({
    version: z.literal(1),
    plugins: z.record(pluginIdSchema, pluginSchema),
  })
  .strict()
  .superRefine((configuration, context) => {
    if (Object.keys(configuration.plugins).length > MAX_PLUGINS) {
      context.addIssue({
        code: "custom",
        path: ["plugins"],
        message: `At most ${MAX_PLUGINS} plugins may be configured.`,
      });
    }
  });

export interface PluginToolPolicyConfiguration {
  effect: Extract<ToolEffect, "read">;
}

export interface PluginConfiguration {
  id: PluginId;
  command: string;
  args: string[];
  cwd?: string;
  environmentNames: string[];
  required: boolean;
  capabilities: PluginCapability[];
  tools: Readonly<Record<string, PluginToolPolicyConfiguration>>;
  startupTimeoutMs: number;
  callTimeoutMs: number;
  shutdownTimeoutMs: number;
  manifestSha256: string;
}

export interface PluginConfigurationSet {
  sourcePath?: string;
  plugins: PluginConfiguration[];
}

export interface LoadPluginConfigurationOptions {
  environment: NodeJS.ProcessEnv;
  kodaHome: string;
  processDirectory: string;
}

export async function loadPluginConfiguration(
  options: LoadPluginConfigurationOptions,
): Promise<PluginConfigurationSet> {
  const explicitPath = options.environment.KODA_PLUGIN_CONFIG?.trim();
  const sourcePath =
    explicitPath === undefined || explicitPath.length === 0
      ? join(options.kodaHome, "plugins.json")
      : resolve(options.processDirectory, explicitPath);
  let bytes: Buffer;
  try {
    const file = await lstat(sourcePath);
    if (!file.isFile()) {
      throw invalidConfiguration(
        `Plugin configuration '${sourcePath}' is not a regular file.`,
      );
    }
    if (file.size > MAX_CONFIG_BYTES) {
      throw invalidConfiguration(
        `Plugin configuration exceeds the ${MAX_CONFIG_BYTES}-byte limit.`,
      );
    }
    bytes = await readFile(sourcePath);
  } catch (error) {
    if (
      isNodeError(error, "ENOENT") &&
      (explicitPath === undefined || explicitPath.length === 0)
    ) {
      return { plugins: [] };
    }
    if (error instanceof PluginHostError) {
      throw error;
    }
    throw invalidConfiguration(
      `Could not read plugin configuration '${sourcePath}': ${errorMessage(error)}`,
      error,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw invalidConfiguration(
      `Plugin configuration '${sourcePath}' is not valid JSON.`,
      error,
    );
  }
  const parsed = configurationSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map(
        (issue) =>
          `${issue.path.join(".") || "configuration"}: ${issue.message}`,
      )
      .join("; ");
    throw invalidConfiguration(
      `Plugin configuration '${sourcePath}' is invalid: ${issues}`,
    );
  }

  const plugins: PluginConfiguration[] = [];
  for (const [rawId, plugin] of Object.entries(parsed.data.plugins).sort(
    ([left], [right]) => comparePortable(left, right),
  )) {
    const id = pluginIdSchema.parse(rawId);
    let cwd: string | undefined;
    if (plugin.cwd !== undefined) {
      if (!isAbsolute(plugin.cwd)) {
        throw invalidConfiguration(
          `Plugin '${id}' working directory must be absolute.`,
        );
      }
      try {
        const canonical = await realpath(plugin.cwd);
        if (!(await stat(canonical)).isDirectory()) {
          throw new Error("Path is not a directory.");
        }
        cwd = canonical;
      } catch (error) {
        throw invalidConfiguration(
          `Plugin '${id}' working directory is invalid: ${errorMessage(error)}`,
          error,
        );
      }
    }
    const capabilities = [...plugin.capabilities].sort(comparePortable);
    plugins.push({
      id,
      command: plugin.command,
      args: [...plugin.args],
      ...(cwd === undefined ? {} : { cwd }),
      environmentNames: [...plugin.env],
      required: plugin.required,
      capabilities,
      tools: plugin.tools,
      startupTimeoutMs: plugin.startup_timeout_ms,
      callTimeoutMs: plugin.call_timeout_ms,
      shutdownTimeoutMs: plugin.shutdown_timeout_ms,
      manifestSha256: sha256CanonicalJson({ id, ...plugin }),
    });
  }
  return { sourcePath, plugins };
}

function invalidConfiguration(
  message: string,
  cause?: unknown,
): PluginHostError {
  return new PluginHostError("PLUGIN_CONFIGURATION_INVALID", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function comparePortable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
