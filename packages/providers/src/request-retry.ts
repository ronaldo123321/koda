class StreamCleanupError extends Error {}

const MAX_RETRIES = 2;
const MAX_WAIT_MS = 30_000;

/** Retry only request acquisition. Never wrap consumption of a response stream.
 * Clients supplied by callers must disable their own retries to avoid multiplying
 * this budget; the built-in provider factories do so explicitly.
 */
export async function requestWithRetry<T>(
  request: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const budget = new RequestRetryBudget();
  for (;;) {
    signal.throwIfAborted();
    try {
      return await request();
    } catch (error) {
      await budget.wait(error, signal);
    }
  }
}

/** Shared budget for acquisition and consumption of resumed GET streams. */
export class RequestRetryBudget {
  private retries = 0;
  private waited = 0;
  public async wait(error: unknown, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.retries >= MAX_RETRIES || !isRetryable(error)) throw error;
    const wait = retryAfter(error) ?? 500 * 2 ** this.retries;
    if (wait > MAX_WAIT_MS - this.waited) throw error;
    this.waited += wait;
    this.retries += 1;
    await waitForRetry(wait, signal);
  }
}

/** Acquire and prime a stream under one retry budget. The first raw event is
 * the replay boundary, even if it is only metadata and not visible to the user.
 * Empty successful streams are left to the provider's protocol validation.
 */
export async function* streamWithRetry<T>(
  request: () => Promise<AsyncIterable<T>>,
  signal: AbortSignal,
): AsyncIterable<T> {
  const { iterator, first } = await requestWithRetry(async () => {
    const stream = await request();
    const iterator = stream[Symbol.asyncIterator]();
    try {
      signal.throwIfAborted();
      const first = await iterator.next();
      signal.throwIfAborted();
      return { iterator, first };
    } catch (error) {
      try {
        await iterator.return?.();
      } catch (cleanupError) {
        // Do not open another stream if the previous stream could not close.
        throw new StreamCleanupError(
          "Provider stream cleanup failed before retry.",
          {
            cause: cleanupError,
          },
        );
      }
      throw error;
    }
  }, signal);

  let item = first;
  try {
    while (!item.done) {
      signal.throwIfAborted();
      yield item.value;
      signal.throwIfAborted();
      item = await iterator.next();
    }
  } finally {
    if (!item.done) await iterator.return?.();
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof StreamCleanupError) return false;
  if (error === null || typeof error !== "object") return false;
  if ("status" in error && typeof error.status === "number") {
    return (
      error.status === 408 ||
      error.status === 429 ||
      (error.status >= 500 && error.status <= 599)
    );
  }
  if (
    error instanceof Error &&
    (error.name === "APIConnectionError" ||
      error.name === "APIConnectionTimeoutError")
  )
    return true;
  // Node fetch may surface a broken response body through a transport cause.
  const cause = "cause" in error ? error.cause : undefined;
  const code =
    "code" in error
      ? error.code
      : cause !== null && typeof cause === "object" && "code" in cause
        ? cause.code
        : undefined;
  return (
    typeof code === "string" &&
    ["ECONNRESET", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET"].includes(code)
  );
}

function retryAfter(error: unknown): number | undefined {
  if (error === null || typeof error !== "object" || !("headers" in error))
    return;
  const headers = error.headers;
  if (headers === null || typeof headers !== "object") return;
  const value =
    headers instanceof Headers
      ? headers.get("retry-after")
      : "retry-after" in headers
        ? headers["retry-after"]
        : undefined;
  if (typeof value !== "string" || value.trim() === "") return;
  const seconds = Number(value);
  if (Number.isFinite(seconds))
    return seconds >= 0 ? seconds * 1_000 : undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function waitForRetry(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
