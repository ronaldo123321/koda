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
});

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
