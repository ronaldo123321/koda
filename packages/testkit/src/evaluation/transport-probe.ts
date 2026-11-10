export type Fault = "rate_limit_once" | "disconnect_once";
export interface TransportEvidence {
  injected: boolean;
  creates: number;
  retrieves: number;
  cancels: number;
  cancelAcknowledged: number;
  cancelHttpStatuses: number[];
  cancelledResponseConfirmed: boolean;
  responseId: string | null;
  upstreamRequests: number;
}

/** Only used by the sequential standalone evaluation process, never application code. */
export async function withTransportProbe<T>(
  fault: Fault | undefined,
  run: (evidence: TransportEvidence) => Promise<T>,
  onLifecycle?: (status: string | null) => void,
  observedEvent:
    "response.created" | "response.in_progress" = "response.created",
): Promise<T> {
  const original = globalThis.fetch;
  const evidence: TransportEvidence = {
    injected: false,
    creates: 0,
    retrieves: 0,
    cancels: 0,
    cancelAcknowledged: 0,
    cancelHttpStatuses: [],
    cancelledResponseConfirmed: false,
    responseId: null,
    upstreamRequests: 0,
  };
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const method = (init?.method ?? request.method).toUpperCase();
    const isResponses =
      url.hostname === "api.openai.com" && url.pathname === "/v1/responses";
    const isMessages =
      url.hostname === "api.anthropic.com" && url.pathname === "/v1/messages";
    const create = method === "POST" && (isResponses || isMessages);
    if (create) evidence.creates += 1;
    if (
      url.hostname === "api.openai.com" &&
      /^\/v1\/responses\/[^/]+$/.test(url.pathname) &&
      method === "GET"
    )
      evidence.retrieves += 1;
    const cancelRequest =
      url.hostname === "api.openai.com" &&
      url.pathname.endsWith("/cancel") &&
      method === "POST";
    if (cancelRequest) {
      evidence.cancels += 1;
      evidence.responseId =
        /^\/v1\/responses\/([A-Za-z0-9_-]+)\/cancel$/.exec(url.pathname)?.[1] ??
        null;
    }
    if (create && fault === "rate_limit_once" && !evidence.injected) {
      evidence.injected = true;
      return new Response(
        JSON.stringify({
          error: {
            message: "Controlled evaluation rate limit",
            type: "rate_limit_error",
          },
        }),
        {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "0" },
        },
      );
    }
    evidence.upstreamRequests += 1;
    const response = await original(input, init);
    if (cancelRequest) {
      evidence.cancelHttpStatuses.push(response.status);
      if (response.ok) {
        evidence.cancelAcknowledged += 1;
        try {
          const result = (await response.clone().json()) as {
            status?: unknown;
          };
          evidence.cancelledResponseConfirmed = result.status === "cancelled";
        } catch {
          /* An acknowledgement alone does not establish terminal state. */
        }
      }
    }
    if (
      !create ||
      !isResponses ||
      (fault !== "disconnect_once" && !onLifecycle) ||
      (fault === "disconnect_once" && evidence.injected) ||
      !response.ok ||
      !response.body
    )
      return response;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffered = "";
    let cut = false;
    let lifecycleObserved = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (cut) {
          controller.error(
            Object.assign(new Error("Controlled evaluation disconnect"), {
              code: "ECONNRESET",
            }),
          );
          return;
        }
        try {
          for (;;) {
            let emitted = false;
            const next = await reader.read();
            if (next.done) {
              buffered += decoder.decode();
              if (buffered) controller.enqueue(encoder.encode(buffered));
              controller.close();
              return;
            }
            buffered += decoder.decode(next.value, { stream: true });
            // SDK may return multiple SSE events in a chunk. Cut exactly after the
            // first complete text delta, before any completion in that same chunk.
            let separator: RegExpExecArray | null;
            const boundary = /\r?\n\r?\n/g;
            while ((separator = boundary.exec(buffered))) {
              const end = separator.index + separator[0].length;
              const frame = buffered.slice(0, end);
              controller.enqueue(encoder.encode(frame));
              emitted = true;
              if (onLifecycle && !lifecycleObserved) {
                const data = frame
                  .split(/\r?\n/)
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trimStart())
                  .join("\n");
                let parsed:
                  | { type?: unknown; response?: { status?: unknown } }
                  | undefined;
                try {
                  parsed = JSON.parse(data);
                } catch {
                  /* Leave protocol validation to the SDK. */
                }
                if (parsed?.type === observedEvent) {
                  lifecycleObserved = true;
                  const status = parsed.response?.status;
                  onLifecycle(
                    status === "queued" || status === "in_progress"
                      ? status
                      : null,
                  );
                }
              }
              buffered = buffered.slice(end);
              boundary.lastIndex = 0;
              if (
                fault === "disconnect_once" &&
                /"type"\s*:\s*"response\.output_text\.delta"/.test(frame)
              ) {
                cut = true;
                evidence.injected = true;
                await reader.cancel();
                return;
              }
            }
            if (buffered.length > 1_048_576)
              throw new Error("Evaluation SSE frame exceeded its limit.");
            if (emitted) return;
          }
        } catch (error) {
          controller.error(error);
          await reader.cancel().catch(() => {});
        }
      },
      cancel: () => reader.cancel(),
    });
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  try {
    return await run(evidence);
  } finally {
    globalThis.fetch = original;
  }
}
