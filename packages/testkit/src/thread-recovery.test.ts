import {
  reducePlanAcceptance,
  reducePlanUpdate,
  type EventReadResult,
} from "@koda/agent-core";
import { assertResumeWorkspace, recoverThread } from "@koda/runtime-node";
import {
  agentEventSchema,
  itemIdSchema,
  jsonValueSchema,
  planCheckpointIdSchema,
  planIdSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type AgentEvent,
  type ToolCatalogGenerationSnapshot,
} from "@koda/protocol";
import { describe, expect, it } from "vitest";

const threadId = threadIdSchema.parse("recovery-thread");
const turnId = turnIdSchema.parse("recovery-turn-1");

describe("recoverThread", () => {
  it("rejects a thread with no durable events", () => {
    expect(() => recoverThread(readResult([]), threadId)).toThrowError(
      expect.objectContaining({ code: "THREAD_NOT_FOUND" }),
    );
  });

  it("recovers completed history, context, and the next sequence", () => {
    const events = [
      event(0, "turn.started", {}),
      contextEvent(1),
      recorded(2, {
        type: "user_message",
        id: itemIdSchema.parse("recovery-user"),
        content: "Inspect the repository.",
      }),
      recorded(3, {
        type: "assistant_message",
        id: itemIdSchema.parse("recovery-assistant"),
        content: "Inspection complete.",
      }),
      event(4, "turn.completed", { steps: 1 }),
    ];

    const recovered = recoverThread(readResult(events), threadId);

    expect(recovered).toMatchObject({
      previousTurnId: turnId,
      previousStatus: "completed",
      nextSequence: 5,
      partialTrailingEventDiscarded: false,
      uncertainToolCalls: [],
      context: { workspaceRoot: "/workspace" },
    });
    expect(recovered.history.map((item) => item.type)).toEqual([
      "user_message",
      "assistant_message",
    ]);
    expect(() => assertResumeWorkspace(recovered, "/workspace")).not.toThrow();
    expect(() => assertResumeWorkspace(recovered, "/other")).toThrowError(
      expect.objectContaining({ code: "THREAD_WORKSPACE_MISMATCH" }),
    );
  });

  it("recovers the final durable tool catalog generation", () => {
    const first = catalogGeneration("1", 2);
    const second = catalogGeneration("2", 2);
    const events = [
      event(0, "turn.started", {}),
      contextEvent(1, first),
      event(2, "tool.catalog_changed", {
        step: 2,
        previous: first,
        current: second,
        changes: [
          {
            name: "mcp__fixture__value",
            change: "changed",
            beforeSha256: "3".repeat(64),
            afterSha256: "4".repeat(64),
          },
        ],
      }),
      event(3, "turn.completed", { steps: 2 }),
    ];

    expect(recoverThread(readResult(events), threadId).context).toMatchObject({
      toolCatalogGeneration: second,
    });
  });

  it("rejects catalog changes that do not chain from the governing generation", () => {
    const first = catalogGeneration("1", 1);
    const unrelated = catalogGeneration("9", 1);
    const second = catalogGeneration("2", 1);
    const events = [
      event(0, "turn.started", {}),
      contextEvent(1, first),
      event(2, "tool.catalog_changed", {
        step: 2,
        previous: unrelated,
        current: second,
        changes: [
          {
            name: "mcp__fixture__value",
            change: "changed",
            beforeSha256: "3".repeat(64),
            afterSha256: "4".repeat(64),
          },
        ],
      }),
      event(3, "turn.completed", { steps: 2 }),
    ];

    expect(() => recoverThread(readResult(events), threadId)).toThrowError(
      expect.objectContaining({ code: "THREAD_LOG_INVALID" }),
    );
  });

  it("marks an interrupted unfinished tool call uncertain and omits it from replay", () => {
    const callId = toolCallIdSchema.parse("uncertain-call");
    const events = [
      event(0, "turn.started", {}),
      contextEvent(1),
      recorded(2, {
        type: "user_message",
        id: itemIdSchema.parse("interrupted-user"),
        content: "Run validation.",
      }),
      recorded(3, {
        type: "tool_call",
        id: itemIdSchema.parse("interrupted-call-item"),
        callId,
        name: "exec_command",
        arguments: { argv: ["pnpm", "test"] },
      }),
      event(4, "tool.started", { callId, name: "exec_command" }),
    ];

    const recovered = recoverThread(readResult(events, true), threadId);

    expect(recovered.previousStatus).toBe("interrupted");
    expect(recovered.history.map((item) => item.type)).toEqual([
      "user_message",
    ]);
    expect(recovered.uncertainToolCalls).toEqual([
      { callId, name: "exec_command" },
    ]);
    expect(recovered.message).toContain("must not be assumed successful");
    expect(recovered.message).toContain("partial trailing event");
  });

  it("does not claim a new-format tool crossed the side-effect boundary before execution", () => {
    const callId = toolCallIdSchema.parse("pre-execution-call");
    const events = [
      event(0, "turn.started", {}),
      contextEvent(1),
      recorded(2, {
        type: "user_message",
        id: itemIdSchema.parse("pre-execution-user"),
        content: "Update the file.",
      }),
      recorded(3, {
        type: "tool_call",
        id: itemIdSchema.parse("pre-execution-call-item"),
        callId,
        name: "apply_patch",
        arguments: {},
      }),
      event(4, "tool.started", {
        callId,
        name: "apply_patch",
        executionBoundary: true,
      }),
    ];

    const recovered = recoverThread(readResult(events), threadId);

    expect(recovered.uncertainToolCalls).toEqual([]);
  });

  it("reports an interrupted write after its durable execution boundary", () => {
    const callId = toolCallIdSchema.parse("uncertain-write-call");
    const events = [
      event(0, "turn.started", {}),
      contextEvent(1),
      recorded(2, {
        type: "tool_call",
        id: itemIdSchema.parse("uncertain-write-item"),
        callId,
        name: "apply_patch",
        arguments: {},
      }),
      event(3, "tool.started", {
        callId,
        name: "apply_patch",
        executionBoundary: true,
      }),
      event(4, "tool.execution_started", {
        callId,
        name: "apply_patch",
        effect: "write",
      }),
    ];

    const recovered = recoverThread(readResult(events), threadId);

    expect(recovered.uncertainToolCalls).toEqual([
      { callId, name: "apply_patch", effect: "write" },
    ]);
    expect(recovered.message).toContain("effect write");
  });

  it("recovers a safely paused Plan and its latest checkpoint", () => {
    const setup = durablePlanSetup();
    const pauseCheckpointId = planCheckpointIdSchema.parse("checkpoint:pause");
    const events = [
      ...setup.events,
      event(10, "plan.checkpointed", {
        checkpoint: {
          checkpointId: pauseCheckpointId,
          planId: setup.plan.planId,
          planRevision: setup.plan.revision,
          activeStageId: setup.plan.stages[0]?.id,
          activeTodoId: setup.plan.stages[0]?.todos[0]?.id,
          lastSafeSequence: 9,
          reason: "safe_pause",
          nextAction: "Write the code",
          evidence: [],
        },
      }),
      event(11, "turn.paused", {
        reason: "step_budget",
        checkpointId: pauseCheckpointId,
      }),
    ];

    const recovered = recoverThread(readResult(events), threadId);

    expect(recovered).toMatchObject({
      previousStatus: "paused",
      plan: { planId: setup.plan.planId, revision: 1 },
      checkpoint: {
        checkpointId: pauseCheckpointId,
        reason: "safe_pause",
      },
      planNeedsRevalidation: false,
    });
  });

  it("rejects a forged Plan revision and an invalid checkpoint boundary", () => {
    const setup = durablePlanSetup();
    const forged = {
      ...setup.plan,
      revision: 2,
    };
    const forgedEvents = setup.events.map((candidate) =>
      candidate.type === "plan.updated"
        ? event(candidate.sequence, "plan.updated", {
            ...candidate.payload,
            plan: forged,
          })
        : candidate,
    );
    expect(() =>
      recoverThread(readResult(forgedEvents), threadId),
    ).toThrowError(expect.objectContaining({ code: "THREAD_LOG_INVALID" }));

    const invalidBoundary = [
      ...setup.events,
      event(10, "plan.checkpointed", {
        checkpoint: {
          checkpointId: planCheckpointIdSchema.parse("checkpoint:invalid"),
          planId: setup.plan.planId,
          planRevision: setup.plan.revision,
          activeStageId: setup.plan.stages[0]?.id,
          activeTodoId: setup.plan.stages[0]?.todos[0]?.id,
          lastSafeSequence: 99,
          reason: "safe_pause",
          evidence: [],
        },
      }),
    ];
    expect(() =>
      recoverThread(readResult(invalidBoundary), threadId),
    ).toThrowError(expect.objectContaining({ code: "THREAD_LOG_INVALID" }));
  });

  it("recovers an exact accepted Stage lifecycle", () => {
    const setup = durableAcceptedPlanSetup();

    const recovered = recoverThread(readResult(setup.events), threadId);

    expect(recovered).toMatchObject({
      previousStatus: "completed",
      plan: {
        planId: setup.acceptedPlan.planId,
        revision: 2,
        status: "completed",
        stages: [{ id: setup.stageId, status: "accepted" }],
      },
      checkpoint: { planRevision: 2, reason: "turn_completion" },
      planNeedsRevalidation: false,
    });
  });

  it("rejects stale, unmatched, and duplicate Stage acceptance audit events", () => {
    const setup = durableAcceptedPlanSetup();
    const staleResolution = setup.events.map((candidate) =>
      candidate.type === "plan.acceptance_resolved"
        ? event(candidate.sequence, "plan.acceptance_resolved", {
            ...candidate.payload,
            planRevision: candidate.payload.planRevision + 1,
          })
        : candidate,
    );
    expect(() =>
      recoverThread(readResult(staleResolution), threadId),
    ).toThrowError(expect.objectContaining({ code: "THREAD_LOG_INVALID" }));

    const request = setup.events.find(
      (candidate) => candidate.type === "plan.acceptance_requested",
    );
    if (request?.type !== "plan.acceptance_requested") {
      throw new Error("Accepted Plan fixture has no acceptance request.");
    }
    const duplicateRequest = setup.events.map((candidate) =>
      candidate.type === "plan.acceptance_resolved"
        ? event(
            candidate.sequence,
            "plan.acceptance_requested",
            request.payload,
          )
        : candidate,
    );
    expect(() =>
      recoverThread(readResult(duplicateRequest), threadId),
    ).toThrowError(expect.objectContaining({ code: "THREAD_LOG_INVALID" }));

    const acceptedWithoutRuntimeUpdate = [
      ...setup.events.slice(0, 9),
      event(9, "tool.completed", {
        callId: toolCallIdSchema.parse("accepted-plan-call"),
        name: "update_plan",
        status: "success",
      }),
    ];
    expect(() =>
      recoverThread(readResult(acceptedWithoutRuntimeUpdate), threadId),
    ).toThrowError(expect.objectContaining({ code: "THREAD_LOG_INVALID" }));
  });

  it("marks an interrupted write after the last Plan checkpoint for revalidation", () => {
    const setup = durablePlanSetup();
    const writeCallId = toolCallIdSchema.parse("write-after-checkpoint");
    const events = [
      ...setup.events,
      recorded(10, {
        type: "tool_call",
        id: itemIdSchema.parse("write-after-checkpoint-item"),
        callId: writeCallId,
        name: "apply_patch",
        arguments: {},
      }),
      event(11, "tool.started", {
        callId: writeCallId,
        name: "apply_patch",
        executionBoundary: true,
      }),
      event(12, "tool.execution_started", {
        callId: writeCallId,
        name: "apply_patch",
        effect: "write",
      }),
    ];

    const recovered = recoverThread(readResult(events), threadId);

    expect(recovered.previousStatus).toBe("interrupted");
    expect(recovered.planNeedsRevalidation).toBe(true);
    expect(recovered.message).toContain("revalidation");
  });

  it("classifies incomplete and durably committed change sets without replay", () => {
    const callId = toolCallIdSchema.parse("recovery-change-set-call");
    const base = [
      event(0, "turn.started", {}),
      contextEvent(1),
      recorded(2, {
        type: "tool_call",
        id: itemIdSchema.parse("recovery-change-set-item"),
        callId,
        name: "apply_patchset",
        arguments: { patch: "*** Begin Patch\n*** End Patch" },
      }),
      event(3, "tool.started", {
        callId,
        name: "apply_patchset",
        executionBoundary: true,
      }),
      event(4, "tool.execution_started", {
        callId,
        name: "apply_patchset",
        effect: "write",
      }),
      event(5, "workspace.change_set_prepared", {
        callId,
        name: "apply_patchset",
        planSha256: "a".repeat(64),
        changes: [changeEvidence()],
      }),
    ];

    const incomplete = recoverThread(readResult(base), threadId);
    expect(incomplete.workspaceChangeSets).toEqual([
      {
        planSha256: "a".repeat(64),
        status: "incomplete",
        paths: ["README.md"],
      },
    ]);
    expect(incomplete.message).toContain("Do not automatically repeat");

    const committed = recoverThread(
      readResult([
        ...base,
        event(6, "workspace.change_set_committed", {
          callId,
          name: "apply_patchset",
          planSha256: "a".repeat(64),
          changeCount: 1,
        }),
      ]),
      threadId,
    );
    expect(committed.workspaceChangeSets).toEqual([
      expect.objectContaining({ status: "committed" }),
    ]);
  });

  it("retains explicit uncertain change-set evidence after tool completion", () => {
    const callId = toolCallIdSchema.parse("uncertain-change-set-call");
    const events = [
      event(0, "turn.started", {}),
      contextEvent(1),
      event(2, "tool.started", {
        callId,
        name: "apply_changes",
        executionBoundary: true,
      }),
      event(3, "tool.execution_started", {
        callId,
        name: "apply_changes",
        effect: "write",
      }),
      event(4, "workspace.change_set_prepared", {
        callId,
        name: "apply_changes",
        planSha256: "b".repeat(64),
        changes: [changeEvidence()],
      }),
      event(5, "workspace.change_set_uncertain", {
        callId,
        name: "apply_changes",
        planSha256: "b".repeat(64),
        appliedCount: 1,
        uncertainPaths: ["README.md"],
        errorCode: "WORKSPACE_CHANGED",
      }),
      event(6, "tool.completed", {
        callId,
        name: "apply_changes",
        status: "error",
      }),
    ];

    const recovered = recoverThread(readResult(events), threadId);

    expect(recovered.uncertainToolCalls).toEqual([]);
    expect(recovered.workspaceChangeSets).toEqual([
      {
        planSha256: "b".repeat(64),
        status: "uncertain",
        paths: ["README.md"],
      },
    ]);

    const resolved = recoverThread(
      readResult([
        ...events,
        event(7, "workspace.change_set_resolved", {
          callId,
          name: "apply_changes",
          planSha256: "b".repeat(64),
          resolution: "accepted_current",
          stateToken: "c".repeat(64),
        }),
      ]),
      threadId,
    );
    expect(resolved.workspaceChangeSets).toEqual([]);
  });

  it("recovers an interrupted external MCP call without replaying it", () => {
    const callId = toolCallIdSchema.parse("uncertain-mcp-call");
    const name = "mcp__github__create_issue";
    const events = [
      event(0, "turn.started", {}),
      contextEvent(1),
      recorded(2, {
        type: "tool_call",
        id: itemIdSchema.parse("uncertain-mcp-item"),
        callId,
        name,
        arguments: { title: "Investigate" },
      }),
      event(3, "tool.started", {
        callId,
        name,
        executionBoundary: true,
      }),
      event(4, "tool.execution_started", {
        callId,
        name,
        effect: "execute",
      }),
    ];

    const recovered = recoverThread(readResult(events), threadId);

    expect(recovered.history).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ callId })]),
    );
    expect(recovered.uncertainToolCalls).toEqual([
      { callId, name, effect: "execute" },
    ]);
    expect(recovered.message).toContain("must not be assumed successful");
  });

  it.each([
    [
      "exited" as const,
      [
        event(6, "process.exited", {
          callId: toolCallIdSchema.parse("uncertain-process-call"),
          name: "exec_command",
          pid: 4321,
          exitCode: 0,
          signal: null,
        }),
      ],
    ],
    [
      "terminated" as const,
      [
        event(6, "process.termination_requested", {
          callId: toolCallIdSchema.parse("uncertain-process-call"),
          name: "exec_command",
          pid: 4321,
          reason: "cancellation",
          attempt: "graceful",
          mechanism: "posix_process_group_signal",
        }),
        event(7, "process.termination_completed", {
          callId: toolCallIdSchema.parse("uncertain-process-call"),
          name: "exec_command",
          pid: 4321,
          reason: "cancellation",
          outcome: "terminated",
        }),
      ],
    ],
    [
      "uncertain" as const,
      [
        event(6, "process.termination_requested", {
          callId: toolCallIdSchema.parse("uncertain-process-call"),
          name: "exec_command",
          pid: 4321,
          reason: "timeout",
          attempt: "force",
          mechanism: "posix_process_group_signal",
        }),
        event(7, "process.termination_completed", {
          callId: toolCallIdSchema.parse("uncertain-process-call"),
          name: "exec_command",
          pid: 4321,
          reason: "timeout",
          outcome: "uncertain",
        }),
      ],
    ],
  ])(
    "recovers an incomplete command with process status %s",
    (status, tail) => {
      const callId = toolCallIdSchema.parse("uncertain-process-call");
      const events = [
        event(0, "turn.started", {}),
        contextEvent(1),
        recorded(2, {
          type: "tool_call",
          id: itemIdSchema.parse("uncertain-process-item"),
          callId,
          name: "exec_command",
          arguments: { argv: ["node", "--version"] },
        }),
        event(3, "tool.started", {
          callId,
          name: "exec_command",
          executionBoundary: true,
        }),
        event(4, "tool.execution_started", {
          callId,
          name: "exec_command",
          effect: "execute",
        }),
        event(5, "process.started", {
          callId,
          name: "exec_command",
          pid: 4321,
          ownership: "posix_process_group",
        }),
        ...tail,
      ];

      const recovered = recoverThread(readResult(events), threadId);

      expect(recovered.uncertainToolCalls).toEqual([
        expect.objectContaining({
          callId,
          name: "exec_command",
          effect: "execute",
          process: expect.objectContaining({ pid: 4321, status }),
        }),
      ]);
      expect(recovered.message).toContain(`process 4321 ${status}`);
    },
  );

  it("rejects process lifecycle events without an execute boundary", () => {
    const callId = toolCallIdSchema.parse("invalid-process-order-call");
    const events = [
      event(0, "turn.started", {}),
      contextEvent(1),
      event(2, "tool.started", {
        callId,
        name: "exec_command",
        executionBoundary: true,
      }),
      event(3, "process.started", {
        callId,
        name: "exec_command",
        pid: 6789,
        ownership: "posix_process_group",
      }),
    ];

    expect(() => recoverThread(readResult(events), threadId)).toThrowError(
      expect.objectContaining({ code: "THREAD_LOG_INVALID" }),
    );
  });

  it("rejects a completed tool with an unfinished process lifecycle", () => {
    const callId = toolCallIdSchema.parse("invalid-finished-process-call");
    const events = [
      event(0, "turn.started", {}),
      contextEvent(1),
      event(2, "tool.started", {
        callId,
        name: "exec_command",
        executionBoundary: true,
      }),
      event(3, "tool.execution_started", {
        callId,
        name: "exec_command",
        effect: "execute",
      }),
      event(4, "process.started", {
        callId,
        name: "exec_command",
        pid: 9876,
        ownership: "posix_process_group",
      }),
      event(5, "tool.completed", {
        callId,
        name: "exec_command",
        status: "success",
      }),
    ];

    expect(() => recoverThread(readResult(events), threadId)).toThrowError(
      expect.objectContaining({ code: "THREAD_LOG_INVALID" }),
    );
  });

  it("rejects mismatched process termination reasons", () => {
    const callId = toolCallIdSchema.parse("invalid-termination-reason-call");
    const events = [
      event(0, "turn.started", {}),
      contextEvent(1),
      event(2, "tool.started", {
        callId,
        name: "exec_command",
        executionBoundary: true,
      }),
      event(3, "tool.execution_started", {
        callId,
        name: "exec_command",
        effect: "execute",
      }),
      event(4, "process.started", {
        callId,
        name: "exec_command",
        pid: 2468,
        ownership: "posix_process_group",
      }),
      event(5, "process.termination_requested", {
        callId,
        name: "exec_command",
        pid: 2468,
        reason: "timeout",
        attempt: "graceful",
        mechanism: "posix_process_group_signal",
      }),
      event(6, "process.termination_completed", {
        callId,
        name: "exec_command",
        pid: 2468,
        reason: "cancellation",
        outcome: "terminated",
      }),
    ];

    expect(() => recoverThread(readResult(events), threadId)).toThrowError(
      expect.objectContaining({ code: "THREAD_LOG_INVALID" }),
    );
  });

  it.each([
    [
      "turn.failed" as const,
      { code: "MODEL_ERROR", message: "failed" },
      "failed",
    ],
    ["turn.cancelled" as const, { reason: "cancelled" }, "cancelled"],
  ])("recovers a %s terminal turn as %s", (type, payload, status) => {
    const events = [
      event(0, "turn.started", {}),
      contextEvent(1),
      event(2, type, payload),
    ];

    expect(recoverThread(readResult(events), threadId).previousStatus).toBe(
      status,
    );
  });

  it("rejects logs without context and mismatched thread IDs", () => {
    expect(() =>
      recoverThread(
        readResult([
          event(0, "turn.started", {}),
          event(1, "turn.completed", { steps: 1 }),
        ]),
        threadId,
      ),
    ).toThrowError(expect.objectContaining({ code: "THREAD_CONTEXT_MISSING" }));

    const otherThreadEvent = agentEventSchema.parse({
      ...event(0, "turn.started", {}),
      threadId: threadIdSchema.parse("other-thread"),
    });
    expect(() =>
      recoverThread(readResult([otherThreadEvent]), threadId),
    ).toThrowError(expect.objectContaining({ code: "THREAD_ID_MISMATCH" }));
  });

  it("rejects an unmatched tool call in a completed turn", () => {
    const callId = toolCallIdSchema.parse("invalid-complete-call");
    const events = [
      event(0, "turn.started", {}),
      contextEvent(1),
      recorded(2, {
        type: "tool_call",
        id: itemIdSchema.parse("invalid-complete-item"),
        callId,
        name: "apply_patch",
        arguments: {},
      }),
      event(3, "tool.started", { callId, name: "apply_patch" }),
      event(4, "turn.completed", { steps: 1 }),
    ];

    expect(() => recoverThread(readResult(events), threadId)).toThrowError(
      expect.objectContaining({ code: "THREAD_LOG_INVALID" }),
    );
  });

  it("recovers an append-only context compaction with retained history", () => {
    const latestUserId = itemIdSchema.parse("compaction-latest-user");
    const events = [
      event(0, "turn.started", {}),
      contextEvent(1),
      recorded(2, {
        type: "user_message",
        id: itemIdSchema.parse("compaction-old-user"),
        content: "Old objective.",
      }),
      recorded(3, {
        type: "assistant_message",
        id: itemIdSchema.parse("compaction-old-assistant"),
        content: "Old conclusion.",
      }),
      recorded(4, {
        type: "user_message",
        id: latestUserId,
        content: "Current objective.",
      }),
      recorded(5, {
        type: "compaction",
        id: itemIdSchema.parse("compaction-state"),
        reason: "context_budget",
        retainedItemIds: [latestUserId],
        estimatedTokensBefore: 1_000,
        estimatedTokensAfter: 300,
        summary: compactionSummary(),
      }),
      event(6, "turn.completed", { steps: 1 }),
    ];

    const recovered = recoverThread(readResult(events), threadId);

    expect(recovered.history.map((item) => item.type)).toEqual([
      "user_message",
      "assistant_message",
      "user_message",
      "compaction",
    ]);
  });

  it.each([
    ["unknown", [itemIdSchema.parse("missing-item")]],
    [
      "duplicated",
      [
        itemIdSchema.parse("invalid-compaction-user"),
        itemIdSchema.parse("invalid-compaction-user"),
      ],
    ],
    ["drops latest user", [itemIdSchema.parse("invalid-old-user")]],
  ])("rejects a compaction with %s retained IDs", (_case, retainedItemIds) => {
    const events = [
      event(0, "turn.started", {}),
      contextEvent(1),
      recorded(2, {
        type: "user_message",
        id: itemIdSchema.parse("invalid-old-user"),
        content: "Old.",
      }),
      recorded(3, {
        type: "user_message",
        id: itemIdSchema.parse("invalid-compaction-user"),
        content: "Newest.",
      }),
      recorded(4, {
        type: "compaction",
        id: itemIdSchema.parse("invalid-compaction-state"),
        reason: "context_budget",
        retainedItemIds,
        estimatedTokensBefore: 1_000,
        estimatedTokensAfter: 300,
        summary: compactionSummary(),
      }),
      event(5, "turn.completed", { steps: 1 }),
    ];

    expect(() => recoverThread(readResult(events), threadId)).toThrowError(
      expect.objectContaining({ code: "THREAD_LOG_INVALID" }),
    );
  });

  it("rejects a compaction that retains only part of a tool group", () => {
    const callId = toolCallIdSchema.parse("partial-compaction-call");
    const callItemId = itemIdSchema.parse("partial-compaction-call-item");
    const latestUserId = itemIdSchema.parse("partial-compaction-user");
    const events = [
      event(0, "turn.started", {}),
      contextEvent(1),
      recorded(2, {
        type: "user_message",
        id: itemIdSchema.parse("partial-compaction-old-user"),
        content: "Inspect.",
      }),
      recorded(3, {
        type: "tool_call",
        id: callItemId,
        callId,
        name: "read_file",
        arguments: { path: "README.md" },
      }),
      recorded(4, {
        type: "tool_result",
        id: itemIdSchema.parse("partial-compaction-result-item"),
        callId,
        name: "read_file",
        status: "success",
        output: { content: "# Koda" },
      }),
      recorded(5, {
        type: "user_message",
        id: latestUserId,
        content: "Continue.",
      }),
      recorded(6, {
        type: "compaction",
        id: itemIdSchema.parse("partial-compaction-state"),
        reason: "context_budget",
        retainedItemIds: [callItemId, latestUserId],
        estimatedTokensBefore: 1_000,
        estimatedTokensAfter: 300,
        summary: compactionSummary(),
      }),
      event(7, "turn.completed", { steps: 1 }),
    ];

    expect(() => recoverThread(readResult(events), threadId)).toThrowError(
      expect.objectContaining({ code: "THREAD_LOG_INVALID" }),
    );
  });

  it("rejects a compaction that drops provider state but retains its tool step", () => {
    const callId = toolCallIdSchema.parse("partial-state-call");
    const latestUserId = itemIdSchema.parse("partial-state-user");
    const callItemId = itemIdSchema.parse("partial-state-call-item");
    const resultItemId = itemIdSchema.parse("partial-state-result-item");
    const events = [
      event(0, "turn.started", {}),
      contextEvent(1),
      recorded(2, {
        type: "user_message",
        id: latestUserId,
        content: "Inspect with provider state.",
      }),
      recorded(3, {
        type: "provider_state",
        id: itemIdSchema.parse("partial-provider-state"),
        provider: "deepseek",
        data: { reasoning_content: "inspect first" },
      }),
      recorded(4, {
        type: "tool_call",
        id: callItemId,
        callId,
        name: "read_file",
        arguments: { path: "README.md" },
      }),
      recorded(5, {
        type: "tool_result",
        id: resultItemId,
        callId,
        name: "read_file",
        status: "success",
        output: { content: "# Koda" },
      }),
      recorded(6, {
        type: "compaction",
        id: itemIdSchema.parse("partial-state-compaction"),
        reason: "context_budget",
        retainedItemIds: [latestUserId, callItemId, resultItemId],
        estimatedTokensBefore: 1_000,
        estimatedTokensAfter: 300,
        summary: compactionSummary(),
      }),
      event(7, "turn.completed", { steps: 1 }),
    ];

    expect(() => recoverThread(readResult(events), threadId)).toThrowError(
      expect.objectContaining({ code: "THREAD_LOG_INVALID" }),
    );
  });

  it("validates durable grant creation evidence without restoring session grants", () => {
    const callId = toolCallIdSchema.parse("recovery-grant-call");
    const grantId = "grant:recovery";
    const events = [
      event(0, "turn.started", {}),
      contextEvent(1),
      event(2, "tool.started", {
        callId,
        name: "exec_command",
        executionBoundary: true,
      }),
      event(3, "approval.requested", {
        callId,
        name: "exec_command",
        title: "Run command",
        summary: "Run exact command",
        details: 'argv: ["pnpm","test"]',
        reason: "process execution",
        grantCandidate: {
          kind: "exact_command",
          key: "a".repeat(64),
          summary: 'argv: ["pnpm","test"]',
          defaultExpiresInSeconds: 900,
          maximumExpiresInSeconds: 3600,
        },
      }),
      event(4, "approval.resolved", {
        callId,
        decision: "approved",
        grantId,
      }),
      event(5, "approval.grant_created", {
        callId,
        grant: {
          id: grantId,
          kind: "exact_command",
          toolName: "exec_command",
          workspaceRoot: "/workspace",
          key: "a".repeat(64),
          summary: 'argv: ["pnpm","test"]',
          createdAt: "2026-08-25T23:59:59.000Z",
          expiresAt: "2026-08-26T00:15:00.000Z",
          uses: 0,
        },
      }),
      event(6, "tool.execution_started", {
        callId,
        name: "exec_command",
        effect: "execute",
      }),
      event(7, "tool.completed", {
        callId,
        name: "exec_command",
        status: "success",
      }),
      event(8, "turn.completed", { steps: 1 }),
    ];

    const recovered = recoverThread(readResult(events), threadId);
    expect(recovered.previousStatus).toBe("completed");
    expect(recovered).not.toHaveProperty("approvalGrants");
  });

  it("rejects execution when a grant-bearing resolution lacks creation audit", () => {
    const callId = toolCallIdSchema.parse("missing-grant-audit-call");
    const events = [
      event(0, "turn.started", {}),
      contextEvent(1),
      event(2, "tool.started", {
        callId,
        name: "exec_command",
        executionBoundary: true,
      }),
      event(3, "approval.requested", {
        callId,
        name: "exec_command",
        title: "Run command",
        summary: "Run exact command",
        details: 'argv: ["pnpm","test"]',
        reason: "process execution",
      }),
      event(4, "approval.resolved", {
        callId,
        decision: "approved",
        grantId: "grant:missing",
      }),
      event(5, "tool.execution_started", {
        callId,
        name: "exec_command",
        effect: "execute",
      }),
    ];

    expect(() => recoverThread(readResult(events), threadId)).toThrowError(
      expect.objectContaining({ code: "THREAD_LOG_INVALID" }),
    );
  });
});

function compactionSummary() {
  return {
    objective: "Current objective.",
    decisions: [],
    modifiedFiles: [],
    completedWork: [],
    pendingWork: ["Current objective."],
    failedAttempts: [],
    criticalFacts: [],
  };
}

function changeEvidence() {
  return {
    index: 0,
    operation: "update" as const,
    path: "README.md",
    beforeSha256: "c".repeat(64),
    afterSha256: "d".repeat(64),
    bytes: 10,
  };
}

function contextEvent(
  sequence: number,
  toolCatalogGeneration?: ToolCatalogGenerationSnapshot,
): AgentEvent {
  return event(sequence, "turn.context", {
    provider: "openai",
    model: "test-model",
    workspaceRoot: "/workspace",
    approvalMode: "on-request",
    instructionsSha256: "a".repeat(64),
    repositoryInstructions: [],
    skills: [],
    commandTemplates: [],
    plugins: [],
    ...(toolCatalogGeneration === undefined ? {} : { toolCatalogGeneration }),
  });
}

function catalogGeneration(
  character: string,
  toolCount: number,
): ToolCatalogGenerationSnapshot {
  return {
    generationId: `tool-catalog:${character.repeat(64)}`,
    toolCount,
    toolsSha256: character.repeat(64),
  };
}

function durableAcceptedPlanSetup() {
  const callId = toolCallIdSchema.parse("accepted-plan-call");
  const stageId = "stage-accepted";
  const awaitingPlan = reducePlanUpdate({
    planId: planIdSchema.parse("plan:accepted"),
    update: {
      expectedRevision: 0,
      objective: "Finish accepted planning",
      stages: [
        {
          id: stageId,
          title: "Verify the implementation",
          requiresAcceptance: true,
          acceptanceCriteria: ["Regression tests pass"],
          summary: "Implementation and tests are complete.",
          evidence: [{ kind: "tool_call", callId }],
          todos: [
            {
              id: "todo-accepted",
              title: "Implement and test",
              status: "completed",
              outcome: "Implemented with passing tests.",
            },
          ],
        },
      ],
    },
  });
  const accepted = reducePlanAcceptance(awaitingPlan, {
    callId,
    planId: awaitingPlan.planId,
    planRevision: awaitingPlan.revision,
    stageId: awaitingPlan.stages[0]!.id,
    decision: "accepted",
  });
  if (accepted.status !== "accepted") {
    throw new Error("Accepted Plan fixture did not reach accepted state.");
  }
  const requestPayload = {
    callId,
    planId: awaitingPlan.planId,
    planRevision: awaitingPlan.revision,
    stageId: awaitingPlan.stages[0]!.id,
    criteria: awaitingPlan.stages[0]!.acceptanceCriteria,
    summary: awaitingPlan.stages[0]!.summary!,
    evidence: awaitingPlan.stages[0]!.evidence,
  };
  return {
    stageId,
    acceptedPlan: accepted.plan,
    events: [
      event(0, "turn.started", {}),
      contextEvent(1),
      recorded(2, {
        type: "tool_call",
        id: itemIdSchema.parse("accepted-plan-item"),
        callId,
        name: "update_plan",
        arguments: {},
      }),
      event(3, "tool.started", {
        callId,
        name: "update_plan",
        executionBoundary: true,
      }),
      event(4, "tool.execution_started", {
        callId,
        name: "update_plan",
        effect: "control",
      }),
      event(5, "plan.updated", {
        callId,
        source: "model_update",
        plan: awaitingPlan,
      }),
      event(6, "plan.checkpointed", {
        checkpoint: {
          checkpointId: planCheckpointIdSchema.parse(
            "checkpoint:awaiting-acceptance",
          ),
          planId: awaitingPlan.planId,
          planRevision: awaitingPlan.revision,
          activeStageId: awaitingPlan.stages[0]!.id,
          lastSafeSequence: 5,
          reason: "plan_update",
          evidence: [{ kind: "event", sequence: 5 }],
        },
      }),
      event(7, "plan.acceptance_requested", requestPayload),
      event(8, "plan.acceptance_resolved", {
        callId,
        planId: awaitingPlan.planId,
        planRevision: awaitingPlan.revision,
        stageId: awaitingPlan.stages[0]!.id,
        decision: "accepted",
      }),
      event(9, "plan.updated", {
        callId,
        source: "runtime_acceptance",
        plan: accepted.plan,
      }),
      event(10, "plan.checkpointed", {
        checkpoint: {
          checkpointId: planCheckpointIdSchema.parse(
            "checkpoint:stage-accepted",
          ),
          planId: accepted.plan.planId,
          planRevision: accepted.plan.revision,
          lastSafeSequence: 9,
          reason: "stage_acceptance",
          evidence: [{ kind: "event", sequence: 9 }],
        },
      }),
      recorded(11, {
        type: "tool_result",
        id: itemIdSchema.parse("accepted-plan-result"),
        callId,
        name: "update_plan",
        status: "success",
        output: jsonValueSchema.parse({
          plan: accepted.plan,
          acceptance: { status: "accepted" },
        }),
      }),
      event(12, "tool.completed", {
        callId,
        name: "update_plan",
        status: "success",
      }),
      event(13, "plan.checkpointed", {
        checkpoint: {
          checkpointId: planCheckpointIdSchema.parse(
            "checkpoint:accepted-turn",
          ),
          planId: accepted.plan.planId,
          planRevision: accepted.plan.revision,
          lastSafeSequence: 12,
          reason: "turn_completion",
          evidence: [],
        },
      }),
      event(14, "turn.completed", { steps: 1 }),
    ],
  };
}

function durablePlanSetup() {
  const callId = toolCallIdSchema.parse("durable-plan-call");
  const plan = reducePlanUpdate({
    planId: planIdSchema.parse("plan:durable"),
    update: {
      expectedRevision: 0,
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
    },
  });
  return {
    plan,
    events: [
      event(0, "turn.started", {}),
      contextEvent(1),
      recorded(2, {
        type: "user_message",
        id: itemIdSchema.parse("durable-plan-user"),
        content: "Create a plan.",
      }),
      recorded(3, {
        type: "tool_call",
        id: itemIdSchema.parse("durable-plan-item"),
        callId,
        name: "update_plan",
        arguments: {},
      }),
      event(4, "tool.started", {
        callId,
        name: "update_plan",
        executionBoundary: true,
      }),
      event(5, "tool.execution_started", {
        callId,
        name: "update_plan",
        effect: "control",
      }),
      event(6, "plan.updated", {
        callId,
        source: "model_update",
        plan,
      }),
      event(7, "plan.checkpointed", {
        checkpoint: {
          checkpointId: planCheckpointIdSchema.parse("checkpoint:plan-update"),
          planId: plan.planId,
          planRevision: plan.revision,
          activeStageId: plan.stages[0]?.id,
          activeTodoId: plan.stages[0]?.todos[0]?.id,
          lastSafeSequence: 6,
          reason: "plan_update",
          nextAction: "Write the code",
          evidence: [
            { kind: "event", sequence: 6 },
            { kind: "tool_call", callId },
          ],
        },
      }),
      recorded(8, {
        type: "tool_result",
        id: itemIdSchema.parse("durable-plan-result"),
        callId,
        name: "update_plan",
        status: "success",
        output: jsonValueSchema.parse({ plan }),
      }),
      event(9, "tool.completed", {
        callId,
        name: "update_plan",
        status: "success",
      }),
    ],
  };
}

function recorded(
  sequence: number,
  item: Extract<AgentEvent, { type: "item.recorded" }>["payload"]["item"],
): AgentEvent {
  return event(sequence, "item.recorded", { item });
}

function event<Type extends AgentEvent["type"]>(
  sequence: number,
  type: Type,
  payload: Extract<AgentEvent, { type: Type }>["payload"],
): AgentEvent {
  return agentEventSchema.parse({
    schemaVersion: 1,
    sequence,
    timestamp: "2026-08-26T00:00:00.000Z",
    threadId,
    turnId,
    type,
    payload,
  });
}

function readResult(
  events: AgentEvent[],
  partialTrailingLine = false,
): EventReadResult {
  return {
    events,
    diagnostics: partialTrailingLine
      ? [
          {
            code: "PARTIAL_TRAILING_LINE",
            message: "Ignored partial tail.",
            line: events.length + 1,
          },
        ]
      : [],
  };
}
