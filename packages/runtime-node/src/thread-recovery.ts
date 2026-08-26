import type { EventReadResult } from "@koda/agent-core";
import type {
  AgentEvent,
  ConversationItem,
  ThreadId,
  ToolCallId,
  TurnContextSnapshot,
  TurnId,
} from "@koda/protocol";

export type ThreadRecoveryErrorCode =
  | "THREAD_NOT_FOUND"
  | "THREAD_BUSY"
  | "THREAD_ID_MISMATCH"
  | "THREAD_CONTEXT_MISSING"
  | "THREAD_WORKSPACE_MISMATCH"
  | "THREAD_LOG_INVALID";

export class ThreadRecoveryError extends Error {
  public constructor(
    public readonly code: ThreadRecoveryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ThreadRecoveryError";
  }
}

export type PreviousTurnStatus =
  "completed" | "failed" | "cancelled" | "interrupted";

export interface RecoveredThread {
  threadId: ThreadId;
  previousTurnId: TurnId;
  previousStatus: PreviousTurnStatus;
  nextSequence: number;
  history: ConversationItem[];
  context: TurnContextSnapshot;
  uncertainToolCalls: Array<{ callId: ToolCallId; name: string }>;
  partialTrailingEventDiscarded: boolean;
  message: string;
}

interface TurnGroup {
  turnId: TurnId;
  events: AgentEvent[];
}

export function recoverThread(
  readResult: EventReadResult,
  expectedThreadId: ThreadId,
): RecoveredThread {
  const { events } = readResult;
  if (events.length === 0) {
    throw new ThreadRecoveryError(
      "THREAD_NOT_FOUND",
      `Thread '${expectedThreadId}' has no durable events.`,
    );
  }
  for (const event of events) {
    if (event.threadId !== expectedThreadId) {
      throw new ThreadRecoveryError(
        "THREAD_ID_MISMATCH",
        `Thread log contains events for '${event.threadId}' instead of '${expectedThreadId}'.`,
      );
    }
  }

  const groups = groupTurns(events);
  const previous = groups.at(-1);
  if (previous === undefined) {
    throw invalidLog("Thread log does not contain a turn.");
  }
  const previousStatus = validateTurnTerminals(groups);
  const contextEvent = [...events]
    .reverse()
    .find((event) => event.type === "turn.context");
  if (contextEvent?.type !== "turn.context") {
    throw new ThreadRecoveryError(
      "THREAD_CONTEXT_MISSING",
      "Thread cannot be resumed because it has no durable context snapshot.",
    );
  }

  const { history, unmatchedCalls } = reconstructHistory(events);
  for (const unmatched of unmatchedCalls) {
    if (
      unmatched.turnId !== previous.turnId ||
      previousStatus === "completed"
    ) {
      throw invalidLog(
        `Tool call '${unmatched.callId}' has no durable result in a completed turn.`,
      );
    }
  }

  const uncertainToolCalls = findUncertainToolCalls(previous.events);
  const partialTrailingEventDiscarded = readResult.diagnostics.some(
    (diagnostic) => diagnostic.code === "PARTIAL_TRAILING_LINE",
  );
  const message = buildRecoveryMessage({
    previousStatus,
    uncertainToolCalls,
    partialTrailingEventDiscarded,
  });
  const lastEvent = events.at(-1);
  if (lastEvent === undefined) {
    throw invalidLog("Thread log does not contain a final valid event.");
  }

  return {
    threadId: expectedThreadId,
    previousTurnId: previous.turnId,
    previousStatus,
    nextSequence: lastEvent.sequence + 1,
    history,
    context: contextEvent.payload,
    uncertainToolCalls,
    partialTrailingEventDiscarded,
    message,
  };
}

export function assertResumeWorkspace(
  recovered: RecoveredThread,
  workspaceRoot: string,
): void {
  if (recovered.context.workspaceRoot !== workspaceRoot) {
    throw new ThreadRecoveryError(
      "THREAD_WORKSPACE_MISMATCH",
      `Thread belongs to workspace '${recovered.context.workspaceRoot}', not '${workspaceRoot}'.`,
    );
  }
}

function groupTurns(events: readonly AgentEvent[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  const closedTurnIds = new Set<string>();
  for (const event of events) {
    const current = groups.at(-1);
    if (current?.turnId === event.turnId) {
      current.events.push(event);
      continue;
    }
    if (closedTurnIds.has(event.turnId)) {
      throw invalidLog(
        `Turn '${event.turnId}' is not contiguous in the event log.`,
      );
    }
    if (current !== undefined) {
      closedTurnIds.add(current.turnId);
    }
    groups.push({ turnId: event.turnId, events: [event] });
  }
  for (const group of groups) {
    if (group.events[0]?.type !== "turn.started") {
      throw invalidLog(
        `Turn '${group.turnId}' does not begin with turn.started.`,
      );
    }
  }
  return groups;
}

function validateTurnTerminals(
  groups: readonly TurnGroup[],
): PreviousTurnStatus {
  let previousStatus: PreviousTurnStatus = "interrupted";
  for (const [index, group] of groups.entries()) {
    const terminals = group.events.filter(isTerminalEvent);
    if (terminals.length > 1) {
      throw invalidLog(`Turn '${group.turnId}' has multiple terminal events.`);
    }
    const terminal = terminals[0];
    if (
      terminal !== undefined &&
      group.events.at(-1)?.sequence !== terminal.sequence
    ) {
      throw invalidLog(
        `Turn '${group.turnId}' has events after its terminal event.`,
      );
    }
    if (index < groups.length - 1 && terminal === undefined) {
      throw invalidLog(
        `Turn '${group.turnId}' is interrupted but a later turn already exists.`,
      );
    }
    if (index === groups.length - 1) {
      previousStatus =
        terminal?.type === "turn.completed"
          ? "completed"
          : terminal?.type === "turn.failed"
            ? "failed"
            : terminal?.type === "turn.cancelled"
              ? "cancelled"
              : "interrupted";
    }
  }
  return previousStatus;
}

function reconstructHistory(events: readonly AgentEvent[]): {
  history: ConversationItem[];
  unmatchedCalls: Array<{
    callId: ToolCallId;
    turnId: TurnId;
  }>;
} {
  const recorded = events.flatMap((event) =>
    event.type === "item.recorded"
      ? [{ item: event.payload.item, turnId: event.turnId }]
      : [],
  );
  const calls = new Map<
    ToolCallId,
    { item: Extract<ConversationItem, { type: "tool_call" }>; turnId: TurnId }
  >();
  const results = new Map<ToolCallId, string>();
  for (const entry of recorded) {
    if (entry.item.type === "tool_call") {
      if (calls.has(entry.item.callId)) {
        throw invalidLog(`Tool call '${entry.item.callId}' is duplicated.`);
      }
      calls.set(entry.item.callId, { item: entry.item, turnId: entry.turnId });
    } else if (entry.item.type === "tool_result") {
      const call = calls.get(entry.item.callId);
      if (call === undefined) {
        throw invalidLog(
          `Tool result '${entry.item.callId}' has no preceding tool call.`,
        );
      }
      if (call.item.name !== entry.item.name) {
        throw invalidLog(
          `Tool result '${entry.item.callId}' does not match its tool name.`,
        );
      }
      if (results.has(entry.item.callId)) {
        throw invalidLog(`Tool result '${entry.item.callId}' is duplicated.`);
      }
      results.set(entry.item.callId, entry.item.name);
    }
  }

  const unmatchedCalls = [...calls.entries()]
    .filter(([callId]) => !results.has(callId))
    .map(([callId, call]) => ({ callId, turnId: call.turnId }));
  const unmatchedIds = new Set(unmatchedCalls.map((call) => call.callId));
  const history = recorded
    .map((entry) => entry.item)
    .filter(
      (item) => item.type !== "tool_call" || !unmatchedIds.has(item.callId),
    );
  return { history, unmatchedCalls };
}

function findUncertainToolCalls(
  events: readonly AgentEvent[],
): Array<{ callId: ToolCallId; name: string }> {
  const started = new Map<ToolCallId, string>();
  const completed = new Set<ToolCallId>();
  for (const event of events) {
    if (event.type === "tool.started") {
      if (started.has(event.payload.callId)) {
        throw invalidLog(
          `Tool '${event.payload.callId}' started more than once.`,
        );
      }
      started.set(event.payload.callId, event.payload.name);
    } else if (event.type === "tool.completed") {
      const name = started.get(event.payload.callId);
      if (name === undefined || name !== event.payload.name) {
        throw invalidLog(
          `Tool completion '${event.payload.callId}' has no matching start.`,
        );
      }
      completed.add(event.payload.callId);
    } else if (
      event.type === "item.recorded" &&
      event.payload.item.type === "tool_result"
    ) {
      completed.add(event.payload.item.callId);
    }
  }
  return [...started.entries()]
    .filter(([callId]) => !completed.has(callId))
    .map(([callId, name]) => ({ callId, name }));
}

function isTerminalEvent(
  event: AgentEvent,
): event is Extract<
  AgentEvent,
  { type: "turn.completed" | "turn.failed" | "turn.cancelled" }
> {
  return (
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "turn.cancelled"
  );
}

function buildRecoveryMessage(options: {
  previousStatus: PreviousTurnStatus;
  uncertainToolCalls: readonly { callId: ToolCallId; name: string }[];
  partialTrailingEventDiscarded: boolean;
}): string {
  const parts = [
    `This thread was resumed after the previous turn ended with status '${options.previousStatus}'.`,
  ];
  if (options.uncertainToolCalls.length > 0) {
    parts.push(
      `The following tool calls started without a durable completion and must not be assumed successful or automatically repeated: ${options.uncertainToolCalls.map((call) => `${call.name} (${call.callId})`).join(", ")}. Inspect current state before proposing any new action.`,
    );
  }
  if (options.partialTrailingEventDiscarded) {
    parts.push("One partial trailing event was discarded during recovery.");
  }
  return parts.join(" ");
}

function invalidLog(message: string): ThreadRecoveryError {
  return new ThreadRecoveryError("THREAD_LOG_INVALID", message);
}
