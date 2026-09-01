import { z } from "zod";

import { runtimeSettingsModelSchema } from "./app-server.js";
import { modelProviderIdSchema } from "./providers.js";

export const SETUP_RESULT_SCHEMA_VERSION = 1;
export const MAX_SETUP_WORKSPACE_BYTES = 4_096;
export const MAX_SETUP_MESSAGE_BYTES = 2_048;

const setupWorkspaceSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <= MAX_SETUP_WORKSPACE_BYTES,
    `Workspace must not exceed ${MAX_SETUP_WORKSPACE_BYTES} UTF-8 bytes.`,
  );

const setupMessageSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <= MAX_SETUP_MESSAGE_BYTES,
    `Setup message must not exceed ${MAX_SETUP_MESSAGE_BYTES} UTF-8 bytes.`,
  );

export const setupCommandInputSchema = z
  .object({
    cwd: setupWorkspaceSchema.optional(),
    provider: modelProviderIdSchema.optional(),
    model: runtimeSettingsModelSchema.optional(),
    json: z.boolean().optional(),
    check: z.boolean().optional(),
  })
  .strict();

export const setupCheckFailureReasonSchema = z.enum([
  "credential_missing",
  "authentication_failed",
  "model_unavailable",
  "rate_limited",
  "network_failed",
  "cancelled",
  "provider_failed",
]);

export const setupCheckResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_run") }).strict(),
  z.object({ status: z.literal("passed") }).strict(),
  z
    .object({
      status: z.literal("failed"),
      reason: setupCheckFailureReasonSchema,
      message: setupMessageSchema,
    })
    .strict(),
]);

export const setupResultSchema = z
  .object({
    schema_version: z.literal(SETUP_RESULT_SCHEMA_VERSION),
    workspace: setupWorkspaceSchema,
    provider: modelProviderIdSchema,
    model: runtimeSettingsModelSchema,
    credential_environment_variable: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]{0,127}$/u),
    credential_available: z.boolean(),
    preference_saved: z.boolean(),
    settings_revision: z.number().int().safe().nonnegative(),
    check: setupCheckResultSchema,
  })
  .strict();

export const setupErrorResultSchema = z
  .object({
    schema_version: z.literal(SETUP_RESULT_SCHEMA_VERSION),
    error: z
      .object({
        code: z.literal("KODA_SETUP_FAILED"),
        message: setupMessageSchema,
      })
      .strict(),
  })
  .strict();

export type SetupCheckResult = z.infer<typeof setupCheckResultSchema>;
export type SetupCheckFailureReason = z.infer<
  typeof setupCheckFailureReasonSchema
>;
export type SetupCommandInput = z.infer<typeof setupCommandInputSchema>;
export type SetupResult = z.infer<typeof setupResultSchema>;
export type SetupErrorResult = z.infer<typeof setupErrorResultSchema>;
