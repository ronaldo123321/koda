import type { EventReadResult } from "@koda/agent-core";
import { assertResumeWorkspace, recoverThread } from "@koda/runtime-node";
import {
  agentEventSchema,
  itemIdSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type AgentEvent,
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

function contextEvent(sequence: number): AgentEvent {
  return event(sequence, "turn.context", {
    provider: "openai",
    model: "test-model",
    workspaceRoot: "/workspace",
    approvalMode: "on-request",
    instructionsSha256: "a".repeat(64),
    repositoryInstructions: [],
  });
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
