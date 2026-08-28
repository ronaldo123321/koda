import { join, resolve } from "node:path";

import {
  agentEventSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type AgentEvent,
} from "@koda/protocol";

import { JsonlEventStore } from "./jsonl-event-store.js";
import { ThreadLease } from "./thread-lease.js";
import type { WorkspaceMutationRecoveryResult } from "./workspace-mutation-journal.js";

const SAFE_THREAD_FILE_NAME = /^[A-Za-z0-9._-]{1,200}$/u;

export type WorkspaceMutationAuditReconciliationStatus =
  "reconciled" | "already_reconciled" | "deferred";

export interface WorkspaceMutationAuditReconciliation {
  status: WorkspaceMutationAuditReconciliationStatus;
  message?: string;
}

export interface WorkspaceMutationAuditReconcilerOptions {
  now?: () => string;
}

export async function reconcileWorkspaceMutationAudit(
  kodaHome: string,
  recovery: WorkspaceMutationRecoveryResult,
  options: WorkspaceMutationAuditReconcilerOptions = {},
): Promise<WorkspaceMutationAuditReconciliation> {
  if (!SAFE_THREAD_FILE_NAME.test(recovery.threadId)) {
    return {
      status: "deferred",
      message:
        "The originating thread ID is not safe to map to a local event log.",
    };
  }
  const eventLogPath = join(
    resolve(kodaHome),
    "threads",
    `${recovery.threadId}.jsonl`,
  );
  let lease: ThreadLease | undefined;
  try {
    lease = await ThreadLease.acquire(eventLogPath);
  } catch (error) {
    return {
      status: "deferred",
      message: `The originating thread audit is busy: ${errorMessage(error)}`,
    };
  }

  try {
    const eventStore = new JsonlEventStore(eventLogPath);
    let events: readonly AgentEvent[];
    try {
      events = (await eventStore.readAllRequired()).events;
    } catch (error) {
      return {
        status: "deferred",
        message: `The originating thread audit is unavailable: ${errorMessage(error)}`,
      };
    }
    const prepared = events.find(
      (event) =>
        event.type === "workspace.change_set_prepared" &&
        event.payload.callId === recovery.callId &&
        event.payload.name === recovery.toolName &&
        event.payload.planSha256 === recovery.planSha256,
    );
    if (
      prepared === undefined ||
      prepared.type !== "workspace.change_set_prepared" ||
      prepared.payload.changes.length !== recovery.changeCount
    ) {
      return {
        status: "deferred",
        message:
          "The originating thread audit has no matching prepared change-set boundary.",
      };
    }

    const terminal = events.find(
      (event) =>
        isChangeSetTerminal(event) && event.payload.callId === recovery.callId,
    );
    const expectedType = expectedTerminalType(recovery.status);
    if (terminal !== undefined) {
      return terminal.type === expectedType &&
        terminal.payload.name === recovery.toolName &&
        terminal.payload.planSha256 === recovery.planSha256
        ? { status: "already_reconciled" }
        : {
            status: "deferred",
            message:
              "The originating thread audit contains a conflicting terminal change-set event.",
          };
    }

    const preparedIndex = events.indexOf(prepared);
    const trailingEvents = events.slice(preparedIndex + 1);
    if (
      trailingEvents.some(
        (event) =>
          (event.type === "tool.completed" &&
            event.payload.callId === recovery.callId) ||
          event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.cancelled" ||
          event.type === "turn.paused",
      )
    ) {
      return {
        status: "deferred",
        message:
          "The originating thread audit already crossed a terminal boundary without matching recovery evidence.",
      };
    }

    const previous = events.at(-1);
    if (previous === undefined) {
      return {
        status: "deferred",
        message: "The originating thread audit is empty.",
      };
    }
    await eventStore.append(
      createRecoveryEvent(
        recovery,
        previous.sequence + 1,
        options.now?.() ?? new Date().toISOString(),
      ),
    );
    return { status: "reconciled" };
  } finally {
    await lease.release();
  }
}

function createRecoveryEvent(
  recovery: WorkspaceMutationRecoveryResult,
  sequence: number,
  timestamp: string,
): AgentEvent {
  const metadata = {
    schemaVersion: 1 as const,
    sequence,
    timestamp,
    threadId: threadIdSchema.parse(recovery.threadId),
    turnId: turnIdSchema.parse(recovery.turnId),
  };
  const callId = toolCallIdSchema.parse(recovery.callId);
  if (recovery.status === "committed") {
    return agentEventSchema.parse({
      ...metadata,
      type: "workspace.change_set_committed",
      payload: {
        callId,
        name: recovery.toolName,
        planSha256: recovery.planSha256,
        changeCount: recovery.changeCount,
      },
    });
  }
  if (recovery.status === "conflicted") {
    return agentEventSchema.parse({
      ...metadata,
      type: "workspace.change_set_uncertain",
      payload: {
        callId,
        name: recovery.toolName,
        planSha256: recovery.planSha256,
        appliedCount: recovery.appliedCount,
        uncertainPaths: recovery.primaryPaths,
        errorCode: "PROCESS_INTERRUPTED",
      },
    });
  }
  return agentEventSchema.parse({
    ...metadata,
    type: "workspace.change_set_rolled_back",
    payload: {
      callId,
      name: recovery.toolName,
      planSha256: recovery.planSha256,
      appliedCount: recovery.appliedCount,
      restoredPaths: recovery.restoredPaths,
      errorCode: "PROCESS_INTERRUPTED",
    },
  });
}

function expectedTerminalType(
  status: WorkspaceMutationRecoveryResult["status"],
):
  | "workspace.change_set_committed"
  | "workspace.change_set_rolled_back"
  | "workspace.change_set_uncertain" {
  return status === "committed"
    ? "workspace.change_set_committed"
    : status === "conflicted"
      ? "workspace.change_set_uncertain"
      : "workspace.change_set_rolled_back";
}

function isChangeSetTerminal(event: AgentEvent): event is Extract<
  AgentEvent,
  {
    type:
      | "workspace.change_set_committed"
      | "workspace.change_set_rolled_back"
      | "workspace.change_set_uncertain";
  }
> {
  return (
    event.type === "workspace.change_set_committed" ||
    event.type === "workspace.change_set_rolled_back" ||
    event.type === "workspace.change_set_uncertain"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
