import {
  planAcceptanceResolutionSchema,
  planSnapshotSchema,
  planUpdateDraftSchema,
  type PlanAcceptanceResolution,
  type PlanErrorCode,
  type PlanId,
  type PlanSnapshot,
  type PlanStage,
  type PlanStageDraft,
  type PlanStageStatus,
  type PlanTodo,
  type PlanTodoStatus,
} from "@koda/protocol";
import type { z } from "zod";

export class PlanReducerError extends Error {
  public constructor(
    public readonly code: PlanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PlanReducerError";
  }
}

export interface ReducePlanUpdateInput {
  planId: PlanId;
  previous?: PlanSnapshot;
  update: unknown;
}

export type PlanAcceptanceReducerResult =
  | {
      status: "accepted";
      plan: PlanSnapshot;
    }
  | {
      status: "changes_requested";
      plan: PlanSnapshot;
      feedback: string;
    };

export function reducePlanUpdate(input: ReducePlanUpdateInput): PlanSnapshot {
  const previous = parsePrevious(input.previous);
  if (previous !== undefined && previous.planId !== input.planId) {
    throw new PlanReducerError(
      "PLAN_INVALID",
      "The supplied Plan ID does not match the previous Plan.",
    );
  }
  if (previous?.status === "cancelled") {
    throw new PlanReducerError(
      "PLAN_TRANSITION_INVALID",
      "A cancelled Plan cannot be updated.",
    );
  }

  const parsedUpdate = planUpdateDraftSchema.safeParse(input.update);
  if (!parsedUpdate.success) {
    throw schemaError(parsedUpdate.error);
  }
  const update = parsedUpdate.data;
  const expectedRevision = previous?.revision ?? 0;
  if (update.expectedRevision !== expectedRevision) {
    throw new PlanReducerError(
      "PLAN_REVISION_CONFLICT",
      `Expected Plan revision ${expectedRevision}, received ${update.expectedRevision}.`,
    );
  }

  validateStartedStageContinuity(previous, update.stages);
  const previousStages = new Map(
    previous?.stages.map((stage) => [stage.id, stage]) ?? [],
  );
  const planStarted =
    previous?.stages.some((stage) => stage.status !== "pending") ?? false;
  if (planStarted) {
    for (const draft of update.stages) {
      if (
        !previousStages.has(draft.id) &&
        !draft.todos.every((todo) => todo.status === "pending")
      ) {
        throw new PlanReducerError(
          "PLAN_TRANSITION_INVALID",
          `New Stage '${draft.id}' must begin pending after Plan execution starts.`,
        );
      }
    }
  }
  const stages = update.stages.map((stage) =>
    reduceStage(previousStages.get(stage.id), stage),
  );
  validateSingleActiveTodo(stages);
  validateStageOrder(stages);

  return parseCandidate({
    schemaVersion: 1,
    planId: input.planId,
    revision: expectedRevision + 1,
    objective: update.objective,
    status: derivePlanStatus(stages),
    stages,
  });
}

export function reducePlanAcceptance(
  previousInput: PlanSnapshot,
  resolutionInput: PlanAcceptanceResolution | unknown,
): PlanAcceptanceReducerResult {
  const previous = parsePrevious(previousInput);
  if (previous === undefined) {
    throw new PlanReducerError(
      "PLAN_ACCEPTANCE_NOT_PENDING",
      "No Plan exists for this acceptance decision.",
    );
  }
  if (previous.status === "cancelled") {
    throw new PlanReducerError(
      "PLAN_ACCEPTANCE_NOT_PENDING",
      "A cancelled Plan has no pending acceptance.",
    );
  }
  const resolution = planAcceptanceResolutionSchema.safeParse(resolutionInput);
  if (!resolution.success) {
    throw schemaError(resolution.error);
  }
  if (
    resolution.data.planId !== previous.planId ||
    resolution.data.planRevision !== previous.revision
  ) {
    throw new PlanReducerError(
      "PLAN_ACCEPTANCE_STALE",
      "The acceptance decision targets a stale Plan revision.",
    );
  }
  const stageIndex = previous.stages.findIndex(
    (stage) => stage.id === resolution.data.stageId,
  );
  const stage = previous.stages[stageIndex];
  if (stage === undefined || stage.status !== "awaiting_acceptance") {
    throw new PlanReducerError(
      "PLAN_ACCEPTANCE_NOT_PENDING",
      `Stage '${resolution.data.stageId}' is not awaiting acceptance.`,
    );
  }
  if (resolution.data.decision === "changes_requested") {
    const feedback = resolution.data.feedback;
    if (feedback === undefined) {
      throw new PlanReducerError(
        "PLAN_INVALID",
        "Requested changes require feedback.",
      );
    }
    return {
      status: "changes_requested",
      plan: previous,
      feedback,
    };
  }

  const stages = previous.stages.map((candidate, index) =>
    index === stageIndex
      ? { ...candidate, status: "accepted" as const }
      : candidate,
  );
  return {
    status: "accepted",
    plan: parseCandidate({
      ...previous,
      revision: previous.revision + 1,
      status: derivePlanStatus(stages),
      stages,
    }),
  };
}

function parsePrevious(
  previous: PlanSnapshot | undefined,
): PlanSnapshot | undefined {
  if (previous === undefined) {
    return undefined;
  }
  const parsed = planSnapshotSchema.safeParse(previous);
  if (!parsed.success) {
    throw schemaError(parsed.error);
  }
  assertSnapshotInvariants(parsed.data);
  return parsed.data;
}

function parseCandidate(candidate: unknown): PlanSnapshot {
  const parsed = planSnapshotSchema.safeParse(candidate);
  if (!parsed.success) {
    throw schemaError(parsed.error);
  }
  assertSnapshotInvariants(parsed.data);
  return parsed.data;
}

function reduceStage(
  previous: PlanStage | undefined,
  draft: PlanStageDraft,
): PlanStage {
  if (previous?.status === "accepted") {
    if (!sameStageContent(previous, draft)) {
      throw new PlanReducerError(
        "PLAN_TRANSITION_INVALID",
        `Accepted Stage '${draft.id}' is immutable.`,
      );
    }
    return { ...draft, status: "accepted" };
  }

  if (previous !== undefined && previous.status !== "pending") {
    if (
      previous.title !== draft.title ||
      previous.requiresAcceptance !== draft.requiresAcceptance ||
      !sameStrings(previous.acceptanceCriteria, draft.acceptanceCriteria)
    ) {
      throw new PlanReducerError(
        "PLAN_TRANSITION_INVALID",
        `Started Stage '${draft.id}' cannot change its title or acceptance contract.`,
      );
    }
  }

  validateTodoContinuity(previous, draft);
  const previousTodos = new Map(
    previous?.todos.map((todo) => [todo.id, todo]) ?? [],
  );
  for (const todo of draft.todos) {
    const previousTodo = previousTodos.get(todo.id);
    if (
      previous !== undefined &&
      previous.status !== "pending" &&
      previousTodo === undefined &&
      todo.status !== "pending" &&
      todo.status !== "in_progress"
    ) {
      throw new PlanReducerError(
        "PLAN_TRANSITION_INVALID",
        `New Todo '${todo.id}' in a started Stage must begin pending or in progress.`,
      );
    }
    if (previousTodo !== undefined) {
      validateTodoTransition(previousTodo, todo);
    }
  }

  const status = deriveStageStatus(previous, draft);
  if (status === "awaiting_acceptance") {
    if (draft.summary === undefined || draft.evidence.length === 0) {
      throw new PlanReducerError(
        "PLAN_TRANSITION_INVALID",
        `Gated Stage '${draft.id}' requires a summary and evidence before acceptance.`,
      );
    }
  }
  return { ...draft, status };
}

function deriveStageStatus(
  previous: PlanStage | undefined,
  draft: PlanStageDraft,
): PlanStageStatus {
  if (previous?.status === "accepted") {
    return "accepted";
  }
  if (draft.todos.every((todo) => todo.status === "pending")) {
    return "pending";
  }
  const allTerminal = draft.todos.every(
    (todo) => todo.status === "completed" || todo.status === "cancelled",
  );
  if (!allTerminal) {
    return "active";
  }
  return draft.requiresAcceptance ? "awaiting_acceptance" : "completed";
}

function derivePlanStatus(
  stages: readonly PlanStage[],
): "active" | "completed" {
  return stages.every(
    (stage) => stage.status === "completed" || stage.status === "accepted",
  )
    ? "completed"
    : "active";
}

function validateStartedStageContinuity(
  previous: PlanSnapshot | undefined,
  drafts: readonly PlanStageDraft[],
): void {
  if (previous === undefined) {
    return;
  }
  let previousCandidateIndex = -1;
  for (const stage of previous.stages) {
    if (stage.status === "pending") {
      continue;
    }
    const candidateIndex = drafts.findIndex((draft) => draft.id === stage.id);
    if (candidateIndex < 0) {
      throw new PlanReducerError(
        "PLAN_TRANSITION_INVALID",
        `Started Stage '${stage.id}' cannot be removed.`,
      );
    }
    if (candidateIndex <= previousCandidateIndex) {
      throw new PlanReducerError(
        "PLAN_TRANSITION_INVALID",
        "Started Stages cannot be reordered.",
      );
    }
    previousCandidateIndex = candidateIndex;
  }
}

function validateTodoContinuity(
  previous: PlanStage | undefined,
  draft: PlanStageDraft,
): void {
  if (previous === undefined || previous.status === "pending") {
    return;
  }
  let previousCandidateIndex = -1;
  for (const todo of previous.todos) {
    const candidateIndex = draft.todos.findIndex(
      (candidate) => candidate.id === todo.id,
    );
    if (candidateIndex < 0) {
      throw new PlanReducerError(
        "PLAN_TRANSITION_INVALID",
        `Todo '${todo.id}' cannot be removed after its Stage starts.`,
      );
    }
    if (candidateIndex <= previousCandidateIndex) {
      throw new PlanReducerError(
        "PLAN_TRANSITION_INVALID",
        `Todos in started Stage '${draft.id}' cannot be reordered.`,
      );
    }
    previousCandidateIndex = candidateIndex;
  }
}

function validateTodoTransition(previous: PlanTodo, candidate: PlanTodo): void {
  const allowed: Record<PlanTodoStatus, readonly PlanTodoStatus[]> = {
    pending: ["pending", "in_progress", "cancelled"],
    in_progress: ["in_progress", "blocked", "completed", "cancelled"],
    blocked: ["blocked", "in_progress", "cancelled"],
    completed: ["completed", "in_progress"],
    cancelled: ["cancelled"],
  };
  if (!allowed[previous.status].includes(candidate.status)) {
    throw new PlanReducerError(
      "PLAN_TRANSITION_INVALID",
      `Todo '${candidate.id}' cannot move from '${previous.status}' to '${candidate.status}'.`,
    );
  }
  if (previous.status === "completed" && candidate.status === "in_progress") {
    if (
      candidate.reopenReason === undefined ||
      candidate.reopenReason === previous.reopenReason
    ) {
      throw new PlanReducerError(
        "PLAN_TRANSITION_INVALID",
        `Reopened Todo '${candidate.id}' requires a new reopen reason.`,
      );
    }
  }
}

function validateSingleActiveTodo(stages: readonly PlanStage[]): void {
  const activeTodos = stages.flatMap((stage) =>
    stage.todos.filter((todo) => todo.status === "in_progress"),
  );
  if (activeTodos.length > 1) {
    throw new PlanReducerError(
      "PLAN_TRANSITION_INVALID",
      "A Plan may contain at most one in-progress Todo.",
    );
  }
}

function validateStageOrder(stages: readonly PlanStage[]): void {
  let nonterminalSeen = false;
  for (const stage of stages) {
    const terminal =
      stage.status === "completed" || stage.status === "accepted";
    if (terminal) {
      if (nonterminalSeen) {
        throw new PlanReducerError(
          "PLAN_STAGE_LOCKED",
          `Stage '${stage.id}' cannot finish before an earlier Stage.`,
        );
      }
      continue;
    }
    if (!nonterminalSeen) {
      nonterminalSeen = true;
      continue;
    }
    if (stage.status !== "pending") {
      throw new PlanReducerError(
        "PLAN_STAGE_LOCKED",
        `Stage '${stage.id}' cannot start before the current Stage is terminal.`,
      );
    }
  }
}

function assertSnapshotInvariants(plan: PlanSnapshot): void {
  try {
    validateSingleActiveTodo(plan.stages);
    validateStageOrder(plan.stages);
  } catch (error) {
    if (error instanceof PlanReducerError) {
      throw new PlanReducerError("PLAN_INVALID", error.message);
    }
    throw error;
  }
  for (const stage of plan.stages) {
    const allPending = stage.todos.every((todo) => todo.status === "pending");
    const allTerminal = stage.todos.every(
      (todo) => todo.status === "completed" || todo.status === "cancelled",
    );
    const valid =
      (stage.status === "pending" && allPending) ||
      (stage.status === "active" && !allPending && !allTerminal) ||
      (stage.status === "completed" &&
        allTerminal &&
        !stage.requiresAcceptance) ||
      ((stage.status === "awaiting_acceptance" ||
        stage.status === "accepted") &&
        allTerminal &&
        stage.requiresAcceptance &&
        stage.summary !== undefined &&
        stage.evidence.length > 0);
    if (!valid) {
      throw new PlanReducerError(
        "PLAN_INVALID",
        `Stage '${stage.id}' status does not match its Todo and acceptance state.`,
      );
    }
  }
  if (plan.status === "cancelled") {
    return;
  }
  const derived = derivePlanStatus(plan.stages);
  if (plan.status !== derived) {
    throw new PlanReducerError(
      "PLAN_INVALID",
      `Plan status '${plan.status}' does not match derived status '${derived}'.`,
    );
  }
}

function sameStageContent(previous: PlanStage, draft: PlanStageDraft): boolean {
  const { status: _status, ...previousContent } = previous;
  return JSON.stringify(previousContent) === JSON.stringify(draft);
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function schemaError(error: z.ZodError): PlanReducerError {
  const limitExceeded = error.issues.some(
    (issue) =>
      issue.code === "too_big" ||
      issue.message.includes("must not exceed") ||
      issue.message.includes("must not contain more than"),
  );
  return new PlanReducerError(
    limitExceeded ? "PLAN_LIMIT_EXCEEDED" : "PLAN_INVALID",
    error.issues
      .map((issue) => `${issue.path.join(".") || "plan"}: ${issue.message}`)
      .join("; "),
  );
}
