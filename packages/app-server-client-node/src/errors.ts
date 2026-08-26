export type AppServerClientErrorCode =
  | "APP_SERVER_START_FAILED"
  | "APP_SERVER_CONNECTION_CLOSED"
  | "APP_SERVER_PROTOCOL_ERROR"
  | "APP_SERVER_REQUEST_TIMEOUT"
  | "APP_SERVER_REQUEST_FAILED"
  | "APP_SERVER_SHUTDOWN_FAILED";

export class AppServerClientError extends Error {
  public constructor(
    public readonly code: AppServerClientErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(boundClientMessage(message), options);
    this.name = "AppServerClientError";
  }
}

export class AppServerRpcError extends AppServerClientError {
  public constructor(
    public readonly rpcCode: number,
    message: string,
    public readonly dataCode?: string,
  ) {
    super("APP_SERVER_REQUEST_FAILED", message);
    this.name = "AppServerRpcError";
  }
}

export function boundClientMessage(message: string): string {
  const normalized = message.replace(/[\r\n]+/gu, " ");
  return normalized.length <= 1_000
    ? normalized
    : `${normalized.slice(0, 997)}...`;
}

export function clientErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
