import type { ModelProvider, ModelRequest } from "@koda/agent-core";
import {
  assistantMessageItemSchema,
  itemIdSchema,
  planStateItemSchema,
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
  BUILT_IN_PROVIDER_METADATA,
  getBuiltInProviderProfile,
  OpenAICompatibleChatProvider,
  projectCompatibleMessages,
  type OpenAICompatibleChatClient,
  type OpenAICompatibleProfile,
} from "@koda/providers";
import { describe, expect, it } from "vitest";

type CreateMethod = OpenAICompatibleChatClient["chat"]["completions"]["create"];
type CreateBody = Parameters<CreateMethod>[0];
type CompatibleChunk =
  Awaited<ReturnType<CreateMethod>> extends AsyncIterable<infer Chunk>
    ? Chunk
    : never;

const deepSeekProfile: OpenAICompatibleProfile = {
  id: "deepseek",
  displayName: "DeepSeek",
  baseURL: "https://api.deepseek.com",
};

const request: ModelRequest = {
  threadId: threadIdSchema.parse("compatible-thread"),
  turnId: turnIdSchema.parse("compatible-turn"),
  step: 1,
  items: [
    userMessageItemSchema.parse({
      type: "user_message",
      id: itemIdSchema.parse("compatible-user"),
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

class FakeCompatibleClient implements OpenAICompatibleChatClient {
  public body: CreateBody | undefined;
  public signal: AbortSignal | undefined;

  public constructor(
    private readonly chunks: readonly CompatibleChunk[] = [],
    private readonly failure?: unknown,
  ) {}

  public readonly chat = {
    completions: {
      create: async (body: CreateBody, options?: { signal?: AbortSignal }) => {
        this.body = body;
        this.signal = options?.signal;
        if (this.failure !== undefined) {
          throw this.failure;
        }
        return iterable(this.chunks);
      },
    },
  };
}

describe("OpenAICompatibleChatProvider", () => {
  it("projects pinned Plan state as an authoritative system notice", () => {
    const messages = projectCompatibleMessages(
      [...request.items, planState()],
      "deepseek",
    );

    expect(messages.at(-1)).toMatchObject({
      role: "system",
      content: expect.stringContaining(
        "Use expected revision 1 for the next update_plan call.",
      ),
    });
  });

  it("assembles fragmented tool calls and preserves reasoning continuity", async () => {
    const client = new FakeCompatibleClient([
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              reasoning_content: "inspect carefully",
              tool_calls: [
                {
                  index: 0,
                  id: "compatible-call",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '"README.md"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      chunk({
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "tool_calls",
          },
        ],
      }),
      chunk({
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 40 },
          completion_tokens_details: { reasoning_tokens: 12 },
        },
      }),
    ]);
    const provider = new OpenAICompatibleChatProvider({
      client,
      profile: deepSeekProfile,
      model: "deepseek-v4-pro",
      instructions: "Inspect safely.",
      maxOutputTokens: 2_000,
    });
    const controller = new AbortController();

    const events = await collect(provider, request, controller.signal);

    expect(events).toEqual([
      {
        type: "tool_call",
        callId: "compatible-call",
        name: "read_file",
        arguments: { path: "README.md" },
      },
      {
        type: "completed",
        finishReason: "tool_calls",
        providerState: {
          provider: "deepseek",
          data: { reasoning_content: "inspect carefully" },
        },
        usage: {
          inputTokens: 100,
          cachedInputTokens: 40,
          cacheWriteInputTokens: 0,
          outputTokens: 20,
          reasoningOutputTokens: 12,
          totalTokens: 120,
        },
      },
    ]);
    expect(client.signal).toBe(controller.signal);
    expect(client.body).toMatchObject({
      model: "deepseek-v4-pro",
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 2_000,
    });
  });

  it("ignores nullable reasoning continuity chunks", async () => {
    const provider = new OpenAICompatibleChatProvider({
      client: new FakeCompatibleClient([
        chunk({
          choices: [
            {
              index: 0,
              delta: { content: "Hello", reasoning_content: null },
              finish_reason: null,
            },
          ],
        }),
        chunk({
          choices: [
            {
              index: 0,
              delta: { reasoning_content: null },
              finish_reason: "stop",
            },
          ],
        }),
      ]),
      profile: deepSeekProfile,
      model: "deepseek-v4-pro",
      instructions: "Inspect safely.",
    });

    await expect(
      collect(provider, request, new AbortController().signal),
    ).resolves.toEqual([
      { type: "assistant_delta", text: "Hello" },
      { type: "completed", finishReason: "stop" },
    ]);
  });

  it("rejects non-null non-string reasoning continuity chunks", async () => {
    const provider = new OpenAICompatibleChatProvider({
      client: new FakeCompatibleClient([
        chunk({
          choices: [
            {
              index: 0,
              delta: { reasoning_content: { unexpected: true } },
              finish_reason: null,
            },
          ],
        }),
      ]),
      profile: deepSeekProfile,
      model: "deepseek-v4-pro",
      instructions: "Inspect safely.",
    });

    await expect(
      collect(provider, request, new AbortController().signal),
    ).rejects.toMatchObject({ code: "PROVIDER_OUTPUT_INVALID" });
  });

  it("projects one durable multi-tool step into one assistant tool message", () => {
    const firstCallId = toolCallIdSchema.parse("projection-first-call");
    const secondCallId = toolCallIdSchema.parse("projection-second-call");
    const items: ConversationItem[] = [
      assistantMessageItemSchema.parse({
        type: "assistant_message",
        id: itemIdSchema.parse("projection-assistant"),
        content: "I will inspect both files.",
      }),
      providerStateItemSchema.parse({
        type: "provider_state",
        id: itemIdSchema.parse("projection-state"),
        provider: "deepseek",
        data: { reasoning_content: "two reads are required" },
      }),
      toolCallItemSchema.parse({
        type: "tool_call",
        id: itemIdSchema.parse("projection-first-call-item"),
        callId: firstCallId,
        name: "read_file",
        arguments: { path: "README.md" },
      }),
      toolResultItemSchema.parse({
        type: "tool_result",
        id: itemIdSchema.parse("projection-first-result"),
        callId: firstCallId,
        name: "read_file",
        status: "success",
        output: { content: "readme" },
      }),
      toolCallItemSchema.parse({
        type: "tool_call",
        id: itemIdSchema.parse("projection-second-call-item"),
        callId: secondCallId,
        name: "read_file",
        arguments: { path: "package.json" },
      }),
      toolResultItemSchema.parse({
        type: "tool_result",
        id: itemIdSchema.parse("projection-second-result"),
        callId: secondCallId,
        name: "read_file",
        status: "error",
        error: { code: "NOT_FOUND", message: "Missing." },
      }),
    ];

    const messages = projectCompatibleMessages(items, "deepseek");

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: "I will inspect both files.",
      reasoning_content: "two reads are required",
      tool_calls: [
        { id: firstCallId, function: { name: "read_file" } },
        { id: secondCallId, function: { name: "read_file" } },
      ],
    });
    expect(messages.slice(1)).toMatchObject([
      { role: "tool", tool_call_id: firstCallId },
      { role: "tool", tool_call_id: secondCallId },
    ]);
  });

  it("fails closed for foreign provider state", () => {
    expect(() =>
      projectCompatibleMessages(
        [
          providerStateItemSchema.parse({
            type: "provider_state",
            id: itemIdSchema.parse("foreign-state"),
            provider: "kimi",
            data: { reasoning_content: "opaque" },
          }),
          toolCallItemSchema.parse({
            type: "tool_call",
            id: itemIdSchema.parse("foreign-call-item"),
            callId: toolCallIdSchema.parse("foreign-call"),
            name: "read_file",
            arguments: { path: "README.md" },
          }),
          toolResultItemSchema.parse({
            type: "tool_result",
            id: itemIdSchema.parse("foreign-result"),
            callId: toolCallIdSchema.parse("foreign-call"),
            name: "read_file",
            status: "success",
            output: { content: "ok" },
          }),
        ],
        "deepseek",
      ),
    ).toThrow("belongs to 'kimi'");
  });

  it("maps authentication failures to a stable provider error", async () => {
    const provider = new OpenAICompatibleChatProvider({
      client: new FakeCompatibleClient([], { status: 401 }),
      profile: deepSeekProfile,
      model: "deepseek-v4-pro",
      instructions: "Inspect safely.",
    });

    await expect(
      collect(provider, request, new AbortController().signal),
    ).rejects.toMatchObject({ code: "PROVIDER_AUTHENTICATION_FAILED" });
  });

  it("rejects a truncated compatible completion", async () => {
    const provider = new OpenAICompatibleChatProvider({
      client: new FakeCompatibleClient([
        chunk({
          choices: [
            {
              index: 0,
              delta: { content: "partial" },
              finish_reason: "length",
            },
          ],
        }),
      ]),
      profile: deepSeekProfile,
      model: "deepseek-v4-pro",
      instructions: "Inspect safely.",
    });

    await expect(
      collect(provider, request, new AbortController().signal),
    ).rejects.toMatchObject({ code: "PROVIDER_OUTPUT_INVALID" });
  });

  it("publishes the finite built-in provider registry", () => {
    expect(BUILT_IN_PROVIDER_METADATA).toEqual([
      expect.objectContaining({ id: "openai", defaultModel: "gpt-5.6-terra" }),
      expect.objectContaining({
        id: "anthropic",
        defaultModel: "claude-sonnet-5",
      }),
      expect.objectContaining({
        id: "deepseek",
        defaultModel: "deepseek-v4-pro",
      }),
      expect.objectContaining({ id: "kimi", defaultModel: "kimi-k2.6" }),
      expect.objectContaining({ id: "glm", defaultModel: "glm-5.2" }),
    ]);
    expect(getBuiltInProviderProfile("deepseek")).toMatchObject({
      baseURL: "https://api.deepseek.com",
      credentialEnvironmentVariable: "DEEPSEEK_API_KEY",
    });
    expect(getBuiltInProviderProfile("kimi")).toMatchObject({
      baseURL: "https://api.moonshot.cn/v1",
      credentialEnvironmentVariable: "MOONSHOT_API_KEY",
      requestExtensions: { thinking: { type: "enabled" } },
    });
    expect(getBuiltInProviderProfile("glm")).toMatchObject({
      baseURL: "https://open.bigmodel.cn/api/paas/v4/",
      credentialEnvironmentVariable: "ZAI_API_KEY",
      requestExtensions: { thinking: { type: "enabled" } },
    });
  });
});

function planState() {
  return planStateItemSchema.parse({
    type: "plan_state",
    id: itemIdSchema.parse("plan-state:plan:compatible:1"),
    plan: {
      schemaVersion: 1,
      planId: "plan:compatible",
      revision: 1,
      objective: "Inspect the repository",
      status: "active",
      stages: [
        {
          id: "stage-inspect",
          title: "Inspect",
          status: "active",
          requiresAcceptance: false,
          acceptanceCriteria: [],
          evidence: [],
          todos: [
            {
              id: "todo-read",
              title: "Read README",
              status: "in_progress",
            },
          ],
        },
      ],
    },
    needsRevalidation: false,
    checkpointRecommended: true,
  });
}

async function collect(
  provider: ModelProvider,
  modelRequest: ModelRequest,
  signal: AbortSignal,
) {
  const events = [];
  for await (const event of provider.stream(modelRequest, signal)) {
    events.push(event);
  }
  return events;
}

function chunk(value: Record<string, unknown>): CompatibleChunk {
  return {
    id: "compatible-response",
    object: "chat.completion.chunk",
    created: 0,
    model: "compatible-model",
    ...value,
  } as unknown as CompatibleChunk;
}

async function* iterable<T>(values: readonly T[]): AsyncIterable<T> {
  for (const value of values) {
    yield value;
  }
}
