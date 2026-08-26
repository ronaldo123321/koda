export type ProviderErrorCode =
  | "PROVIDER_AUTHENTICATION_FAILED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_REQUEST_FAILED"
  | "PROVIDER_PROTOCOL_ERROR"
  | "PROVIDER_OUTPUT_INVALID";

export class ProviderError extends Error {
  public constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(boundProviderMessage(message), options);
    this.name = "ProviderError";
  }
}

export function mapProviderRequestError(
  providerName: string,
  error: unknown,
  signal: AbortSignal,
): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }
  if (signal.aborted) {
    return new ProviderError(
      "PROVIDER_REQUEST_FAILED",
      `The ${providerName} request was cancelled.`,
      { cause: error },
    );
  }
  const status =
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : undefined;
  const code =
    status === 401 || status === 403
      ? "PROVIDER_AUTHENTICATION_FAILED"
      : status === 429
        ? "PROVIDER_RATE_LIMITED"
        : "PROVIDER_REQUEST_FAILED";
  return new ProviderError(
    code,
    code === "PROVIDER_AUTHENTICATION_FAILED"
      ? `${providerName} rejected the configured credential.`
      : code === "PROVIDER_RATE_LIMITED"
        ? `${providerName} rate-limited the request.`
        : `The ${providerName} request failed.`,
    { cause: error },
  );
}

function boundProviderMessage(message: string): string {
  const normalized = message.replace(/[\r\n]+/gu, " ");
  return normalized.length <= 1_000
    ? normalized
    : `${normalized.slice(0, 997)}...`;
}
