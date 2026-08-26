import {
  approvalItemSchema,
  assistantMessageItemSchema,
  collectArtifactReferences,
  conversationItemSchema,
  itemIdSchema,
  toolCallItemSchema,
  toolResultItemSchema,
  userMessageItemSchema,
  type AssistantMessageItem,
  type ConversationItem,
  type ItemId,
  type TokenUsage,
  type ThreadId,
  type TurnContextSnapshot,
  type TurnUsage,
  type TurnId,
} from "@koda/protocol";

import {
  TurnEventRecorder,
  systemClock,
  type Clock,
  type EventSink,
} from "./events.js";
import { ContextBudgetError, type ContextEngine } from "./context-engine.js";
import type { ModelEvent, ModelProvider } from "./model.js";
import {
  denySideEffectsPolicy,
  rejectApprovalsBroker,
  type ApprovalBroker,
  type ToolPolicy,
} from "./policy.js";
import {
  ToolRegistry,
  ToolOperationalEventError,
  type PreparedToolInvocation,
  type ToolExecutionResult,
} from "./tools.js";

export interface ItemIdFactory {
  next(): ItemId;
}

export interface AgentLoopOptions {
  provider: ModelProvider;
  tools: ToolRegistry;
  events: EventSink;
  ids: ItemIdFactory;
  policy?: ToolPolicy;
  approvals?: ApprovalBroker;
  clock?: Clock;
  maxSteps?: number;
  maxModelOutputBytes?: number;
  contextEngine?: ContextEngine;
}

export interface RunTurnInput {
  threadId: ThreadId;
  turnId: TurnId;
  userInput: string;
  signal?: AbortSignal;
  history?: readonly ConversationItem[];
  prefaceItems?: readonly ConversationItem[];
  context?: TurnContextSnapshot;
  initialSequence?: number;
}

export type RunTurnResult =
  | {
      status: "completed";
      steps: number;
      items: readonly ConversationItem[];
      finalMessage?: AssistantMessageItem;
      usage: TurnUsage;
    }
  | {
      status: "cancelled";
      steps: number;
      items: readonly ConversationItem[];
      reason: string;
      usage: TurnUsage;
    }
  | {
      status: "failed";
      steps: number;
      items: readonly ConversationItem[];
      error: { code: string; message: string };
      usage: TurnUsage;
    };

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_MODEL_OUTPUT_BYTES = 262_144;

export class AgentLoop {
  private readonly provider: ModelProvider;
  private readonly tools: ToolRegistry;
  private readonly events: EventSink;
  private readonly ids: ItemIdFactory;
  private readonly policy: ToolPolicy;
  private readonly approvals: ApprovalBroker;
  private readonly clock: Clock;
  private readonly maxSteps: number;
  private readonly maxModelOutputBytes: number;
  private readonly contextEngine: ContextEngine | undefined;

  public constructor(options: AgentLoopOptions) {
    this.provider = options.provider;
    this.tools = options.tools;
    this.events = options.events;
    this.ids = options.ids;
    this.policy = options.policy ?? denySideEffectsPolicy;
    this.approvals = options.approvals ?? rejectApprovalsBroker;
    this.clock = options.clock ?? systemClock;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.maxModelOutputBytes =
      options.maxModelOutputBytes ?? DEFAULT_MAX_MODEL_OUTPUT_BYTES;
    this.contextEngine = options.contextEngine;

    if (!Number.isInteger(this.maxSteps) || this.maxSteps < 1) {
      throw new Error("maxSteps must be a positive integer.");
    }
    if (
      !Number.isInteger(this.maxModelOutputBytes) ||
      this.maxModelOutputBytes < 1
    ) {
      throw new Error("maxModelOutputBytes must be a positive integer.");
    }
  }

  public async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    const signal = input.signal ?? new AbortController().signal;
    const initialSequence = input.initialSequence ?? 0;
    if (!Number.isInteger(initialSequence) || initialSequence < 0) {
      throw new Error("initialSequence must be a non-negative integer.");
    }
    const recorder = new TurnEventRecorder(
      this.events,
      this.clock,
      input.threadId,
      input.turnId,
      initialSequence,
    );
    const items: ConversationItem[] = (input.history ?? []).map((item) =>
      conversationItemSchema.parse(item),
    );
    const usage = emptyTurnUsage();
    let completedSteps = 0;

    await recorder.record({ type: "turn.started", payload: {} });

    if (input.context !== undefined) {
      await recorder.record({
        type: "turn.context",
        payload: input.context,
      });
    }

    for (const item of input.prefaceItems ?? []) {
      const parsedItem = conversationItemSchema.parse(item);
      items.push(parsedItem);
      await recorder.record({
        type: "item.recorded",
        payload: { item: parsedItem },
      });
    }

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
      return this.cancel(recorder, items, completedSteps, signal.reason, usage);
    }

    for (let step = 1; step <= this.maxSteps; step += 1) {
      const toolDefinitions = this.tools.definitions();
      let modelItems: readonly ConversationItem[] = items;
      let rawEstimatedInputTokens: number | undefined;
      if (this.contextEngine !== undefined) {
        try {
          const prepared = this.contextEngine.prepare(items, toolDefinitions);
          modelItems = prepared.items;
          rawEstimatedInputTokens = prepared.rawEstimatedInputTokens;
          if (prepared.compaction !== undefined) {
            items.push(prepared.compaction);
            await recorder.record({
              type: "item.recorded",
              payload: { item: prepared.compaction },
            });
          }
        } catch (error) {
          return this.fail(
            recorder,
            items,
            completedSteps,
            error instanceof ContextBudgetError
              ? error.code
              : "CONTEXT_PREPARATION_ERROR",
            error instanceof Error ? error.message : String(error),
            usage,
          );
        }
      }
      completedSteps = step;
      usage.modelRequests += 1;
      let assistantText = "";
      const toolCalls: Extract<ModelEvent, { type: "tool_call" }>[] = [];
      let completedEventSeen = false;
      let finishReason:
        Extract<ModelEvent, { type: "completed" }>["finishReason"] | undefined;
      let responseId: string | undefined;
      let stepUsage: TokenUsage | undefined;
      let modelOutputBytes = 0;

      try {
        for await (const event of this.provider.stream(
          {
            threadId: input.threadId,
            turnId: input.turnId,
            step,
            items: [...modelItems],
            tools: toolDefinitions,
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
              usage,
            );
          }
          if (event.type === "assistant_delta") {
            modelOutputBytes += utf8Bytes(event.text);
            if (modelOutputBytes > this.maxModelOutputBytes) {
              return this.fail(
                recorder,
                items,
                completedSteps,
                "MODEL_OUTPUT_LIMIT_EXCEEDED",
                `The provider output exceeded the ${this.maxModelOutputBytes}-byte limit for one model step.`,
                usage,
              );
            }
            assistantText += event.text;
            if (event.text.length > 0) {
              await recorder.record({
                type: "assistant.delta",
                payload: { text: event.text },
              });
            }
          } else if (event.type === "tool_call") {
            modelOutputBytes += utf8Bytes(JSON.stringify(event.arguments));
            if (modelOutputBytes > this.maxModelOutputBytes) {
              return this.fail(
                recorder,
                items,
                completedSteps,
                "MODEL_OUTPUT_LIMIT_EXCEEDED",
                `The provider output exceeded the ${this.maxModelOutputBytes}-byte limit for one model step.`,
                usage,
              );
            }
            toolCalls.push(event);
          } else if (event.type === "completed") {
            completedEventSeen = true;
            finishReason = event.finishReason;
            responseId = event.responseId;
            stepUsage = event.usage;
          }
        }
      } catch (error) {
        if (signal.aborted) {
          return this.cancel(
            recorder,
            items,
            completedSteps,
            signal.reason,
            usage,
          );
        }
        return this.fail(
          recorder,
          items,
          completedSteps,
          "MODEL_ERROR",
          error instanceof Error ? error.message : String(error),
          usage,
        );
      }

      if (!completedEventSeen) {
        return this.fail(
          recorder,
          items,
          completedSteps,
          "MODEL_PROTOCOL_ERROR",
          "The provider stream ended without a completed event.",
          usage,
        );
      }

      if (stepUsage !== undefined) {
        addTokenUsage(usage, stepUsage);
        if (
          this.contextEngine !== undefined &&
          rawEstimatedInputTokens !== undefined
        ) {
          this.contextEngine.observe(
            rawEstimatedInputTokens,
            stepUsage.inputTokens,
          );
        }
        await recorder.record({
          type: "model.usage",
          payload: {
            step,
            usage: stepUsage,
            ...(responseId === undefined ? {} : { responseId }),
          },
        });
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
          usage,
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
          return this.cancel(
            recorder,
            items,
            completedSteps,
            signal.reason,
            usage,
          );
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
          payload: {
            callId: call.callId,
            name: call.name,
            executionBoundary: true,
          },
        });

        let result: ToolExecutionResult;
        let operationalEventQueue = Promise.resolve();
        try {
          const preparation = await this.tools.prepare(call, {
            threadId: input.threadId,
            turnId: input.turnId,
            signal,
            report: async (event) => {
              const recording = operationalEventQueue.then(async () => {
                try {
                  if (event.type === "process.started") {
                    await recorder.record({
                      type: event.type,
                      payload: {
                        callId: call.callId,
                        name: call.name,
                        ...event.payload,
                      },
                    });
                  } else if (event.type === "process.exited") {
                    await recorder.record({
                      type: event.type,
                      payload: {
                        callId: call.callId,
                        name: call.name,
                        ...event.payload,
                      },
                    });
                  } else if (event.type === "process.termination_requested") {
                    await recorder.record({
                      type: event.type,
                      payload: {
                        callId: call.callId,
                        name: call.name,
                        ...event.payload,
                      },
                    });
                  } else {
                    await recorder.record({
                      type: event.type,
                      payload: {
                        callId: call.callId,
                        name: call.name,
                        ...event.payload,
                      },
                    });
                  }
                } catch (error) {
                  throw new ToolOperationalEventError(
                    `Could not persist ${event.type} for '${call.name}'.`,
                    { cause: error },
                  );
                }
              });
              operationalEventQueue = recording.catch(() => {});
              await recording;
            },
          });
          result =
            preparation.status === "error"
              ? preparation.result
              : await this.authorizeAndExecute(
                  recorder,
                  items,
                  call,
                  preparation.invocation,
                  signal,
                );
        } catch (error) {
          if (signal.aborted) {
            return this.cancel(
              recorder,
              items,
              completedSteps,
              signal.reason,
              usage,
            );
          }
          if (error instanceof ToolOperationalEventError) {
            return this.fail(
              recorder,
              items,
              completedSteps,
              "EVENT_PERSISTENCE_FAILED",
              error.message,
              usage,
            );
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
        if (
          resultItem.type === "tool_result" &&
          resultItem.output !== undefined
        ) {
          for (const artifact of collectArtifactReferences(resultItem.output)) {
            await recorder.record({
              type: "artifact.recorded",
              payload: {
                callId: call.callId,
                name: call.name,
                artifact,
              },
            });
          }
        }
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
          payload: { ...payload, usage: copyTurnUsage(usage) },
        });
        return finalMessage
          ? {
              status: "completed",
              steps: completedSteps,
              items,
              finalMessage,
              usage: copyTurnUsage(usage),
            }
          : {
              status: "completed",
              steps: completedSteps,
              items,
              usage: copyTurnUsage(usage),
            };
      }
    }

    return this.fail(
      recorder,
      items,
      completedSteps,
      "MAX_STEPS_EXCEEDED",
      `The turn exceeded the configured limit of ${this.maxSteps} model steps.`,
      usage,
    );
  }

  private async authorizeAndExecute(
    recorder: TurnEventRecorder,
    items: ConversationItem[],
    call: Extract<ModelEvent, { type: "tool_call" }>,
    prepared: PreparedToolInvocation,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    let policyDecision;
    try {
      policyDecision = await this.policy.evaluate({
        callId: call.callId,
        name: call.name,
        effect: prepared.effect,
        arguments: call.arguments,
      });
    } catch (error) {
      return {
        status: "error",
        error: {
          code: "POLICY_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    if (policyDecision.decision === "deny") {
      return {
        status: "error",
        error: { code: "POLICY_DENIED", message: policyDecision.reason },
      };
    }
    if (policyDecision.decision === "allow") {
      return this.executePrepared(recorder, call, prepared);
    }
    if (prepared.approval === undefined) {
      return {
        status: "error",
        error: {
          code: "APPROVAL_CONTEXT_MISSING",
          message: `Tool '${call.name}' requires approval but did not provide a preview.`,
        },
      };
    }

    const request = {
      callId: call.callId,
      name: call.name,
      reason: policyDecision.reason,
      ...prepared.approval,
    };
    await recorder.record({
      type: "approval.requested",
      payload: request,
    });
    signal.throwIfAborted();

    let decision;
    try {
      decision = await this.approvals.request(request, signal);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      decision = {
        decision: "rejected" as const,
        reason:
          error instanceof Error
            ? `Approval failed: ${error.message}`
            : `Approval failed: ${String(error)}`,
      };
    }

    const approvalItem = approvalItemSchema.parse({
      type: "approval",
      id: this.ids.next(),
      callId: call.callId,
      decision: decision.decision,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    });
    items.push(approvalItem);
    await recorder.record({
      type: "item.recorded",
      payload: { item: approvalItem },
    });
    await recorder.record({
      type: "approval.resolved",
      payload: {
        callId: call.callId,
        decision: decision.decision,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      },
    });

    return decision.decision === "approved"
      ? this.executePrepared(recorder, call, prepared)
      : {
          status: "error",
          error: {
            code: "APPROVAL_REJECTED",
            message: decision.reason ?? "The user rejected this tool call.",
          },
        };
  }

  private async executePrepared(
    recorder: TurnEventRecorder,
    call: Extract<ModelEvent, { type: "tool_call" }>,
    prepared: PreparedToolInvocation,
  ): Promise<ToolExecutionResult> {
    try {
      await recorder.record({
        type: "tool.execution_started",
        payload: {
          callId: call.callId,
          name: call.name,
          effect: prepared.effect,
        },
      });
    } catch (error) {
      throw new ToolOperationalEventError(
        `Could not persist tool.execution_started for '${call.name}'.`,
        { cause: error },
      );
    }
    return prepared.execute();
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
    usage: TurnUsage,
  ): Promise<RunTurnResult> {
    const message =
      typeof reason === "string" && reason.length > 0
        ? reason
        : "The turn was cancelled.";
    await recorder.record({
      type: "turn.cancelled",
      payload: { reason: message, usage: copyTurnUsage(usage) },
    });
    return {
      status: "cancelled",
      steps,
      items,
      reason: message,
      usage: copyTurnUsage(usage),
    };
  }

  private async fail(
    recorder: TurnEventRecorder,
    items: ConversationItem[],
    steps: number,
    code: string,
    message: string,
    usage: TurnUsage,
  ): Promise<RunTurnResult> {
    await recorder.record({
      type: "turn.failed",
      payload: { code, message, usage: copyTurnUsage(usage) },
    });
    return {
      status: "failed",
      steps,
      items,
      error: { code, message },
      usage: copyTurnUsage(usage),
    };
  }
}

function emptyTurnUsage(): TurnUsage {
  return {
    modelRequests: 0,
    reportedRequests: 0,
    tokens: {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    },
  };
}

function addTokenUsage(summary: TurnUsage, usage: TokenUsage): void {
  summary.reportedRequests += 1;
  summary.tokens.inputTokens += usage.inputTokens;
  summary.tokens.cachedInputTokens += usage.cachedInputTokens;
  summary.tokens.cacheWriteInputTokens += usage.cacheWriteInputTokens;
  summary.tokens.outputTokens += usage.outputTokens;
  summary.tokens.reasoningOutputTokens += usage.reasoningOutputTokens;
  summary.tokens.totalTokens += usage.totalTokens;
}

function copyTurnUsage(usage: TurnUsage): TurnUsage {
  return {
    modelRequests: usage.modelRequests,
    reportedRequests: usage.reportedRequests,
    tokens: { ...usage.tokens },
  };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
