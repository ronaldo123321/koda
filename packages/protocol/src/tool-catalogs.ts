import { z } from "zod";

import { artifactSha256Schema } from "./artifacts.js";

export const MAX_TOOL_CATALOG_ENTRIES = 512;
export const MAX_TOOL_CATALOG_CHANGES = 512;

export const toolCatalogGenerationIdSchema = z
  .string()
  .regex(
    /^tool-catalog:[a-f0-9]{64}$/u,
    "Tool catalog generation ID must be a sha256 identity.",
  );

export const toolCatalogGenerationSnapshotSchema = z
  .object({
    generationId: toolCatalogGenerationIdSchema,
    toolCount: z
      .number()
      .int()
      .safe()
      .nonnegative()
      .max(MAX_TOOL_CATALOG_ENTRIES),
    toolsSha256: artifactSha256Schema,
  })
  .strict();

export const toolCatalogChangeSchema = z
  .object({
    name: z.string().min(1).max(128),
    change: z.enum(["added", "removed", "changed"]),
    beforeSha256: artifactSha256Schema.optional(),
    afterSha256: artifactSha256Schema.optional(),
  })
  .strict()
  .superRefine((change, context) => {
    const valid =
      (change.change === "added" &&
        change.beforeSha256 === undefined &&
        change.afterSha256 !== undefined) ||
      (change.change === "removed" &&
        change.beforeSha256 !== undefined &&
        change.afterSha256 === undefined) ||
      (change.change === "changed" &&
        change.beforeSha256 !== undefined &&
        change.afterSha256 !== undefined &&
        change.beforeSha256 !== change.afterSha256);
    if (!valid) {
      context.addIssue({
        code: "custom",
        message: "Tool catalog change digests do not match its change kind.",
      });
    }
  });

export const toolCatalogChangedPayloadSchema = z
  .object({
    step: z.number().int().safe().positive(),
    previous: toolCatalogGenerationSnapshotSchema,
    current: toolCatalogGenerationSnapshotSchema,
    changes: z
      .array(toolCatalogChangeSchema)
      .min(1)
      .max(MAX_TOOL_CATALOG_CHANGES),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.previous.generationId === payload.current.generationId) {
      context.addIssue({
        code: "custom",
        message: "A catalog change requires a new generation identity.",
      });
    }
    const names = new Set<string>();
    for (const [index, change] of payload.changes.entries()) {
      if (names.has(change.name)) {
        context.addIssue({
          code: "custom",
          path: ["changes", index, "name"],
          message: `Tool '${change.name}' is duplicated in the catalog diff.`,
        });
      }
      names.add(change.name);
      if (index > 0 && payload.changes[index - 1]!.name >= change.name) {
        context.addIssue({
          code: "custom",
          path: ["changes", index, "name"],
          message: "Tool catalog changes must use stable name ordering.",
        });
      }
    }
  });

export const toolCatalogResumeChangeSchema = z
  .object({
    previous: toolCatalogGenerationSnapshotSchema,
    current: toolCatalogGenerationSnapshotSchema,
  })
  .strict()
  .superRefine((change, context) => {
    if (change.previous.generationId === change.current.generationId) {
      context.addIssue({
        code: "custom",
        message: "A resume catalog change requires different generations.",
      });
    }
  });

export type ToolCatalogGenerationId = z.infer<
  typeof toolCatalogGenerationIdSchema
>;
export type ToolCatalogGenerationSnapshot = z.infer<
  typeof toolCatalogGenerationSnapshotSchema
>;
export type ToolCatalogChange = z.infer<typeof toolCatalogChangeSchema>;
export type ToolCatalogChangedPayload = z.infer<
  typeof toolCatalogChangedPayloadSchema
>;
export type ToolCatalogResumeChange = z.infer<
  typeof toolCatalogResumeChangeSchema
>;
