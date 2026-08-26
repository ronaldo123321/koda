export type McpClientErrorCode =
  | "MCP_CONFIGURATION_INVALID"
  | "MCP_SERVER_START_FAILED"
  | "MCP_TOOL_CATALOG_INVALID"
  | "MCP_TOOL_TIMEOUT"
  | "MCP_CONNECTION_CLOSED"
  | "MCP_PROTOCOL_ERROR"
  | "MCP_TOOL_ERROR"
  | "MCP_INVALID_RESULT"
  | "MCP_OUTPUT_LIMIT_EXCEEDED"
  | "MCP_SESSION_CLEANUP_FAILED";

export class McpClientError extends Error {
  public constructor(
    public readonly code: McpClientErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(boundMcpMessage(message), options);
    this.name = "McpClientError";
  }
}

export function boundMcpMessage(message: string): string {
  const normalized = message.replace(/[\r\n]+/gu, " ");
  return normalized.length <= 1_000
    ? normalized
    : `${normalized.slice(0, 997)}...`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
