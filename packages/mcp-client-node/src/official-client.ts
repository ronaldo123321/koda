import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import type { JsonObject } from "@koda/protocol";

import type { McpServerConfiguration } from "./config.js";
import { McpClientError, errorMessage } from "./errors.js";

export interface McpConnection {
  readonly serverId: string;
  listTools(signal: AbortSignal, timeoutMs: number): Promise<readonly Tool[]>;
  callTool(
    tool: Tool,
    arguments_: JsonObject,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

export type McpConnectionFactory = (
  configuration: McpServerConfiguration,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
) => Promise<McpConnection>;

export const connectOfficialMcpClient: McpConnectionFactory = async (
  configuration,
  environment,
  signal,
) => {
  const childEnvironment = getDefaultEnvironment();
  for (const name of configuration.environmentNames) {
    const value = environment[name];
    if (value === undefined) {
      throw new McpClientError(
        "MCP_CONFIGURATION_INVALID",
        `MCP server '${configuration.id}' requires environment variable '${name}'.`,
      );
    }
    childEnvironment[name] = value;
  }
  const transport = new StdioClientTransport({
    command: configuration.command,
    args: configuration.args,
    env: childEnvironment,
    stderr: "pipe",
    ...(configuration.cwd === undefined ? {} : { cwd: configuration.cwd }),
  });
  transport.stderr?.on("data", () => {
    // Consume untrusted server diagnostics without forwarding possible secrets.
  });
  const client = new Client(
    { name: "koda", version: "0.1.0" },
    { listMaxPages: 64 },
  );
  try {
    await client.connect(transport, {
      signal,
      timeout: configuration.startupTimeoutMs,
      maxTotalTimeout: configuration.startupTimeoutMs,
    });
  } catch (error) {
    await client.close().catch(() => undefined);
    if (signal.aborted) {
      signal.throwIfAborted();
    }
    throw classifyMcpError(
      error,
      "MCP_SERVER_START_FAILED",
      `Could not start MCP server '${configuration.id}'`,
    );
  }
  return {
    serverId: configuration.id,
    listTools: async (requestSignal, timeoutMs) => {
      try {
        const result = await client.listTools(undefined, {
          signal: requestSignal,
          timeout: timeoutMs,
          maxTotalTimeout: timeoutMs,
          cacheMode: "refresh",
        });
        return result.tools;
      } catch (error) {
        if (requestSignal.aborted) {
          requestSignal.throwIfAborted();
        }
        throw classifyMcpError(
          error,
          "MCP_TOOL_CATALOG_INVALID",
          `Could not discover tools from MCP server '${configuration.id}'`,
        );
      }
    },
    callTool: async (tool, arguments_, requestSignal, timeoutMs) => {
      try {
        return await client.callTool(
          { name: tool.name, arguments: arguments_ },
          {
            signal: requestSignal,
            timeout: timeoutMs,
            maxTotalTimeout: timeoutMs,
            toolDefinition: tool,
          },
        );
      } catch (error) {
        if (requestSignal.aborted) {
          requestSignal.throwIfAborted();
        }
        throw classifyMcpError(
          error,
          "MCP_PROTOCOL_ERROR",
          `MCP tool '${configuration.id}/${tool.name}' failed`,
        );
      }
    },
    close: async () => {
      await client.close();
    },
  };
};

function classifyMcpError(
  error: unknown,
  fallbackCode:
    | "MCP_SERVER_START_FAILED"
    | "MCP_TOOL_CATALOG_INVALID"
    | "MCP_PROTOCOL_ERROR",
  prefix: string,
): McpClientError {
  if (error instanceof McpClientError) {
    return error;
  }
  if (SdkError.isInstance(error)) {
    if (error.code === SdkErrorCode.RequestTimeout) {
      return new McpClientError(
        fallbackCode === "MCP_PROTOCOL_ERROR"
          ? "MCP_TOOL_TIMEOUT"
          : fallbackCode,
        `${prefix}: timed out.`,
        { cause: error },
      );
    }
    if (
      fallbackCode !== "MCP_SERVER_START_FAILED" &&
      [
        SdkErrorCode.ConnectionClosed,
        SdkErrorCode.NotConnected,
        SdkErrorCode.SendFailed,
      ].includes(error.code)
    ) {
      return new McpClientError(
        "MCP_CONNECTION_CLOSED",
        `${prefix}: connection closed.`,
        { cause: error },
      );
    }
    if (error.code === SdkErrorCode.InvalidResult) {
      return new McpClientError(
        "MCP_INVALID_RESULT",
        `${prefix}: invalid result.`,
        { cause: error },
      );
    }
  }
  if (ProtocolError.isInstance(error)) {
    return new McpClientError(
      "MCP_PROTOCOL_ERROR",
      `${prefix}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  return new McpClientError(fallbackCode, `${prefix}: ${errorMessage(error)}`, {
    cause: error,
  });
}
