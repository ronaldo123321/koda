import type { EventReadResult } from "@koda/agent-core";
import type {
  AgentEvent,
  ConversationItem,
  ProcessOwnership,
  ProcessTerminationReason,
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
  uncertainToolCalls: UncertainToolCall[];
  partialTrailingEventDiscarded: boolean;
  message: string;
}

export interface UncertainToolCall {
  callId: ToolCallId;
  name: string;
  effect?: "read" | "write" | "execute";
  process?: {
    pid: number;
    ownership: ProcessOwnership;
    status: "exited" | "terminated" | "already_exited" | "uncertain";
    exitCode?: number | null;
    signal?: string | null;
  };
}

interface TurnGroup {
  turnId: TurnId;
  events: AgentEvent[];
}

interface RecoveryProcessState {
  name: string;
  pid: number;
  ownership: ProcessOwnership;
  exit?: { exitCode: number | null; signal: string | null };
  termination?: "terminated" | "already_exited" | "uncertain";
  terminationReason?: ProcessTerminationReason;
  terminationRequests: Set<string>;
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
  validateCompactionHistory(history);

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

function validateCompactionHistory(history: readonly ConversationItem[]): void {
  const itemIds = new Set<string>();
  for (const item of history) {
    if (itemIds.has(item.id)) {
      throw invalidLog(`Conversation item '${item.id}' is duplicated.`);
    }
    itemIds.add(item.id);
  }

  for (const [index, item] of history.entries()) {
    if (item.type !== "compaction" || item.reason === undefined) {
      continue;
    }
    if (
      item.retainedItemIds === undefined ||
      item.estimatedTokensBefore === undefined ||
      item.estimatedTokensAfter === undefined
    ) {
      throw invalidLog(`Compaction '${item.id}' has incomplete metadata.`);
    }
    if (item.estimatedTokensAfter > item.estimatedTokensBefore) {
      throw invalidLog(
        `Compaction '${item.id}' increases the estimated context size.`,
      );
    }

    const retainedIds = new Set(item.retainedItemIds);
    if (retainedIds.size !== item.retainedItemIds.length) {
      throw invalidLog(`Compaction '${item.id}' repeats a retained item ID.`);
    }
    const precedingItems = history.slice(0, index);
    const precedingById = new Map(
      precedingItems.map((preceding) => [preceding.id, preceding]),
    );
    const retainedItems = item.retainedItemIds.map((retainedId) => {
      const retained = precedingById.get(retainedId);
      if (retained === undefined || retained.type === "compaction") {
        throw invalidLog(
          `Compaction '${item.id}' references unavailable item '${retainedId}'.`,
        );
      }
      return retained;
    });
    const retainedPositions = item.retainedItemIds.map((retainedId) =>
      precedingItems.findIndex((preceding) => preceding.id === retainedId),
    );
    if (
      retainedPositions.some(
        (position, retainedIndex) =>
          retainedIndex > 0 &&
          position <= (retainedPositions[retainedIndex - 1] ?? -1),
      )
    ) {
      throw invalidLog(
        `Compaction '${item.id}' does not preserve retained item order.`,
      );
    }

    const newestUser = [...precedingItems]
      .reverse()
      .find((preceding) => preceding.type === "user_message");
    if (newestUser === undefined || !retainedIds.has(newestUser.id)) {
      throw invalidLog(
        `Compaction '${item.id}' does not retain the newest user message.`,
      );
    }

    const retainedCallIds = new Set(
      retainedItems.flatMap((retained) =>
        retained.type === "tool_call" ||
        retained.type === "approval" ||
        retained.type === "tool_result"
          ? [retained.callId]
          : [],
      ),
    );
    for (const callId of retainedCallIds) {
      const related = precedingItems.filter(
        (preceding) =>
          (preceding.type === "tool_call" ||
            preceding.type === "approval" ||
            preceding.type === "tool_result") &&
          preceding.callId === callId,
      );
      if (related.some((relatedItem) => !retainedIds.has(relatedItem.id))) {
        throw invalidLog(
          `Compaction '${item.id}' retains only part of tool call '${callId}'.`,
        );
      }
    }

    for (const [
      providerStateIndex,
      providerState,
    ] of precedingItems.entries()) {
      if (providerState.type !== "provider_state") {
        continue;
      }
      const stateStepItems: ConversationItem[] = [providerState];
      let cursor = providerStateIndex + 1;
      let followingCalls = 0;
      while (precedingItems[cursor]?.type === "tool_call") {
        const call = precedingItems[cursor];
        if (call?.type !== "tool_call") {
          break;
        }
        const related = precedingItems.filter(
          (preceding) =>
            (preceding.type === "tool_call" ||
              preceding.type === "approval" ||
              preceding.type === "tool_result") &&
            preceding.callId === call.callId,
        );
        stateStepItems.push(...related);
        followingCalls += 1;
        cursor += related.length;
      }
      if (followingCalls === 0) {
        throw invalidLog(
          `Compaction '${item.id}' retains provider state '${providerState.id}' without a following tool call.`,
        );
      }
      const retainedStateStepItems = stateStepItems.filter((stateStepItem) =>
        retainedIds.has(stateStepItem.id),
      );
      if (
        retainedStateStepItems.length > 0 &&
        retainedStateStepItems.length !== stateStepItems.length
      ) {
        throw invalidLog(
          `Compaction '${item.id}' retains only part of provider state step '${providerState.id}'.`,
        );
      }
    }
  }
}

function findUncertainToolCalls(
  events: readonly AgentEvent[],
): UncertainToolCall[] {
  const started = new Map<ToolCallId, string>();
  const executionStarted = new Map<
    ToolCallId,
    { name: string; effect: "read" | "write" | "execute" }
  >();
  const processes = new Map<ToolCallId, RecoveryProcessState>();
  const completed = new Set<ToolCallId>();
  for (const event of events) {
    if (event.type === "tool.started") {
      if (started.has(event.payload.callId)) {
        throw invalidLog(
          `Tool '${event.payload.callId}' started more than once.`,
        );
      }
      started.set(event.payload.callId, event.payload.name);
    } else if (event.type === "tool.execution_started") {
      const name = started.get(event.payload.callId);
      if (name === undefined || name !== event.payload.name) {
        throw invalidLog(
          `Tool execution '${event.payload.callId}' has no matching tool start.`,
        );
      }
      if (executionStarted.has(event.payload.callId)) {
        throw invalidLog(
          `Tool execution '${event.payload.callId}' started more than once.`,
        );
      }
      executionStarted.set(event.payload.callId, {
        name,
        effect: event.payload.effect,
      });
    } else if (event.type === "process.started") {
      const execution = executionStarted.get(event.payload.callId);
      if (
        execution === undefined ||
        execution.name !== event.payload.name ||
        execution.effect !== "execute"
      ) {
        throw invalidLog(
          `Process '${event.payload.callId}' has no matching execute boundary.`,
        );
      }
      if (processes.has(event.payload.callId)) {
        throw invalidLog(
          `Process '${event.payload.callId}' started more than once.`,
        );
      }
      processes.set(event.payload.callId, {
        name: event.payload.name,
        pid: event.payload.pid,
        ownership: event.payload.ownership,
        terminationRequests: new Set(),
      });
    } else if (event.type === "process.exited") {
      const processState = matchingProcess(processes, event);
      if (processState.exit !== undefined) {
        throw invalidLog(
          `Process '${event.payload.callId}' exited more than once.`,
        );
      }
      processState.exit = {
        exitCode: event.payload.exitCode,
        signal: event.payload.signal,
      };
    } else if (event.type === "process.termination_requested") {
      const processState = matchingProcess(processes, event);
      if (processState.termination !== undefined) {
        throw invalidLog(
          `Process '${event.payload.callId}' requested termination after completion.`,
        );
      }
      if (
        processState.terminationReason !== undefined &&
        processState.terminationReason !== event.payload.reason
      ) {
        throw invalidLog(
          `Process '${event.payload.callId}' changed its termination reason.`,
        );
      }
      const requestKey = `${event.payload.attempt}:${event.payload.mechanism}`;
      if (processState.terminationRequests.has(requestKey)) {
        throw invalidLog(
          `Process '${event.payload.callId}' repeated a termination attempt.`,
        );
      }
      processState.terminationReason = event.payload.reason;
      processState.terminationRequests.add(requestKey);
    } else if (event.type === "process.termination_completed") {
      const processState = matchingProcess(processes, event);
      if (processState.terminationRequests.size === 0) {
        throw invalidLog(
          `Process '${event.payload.callId}' completed termination without a request.`,
        );
      }
      if (processState.terminationReason !== event.payload.reason) {
        throw invalidLog(
          `Process '${event.payload.callId}' completed a different termination reason.`,
        );
      }
      if (processState.termination !== undefined) {
        throw invalidLog(
          `Process '${event.payload.callId}' completed termination more than once.`,
        );
      }
      processState.termination = event.payload.outcome;
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
  for (const [callId, processState] of processes) {
    if (
      completed.has(callId) &&
      processState.exit === undefined &&
      processState.termination === undefined
    ) {
      throw invalidLog(
        `Completed tool '${callId}' has an unfinished process lifecycle.`,
      );
    }
  }
  const usesExecutionBoundaries = events.some(
    (event) =>
      event.type === "tool.started" && event.payload.executionBoundary === true,
  );
  return [...started.entries()]
    .filter(([callId]) => !completed.has(callId))
    .flatMap(([callId, name]) => {
      const execution = executionStarted.get(callId);
      if (execution === undefined) {
        return usesExecutionBoundaries ? [] : [{ callId, name }];
      }
      const processState = processes.get(callId);
      if (processState === undefined) {
        return [{ callId, name, effect: execution.effect }];
      }
      const status =
        processState.termination ??
        (processState.exit === undefined ? "uncertain" : "exited");
      return [
        {
          callId,
          name,
          effect: execution.effect,
          process: {
            pid: processState.pid,
            ownership: processState.ownership,
            status,
            ...(processState.exit === undefined
              ? {}
              : {
                  exitCode: processState.exit.exitCode,
                  signal: processState.exit.signal,
                }),
          },
        },
      ];
    });
}

function matchingProcess(
  processes: Map<ToolCallId, RecoveryProcessState>,
  event: Extract<
    AgentEvent,
    {
      type:
        | "process.exited"
        | "process.termination_requested"
        | "process.termination_completed";
    }
  >,
) {
  const processState = processes.get(event.payload.callId);
  if (
    processState === undefined ||
    processState.name !== event.payload.name ||
    processState.pid !== event.payload.pid
  ) {
    throw invalidLog(
      `Process event '${event.type}' has no matching process start.`,
    );
  }
  return processState;
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
  uncertainToolCalls: readonly UncertainToolCall[];
  partialTrailingEventDiscarded: boolean;
}): string {
  const parts = [
    `This thread was resumed after the previous turn ended with status '${options.previousStatus}'.`,
  ];
  if (options.uncertainToolCalls.length > 0) {
    parts.push(
      `The following tool calls started without a durable completion and must not be assumed successful or automatically repeated: ${options.uncertainToolCalls.map(describeUncertainToolCall).join(", ")}. Inspect current repository and process state before proposing any new action.`,
    );
  }
  if (options.partialTrailingEventDiscarded) {
    parts.push("One partial trailing event was discarded during recovery.");
  }
  return parts.join(" ");
}

function describeUncertainToolCall(call: UncertainToolCall): string {
  const effect = call.effect === undefined ? "" : `, effect ${call.effect}`;
  const processState =
    call.process === undefined
      ? ""
      : `, process ${call.process.pid} ${call.process.status}`;
  return `${call.name} (${call.callId}${effect}${processState})`;
}

function invalidLog(message: string): ThreadRecoveryError {
  return new ThreadRecoveryError("THREAD_LOG_INVALID", message);
}
