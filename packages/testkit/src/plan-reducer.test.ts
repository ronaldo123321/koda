import {
  PlanReducerError,
  reducePlanAcceptance,
  reducePlanUpdate,
} from "@koda/agent-core";
import {
  PLAN_MAXIMUM_STAGES,
  agentEventSchema,
  itemIdSchema,
  planAcceptanceResolutionSchema,
  planCheckpointSchema,
  planIdSchema,
  planSnapshotSchema,
  planStageDraftSchema,
  planStageIdSchema,
  planTodoIdSchema,
  planTodoSchema,
  planUpdatedPayloadSchema,
  toolCallIdSchema,
  threadIdSchema,
  turnPausedPayloadSchema,
  turnIdSchema,
  type PlanErrorCode,
  type PlanAcceptanceResolution,
  type PlanSnapshot,
  type PlanStage,
  type PlanStageDraft,
  type PlanTodo,
  type PlanTodoStatus,
  type PlanUpdateDraft,
} from "@koda/protocol";
import { describe, expect, it } from "vitest";

const planId = planIdSchema.parse("plan:test");
const callId = toolCallIdSchema.parse("plan-call");
const evidence = [
  { kind: "item" as const, itemId: itemIdSchema.parse("plan-evidence") },
];

describe("Phase 3G1 plan protocol", () => {
  it("validates snapshots, checkpoints, acceptance, updates, and paused turns", () => {
    const plan = createPlan([stage("stage-1", [todo("todo-1", "pending")])]);
    const checkpoint = planCheckpointSchema.parse({
      checkpointId: "checkpoint:1",
      planId,
      planRevision: plan.revision,
      activeStageId: "stage-1",
      activeTodoId: "todo-1",
      lastSafeSequence: 7,
      reason: "plan_update",
      nextAction: "Start the first Todo.",
      evidence: [],
    });

    expect(planSnapshotSchema.parse(plan)).toEqual(plan);
    expect(
      planUpdatedPayloadSchema.parse({
        callId,
        source: "model_update",
        plan,
        explanation: "Created the initial plan.",
      }),
    ).toMatchObject({ plan: { revision: 1 } });
    expect(checkpoint.activeTodoId).toBe("todo-1");
    expect(
      planAcceptanceResolutionSchema.parse({
        callId,
        planId,
        planRevision: 1,
        stageId: "stage-1",
        decision: "changes_requested",
        feedback: "Add recovery coverage.",
      }).decision,
    ).toBe("changes_requested");
    expect(
      turnPausedPayloadSchema.parse({
        reason: "step_budget",
        checkpointId: "checkpoint:1",
      }),
    ).toEqual({ reason: "step_budget", checkpointId: "checkpoint:1" });

    const metadata = {
      schemaVersion: 1 as const,
      timestamp: "2026-08-28T00:00:00.000Z",
      threadId: threadIdSchema.parse("plan-thread"),
      turnId: turnIdSchema.parse("plan-turn"),
    };
    const events = [
      {
        ...metadata,
        sequence: 0,
        type: "plan.updated",
        payload: { callId, source: "model_update", plan },
      },
      {
        ...metadata,
        sequence: 1,
        type: "plan.checkpointed",
        payload: { checkpoint },
      },
      {
        ...metadata,
        sequence: 2,
        type: "plan.acceptance_requested",
        payload: {
          callId,
          planId,
          planRevision: 1,
          stageId: "stage-1",
          criteria: ["Review the result."],
          summary: "Ready for review.",
          evidence,
        },
      },
      {
        ...metadata,
        sequence: 3,
        type: "plan.acceptance_resolved",
        payload: {
          callId,
          planId,
          planRevision: 1,
          stageId: "stage-1",
          decision: "accepted",
        },
      },
      {
        ...metadata,
        sequence: 4,
        type: "turn.paused",
        payload: { reason: "step_budget", checkpointId: "checkpoint:1" },
      },
    ];
    expect(events.map((event) => agentEventSchema.parse(event).type)).toEqual([
      "plan.updated",
      "plan.checkpointed",
      "plan.acceptance_requested",
      "plan.acceptance_resolved",
      "turn.paused",
    ]);
  });

  it("rejects incomplete conditional fields and detached active Todos", () => {
    expect(
      planTodoSchema.safeParse({
        id: "todo-1",
        title: "Incomplete",
        status: "completed",
      }).success,
    ).toBe(false);
    expect(
      planTodoSchema.safeParse({
        id: "todo-1",
        title: "Blocked",
        status: "blocked",
      }).success,
    ).toBe(false);
    expect(
      planTodoSchema.safeParse({
        id: "todo-1",
        title: "Cancelled",
        status: "cancelled",
      }).success,
    ).toBe(false);
    expect(
      planCheckpointSchema.safeParse({
        checkpointId: "checkpoint:1",
        planId,
        planRevision: 1,
        activeTodoId: "todo-1",
        lastSafeSequence: 1,
        reason: "safe_pause",
        evidence: [],
      }).success,
    ).toBe(false);
    expect(
      planAcceptanceResolutionSchema.safeParse({
        callId,
        planId,
        planRevision: 1,
        stageId: "stage-1",
        decision: "changes_requested",
      }).success,
    ).toBe(false);
  });
});

describe("Phase 3G1 plan reducer", () => {
  it("creates a Plan and derives pending, active, and completed state", () => {
    const pending = createPlan([stage("stage-1", [todo("todo-1", "pending")])]);
    expect(pending).toMatchObject({
      revision: 1,
      status: "active",
      stages: [{ status: "pending" }],
    });

    const active = updatePlan(pending, [
      stage("stage-1", [todo("todo-1", "in_progress")]),
    ]);
    expect(active).toMatchObject({
      revision: 2,
      status: "active",
      stages: [{ status: "active", todos: [{ status: "in_progress" }] }],
    });

    const completed = updatePlan(active, [
      stage("stage-1", [todo("todo-1", "completed")]),
    ]);
    expect(completed).toMatchObject({
      revision: 3,
      status: "completed",
      stages: [{ status: "completed", todos: [{ outcome: "Done." }] }],
    });
  });

  it("accepts every valid Todo transition", () => {
    const transitions: Array<{
      from: PlanTodoStatus;
      to: PlanTodoStatus;
      overrides?: Record<string, string>;
    }> = [
      { from: "pending", to: "pending" },
      { from: "pending", to: "in_progress" },
      { from: "pending", to: "cancelled" },
      { from: "in_progress", to: "in_progress" },
      { from: "in_progress", to: "blocked" },
      { from: "in_progress", to: "completed" },
      { from: "in_progress", to: "cancelled" },
      { from: "blocked", to: "blocked" },
      { from: "blocked", to: "in_progress" },
      { from: "blocked", to: "cancelled" },
      { from: "completed", to: "completed" },
      {
        from: "completed",
        to: "in_progress",
        overrides: { reopenReason: "Verification failed." },
      },
      { from: "cancelled", to: "cancelled" },
    ];

    for (const transition of transitions) {
      const previous = createPlan([
        stage("stage-1", [todo("todo-1", transition.from)]),
      ]);
      expect(() =>
        updatePlan(previous, [
          stage("stage-1", [
            todo("todo-1", transition.to, transition.overrides),
          ]),
        ]),
      ).not.toThrow();
    }
  });

  it.each([
    ["pending", "blocked"],
    ["pending", "completed"],
    ["in_progress", "pending"],
    ["blocked", "pending"],
    ["blocked", "completed"],
    ["completed", "pending"],
    ["cancelled", "in_progress"],
  ] as const)("rejects Todo transition %s -> %s", (from, to) => {
    const previous = createPlan([stage("stage-1", [todo("todo-1", from)])]);
    expectPlanError(
      () => updatePlan(previous, [stage("stage-1", [todo("todo-1", to)])]),
      "PLAN_TRANSITION_INVALID",
    );
  });

  it("requires a new reason when reopening completed work", () => {
    const previous = createPlan([
      stage("stage-1", [
        todo("todo-1", "completed", { reopenReason: "Old reason." }),
      ]),
    ]);
    expectPlanError(
      () =>
        updatePlan(previous, [
          stage("stage-1", [
            todo("todo-1", "in_progress", { reopenReason: "Old reason." }),
          ]),
        ]),
      "PLAN_TRANSITION_INVALID",
    );
    expect(
      updatePlan(previous, [
        stage("stage-1", [
          todo("todo-1", "in_progress", { reopenReason: "New reason." }),
        ]),
      ]).stages[0]?.status,
    ).toBe("active");
  });

  it("enforces one active Todo and sequential Stage execution", () => {
    expectPlanError(
      () =>
        createPlan([
          stage("stage-1", [todo("todo-1", "in_progress")]),
          stage("stage-2", [todo("todo-2", "in_progress")]),
        ]),
      "PLAN_TRANSITION_INVALID",
    );
    expectPlanError(
      () =>
        createPlan([
          stage("stage-1", [todo("todo-1", "pending")]),
          stage("stage-2", [todo("todo-2", "in_progress")]),
        ]),
      "PLAN_STAGE_LOCKED",
    );
    expectPlanError(
      () =>
        createPlan([
          stage("stage-1", [todo("todo-1", "blocked")]),
          stage("stage-2", [todo("todo-2", "completed")]),
        ]),
      "PLAN_STAGE_LOCKED",
    );
  });

  it("preserves started Stage and Todo identity and order", () => {
    const previous = createPlan([
      stage("stage-1", [
        todo("todo-1", "completed"),
        todo("todo-2", "in_progress"),
      ]),
      stage("stage-2", [todo("todo-3", "pending")]),
    ]);
    expectPlanError(
      () =>
        updatePlan(previous, [
          stage("stage-1", [todo("todo-2", "in_progress")]),
          stage("stage-2", [todo("todo-3", "pending")]),
        ]),
      "PLAN_TRANSITION_INVALID",
    );
    expectPlanError(
      () =>
        updatePlan(previous, [
          stage("stage-1", [
            todo("todo-2", "in_progress"),
            todo("todo-1", "completed"),
          ]),
          stage("stage-2", [todo("todo-3", "pending")]),
        ]),
      "PLAN_TRANSITION_INVALID",
    );
    expectPlanError(
      () =>
        updatePlan(previous, [stage("stage-2", [todo("todo-3", "pending")])]),
      "PLAN_TRANSITION_INVALID",
    );
  });

  it("allows replacing pending work before its Stage starts", () => {
    const previous = createPlan([
      stage("stage-1", [todo("todo-old", "pending")]),
    ]);
    const updated = updatePlan(previous, [
      stage("stage-new", [todo("todo-new", "in_progress")]),
    ]);
    expect(updated.stages[0]).toMatchObject({
      id: "stage-new",
      status: "active",
      todos: [{ id: "todo-new", status: "in_progress" }],
    });
  });

  it("requires newly discovered Stages to begin pending after execution starts", () => {
    const previous = createPlan([
      stage("stage-1", [todo("todo-1", "in_progress")]),
    ]);
    expectPlanError(
      () =>
        updatePlan(previous, [
          stage("stage-1", [todo("todo-1", "completed")]),
          stage("stage-new", [todo("todo-new", "in_progress")]),
        ]),
      "PLAN_TRANSITION_INVALID",
    );
    expect(
      updatePlan(previous, [
        stage("stage-1", [todo("todo-1", "completed")]),
        stage("stage-new", [todo("todo-new", "pending")]),
      ]).stages[1]?.status,
    ).toBe("pending");
  });

  it("freezes a started Stage acceptance contract", () => {
    const previous = createPlan([
      stage("stage-1", [todo("todo-1", "in_progress")], {
        requiresAcceptance: true,
        acceptanceCriteria: ["Tests pass."],
      }),
    ]);
    expectPlanError(
      () =>
        updatePlan(previous, [
          stage("stage-1", [todo("todo-1", "in_progress")]),
        ]),
      "PLAN_TRANSITION_INVALID",
    );
  });

  it("requires evidence, resolves acceptance, and keeps accepted Stages immutable", () => {
    const active = createPlan([
      stage("stage-1", [todo("todo-1", "in_progress")], {
        requiresAcceptance: true,
        acceptanceCriteria: ["Tests pass."],
      }),
      stage("stage-2", [todo("todo-2", "pending")]),
    ]);
    expectPlanError(
      () =>
        updatePlan(active, [
          stage("stage-1", [todo("todo-1", "completed")], {
            requiresAcceptance: true,
            acceptanceCriteria: ["Tests pass."],
          }),
          stage("stage-2", [todo("todo-2", "pending")]),
        ]),
      "PLAN_TRANSITION_INVALID",
    );

    const awaiting = updatePlan(active, [
      stage("stage-1", [todo("todo-1", "completed")], {
        requiresAcceptance: true,
        acceptanceCriteria: ["Tests pass."],
        summary: "The first Stage is verified.",
        evidence,
      }),
      stage("stage-2", [todo("todo-2", "pending")]),
    ]);
    expect(awaiting.stages[0]?.status).toBe("awaiting_acceptance");

    const changes = reducePlanAcceptance(
      awaiting,
      acceptance(awaiting, "changes_requested", "Add a recovery test."),
    );
    expect(changes).toMatchObject({
      status: "changes_requested",
      plan: { revision: awaiting.revision },
      feedback: "Add a recovery test.",
    });

    const acceptedResult = reducePlanAcceptance(
      awaiting,
      acceptance(awaiting, "accepted"),
    );
    expect(acceptedResult.status).toBe("accepted");
    if (acceptedResult.status !== "accepted") {
      throw new Error("Expected acceptance.");
    }
    const accepted = acceptedResult.plan;
    expect(accepted).toMatchObject({
      revision: awaiting.revision + 1,
      status: "active",
      stages: [{ status: "accepted" }, { status: "pending" }],
    });

    const continued = updatePlan(accepted, [
      draftFromStage(accepted.stages[0]!),
      stage("stage-2", [todo("todo-2", "in_progress")]),
    ]);
    expect(continued.stages.map((candidate) => candidate.status)).toEqual([
      "accepted",
      "active",
    ]);

    expectPlanError(
      () =>
        updatePlan(accepted, [
          {
            ...draftFromStage(accepted.stages[0]!),
            summary: "Mutated after acceptance.",
          },
          stage("stage-2", [todo("todo-2", "pending")]),
        ]),
      "PLAN_TRANSITION_INVALID",
    );
  });

  it("rejects stale, missing, and duplicate acceptance decisions", () => {
    const awaiting = createPlan([
      stage("stage-1", [todo("todo-1", "completed")], {
        requiresAcceptance: true,
        acceptanceCriteria: ["Tests pass."],
        summary: "Verified.",
        evidence,
      }),
    ]);
    expectPlanError(
      () =>
        reducePlanAcceptance(awaiting, {
          ...acceptance(awaiting, "accepted"),
          planRevision: awaiting.revision + 1,
        }),
      "PLAN_ACCEPTANCE_STALE",
    );
    expectPlanError(
      () =>
        reducePlanAcceptance(awaiting, {
          ...acceptance(awaiting, "accepted"),
          stageId: "stage-missing",
        }),
      "PLAN_ACCEPTANCE_NOT_PENDING",
    );

    const accepted = reducePlanAcceptance(
      awaiting,
      acceptance(awaiting, "accepted"),
    );
    if (accepted.status !== "accepted") {
      throw new Error("Expected acceptance.");
    }
    expectPlanError(
      () =>
        reducePlanAcceptance(
          accepted.plan,
          acceptance(accepted.plan, "accepted"),
        ),
      "PLAN_ACCEPTANCE_NOT_PENDING",
    );
  });

  it("rejects revision, identifier, duplicate, count, and UTF-8 violations", () => {
    const previous = createPlan([
      stage("stage-1", [todo("todo-1", "pending")]),
    ]);
    expectPlanError(
      () =>
        reducePlanUpdate({
          planId,
          previous,
          update: updateDraft(previous.revision + 1, [
            stage("stage-1", [todo("todo-1", "pending")]),
          ]),
        }),
      "PLAN_REVISION_CONFLICT",
    );
    expectPlanError(
      () =>
        reducePlanUpdate({
          planId: planIdSchema.parse("plan:other"),
          previous,
          update: updateDraft(previous.revision, [
            stage("stage-1", [todo("todo-1", "pending")]),
          ]),
        }),
      "PLAN_INVALID",
    );
    expectPlanError(
      () =>
        createPlan([
          stage("stage-1", [todo("todo-duplicate", "pending")]),
          stage("stage-2", [todo("todo-duplicate", "pending")]),
        ]),
      "PLAN_INVALID",
    );
    expectPlanError(
      () =>
        createPlan(
          Array.from({ length: PLAN_MAXIMUM_STAGES + 1 }, (_, index) =>
            stage(`stage-${index}`, [todo(`todo-${index}`, "pending")]),
          ),
        ),
      "PLAN_LIMIT_EXCEEDED",
    );
    expectPlanError(
      () =>
        createPlan(
          Array.from({ length: 5 }, (_, stageIndex) =>
            stage(
              `stage-total-${stageIndex}`,
              Array.from({ length: 64 }, (_, todoIndex) =>
                todo(`todo-total-${stageIndex}-${todoIndex}`, "pending"),
              ),
            ),
          ),
        ),
      "PLAN_LIMIT_EXCEEDED",
    );
    expectPlanError(
      () =>
        reducePlanUpdate({
          planId,
          update: {
            ...updateDraft(0, [stage("stage-1", [todo("todo-1", "pending")])]),
            objective: "界".repeat(6_000),
          },
        }),
      "PLAN_LIMIT_EXCEEDED",
    );
  });

  it("rejects structurally valid snapshots with contradictory aggregate state", () => {
    const previous = createPlan([
      stage("stage-1", [todo("todo-1", "pending")]),
    ]);
    const contradictory = planSnapshotSchema.parse({
      ...previous,
      status: "completed",
    });
    expectPlanError(
      () =>
        reducePlanUpdate({
          planId,
          previous: contradictory,
          update: updateDraft(contradictory.revision, [
            draftFromStage(contradictory.stages[0]!),
          ]),
        }),
      "PLAN_INVALID",
    );
  });
});

function createPlan(stages: readonly PlanStageDraft[]): PlanSnapshot {
  return reducePlanUpdate({
    planId,
    update: updateDraft(0, stages),
  });
}

function updatePlan(
  previous: PlanSnapshot,
  stages: readonly PlanStageDraft[],
): PlanSnapshot {
  return reducePlanUpdate({
    planId,
    previous,
    update: updateDraft(previous.revision, stages),
  });
}

function updateDraft(
  expectedRevision: number,
  stages: readonly PlanStageDraft[],
): PlanUpdateDraft {
  return {
    expectedRevision,
    objective: "Implement durable planning.",
    explanation: "Advance the execution plan.",
    stages: [...stages],
  };
}

function stage(
  id: string,
  todos: readonly PlanTodo[],
  overrides: Partial<Omit<PlanStageDraft, "id" | "title" | "todos">> = {},
): PlanStageDraft {
  return planStageDraftSchema.parse({
    id: planStageIdSchema.parse(id),
    title: `Stage ${id}`,
    requiresAcceptance: false,
    acceptanceCriteria: [],
    evidence: [],
    todos,
    ...overrides,
  });
}

function todo(
  id: string,
  status: PlanTodoStatus,
  overrides: Record<string, string> = {},
): PlanTodo {
  return planTodoSchema.parse({
    id: planTodoIdSchema.parse(id),
    title: `Todo ${id}`,
    status,
    ...(status === "completed" ? { outcome: "Done." } : {}),
    ...(status === "blocked" ? { blockedReason: "Waiting." } : {}),
    ...(status === "cancelled" ? { cancellationReason: "Superseded." } : {}),
    ...overrides,
  });
}

function draftFromStage(stageValue: PlanStage): PlanStageDraft {
  const { status: _status, ...draft } = stageValue;
  return draft;
}

function acceptance(
  plan: PlanSnapshot,
  decision: "accepted" | "changes_requested",
  feedback?: string,
): PlanAcceptanceResolution {
  return planAcceptanceResolutionSchema.parse({
    callId,
    planId: plan.planId,
    planRevision: plan.revision,
    stageId: plan.stages[0]?.id,
    decision,
    ...(feedback === undefined ? {} : { feedback }),
  });
}

function expectPlanError(action: () => unknown, code: PlanErrorCode): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PlanReducerError);
    expect((error as PlanReducerError).code).toBe(code);
    return;
  }
  throw new Error(`Expected PlanReducerError ${code}.`);
}
