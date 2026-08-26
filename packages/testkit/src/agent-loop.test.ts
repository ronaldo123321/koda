import { AgentLoop, ToolRegistry } from "@koda/agent-core";
import {
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type JsonValue,
  type ToolResultItem,
} from "@koda/protocol";
import { ScriptedModelProvider } from "@koda/providers";
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
      "item.recorded",
      "tool.completed",
      "assistant.delta",
      "item.recorded",
      "turn.completed",
    ]);
    expect(events.events.map((event) => event.sequence)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
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
