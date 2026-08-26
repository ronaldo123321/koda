import type { Tool } from "@modelcontextprotocol/client";
import type { ToolEffect, ToolRegistry } from "@koda/agent-core";
import {
  jsonObjectSchema,
  type JsonObject,
  type JsonValue,
} from "@koda/protocol";
import { ArtifactStore } from "@koda/runtime-node";

import { loadMcpConfiguration, type McpServerConfiguration } from "./config.js";
import { McpClientError, errorMessage } from "./errors.js";
import {
  connectOfficialMcpClient,
  type McpConnection,
  type McpConnectionFactory,
} from "./official-client.js";
import { materializeMcpToolResult, stableJsonStringify } from "./result.js";

const MAX_TOOLS = 256;
const MAX_TOOL_SCHEMA_BYTES = 65_536;
const MAX_CATALOG_BYTES = 524_288;
const MAX_APPROVAL_DETAILS = 4_000;

interface RegisteredMcpTool {
  alias: string;
  server: McpServerConfiguration;
  connection: McpConnection;
  originalName: string;
  description: string;
  inputSchema: JsonObject;
  effect: ToolEffect;
}

export interface OpenMcpTurnSessionOptions {
  environment: NodeJS.ProcessEnv;
  kodaHome: string;
  processDirectory: string;
  artifactStore: ArtifactStore;
  signal: AbortSignal;
  connectionFactory?: McpConnectionFactory;
}

export class McpTurnSession {
  private closed = false;

  private constructor(
    private readonly connections: McpConnection[],
    private readonly tools: RegisteredMcpTool[],
    private readonly artifactStore: ArtifactStore,
  ) {}

  public static async open(
    options: OpenMcpTurnSessionOptions,
  ): Promise<McpTurnSession> {
    const configuration = await loadMcpConfiguration(options);
    const connections: McpConnection[] = [];
    const tools: RegisteredMcpTool[] = [];
    const aliases = new Set<string>();
    const connectionFactory =
      options.connectionFactory ?? connectOfficialMcpClient;
    let catalogBytes = 0;
    try {
      for (const server of configuration.servers) {
        options.signal.throwIfAborted();
        const connection = await connectionFactory(
          server,
          options.environment,
          options.signal,
        );
        connections.push(connection);
        const definitions = await connection.listTools(
          options.signal,
          server.startupTimeoutMs,
        );
        const discoveredNames = new Set<string>();
        for (const definition of definitions) {
          if (tools.length >= MAX_TOOLS) {
            throw catalogError(
              `MCP tool catalog exceeds the ${MAX_TOOLS}-tool limit.`,
            );
          }
          const tool = normalizeTool(server, connection, definition);
          if (discoveredNames.has(tool.originalName)) {
            throw catalogError(
              `MCP server '${server.id}' returned duplicate tool '${tool.originalName}'.`,
            );
          }
          discoveredNames.add(tool.originalName);
          if (aliases.has(tool.alias)) {
            throw catalogError(`MCP tool alias '${tool.alias}' is duplicated.`);
          }
          aliases.add(tool.alias);
          catalogBytes += Buffer.byteLength(
            `${tool.alias}\n${tool.description}\n${stableJsonStringify(tool.inputSchema)}`,
          );
          if (catalogBytes > MAX_CATALOG_BYTES) {
            throw catalogError(
              `MCP tool catalog exceeds the ${MAX_CATALOG_BYTES}-byte limit.`,
            );
          }
          tools.push(tool);
        }
        for (const configuredName of Object.keys(server.tools)) {
          if (!discoveredNames.has(configuredName)) {
            throw catalogError(
              `MCP server '${server.id}' configures unknown read tool '${configuredName}'.`,
            );
          }
        }
      }
      return new McpTurnSession(connections, tools, options.artifactStore);
    } catch (error) {
      await closeConnections(connections);
      if (options.signal.aborted) {
        options.signal.throwIfAborted();
      }
      throw error;
    }
  }

  public registerTools(registry: ToolRegistry): void {
    const existing = new Set(registry.definitions().map((tool) => tool.name));
    for (const tool of this.tools) {
      if (existing.has(tool.alias)) {
        throw catalogError(
          `MCP tool alias '${tool.alias}' conflicts with an existing Koda tool.`,
        );
      }
      existing.add(tool.alias);
    }
    for (const tool of this.tools) {
      registry.register({
        spec: {
          name: tool.alias,
          description: tool.description,
          inputJsonSchema: tool.inputSchema,
        },
        inputSchema: jsonObjectSchema,
        concurrency: "exclusive",
        effect: tool.effect,
        prepare: async (context, input) => ({
          approval: approvalPreview(tool, input),
          execute: async (): Promise<JsonValue> => {
            if (this.closed) {
              throw new McpClientError(
                "MCP_CONNECTION_CLOSED",
                `MCP session for '${tool.server.id}' is closed.`,
              );
            }
            const result = await tool.connection.callTool(
              tool.originalName,
              input,
              context.signal,
              tool.server.callTimeoutMs,
            );
            return materializeMcpToolResult(result, this.artifactStore);
          },
        }),
      });
    }
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const errors = await closeConnections(this.connections);
    if (errors.length > 0) {
      throw new McpClientError(
        "MCP_SESSION_CLEANUP_FAILED",
        `Could not close ${errors.length} MCP connection(s): ${errors.map(errorMessage).join("; ")}`,
      );
    }
  }
}

function normalizeTool(
  server: McpServerConfiguration,
  connection: McpConnection,
  definition: Tool,
): RegisteredMcpTool {
  const alias = `mcp__${server.id}__${definition.name}`;
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(alias)) {
    throw catalogError(
      `MCP tool '${server.id}/${definition.name}' cannot form a valid model alias.`,
    );
  }
  const schema = jsonObjectSchema.safeParse(definition.inputSchema);
  if (!schema.success || schema.data.type !== "object") {
    throw catalogError(
      `MCP tool '${server.id}/${definition.name}' must provide an object input schema.`,
    );
  }
  const schemaBytes = Buffer.byteLength(stableJsonStringify(schema.data));
  if (schemaBytes > MAX_TOOL_SCHEMA_BYTES) {
    throw catalogError(
      `MCP tool '${server.id}/${definition.name}' schema exceeds the ${MAX_TOOL_SCHEMA_BYTES}-byte limit.`,
    );
  }
  const configured = server.tools[definition.name];
  return {
    alias,
    server,
    connection,
    originalName: definition.name,
    description:
      definition.description?.trim() ||
      `Call '${definition.name}' on the local MCP server '${server.id}'.`,
    inputSchema: schema.data,
    effect: configured?.effect ?? "execute",
  };
}

function approvalPreview(
  tool: RegisteredMcpTool,
  input: JsonObject,
): { title: string; summary: string; details: string } {
  const details = stableJsonStringify(input);
  return {
    title: `Call MCP tool ${tool.server.id}/${tool.originalName}`,
    summary: `Invoke external MCP tool '${tool.alias}'.`,
    details:
      details.length <= MAX_APPROVAL_DETAILS
        ? details
        : `${details.slice(0, MAX_APPROVAL_DETAILS - 3)}...`,
  };
}

async function closeConnections(
  connections: readonly McpConnection[],
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const connection of [...connections].reverse()) {
    try {
      await connection.close();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function catalogError(message: string): McpClientError {
  return new McpClientError("MCP_TOOL_CATALOG_INVALID", message);
}
