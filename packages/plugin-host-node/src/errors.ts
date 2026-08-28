export type PluginHostErrorCode =
  | "PLUGIN_CONFIGURATION_INVALID"
  | "PLUGIN_SERVER_START_FAILED"
  | "PLUGIN_SERVER_EXITED"
  | "PLUGIN_PROTOCOL_INVALID"
  | "PLUGIN_VERSION_UNSUPPORTED"
  | "PLUGIN_CAPABILITY_INVALID"
  | "PLUGIN_CONTRIBUTION_INVALID"
  | "PLUGIN_TOOL_ERROR"
  | "PLUGIN_OUTPUT_LIMIT_EXCEEDED"
  | "PLUGIN_CONNECTION_CLOSED"
  | "PLUGIN_TIMEOUT"
  | "PLUGIN_SESSION_CLEANUP_FAILED";

export class PluginHostError extends Error {
  public constructor(
    public readonly code: PluginHostErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PluginHostError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function pluginErrorCode(error: unknown): PluginHostErrorCode {
  return error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("PLUGIN_")
    ? ((error as { code: PluginHostErrorCode }).code as PluginHostErrorCode)
    : "PLUGIN_CONTRIBUTION_INVALID";
}
