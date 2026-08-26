import { z } from "zod";

import {
  itemIdSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
} from "./ids.js";
import { conversationItemSchema } from "./items.js";

const metadataShape = {
  schemaVersion: z.literal(1),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().datetime({ offset: true }),
  threadId: threadIdSchema,
  turnId: turnIdSchema,
};

export const agentEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...metadataShape,
    type: z.literal("turn.started"),
    payload: z.object({}),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("assistant.delta"),
    payload: z.object({ text: z.string().min(1) }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("item.recorded"),
    payload: z.object({ item: conversationItemSchema }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("tool.started"),
    payload: z.object({
      callId: toolCallIdSchema,
      name: z.string().min(1),
    }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("approval.requested"),
    payload: z.object({
      callId: toolCallIdSchema,
      name: z.string().min(1),
      title: z.string().min(1),
      summary: z.string().min(1),
      details: z.string().min(1),
      reason: z.string().min(1),
    }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("approval.resolved"),
    payload: z.object({
      callId: toolCallIdSchema,
      decision: z.enum(["approved", "rejected"]),
      reason: z.string().optional(),
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
    }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("turn.cancelled"),
    payload: z.object({ reason: z.string() }),
  }),
  z.object({
    ...metadataShape,
    type: z.literal("turn.failed"),
    payload: z.object({
      code: z.string().min(1),
      message: z.string(),
    }),
  }),
]);

export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentEventType = AgentEvent["type"];
