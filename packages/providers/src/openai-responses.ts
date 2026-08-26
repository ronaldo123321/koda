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
  type ToolResultItem,
} from "@koda/protocol";
import OpenAI from "openai";

import {
  ProviderError,
  mapProviderRequestError,
  type ProviderErrorCode,
} from "./errors.js";

export type OpenAIReasoningEffort =
  "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface OpenAIResponsesClient {
  responses: {
    create(
      body: OpenAI.Responses.ResponseCreateParamsStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>>;
  };
}

export interface OpenAIResponsesProviderOptions {
  client: OpenAIResponsesClient;
  model: string;
  instructions: string;
  reasoningEffort?: OpenAIReasoningEffort;
  maxOutputTokens?: number;
}

export interface CreateOpenAIResponsesProviderOptions extends Omit<
  OpenAIResponsesProviderOptions,
  "client"
> {
  apiKey: string;
}

interface TurnSession {
  previousResponseId?: string;
  submittedItemIds: Set<string>;
  lastCompletedStep: number;
  inFlight: boolean;
  failed: boolean;
}

export class OpenAIProviderError extends ProviderError {
  public constructor(
    code: ProviderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, options);
    this.name = "OpenAIProviderError";
  }
}

export class OpenAIResponsesProvider implements ModelProvider {
  private readonly sessions = new Map<string, TurnSession>();
  private readonly reasoningEffort: OpenAIReasoningEffort;

  public constructor(private readonly options: OpenAIResponsesProviderOptions) {
    this.reasoningEffort = options.reasoningEffort ?? "medium";
  }

  public async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    const sessionKey = `${request.threadId}:${request.turnId}`;
    const session = this.getSession(sessionKey, request.step);
    this.assertSessionCanStart(session, request.step);
    const resetsResponseChain =
      request.step > 1 &&
      request.items.some(
        (item) =>
          item.type === "compaction" && !session.submittedItemIds.has(item.id),
      );
    const input = resetsResponseChain
      ? this.buildReplayInput(request.items)
      : this.buildInput(request.items, session, request.step);
    const previousResponseId = resetsResponseChain
      ? undefined
      : session.previousResponseId;
    if (resetsResponseChain) {
      session.submittedItemIds.clear();
    }
    session.inFlight = true;

    let completed = false;
    let functionCallCount = 0;
    try {
      const stream = await this.options.client.responses.create(
        {
          model: this.options.model,
          instructions: this.options.instructions,
          input,
          tools: request.tools.map(toOpenAIFunctionTool),
          parallel_tool_calls: true,
          reasoning: { effort: this.reasoningEffort },
          store: true,
          stream: true,
          ...(this.options.maxOutputTokens === undefined
            ? {}
            : { max_output_tokens: this.options.maxOutputTokens }),
          ...(previousResponseId === undefined
            ? {}
            : { previous_response_id: previousResponseId }),
        },
        { signal },
      );

      for await (const event of stream) {
        signal.throwIfAborted();

        if (event.type === "response.output_text.delta") {
          if (event.delta.length > 0) {
            yield { type: "assistant_delta", text: event.delta };
          }
          continue;
        }

        if (
          event.type === "response.output_item.done" &&
          event.item.type === "function_call"
        ) {
          const parsedArguments = parseFunctionArguments(
            event.item.arguments,
            event.item.name,
          );
          functionCallCount += 1;
          yield {
            type: "tool_call",
            callId: toolCallIdSchema.parse(event.item.call_id),
            name: event.item.name,
            arguments: parsedArguments,
          };
          continue;
        }

        if (event.type === "error") {
          throw new OpenAIProviderError(
            "PROVIDER_REQUEST_FAILED",
            "The OpenAI response stream reported an error.",
          );
        }

        if (event.type === "response.failed") {
          throw new OpenAIProviderError(
            "PROVIDER_REQUEST_FAILED",
            "The OpenAI response failed.",
          );
        }

        if (event.type === "response.incomplete") {
          throw new OpenAIProviderError(
            "PROVIDER_OUTPUT_INVALID",
            "The OpenAI response ended before it completed.",
          );
        }

        if (event.type === "response.completed") {
          if (completed) {
            throw new OpenAIProviderError(
              "PROVIDER_PROTOCOL_ERROR",
              "OpenAI emitted more than one response.completed event.",
            );
          }
          completed = true;
          session.previousResponseId = event.response.id;
          session.lastCompletedStep = request.step;
          for (const item of request.items) {
            session.submittedItemIds.add(item.id);
          }
          const usage = normalizeOpenAIUsage(event.response.usage);
          yield {
            type: "completed",
            finishReason: functionCallCount > 0 ? "tool_calls" : "stop",
            responseId: event.response.id,
            ...(usage === undefined ? {} : { usage }),
          };
        }
      }

      if (!completed) {
        throw new OpenAIProviderError(
          "PROVIDER_PROTOCOL_ERROR",
          "The OpenAI stream ended without response.completed.",
        );
      }

      if (functionCallCount === 0) {
        this.sessions.delete(sessionKey);
      }
    } catch (error) {
      session.failed = true;
      if (error instanceof OpenAIProviderError) {
        throw error;
      }
      throw mapProviderRequestError("OpenAI", error, signal);
    } finally {
      session.inFlight = false;
    }
  }

  private getSession(sessionKey: string, step: number): TurnSession {
    const existing = this.sessions.get(sessionKey);
    if (existing !== undefined) {
      return existing;
    }
    if (step !== 1) {
      throw new OpenAIProviderError(
        "PROVIDER_PROTOCOL_ERROR",
        `Model step ${step} has no previous OpenAI response session.`,
      );
    }
    const created: TurnSession = {
      submittedItemIds: new Set(),
      lastCompletedStep: 0,
      inFlight: false,
      failed: false,
    };
    this.sessions.set(sessionKey, created);
    return created;
  }

  private assertSessionCanStart(session: TurnSession, step: number): void {
    if (session.failed) {
      throw new OpenAIProviderError(
        "PROVIDER_PROTOCOL_ERROR",
        "This OpenAI turn session previously failed and cannot be continued.",
      );
    }
    if (session.inFlight) {
      throw new OpenAIProviderError(
        "PROVIDER_PROTOCOL_ERROR",
        "A model request is already running for this turn.",
      );
    }
    if (step !== session.lastCompletedStep + 1) {
      throw new OpenAIProviderError(
        "PROVIDER_PROTOCOL_ERROR",
        `Expected model step ${session.lastCompletedStep + 1}, received ${step}.`,
      );
    }
    if (step > 1 && session.previousResponseId === undefined) {
      throw new OpenAIProviderError(
        "PROVIDER_PROTOCOL_ERROR",
        "A follow-up model step requires a previous OpenAI response ID.",
      );
    }
  }

  private buildInput(
    items: readonly ConversationItem[],
    session: TurnSession,
    step: number,
  ): OpenAI.Responses.ResponseInput {
    if (step === 1) {
      return this.buildReplayInput(items);
    }

    const newItems = items.filter(
      (item) => !session.submittedItemIds.has(item.id),
    );
    const input: OpenAI.Responses.ResponseInput = [];
    for (const item of newItems) {
      if (item.type === "tool_result") {
        input.push(toFunctionCallOutput(item));
      } else if (item.type === "user_message") {
        input.push({ role: "user", content: item.content });
      }
    }
    if (input.length === 0) {
      throw new OpenAIProviderError(
        "PROVIDER_PROTOCOL_ERROR",
        "A follow-up OpenAI request has no new tool results or user input.",
      );
    }
    return input;
  }

  private buildReplayInput(
    items: readonly ConversationItem[],
  ): OpenAI.Responses.ResponseInput {
    const replay = toOpenAIReplayInput(items);
    if (!items.some((item) => item.type === "user_message")) {
      throw new OpenAIProviderError(
        "PROVIDER_OUTPUT_INVALID",
        "An OpenAI response chain requires a user message.",
      );
    }
    return replay;
  }
}

function toOpenAIReplayInput(
  items: readonly ConversationItem[],
): OpenAI.Responses.ResponseInput {
  const input: OpenAI.Responses.ResponseInput = [];
  for (const item of items) {
    if (item.type === "user_message" || item.type === "assistant_message") {
      input.push({
        role: item.type === "user_message" ? "user" : "assistant",
        content: item.content,
      });
    } else if (item.type === "tool_call") {
      input.push({
        type: "function_call",
        call_id: item.callId,
        name: item.name,
        arguments: JSON.stringify(item.arguments),
      });
    } else if (item.type === "tool_result") {
      input.push(toFunctionCallOutput(item));
    } else if (item.type === "recovery") {
      input.push({
        role: "developer",
        content: `Koda recovery notice: ${item.message}`,
      });
    } else if (item.type === "compaction") {
      input.push({
        role: "developer",
        content: `Koda compacted thread state: ${JSON.stringify(item.summary)}`,
      });
    }
  }
  return input;
}

export function createOpenAIResponsesProvider(
  options: CreateOpenAIResponsesProviderOptions,
): OpenAIResponsesProvider {
  const client = new OpenAI({ apiKey: options.apiKey });
  return new OpenAIResponsesProvider({
    client,
    model: options.model,
    instructions: options.instructions,
    ...(options.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: options.reasoningEffort }),
    ...(options.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: options.maxOutputTokens }),
  });
}

function toOpenAIFunctionTool(
  tool: ModelToolDefinition,
): OpenAI.Responses.FunctionTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputJsonSchema,
    strict: true,
  };
}

function toFunctionCallOutput(
  item: ToolResultItem,
): OpenAI.Responses.ResponseInputItem.FunctionCallOutput {
  return {
    type: "function_call_output",
    call_id: item.callId,
    name: item.name,
    output: JSON.stringify(
      item.status === "success"
        ? { status: "success", output: item.output ?? null }
        : { status: "error", error: item.error },
    ),
  };
}

function parseFunctionArguments(argumentsText: string, toolName: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText);
  } catch (error) {
    throw new OpenAIProviderError(
      "PROVIDER_OUTPUT_INVALID",
      `OpenAI returned invalid JSON arguments for '${toolName}'.`,
      { cause: error },
    );
  }
  const result = jsonObjectSchema.safeParse(parsed);
  if (!result.success) {
    throw new OpenAIProviderError(
      "PROVIDER_OUTPUT_INVALID",
      `OpenAI returned non-object arguments for '${toolName}'.`,
    );
  }
  return result.data;
}

function normalizeOpenAIUsage(
  usage: OpenAI.Responses.ResponseUsage | undefined,
) {
  if (usage === undefined) {
    return undefined;
  }
  const normalized = tokenUsageSchema.safeParse({
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteInputTokens: usage.input_tokens_details?.cache_write_tokens ?? 0,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
    totalTokens: usage.total_tokens,
  });
  if (!normalized.success) {
    throw new OpenAIProviderError(
      "PROVIDER_OUTPUT_INVALID",
      "OpenAI returned invalid token usage metadata.",
      { cause: normalized.error },
    );
  }
  return normalized.data;
}
