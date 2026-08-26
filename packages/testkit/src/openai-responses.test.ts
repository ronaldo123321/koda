import type { ModelRequest } from "@koda/agent-core";
import {
  assistantMessageItemSchema,
  itemIdSchema,
  threadIdSchema,
  toolCallIdSchema,
  toolCallItemSchema,
  toolResultItemSchema,
  turnIdSchema,
  userMessageItemSchema,
} from "@koda/protocol";
import {
  OpenAIResponsesProvider,
  type OpenAIResponsesClient,
} from "@koda/providers";
import { describe, expect, it } from "vitest";

type CreateMethod = OpenAIResponsesClient["responses"]["create"];
type CreateBody = Parameters<CreateMethod>[0];
type CreateOptions = Parameters<CreateMethod>[1];
type StreamEvent =
  Awaited<ReturnType<CreateMethod>> extends AsyncIterable<infer Event>
    ? Event
    : never;

class FakeOpenAIClient implements OpenAIResponsesClient {
  public readonly requests: Array<{
    body: CreateBody;
    options: CreateOptions;
  }> = [];
  private cursor = 0;

  public constructor(private readonly scripts: readonly StreamEvent[][]) {}

  public readonly responses = {
    create: async (body: CreateBody, options?: CreateOptions) => {
      this.requests.push({ body, options });
      const events = this.scripts[this.cursor];
      if (events === undefined) {
        throw new Error("No fake OpenAI stream is configured.");
      }
      this.cursor += 1;
      return toAsyncIterable(events);
    },
  };
}

const threadId = threadIdSchema.parse("openai-thread");
const turnId = turnIdSchema.parse("openai-turn");
const callId = toolCallIdSchema.parse("call-read");
const userItem = userMessageItemSchema.parse({
  type: "user_message",
  id: itemIdSchema.parse("openai-item-1"),
  content: "Read the README.",
});

const toolDefinition = {
  name: "read_file",
  description: "Read a file.",
  inputJsonSchema: {
    type: "object" as const,
    properties: { path: { type: "string" as const } },
    required: ["path"],
    additionalProperties: false,
  },
};

describe("OpenAIResponsesProvider", () => {
  it("maps streaming text, function calls, and follow-up outputs", async () => {
    const client = new FakeOpenAIClient([
      [
        streamEvent({
          type: "response.output_text.delta",
          delta: "Inspecting...",
        }),
        streamEvent({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc-read",
            call_id: callId,
            name: "read_file",
            arguments: '{"path":"README.md"}',
            status: "completed",
          },
        }),
        streamEvent({
          type: "response.completed",
          response: { id: "resp-first" },
        }),
      ],
      [
        streamEvent({
          type: "response.output_text.delta",
          delta: "The README describes Koda.",
        }),
        streamEvent({
          type: "response.completed",
          response: { id: "resp-second" },
        }),
      ],
    ]);
    const provider = new OpenAIResponsesProvider({
      client,
      model: "gpt-5.6-terra",
      instructions: "Inspect the repository.",
      reasoningEffort: "medium",
    });
    const firstRequest: ModelRequest = {
      threadId,
      turnId,
      step: 1,
      items: [userItem],
      tools: [toolDefinition],
    };

    const firstEvents = await collect(provider, firstRequest);

    expect(firstEvents).toEqual([
      { type: "assistant_delta", text: "Inspecting..." },
      {
        type: "tool_call",
        callId,
        name: "read_file",
        arguments: { path: "README.md" },
      },
      {
        type: "completed",
        finishReason: "tool_calls",
        responseId: "resp-first",
      },
    ]);
    expect(client.requests[0]?.body).toMatchObject({
      model: "gpt-5.6-terra",
      instructions: "Inspect the repository.",
      input: [{ role: "user", content: "Read the README." }],
      reasoning: { effort: "medium" },
      store: true,
      stream: true,
    });
    expect(client.requests[0]?.body.tools).toEqual([
      {
        type: "function",
        name: "read_file",
        description: "Read a file.",
        parameters: toolDefinition.inputJsonSchema,
        strict: true,
      },
    ]);

    const secondRequest: ModelRequest = {
      threadId,
      turnId,
      step: 2,
      items: [
        userItem,
        assistantMessageItemSchema.parse({
          type: "assistant_message",
          id: itemIdSchema.parse("openai-item-2"),
          content: "Inspecting...",
        }),
        toolCallItemSchema.parse({
          type: "tool_call",
          id: itemIdSchema.parse("openai-item-3"),
          callId,
          name: "read_file",
          arguments: { path: "README.md" },
        }),
        toolResultItemSchema.parse({
          type: "tool_result",
          id: itemIdSchema.parse("openai-item-4"),
          callId,
          name: "read_file",
          status: "success",
          output: { content: "# Koda" },
        }),
      ],
      tools: [toolDefinition],
    };

    const secondEvents = await collect(provider, secondRequest);

    expect(secondEvents).toEqual([
      { type: "assistant_delta", text: "The README describes Koda." },
      {
        type: "completed",
        finishReason: "stop",
        responseId: "resp-second",
      },
    ]);
    expect(client.requests[1]?.body.previous_response_id).toBe("resp-first");
    expect(client.requests[1]?.body.input).toEqual([
      {
        type: "function_call_output",
        call_id: callId,
        name: "read_file",
        output: JSON.stringify({
          status: "success",
          output: { content: "# Koda" },
        }),
      },
    ]);
    expect(client.requests[1]?.body.instructions).toBe(
      "Inspect the repository.",
    );
  });

  it("rejects malformed function arguments", async () => {
    const client = new FakeOpenAIClient([
      [
        streamEvent({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc-invalid",
            call_id: "call-invalid",
            name: "read_file",
            arguments: "not-json",
            status: "completed",
          },
        }),
      ],
    ]);
    const provider = new OpenAIResponsesProvider({
      client,
      model: "gpt-5.6-terra",
      instructions: "Inspect.",
    });

    await expect(
      collect(provider, {
        threadId,
        turnId,
        step: 1,
        items: [userItem],
        tools: [toolDefinition],
      }),
    ).rejects.toMatchObject({
      code: "OPENAI_INVALID_FUNCTION_ARGUMENTS",
    });
  });

  it("submits each tool result only once across response continuations", async () => {
    const secondCallId = toolCallIdSchema.parse("call-second");
    const client = new FakeOpenAIClient([
      [functionCallEvent(callId, "fc-first"), completedEvent("resp-first")],
      [
        functionCallEvent(secondCallId, "fc-second"),
        completedEvent("resp-second"),
      ],
      [completedEvent("resp-third")],
    ]);
    const provider = new OpenAIResponsesProvider({
      client,
      model: "gpt-5.6-terra",
      instructions: "Inspect.",
    });
    const firstResult = toolResultItemSchema.parse({
      type: "tool_result",
      id: itemIdSchema.parse("result-first"),
      callId,
      name: "read_file",
      status: "success",
      output: { content: "first" },
    });
    const secondResult = toolResultItemSchema.parse({
      type: "tool_result",
      id: itemIdSchema.parse("result-second"),
      callId: secondCallId,
      name: "read_file",
      status: "success",
      output: { content: "second" },
    });

    await collect(provider, {
      threadId,
      turnId,
      step: 1,
      items: [userItem],
      tools: [toolDefinition],
    });
    await collect(provider, {
      threadId,
      turnId,
      step: 2,
      items: [userItem, firstResult],
      tools: [toolDefinition],
    });
    await collect(provider, {
      threadId,
      turnId,
      step: 3,
      items: [userItem, firstResult, secondResult],
      tools: [toolDefinition],
    });

    expect(client.requests[1]?.body.input).toEqual([
      expect.objectContaining({ call_id: callId }),
    ]);
    expect(client.requests[2]?.body.input).toEqual([
      expect.objectContaining({ call_id: secondCallId }),
    ]);
  });

  it("forwards the caller abort signal to the OpenAI SDK", async () => {
    const client = new FakeOpenAIClient([[completedEvent("resp-signal")]]);
    const provider = new OpenAIResponsesProvider({
      client,
      model: "gpt-5.6-terra",
      instructions: "Inspect.",
    });
    const controller = new AbortController();

    await collect(
      provider,
      {
        threadId,
        turnId,
        step: 1,
        items: [userItem],
        tools: [toolDefinition],
      },
      controller.signal,
    );

    expect(client.requests[0]?.options?.signal).toBe(controller.signal);
  });

  it.each([
    {
      event: streamEvent({
        type: "response.failed",
        response: {
          error: { code: "server_error", message: "Provider failed." },
        },
      }),
      code: "server_error",
    },
    {
      event: streamEvent({
        type: "response.incomplete",
        response: {},
      }),
      code: "OPENAI_RESPONSE_INCOMPLETE",
    },
  ])("maps failed provider streams to $code", async ({ event, code }) => {
    const client = new FakeOpenAIClient([[event]]);
    const provider = new OpenAIResponsesProvider({
      client,
      model: "gpt-5.6-terra",
      instructions: "Inspect.",
    });

    await expect(
      collect(provider, {
        threadId,
        turnId,
        step: 1,
        items: [userItem],
        tools: [toolDefinition],
      }),
    ).rejects.toMatchObject({ code });
  });
});

async function collect(
  provider: OpenAIResponsesProvider,
  request: ModelRequest,
  signal = new AbortController().signal,
) {
  const events = [];
  for await (const event of provider.stream(request, signal)) {
    events.push(event);
  }
  return events;
}

function functionCallEvent(
  functionCallId: typeof callId,
  itemId: string,
): StreamEvent {
  return streamEvent({
    type: "response.output_item.done",
    item: {
      type: "function_call",
      id: itemId,
      call_id: functionCallId,
      name: "read_file",
      arguments: '{"path":"README.md"}',
      status: "completed",
    },
  });
}

function completedEvent(responseId: string): StreamEvent {
  return streamEvent({
    type: "response.completed",
    response: { id: responseId },
  });
}

function streamEvent(value: unknown): StreamEvent {
  return value as StreamEvent;
}

async function* toAsyncIterable(
  events: readonly StreamEvent[],
): AsyncIterable<StreamEvent> {
  for (const event of events) {
    yield event;
  }
}
