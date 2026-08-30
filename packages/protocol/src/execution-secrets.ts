import { z } from "zod";

export const EXECUTION_SECRET_SCHEMA_VERSION = 1;
export const EXECUTION_SECRET_MAX_DECLARATIONS = 32;
export const EXECUTION_SECRET_MAX_SELECTION = 16;
export const EXECUTION_SECRET_ALIAS_MAX_BYTES = 64;
export const EXECUTION_SECRET_ENVIRONMENT_NAME_MAX_BYTES = 128;
export const EXECUTION_SECRET_VALUE_MIN_BYTES = 8;
export const EXECUTION_SECRET_VALUE_MAX_BYTES = 8 * 1_024;
export const EXECUTION_SECRET_VALUES_MAX_BYTES = 64 * 1_024;
export const EXECUTION_SECRET_LEASE_MIN_MS = 1_000;
export const EXECUTION_SECRET_LEASE_MAX_MS = 5 * 60 * 1_000;
export const EXECUTION_SECRET_EVIDENCE_MAX_BYTES = 16_384;

const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const safeNonnegativeInteger = z.number().int().safe().nonnegative();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const secretAliasSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*$/u)
  .refine(
    (value) => utf8Bytes(value) <= EXECUTION_SECRET_ALIAS_MAX_BYTES,
    "Secret alias is too large.",
  );

export const hostSecretEnvironmentNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
  .refine(
    (value) => utf8Bytes(value) <= EXECUTION_SECRET_ENVIRONMENT_NAME_MAX_BYTES,
    "Host environment name is too large.",
  );

export const secretFileEnvironmentNameSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*_FILE$/u)
  .refine((value) => !value.startsWith("KODA_"), {
    message: "Koda-reserved environment names cannot receive secrets.",
  })
  .refine(
    (value) => utf8Bytes(value) <= EXECUTION_SECRET_ENVIRONMENT_NAME_MAX_BYTES,
    "Secret file environment name is too large.",
  );

export const secretToolSchema = z.enum(["exec_command", "exec_terminal"]);

export const secretDeclarationSchema = z
  .object({
    schema_version: z.literal(EXECUTION_SECRET_SCHEMA_VERSION),
    alias: secretAliasSchema,
    source: z
      .object({
        kind: z.literal("host_env"),
        name: hostSecretEnvironmentNameSchema,
      })
      .strict(),
    target: z
      .object({
        kind: z.literal("file_env"),
        name: secretFileEnvironmentNameSchema,
      })
      .strict(),
    tools: z
      .array(secretToolSchema)
      .min(1)
      .max(2)
      .superRefine((tools, context) => {
        if (new Set(tools).size !== tools.length) {
          context.addIssue({
            code: "custom",
            message: "Secret declaration tools must be unique.",
          });
        }
      }),
    lease_ms: z
      .number()
      .int()
      .safe()
      .min(EXECUTION_SECRET_LEASE_MIN_MS)
      .max(EXECUTION_SECRET_LEASE_MAX_MS),
  })
  .strict();

export const secretCatalogSchema = z
  .object({
    schema_version: z.literal(EXECUTION_SECRET_SCHEMA_VERSION),
    declarations: z
      .array(secretDeclarationSchema)
      .max(EXECUTION_SECRET_MAX_DECLARATIONS),
  })
  .strict()
  .superRefine((catalog, context) => {
    const aliases = new Set<string>();
    const targets = new Set<string>();
    for (const [index, declaration] of catalog.declarations.entries()) {
      if (aliases.has(declaration.alias)) {
        context.addIssue({
          code: "custom",
          path: ["declarations", index, "alias"],
          message: "Secret aliases must be unique.",
        });
      }
      aliases.add(declaration.alias);
      if (targets.has(declaration.target.name)) {
        context.addIssue({
          code: "custom",
          path: ["declarations", index, "target", "name"],
          message: "Secret target environment names must be unique.",
        });
      }
      targets.add(declaration.target.name);
    }
  });

export const secretAliasSelectionSchema = z
  .array(secretAliasSchema)
  .max(EXECUTION_SECRET_MAX_SELECTION)
  .superRefine((aliases, context) => {
    if (new Set(aliases).size !== aliases.length) {
      context.addIssue({
        code: "custom",
        message: "Selected secret aliases must be unique.",
      });
    }
  });

export const secretPolicyErrorCodeSchema = z.enum([
  "INVALID_SECRET_DECLARATION",
  "SECRET_ALIAS_NOT_CONFIGURED",
  "SECRET_VALUE_UNAVAILABLE",
  "SECRET_VALUE_INVALID",
  "SECRET_LEASE_EXPIRED",
  "SECRET_POLICY_UNAVAILABLE",
  "SECRET_POLICY_CHANGED",
  "SECRET_REAUTH_REQUIRED",
  "SECRET_INJECTION_FAILED",
  "SECRET_REDACTION_FAILED",
  "SECRET_CLEANUP_FAILED",
  "SECRET_EVIDENCE_CORRUPT",
]);

const secretPublicTargetSchema = z
  .object({
    alias: secretAliasSchema,
    environment_variable: secretFileEnvironmentNameSchema,
  })
  .strict();

const secretLifecycleSchema = z.enum([
  "resolved",
  "injected",
  "expired",
  "destroyed",
  "cleanup_pending",
  "cleanup_failed",
]);

const secretCleanupSchema = z.enum([
  "not_started",
  "pending",
  "completed",
  "failed",
]);

export const secretExecutionEvidenceSchema = z
  .object({
    schema_version: z.literal(EXECUTION_SECRET_SCHEMA_VERSION),
    declaration_digest: digestSchema,
    lease_id: z.string().regex(/^[a-f0-9]{32}$/u),
    aliases: z
      .array(secretAliasSchema)
      .min(1)
      .max(EXECUTION_SECRET_MAX_SELECTION),
    targets: z
      .array(secretPublicTargetSchema)
      .min(1)
      .max(EXECUTION_SECRET_MAX_SELECTION),
    lifecycle: secretLifecycleSchema,
    expires_at_ms: z.number().int().safe().positive(),
    redactions: z
      .object({
        stdout: safeNonnegativeInteger,
        stderr: safeNonnegativeInteger,
        pty: safeNonnegativeInteger,
      })
      .strict(),
    cleanup: secretCleanupSchema,
  })
  .strict()
  .superRefine((evidence, context) => {
    if (!isStrictlySorted(evidence.aliases)) {
      context.addIssue({
        code: "custom",
        path: ["aliases"],
        message: "Secret evidence aliases must be sorted and unique.",
      });
    }
    const targetAliases = evidence.targets.map((target) => target.alias);
    const targetNames = evidence.targets.map(
      (target) => target.environment_variable,
    );
    if (
      targetAliases.length !== evidence.aliases.length ||
      targetAliases.some((alias, index) => alias !== evidence.aliases[index]) ||
      new Set(targetNames).size !== targetNames.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["targets"],
        message: "Secret evidence targets must map each alias exactly once.",
      });
    }
    const expectedCleanup = {
      resolved: "not_started",
      injected: "pending",
      expired: "completed",
      destroyed: "completed",
      cleanup_pending: "pending",
      cleanup_failed: "failed",
    } as const;
    if (evidence.cleanup !== expectedCleanup[evidence.lifecycle]) {
      context.addIssue({
        code: "custom",
        path: ["cleanup"],
        message: "Secret cleanup evidence is inconsistent with lifecycle.",
      });
    }
  })
  .refine(
    (value) =>
      utf8Bytes(JSON.stringify(value)) <= EXECUTION_SECRET_EVIDENCE_MAX_BYTES,
    "Secret execution evidence is too large.",
  );

function isStrictlySorted(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || values[index - 1]! < value,
  );
}

export type SecretAlias = z.infer<typeof secretAliasSchema>;
export type SecretTool = z.infer<typeof secretToolSchema>;
export type SecretDeclaration = z.infer<typeof secretDeclarationSchema>;
export type SecretCatalog = z.infer<typeof secretCatalogSchema>;
export type SecretPolicyErrorCode = z.infer<typeof secretPolicyErrorCodeSchema>;
export type SecretExecutionEvidence = z.infer<
  typeof secretExecutionEvidenceSchema
>;
