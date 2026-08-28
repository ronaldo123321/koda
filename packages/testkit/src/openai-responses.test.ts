import type { ModelRequest } from "@koda/agent-core";
import {
  approvalItemSchema,
  assistantMessageItemSchema,
  compactionItemSchema,
  itemIdSchema,
  planStateItemSchema,
  recoveryItemSchema,
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
      maxOutputTokens: 16_384,
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
      max_output_tokens: 16_384,
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
        planState(),
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
      {
        role: "developer",
        content: expect.stringContaining(
          "Use expected revision 1 for the next update_plan call.",
        ),
      },
    ]);
    expect(client.requests[1]?.body.instructions).toBe(
      "Inspect the repository.",
    );
  });

  it("resends pinned Plan state on every incremental follow-up", async () => {
    const client = new FakeOpenAIClient([
      [
        functionCallEvent(callId, "fc-plan-followup"),
        completedEvent("resp-plan"),
      ],
      [completedEvent("resp-plan-done")],
    ]);
    const provider = new OpenAIResponsesProvider({
      client,
      model: "gpt-5.6-terra",
      instructions: "Inspect the repository.",
    });
    const pinnedPlan = planState();

    await collect(provider, {
      threadId,
      turnId,
      step: 1,
      items: [userItem, pinnedPlan],
      tools: [toolDefinition],
    });
    await collect(provider, {
      threadId,
      turnId,
      step: 2,
      items: [
        userItem,
        toolCallItemSchema.parse({
          type: "tool_call",
          id: itemIdSchema.parse("openai-plan-call-item"),
          callId,
          name: "read_file",
          arguments: { path: "README.md" },
        }),
        toolResultItemSchema.parse({
          type: "tool_result",
          id: itemIdSchema.parse("openai-plan-result-item"),
          callId,
          name: "read_file",
          status: "success",
          output: { content: "# Koda" },
        }),
        pinnedPlan,
      ],
      tools: [toolDefinition],
    });

    expect(client.requests[0]?.body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "developer",
          content: expect.stringContaining("expected revision 1"),
        }),
      ]),
    );
    expect(client.requests[1]?.body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "developer",
          content: expect.stringContaining("expected revision 1"),
        }),
      ]),
    );
  });

  it("replays durable history and recovery context on a resumed turn", async () => {
    const client = new FakeOpenAIClient([[completedEvent("resp-resumed")]]);
    const provider = new OpenAIResponsesProvider({
      client,
      model: "gpt-5.6-terra",
      instructions: "Inspect.",
    });
    const historicalCall = toolCallItemSchema.parse({
      type: "tool_call",
      id: itemIdSchema.parse("resume-call-item"),
      callId,
      name: "read_file",
      arguments: { path: "README.md" },
    });
    const historicalResult = toolResultItemSchema.parse({
      type: "tool_result",
      id: itemIdSchema.parse("resume-result-item"),
      callId,
      name: "read_file",
      status: "success",
      output: { content: "# Koda" },
    });
    const recoveryMessage =
      "This thread resumed after the previous turn completed.";

    await collect(provider, {
      threadId,
      turnId: turnIdSchema.parse("openai-resumed-turn"),
      step: 1,
      items: [
        userItem,
        assistantMessageItemSchema.parse({
          type: "assistant_message",
          id: itemIdSchema.parse("resume-assistant-item"),
          content: "I read the README.",
        }),
        historicalCall,
        historicalResult,
        approvalItemSchema.parse({
          type: "approval",
          id: itemIdSchema.parse("resume-approval-item"),
          callId,
          decision: "approved",
        }),
        recoveryItemSchema.parse({
          type: "recovery",
          id: itemIdSchema.parse("resume-recovery-item"),
          previousTurnId: turnId,
          previousStatus: "completed",
          message: recoveryMessage,
          partialTrailingEventDiscarded: false,
          uncertainToolCalls: [],
        }),
        userMessageItemSchema.parse({
          type: "user_message",
          id: itemIdSchema.parse("resume-current-user-item"),
          content: "Continue.",
        }),
      ],
      tools: [toolDefinition],
    });

    expect(client.requests[0]?.body.previous_response_id).toBeUndefined();
    expect(client.requests[0]?.body.input).toEqual([
      { role: "user", content: "Read the README." },
      { role: "assistant", content: "I read the README." },
      {
        type: "function_call",
        call_id: callId,
        name: "read_file",
        arguments: '{"path":"README.md"}',
      },
      {
        type: "function_call_output",
        call_id: callId,
        name: "read_file",
        output: JSON.stringify({
          status: "success",
          output: { content: "# Koda" },
        }),
      },
      {
        role: "developer",
        content: `Koda recovery notice: ${recoveryMessage}`,
      },
      { role: "user", content: "Continue." },
    ]);
  });

  it("resets the response chain when a later model step introduces compaction", async () => {
    const client = new FakeOpenAIClient([
      [
        functionCallEvent(callId, "fc-before-compaction"),
        completedEvent("resp-before"),
      ],
      [completedEvent("resp-after")],
    ]);
    const provider = new OpenAIResponsesProvider({
      client,
      model: "gpt-5.6-terra",
      instructions: "Inspect.",
    });
    await collect(provider, {
      threadId,
      turnId,
      step: 1,
      items: [userItem],
      tools: [toolDefinition],
    });
    const retainedCall = toolCallItemSchema.parse({
      type: "tool_call",
      id: itemIdSchema.parse("compacted-call-item"),
      callId,
      name: "read_file",
      arguments: { path: "README.md" },
    });
    const retainedResult = toolResultItemSchema.parse({
      type: "tool_result",
      id: itemIdSchema.parse("compacted-result-item"),
      callId,
      name: "read_file",
      status: "success",
      output: { content: "# Koda" },
    });
    const compaction = compactionItemSchema.parse({
      type: "compaction",
      id: itemIdSchema.parse("openai-compaction-item"),
      reason: "context_budget",
      retainedItemIds: [userItem.id, retainedCall.id, retainedResult.id],
      estimatedTokensBefore: 2_000,
      estimatedTokensAfter: 500,
      summary: {
        objective: "Read the README.",
        decisions: [],
        modifiedFiles: [],
        completedWork: [],
        pendingWork: ["Read the README."],
        failedAttempts: [],
        criticalFacts: [],
      },
    });

    await collect(provider, {
      threadId,
      turnId,
      step: 2,
      items: [compaction, userItem, retainedCall, retainedResult],
      tools: [toolDefinition],
    });

    expect(client.requests[1]?.body.previous_response_id).toBeUndefined();
    expect(client.requests[1]?.body.input).toEqual([
      {
        role: "developer",
        content: `Koda compacted thread state: ${JSON.stringify(compaction.summary)}`,
      },
      { role: "user", content: "Read the README." },
      {
        type: "function_call",
        call_id: callId,
        name: "read_file",
        arguments: '{"path":"README.md"}',
      },
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
      code: "PROVIDER_OUTPUT_INVALID",
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

  it("normalizes token usage from a completed response", async () => {
    const client = new FakeOpenAIClient([
      [
        streamEvent({
          type: "response.completed",
          response: {
            id: "resp-usage",
            usage: {
              input_tokens: 120,
              input_tokens_details: {
                cached_tokens: 80,
                cache_write_tokens: 10,
              },
              output_tokens: 30,
              output_tokens_details: { reasoning_tokens: 12 },
              total_tokens: 150,
            },
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
    ).resolves.toEqual([
      {
        type: "completed",
        finishReason: "stop",
        responseId: "resp-usage",
        usage: {
          inputTokens: 120,
          cachedInputTokens: 80,
          cacheWriteInputTokens: 10,
          outputTokens: 30,
          reasoningOutputTokens: 12,
          totalTokens: 150,
        },
      },
    ]);
  });

  it("rejects invalid provider token usage", async () => {
    const client = new FakeOpenAIClient([
      [
        streamEvent({
          type: "response.completed",
          response: {
            id: "resp-invalid-usage",
            usage: {
              input_tokens: -1,
              input_tokens_details: {
                cached_tokens: 0,
                cache_write_tokens: 0,
              },
              output_tokens: 1,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 0,
            },
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
    ).rejects.toMatchObject({ code: "PROVIDER_OUTPUT_INVALID" });
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
      code: "PROVIDER_REQUEST_FAILED",
    },
    {
      event: streamEvent({
        type: "response.incomplete",
        response: {},
      }),
      code: "PROVIDER_OUTPUT_INVALID",
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

function planState() {
  return planStateItemSchema.parse({
    type: "plan_state",
    id: itemIdSchema.parse("plan-state:plan:provider:1"),
    plan: {
      schemaVersion: 1,
      planId: "plan:provider",
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
    checkpointRecommended: false,
  });
}

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
