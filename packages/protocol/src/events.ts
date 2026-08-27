import { z } from "zod";

import {
  itemIdSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
} from "./ids.js";
import { conversationItemSchema } from "./items.js";
import { artifactReferenceSchema } from "./artifacts.js";
import {
  approvalGrantCandidateSchema,
  approvalGrantIdSchema,
  approvalGrantKeySchema,
  approvalGrantKindSchema,
  approvalGrantRecordSchema,
} from "./approval-grants.js";
import {
  workspaceChangeSetCommittedPayloadSchema,
  workspaceChangeSetPreparedPayloadSchema,
  workspaceChangeSetRolledBackPayloadSchema,
  workspaceChangeSetUncertainPayloadSchema,
} from "./change-sets.js";
import { tokenUsageSchema, turnUsageSchema } from "./usage.js";
import {
  contextPreparedPayloadSchema,
  turnContextSnapshotSchema,
} from "./context.js";

const metadataShape = {
  schemaVersion: z.literal(1),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().datetime({ offset: true }),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
};

function utf8BoundedString(maximumBytes: number) {
  return z
    .string()
    .min(1)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= maximumBytes,
      `Text must not exceed ${maximumBytes} UTF-8 bytes.`,
    );
}

const approvalResolvedPayloadSchema = z
  .object({
    callId: toolCallIdSchema,
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().optional(),
    grantId: approvalGrantIdSchema.optional(),
  })
  .superRefine((payload, context) => {
    if (payload.grantId !== undefined && payload.decision !== "approved") {
      context.addIssue({
        code: "custom",
        message: "Only an approved request can reference a grant.",
        path: ["grantId"],
      });
    }
  });

export const toolEffectSchema = z.enum(["read", "write", "execute"]);
export const processOwnershipSchema = z.enum([
  "posix_process_group",
  "windows_taskkill_tree",
  "direct_child",
]);
export const processTerminationReasonSchema = z.enum([
  "timeout",
  "cancellation",
  "orphan_cleanup",
  "output_failure",
]);
export const processTerminationAttemptSchema = z.enum(["graceful", "force"]);
export const processTerminationMechanismSchema = z.enum([
  "posix_process_group_signal",
  "windows_taskkill",
  "direct_child_signal",
]);
export const processTerminationOutcomeSchema = z.enum([
  "terminated",
  "already_exited",
  "uncertain",
]);

export const agentEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...metadataShape,
    type: z.literal("turn.started"),
    payload: z.object({}),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("turn.context"),
    payload: turnContextSnapshotSchema,
  }),
  z.object({
    ...metadataShape,
    type: z.literal("context.prepared"),
    payload: contextPreparedPayloadSchema,
  }),
  z.object({
    ...metadataShape,
    type: z.literal("assistant.delta"),
    payload: z.object({ text: z.string().min(1) }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("model.usage"),
    payload: z.object({
      step: z.number().int().positive(),
      responseId: z.string().min(1).optional(),
      usage: tokenUsageSchema,
    }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("item.recorded"),
    payload: z.object({ item: conversationItemSchema }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("artifact.recorded"),
    payload: z.object({
      callId: toolCallIdSchema,
      name: z.string().min(1),
      artifact: artifactReferenceSchema,
    }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("tool.started"),
    payload: z.object({
      callId: toolCallIdSchema,
      name: z.string().min(1),
      executionBoundary: z.literal(true).optional(),
    }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("tool.execution_started"),
    payload: z.object({
      callId: toolCallIdSchema,
      name: z.string().min(1),
      effect: toolEffectSchema,
    }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("process.started"),
    payload: z.object({
      callId: toolCallIdSchema,
      name: z.string().min(1),
      pid: z.number().int().positive(),
      ownership: processOwnershipSchema,
    }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("process.exited"),
    payload: z.object({
      callId: toolCallIdSchema,
      name: z.string().min(1),
      pid: z.number().int().positive(),
      exitCode: z.number().int().nullable(),
      signal: z.string().min(1).nullable(),
    }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("process.termination_requested"),
    payload: z.object({
      callId: toolCallIdSchema,
      name: z.string().min(1),
      pid: z.number().int().positive(),
      reason: processTerminationReasonSchema,
      attempt: processTerminationAttemptSchema,
      mechanism: processTerminationMechanismSchema,
    }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("process.termination_completed"),
    payload: z.object({
      callId: toolCallIdSchema,
      name: z.string().min(1),
      pid: z.number().int().positive(),
      reason: processTerminationReasonSchema,
      outcome: processTerminationOutcomeSchema,
    }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("workspace.change_set_prepared"),
    payload: z.object({
      callId: toolCallIdSchema,
      name: z.string().min(1),
      ...workspaceChangeSetPreparedPayloadSchema.shape,
    }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("workspace.change_set_committed"),
    payload: z.object({
      callId: toolCallIdSchema,
      name: z.string().min(1),
      ...workspaceChangeSetCommittedPayloadSchema.shape,
    }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("workspace.change_set_rolled_back"),
    payload: z.object({
      callId: toolCallIdSchema,
      name: z.string().min(1),
      ...workspaceChangeSetRolledBackPayloadSchema.shape,
    }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("workspace.change_set_uncertain"),
    payload: z.object({
      callId: toolCallIdSchema,
      name: z.string().min(1),
      ...workspaceChangeSetUncertainPayloadSchema.shape,
    }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("approval.requested"),
    payload: z.object({
      callId: toolCallIdSchema,
      name: z.string().min(1),
      title: utf8BoundedString(1_024),
      summary: utf8BoundedString(16_384),
      details: utf8BoundedString(524_288),
      reason: utf8BoundedString(4_096),
      grantCandidate: approvalGrantCandidateSchema.optional(),
    }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("approval.resolved"),
    payload: approvalResolvedPayloadSchema,
  }),
  z.object({
    ...metadataShape,
    type: z.literal("approval.grant_created"),
    payload: z.object({
      callId: toolCallIdSchema,
      grant: approvalGrantRecordSchema,
    }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("approval.grant_used"),
    payload: z.object({
      callId: toolCallIdSchema,
      grantId: approvalGrantIdSchema,
      kind: approvalGrantKindSchema,
      name: z.literal("exec_command"),
      key: approvalGrantKeySchema,
      expiresAt: z.string().datetime({ offset: true }),
    }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("tool.completed"),
    payload: z.object({
      callId: toolCallIdSchema,
      name: z.string().min(1),
      status: z.enum(["success", "error"]),
    }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("turn.completed"),
    payload: z.object({
      finalMessageId: itemIdSchema.optional(),
      steps: z.number().int().positive(),
      usage: turnUsageSchema.optional(),
    }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("turn.cancelled"),
    payload: z.object({
      reason: z.string(),
      usage: turnUsageSchema.optional(),
    }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("turn.failed"),
    payload: z.object({
      code: z.string().min(1),
      message: z.string(),
      usage: turnUsageSchema.optional(),
    }),
  }),
]);

export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentEventType = AgentEvent["type"];
export type ProcessOwnership = z.infer<typeof processOwnershipSchema>;
export type ProcessTerminationReason = z.infer<
  typeof processTerminationReasonSchema
>;
export type ProcessTerminationAttempt = z.infer<
  typeof processTerminationAttemptSchema
>;
export type ProcessTerminationMechanism = z.infer<
  typeof processTerminationMechanismSchema
>;
export type ProcessTerminationOutcome = z.infer<
  typeof processTerminationOutcomeSchema
>;
