/** Deliberately omit SDK messages, response bodies, headers and arbitrary error values. */
export function failureEvidence(error: unknown) {
  const codes = new Set([
    "PROVIDER_AUTHENTICATION_FAILED",
    "PROVIDER_RATE_LIMITED",
    "PROVIDER_REQUEST_FAILED",
    "PROVIDER_PROTOCOL_ERROR",
    "PROVIDER_OUTPUT_INVALID",
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "UND_ERR_SOCKET",
    "EPERM",
    "ENOTFOUND",
  ]);
  let code = "EVALUATION_FAILED";
  let httpStatus: number | null = null;
  let current = error;
  for (
    let depth = 0;
    depth < 3 && current !== null && typeof current === "object";
    depth += 1
  ) {
    if (
      "code" in current &&
      typeof current.code === "string" &&
      codes.has(current.code) &&
      code === "EVALUATION_FAILED"
    )
      code = current.code;
    if (
      "status" in current &&
      typeof current.status === "number" &&
      Number.isInteger(current.status) &&
      current.status >= 100 &&
      current.status <= 599
    )
      httpStatus = current.status;
    current = "cause" in current ? current.cause : undefined;
  }
  return { code, httpStatus };
}
