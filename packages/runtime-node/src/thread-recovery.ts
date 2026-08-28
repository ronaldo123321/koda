import {
  PlanReducerError,
  reducePlanAcceptance,
  reducePlanUpdate,
  type EventReadResult,
} from "@koda/agent-core";
import {
  type AgentEvent,
  type ConversationItem,
  type PlanAcceptanceResolution,
  type PlanCheckpoint,
  type PlanSnapshot,
  type ProcessOwnership,
  type ProcessTerminationReason,
  type ThreadId,
  type ToolCallId,
  type TurnContextSnapshot,
  type TurnId,
  type WorkspaceChangeSetRecovery,
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
  "completed" | "failed" | "cancelled" | "paused" | "interrupted";

export interface RecoveredThread {
  threadId: ThreadId;
  previousTurnId: TurnId;
  previousStatus: PreviousTurnStatus;
  nextSequence: number;
  history: ConversationItem[];
  context: TurnContextSnapshot;
  uncertainToolCalls: UncertainToolCall[];
  workspaceChangeSets: WorkspaceChangeSetRecovery[];
  plan?: PlanSnapshot;
  checkpoint?: PlanCheckpoint;
  planNeedsRevalidation: boolean;
  partialTrailingEventDiscarded: boolean;
  message: string;
}

export interface UncertainToolCall {
  callId: ToolCallId;
  name: string;
  effect?: "read" | "control" | "write" | "execute";
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
  validateApprovalGrantAudit(groups);
  const recoveredPlan = recoverPlanState(events);
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
  const workspaceChangeSets = findWorkspaceChangeSets(previous.events);
  const planNeedsRevalidation = needsPlanRevalidation(
    previous.events,
    uncertainToolCalls,
    recoveredPlan.checkpoint,
  );
  const partialTrailingEventDiscarded = readResult.diagnostics.some(
    (diagnostic) => diagnostic.code === "PARTIAL_TRAILING_LINE",
  );
  const message = buildRecoveryMessage({
    previousStatus,
    uncertainToolCalls,
    workspaceChangeSets,
    planNeedsRevalidation,
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
    workspaceChangeSets,
    ...(recoveredPlan.plan === undefined ? {} : { plan: recoveredPlan.plan }),
    ...(recoveredPlan.checkpoint === undefined
      ? {}
      : { checkpoint: recoveredPlan.checkpoint }),
    planNeedsRevalidation,
    partialTrailingEventDiscarded,
    message,
  };
}

function recoverPlanState(events: readonly AgentEvent[]): {
  plan?: PlanSnapshot;
  checkpoint?: PlanCheckpoint;
} {
  let plan: PlanSnapshot | undefined;
  let checkpoint: PlanCheckpoint | undefined;
  const started = new Map<ToolCallId, string>();
  const openTools = new Set<ToolCallId>();
  const executing = new Map<
    ToolCallId,
    "read" | "control" | "write" | "execute"
  >();
  const resolutions = new Map<ToolCallId, PlanAcceptanceResolution>();
  const acceptanceRequests = new Map<
    ToolCallId,
    Extract<AgentEvent, { type: "plan.acceptance_requested" }>["payload"]
  >();
  const consumedAcceptances = new Set<ToolCallId>();
  const eventsBySequence = new Map(
    events.map((event) => [event.sequence, event]),
  );

  for (const event of events) {
    if (event.type === "tool.started") {
      started.set(event.payload.callId, event.payload.name);
      openTools.add(event.payload.callId);
      continue;
    }
    if (event.type === "tool.execution_started") {
      executing.set(event.payload.callId, event.payload.effect);
      continue;
    }
    if (event.type === "tool.completed") {
      const resolution = resolutions.get(event.payload.callId);
      if (
        resolution?.decision === "accepted" &&
        !consumedAcceptances.has(event.payload.callId)
      ) {
        throw invalidLog(
          `Accepted Plan resolution '${event.payload.callId}' has no durable Runtime Plan update.`,
        );
      }
      executing.delete(event.payload.callId);
      openTools.delete(event.payload.callId);
      continue;
    }
    if (event.type === "plan.acceptance_requested") {
      const stage = plan?.stages.find(
        (candidate) => candidate.id === event.payload.stageId,
      );
      if (
        plan === undefined ||
        started.get(event.payload.callId) !== "update_plan" ||
        executing.get(event.payload.callId) !== "control" ||
        event.payload.planId !== plan.planId ||
        event.payload.planRevision !== plan.revision ||
        stage?.status !== "awaiting_acceptance" ||
        JSON.stringify(event.payload.criteria) !==
          JSON.stringify(stage.acceptanceCriteria) ||
        event.payload.summary !== stage.summary ||
        JSON.stringify(event.payload.evidence) !==
          JSON.stringify(stage.evidence)
      ) {
        throw invalidLog(
          `Plan acceptance request '${event.payload.callId}' does not match the active gated Stage.`,
        );
      }
      if (acceptanceRequests.has(event.payload.callId)) {
        throw invalidLog(
          `Plan acceptance request '${event.payload.callId}' is duplicated.`,
        );
      }
      acceptanceRequests.set(event.payload.callId, event.payload);
      continue;
    }
    if (event.type === "plan.acceptance_resolved") {
      const request = acceptanceRequests.get(event.payload.callId);
      if (
        request === undefined ||
        request.planId !== event.payload.planId ||
        request.planRevision !== event.payload.planRevision ||
        request.stageId !== event.payload.stageId
      ) {
        throw invalidLog(
          `Plan acceptance resolution '${event.payload.callId}' is stale or has no matching request.`,
        );
      }
      if (resolutions.has(event.payload.callId)) {
        throw invalidLog(
          `Plan acceptance resolution '${event.payload.callId}' is duplicated.`,
        );
      }
      resolutions.set(event.payload.callId, event.payload);
      continue;
    }
    if (event.type === "plan.updated") {
      if (
        started.get(event.payload.callId) !== "update_plan" ||
        executing.get(event.payload.callId) !== "control"
      ) {
        throw invalidLog(
          `Plan update revision ${event.payload.plan.revision} has no active update_plan control boundary.`,
        );
      }
      try {
        let expected: PlanSnapshot;
        if (event.payload.source === "model_update") {
          expected = reducePlanUpdate({
            planId: event.payload.plan.planId,
            ...(plan === undefined ? {} : { previous: plan }),
            update: {
              expectedRevision: plan?.revision ?? 0,
              objective: event.payload.plan.objective,
              ...(event.payload.explanation === undefined
                ? {}
                : { explanation: event.payload.explanation }),
              stages: event.payload.plan.stages.map((stage) => {
                const { status: _status, ...draft } = stage;
                return draft;
              }),
            },
          });
        } else {
          if (plan === undefined) {
            throw invalidLog(
              "Runtime acceptance cannot create the first Plan revision.",
            );
          }
          const resolution = resolutions.get(event.payload.callId);
          if (
            resolution === undefined ||
            resolution.decision !== "accepted" ||
            consumedAcceptances.has(event.payload.callId)
          ) {
            throw invalidLog(
              `Runtime Plan update '${event.payload.callId}' has no accepted resolution.`,
            );
          }
          const reduced = reducePlanAcceptance(plan, resolution);
          if (reduced.status !== "accepted") {
            throw invalidLog(
              `Runtime Plan update '${event.payload.callId}' did not accept its Stage.`,
            );
          }
          expected = reduced.plan;
          consumedAcceptances.add(event.payload.callId);
        }
        if (JSON.stringify(expected) !== JSON.stringify(event.payload.plan)) {
          throw invalidLog(
            `Plan update revision ${event.payload.plan.revision} does not match its validated transition.`,
          );
        }
      } catch (error) {
        if (error instanceof ThreadRecoveryError) {
          throw error;
        }
        if (error instanceof PlanReducerError) {
          throw invalidLog(
            `Plan update revision ${event.payload.plan.revision} is invalid: ${error.code}: ${error.message}`,
          );
        }
        throw error;
      }
      plan = event.payload.plan;
      continue;
    }
    if (event.type === "plan.checkpointed") {
      const candidate = event.payload.checkpoint;
      if (
        plan === undefined ||
        candidate.planId !== plan.planId ||
        candidate.planRevision !== plan.revision
      ) {
        throw invalidLog(
          `Plan checkpoint '${candidate.checkpointId}' references an unavailable Plan revision.`,
        );
      }
      const unsafeExecution = [...executing.values()].some(
        (effect) => effect === "write" || effect === "execute",
      );
      if (unsafeExecution) {
        throw invalidLog(
          `Plan checkpoint '${candidate.checkpointId}' crosses an incomplete side effect.`,
        );
      }
      const safeEvent = eventsBySequence.get(candidate.lastSafeSequence);
      if (
        safeEvent === undefined ||
        safeEvent.sequence >= event.sequence ||
        safeEvent.threadId !== event.threadId
      ) {
        throw invalidLog(
          `Plan checkpoint '${candidate.checkpointId}' has an invalid safe sequence.`,
        );
      }
      for (const reference of candidate.evidence) {
        if (
          reference.kind === "event" &&
          (reference.sequence >= event.sequence ||
            !eventsBySequence.has(reference.sequence))
        ) {
          throw invalidLog(
            `Plan checkpoint '${candidate.checkpointId}' references unavailable event evidence.`,
          );
        }
      }
      const activeStage = plan.stages.find(
        (stage) => stage.status !== "completed" && stage.status !== "accepted",
      );
      const activeTodo = activeStage?.todos.find(
        (todo) => todo.status === "in_progress",
      );
      if (
        candidate.activeStageId !== activeStage?.id ||
        candidate.activeTodoId !== activeTodo?.id
      ) {
        throw invalidLog(
          `Plan checkpoint '${candidate.checkpointId}' does not match the active Plan state.`,
        );
      }
      checkpoint = candidate;
      continue;
    }
    if (event.type === "turn.paused") {
      if (openTools.size > 0 || executing.size > 0) {
        throw invalidLog(
          `Paused turn '${event.turnId}' still has an incomplete Tool boundary.`,
        );
      }
      if (
        checkpoint === undefined ||
        event.payload.checkpointId !== checkpoint.checkpointId
      ) {
        throw invalidLog(
          `Paused turn '${event.turnId}' has no matching latest Plan checkpoint.`,
        );
      }
    }
  }
  return {
    ...(plan === undefined ? {} : { plan }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
}

function needsPlanRevalidation(
  events: readonly AgentEvent[],
  uncertainToolCalls: readonly UncertainToolCall[],
  checkpoint: PlanCheckpoint | undefined,
): boolean {
  const uncertainIds = new Set(uncertainToolCalls.map((call) => call.callId));
  const safeSequence = checkpoint?.lastSafeSequence ?? -1;
  return events.some(
    (event) =>
      event.type === "tool.execution_started" &&
      event.sequence > safeSequence &&
      uncertainIds.has(event.payload.callId) &&
      (event.payload.effect === "write" || event.payload.effect === "execute"),
  );
}

function validateApprovalGrantAudit(groups: readonly TurnGroup[]): void {
  const createdGrantIds = new Set<string>();
  for (const group of groups) {
    const started = new Map<ToolCallId, string>();
    const requested = new Set<ToolCallId>();
    const resolved = new Map<
      ToolCallId,
      Extract<AgentEvent, { type: "approval.resolved" }>
    >();
    const created = new Set<ToolCallId>();
    const used = new Set<ToolCallId>();
    const executionStarted = new Set<ToolCallId>();
    const context = group.events.find((event) => event.type === "turn.context");

    for (const event of group.events) {
      if (event.type === "tool.started") {
        started.set(event.payload.callId, event.payload.name);
        continue;
      }
      if (event.type === "approval.requested") {
        if (
          started.get(event.payload.callId) !== event.payload.name ||
          requested.has(event.payload.callId)
        ) {
          throw invalidLog(
            `Approval '${event.payload.callId}' has no unique matching tool start.`,
          );
        }
        requested.add(event.payload.callId);
        continue;
      }
      if (event.type === "approval.resolved") {
        if (
          !requested.has(event.payload.callId) ||
          resolved.has(event.payload.callId) ||
          (event.payload.grantId !== undefined &&
            event.payload.decision !== "approved")
        ) {
          throw invalidLog(
            `Approval resolution '${event.payload.callId}' has no unique request.`,
          );
        }
        resolved.set(event.payload.callId, event);
        continue;
      }
      if (event.type === "approval.grant_created") {
        const resolution = resolved.get(event.payload.callId);
        const grant = event.payload.grant;
        if (
          started.get(event.payload.callId) !== grant.toolName ||
          resolution?.payload.decision !== "approved" ||
          resolution.payload.grantId !== grant.id ||
          created.has(event.payload.callId) ||
          used.has(event.payload.callId) ||
          createdGrantIds.has(grant.id) ||
          grant.uses !== 0 ||
          context?.type !== "turn.context" ||
          context.payload.workspaceRoot !== grant.workspaceRoot ||
          Date.parse(grant.createdAt) > Date.parse(event.timestamp) ||
          Date.parse(grant.expiresAt) <= Date.parse(event.timestamp)
        ) {
          throw invalidLog(
            `Approval grant '${grant.id}' has invalid creation evidence.`,
          );
        }
        created.add(event.payload.callId);
        createdGrantIds.add(grant.id);
        continue;
      }
      if (event.type === "approval.grant_used") {
        if (
          started.get(event.payload.callId) !== event.payload.name ||
          requested.has(event.payload.callId) ||
          resolved.has(event.payload.callId) ||
          created.has(event.payload.callId) ||
          used.has(event.payload.callId) ||
          executionStarted.has(event.payload.callId) ||
          Date.parse(event.payload.expiresAt) <= Date.parse(event.timestamp)
        ) {
          throw invalidLog(
            `Approval grant use '${event.payload.callId}' has invalid audit evidence.`,
          );
        }
        used.add(event.payload.callId);
        continue;
      }
      if (event.type === "tool.execution_started") {
        const resolution = resolved.get(event.payload.callId);
        if (
          (resolution?.payload.grantId !== undefined &&
            !created.has(event.payload.callId)) ||
          (used.has(event.payload.callId) &&
            event.payload.name !== "exec_command")
        ) {
          throw invalidLog(
            `Tool execution '${event.payload.callId}' is missing approval grant audit evidence.`,
          );
        }
        executionStarted.add(event.payload.callId);
      }
    }
  }
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
              : terminal?.type === "turn.paused"
                ? "paused"
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
    { name: string; effect: "read" | "control" | "write" | "execute" }
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

interface WorkspaceChangeSetState {
  name: string;
  prepared: Extract<AgentEvent, { type: "workspace.change_set_prepared" }>;
  terminal?: Extract<
    AgentEvent,
    {
      type:
        | "workspace.change_set_committed"
        | "workspace.change_set_rolled_back"
        | "workspace.change_set_uncertain";
    }
  >;
}

const CHANGE_SET_TOOL_NAMES = new Set(["apply_changes", "apply_patchset"]);

function findWorkspaceChangeSets(
  events: readonly AgentEvent[],
): WorkspaceChangeSetRecovery[] {
  const executions = new Map<ToolCallId, string>();
  const states = new Map<ToolCallId, WorkspaceChangeSetState>();
  const completed = new Set<ToolCallId>();
  for (const event of events) {
    if (event.type === "tool.execution_started") {
      executions.set(event.payload.callId, event.payload.name);
      continue;
    }
    if (event.type === "tool.completed") {
      completed.add(event.payload.callId);
      continue;
    }
    if (event.type === "workspace.change_set_prepared") {
      if (
        !CHANGE_SET_TOOL_NAMES.has(event.payload.name) ||
        executions.get(event.payload.callId) !== event.payload.name
      ) {
        throw invalidLog(
          `Change set '${event.payload.callId}' has no matching change-set execution boundary.`,
        );
      }
      if (
        states.has(event.payload.callId) ||
        completed.has(event.payload.callId)
      ) {
        throw invalidLog(
          `Change set '${event.payload.callId}' was prepared more than once or after completion.`,
        );
      }
      states.set(event.payload.callId, {
        name: event.payload.name,
        prepared: event,
      });
      continue;
    }
    if (
      event.type !== "workspace.change_set_committed" &&
      event.type !== "workspace.change_set_rolled_back" &&
      event.type !== "workspace.change_set_uncertain"
    ) {
      continue;
    }
    const state = states.get(event.payload.callId);
    if (
      state === undefined ||
      state.name !== event.payload.name ||
      state.prepared.payload.planSha256 !== event.payload.planSha256 ||
      state.terminal !== undefined ||
      completed.has(event.payload.callId)
    ) {
      throw invalidLog(
        `Change set '${event.payload.callId}' has an invalid terminal event.`,
      );
    }
    if (
      event.type === "workspace.change_set_committed" &&
      event.payload.changeCount !== state.prepared.payload.changes.length
    ) {
      throw invalidLog(
        `Committed change set '${event.payload.callId}' has an invalid operation count.`,
      );
    }
    state.terminal = event;
  }

  return [...states.entries()].flatMap(([callId, state]) => {
    const status =
      state.terminal?.type === "workspace.change_set_committed"
        ? "committed"
        : state.terminal?.type === "workspace.change_set_rolled_back"
          ? "rolled_back"
          : state.terminal?.type === "workspace.change_set_uncertain"
            ? "uncertain"
            : "incomplete";
    if (completed.has(callId) && status !== "uncertain") {
      return [];
    }
    return [
      {
        planSha256: state.prepared.payload.planSha256,
        status,
        paths: state.prepared.payload.changes.map((change) => change.path),
      } satisfies WorkspaceChangeSetRecovery,
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

function isTerminalEvent(event: AgentEvent): event is Extract<
  AgentEvent,
  {
    type: "turn.completed" | "turn.failed" | "turn.cancelled" | "turn.paused";
  }
> {
  return (
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "turn.cancelled" ||
    event.type === "turn.paused"
  );
}

function buildRecoveryMessage(options: {
  previousStatus: PreviousTurnStatus;
  uncertainToolCalls: readonly UncertainToolCall[];
  workspaceChangeSets: readonly WorkspaceChangeSetRecovery[];
  planNeedsRevalidation: boolean;
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
  if (options.workspaceChangeSets.length > 0) {
    parts.push(
      `Workspace change-set recovery evidence: ${options.workspaceChangeSets
        .map(
          (changeSet) =>
            `${changeSet.planSha256.slice(0, 12)} ${changeSet.status} (${changeSet.paths.join(", ")})`,
        )
        .join(
          "; ",
        )}. Do not automatically repeat these writes; inspect affected paths first.`,
    );
  }
  if (options.planNeedsRevalidation) {
    parts.push(
      "The active Plan Todo crosses an uncertain write or execute boundary and requires revalidation before it can advance.",
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
