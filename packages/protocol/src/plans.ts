import { z } from "zod";

import { artifactIdSchema } from "./artifacts.js";
import { itemIdSchema, toolCallIdSchema } from "./ids.js";
import { turnUsageSchema } from "./usage.js";

export const PLAN_MAXIMUM_STAGES = 32;
export const PLAN_MAXIMUM_TODOS_PER_STAGE = 64;
export const PLAN_MAXIMUM_TODOS = 256;
export const PLAN_MAXIMUM_ACCEPTANCE_CRITERIA = 32;
export const PLAN_MAXIMUM_EVIDENCE_REFERENCES = 32;
export const PLAN_SNAPSHOT_BUDGET_BYTES = 256 * 1_024;
export const PLAN_ID_BUDGET_BYTES = 128;
export const PLAN_TITLE_BUDGET_BYTES = 1_024;
export const PLAN_OBJECTIVE_BUDGET_BYTES = 16_384;
export const PLAN_DETAIL_BUDGET_BYTES = 16_384;
export const PLAN_ACCEPTANCE_CRITERION_BUDGET_BYTES = 4_096;

const utf8BoundedString = (maximumBytes: number) =>
  z
    .string()
    .min(1)
    .refine(
      (value) => utf8Bytes(value) <= maximumBytes,
      `Text must not exceed ${maximumBytes} UTF-8 bytes.`,
    );

const opaquePlanIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u,
    "Identifier must be bounded ASCII without whitespace.",
  );

export const planIdSchema = opaquePlanIdSchema.brand<"PlanId">();
export const planStageIdSchema = opaquePlanIdSchema.brand<"PlanStageId">();
export const planTodoIdSchema = opaquePlanIdSchema.brand<"PlanTodoId">();
export const planCheckpointIdSchema =
  opaquePlanIdSchema.brand<"PlanCheckpointId">();

export const planTodoStatusSchema = z.enum([
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
]);

export const planStageStatusSchema = z.enum([
  "pending",
  "active",
  "awaiting_acceptance",
  "completed",
  "accepted",
]);

export const planStatusSchema = z.enum(["active", "completed", "cancelled"]);

export const planEvidenceReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("item"), itemId: itemIdSchema }).strict(),
  z.object({ kind: z.literal("tool_call"), callId: toolCallIdSchema }).strict(),
  z
    .object({ kind: z.literal("artifact"), artifactId: artifactIdSchema })
    .strict(),
  z
    .object({
      kind: z.literal("event"),
      sequence: z.number().int().safe().nonnegative(),
    })
    .strict(),
]);

const planTodoShape = {
  id: planTodoIdSchema,
  title: utf8BoundedString(PLAN_TITLE_BUDGET_BYTES),
  status: planTodoStatusSchema,
  outcome: utf8BoundedString(PLAN_DETAIL_BUDGET_BYTES).optional(),
  blockedReason: utf8BoundedString(PLAN_DETAIL_BUDGET_BYTES).optional(),
  cancellationReason: utf8BoundedString(PLAN_DETAIL_BUDGET_BYTES).optional(),
  reopenReason: utf8BoundedString(PLAN_DETAIL_BUDGET_BYTES).optional(),
};

export const planTodoSchema = z
  .object(planTodoShape)
  .strict()
  .superRefine((todo, context) => {
    if (todo.status === "completed" && todo.outcome === undefined) {
      context.addIssue({
        code: "custom",
        message: "A completed Todo requires an outcome.",
        path: ["outcome"],
      });
    }
    if (todo.status === "blocked" && todo.blockedReason === undefined) {
      context.addIssue({
        code: "custom",
        message: "A blocked Todo requires a blocked reason.",
        path: ["blockedReason"],
      });
    }
    if (todo.status === "cancelled" && todo.cancellationReason === undefined) {
      context.addIssue({
        code: "custom",
        message: "A cancelled Todo requires a cancellation reason.",
        path: ["cancellationReason"],
      });
    }
  });

const planStageContentShape = {
  id: planStageIdSchema,
  title: utf8BoundedString(PLAN_TITLE_BUDGET_BYTES),
  requiresAcceptance: z.boolean(),
  acceptanceCriteria: z
    .array(utf8BoundedString(PLAN_ACCEPTANCE_CRITERION_BUDGET_BYTES))
    .max(PLAN_MAXIMUM_ACCEPTANCE_CRITERIA),
  summary: utf8BoundedString(PLAN_DETAIL_BUDGET_BYTES).optional(),
  evidence: z
    .array(planEvidenceReferenceSchema)
    .max(PLAN_MAXIMUM_EVIDENCE_REFERENCES),
  todos: z.array(planTodoSchema).min(1).max(PLAN_MAXIMUM_TODOS_PER_STAGE),
};

export const planStageDraftSchema = z
  .object(planStageContentShape)
  .strict()
  .superRefine(refineStageContent);

export const planStageSchema = z
  .object({
    ...planStageContentShape,
    status: planStageStatusSchema,
  })
  .strict()
  .superRefine(refineStageContent);

const planSnapshotBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    planId: planIdSchema,
    revision: z.number().int().safe().positive(),
    objective: utf8BoundedString(PLAN_OBJECTIVE_BUDGET_BYTES),
    status: planStatusSchema,
    stages: z.array(planStageSchema).min(1).max(PLAN_MAXIMUM_STAGES),
  })
  .strict();

export const planSnapshotSchema = planSnapshotBaseSchema.superRefine(
  (plan, context) => {
    refinePlanCollections(plan, context);
    if (jsonUtf8Bytes(plan) > PLAN_SNAPSHOT_BUDGET_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Plan snapshot must not exceed ${PLAN_SNAPSHOT_BUDGET_BYTES} UTF-8 bytes.`,
      });
    }
  },
);

export const planUpdateDraftSchema = z
  .object({
    expectedRevision: z.number().int().safe().nonnegative(),
    objective: utf8BoundedString(PLAN_OBJECTIVE_BUDGET_BYTES),
    explanation: utf8BoundedString(PLAN_DETAIL_BUDGET_BYTES).optional(),
    stages: z.array(planStageDraftSchema).min(1).max(PLAN_MAXIMUM_STAGES),
  })
  .strict()
  .superRefine((draft, context) => {
    refinePlanCollections(draft, context);
    if (jsonUtf8Bytes(draft) > PLAN_SNAPSHOT_BUDGET_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Plan update must not exceed ${PLAN_SNAPSHOT_BUDGET_BYTES} UTF-8 bytes.`,
      });
    }
  });

export const planCheckpointReasonSchema = z.enum([
  "plan_update",
  "tool_completion",
  "stage_acceptance",
  "turn_completion",
  "safe_pause",
]);

export const planCheckpointSchema = z
  .object({
    checkpointId: planCheckpointIdSchema,
    planId: planIdSchema,
    planRevision: z.number().int().safe().positive(),
    activeStageId: planStageIdSchema.optional(),
    activeTodoId: planTodoIdSchema.optional(),
    lastSafeSequence: z.number().int().safe().nonnegative(),
    reason: planCheckpointReasonSchema,
    completedSummary: utf8BoundedString(PLAN_DETAIL_BUDGET_BYTES).optional(),
    nextAction: utf8BoundedString(PLAN_DETAIL_BUDGET_BYTES).optional(),
    evidence: z
      .array(planEvidenceReferenceSchema)
      .max(PLAN_MAXIMUM_EVIDENCE_REFERENCES),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    if (
      checkpoint.activeTodoId !== undefined &&
      checkpoint.activeStageId === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "An active Todo checkpoint requires an active Stage.",
        path: ["activeStageId"],
      });
    }
  });

export const planAcceptanceDecisionSchema = z.enum([
  "accepted",
  "changes_requested",
]);

export const planAcceptanceRequestSchema = z
  .object({
    callId: toolCallIdSchema,
    planId: planIdSchema,
    planRevision: z.number().int().safe().positive(),
    stageId: planStageIdSchema,
    criteria: z
      .array(utf8BoundedString(PLAN_ACCEPTANCE_CRITERION_BUDGET_BYTES))
      .min(1)
      .max(PLAN_MAXIMUM_ACCEPTANCE_CRITERIA),
    summary: utf8BoundedString(PLAN_DETAIL_BUDGET_BYTES),
    evidence: z
      .array(planEvidenceReferenceSchema)
      .min(1)
      .max(PLAN_MAXIMUM_EVIDENCE_REFERENCES),
  })
  .strict();

export const planAcceptanceResolutionSchema = z
  .object({
    callId: toolCallIdSchema,
    planId: planIdSchema,
    planRevision: z.number().int().safe().positive(),
    stageId: planStageIdSchema,
    decision: planAcceptanceDecisionSchema,
    feedback: utf8BoundedString(PLAN_DETAIL_BUDGET_BYTES).optional(),
  })
  .strict()
  .superRefine((resolution, context) => {
    if (
      resolution.decision === "changes_requested" &&
      resolution.feedback === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Requested changes require feedback.",
        path: ["feedback"],
      });
    }
  });

export const planUpdatedPayloadSchema = z
  .object({
    callId: toolCallIdSchema,
    source: z.enum(["model_update", "runtime_acceptance"]),
    plan: planSnapshotSchema,
    explanation: utf8BoundedString(PLAN_DETAIL_BUDGET_BYTES).optional(),
  })
  .strict();

export const planCheckpointedPayloadSchema = z
  .object({ checkpoint: planCheckpointSchema })
  .strict();

export const planAcceptanceRequestedPayloadSchema = planAcceptanceRequestSchema;
export const planAcceptanceResolvedPayloadSchema =
  planAcceptanceResolutionSchema;

export const turnPausedReasonSchema = z.enum([
  "step_budget",
  "time_budget",
  "stage_acceptance",
  "user_request",
]);

export const turnPausedPayloadSchema = z
  .object({
    reason: turnPausedReasonSchema,
    checkpointId: planCheckpointIdSchema,
    usage: turnUsageSchema.optional(),
  })
  .strict();

export const planErrorCodeSchema = z.enum([
  "PLAN_INVALID",
  "PLAN_TRANSITION_INVALID",
  "PLAN_REVISION_CONFLICT",
  "PLAN_STAGE_LOCKED",
  "PLAN_ACCEPTANCE_NOT_PENDING",
  "PLAN_ACCEPTANCE_STALE",
  "PLAN_LIMIT_EXCEEDED",
  "PLAN_CHECKPOINT_INVALID",
  "PLAN_RECOVERY_INVALID",
]);

function refineStageContent(
  stage: {
    requiresAcceptance: boolean;
    acceptanceCriteria: readonly string[];
  },
  context: z.RefinementCtx,
): void {
  if (stage.requiresAcceptance && stage.acceptanceCriteria.length === 0) {
    context.addIssue({
      code: "custom",
      message: "A gated Stage requires at least one acceptance criterion.",
      path: ["acceptanceCriteria"],
    });
  }
}

function refinePlanCollections(
  plan: {
    stages: readonly {
      id: string;
      todos: readonly { id: string }[];
    }[];
  },
  context: z.RefinementCtx,
): void {
  const stageIds = new Set<string>();
  const todoIds = new Set<string>();
  let todoCount = 0;
  for (const [stageIndex, stage] of plan.stages.entries()) {
    if (stageIds.has(stage.id)) {
      context.addIssue({
        code: "custom",
        message: "Stage IDs must be unique within a Plan.",
        path: ["stages", stageIndex, "id"],
      });
    }
    stageIds.add(stage.id);
    for (const [todoIndex, todo] of stage.todos.entries()) {
      todoCount += 1;
      if (todoIds.has(todo.id)) {
        context.addIssue({
          code: "custom",
          message: "Todo IDs must be unique within a Plan.",
          path: ["stages", stageIndex, "todos", todoIndex, "id"],
        });
      }
      todoIds.add(todo.id);
    }
  }
  if (todoCount > PLAN_MAXIMUM_TODOS) {
    context.addIssue({
      code: "custom",
      message: `Plan must not contain more than ${PLAN_MAXIMUM_TODOS} Todos.`,
      path: ["stages"],
    });
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function jsonUtf8Bytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}

export type PlanId = z.infer<typeof planIdSchema>;
export type PlanStageId = z.infer<typeof planStageIdSchema>;
export type PlanTodoId = z.infer<typeof planTodoIdSchema>;
export type PlanCheckpointId = z.infer<typeof planCheckpointIdSchema>;
export type PlanTodoStatus = z.infer<typeof planTodoStatusSchema>;
export type PlanStageStatus = z.infer<typeof planStageStatusSchema>;
export type PlanStatus = z.infer<typeof planStatusSchema>;
export type PlanEvidenceReference = z.infer<typeof planEvidenceReferenceSchema>;
export type PlanTodo = z.infer<typeof planTodoSchema>;
export type PlanStageDraft = z.infer<typeof planStageDraftSchema>;
export type PlanStage = z.infer<typeof planStageSchema>;
export type PlanSnapshot = z.infer<typeof planSnapshotSchema>;
export type PlanUpdateDraft = z.infer<typeof planUpdateDraftSchema>;
export type PlanCheckpointReason = z.infer<typeof planCheckpointReasonSchema>;
export type PlanCheckpoint = z.infer<typeof planCheckpointSchema>;
export type PlanAcceptanceDecision = z.infer<
  typeof planAcceptanceDecisionSchema
>;
export type PlanAcceptanceRequest = z.infer<typeof planAcceptanceRequestSchema>;
export type PlanAcceptanceResolution = z.infer<
  typeof planAcceptanceResolutionSchema
>;
export type PlanUpdatedPayload = z.infer<typeof planUpdatedPayloadSchema>;
export type PlanCheckpointedPayload = z.infer<
  typeof planCheckpointedPayloadSchema
>;
export type PlanAcceptanceRequestedPayload = z.infer<
  typeof planAcceptanceRequestedPayloadSchema
>;
export type PlanAcceptanceResolvedPayload = z.infer<
  typeof planAcceptanceResolvedPayloadSchema
>;
export type TurnPausedReason = z.infer<typeof turnPausedReasonSchema>;
export type TurnPausedPayload = z.infer<typeof turnPausedPayloadSchema>;
export type PlanErrorCode = z.infer<typeof planErrorCodeSchema>;
