import type { Tool } from "@modelcontextprotocol/client";
import {
  sha256CanonicalJson,
  type ToolCatalogReplacement,
  type ToolEffect,
  type ToolRegistry,
} from "@koda/agent-core";
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
const MAX_TOOL_DEFINITION_BYTES = 65_536;
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
  definition: Tool;
  definitionSha256: string;
}

interface McpServerConnection {
  server: McpServerConfiguration;
  connection: McpConnection;
}

export interface OpenMcpTurnSessionOptions {
  environment: NodeJS.ProcessEnv;
  kodaHome: string;
  processDirectory: string;
  artifactStore: ArtifactStore;
  signal: AbortSignal;
  connectionFactory?: McpConnectionFactory;
  serverIds?: readonly string[];
}

export async function inspectMcpServerTools(
  options: Pick<
    OpenMcpTurnSessionOptions,
    | "environment"
    | "kodaHome"
    | "processDirectory"
    | "signal"
    | "connectionFactory"
  >,
  serverId: string,
): Promise<
  readonly { name: string; definitionSha256: string; definition: Tool }[]
> {
  const configuration = await loadMcpConfiguration(options);
  const server = configuration.servers.find((item) => item.id === serverId);
  if (server === undefined) {
    throw new McpClientError(
      "MCP_CONFIGURATION_INVALID",
      `MCP server '${serverId}' is unavailable.`,
    );
  }
  const connection = await (
    options.connectionFactory ?? connectOfficialMcpClient
  )(server, options.environment, options.signal, options.kodaHome);
  try {
    const tools = await discoverTools(
      [{ server, connection }],
      options.signal,
      true,
      false,
    );
    return tools.map((tool) => ({
      name: tool.originalName,
      definitionSha256: tool.definitionSha256,
      definition: tool.definition,
    }));
  } finally {
    await connection.close();
  }
}

export class McpTurnSession {
  private closed = false;
  private registry: ToolRegistry | undefined;

  private constructor(
    private readonly connections: McpServerConnection[],
    private tools: RegisteredMcpTool[],
    private readonly artifactStore: ArtifactStore,
    private readonly remoteSelection: boolean,
  ) {}

  public static async open(
    options: OpenMcpTurnSessionOptions,
  ): Promise<McpTurnSession> {
    const configuration = await loadMcpConfiguration(options);
    const selected = options.serverIds;
    if (
      selected !== undefined &&
      (selected.length === 0 ||
        new Set(selected).size !== selected.length ||
        selected.some(
          (id) =>
            !configuration.servers.some(
              (server) => server.id === id && server.remoteToolNames.length > 0,
            ),
        ))
    ) {
      throw new McpClientError(
        "MCP_CONFIGURATION_INVALID",
        "Selected MCP servers are unavailable.",
      );
    }
    const connections: McpServerConnection[] = [];
    const connectionFactory =
      options.connectionFactory ?? connectOfficialMcpClient;
    try {
      for (const server of configuration.servers) {
        if (selected !== undefined && !selected.includes(server.id)) continue;
        options.signal.throwIfAborted();
        const connection = await connectionFactory(
          server,
          options.environment,
          options.signal,
          options.kodaHome,
        );
        connections.push({ server, connection });
      }
      const tools = await discoverTools(
        connections,
        options.signal,
        true,
        selected !== undefined,
      );
      return new McpTurnSession(
        connections,
        tools,
        options.artifactStore,
        selected !== undefined,
      );
    } catch (error) {
      await closeConnections(connections);
      if (options.signal.aborted) {
        options.signal.throwIfAborted();
      }
      throw error;
    }
  }

  public registerTools(registry: ToolRegistry): void {
    if (this.registry !== undefined) {
      throw catalogError("MCP tools are already registered for this Turn.");
    }
    try {
      installTools(registry, this.tools, this.artifactStore, () => this.closed);
      this.registry = registry;
    } catch (error) {
      throw catalogError(
        `MCP tool catalog conflicts with the Koda registry: ${errorMessage(error)}`,
      );
    }
  }

  public async refreshTools(
    step: number,
    signal: AbortSignal,
  ): Promise<ToolCatalogReplacement | undefined> {
    if (step === 1 || this.connections.length === 0) {
      return undefined;
    }
    if (this.closed) {
      throw new McpClientError(
        "MCP_CONNECTION_CLOSED",
        "MCP session is closed.",
      );
    }
    const registry = this.registry;
    if (registry === undefined) {
      throw catalogError("MCP tools must be registered before refresh.");
    }
    const candidate = await discoverTools(
      this.connections,
      signal,
      false,
      this.remoteSelection,
    );
    if (sameTools(this.tools, candidate)) {
      return undefined;
    }
    let replacement: ToolCatalogReplacement;
    try {
      replacement = installTools(
        registry,
        candidate,
        this.artifactStore,
        () => this.closed,
      );
    } catch (error) {
      throw catalogError(
        `Refreshed MCP tool catalog conflicts with the Koda registry: ${errorMessage(error)}`,
      );
    }
    if (replacement.changes.length === 0) {
      throw catalogError(
        "Refreshed MCP definitions changed without producing generation evidence.",
      );
    }
    this.tools = candidate;
    return replacement;
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

function installTools(
  registry: ToolRegistry,
  tools: readonly RegisteredMcpTool[],
  artifactStore: ArtifactStore,
  isClosed: () => boolean,
): ToolCatalogReplacement {
  return registry.replaceNamespace("mcp", (register) => {
    for (const tool of tools) {
      register({
        spec: {
          name: tool.alias,
          description: tool.description,
          inputJsonSchema: tool.inputSchema,
        },
        inputSchema: jsonObjectSchema,
        concurrency: "exclusive",
        effect: tool.effect,
        catalogIdentity: {
          source: "mcp",
          server_id: tool.server.id,
          original_name: tool.originalName,
          definition_sha256: tool.definitionSha256,
        },
        prepare: async (context, input) => ({
          approval: approvalPreview(tool, input),
          execute: async (): Promise<JsonValue> => {
            if (isClosed()) {
              throw new McpClientError(
                "MCP_CONNECTION_CLOSED",
                `MCP session for '${tool.server.id}' is closed.`,
              );
            }
            const result = await tool.connection.callTool(
              structuredClone(tool.definition),
              input,
              context.signal,
              tool.server.callTimeoutMs,
            );
            return materializeMcpToolResult(result, artifactStore);
          },
        }),
      });
    }
  });
}

function normalizeTool(
  server: McpServerConfiguration,
  connection: McpConnection,
  definition: Tool,
): RegisteredMcpTool {
  const definitionSnapshot = structuredClone(definition);
  if (
    Buffer.byteLength(JSON.stringify(definitionSnapshot)) >
    MAX_TOOL_DEFINITION_BYTES
  ) {
    throw catalogError(
      `MCP tool '${server.id}/${definitionSnapshot.name}' definition exceeds the ${MAX_TOOL_DEFINITION_BYTES}-byte limit.`,
    );
  }
  const alias = `mcp__${server.id}__${definitionSnapshot.name}`;
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(alias)) {
    throw catalogError(
      `MCP tool '${server.id}/${definitionSnapshot.name}' cannot form a valid model alias.`,
    );
  }
  const schema = jsonObjectSchema.safeParse(definitionSnapshot.inputSchema);
  if (!schema.success || schema.data.type !== "object") {
    throw catalogError(
      `MCP tool '${server.id}/${definitionSnapshot.name}' must provide an object input schema.`,
    );
  }
  const schemaBytes = Buffer.byteLength(stableJsonStringify(schema.data));
  if (schemaBytes > MAX_TOOL_SCHEMA_BYTES) {
    throw catalogError(
      `MCP tool '${server.id}/${definitionSnapshot.name}' schema exceeds the ${MAX_TOOL_SCHEMA_BYTES}-byte limit.`,
    );
  }
  const configured = server.tools[definitionSnapshot.name];
  return {
    alias,
    server,
    connection,
    originalName: definitionSnapshot.name,
    description:
      definitionSnapshot.description?.trim() ||
      `Call '${definitionSnapshot.name}' on the local MCP server '${server.id}'.`,
    inputSchema: schema.data,
    effect: configured?.effect ?? "execute",
    definition: definitionSnapshot,
    definitionSha256: sha256CanonicalJson(definitionSnapshot),
  };
}

async function discoverTools(
  connections: readonly McpServerConnection[],
  signal: AbortSignal,
  startup: boolean,
  remoteSelection: boolean,
): Promise<RegisteredMcpTool[]> {
  const tools: RegisteredMcpTool[] = [];
  const aliases = new Set<string>();
  let catalogBytes = 0;
  for (const { server, connection } of connections) {
    signal.throwIfAborted();
    const definitions = await connection.listTools(
      signal,
      startup ? server.startupTimeoutMs : server.callTimeoutMs,
    );
    const discoveredNames = new Set<string>();
    for (const definition of definitions) {
      if (
        remoteSelection &&
        !server.remoteToolNames.includes(definition.name)
      ) {
        continue;
      }
      if (tools.length >= MAX_TOOLS) {
        throw catalogError(
          `MCP tool catalog exceeds the ${MAX_TOOLS}-tool limit.`,
        );
      }
      const tool = normalizeTool(server, connection, definition);
      if (
        remoteSelection &&
        server.remoteToolDigests[tool.originalName] !== tool.definitionSha256
      ) {
        throw catalogError(
          `MCP server '${server.id}' remote tool '${tool.originalName}' has no matching reviewed definition digest.`,
        );
      }
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
        `${tool.alias}\n${JSON.stringify(tool.definition)}`,
      );
      if (catalogBytes > MAX_CATALOG_BYTES) {
        throw catalogError(
          `MCP tool catalog exceeds the ${MAX_CATALOG_BYTES}-byte limit.`,
        );
      }
      tools.push(tool);
    }
    for (const configuredName of Object.keys(server.tools)) {
      if (
        (!remoteSelection || server.remoteToolNames.includes(configuredName)) &&
        !discoveredNames.has(configuredName)
      ) {
        throw catalogError(
          `MCP server '${server.id}' configures unknown read tool '${configuredName}'.`,
        );
      }
    }
    if (remoteSelection) {
      for (const allowedName of server.remoteToolNames) {
        if (!discoveredNames.has(allowedName)) {
          throw catalogError(
            `MCP server '${server.id}' has no reviewed remote tool '${allowedName}'.`,
          );
        }
      }
    }
  }
  return tools.sort((left, right) =>
    left.alias < right.alias ? -1 : left.alias > right.alias ? 1 : 0,
  );
}

function sameTools(
  previous: readonly RegisteredMcpTool[],
  current: readonly RegisteredMcpTool[],
): boolean {
  return (
    previous.length === current.length &&
    previous.every((tool, index) => {
      const candidate = current[index];
      return (
        candidate !== undefined &&
        tool.alias === candidate.alias &&
        tool.effect === candidate.effect &&
        tool.definitionSha256 === candidate.definitionSha256
      );
    })
  );
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
  connections: readonly McpServerConnection[],
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const { connection } of [...connections].reverse()) {
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
