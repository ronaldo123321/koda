import type { ModelProvider, ModelRequest } from "@koda/agent-core";
import {
  assistantMessageItemSchema,
  itemIdSchema,
  providerStateItemSchema,
  threadIdSchema,
  toolCallIdSchema,
  toolCallItemSchema,
  toolResultItemSchema,
  turnIdSchema,
  userMessageItemSchema,
  type ConversationItem,
} from "@koda/protocol";
import {
  AnthropicMessagesProvider,
  projectAnthropicMessages,
  type AnthropicMessagesClient,
} from "@koda/providers";
import { describe, expect, it } from "vitest";

type CreateMethod = AnthropicMessagesClient["messages"]["create"];
type CreateBody = Parameters<CreateMethod>[0];
type AnthropicStreamEvent =
  Awaited<ReturnType<CreateMethod>> extends AsyncIterable<infer Event>
    ? Event
    : never;

const request: ModelRequest = {
  threadId: threadIdSchema.parse("anthropic-thread"),
  turnId: turnIdSchema.parse("anthropic-turn"),
  step: 1,
  items: [
    userMessageItemSchema.parse({
      type: "user_message",
      id: itemIdSchema.parse("anthropic-user"),
      content: "Inspect README.md.",
    }),
  ],
  tools: [
    {
      name: "read_file",
      description: "Read a file.",
      inputJsonSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ],
};

class FakeAnthropicClient implements AnthropicMessagesClient {
  public body: CreateBody | undefined;
  public signal: AbortSignal | undefined;

  public constructor(
    private readonly events: readonly AnthropicStreamEvent[] = [],
    private readonly failure?: unknown,
  ) {}

  public readonly messages = {
    create: async (body: CreateBody, options?: { signal?: AbortSignal }) => {
      this.body = body;
      this.signal = options?.signal;
      if (this.failure !== undefined) {
        throw this.failure;
      }
      return iterable(this.events);
    },
  };
}

describe("AnthropicMessagesProvider", () => {
  it("streams text and tools while preserving signed thinking blocks", async () => {
    const client = new FakeAnthropicClient([
      event({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 80,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 10,
            output_tokens: 0,
            output_tokens_details: null,
          },
        },
      }),
      event({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      }),
      event({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "inspect carefully" },
      }),
      event({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "signed-thinking" },
      }),
      event({ type: "content_block_stop", index: 0 }),
      event({
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      }),
      event({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "I will inspect it." },
      }),
      event({ type: "content_block_stop", index: 1 }),
      event({
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "tool_use",
          id: "anthropic-call",
          name: "read_file",
          input: {},
        },
      }),
      event({
        type: "content_block_delta",
        index: 2,
        delta: {
          type: "input_json_delta",
          partial_json: '{"path":"README.md"}',
        },
      }),
      event({ type: "content_block_stop", index: 2 }),
      event({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: {
          input_tokens: 80,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
          output_tokens: 30,
          output_tokens_details: { thinking_tokens: 18 },
        },
      }),
      event({ type: "message_stop" }),
    ]);
    const provider = new AnthropicMessagesProvider({
      client,
      model: "claude-sonnet-5",
      instructions: "Inspect safely.",
      maxOutputTokens: 4_000,
    });
    const controller = new AbortController();

    const events = await collect(provider, request, controller.signal);

    expect(events).toEqual([
      { type: "assistant_delta", text: "I will inspect it." },
      {
        type: "tool_call",
        callId: "anthropic-call",
        name: "read_file",
        arguments: { path: "README.md" },
      },
      {
        type: "completed",
        finishReason: "tool_calls",
        providerState: {
          provider: "anthropic",
          data: {
            blocks: [
              {
                type: "thinking",
                thinking: "inspect carefully",
                signature: "signed-thinking",
              },
            ],
          },
        },
        usage: {
          inputTokens: 110,
          cachedInputTokens: 20,
          cacheWriteInputTokens: 10,
          outputTokens: 30,
          reasoningOutputTokens: 18,
          totalTokens: 140,
        },
      },
    ]);
    expect(client.signal).toBe(controller.signal);
    expect(client.body).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: 4_000,
      thinking: { type: "adaptive" },
      stream: true,
    });
  });

  it("replays exact thinking blocks before assistant tools and user results", () => {
    const callId = toolCallIdSchema.parse("anthropic-projection-call");
    const items: ConversationItem[] = [
      assistantMessageItemSchema.parse({
        type: "assistant_message",
        id: itemIdSchema.parse("anthropic-projection-assistant"),
        content: "I will read it.",
      }),
      providerStateItemSchema.parse({
        type: "provider_state",
        id: itemIdSchema.parse("anthropic-projection-state"),
        provider: "anthropic",
        data: {
          blocks: [
            {
              type: "thinking",
              thinking: "read first",
              signature: "opaque-signature",
            },
            { type: "redacted_thinking", data: "opaque-redacted-data" },
          ],
        },
      }),
      toolCallItemSchema.parse({
        type: "tool_call",
        id: itemIdSchema.parse("anthropic-projection-call-item"),
        callId,
        name: "read_file",
        arguments: { path: "README.md" },
      }),
      toolResultItemSchema.parse({
        type: "tool_result",
        id: itemIdSchema.parse("anthropic-projection-result"),
        callId,
        name: "read_file",
        status: "success",
        output: { content: "hello" },
      }),
    ];

    const projected = projectAnthropicMessages(items);

    expect(projected.messages).toHaveLength(2);
    expect(projected.messages[0]).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "read first",
          signature: "opaque-signature",
        },
        { type: "redacted_thinking", data: "opaque-redacted-data" },
        { type: "text", text: "I will read it." },
        { type: "tool_use", id: callId, name: "read_file" },
      ],
    });
    expect(projected.messages[1]).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: callId }],
    });
  });

  it("fails closed for malformed or foreign continuation state", () => {
    const callId = toolCallIdSchema.parse("anthropic-foreign-call");
    expect(() =>
      projectAnthropicMessages([
        providerStateItemSchema.parse({
          type: "provider_state",
          id: itemIdSchema.parse("anthropic-foreign-state"),
          provider: "glm",
          data: { reasoning_content: "opaque" },
        }),
        toolCallItemSchema.parse({
          type: "tool_call",
          id: itemIdSchema.parse("anthropic-foreign-call-item"),
          callId,
          name: "read_file",
          arguments: { path: "README.md" },
        }),
        toolResultItemSchema.parse({
          type: "tool_result",
          id: itemIdSchema.parse("anthropic-foreign-result"),
          callId,
          name: "read_file",
          status: "success",
          output: { content: "ok" },
        }),
      ]),
    ).toThrow("belongs to 'glm'");
  });

  it("maps rate limits to a stable provider error", async () => {
    const provider = new AnthropicMessagesProvider({
      client: new FakeAnthropicClient([], { status: 429 }),
      model: "claude-sonnet-5",
      instructions: "Inspect safely.",
      maxOutputTokens: 4_000,
    });

    await expect(
      collect(provider, request, new AbortController().signal),
    ).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
  });
});

async function collect(
  provider: ModelProvider,
  modelRequest: ModelRequest,
  signal: AbortSignal,
) {
  const events = [];
  for await (const modelEvent of provider.stream(modelRequest, signal)) {
    events.push(modelEvent);
  }
  return events;
}

function event(value: Record<string, unknown>): AnthropicStreamEvent {
  return value as unknown as AnthropicStreamEvent;
}

async function* iterable<T>(values: readonly T[]): AsyncIterable<T> {
  for (const value of values) {
    yield value;
  }
}
