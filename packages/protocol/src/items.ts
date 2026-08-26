import { z } from "zod";

import { artifactIdSchema } from "./artifacts.js";
import { itemIdSchema, toolCallIdSchema, turnIdSchema } from "./ids.js";
import { jsonObjectSchema, jsonValueSchema } from "./json.js";

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

export const toolCallItemSchema = z.object({
  type: z.literal("tool_call"),
  id: itemIdSchema,
  callId: toolCallIdSchema,
  name: z.string().min(1),
  arguments: jsonObjectSchema,
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

export const approvalItemSchema = z.object({
  type: z.literal("approval"),
  id: itemIdSchema,
  callId: toolCallIdSchema,
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().optional(),
});

export const compactionItemSchema = z.object({
  type: z.literal("compaction"),
  id: itemIdSchema,
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
  previousStatus: z.enum(["completed", "failed", "cancelled", "interrupted"]),
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
  uncertainToolCalls: z.array(
    z.object({
      callId: toolCallIdSchema,
      name: z.string().min(1),
    }),
  ),
});

export const conversationItemSchema = z.discriminatedUnion("type", [
  userMessageItemSchema,
  assistantMessageItemSchema,
  toolCallItemSchema,
  toolResultItemSchema,
  approvalItemSchema,
  compactionItemSchema,
  recoveryItemSchema,
]);

export type UserMessageItem = z.infer<typeof userMessageItemSchema>;
export type AssistantMessageItem = z.infer<typeof assistantMessageItemSchema>;
export type ToolCallItem = z.infer<typeof toolCallItemSchema>;
export type ToolResultItem = z.infer<typeof toolResultItemSchema>;
export type ApprovalItem = z.infer<typeof approvalItemSchema>;
export type CompactionItem = z.infer<typeof compactionItemSchema>;
export type RecoveryItem = z.infer<typeof recoveryItemSchema>;
export type ConversationItem = z.infer<typeof conversationItemSchema>;
