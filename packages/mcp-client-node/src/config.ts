import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { ToolEffect } from "@koda/agent-core";
import { z } from "zod";

import { McpClientError, errorMessage } from "./errors.js";

const MAX_CONFIG_BYTES = 1_048_576;
const MAX_SERVERS = 16;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_CHARACTERS = 4_096;
const MAX_TOTAL_ARGUMENT_BYTES = 32_768;
const MAX_ENVIRONMENT_VARIABLES = 64;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

const safeString = z
  .string()
  .min(1)
  .max(MAX_ARGUMENT_CHARACTERS)
  .refine((value) => !value.includes("\0"), "Cannot contain a null byte.");

const environmentNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
  .max(128);

const configuredToolSchema = z.object({ effect: z.literal("read") }).strict();

const serverSchema = z
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
    tools: z
      .record(z.string().min(1).max(128), configuredToolSchema)
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
  })
  .strict();

const configurationSchema = z
  .object({
    version: z.literal(1),
    servers: z.record(
      z.string().regex(/^[a-z][a-z0-9_-]{0,23}$/u),
      serverSchema,
    ),
  })
  .strict()
  .superRefine((configuration, context) => {
    if (Object.keys(configuration.servers).length > MAX_SERVERS) {
      context.addIssue({
        code: "custom",
        path: ["servers"],
        message: `At most ${MAX_SERVERS} MCP servers may be configured.`,
      });
    }
  });

export interface McpToolPolicyConfiguration {
  effect: Extract<ToolEffect, "read">;
}

export interface McpServerConfiguration {
  id: string;
  command: string;
  args: string[];
  cwd?: string;
  environmentNames: string[];
  tools: Readonly<Record<string, McpToolPolicyConfiguration>>;
  startupTimeoutMs: number;
  callTimeoutMs: number;
}

export interface McpConfiguration {
  sourcePath?: string;
  servers: McpServerConfiguration[];
}

export interface LoadMcpConfigurationOptions {
  environment: NodeJS.ProcessEnv;
  kodaHome: string;
  processDirectory: string;
}

export async function loadMcpConfiguration(
  options: LoadMcpConfigurationOptions,
): Promise<McpConfiguration> {
  const explicitPath = options.environment.KODA_MCP_CONFIG?.trim();
  const sourcePath =
    explicitPath === undefined || explicitPath.length === 0
      ? join(options.kodaHome, "mcp.json")
      : resolve(options.processDirectory, explicitPath);
  let bytes: Buffer;
  try {
    const file = await lstat(sourcePath);
    if (!file.isFile()) {
      throw new McpClientError(
        "MCP_CONFIGURATION_INVALID",
        `MCP configuration '${sourcePath}' is not a regular file.`,
      );
    }
    if (file.size > MAX_CONFIG_BYTES) {
      throw new McpClientError(
        "MCP_CONFIGURATION_INVALID",
        `MCP configuration exceeds the ${MAX_CONFIG_BYTES}-byte limit.`,
      );
    }
    bytes = await readFile(sourcePath);
  } catch (error) {
    if (
      isNodeError(error, "ENOENT") &&
      (explicitPath === undefined || explicitPath.length === 0)
    ) {
      return { servers: [] };
    }
    if (error instanceof McpClientError) {
      throw error;
    }
    throw new McpClientError(
      "MCP_CONFIGURATION_INVALID",
      `Could not read MCP configuration '${sourcePath}': ${errorMessage(error)}`,
      { cause: error },
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new McpClientError(
      "MCP_CONFIGURATION_INVALID",
      `MCP configuration '${sourcePath}' is not valid JSON.`,
      { cause: error },
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
    throw new McpClientError(
      "MCP_CONFIGURATION_INVALID",
      `MCP configuration '${sourcePath}' is invalid: ${issues}`,
    );
  }

  const servers: McpServerConfiguration[] = [];
  for (const [id, server] of Object.entries(parsed.data.servers).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    let cwd: string | undefined;
    if (server.cwd !== undefined) {
      if (!isAbsolute(server.cwd)) {
        throw new McpClientError(
          "MCP_CONFIGURATION_INVALID",
          `MCP server '${id}' working directory must be absolute.`,
        );
      }
      try {
        const canonical = await realpath(server.cwd);
        const statistics = await stat(canonical);
        if (!statistics.isDirectory()) {
          throw new Error("Path is not a directory.");
        }
        cwd = canonical;
      } catch (error) {
        throw new McpClientError(
          "MCP_CONFIGURATION_INVALID",
          `MCP server '${id}' working directory is invalid: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    }
    servers.push({
      id,
      command: server.command,
      args: [...server.args],
      ...(cwd === undefined ? {} : { cwd }),
      environmentNames: [...server.env],
      tools: server.tools,
      startupTimeoutMs: server.startup_timeout_ms,
      callTimeoutMs: server.call_timeout_ms,
    });
  }
  return { sourcePath, servers };
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
