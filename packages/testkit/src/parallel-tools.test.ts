import {
  AgentLoop,
  ContextEngine,
  EffectToolPolicy,
  PlanRuntimeState,
  ToolRegistry,
} from "@koda/agent-core";
import {
  threadIdSchema,
  turnIdSchema,
  toolCallIdSchema,
  type ConversationItem,
} from "@koda/protocol";
import { ScriptedModelProvider } from "@koda/providers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DeterministicItemIdFactory,
  FixedClock,
  MemoryEventStore,
} from "./index.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function provider(names: string[]) {
  return new ScriptedModelProvider([
    {
      events: [
        ...names.map((name, index) => ({
          type: "tool_call" as const,
          callId: toolCallIdSchema.parse(`parallel-${index}`),
          name,
          arguments: {},
        })),
        { type: "completed", finishReason: "tool_calls" },
      ],
    },
    { events: [{ type: "completed", finishReason: "stop" }] },
  ]);
}
function register(
  tools: ToolRegistry,
  name: string,
  concurrency: "parallel" | "exclusive",
  execute: () => Promise<string>,
) {
  tools.register({
    spec: {
      name,
      description: name,
      inputJsonSchema: { type: "object", properties: {} },
    },
    inputSchema: z.object({}),
    effect: "read",
    concurrency,
    execute,
  });
}
const input = {
  threadId: threadIdSchema.parse("parallel-thread"),
  turnId: turnIdSchema.parse("parallel-turn"),
  userInput: "Read files.",
};

describe("parallel read tools", () => {
  it("bounds reads at four and treats exclusive tools as barriers", async () => {
    const tools = new ToolRegistry();
    const gate = deferred();
    const fourStarted = deferred();
    let active = 0;
    let peak = 0;
    let reads = 0;
    let barrier = false;
    register(tools, "read", "parallel", async () => {
      active += 1;
      peak = Math.max(peak, active);
      reads += 1;
      if (reads === 4) fourStarted.resolve();
      await gate.promise;
      active -= 1;
      return "read";
    });
    register(tools, "barrier", "exclusive", async () => {
      expect(active).toBe(0);
      expect(reads).toBe(5);
      barrier = true;
      return "barrier";
    });
    register(tools, "after", "parallel", async () => {
      expect(barrier).toBe(true);
      return "after";
    });
    const events = new MemoryEventStore();
    const loop = new AgentLoop({
      tools,
      provider: provider([
        "read",
        "read",
        "read",
        "read",
        "read",
        "barrier",
        "after",
      ]),
      events,
      ids: new DeterministicItemIdFactory("parallel-item"),
      clock: new FixedClock(),
      policy: new EffectToolPolicy("never"),
      planState: new PlanRuntimeState({ nextOpaqueId: () => "plan-id" }),
    });
    const running = loop.runTurn(input);
    await fourStarted.promise;
    expect(active).toBe(4);
    expect(reads).toBe(4);
    gate.resolve();
    const result = await running;
    expect(result.status).toBe("completed");
    expect(peak).toBe(4);
    expect(events.events.map((event) => event.sequence)).toEqual(
      events.events.map((_, index) => index),
    );
    const calls = result.items.filter((item) => item.type === "tool_call");
    for (const call of calls) {
      const index = result.items.indexOf(call);
      expect(result.items[index + 1]).toMatchObject({
        type: "tool_result",
        callId: call.callId,
      });
    }
    const raw: ConversationItem[] = events.events.flatMap((event) =>
      event.type === "item.recorded" ? [event.payload.item] : [],
    );
    const context = new ContextEngine({
      contextWindowTokens: 100_000,
      maxOutputTokens: 100,
      safetyMarginTokens: 100,
      ids: new DeterministicItemIdFactory("context"),
    });
    expect(context.prepare(raw, []).items).toEqual(result.items);
  });

  it("waits for active reads on cancellation and never admits later work", async () => {
    const tools = new ToolRegistry();
    const gate = deferred();
    const started = deferred();
    let count = 0;
    let active = 0;
    register(tools, "read", "parallel", async () => {
      count += 1;
      active += 1;
      if (count === 4) started.resolve();
      await gate.promise;
      active -= 1;
      return "read";
    });
    const controller = new AbortController();
    const events = new MemoryEventStore();
    const running = new AgentLoop({
      tools,
      provider: provider(Array(6).fill("read")),
      events,
      ids: new DeterministicItemIdFactory("cancel-item"),
      clock: new FixedClock(),
    }).runTurn({ ...input, signal: controller.signal });
    await started.promise;
    controller.abort();
    gate.resolve();
    expect((await running).status).toBe("cancelled");
    expect(count).toBe(4);
    expect(active).toBe(0);
    expect(
      events.events.filter((event) => event.type === "turn.cancelled"),
    ).toHaveLength(1);
  });

  it("keeps custom policies serial", async () => {
    const tools = new ToolRegistry();
    let active = 0;
    let peak = 0;
    register(tools, "read", "parallel", async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return "read";
    });
    const result = await new AgentLoop({
      tools,
      provider: provider(["read", "read"]),
      events: new MemoryEventStore(),
      ids: new DeterministicItemIdFactory("serial-item"),
      policy: { evaluate: () => ({ decision: "allow" }) },
    }).runTurn(input);
    expect(result.status).toBe("completed");
    expect(peak).toBe(1);
  });
});
