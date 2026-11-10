import { requestWithRetry, streamWithRetry } from "@koda/providers";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.useRealTimers());

const signal = () => new AbortController().signal;

describe("provider request retry", () => {
  it("retries transient acquisition failures with bounded backoff", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockRejectedValueOnce({ status: 503 })
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValue("stream");
    const result = requestWithRetry(request, signal());
    await vi.advanceTimersByTimeAsync(499);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBe("stream");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("stops after two retries and preserves the final error", async () => {
    vi.useFakeTimers();
    const error = { status: 503 };
    const request = vi.fn().mockRejectedValue(error);
    const result = expect(requestWithRetry(request, signal())).rejects.toBe(
      error,
    );
    await vi.runAllTimersAsync();
    await result;
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each([400, 401, 403, 404, 422])(
    "does not retry HTTP %s",
    async (status) => {
      const error = { status };
      const request = vi.fn().mockRejectedValue(error);
      await expect(requestWithRetry(request, signal())).rejects.toBe(error);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["APIConnectionError", "APIConnectionTimeoutError"])(
    "retries %s",
    async (name) => {
      vi.useFakeTimers();
      const error = new Error("connection failed");
      error.name = name;
      const request = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue("stream");
      const result = requestWithRetry(request, signal());
      await vi.runAllTimersAsync();
      await expect(result).resolves.toBe("stream");
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])(
    "honors Retry-After seconds and dates (date=%s)",
    async (date) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const value = date ? "Thu, 01 Jan 2026 00:00:02 GMT" : "2";
      const request = vi
        .fn()
        .mockRejectedValueOnce({
          status: 429,
          headers: new Headers({ "Retry-After": value }),
        })
        .mockResolvedValue("stream");
      const result = requestWithRetry(request, signal());
      await vi.advanceTimersByTimeAsync(1_999);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe("stream");
    },
  );

  it("does not shorten server advice beyond the remaining wait budget", async () => {
    vi.useFakeTimers();
    const error = { status: 429, headers: { "retry-after": "20" } };
    const request = vi.fn().mockRejectedValue(error);
    const result = expect(requestWithRetry(request, signal())).rejects.toBe(
      error,
    );
    await vi.runAllTimersAsync();
    await result;
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("cancels during backoff without sending another request", async () => {
    const controller = new AbortController();
    const request = vi
      .fn()
      .mockRejectedValue({ status: 429, headers: { "retry-after": "30" } });
    const result = expect(
      requestWithRetry(request, controller.signal),
    ).rejects.toThrow();
    await Promise.resolve();
    controller.abort();
    await result;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("never sends an already cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn();
    await expect(
      requestWithRetry(request, controller.signal),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not replay a stream after partial output and a transient failure", async () => {
    const error = { status: 503 };
    const request = vi.fn(async function* () {
      yield "partial output";
      throw error;
    });
    const stream = await requestWithRetry(async () => request(), signal());
    expect(await stream.next()).toEqual({
      value: "partial output",
      done: false,
    });
    await expect(stream.next()).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("provider stream retry", () => {
  it("shares one budget across acquisition and first-event failures", async () => {
    vi.useFakeTimers();
    const error = { status: 503 };
    const close = vi.fn(async () => ({
      done: true as const,
      value: undefined,
    }));
    const request = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw error;
          },
          return: close,
        }),
      })
      .mockResolvedValueOnce(
        (async function* () {
          yield "recovered";
        })(),
      );
    const collected = collectStream(streamWithRetry(request, signal()));
    await vi.runAllTimersAsync();
    await expect(collected).resolves.toEqual(["recovered"]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("stops retrying failed first reads after three total attempts", async () => {
    vi.useFakeTimers();
    const error = { status: 503 };
    const request = vi.fn(async () =>
      (async function* () {
        throw error;
        yield "unreachable";
      })(),
    );
    const result = expect(
      collectStream(streamWithRetry(request, signal())),
    ).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await result;
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("does not replay even after a metadata-only first event", async () => {
    const error = { status: 503 };
    const request = vi.fn(async () =>
      (async function* () {
        yield "created";
        throw error;
      })(),
    );
    const iterator = streamWithRetry(request, signal())[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe("created");
    await expect(iterator.next()).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("closes a stream cancelled while awaiting its first event without retrying", async () => {
    const controller = new AbortController();
    const close = vi.fn(async () => ({
      done: true as const,
      value: undefined,
    }));
    const request = vi.fn(async () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          controller.abort();
          return { done: false as const, value: "first" };
        },
        return: close,
      }),
    }));
    await expect(
      collectStream(streamWithRetry(request, controller.signal)),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("recognizes a Node transport reset before the first event", async () => {
    vi.useFakeTimers();
    const error = new TypeError("terminated", {
      cause: { code: "ECONNRESET" },
    });
    const request = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(
        (async function* () {
          yield "ok";
        })(),
      );
    const result = collectStream(streamWithRetry(request, signal()));
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual(["ok"]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not retry malformed stream data", async () => {
    const error = new SyntaxError("invalid event JSON");
    const request = vi.fn(async () =>
      (async function* () {
        throw error;
        yield "unreachable";
      })(),
    );
    await expect(
      collectStream(streamWithRetry(request, signal())),
    ).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not retry empty successful streams", async () => {
    const request = vi.fn(async () => (async function* () {})());
    await expect(
      collectStream(streamWithRetry(request, signal())),
    ).resolves.toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("closes the underlying iterator when the consumer stops", async () => {
    let closed = false;
    const request = async () =>
      (async function* () {
        try {
          yield "first";
          yield "second";
        } finally {
          closed = true;
        }
      })();
    for await (const value of streamWithRetry(request, signal())) {
      expect(value).toBe("first");
      break;
    }
    expect(closed).toBe(true);
  });

  it("does not retry if failed stream cleanup also fails", async () => {
    const request = vi.fn(async () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw { status: 503 };
        },
        return: async () => {
          throw Object.assign(new Error("cannot close"), {
            code: "ECONNRESET",
          });
        },
      }),
    }));
    await expect(
      collectStream(streamWithRetry(request, signal())),
    ).rejects.toThrow("cleanup failed");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

async function collectStream<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}
