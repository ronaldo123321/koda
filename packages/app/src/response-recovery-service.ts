import { createHash } from "node:crypto";
import {
  TurnEventRecorder,
  type ModelEvent,
  type ModelProvider,
} from "@koda/agent-core";
import {
  assistantMessageItemSchema,
  toolCallItemSchema,
  toolResultItemSchema,
  type ThreadId,
} from "@koda/protocol";
import { ResponseJournal } from "@koda/providers";
import {
  JsonlEventStore,
  recoverThread,
  ThreadRecoveryError,
} from "@koda/runtime-node";

const invalid = (message: string) =>
  new ThreadRecoveryError("THREAD_LOG_INVALID", message);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Runs under the thread lease before a new turn starts. Never executes tools. */
export async function reconcileResponseJournal(
  journal: ResponseJournal,
  store: JsonlEventStore,
  provider: ModelProvider,
  threadId: ThreadId,
  signal: AbortSignal,
): Promise<boolean> {
  const snapshot = await journal.load();
  if (!snapshot) return false;
  if (snapshot.header.threadId !== threadId)
    throw invalid("Response journal belongs to another thread.");
  let read = await store.readAll();
  const recovered = recoverThread(read, threadId);
  const previous = read.events.filter(
    (event) => event.turnId === snapshot.header.turnId,
  );
  if (previous.length === 0)
    throw invalid("Response journal has no originating turn.");
  // A recorded terminal owns the outcome; a stale journal cannot reopen it.
  if (
    previous.some((event) =>
      [
        "turn.completed",
        "turn.failed",
        "turn.cancelled",
        "turn.paused",
      ].includes(event.type),
    )
  ) {
    await store.sync();
    await journal.clear();
    return false;
  }
  if (snapshot.header.turnId !== recovered.previousTurnId)
    throw invalid("Response journal is not for the interrupted turn.");
  const prepared = [...previous]
    .reverse()
    .find((event) => event.type === "context.prepared");
  if (
    prepared?.type !== "context.prepared" ||
    prepared.payload.step !== snapshot.header.step
  )
    throw invalid("Response journal does not match the prepared model step.");
  if (!provider.recoverPendingStream)
    throw invalid(
      "The configured provider cannot recover this pending response.",
    );
  const tail = previous.filter((event) => event.sequence > prepared.sequence);
  const delivered = tail
    .flatMap((event) =>
      event.type === "assistant.delta" ? [event.payload.text] : [],
    )
    .join("");
  let text = "";
  let bytes = 0;
  const calls: Extract<ModelEvent, { type: "tool_call" }>[] = [];
  let completed: Extract<ModelEvent, { type: "completed" }> | undefined;
  for await (const event of provider.recoverPendingStream(signal)) {
    signal.throwIfAborted();
    if (completed)
      throw invalid("Recovered response continued after completion.");
    if (event.type === "assistant_delta") {
      text += event.text;
      bytes += Buffer.byteLength(event.text);
    }
    if (event.type === "tool_call") {
      calls.push(event);
      bytes += Buffer.byteLength(JSON.stringify(event.arguments));
    }
    if (event.type === "completed") completed = event;
    if (bytes > 262_144)
      throw invalid("Recovered response exceeds the model output limit.");
  }
  if (
    !completed ||
    !completed.responseId ||
    (completed.finishReason === "tool_calls") !== calls.length > 0
  )
    throw invalid("Recovered response has no valid completion.");
  if (!text.startsWith(delivered))
    throw invalid(
      "Durable assistant output conflicts with the recovered response.",
    );
  const callIds = new Set(calls.map((call) => call.callId));
  if (callIds.size !== calls.length)
    throw invalid("Recovered response repeats a tool call ID.");
  const recorded = tail.flatMap((event) =>
    event.type === "item.recorded" ? [event.payload.item] : [],
  );
  const messages = recorded.filter((item) => item.type === "assistant_message");
  if (messages.length > 1 || (messages[0] && messages[0].content !== text))
    throw invalid(
      "Recorded assistant message conflicts with the recovered response.",
    );
  for (const item of recorded) {
    if (item.type === "tool_call") {
      const call = calls.find((candidate) => candidate.callId === item.callId);
      if (
        !call ||
        call.name !== item.name ||
        !same(call.arguments, item.arguments)
      )
        throw invalid(
          "Recorded tool call conflicts with the recovered response.",
        );
    }
  }
  for (const call of calls) {
    const existing = read.events.find(
      (event) =>
        event.type === "item.recorded" &&
        event.payload.item.type === "tool_call" &&
        event.payload.item.callId === call.callId,
    );
    if (existing && !tail.includes(existing))
      throw invalid("Recovered call ID collides with an earlier model step.");
  }
  const existingUsage = tail.filter(
    (event) =>
      event.type === "model.usage" &&
      event.payload.purpose !== "context_summary",
  );
  if (
    existingUsage.length > 1 ||
    existingUsage.some(
      (event) =>
        event.type === "model.usage" &&
        (event.payload.step !== snapshot.header.step ||
          event.payload.responseId !== completed!.responseId ||
          !same(event.payload.usage, completed!.usage)),
    )
  )
    throw invalid("Recovered usage conflicts with the model step audit.");
  await store.prepareForAppend({
    discardPartialTrailingLine: recovered.partialTrailingEventDiscarded,
  });
  const recorder = new TurnEventRecorder(
    store,
    { now: () => new Date().toISOString() },
    threadId,
    snapshot.header.turnId,
    recovered.nextSequence,
  );
  const itemId = (kind: string) =>
    `response-recovery-${createHash("sha256").update(`${completed!.responseId}:${kind}`).digest("hex")}`;
  if (text.length > delivered.length)
    await recorder.record({
      type: "assistant.delta",
      payload: { text: text.slice(delivered.length) },
    });
  if (text && messages.length === 0)
    await recorder.record({
      type: "item.recorded",
      payload: {
        item: assistantMessageItemSchema.parse({
          type: "assistant_message",
          id: itemId("message"),
          content: text,
        }),
      },
    });
  if (completed.usage && existingUsage.length === 0)
    await recorder.record({
      type: "model.usage",
      payload: {
        step: snapshot.header.step,
        responseId: completed.responseId,
        usage: completed.usage,
      },
    });
  for (const call of calls) {
    const existing = recorded.find(
      (item) => item.type === "tool_call" && item.callId === call.callId,
    );
    if (!existing)
      await recorder.record({
        type: "item.recorded",
        payload: {
          item: toolCallItemSchema.parse({
            ...call,
            id: itemId(`call:${call.callId}`),
            catalogGenerationId: prepared.payload.toolCatalogGenerationId,
          }),
        },
      });
    if (
      recorded.some(
        (item) => item.type === "tool_result" && item.callId === call.callId,
      )
    )
      continue;
    const started = tail.some(
      (event) =>
        event.type === "tool.started" && event.payload.callId === call.callId,
    );
    await recorder.record({
      type: "item.recorded",
      payload: {
        item: toolResultItemSchema.parse({
          type: "tool_result",
          id: itemId(`result:${call.callId}`),
          callId: call.callId,
          name: call.name,
          status: "error",
          error: started
            ? {
                code: "TOOL_OUTCOME_UNKNOWN",
                message:
                  "The process stopped after this tool started. Its outcome is unknown; inspect durable evidence before considering a retry. Recovery did not execute it.",
              }
            : {
                code: "TOOL_NOT_EXECUTED",
                message:
                  "This call was recovered from the model response but was not executed. Reassess it under current instructions and approval policy.",
              },
        }),
      },
    });
  }
  await recorder.record({
    type: "turn.failed",
    payload: {
      code: "TURN_STREAM_RECOVERED",
      message:
        "The interrupted model response was recovered without repeating inference or tools. Continue in a new turn using the reconciled history.",
    },
  });
  read = await store.readAll();
  recoverThread(read, threadId);
  await store.sync();
  await journal.clear(); // Ensure the durable history remains independently replayable.
  return true;
}
