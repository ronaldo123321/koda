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
  type ModelProviderId,
  type ProviderStateItem,
  type TokenUsage,
  type ToolResultItem,
} from "@koda/protocol";
import OpenAI from "openai";

import { ProviderError, mapProviderRequestError } from "./errors.js";
import { serializePlanStateNotice } from "./plan-state.js";

export interface OpenAICompatibleProfile {
  id: Extract<ModelProviderId, "deepseek" | "kimi" | "glm">;
  displayName: string;
  baseURL: string;
  requestExtensions?: JsonObject;
}

export interface OpenAICompatibleChatClient {
  chat: {
    completions: {
      create(
        body: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
        options?: { signal?: AbortSignal },
      ): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>>;
    };
  };
}

export interface OpenAICompatibleChatProviderOptions {
  client: OpenAICompatibleChatClient;
  profile: OpenAICompatibleProfile;
  model: string;
  instructions: string;
  maxOutputTokens?: number;
}

export interface CreateOpenAICompatibleChatProviderOptions extends Omit<
  OpenAICompatibleChatProviderOptions,
  "client"
> {
  apiKey: string;
}

interface PendingToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

interface CompatibleAssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  reasoning_content?: string;
}

export class OpenAICompatibleChatProvider implements ModelProvider {
  public constructor(
    private readonly options: OpenAICompatibleChatProviderOptions,
  ) {}

  public async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    const pendingCalls = new Map<number, PendingToolCall>();
    let reasoningContent = "";
    let finishReason: string | null | undefined;
    let usage: TokenUsage | undefined;

    try {
      const messages = projectCompatibleMessages(
        request.items,
        this.options.profile.id,
      );
      const body = {
        model: this.options.model,
        messages: [
          { role: "system" as const, content: this.options.instructions },
          ...messages,
        ],
        tools: request.tools.map(toChatTool),
        stream: true as const,
        stream_options: { include_usage: true },
        ...(this.options.maxOutputTokens === undefined
          ? {}
          : { max_tokens: this.options.maxOutputTokens }),
        ...(this.options.profile.requestExtensions ?? {}),
      } as OpenAI.Chat.ChatCompletionCreateParamsStreaming;
      const stream = await this.options.client.chat.completions.create(body, {
        signal,
      });

      for await (const chunk of stream) {
        signal.throwIfAborted();
        if (
          "error" in chunk &&
          chunk.error !== undefined &&
          chunk.error !== null
        ) {
          throw new ProviderError(
            "PROVIDER_REQUEST_FAILED",
            `${this.options.profile.displayName} reported a streaming request error.`,
          );
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          usage = normalizeCompatibleUsage(chunk.usage);
        }
        for (const choice of chunk.choices) {
          if (choice.index !== 0) {
            throw new ProviderError(
              "PROVIDER_PROTOCOL_ERROR",
              `${this.options.profile.displayName} returned an unexpected additional completion choice.`,
            );
          }
          const delta =
            choice.delta as OpenAI.Chat.ChatCompletionChunk.Choice.Delta & {
              reasoning_content?: unknown;
            };
          if (typeof delta.content === "string" && delta.content.length > 0) {
            yield { type: "assistant_delta", text: delta.content };
          }
          if (
            delta.reasoning_content !== undefined &&
            delta.reasoning_content !== null
          ) {
            if (typeof delta.reasoning_content !== "string") {
              throw new ProviderError(
                "PROVIDER_OUTPUT_INVALID",
                `${this.options.profile.displayName} returned invalid reasoning continuity data.`,
              );
            }
            reasoningContent += delta.reasoning_content;
          }
          for (const fragment of delta.tool_calls ?? []) {
            const index = fragment.index;
            const current = pendingCalls.get(index) ?? {
              id: "",
              name: "",
              argumentsText: "",
            };
            if (fragment.id !== undefined) {
              current.id += fragment.id;
            }
            if (fragment.function?.name !== undefined) {
              current.name += fragment.function.name;
            }
            if (fragment.function?.arguments !== undefined) {
              current.argumentsText += fragment.function.arguments;
            }
            pendingCalls.set(index, current);
          }
          if (choice.finish_reason !== null) {
            if (finishReason !== undefined) {
              throw new ProviderError(
                "PROVIDER_PROTOCOL_ERROR",
                `${this.options.profile.displayName} returned more than one finish reason.`,
              );
            }
            finishReason = choice.finish_reason;
          }
        }
      }

      if (finishReason === undefined || finishReason === null) {
        throw new ProviderError(
          "PROVIDER_PROTOCOL_ERROR",
          `${this.options.profile.displayName} ended its stream without a finish reason.`,
        );
      }
      const calls = [...pendingCalls.entries()].sort(
        ([left], [right]) => left - right,
      );
      for (const [, call] of calls) {
        yield {
          type: "tool_call",
          callId: toolCallIdSchema.parse(call.id),
          name: nonEmpty(call.name, "tool name", this.options.profile),
          arguments: parseToolArguments(call, this.options.profile),
        };
      }
      const hasToolCalls = calls.length > 0;
      if (hasToolCalls !== (finishReason === "tool_calls")) {
        throw new ProviderError(
          "PROVIDER_PROTOCOL_ERROR",
          `${this.options.profile.displayName} finish reason '${finishReason}' does not match its tool calls.`,
        );
      }
      if (!hasToolCalls && finishReason !== "stop") {
        throw new ProviderError(
          "PROVIDER_OUTPUT_INVALID",
          `${this.options.profile.displayName} stopped with incomplete reason '${finishReason}'.`,
        );
      }
      yield {
        type: "completed",
        finishReason: hasToolCalls ? "tool_calls" : "stop",
        ...(hasToolCalls && reasoningContent.length > 0
          ? {
              providerState: {
                provider: this.options.profile.id,
                data: { reasoning_content: reasoningContent },
              },
            }
          : {}),
        ...(usage === undefined ? {} : { usage }),
      };
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw mapProviderRequestError(
        this.options.profile.displayName,
        error,
        signal,
      );
    }
  }
}

export function createOpenAICompatibleChatProvider(
  options: CreateOpenAICompatibleChatProviderOptions,
): OpenAICompatibleChatProvider {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.profile.baseURL,
  });
  return new OpenAICompatibleChatProvider({
    client,
    profile: options.profile,
    model: options.model,
    instructions: options.instructions,
    ...(options.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: options.maxOutputTokens }),
  });
}

export function projectCompatibleMessages(
  items: readonly ConversationItem[],
  provider: Extract<ModelProviderId, "deepseek" | "kimi" | "glm">,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
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
      messages.push({
        role: "system",
        content: `Koda recovery notice: ${item.message}`,
      });
      continue;
    }
    if (item.type === "compaction") {
      messages.push({
        role: "system",
        content: `Koda compacted thread state: ${JSON.stringify(item.summary)}`,
      });
      continue;
    }
    if (item.type === "plan_state") {
      messages.push({
        role: "system",
        content: serializePlanStateNotice(item),
      });
      continue;
    }

    const assistantText =
      item.type === "assistant_message" ? item.content : undefined;
    let cursor = assistantText === undefined ? index : index + 1;
    const state =
      items[cursor]?.type === "provider_state"
        ? (items[cursor] as ProviderStateItem)
        : undefined;
    if (state !== undefined) {
      cursor += 1;
    }
    const toolStep = collectDurableToolStep(items, cursor);
    if (toolStep.calls.length > 0) {
      const reasoningContent = parseCompatibleState(state, provider);
      const assistantMessage: CompatibleAssistantMessage = {
        role: "assistant",
        content: assistantText ?? null,
        tool_calls: toolStep.calls.map((call) => ({
          id: call.callId,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        })),
        ...(reasoningContent === undefined
          ? {}
          : { reasoning_content: reasoningContent }),
      };
      messages.push(assistantMessage as OpenAI.Chat.ChatCompletionMessageParam);
      for (const result of toolStep.results) {
        messages.push({
          role: "tool",
          tool_call_id: result.callId,
          content: serializeToolResult(result),
        });
      }
      index = toolStep.nextIndex - 1;
      continue;
    }

    if (state !== undefined) {
      throw new ProviderError(
        "PROVIDER_OUTPUT_INVALID",
        `Stored ${provider} continuation state has no following tool calls.`,
      );
    }
    if (assistantText !== undefined) {
      messages.push({ role: "assistant", content: assistantText });
      continue;
    }
    if (item.type === "provider_state") {
      throw new ProviderError(
        "PROVIDER_OUTPUT_INVALID",
        `Stored ${provider} continuation state is not attached to a valid tool step.`,
      );
    }
    if (item.type === "tool_call" || item.type === "tool_result") {
      throw new ProviderError(
        "PROVIDER_OUTPUT_INVALID",
        `Stored ${provider} tool history is incomplete.`,
      );
    }
  }
  return messages;
}

function collectDurableToolStep(
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
        `Stored tool call '${call.callId}' has no matching result.`,
      );
    }
    results.push(result);
    cursor += 1;
  }
  return { calls, results, nextIndex: cursor };
}

function parseCompatibleState(
  state: ProviderStateItem | undefined,
  provider: Extract<ModelProviderId, "deepseek" | "kimi" | "glm">,
): string | undefined {
  if (state === undefined) {
    return undefined;
  }
  if (state.provider !== provider) {
    throw new ProviderError(
      "PROVIDER_OUTPUT_INVALID",
      `Stored continuation state belongs to '${state.provider}', not '${provider}'.`,
    );
  }
  const keys = Object.keys(state.data);
  if (
    keys.length !== 1 ||
    keys[0] !== "reasoning_content" ||
    typeof state.data.reasoning_content !== "string" ||
    state.data.reasoning_content.length === 0
  ) {
    throw new ProviderError(
      "PROVIDER_OUTPUT_INVALID",
      `Stored ${provider} reasoning continuity data is invalid.`,
    );
  }
  return state.data.reasoning_content;
}

function toChatTool(tool: ModelToolDefinition): OpenAI.Chat.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputJsonSchema,
    },
  };
}

function parseToolArguments(
  call: PendingToolCall,
  profile: OpenAICompatibleProfile,
): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.argumentsText);
  } catch (error) {
    throw new ProviderError(
      "PROVIDER_OUTPUT_INVALID",
      `${profile.displayName} returned invalid JSON arguments for '${call.name || "unknown tool"}'.`,
      { cause: error },
    );
  }
  const result = jsonObjectSchema.safeParse(parsed);
  if (!result.success) {
    throw new ProviderError(
      "PROVIDER_OUTPUT_INVALID",
      `${profile.displayName} returned non-object arguments for '${call.name || "unknown tool"}'.`,
      { cause: result.error },
    );
  }
  return result.data;
}

function normalizeCompatibleUsage(usage: OpenAI.Completions.CompletionUsage) {
  const cachedInputTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoningOutputTokens =
    usage.completion_tokens_details?.reasoning_tokens ?? 0;
  const normalized = tokenUsageSchema.safeParse({
    inputTokens: usage.prompt_tokens,
    cachedInputTokens,
    cacheWriteInputTokens: 0,
    outputTokens: usage.completion_tokens,
    reasoningOutputTokens,
    totalTokens: usage.total_tokens,
  });
  if (!normalized.success) {
    throw new ProviderError(
      "PROVIDER_OUTPUT_INVALID",
      "The provider returned invalid token usage metadata.",
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

function nonEmpty(
  value: string,
  field: string,
  profile: OpenAICompatibleProfile,
): string {
  if (value.length === 0) {
    throw new ProviderError(
      "PROVIDER_OUTPUT_INVALID",
      `${profile.displayName} returned an empty ${field}.`,
    );
  }
  return value;
}
