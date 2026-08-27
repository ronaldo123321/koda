import { z } from "zod";

import { artifactSha256Schema } from "./artifacts.js";

export const CHANGE_SET_MAXIMUM_CHANGES = 16;
export const CHANGE_SET_PATH_BUDGET_BYTES = 4_096;
export const CHANGE_SET_ERROR_CODE_MAXIMUM_CHARACTERS = 128;

export const workspaceChangePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <=
      CHANGE_SET_PATH_BUDGET_BYTES,
    `Path must not exceed ${CHANGE_SET_PATH_BUDGET_BYTES} UTF-8 bytes.`,
  );

export const workspaceChangeOperationSchema = z.enum([
  "create",
  "update",
  "move",
  "delete",
]);

export const workspaceChangeEvidenceSchema = z
  .object({
    index: z
      .number()
      .int()
      .min(0)
      .max(CHANGE_SET_MAXIMUM_CHANGES - 1),
    operation: workspaceChangeOperationSchema,
    path: workspaceChangePathSchema,
    destination: workspaceChangePathSchema.optional(),
    beforeSha256: artifactSha256Schema.nullable(),
    afterSha256: artifactSha256Schema.nullable(),
    bytes: z.number().int().nonnegative().max(1_000_000),
  })
  .strict()
  .superRefine((change, context) => {
    const valid =
      (change.operation === "create" &&
        change.destination === undefined &&
        change.beforeSha256 === null &&
        change.afterSha256 !== null) ||
      (change.operation === "update" &&
        change.destination === undefined &&
        change.beforeSha256 !== null &&
        change.afterSha256 !== null) ||
      (change.operation === "move" &&
        change.destination !== undefined &&
        change.beforeSha256 !== null &&
        change.beforeSha256 === change.afterSha256) ||
      (change.operation === "delete" &&
        change.destination === undefined &&
        change.beforeSha256 !== null &&
        change.afterSha256 === null);
    if (!valid) {
      context.addIssue({
        code: "custom",
        message: "Change evidence does not match its operation semantics.",
      });
    }
  });

const planSha256Shape = {
  planSha256: artifactSha256Schema,
};

export const workspaceChangeSetPreparedPayloadSchema = z
  .object({
    ...planSha256Shape,
    changes: z
      .array(workspaceChangeEvidenceSchema)
      .min(1)
      .max(CHANGE_SET_MAXIMUM_CHANGES),
  })
  .strict()
  .superRefine((payload, context) => {
    const endpoints = new Set<string>();
    for (const [index, change] of payload.changes.entries()) {
      if (change.index !== index) {
        context.addIssue({
          code: "custom",
          message: "Change evidence indexes must be contiguous and ordered.",
          path: ["changes", index, "index"],
        });
      }
      for (const endpoint of [change.path, change.destination]) {
        if (endpoint === undefined) {
          continue;
        }
        if (endpoints.has(endpoint)) {
          context.addIssue({
            code: "custom",
            message: "Change evidence paths must not overlap.",
            path: ["changes", index],
          });
        }
        endpoints.add(endpoint);
      }
    }
  });

export const workspaceChangeSetCommittedPayloadSchema = z
  .object({
    ...planSha256Shape,
    changeCount: z.number().int().min(1).max(CHANGE_SET_MAXIMUM_CHANGES),
  })
  .strict();

const errorCodeSchema = z
  .string()
  .min(1)
  .max(CHANGE_SET_ERROR_CODE_MAXIMUM_CHARACTERS);

export const workspaceChangeSetRolledBackPayloadSchema = z
  .object({
    ...planSha256Shape,
    appliedCount: z.number().int().min(0).max(CHANGE_SET_MAXIMUM_CHANGES),
    restoredPaths: z
      .array(workspaceChangePathSchema)
      .max(CHANGE_SET_MAXIMUM_CHANGES),
    errorCode: errorCodeSchema,
  })
  .strict();

export const workspaceChangeSetUncertainPayloadSchema = z
  .object({
    ...planSha256Shape,
    appliedCount: z.number().int().min(0).max(CHANGE_SET_MAXIMUM_CHANGES),
    uncertainPaths: z
      .array(workspaceChangePathSchema)
      .min(1)
      .max(CHANGE_SET_MAXIMUM_CHANGES),
    errorCode: errorCodeSchema,
  })
  .strict();

export const workspaceChangeSetRecoverySchema = z
  .object({
    planSha256: artifactSha256Schema,
    status: z.enum(["committed", "rolled_back", "uncertain", "incomplete"]),
    paths: z
      .array(workspaceChangePathSchema)
      .min(1)
      .max(CHANGE_SET_MAXIMUM_CHANGES),
  })
  .strict();

export type WorkspaceChangeEvidence = z.infer<
  typeof workspaceChangeEvidenceSchema
>;
export type WorkspaceChangeSetPreparedPayload = z.infer<
  typeof workspaceChangeSetPreparedPayloadSchema
>;
export type WorkspaceChangeSetCommittedPayload = z.infer<
  typeof workspaceChangeSetCommittedPayloadSchema
>;
export type WorkspaceChangeSetRolledBackPayload = z.infer<
  typeof workspaceChangeSetRolledBackPayloadSchema
>;
export type WorkspaceChangeSetUncertainPayload = z.infer<
  typeof workspaceChangeSetUncertainPayloadSchema
>;
export type WorkspaceChangeSetRecovery = z.infer<
  typeof workspaceChangeSetRecoverySchema
>;
