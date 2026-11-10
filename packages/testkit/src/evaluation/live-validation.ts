import { failureEvidence } from "./failure.js";
import { randomUUID } from "node:crypto";
import { AgentLoop, ToolRegistry, type ModelProvider } from "@koda/agent-core";
import {
  threadIdSchema,
  turnIdSchema,
  itemIdSchema,
  type ModelProviderId,
  type TokenUsage,
} from "@koda/protocol";
import { createRegisteredProvider } from "@koda/providers";
import { z } from "zod";
import { DeterministicItemIdFactory } from "../deterministic.js";
import { MemoryEventStore } from "../memory-event-store.js";
import { withTransportProbe, type Fault } from "./transport-probe.js";

export interface LiveOptions {
  provider: "openai" | "anthropic";
  model: string;
  apiKey: string;
  timeoutMs: number;
}
export function liveProvider(
  options: LiveOptions,
  instructions: string,
  resumableStreams = false,
): ModelProvider {
  return createRegisteredProvider({
    provider: options.provider as ModelProviderId,
    model: options.model,
    apiKey: options.apiKey,
    instructions,
    maxOutputTokens: 2048,
    resumableStreams,
  });
}
export async function runSmoke(options: LiveOptions) {
  const started = performance.now();
  const nonce = randomUUID();
  let reads = 0;
  const tools = new ToolRegistry();
  tools.register({
    spec: {
      name: "read_probe",
      description: "Read the evaluation fixture marker.",
      inputJsonSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    inputSchema: z.object({}),
    effect: "read",
    concurrency: "parallel",
    execute: async () => {
      reads += 1;
      return nonce;
    },
  });
  const events = new MemoryEventStore();
  const result = await new AgentLoop({
    provider: liveProvider(
      options,
      "You are validating the Koda tool loop. Call read_probe exactly once, then return only the marker returned by the tool. Never guess the marker.",
    ),
    tools,
    events,
    ids: new DeterministicItemIdFactory(),
    maxSteps: 3,
  }).runTurn({
    threadId: threadIdSchema.parse(`eval-${nonce}`),
    turnId: turnIdSchema.parse(`eval-${nonce}`),
    userInput: "Read the fixture marker and report it.",
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const text = result.items
    .filter((item) => item.type === "assistant_message")
    .map((item) => item.content)
    .join("\n");
  return {
    id: "tool-roundtrip",
    status: result.status,
    passed:
      result.status === "completed" && reads === 1 && text.includes(nonce),
    reads,
    latencyMs: Math.round(performance.now() - started),
    usage: result.usage,
    monetaryCost: null,
  };
}

export async function runStreamProbe(
  options: LiveOptions,
  mode: "cancel" | "cancel-created" | "cancel-progress" | "retry" | "resume",
) {
  if (
    (mode === "resume" ||
      mode === "cancel-created" ||
      mode === "cancel-progress") &&
    options.provider !== "openai"
  )
    return { id: mode, status: "unsupported", passed: null };
  const fault: Fault | undefined =
    mode === "retry"
      ? "rate_limit_once"
      : mode === "resume"
        ? "disconnect_once"
        : undefined;
  const started = performance.now();
  const controller = new AbortController();
  let creationTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelledAfterCreation = false;
  let createdStatus: string | null = null;
  let responseCreatedMs: number | null = null;
  return withTransportProbe(
    fault,
    async (transport) => {
      const timer = setTimeout(
        () => controller.abort(new Error("Evaluation deadline exceeded")),
        options.timeoutMs,
      );
      let firstDeltaMs: number | null = null;
      let cancelledAfterDelta = false;
      let completed = false;
      let text = "";
      let usage: TokenUsage | undefined;
      let failure = false;
      let errorEvidence: ReturnType<typeof failureEvidence> | null = null;
      try {
        const id = `probe-${randomUUID()}`;
        const provider = liveProvider(
          options,
          "Follow the user's formatting instruction exactly. Do not use tools.",
          options.provider === "openai" && mode !== "retry",
        );
        for await (const event of provider.stream(
          {
            threadId: threadIdSchema.parse(id),
            turnId: turnIdSchema.parse(id),
            step: 1,
            items: [
              {
                type: "user_message",
                id: itemIdSchema.parse(id),
                content:
                  mode === "cancel" ||
                  mode === "cancel-created" ||
                  mode === "cancel-progress"
                    ? "Explain binary search in about 120 words, starting immediately with the word Search."
                    : "Return exactly this text and nothing else: KODA_PROBE_OK",
              },
            ],
            tools: [],
          },
          controller.signal,
        )) {
          if (event.type === "assistant_delta") {
            firstDeltaMs ??= Math.round(performance.now() - started);
            text += event.text;
            if (text.length > 65_536)
              throw new Error("Evaluation output limit exceeded");
            if (mode === "cancel") {
              cancelledAfterDelta = true;
              controller.abort(new Error("Controlled evaluation cancellation"));
            }
          } else if (event.type === "completed") {
            completed = true;
            usage = event.usage;
          } else throw new Error("Unexpected tool call");
        }
      } catch (error) {
        failure = true;
        errorEvidence = failureEvidence(error);
      } finally {
        clearTimeout(timer);
        clearTimeout(creationTimer);
      }
      let remoteStatus: string | null = null;
      if (
        (mode === "cancel" ||
          mode === "cancel-created" ||
          mode === "cancel-progress") &&
        (cancelledAfterDelta || cancelledAfterCreation) &&
        !transport.cancelAcknowledged &&
        transport.responseId &&
        options.provider === "openai"
      ) {
        try {
          const response = await fetch(
            `https://api.openai.com/v1/responses/${transport.responseId}`,
            {
              headers: { Authorization: `Bearer ${options.apiKey}` },
              signal: AbortSignal.timeout(5000),
            },
          );
          if (response.ok) {
            const body = (await response.json()) as { status?: unknown };
            if (
              typeof body.status === "string" &&
              [
                "queued",
                "in_progress",
                "completed",
                "failed",
                "cancelled",
                "incomplete",
              ].includes(body.status)
            )
              remoteStatus = body.status;
          }
        } catch {
          /* Unknown remote state remains unknown, never success. */
        }
      }
      const passed =
        mode === "cancel-created" || mode === "cancel-progress"
          ? cancelledAfterCreation &&
            createdStatus !== null &&
            (mode !== "cancel-progress" || createdStatus === "in_progress") &&
            firstDeltaMs === null &&
            failure &&
            !completed &&
            transport.cancelledResponseConfirmed
          : mode === "cancel"
            ? cancelledAfterDelta &&
              failure &&
              !completed &&
              (options.provider !== "openai" ||
                transport.cancelledResponseConfirmed)
            : !failure &&
              completed &&
              text.trim() === "KODA_PROBE_OK" &&
              transport.injected &&
              (mode !== "resume" ||
                (transport.creates === 1 && transport.retrieves > 0));
      return {
        id: mode,
        status: passed ? "passed" : "failed",
        passed,
        latencyMs: Math.round(performance.now() - started),
        firstDeltaMs,
        completed,
        cancelledAfterDelta,
        cancelledAfterCreation,
        cancellationTrigger:
          mode === "cancel-progress"
            ? "response.in_progress"
            : mode === "cancel-created"
              ? "response.created"
              : null,
        createdStatus,
        responseCreatedMs,
        error: errorEvidence,
        remoteStatus,
        transport,
        usage: usage ?? null,
        monetaryCost: null,
        faultInjection: fault ?? null,
      };
    },
    mode === "cancel-created" || mode === "cancel-progress"
      ? (status) => {
          createdStatus = status;
          responseCreatedMs = Math.round(performance.now() - started);
          // Give the SDK/provider the current event before aborting on the next task.
          creationTimer = setTimeout(() => {
            cancelledAfterCreation = true;
            controller.abort(
              new Error(
                "Controlled cancellation after response lifecycle event",
              ),
            );
          }, 0);
        }
      : undefined,
    mode === "cancel-progress" ? "response.in_progress" : "response.created",
  );
}
