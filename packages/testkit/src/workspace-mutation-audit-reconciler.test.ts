import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentEventSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type AgentEvent,
} from "@koda/protocol";
import {
  JsonlEventStore,
  reconcileWorkspaceMutationAudit,
  type WorkspaceMutationRecoveryResult,
} from "@koda/runtime-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let temporaryRoot: string;
let kodaHome: string;
let eventStore: JsonlEventStore;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "koda-mutation-audit-"));
  kodaHome = join(temporaryRoot, "state");
  await mkdir(join(kodaHome, "threads"), { recursive: true });
  eventStore = new JsonlEventStore(
    join(kodaHome, "threads", "audit-thread.jsonl"),
  );
  for (const event of preparedEvents()) {
    await eventStore.append(event);
  }
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("reconcileWorkspaceMutationAudit", () => {
  it.each([
    ["committed" as const, "workspace.change_set_committed"],
    ["rolled_back" as const, "workspace.change_set_rolled_back"],
    ["not_started" as const, "workspace.change_set_rolled_back"],
    ["conflicted" as const, "workspace.change_set_uncertain"],
  ])(
    "appends one idempotent %s recovery terminal",
    async (status, eventType) => {
      const recovery = recoveryResult(status);

      await expect(
        reconcileWorkspaceMutationAudit(kodaHome, recovery, {
          now: () => "2026-08-28T01:00:00.000Z",
        }),
      ).resolves.toEqual({ status: "reconciled" });
      const events = (await eventStore.readAllRequired()).events;
      expect(events.at(-1)).toMatchObject({
        sequence: 3,
        timestamp: "2026-08-28T01:00:00.000Z",
        type: eventType,
        payload: {
          callId: "audit-call",
          name: "apply_changes",
          planSha256: "a".repeat(64),
        },
      });
      await expect(
        reconcileWorkspaceMutationAudit(kodaHome, recovery),
      ).resolves.toEqual({ status: "already_reconciled" });
      expect((await eventStore.readAllRequired()).events).toHaveLength(4);
    },
  );

  it("defers when the prepared audit boundary is missing", async () => {
    const recovery = {
      ...recoveryResult("committed"),
      threadId: "missing-thread",
    };

    await expect(
      reconcileWorkspaceMutationAudit(kodaHome, recovery),
    ).resolves.toMatchObject({
      status: "deferred",
      message: expect.stringContaining("unavailable"),
    });
  });

  it("defers rather than appending after a conflicting terminal", async () => {
    await eventStore.append(
      terminalEvent(3, "workspace.change_set_rolled_back"),
    );

    await expect(
      reconcileWorkspaceMutationAudit(kodaHome, recoveryResult("committed")),
    ).resolves.toMatchObject({
      status: "deferred",
      message: expect.stringContaining("conflicting terminal"),
    });
    expect((await eventStore.readAllRequired()).events).toHaveLength(4);
  });
});

function preparedEvents(): AgentEvent[] {
  return [
    event(0, "turn.started", {}),
    event(1, "tool.execution_started", {
      callId: toolCallIdSchema.parse("audit-call"),
      name: "apply_changes",
      effect: "write",
    }),
    event(2, "workspace.change_set_prepared", {
      callId: toolCallIdSchema.parse("audit-call"),
      name: "apply_changes",
      planSha256: "a".repeat(64),
      changes: [
        {
          index: 0,
          operation: "update",
          path: "README.md",
          beforeSha256: "b".repeat(64),
          afterSha256: "c".repeat(64),
          bytes: 10,
        },
      ],
    }),
  ];
}

function terminalEvent(
  sequence: number,
  type:
    | "workspace.change_set_committed"
    | "workspace.change_set_rolled_back"
    | "workspace.change_set_uncertain",
): AgentEvent {
  if (type === "workspace.change_set_committed") {
    return event(sequence, type, {
      callId: toolCallIdSchema.parse("audit-call"),
      name: "apply_changes",
      planSha256: "a".repeat(64),
      changeCount: 1,
    });
  }
  if (type === "workspace.change_set_uncertain") {
    return event(sequence, type, {
      callId: toolCallIdSchema.parse("audit-call"),
      name: "apply_changes",
      planSha256: "a".repeat(64),
      appliedCount: 1,
      uncertainPaths: ["README.md"],
      errorCode: "PROCESS_INTERRUPTED",
    });
  }
  return event(sequence, type, {
    callId: toolCallIdSchema.parse("audit-call"),
    name: "apply_changes",
    planSha256: "a".repeat(64),
    appliedCount: 1,
    restoredPaths: ["README.md"],
    errorCode: "PROCESS_INTERRUPTED",
  });
}

function event(
  sequence: number,
  type: AgentEvent["type"],
  payload: unknown,
): AgentEvent {
  return agentEventSchema.parse({
    schemaVersion: 1,
    sequence,
    timestamp: "2026-08-28T00:00:00.000Z",
    threadId: threadIdSchema.parse("audit-thread"),
    turnId: turnIdSchema.parse("audit-turn"),
    type,
    payload,
  });
}

function recoveryResult(
  status: WorkspaceMutationRecoveryResult["status"],
): WorkspaceMutationRecoveryResult {
  return {
    threadId: "audit-thread",
    turnId: "audit-turn",
    callId: "audit-call",
    toolName: "apply_changes",
    planSha256: "a".repeat(64),
    status,
    paths: ["README.md"],
    primaryPaths: ["README.md"],
    changeCount: 1,
    appliedCount: status === "not_started" ? 0 : 1,
    restoredPaths: status === "rolled_back" ? ["README.md"] : [],
    journalDirectory: join(temporaryRoot, "journal"),
  };
}
