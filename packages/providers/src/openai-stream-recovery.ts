import { createHash } from "node:crypto";
import type OpenAI from "openai";
import { ProviderError } from "./errors.js";
import { RequestRetryBudget } from "./request-retry.js";
import type { OpenAIResponsesClient } from "./openai-responses.js";

type Event = OpenAI.Responses.ResponseStreamEvent;

/** Resume the same background response. Never repeat inference after output. */
export async function* recoverOpenAIStream(
  create: () => Promise<AsyncIterable<Event>>,
  responses: OpenAIResponsesClient["responses"],
  signal: AbortSignal,
  durable?: { replay?: readonly Event[]; append(event: Event): Promise<void> },
): AsyncIterable<Event> {
  if (!responses.retrieve || !responses.cancel)
    throw protocolError(
      "Stream recovery requires retrieve and cancel support.",
    );
  let responseId: string | undefined;
  let cursor = -1;
  let terminal = false;
  let replaying = durable?.replay !== undefined;
  let acquire: () => Promise<AsyncIterable<Event>> = replaying
    ? async () =>
        (async function* () {
          yield* durable!.replay!;
        })()
    : create;
  const seen = new Map<number, string>();
  const budget = new RequestRetryBudget();
  try {
    for (;;) {
      let iterator: AsyncIterator<Event> | undefined;
      let drained = false;
      let failure: unknown;
      try {
        signal.throwIfAborted();
        iterator = (await acquire())[Symbol.asyncIterator]();
        for (;;) {
          const next = await iterator.next();
          signal.throwIfAborted();
          if (next.done) {
            drained = true;
            if (replaying && !terminal) {
              if (!responseId)
                throw protocolError(
                  "The interrupted request has no durable response ID; its remote outcome is unknown. A new inference will not be started.",
                );
              break;
            }
            if (!terminal)
              throw Object.assign(
                new Error("Response stream disconnected before completion."),
                { code: "ECONNRESET" },
              );
            return;
          }
          const event = next.value;
          const sequence = event.sequence_number;
          if (!Number.isSafeInteger(sequence) || sequence < 0)
            throw protocolError(
              "Response stream has no valid sequence number.",
            );
          const digest = createHash("sha256")
            .update(JSON.stringify(event))
            .digest("hex");
          if (sequence <= cursor) {
            if (seen.get(sequence) !== digest)
              throw protocolError("Conflicting replayed response event.");
            continue;
          }
          if (cursor >= 0 && sequence !== cursor + 1)
            throw protocolError("Response stream skipped an event.");
          if (terminal)
            throw protocolError("Response stream continued after completion.");
          if ("response" in event) {
            if (responseId === undefined) {
              if (
                event.type !== "response.created" ||
                event.response.background !== true
              )
                throw protocolError(
                  "Recovery requires a background response.created event.",
                );
              if (
                sequence !== 0 ||
                typeof event.response.id !== "string" ||
                !/^[A-Za-z0-9_-]{1,256}$/.test(event.response.id)
              )
                throw protocolError(
                  "Invalid initial response identity or sequence.",
                );
              responseId = event.response.id;
            } else if (event.response.id !== responseId)
              throw protocolError("Response identity changed during recovery.");
          }
          if (!responseId)
            throw protocolError("Response output arrived before its identity.");
          if (seen.size >= 100_000)
            throw protocolError("Response stream exceeded its event limit.");
          seen.set(sequence, digest);
          cursor = sequence;
          if (!replaying) await durable?.append(event);
          terminal = [
            "response.completed",
            "response.failed",
            "response.incomplete",
          ].includes(event.type);
          yield event;
        }
      } catch (error) {
        failure = error;
      } finally {
        // A cleanup failure is terminal; do not open another stream over it.
        if (iterator && !drained) await iterator.return?.();
      }
      signal.throwIfAborted();
      if (!responseId || terminal) throw failure;
      if (!replaying || failure !== undefined)
        await budget.wait(failure, signal);
      replaying = false;
      const id = responseId;
      const startingAfter = cursor;
      acquire = () =>
        responses.retrieve!(
          id,
          { stream: true, starting_after: startingAfter },
          { signal },
        );
    }
  } finally {
    // Includes cancellation, early consumer exit, invalid output and exhaustion.
    // Use a separate bounded signal because the turn signal may already be aborted.
    if (responseId && !terminal) {
      try {
        await responses.cancel(responseId, {
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        /* Best effort: cancellation cannot replace the original failure. */
      }
    }
  }
}

function protocolError(message: string): ProviderError {
  return new ProviderError("PROVIDER_PROTOCOL_ERROR", message);
}
