import { AgentLoop, ContextEngine, ToolRegistry } from "@koda/agent-core";
import {
  artifactReferenceSchema,
  assistantMessageItemSchema,
  itemIdSchema,
  recoveryItemSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  userMessageItemSchema,
  type JsonValue,
  type ToolResultItem,
} from "@koda/protocol";
import { ProviderError, ScriptedModelProvider } from "@koda/providers";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DeterministicItemIdFactory,
  FixedClock,
  MemoryEventStore,
  registerEchoTool,
} from "./index.js";

const threadId = threadIdSchema.parse("thread-1");
const turnId = turnIdSchema.parse("turn-1");

function createTools(): ToolRegistry {
  const tools = new ToolRegistry();
  registerEchoTool(tools);
  return tools;
}

describe("AgentLoop", () => {
  it("runs a deterministic model -> tool -> model turn", async () => {
    const events = new MemoryEventStore();
    const provider = new ScriptedModelProvider([
      {
        assertRequest: (request) => {
          expect(request.step).toBe(1);
          expect(request.items.map((item) => item.type)).toEqual([
            "user_message",
          ]);
          expect(request.tools.map((tool) => tool.name)).toEqual(["echo"]);
        },
        events: [
          { type: "assistant_delta", text: "I will echo that. " },
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("call-1"),
            name: "echo",
            arguments: { text: "hello" },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          expect(request.step).toBe(2);
          expect(request.items.map((item) => item.type)).toEqual([
            "user_message",
            "assistant_message",
            "tool_call",
            "tool_result",
          ]);
          const toolResult = request.items.at(-1) as ToolResultItem;
          expect(toolResult.status).toBe("success");
          expect(toolResult.output).toEqual({ echoed: "hello" });
        },
        events: [
          { type: "assistant_delta", text: "Echo returned hello." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const loop = new AgentLoop({
      provider,
      tools: createTools(),
      events,
      ids: new DeterministicItemIdFactory(),
      clock: new FixedClock(),
    });

    const result = await loop.runTurn({
      threadId,
      turnId,
      userInput: "Please echo hello.",
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") {
      throw new Error("Expected a completed result.");
    }
    expect(result.steps).toBe(2);
    expect(result.finalMessage?.content).toBe("Echo returned hello.");
    expect(provider.remainingSteps()).toBe(0);
    expect(events.events.map((event) => event.type)).toEqual([
      "turn.started",
      "item.recorded",
      "assistant.delta",
      "item.recorded",
      "item.recorded",
      "tool.started",
      "tool.execution_started",
      "item.recorded",
      "tool.completed",
      "assistant.delta",
      "item.recorded",
      "turn.completed",
    ]);
    expect(events.events.map((event) => event.sequence)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(result.usage).toEqual({
      modelRequests: 2,
      reportedRequests: 0,
      tokens: {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
    });
  });

  it("continues sequence numbers and records context when resuming history", async () => {
    const events = new MemoryEventStore();
    const history = [
      userMessageItemSchema.parse({
        type: "user_message",
        id: itemIdSchema.parse("history-user"),
        content: "Inspect the project.",
      }),
      assistantMessageItemSchema.parse({
        type: "assistant_message",
        id: itemIdSchema.parse("history-assistant"),
        content: "The project is ready.",
      }),
    ];
    const recovery = recoveryItemSchema.parse({
      type: "recovery",
      id: itemIdSchema.parse("history-recovery"),
      previousTurnId: turnIdSchema.parse("previous-turn"),
      previousStatus: "completed",
      message: "Resume the completed thread.",
      partialTrailingEventDiscarded: false,
      uncertainToolCalls: [],
    });
    const provider = new ScriptedModelProvider([
      {
        assertRequest: (request) => {
          expect(request.items.map((item) => item.type)).toEqual([
            "user_message",
            "assistant_message",
            "recovery",
            "user_message",
          ]);
        },
        events: [
          { type: "assistant_delta", text: "Continuing." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);

    const result = await new AgentLoop({
      provider,
      tools: createTools(),
      events,
      ids: new DeterministicItemIdFactory("resume-item"),
      clock: new FixedClock(),
    }).runTurn({
      threadId,
      turnId: turnIdSchema.parse("resumed-turn"),
      userInput: "Continue.",
      history,
      prefaceItems: [recovery],
      initialSequence: 10,
      context: {
        provider: "openai",
        model: "test-model",
        workspaceRoot: "/workspace",
        approvalMode: "on-request",
        instructionsSha256: "a".repeat(64),
        repositoryInstructions: [],
      },
    });

    expect(result.status).toBe("completed");
    expect(events.events.map((event) => event.sequence)).toEqual([
      10, 11, 12, 13, 14, 15, 16,
    ]);
    expect(events.events.map((event) => event.type)).toEqual([
      "turn.started",
      "turn.context",
      "item.recorded",
      "item.recorded",
      "assistant.delta",
      "item.recorded",
      "turn.completed",
    ]);
    expect(events.events[1]).toMatchObject({
      type: "turn.context",
      payload: { workspaceRoot: "/workspace", model: "test-model" },
    });
  });

  it("records a durable compaction before sending reduced context", async () => {
    const events = new MemoryEventStore();
    const ids = new DeterministicItemIdFactory("context-loop-item");
    const provider = new ScriptedModelProvider([
      {
        assertRequest: (request) => {
          expect(request.items[0]).toMatchObject({
            type: "compaction",
            reason: "context_budget",
          });
          expect(request.items.at(-1)).toMatchObject({
            type: "user_message",
            content: "Continue now.",
          });
          expect(
            request.items.some((item) => item.id === "large-history"),
          ).toBe(false);
        },
        events: [
          { type: "assistant_delta", text: "Continued." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const result = await new AgentLoop({
      provider,
      tools: createTools(),
      events,
      ids,
      clock: new FixedClock(),
      contextEngine: new ContextEngine({
        contextWindowTokens: 1_000,
        maxOutputTokens: 100,
        safetyMarginTokens: 100,
        fixedInputTokens: 20,
        ids,
      }),
    }).runTurn({
      threadId,
      turnId,
      userInput: "Continue now.",
      history: [
        userMessageItemSchema.parse({
          type: "user_message",
          id: itemIdSchema.parse("large-history"),
          content: "x".repeat(8_000),
        }),
      ],
    });

    expect(result.status).toBe("completed");
    expect(result.items.some((item) => item.type === "compaction")).toBe(true);
    expect(
      events.events.some(
        (event) =>
          event.type === "item.recorded" &&
          event.payload.item.type === "compaction",
      ),
    ).toBe(true);
  });

  it("fails before provider use when mandatory context cannot fit", async () => {
    const provider = new ScriptedModelProvider([
      {
        events: [
          { type: "assistant_delta", text: "Must not run." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const ids = new DeterministicItemIdFactory("context-failure-item");

    const result = await new AgentLoop({
      provider,
      tools: createTools(),
      events: new MemoryEventStore(),
      ids,
      clock: new FixedClock(),
      contextEngine: new ContextEngine({
        contextWindowTokens: 600,
        maxOutputTokens: 100,
        safetyMarginTokens: 100,
        fixedInputTokens: 20,
        ids,
      }),
    }).runTurn({
      threadId,
      turnId,
      userInput: "x".repeat(5_000),
    });

    expect(result).toMatchObject({
      status: "failed",
      steps: 0,
      error: { code: "CONTEXT_BUDGET_EXCEEDED" },
      usage: { modelRequests: 0 },
    });
    expect(provider.remainingSteps()).toBe(1);
  });

  it("records artifact references emitted by a successful tool", async () => {
    const artifact = artifactReferenceSchema.parse({
      type: "artifact",
      id: `sha256:${"a".repeat(64)}`,
      sha256: "a".repeat(64),
      bytes: 100_000,
      mediaType: "text/plain; charset=utf-8",
    });
    const tools = new ToolRegistry();
    tools.register({
      spec: {
        name: "large_output",
        description: "Return an artifact reference.",
        inputJsonSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      inputSchema: z.object({}).strict(),
      concurrency: "parallel",
      effect: "read",
      execute: async () => ({ excerpt: "bounded", artifact }),
    });
    const events = new MemoryEventStore();
    const callId = toolCallIdSchema.parse("artifact-call");
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId,
            name: "large_output",
            arguments: {},
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        events: [
          { type: "assistant_delta", text: "Artifact recorded." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);

    const result = await new AgentLoop({
      provider,
      tools,
      events,
      ids: new DeterministicItemIdFactory("artifact-item"),
      clock: new FixedClock(),
    }).runTurn({ threadId, turnId, userInput: "Produce output." });

    expect(result.status).toBe("completed");
    expect(
      events.events.filter((event) => event.type === "artifact.recorded"),
    ).toEqual([
      expect.objectContaining({
        payload: { callId, name: "large_output", artifact },
      }),
    ]);
  });

  it("fails before recording provider output beyond the byte limit", async () => {
    const events = new MemoryEventStore();
    const provider = new ScriptedModelProvider([
      {
        events: [
          { type: "assistant_delta", text: "12345" },
          { type: "assistant_delta", text: "67890" },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);

    const result = await new AgentLoop({
      provider,
      tools: createTools(),
      events,
      ids: new DeterministicItemIdFactory("limited-item"),
      clock: new FixedClock(),
      maxModelOutputBytes: 8,
    }).runTurn({ threadId, turnId, userInput: "Stay bounded." });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "MODEL_OUTPUT_LIMIT_EXCEEDED" },
    });
    expect(
      events.events
        .filter((event) => event.type === "assistant.delta")
        .map((event) => event.payload),
    ).toEqual([{ text: "12345" }]);
  });

  it("does not execute an over-budget provider tool call", async () => {
    const events = new MemoryEventStore();
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("oversized-call"),
            name: "echo",
            arguments: { text: "x".repeat(100) },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
    ]);

    const result = await new AgentLoop({
      provider,
      tools: createTools(),
      events,
      ids: new DeterministicItemIdFactory("oversized-item"),
      clock: new FixedClock(),
      maxModelOutputBytes: 32,
    }).runTurn({ threadId, turnId, userInput: "Stay bounded." });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "MODEL_OUTPUT_LIMIT_EXCEEDED" },
    });
    expect(events.events.some((event) => event.type === "tool.started")).toBe(
      false,
    );
  });

  it("persists provider continuation state before executing its tool step", async () => {
    const events = new MemoryEventStore();
    const callId = toolCallIdSchema.parse("state-call");
    const provider = new ScriptedModelProvider([
      {
        events: [
          { type: "assistant_delta", text: "I will inspect it." },
          {
            type: "tool_call",
            callId,
            name: "echo",
            arguments: { text: "stateful" },
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
                    thinking: "inspect first",
                    signature: "opaque-signature",
                  },
                ],
              },
            },
          },
        ],
      },
      {
        assertRequest: (request) => {
          expect(request.items.map((item) => item.type)).toEqual([
            "user_message",
            "assistant_message",
            "provider_state",
            "tool_call",
            "tool_result",
          ]);
          expect(request.items[2]).toMatchObject({
            provider: "anthropic",
            data: {
              blocks: [
                {
                  type: "thinking",
                  signature: "opaque-signature",
                },
              ],
            },
          });
        },
        events: [
          { type: "assistant_delta", text: "Done." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);

    const result = await new AgentLoop({
      provider,
      tools: createTools(),
      events,
      ids: new DeterministicItemIdFactory("state-item"),
      clock: new FixedClock(),
    }).runTurn({ threadId, turnId, userInput: "Inspect statefully." });

    expect(result.status).toBe("completed");
    const recordedTypes = events.events
      .filter((event) => event.type === "item.recorded")
      .map((event) => event.payload.item.type);
    expect(recordedTypes).toEqual([
      "user_message",
      "assistant_message",
      "provider_state",
      "tool_call",
      "tool_result",
      "assistant_message",
    ]);
  });

  it("rejects oversized provider state before any tool execution", async () => {
    const events = new MemoryEventStore();
    const result = await new AgentLoop({
      provider: new ScriptedModelProvider([
        {
          events: [
            {
              type: "tool_call",
              callId: toolCallIdSchema.parse("oversized-state-call"),
              name: "echo",
              arguments: { text: "safe" },
            },
            {
              type: "completed",
              finishReason: "tool_calls",
              providerState: {
                provider: "deepseek",
                data: { reasoning_content: "x".repeat(100) },
              },
            },
          ],
        },
      ]),
      tools: createTools(),
      events,
      ids: new DeterministicItemIdFactory("oversized-state-item"),
      clock: new FixedClock(),
      maxModelOutputBytes: 80,
    }).runTurn({ threadId, turnId, userInput: "Do not execute." });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "MODEL_OUTPUT_LIMIT_EXCEEDED" },
    });
    expect(events.events.some((event) => event.type === "tool.started")).toBe(
      false,
    );
  });

  it("records per-step usage and aggregates a multi-step turn", async () => {
    const events = new MemoryEventStore();
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("usage-call"),
            name: "echo",
            arguments: { text: "measure" },
          },
          {
            type: "completed",
            finishReason: "tool_calls",
            responseId: "usage-response-1",
            usage: {
              inputTokens: 100,
              cachedInputTokens: 60,
              cacheWriteInputTokens: 5,
              outputTokens: 20,
              reasoningOutputTokens: 8,
              totalTokens: 120,
            },
          },
        ],
      },
      {
        events: [
          { type: "assistant_delta", text: "Measured." },
          {
            type: "completed",
            finishReason: "stop",
            responseId: "usage-response-2",
            usage: {
              inputTokens: 140,
              cachedInputTokens: 90,
              cacheWriteInputTokens: 0,
              outputTokens: 30,
              reasoningOutputTokens: 10,
              totalTokens: 170,
            },
          },
        ],
      },
    ]);

    const result = await new AgentLoop({
      provider,
      tools: createTools(),
      events,
      ids: new DeterministicItemIdFactory(),
      clock: new FixedClock(),
    }).runTurn({ threadId, turnId, userInput: "Measure usage." });

    expect(result.usage).toEqual({
      modelRequests: 2,
      reportedRequests: 2,
      tokens: {
        inputTokens: 240,
        cachedInputTokens: 150,
        cacheWriteInputTokens: 5,
        outputTokens: 50,
        reasoningOutputTokens: 18,
        totalTokens: 290,
      },
    });
    const usageEvents = events.events.filter(
      (event) => event.type === "model.usage",
    );
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0]).toMatchObject({
      payload: {
        step: 1,
        responseId: "usage-response-1",
        usage: { totalTokens: 120 },
      },
    });
    expect(events.events.at(-1)).toMatchObject({
      type: "turn.completed",
      payload: {
        usage: {
          modelRequests: 2,
          reportedRequests: 2,
          tokens: { totalTokens: 290 },
        },
      },
    });
  });

  it("returns invalid tool arguments to the model as an observation", async () => {
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("call-invalid"),
            name: "echo",
            arguments: { text: 42 },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          const result = request.items.at(-1) as ToolResultItem;
          expect(result.status).toBe("error");
          expect(result.error?.code).toBe("INVALID_TOOL_ARGUMENTS");
        },
        events: [
          { type: "assistant_delta", text: "The tool input was invalid." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);

    const result = await new AgentLoop({
      provider,
      tools: createTools(),
      events: new MemoryEventStore(),
      ids: new DeterministicItemIdFactory(),
      clock: new FixedClock(),
    }).runTurn({ threadId, turnId, userInput: "Use echo." });

    expect(result.status).toBe("completed");
  });

  it("returns unknown tools to the model as recoverable errors", async () => {
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("call-unknown"),
            name: "missing_tool",
            arguments: {},
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          const result = request.items.at(-1) as ToolResultItem;
          expect(result.error?.code).toBe("UNKNOWN_TOOL");
        },
        events: [
          { type: "assistant_delta", text: "That tool is unavailable." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);

    const result = await new AgentLoop({
      provider,
      tools: createTools(),
      events: new MemoryEventStore(),
      ids: new DeterministicItemIdFactory(),
      clock: new FixedClock(),
    }).runTurn({ threadId, turnId, userInput: "Use the missing tool." });

    expect(result.status).toBe("completed");
  });

  it("rejects non-JSON tool output before it reaches the transcript", async () => {
    const tools = new ToolRegistry();
    tools.register({
      spec: {
        name: "invalid_output",
        description: "Return an invalid value for a runtime-validation test.",
        inputJsonSchema: { type: "object" },
      },
      inputSchema: z.object({}),
      concurrency: "parallel",
      effect: "read",
      execute: async () => undefined as unknown as JsonValue,
    });
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("call-invalid-output"),
            name: "invalid_output",
            arguments: {},
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          const result = request.items.at(-1) as ToolResultItem;
          expect(result.error?.code).toBe("INVALID_TOOL_OUTPUT");
        },
        events: [
          { type: "assistant_delta", text: "The tool output was invalid." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);

    const result = await new AgentLoop({
      provider,
      tools,
      events: new MemoryEventStore(),
      ids: new DeterministicItemIdFactory(),
      clock: new FixedClock(),
    }).runTurn({ threadId, turnId, userInput: "Run the invalid tool." });

    expect(result.status).toBe("completed");
  });

  it("fails when a provider stream ends without a completed event", async () => {
    const events = new MemoryEventStore();
    const result = await new AgentLoop({
      provider: new ScriptedModelProvider([
        { events: [{ type: "assistant_delta", text: "unfinished" }] },
      ]),
      tools: createTools(),
      events,
      ids: new DeterministicItemIdFactory(),
      clock: new FixedClock(),
    }).runTurn({ threadId, turnId, userInput: "Start but do not finish." });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "MODEL_PROTOCOL_ERROR" },
    });
    expect(events.events.at(-1)?.type).toBe("turn.failed");
  });

  it("preserves stable provider error codes in the durable terminal event", async () => {
    const events = new MemoryEventStore();
    const result = await new AgentLoop({
      provider: {
        stream: async function* () {
          throw new ProviderError(
            "PROVIDER_RATE_LIMITED",
            "The provider rate-limited the request.",
          );
        },
      },
      tools: createTools(),
      events,
      ids: new DeterministicItemIdFactory("provider-error-item"),
      clock: new FixedClock(),
    }).runTurn({ threadId, turnId, userInput: "Try once." });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_RATE_LIMITED" },
    });
    expect(events.events.at(-1)).toMatchObject({
      type: "turn.failed",
      payload: { code: "PROVIDER_RATE_LIMITED" },
    });
  });

  it("records cancellation as an explicit terminal result", async () => {
    const controller = new AbortController();
    controller.abort("Stopped by the user.");
    const events = new MemoryEventStore();
    const loop = new AgentLoop({
      provider: new ScriptedModelProvider([]),
      tools: createTools(),
      events,
      ids: new DeterministicItemIdFactory(),
      clock: new FixedClock(),
    });

    const result = await loop.runTurn({
      threadId,
      turnId,
      userInput: "Do work.",
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      status: "cancelled",
      steps: 0,
      reason: "Stopped by the user.",
    });
    expect(events.events.at(-1)?.type).toBe("turn.cancelled");
  });

  it("fails explicitly when the maximum model-step limit is exhausted", async () => {
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("call-limit-1"),
            name: "echo",
            arguments: { text: "one" },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("call-limit-2"),
            name: "echo",
            arguments: { text: "two" },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
    ]);
    const events = new MemoryEventStore();
    const result = await new AgentLoop({
      provider,
      tools: createTools(),
      events,
      ids: new DeterministicItemIdFactory(),
      clock: new FixedClock(),
      maxSteps: 2,
    }).runTurn({ threadId, turnId, userInput: "Loop forever." });

    expect(result).toMatchObject({
      status: "failed",
      steps: 2,
      error: { code: "MAX_STEPS_EXCEEDED" },
    });
    expect(events.events.at(-1)?.type).toBe("turn.failed");
  });
});
