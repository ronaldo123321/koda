import { z } from "zod";

import { artifactIdSchema } from "./artifacts.js";
import { approvalGrantIdSchema } from "./approval-grants.js";
import { workspaceChangeSetRecoverySchema } from "./change-sets.js";
import { commandTemplateChangeSchema } from "./command-templates.js";
import { itemIdSchema, toolCallIdSchema, turnIdSchema } from "./ids.js";
import { jsonObjectSchema, jsonValueSchema } from "./json.js";
import { modelProviderIdSchema, providerStateSchema } from "./providers.js";
import { planCheckpointSchema, planSnapshotSchema } from "./plans.js";
import { skillChangeSchema } from "./skills.js";
import {
  toolCatalogGenerationIdSchema,
  toolCatalogResumeChangeSchema,
} from "./tool-catalogs.js";

export const CONVERSATION_ITEM_TYPES = [
  "user_message",
  "assistant_message",
  "provider_state",
  "tool_call",
  "tool_result",
  "approval",
  "compaction",
  "recovery",
  "plan_state",
] as const;

export const conversationItemTypeSchema = z.enum(CONVERSATION_ITEM_TYPES);

export const userMessageItemSchema = z.object({
  type: z.literal("user_message"),
  id: itemIdSchema,
  content: z.string(),
});

export const assistantMessageItemSchema = z.object({
  type: z.literal("assistant_message"),
  id: itemIdSchema,
  content: z.string(),
});

export const providerStateItemSchema = z
  .object({
    type: z.literal("provider_state"),
    id: itemIdSchema,
    provider: modelProviderIdSchema,
    data: jsonObjectSchema,
  })
  .strict()
  .superRefine((item, context) => {
    const result = providerStateSchema.safeParse({
      provider: item.provider,
      data: item.data,
    });
    if (!result.success) {
      for (const issue of result.error.issues) {
        context.addIssue({ ...issue, path: ["data", ...issue.path] });
      }
    }
  });

export const toolCallItemSchema = z.object({
  type: z.literal("tool_call"),
  id: itemIdSchema,
  callId: toolCallIdSchema,
  name: z.string().min(1),
  arguments: jsonObjectSchema,
  catalogGenerationId: toolCatalogGenerationIdSchema.optional(),
});

export const toolResultItemSchema = z.object({
  type: z.literal("tool_result"),
  id: itemIdSchema,
  callId: toolCallIdSchema,
  name: z.string().min(1),
  status: z.enum(["success", "error"]),
  output: jsonValueSchema.optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string(),
    })
    .optional(),
});

export const approvalItemSchema = z
  .object({
    type: z.literal("approval"),
    id: itemIdSchema,
    callId: toolCallIdSchema,
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().optional(),
    grantId: approvalGrantIdSchema.optional(),
  })
  .superRefine((item, context) => {
    if (item.grantId !== undefined && item.decision !== "approved") {
      context.addIssue({
        code: "custom",
        message: "Only an approved request can reference a grant.",
        path: ["grantId"],
      });
    }
  });

export const compactionItemSchema = z.object({
  type: z.literal("compaction"),
  id: itemIdSchema,
  reason: z.literal("context_budget").optional(),
  retainedItemIds: z.array(itemIdSchema).optional(),
  estimatedTokensBefore: z.number().int().nonnegative().optional(),
  estimatedTokensAfter: z.number().int().nonnegative().optional(),
  summary: z.object({
    objective: z.string(),
    decisions: z.array(z.string()),
    modifiedFiles: z.array(z.string()),
    completedWork: z.array(z.string()),
    pendingWork: z.array(z.string()),
    failedAttempts: z.array(z.string()),
    criticalFacts: z.array(z.string()),
  }),
});

export const recoveryItemSchema = z.object({
  type: z.literal("recovery"),
  id: itemIdSchema,
  previousTurnId: turnIdSchema,
  previousStatus: z.enum([
    "completed",
    "failed",
    "cancelled",
    "paused",
    "interrupted",
  ]),
  message: z.string().min(1),
  partialTrailingEventDiscarded: z.boolean(),
  unavailableArtifacts: z
    .array(
      z.object({
        id: artifactIdSchema,
        reason: z.enum(["missing", "corrupt"]),
      }),
    )
    .default([]),
  instructionChanges: z
    .array(
      z.object({
        path: z.string().min(1),
        scope: z.string().min(1),
        change: z.enum(["added", "removed", "changed"]),
      }),
    )
    .default([]),
  skillChanges: z.array(skillChangeSchema).default([]),
  commandTemplateChanges: z.array(commandTemplateChangeSchema).default([]),
  toolCatalogGenerationChange: toolCatalogResumeChangeSchema.optional(),
  uncertainToolCalls: z.array(
    z.object({
      callId: toolCallIdSchema,
      name: z.string().min(1),
      effect: z.enum(["read", "control", "write", "execute"]).optional(),
      process: z
        .object({
          pid: z.number().int().positive(),
          ownership: z.enum([
            "posix_process_group",
            "windows_taskkill_tree",
            "direct_child",
          ]),
          status: z.enum([
            "exited",
            "terminated",
            "already_exited",
            "uncertain",
          ]),
          exitCode: z.number().int().nullable().optional(),
          signal: z.string().min(1).nullable().optional(),
        })
        .optional(),
    }),
  ),
  workspaceChangeSets: z
    .array(workspaceChangeSetRecoverySchema)
    .max(16)
    .default([]),
});

export const planStateItemSchema = z
  .object({
    type: z.literal("plan_state"),
    id: itemIdSchema,
    plan: planSnapshotSchema,
    checkpoint: planCheckpointSchema.optional(),
    needsRevalidation: z.boolean(),
    checkpointRecommended: z.boolean(),
  })
  .strict()
  .superRefine((item, context) => {
    if (
      item.checkpoint !== undefined &&
      (item.checkpoint.planId !== item.plan.planId ||
        item.checkpoint.planRevision > item.plan.revision)
    ) {
      context.addIssue({
        code: "custom",
        message: "Plan checkpoint does not belong to the active Plan revision.",
        path: ["checkpoint"],
      });
    }
  });

export const conversationItemSchema = z.discriminatedUnion("type", [
  userMessageItemSchema,
  assistantMessageItemSchema,
  providerStateItemSchema,
  toolCallItemSchema,
  toolResultItemSchema,
  approvalItemSchema,
  compactionItemSchema,
  recoveryItemSchema,
  planStateItemSchema,
]);

export type UserMessageItem = z.infer<typeof userMessageItemSchema>;
export type AssistantMessageItem = z.infer<typeof assistantMessageItemSchema>;
export type ProviderStateItem = z.infer<typeof providerStateItemSchema>;
export type ToolCallItem = z.infer<typeof toolCallItemSchema>;
export type ToolResultItem = z.infer<typeof toolResultItemSchema>;
export type ApprovalItem = z.infer<typeof approvalItemSchema>;
export type CompactionItem = z.infer<typeof compactionItemSchema>;
export type RecoveryItem = z.infer<typeof recoveryItemSchema>;
export type PlanStateItem = z.infer<typeof planStateItemSchema>;
export type ConversationItem = z.infer<typeof conversationItemSchema>;
export type ConversationItemType = z.infer<typeof conversationItemTypeSchema>;
