import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ModelToolDefinition,
} from "@koda/agent-core";
import {
  jsonObjectSchema,
  tokenUsageSchema,
  toolCallIdSchema,
  type ConversationItem,
  type JsonObject,
  type ToolResultItem,
} from "@koda/protocol";
import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageCreateParamsStreaming,
  MessageParam,
  RawMessageStreamEvent,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";

import { ProviderError, mapProviderRequestError } from "./errors.js";
import { serializePlanStateNotice } from "./plan-state.js";

export interface AnthropicMessagesClient {
  messages: {
    create(
      body: MessageCreateParamsStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<RawMessageStreamEvent>>;
  };
}

export interface AnthropicMessagesProviderOptions {
  client: AnthropicMessagesClient;
  model: string;
  instructions: string;
  maxOutputTokens: number;
}

export interface CreateAnthropicMessagesProviderOptions extends Omit<
  AnthropicMessagesProviderOptions,
  "client"
> {
  apiKey: string;
}

type AnthropicContinuationBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

type PendingBlock =
  | { type: "text" }
  | {
      type: "tool_use";
      id: string;
      name: string;
      initialInput: unknown;
      partialJson: string;
    }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "ignored" };

interface AnthropicUsageAccumulator {
  inputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export class AnthropicMessagesProvider implements ModelProvider {
  public constructor(
    private readonly options: AnthropicMessagesProviderOptions,
  ) {}

  public async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    const projected = projectAnthropicMessages(request.items);
    const pendingBlocks = new Map<number, PendingBlock>();
    const continuationBlocks: AnthropicContinuationBlock[] = [];
    const calls: Array<Extract<ModelEvent, { type: "tool_call" }>> = [];
    const usage: AnthropicUsageAccumulator = {};
    let stopReason: string | null | undefined;
    let messageStopSeen = false;

    try {
      const stream = await this.options.client.messages.create(
        {
          model: this.options.model,
          max_tokens: this.options.maxOutputTokens,
          system: [this.options.instructions, ...projected.systemNotices].join(
            "\n\n",
          ),
          messages: projected.messages,
          tools: request.tools.map(toAnthropicTool),
          thinking: { type: "adaptive" },
          stream: true,
        },
        { signal },
      );

      for await (const event of stream) {
        signal.throwIfAborted();
        if (messageStopSeen) {
          throw new ProviderError(
            "PROVIDER_PROTOCOL_ERROR",
            "Anthropic emitted an event after message_stop.",
          );
        }
        if (event.type === "message_start") {
          assignAnthropicUsage(usage, event.message.usage);
          continue;
        }
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "text") {
            pendingBlocks.set(event.index, { type: "text" });
            if (block.text.length > 0) {
              yield { type: "assistant_delta", text: block.text };
            }
          } else if (block.type === "tool_use") {
            pendingBlocks.set(event.index, {
              type: "tool_use",
              id: block.id,
              name: block.name,
              initialInput: block.input,
              partialJson: "",
            });
          } else if (block.type === "thinking") {
            pendingBlocks.set(event.index, {
              type: "thinking",
              thinking: block.thinking,
              signature: block.signature,
            });
          } else if (block.type === "redacted_thinking") {
            pendingBlocks.set(event.index, {
              type: "redacted_thinking",
              data: block.data,
            });
          } else {
            pendingBlocks.set(event.index, { type: "ignored" });
          }
          continue;
        }
        if (event.type === "content_block_delta") {
          const block = pendingBlocks.get(event.index);
          if (block === undefined) {
            throw new ProviderError(
              "PROVIDER_PROTOCOL_ERROR",
              `Anthropic emitted a delta for unknown content block ${event.index}.`,
            );
          }
          if (event.delta.type === "text_delta") {
            if (block.type !== "text") {
              throw blockDeltaMismatch(event.index);
            }
            if (event.delta.text.length > 0) {
              yield { type: "assistant_delta", text: event.delta.text };
            }
          } else if (event.delta.type === "input_json_delta") {
            if (block.type !== "tool_use") {
              throw blockDeltaMismatch(event.index);
            }
            block.partialJson += event.delta.partial_json;
          } else if (event.delta.type === "thinking_delta") {
            if (block.type !== "thinking") {
              throw blockDeltaMismatch(event.index);
            }
            block.thinking += event.delta.thinking;
          } else if (event.delta.type === "signature_delta") {
            if (block.type !== "thinking") {
              throw blockDeltaMismatch(event.index);
            }
            block.signature += event.delta.signature;
          }
          continue;
        }
        if (event.type === "content_block_stop") {
          const block = pendingBlocks.get(event.index);
          if (block === undefined) {
            throw new ProviderError(
              "PROVIDER_PROTOCOL_ERROR",
              `Anthropic stopped unknown content block ${event.index}.`,
            );
          }
          pendingBlocks.delete(event.index);
          if (block.type === "tool_use") {
            const call = {
              type: "tool_call" as const,
              callId: toolCallIdSchema.parse(block.id),
              name: requireText(block.name, "tool name"),
              arguments: parseAnthropicToolInput(block),
            };
            calls.push(call);
            yield call;
          } else if (block.type === "thinking") {
            continuationBlocks.push({
              type: "thinking",
              thinking: requireText(block.thinking, "thinking content"),
              signature: requireText(block.signature, "thinking signature"),
            });
          } else if (block.type === "redacted_thinking") {
            continuationBlocks.push({
              type: "redacted_thinking",
              data: requireText(block.data, "redacted thinking data"),
            });
          }
          continue;
        }
        if (event.type === "message_delta") {
          if (stopReason !== undefined && event.delta.stop_reason !== null) {
            throw new ProviderError(
              "PROVIDER_PROTOCOL_ERROR",
              "Anthropic emitted more than one stop reason.",
            );
          }
          if (event.delta.stop_reason !== null) {
            stopReason = event.delta.stop_reason;
          }
          assignAnthropicUsage(usage, event.usage);
          continue;
        }
        if (event.type === "message_stop") {
          messageStopSeen = true;
        }
      }

      if (!messageStopSeen || stopReason === undefined || stopReason === null) {
        throw new ProviderError(
          "PROVIDER_PROTOCOL_ERROR",
          "Anthropic ended its stream without a complete stop event.",
        );
      }
      if (pendingBlocks.size > 0) {
        throw new ProviderError(
          "PROVIDER_PROTOCOL_ERROR",
          "Anthropic ended its stream with an incomplete content block.",
        );
      }
      const hasToolCalls = calls.length > 0;
      if (hasToolCalls !== (stopReason === "tool_use")) {
        throw new ProviderError(
          "PROVIDER_PROTOCOL_ERROR",
          `Anthropic stop reason '${stopReason}' does not match its tool calls.`,
        );
      }
      if (
        !hasToolCalls &&
        stopReason !== "end_turn" &&
        stopReason !== "stop_sequence"
      ) {
        throw new ProviderError(
          "PROVIDER_OUTPUT_INVALID",
          `Anthropic stopped with incomplete reason '${stopReason}'.`,
        );
      }
      const normalizedUsage = normalizeAnthropicUsage(usage);
      yield {
        type: "completed",
        finishReason: hasToolCalls ? "tool_calls" : "stop",
        ...(hasToolCalls && continuationBlocks.length > 0
          ? {
              providerState: {
                provider: "anthropic" as const,
                data: { blocks: continuationBlocks },
              },
            }
          : {}),
        ...(normalizedUsage === undefined ? {} : { usage: normalizedUsage }),
      };
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw mapProviderRequestError("Anthropic", error, signal);
    }
  }
}

export function createAnthropicMessagesProvider(
  options: CreateAnthropicMessagesProviderOptions,
): AnthropicMessagesProvider {
  const client = new Anthropic({ apiKey: options.apiKey });
  return new AnthropicMessagesProvider({
    client: client as unknown as AnthropicMessagesClient,
    model: options.model,
    instructions: options.instructions,
    maxOutputTokens: options.maxOutputTokens,
  });
}

export function projectAnthropicMessages(items: readonly ConversationItem[]): {
  messages: MessageParam[];
  systemNotices: string[];
} {
  const messages: MessageParam[] = [];
  const systemNotices: string[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined || item.type === "approval") {
      continue;
    }
    if (item.type === "user_message") {
      messages.push({ role: "user", content: item.content });
      continue;
    }
    if (item.type === "recovery") {
      systemNotices.push(`Koda recovery notice: ${item.message}`);
      continue;
    }
    if (item.type === "compaction") {
      systemNotices.push(
        `Koda compacted thread state: ${JSON.stringify(item.summary)}`,
      );
      continue;
    }
    if (item.type === "plan_state") {
      systemNotices.push(serializePlanStateNotice(item));
      continue;
    }

    const assistantText =
      item.type === "assistant_message" ? item.content : undefined;
    let cursor = assistantText === undefined ? index : index + 1;
    const stateCandidate = items[cursor];
    const state =
      stateCandidate?.type === "provider_state" ? stateCandidate : undefined;
    if (state !== undefined) {
      cursor += 1;
    }
    const toolStep = collectAnthropicToolStep(items, cursor);
    if (toolStep.calls.length > 0) {
      const content: ContentBlockParam[] = [
        ...parseAnthropicState(state),
        ...(assistantText === undefined || assistantText.length === 0
          ? []
          : [{ type: "text" as const, text: assistantText }]),
        ...toolStep.calls.map((call) => ({
          type: "tool_use" as const,
          id: call.callId,
          name: call.name,
          input: call.arguments,
        })),
      ];
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content: toolStep.results.map((result) => ({
          type: "tool_result" as const,
          tool_use_id: result.callId,
          content: serializeToolResult(result),
          is_error: result.status === "error",
        })),
      });
      index = toolStep.nextIndex - 1;
      continue;
    }

    if (state !== undefined) {
      throw new ProviderError(
        "PROVIDER_OUTPUT_INVALID",
        "Stored Anthropic continuation state has no following tool calls.",
      );
    }
    if (assistantText !== undefined) {
      messages.push({ role: "assistant", content: assistantText });
      continue;
    }
    if (item.type === "provider_state") {
      throw new ProviderError(
        "PROVIDER_OUTPUT_INVALID",
        "Stored Anthropic continuation state is not attached to a valid tool step.",
      );
    }
    if (item.type === "tool_call" || item.type === "tool_result") {
      throw new ProviderError(
        "PROVIDER_OUTPUT_INVALID",
        "Stored Anthropic tool history is incomplete.",
      );
    }
  }
  return { messages, systemNotices };
}

function collectAnthropicToolStep(
  items: readonly ConversationItem[],
  start: number,
): {
  calls: Array<Extract<ConversationItem, { type: "tool_call" }>>;
  results: ToolResultItem[];
  nextIndex: number;
} {
  const calls: Array<Extract<ConversationItem, { type: "tool_call" }>> = [];
  const results: ToolResultItem[] = [];
  let cursor = start;
  while (items[cursor]?.type === "tool_call") {
    const call = items[cursor];
    if (call?.type !== "tool_call") {
      break;
    }
    calls.push(call);
    cursor += 1;
    while (items[cursor]?.type === "approval") {
      cursor += 1;
    }
    const result = items[cursor];
    if (result?.type !== "tool_result" || result.callId !== call.callId) {
      throw new ProviderError(
        "PROVIDER_OUTPUT_INVALID",
        `Stored Anthropic tool call '${call.callId}' has no matching result.`,
      );
    }
    results.push(result);
    cursor += 1;
  }
  return { calls, results, nextIndex: cursor };
}

function parseAnthropicState(
  state: Extract<ConversationItem, { type: "provider_state" }> | undefined,
): AnthropicContinuationBlock[] {
  if (state === undefined) {
    return [];
  }
  if (state.provider !== "anthropic") {
    throw new ProviderError(
      "PROVIDER_OUTPUT_INVALID",
      `Stored continuation state belongs to '${state.provider}', not 'anthropic'.`,
    );
  }
  const keys = Object.keys(state.data);
  if (
    keys.length !== 1 ||
    keys[0] !== "blocks" ||
    !Array.isArray(state.data.blocks)
  ) {
    throw invalidAnthropicState();
  }
  return state.data.blocks.map((block) => {
    if (block === null || typeof block !== "object" || Array.isArray(block)) {
      throw invalidAnthropicState();
    }
    if (
      block.type === "thinking" &&
      Object.keys(block).length === 3 &&
      typeof block.thinking === "string" &&
      block.thinking.length > 0 &&
      typeof block.signature === "string" &&
      block.signature.length > 0
    ) {
      return {
        type: "thinking",
        thinking: block.thinking,
        signature: block.signature,
      };
    }
    if (
      block.type === "redacted_thinking" &&
      Object.keys(block).length === 2 &&
      typeof block.data === "string" &&
      block.data.length > 0
    ) {
      return { type: "redacted_thinking", data: block.data };
    }
    throw invalidAnthropicState();
  });
}

function toAnthropicTool(tool: ModelToolDefinition): Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputJsonSchema as Tool.InputSchema,
  };
}

function parseAnthropicToolInput(
  block: Extract<PendingBlock, { type: "tool_use" }>,
): JsonObject {
  const value =
    block.partialJson.length === 0
      ? block.initialInput
      : parseJson(block.partialJson, block.name);
  const result = jsonObjectSchema.safeParse(value);
  if (!result.success) {
    throw new ProviderError(
      "PROVIDER_OUTPUT_INVALID",
      `Anthropic returned non-object arguments for '${block.name}'.`,
      { cause: result.error },
    );
  }
  return result.data;
}

function parseJson(value: string, toolName: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new ProviderError(
      "PROVIDER_OUTPUT_INVALID",
      `Anthropic returned invalid JSON arguments for '${toolName}'.`,
      { cause: error },
    );
  }
}

function assignAnthropicUsage(
  target: AnthropicUsageAccumulator,
  source: {
    input_tokens: number | null;
    cache_read_input_tokens: number | null;
    cache_creation_input_tokens: number | null;
    output_tokens: number;
    output_tokens_details?: { thinking_tokens: number } | null;
  },
): void {
  if (source.input_tokens !== null) {
    target.inputTokens = source.input_tokens;
  }
  if (source.cache_read_input_tokens !== null) {
    target.cacheReadInputTokens = source.cache_read_input_tokens;
  }
  if (source.cache_creation_input_tokens !== null) {
    target.cacheWriteInputTokens = source.cache_creation_input_tokens;
  }
  target.outputTokens = source.output_tokens;
  if (
    source.output_tokens_details !== undefined &&
    source.output_tokens_details !== null
  ) {
    target.reasoningOutputTokens = source.output_tokens_details.thinking_tokens;
  }
}

function normalizeAnthropicUsage(usage: AnthropicUsageAccumulator) {
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
    return undefined;
  }
  const cachedInputTokens = usage.cacheReadInputTokens ?? 0;
  const cacheWriteInputTokens = usage.cacheWriteInputTokens ?? 0;
  const inputTokens =
    usage.inputTokens + cachedInputTokens + cacheWriteInputTokens;
  const outputTokens = usage.outputTokens;
  const normalized = tokenUsageSchema.safeParse({
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens ?? 0,
    totalTokens: inputTokens + outputTokens,
  });
  if (!normalized.success) {
    throw new ProviderError(
      "PROVIDER_OUTPUT_INVALID",
      "Anthropic returned invalid token usage metadata.",
      { cause: normalized.error },
    );
  }
  return normalized.data;
}

function serializeToolResult(item: ToolResultItem): string {
  return JSON.stringify(
    item.status === "success"
      ? { status: "success", output: item.output ?? null }
      : { status: "error", error: item.error },
  );
}

function requireText(value: string, field: string): string {
  if (value.length === 0) {
    throw new ProviderError(
      "PROVIDER_OUTPUT_INVALID",
      `Anthropic returned empty ${field}.`,
    );
  }
  return value;
}

function blockDeltaMismatch(index: number): ProviderError {
  return new ProviderError(
    "PROVIDER_PROTOCOL_ERROR",
    `Anthropic emitted a delta that does not match content block ${index}.`,
  );
}

function invalidAnthropicState(): ProviderError {
  return new ProviderError(
    "PROVIDER_OUTPUT_INVALID",
    "Stored Anthropic reasoning continuity data is invalid.",
  );
}
