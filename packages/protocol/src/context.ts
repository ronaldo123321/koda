import { z } from "zod";

import { artifactSha256Schema } from "./artifacts.js";
import {
  commandTemplateActivationSchema,
  commandTemplateSnapshotSchema,
  MAX_PROJECT_COMMAND_TEMPLATES,
} from "./command-templates.js";
import { itemIdSchema } from "./ids.js";
import { planCheckpointIdSchema, planIdSchema } from "./plans.js";
import {
  CONVERSATION_ITEM_TYPES,
  conversationItemTypeSchema,
} from "./items.js";
import { modelProviderIdSchema } from "./providers.js";
import { MAX_PROJECT_SKILLS, skillSnapshotSchema } from "./skills.js";
import {
  toolCatalogGenerationIdSchema,
  toolCatalogGenerationSnapshotSchema,
} from "./tool-catalogs.js";

export const repositoryInstructionSnapshotSchema = z.object({
  path: z.string().min(1),
  scope: z.string().min(1).default("."),
  bytes: z.number().int().nonnegative(),
  sha256: artifactSha256Schema,
});

export const turnContextSnapshotSchema = z.object({
  provider: modelProviderIdSchema,
  model: z.string().min(1),
  workspaceRoot: z.string().min(1),
  approvalMode: z.enum(["on-request", "never"]),
  instructionsSha256: artifactSha256Schema,
  repositoryInstructions: z.array(repositoryInstructionSnapshotSchema),
  skills: z.array(skillSnapshotSchema).max(MAX_PROJECT_SKILLS).default([]),
  commandTemplates: z
    .array(commandTemplateSnapshotSchema)
    .max(MAX_PROJECT_COMMAND_TEMPLATES)
    .default([]),
  commandTemplateActivation: commandTemplateActivationSchema.optional(),
  toolCatalogGeneration: toolCatalogGenerationSnapshotSchema.optional(),
});

export const contextPreparedPayloadSchema = z
  .object({
    step: z.number().int().positive(),
    contextWindowTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    safetyMarginTokens: z.number().int().nonnegative(),
    inputBudgetTokens: z.number().int().positive(),
    fixedInputTokens: z.number().int().nonnegative(),
    rawEstimatedInputTokens: z.number().int().nonnegative(),
    estimatedInputTokens: z.number().int().nonnegative(),
    calibrationFactor: z.number().min(1).max(8),
    activeItemCount: z.number().int().nonnegative(),
    activeItemTypes: z.array(
      z
        .object({
          type: conversationItemTypeSchema,
          count: z.number().int().positive(),
        })
        .strict(),
    ),
    activeItemsSha256: artifactSha256Schema,
    toolCount: z.number().int().nonnegative(),
    toolsSha256: artifactSha256Schema,
    toolCatalogGenerationId: toolCatalogGenerationIdSchema.optional(),
    compactionItemId: itemIdSchema.optional(),
    planState: z
      .object({
        itemId: itemIdSchema,
        planId: planIdSchema,
        planRevision: z.number().int().safe().positive(),
        checkpointId: planCheckpointIdSchema.optional(),
        needsRevalidation: z.boolean(),
        checkpointRecommended: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    const seen = new Set<string>();
    let total = 0;
    for (const [index, entry] of payload.activeItemTypes.entries()) {
      if (seen.has(entry.type)) {
        context.addIssue({
          code: "custom",
          message: `Item type '${entry.type}' is duplicated.`,
          path: ["activeItemTypes", index, "type"],
        });
      }
      seen.add(entry.type);
      total += entry.count;
      if (
        index > 0 &&
        CONVERSATION_ITEM_TYPES.indexOf(entry.type) <=
          CONVERSATION_ITEM_TYPES.indexOf(
            payload.activeItemTypes[index - 1]?.type ?? entry.type,
          )
      ) {
        context.addIssue({
          code: "custom",
          message: "Active Item type counts must use stable type ordering.",
          path: ["activeItemTypes", index, "type"],
        });
      }
    }
    if (total !== payload.activeItemCount) {
      context.addIssue({
        code: "custom",
        message: "Active Item type counts must equal activeItemCount.",
        path: ["activeItemTypes"],
      });
    }
    if (
      payload.contextWindowTokens -
        payload.maxOutputTokens -
        payload.safetyMarginTokens !==
      payload.inputBudgetTokens
    ) {
      context.addIssue({
        code: "custom",
        message: "Input budget must match the recorded context reserves.",
        path: ["inputBudgetTokens"],
      });
    }
  });

export type RepositoryInstructionSnapshot = z.infer<
  typeof repositoryInstructionSnapshotSchema
>;
export type TurnContextSnapshot = z.infer<typeof turnContextSnapshotSchema>;
export type ContextPreparedPayload = z.infer<
  typeof contextPreparedPayloadSchema
>;
