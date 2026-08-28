import {
  AgentLoop,
  PlanRuntimeState,
  ToolRegistry,
  reducePlanUpdate,
  type EventSink,
} from "@koda/agent-core";
import {
  planIdSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type AgentEvent,
  type JsonObject,
} from "@koda/protocol";
import { ScriptedModelProvider } from "@koda/providers";
import { registerUpdatePlanTool } from "@koda/runtime-node";
import { describe, expect, it } from "vitest";

import {
  DeterministicItemIdFactory,
  FixedClock,
  MemoryEventStore,
} from "./index.js";

const threadId = threadIdSchema.parse("planning-thread");
const turnId = turnIdSchema.parse("planning-turn");
const budgetCases: readonly {
  name: string;
  expectedReason: "step_budget" | "time_budget";
  maxTurnDurationMs: number;
  monotonicNow: () => number;
}[] = [
  {
    name: "step budget",
    expectedReason: "step_budget",
    maxTurnDurationMs: 1_000,
    monotonicNow: (): number => 0,
  },
  {
    name: "time budget",
    expectedReason: "time_budget",
    maxTurnDurationMs: 10,
    monotonicNow: monotonicSequence([0, 100]),
  },
];

describe("planning Harness", () => {
  it("persists update_plan before success and pins the current Plan into the next request", async () => {
    const events = new MemoryEventStore();
    const state = createPlanState();
    const tools = createPlanTools(state);
    const provider = new ScriptedModelProvider([
      {
        assertRequest: (request) => {
          expect(request.tools.map((tool) => tool.name)).toEqual([
            "update_plan",
          ]);
        },
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("create-plan"),
            name: "update_plan",
            arguments: activePlanInput(0),
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          const planState = request.items.at(-1);
          expect(planState).toMatchObject({
            type: "plan_state",
            plan: { revision: 1, objective: "Implement planning" },
            needsRevalidation: false,
          });
        },
        events: [
          { type: "assistant_delta", text: "Plan saved." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);

    const result = await new AgentLoop({
      provider,
      tools,
      events,
      ids: new DeterministicItemIdFactory("planning-item"),
      clock: new FixedClock(),
      planState: state,
    }).runTurn({ threadId, turnId, userInput: "Create the plan." });

    expect(result.status).toBe("completed");
    expect(state.currentPlan()).toMatchObject({ revision: 1 });
    const types = events.events.map((event) => event.type);
    expect(types.indexOf("tool.execution_started")).toBeLessThan(
      types.indexOf("plan.updated"),
    );
    expect(types.indexOf("plan.updated")).toBeLessThan(
      types.indexOf("plan.checkpointed"),
    );
    expect(types.indexOf("plan.checkpointed")).toBeLessThan(
      types.indexOf("tool.completed"),
    );
    expect(
      events.events.filter((event) => event.type === "plan.checkpointed"),
    ).toHaveLength(2);
  });

  it("returns a stable revision conflict as a recoverable tool result", async () => {
    const state = createPlanState();
    state.commitPlan(
      reducePlanUpdate({
        planId: planIdSchema.parse("plan:existing"),
        update: canonicalPlanDraft(0),
      }),
    );
    const events = new MemoryEventStore();
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("stale-plan"),
            name: "update_plan",
            arguments: activePlanInput(99),
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          expect(
            request.items.find(
              (item) =>
                item.type === "tool_result" && item.callId === "stale-plan",
            ),
          ).toMatchObject({
            type: "tool_result",
            status: "error",
            error: { code: "PLAN_REVISION_CONFLICT" },
          });
        },
        events: [{ type: "completed", finishReason: "stop" }],
      },
    ]);

    const result = await new AgentLoop({
      provider,
      tools: createPlanTools(state),
      events,
      ids: new DeterministicItemIdFactory("revision-item"),
      clock: new FixedClock(),
      planState: state,
    }).runTurn({ threadId, turnId, userInput: "Update the plan." });

    expect(result.status).toBe("completed");
    expect(state.currentPlan()?.revision).toBe(1);
    expect(events.events.some((event) => event.type === "plan.updated")).toBe(
      false,
    );
  });

  it("does not expose update_plan success when its durable event cannot be written", async () => {
    const events = new RejectPlanUpdateSink();
    const state = createPlanState();
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("unpersisted-plan"),
            name: "update_plan",
            arguments: activePlanInput(0),
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
    ]);

    const result = await new AgentLoop({
      provider,
      tools: createPlanTools(state),
      events,
      ids: new DeterministicItemIdFactory("failure-item"),
      clock: new FixedClock(),
      planState: state,
    }).runTurn({ threadId, turnId, userInput: "Create the plan." });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "EVENT_PERSISTENCE_FAILED" },
    });
    expect(state.currentPlan()).toBeUndefined();
    expect(events.events.some((event) => event.type === "tool.completed")).toBe(
      false,
    );
  });

  it.each(budgetCases)("pauses safely at the $name", async (testCase) => {
    const events = new MemoryEventStore();
    const state = createPlanState();
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse(`pause-${testCase.expectedReason}`),
            name: "update_plan",
            arguments: activePlanInput(0),
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
    ]);

    const result = await new AgentLoop({
      provider,
      tools: createPlanTools(state),
      events,
      ids: new DeterministicItemIdFactory("pause-item"),
      clock: new FixedClock(),
      planState: state,
      maxSteps: 1,
      maxTurnDurationMs: testCase.maxTurnDurationMs,
      monotonicNow: testCase.monotonicNow,
    }).runTurn({ threadId, turnId, userInput: "Work until the budget." });

    expect(result).toMatchObject({
      status: "paused",
      reason: testCase.expectedReason,
      checkpoint: { reason: "safe_pause" },
    });
    const terminal = events.events.at(-1);
    expect(terminal).toMatchObject({
      type: "turn.paused",
      payload: { reason: testCase.expectedReason },
    });
    if (terminal?.type === "turn.paused") {
      expect(terminal.payload.checkpointId).toBe(
        state.lastCheckpoint()?.checkpointId,
      );
    }
  });
});

function createPlanState(): PlanRuntimeState {
  const ids = new DeterministicItemIdFactory("plan-runtime");
  return new PlanRuntimeState({ nextOpaqueId: () => ids.next() });
}

function createPlanTools(state: PlanRuntimeState): ToolRegistry {
  const tools = new ToolRegistry();
  registerUpdatePlanTool(tools, state);
  return tools;
}

function activePlanInput(expectedRevision: number): JsonObject {
  return {
    expected_revision: expectedRevision,
    objective: "Implement planning",
    stages: [
      {
        id: "stage-build",
        title: "Build it",
        requires_acceptance: false,
        acceptance_criteria: [],
        evidence: [],
        todos: [
          {
            id: "todo-code",
            title: "Write the code",
            status: "in_progress",
          },
        ],
      },
    ],
  };
}

function canonicalPlanDraft(expectedRevision: number) {
  return {
    expectedRevision,
    objective: "Implement planning",
    stages: [
      {
        id: "stage-build",
        title: "Build it",
        requiresAcceptance: false,
        acceptanceCriteria: [],
        evidence: [],
        todos: [
          {
            id: "todo-code",
            title: "Write the code",
            status: "in_progress",
          },
        ],
      },
    ],
  };
}

function monotonicSequence(values: readonly number[]): () => number {
  let cursor = 0;
  return () => values[Math.min(cursor++, values.length - 1)] ?? 0;
}

class RejectPlanUpdateSink implements EventSink {
  public readonly events: AgentEvent[] = [];

  public async append(event: AgentEvent): Promise<void> {
    if (event.type === "plan.updated") {
      throw new Error("disk unavailable");
    }
    this.events.push(event);
  }
}
