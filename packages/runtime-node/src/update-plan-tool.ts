import {
  PlanReducerError,
  ToolOperationalEventError,
  reducePlanAcceptance,
  reducePlanUpdate,
  rejectPlanAcceptancesBroker,
  type PlanAcceptanceBroker,
  type PlanRuntimeState,
  type ToolRegistry,
} from "@koda/agent-core";
import {
  PLAN_ACCEPTANCE_CRITERION_BUDGET_BYTES,
  PLAN_DETAIL_BUDGET_BYTES,
  PLAN_ID_BUDGET_BYTES,
  PLAN_MAXIMUM_ACCEPTANCE_CRITERIA,
  PLAN_MAXIMUM_EVIDENCE_REFERENCES,
  PLAN_MAXIMUM_STAGES,
  PLAN_MAXIMUM_TODOS_PER_STAGE,
  PLAN_OBJECTIVE_BUDGET_BYTES,
  PLAN_TITLE_BUDGET_BYTES,
  jsonValueSchema,
  planEvidenceReferenceSchema,
  planAcceptanceResolutionSchema,
  planStageIdSchema,
  planTodoIdSchema,
  planTodoStatusSchema,
  type JsonObject,
  type JsonValue,
  type PlanStageDraft,
  type PlanAcceptanceRequest,
  type PlanTodo,
  type PlanUpdateDraft,
} from "@koda/protocol";
import { z } from "zod";

const utf8BoundedString = (maximumBytes: number) =>
  z
    .string()
    .min(1)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= maximumBytes,
      `Text must not exceed ${maximumBytes} UTF-8 bytes.`,
    );

const updatePlanTodoInputSchema = z
  .object({
    id: planTodoIdSchema,
    title: utf8BoundedString(PLAN_TITLE_BUDGET_BYTES),
    status: planTodoStatusSchema,
    outcome: utf8BoundedString(PLAN_DETAIL_BUDGET_BYTES).optional(),
    blocked_reason: utf8BoundedString(PLAN_DETAIL_BUDGET_BYTES).optional(),
    cancellation_reason: utf8BoundedString(PLAN_DETAIL_BUDGET_BYTES).optional(),
    reopen_reason: utf8BoundedString(PLAN_DETAIL_BUDGET_BYTES).optional(),
  })
  .strict();

const updatePlanStageInputSchema = z
  .object({
    id: planStageIdSchema,
    title: utf8BoundedString(PLAN_TITLE_BUDGET_BYTES),
    requires_acceptance: z.boolean(),
    acceptance_criteria: z
      .array(utf8BoundedString(PLAN_ACCEPTANCE_CRITERION_BUDGET_BYTES))
      .max(PLAN_MAXIMUM_ACCEPTANCE_CRITERIA),
    summary: utf8BoundedString(PLAN_DETAIL_BUDGET_BYTES).optional(),
    evidence: z
      .array(planEvidenceReferenceSchema)
      .max(PLAN_MAXIMUM_EVIDENCE_REFERENCES),
    todos: z
      .array(updatePlanTodoInputSchema)
      .min(1)
      .max(PLAN_MAXIMUM_TODOS_PER_STAGE),
  })
  .strict();

export const updatePlanInputSchema = z
  .object({
    expected_revision: z.number().int().safe().nonnegative(),
    objective: utf8BoundedString(PLAN_OBJECTIVE_BUDGET_BYTES),
    explanation: utf8BoundedString(PLAN_DETAIL_BUDGET_BYTES).optional(),
    stages: z.array(updatePlanStageInputSchema).min(1).max(PLAN_MAXIMUM_STAGES),
  })
  .strict();

export interface RegisterUpdatePlanToolOptions {
  acceptances?: PlanAcceptanceBroker;
}

export function registerUpdatePlanTool(
  registry: ToolRegistry,
  state: PlanRuntimeState,
  options: RegisterUpdatePlanToolOptions = {},
): void {
  const acceptances = options.acceptances ?? rejectPlanAcceptancesBroker;
  registry.register({
    spec: {
      name: "update_plan",
      description:
        "Create or replace the durable execution plan for this thread. Keep exactly one Todo in progress, record outcomes for completed work, and use the current expected revision. Koda validates every transition and persists accepted updates before returning success.",
      inputJsonSchema: updatePlanJsonSchema(),
    },
    inputSchema: updatePlanInputSchema,
    concurrency: "exclusive",
    effect: "control",
    execute: async (context, input): Promise<JsonValue> => {
      context.signal.throwIfAborted();
      const previous = state.currentPlan();
      const planId = previous?.planId ?? state.createPlanId();
      let plan;
      try {
        plan = reducePlanUpdate({
          planId,
          ...(previous === undefined ? {} : { previous }),
          update: toPlanUpdateDraft(input),
        });
      } catch (error) {
        if (error instanceof PlanReducerError) {
          throw error;
        }
        throw new PlanReducerError(
          "PLAN_INVALID",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (context.report === undefined) {
        throw new ToolOperationalEventError(
          "update_plan requires a durable operational event recorder.",
        );
      }
      await context.report({
        type: "plan.updated",
        payload: {
          source: "model_update",
          plan,
          ...(input.explanation === undefined
            ? {}
            : { explanation: input.explanation }),
        },
      });
      const awaitingStage = plan.stages.find(
        (stage) => stage.status === "awaiting_acceptance",
      );
      if (awaitingStage === undefined) {
        return jsonValueSchema.parse({ plan });
      }
      const request: PlanAcceptanceRequest = {
        callId: context.callId,
        planId: plan.planId,
        planRevision: plan.revision,
        stageId: awaitingStage.id,
        criteria: awaitingStage.acceptanceCriteria,
        summary: awaitingStage.summary!,
        evidence: awaitingStage.evidence,
      };
      await context.report({
        type: "plan.acceptance_requested",
        payload: withoutCallId(request),
      });
      const resolution = planAcceptanceResolutionSchema.parse(
        await acceptances.request(
          {
            ...request,
            threadId: context.threadId,
            turnId: context.turnId,
          },
          context.signal,
        ),
      );
      if (resolution.callId !== context.callId) {
        throw new PlanReducerError(
          "PLAN_ACCEPTANCE_STALE",
          "The Plan acceptance decision targets another Tool Call.",
        );
      }
      const reduced = reducePlanAcceptance(plan, resolution);
      await context.report({
        type: "plan.acceptance_resolved",
        payload: withoutCallId(resolution),
      });
      if (reduced.status === "changes_requested") {
        return jsonValueSchema.parse({
          plan: reduced.plan,
          acceptance: {
            status: "changes_requested",
            feedback: reduced.feedback,
          },
        });
      }
      await context.report({
        type: "plan.updated",
        payload: {
          source: "runtime_acceptance",
          plan: reduced.plan,
        },
      });
      return jsonValueSchema.parse({
        plan: reduced.plan,
        acceptance: { status: "accepted" },
      });
    },
  });
}

function withoutCallId<T extends { callId: unknown }>(
  value: T,
): Omit<T, "callId"> {
  const { callId: _callId, ...rest } = value;
  return rest;
}

function toPlanUpdateDraft(
  input: z.infer<typeof updatePlanInputSchema>,
): PlanUpdateDraft {
  return {
    expectedRevision: input.expected_revision,
    objective: input.objective,
    ...(input.explanation === undefined
      ? {}
      : { explanation: input.explanation }),
    stages: input.stages.map((stage): PlanStageDraft => ({
      id: stage.id,
      title: stage.title,
      requiresAcceptance: stage.requires_acceptance,
      acceptanceCriteria: stage.acceptance_criteria,
      ...(stage.summary === undefined ? {} : { summary: stage.summary }),
      evidence: stage.evidence,
      todos: stage.todos.map((todo): PlanTodo => ({
        id: todo.id,
        title: todo.title,
        status: todo.status,
        ...(todo.outcome === undefined ? {} : { outcome: todo.outcome }),
        ...(todo.blocked_reason === undefined
          ? {}
          : { blockedReason: todo.blocked_reason }),
        ...(todo.cancellation_reason === undefined
          ? {}
          : { cancellationReason: todo.cancellation_reason }),
        ...(todo.reopen_reason === undefined
          ? {}
          : { reopenReason: todo.reopen_reason }),
      })),
    })),
  };
}

function updatePlanJsonSchema(): JsonObject {
  const boundedText = (maximum: number): JsonObject => ({
    type: "string",
    minLength: 1,
    maxLength: maximum,
  });
  const identifier: JsonObject = {
    type: "string",
    minLength: 1,
    maxLength: PLAN_ID_BUDGET_BYTES,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
  };
  const evidenceReference: JsonObject = {
    oneOf: [
      {
        type: "object",
        properties: { kind: { const: "item" }, itemId: identifier },
        required: ["kind", "itemId"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { kind: { const: "tool_call" }, callId: identifier },
        required: ["kind", "callId"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { kind: { const: "artifact" }, artifactId: identifier },
        required: ["kind", "artifactId"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: { const: "event" },
          sequence: { type: "integer", minimum: 0 },
        },
        required: ["kind", "sequence"],
        additionalProperties: false,
      },
    ],
  };
  const todo: JsonObject = {
    type: "object",
    properties: {
      id: identifier,
      title: boundedText(PLAN_TITLE_BUDGET_BYTES),
      status: {
        type: "string",
        enum: ["pending", "in_progress", "blocked", "completed", "cancelled"],
      },
      outcome: boundedText(PLAN_DETAIL_BUDGET_BYTES),
      blocked_reason: boundedText(PLAN_DETAIL_BUDGET_BYTES),
      cancellation_reason: boundedText(PLAN_DETAIL_BUDGET_BYTES),
      reopen_reason: boundedText(PLAN_DETAIL_BUDGET_BYTES),
    },
    required: ["id", "title", "status"],
    additionalProperties: false,
  };
  const stage: JsonObject = {
    type: "object",
    properties: {
      id: identifier,
      title: boundedText(PLAN_TITLE_BUDGET_BYTES),
      requires_acceptance: { type: "boolean" },
      acceptance_criteria: {
        type: "array",
        items: boundedText(PLAN_ACCEPTANCE_CRITERION_BUDGET_BYTES),
        maxItems: PLAN_MAXIMUM_ACCEPTANCE_CRITERIA,
      },
      summary: boundedText(PLAN_DETAIL_BUDGET_BYTES),
      evidence: {
        type: "array",
        items: evidenceReference,
        maxItems: PLAN_MAXIMUM_EVIDENCE_REFERENCES,
      },
      todos: {
        type: "array",
        items: todo,
        minItems: 1,
        maxItems: PLAN_MAXIMUM_TODOS_PER_STAGE,
      },
    },
    required: [
      "id",
      "title",
      "requires_acceptance",
      "acceptance_criteria",
      "evidence",
      "todos",
    ],
    additionalProperties: false,
  };
  return {
    type: "object",
    properties: {
      expected_revision: { type: "integer", minimum: 0 },
      objective: boundedText(PLAN_OBJECTIVE_BUDGET_BYTES),
      explanation: boundedText(PLAN_DETAIL_BUDGET_BYTES),
      stages: {
        type: "array",
        items: stage,
        minItems: 1,
        maxItems: PLAN_MAXIMUM_STAGES,
      },
    },
    required: ["expected_revision", "objective", "stages"],
    additionalProperties: false,
  };
}
