import {
  assistantMessageItemSchema,
  itemIdSchema,
  toolCallItemSchema,
  toolResultItemSchema,
  userMessageItemSchema,
  type AssistantMessageItem,
  type ConversationItem,
  type ItemId,
  type ThreadId,
  type TurnId,
} from "@koda/protocol";

import {
  TurnEventRecorder,
  systemClock,
  type Clock,
  type EventSink,
} from "./events.js";
import type { ModelEvent, ModelProvider } from "./model.js";
import { ToolRegistry, type ToolExecutionResult } from "./tools.js";

export interface ItemIdFactory {
  next(): ItemId;
}

export interface AgentLoopOptions {
  provider: ModelProvider;
  tools: ToolRegistry;
  events: EventSink;
  ids: ItemIdFactory;
  clock?: Clock;
  maxSteps?: number;
}

export interface RunTurnInput {
  threadId: ThreadId;
  turnId: TurnId;
  userInput: string;
  signal?: AbortSignal;
}

export type RunTurnResult =
  | {
      status: "completed";
      steps: number;
      items: readonly ConversationItem[];
      finalMessage?: AssistantMessageItem;
    }
  | {
      status: "cancelled";
      steps: number;
      items: readonly ConversationItem[];
      reason: string;
    }
  | {
      status: "failed";
      steps: number;
      items: readonly ConversationItem[];
      error: { code: string; message: string };
    };

const DEFAULT_MAX_STEPS = 8;

export class AgentLoop {
  private readonly provider: ModelProvider;
  private readonly tools: ToolRegistry;
  private readonly events: EventSink;
  private readonly ids: ItemIdFactory;
  private readonly clock: Clock;
  private readonly maxSteps: number;

  public constructor(options: AgentLoopOptions) {
    this.provider = options.provider;
    this.tools = options.tools;
    this.events = options.events;
    this.ids = options.ids;
    this.clock = options.clock ?? systemClock;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;

    if (!Number.isInteger(this.maxSteps) || this.maxSteps < 1) {
      throw new Error("maxSteps must be a positive integer.");
    }
  }

  public async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    const signal = input.signal ?? new AbortController().signal;
    const recorder = new TurnEventRecorder(
      this.events,
      this.clock,
      input.threadId,
      input.turnId,
    );
    const items: ConversationItem[] = [];
    let completedSteps = 0;

    await recorder.record({ type: "turn.started", payload: {} });

    const userItem = userMessageItemSchema.parse({
      type: "user_message",
      id: this.ids.next(),
      content: input.userInput,
    });
    items.push(userItem);
    await recorder.record({
      type: "item.recorded",
      payload: { item: userItem },
    });

    if (signal.aborted) {
      return this.cancel(recorder, items, completedSteps, signal.reason);
    }

    for (let step = 1; step <= this.maxSteps; step += 1) {
      completedSteps = step;
      let assistantText = "";
      const toolCalls: Extract<ModelEvent, { type: "tool_call" }>[] = [];
      let completedEventSeen = false;
      let finishReason:
        Extract<ModelEvent, { type: "completed" }>["finishReason"] | undefined;

      try {
        for await (const event of this.provider.stream(
          {
            threadId: input.threadId,
            turnId: input.turnId,
            step,
            items: [...items],
            tools: this.tools.definitions(),
          },
          signal,
        )) {
          signal.throwIfAborted();
          if (completedEventSeen) {
            return this.fail(
              recorder,
              items,
              completedSteps,
              "MODEL_PROTOCOL_ERROR",
              "The provider emitted an event after the completed event.",
            );
          }
          if (event.type === "assistant_delta") {
            assistantText += event.text;
            if (event.text.length > 0) {
              await recorder.record({
                type: "assistant.delta",
                payload: { text: event.text },
              });
            }
          } else if (event.type === "tool_call") {
            toolCalls.push(event);
          } else if (event.type === "completed") {
            completedEventSeen = true;
            finishReason = event.finishReason;
          }
        }
      } catch (error) {
        if (signal.aborted) {
          return this.cancel(recorder, items, completedSteps, signal.reason);
        }
        return this.fail(
          recorder,
          items,
          completedSteps,
          "MODEL_ERROR",
          error instanceof Error ? error.message : String(error),
        );
      }

      if (!completedEventSeen) {
        return this.fail(
          recorder,
          items,
          completedSteps,
          "MODEL_PROTOCOL_ERROR",
          "The provider stream ended without a completed event.",
        );
      }

      if (
        (finishReason === "tool_calls" && toolCalls.length === 0) ||
        (finishReason === "stop" && toolCalls.length > 0)
      ) {
        return this.fail(
          recorder,
          items,
          completedSteps,
          "MODEL_PROTOCOL_ERROR",
          `The provider finish reason '${finishReason}' does not match the emitted tool calls.`,
        );
      }

      let finalMessage: AssistantMessageItem | undefined;
      if (assistantText.length > 0) {
        finalMessage = assistantMessageItemSchema.parse({
          type: "assistant_message",
          id: this.ids.next(),
          content: assistantText,
        });
        items.push(finalMessage);
        await recorder.record({
          type: "item.recorded",
          payload: { item: finalMessage },
        });
      }

      for (const call of toolCalls) {
        if (signal.aborted) {
          return this.cancel(recorder, items, completedSteps, signal.reason);
        }

        const callItem = toolCallItemSchema.parse({
          type: "tool_call",
          id: this.ids.next(),
          callId: call.callId,
          name: call.name,
          arguments: call.arguments,
        });
        items.push(callItem);
        await recorder.record({
          type: "item.recorded",
          payload: { item: callItem },
        });
        await recorder.record({
          type: "tool.started",
          payload: { callId: call.callId, name: call.name },
        });

        let result: ToolExecutionResult;
        try {
          result = await this.tools.execute(call, {
            threadId: input.threadId,
            turnId: input.turnId,
            signal,
          });
        } catch (error) {
          if (signal.aborted) {
            return this.cancel(recorder, items, completedSteps, signal.reason);
          }
          result = {
            status: "error",
            error: {
              code: "TOOL_RUNTIME_ERROR",
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }

        const resultItem = this.createToolResult(call, result);
        items.push(resultItem);
        await recorder.record({
          type: "item.recorded",
          payload: { item: resultItem },
        });
        await recorder.record({
          type: "tool.completed",
          payload: {
            callId: call.callId,
            name: call.name,
            status: result.status,
          },
        });
      }

      if (toolCalls.length === 0) {
        const payload = finalMessage
          ? { finalMessageId: finalMessage.id, steps: completedSteps }
          : { steps: completedSteps };
        await recorder.record({
          type: "turn.completed",
          payload,
        });
        return finalMessage
          ? {
              status: "completed",
              steps: completedSteps,
              items,
              finalMessage,
            }
          : { status: "completed", steps: completedSteps, items };
      }
    }

    return this.fail(
      recorder,
      items,
      completedSteps,
      "MAX_STEPS_EXCEEDED",
      `The turn exceeded the configured limit of ${this.maxSteps} model steps.`,
    );
  }

  private createToolResult(
    call: Extract<ModelEvent, { type: "tool_call" }>,
    result: ToolExecutionResult,
  ): ConversationItem {
    const common = {
      type: "tool_result" as const,
      id: itemIdSchema.parse(this.ids.next()),
      callId: call.callId,
      name: call.name,
      status: result.status,
    };
    return result.status === "success"
      ? toolResultItemSchema.parse({ ...common, output: result.output })
      : toolResultItemSchema.parse({ ...common, error: result.error });
  }

  private async cancel(
    recorder: TurnEventRecorder,
    items: ConversationItem[],
    steps: number,
    reason: unknown,
  ): Promise<RunTurnResult> {
    const message =
      typeof reason === "string" && reason.length > 0
        ? reason
        : "The turn was cancelled.";
    await recorder.record({
      type: "turn.cancelled",
      payload: { reason: message },
    });
    return { status: "cancelled", steps, items, reason: message };
  }

  private async fail(
    recorder: TurnEventRecorder,
    items: ConversationItem[],
    steps: number,
    code: string,
    message: string,
  ): Promise<RunTurnResult> {
    await recorder.record({
      type: "turn.failed",
      payload: { code, message },
    });
    return { status: "failed", steps, items, error: { code, message } };
  }
}
