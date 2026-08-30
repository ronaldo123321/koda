import { createHash } from "node:crypto";

import {
  secretAliasSelectionSchema,
  secretCatalogSchema,
  secretExecutionEvidenceSchema,
  type SecretAlias,
  type SecretCatalog,
  type SecretExecutionEvidence,
  type SecretPolicyErrorCode,
  type SecretTool,
} from "@koda/protocol";
import type { z } from "zod";

const errorMessages: Record<SecretPolicyErrorCode, string> = {
  INVALID_SECRET_DECLARATION: "Secret declaration configuration is invalid.",
  SECRET_ALIAS_NOT_CONFIGURED: "The requested secret alias is not configured.",
  SECRET_VALUE_UNAVAILABLE: "A requested secret value is unavailable.",
  SECRET_VALUE_INVALID: "A requested secret value is invalid.",
  SECRET_LEASE_EXPIRED: "The secret lease expired before execution.",
  SECRET_POLICY_UNAVAILABLE:
    "The selected backend cannot enforce the requested secret policy.",
  SECRET_POLICY_CHANGED: "The prepared secret contract has changed.",
  SECRET_REAUTH_REQUIRED: "The secret must be resolved and approved again.",
  SECRET_INJECTION_FAILED: "The secret could not be injected safely.",
  SECRET_REDACTION_FAILED: "Command output could not be redacted safely.",
  SECRET_CLEANUP_FAILED: "Secret cleanup could not be confirmed.",
  SECRET_EVIDENCE_CORRUPT:
    "Secret execution evidence is invalid or inconsistent.",
};

export class SecretPolicyError extends Error {
  public constructor(public readonly code: SecretPolicyErrorCode) {
    super(errorMessages[code]);
    this.name = "SecretPolicyError";
  }
}

function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: SecretPolicyErrorCode,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new SecretPolicyError(code);
  return result.data;
}

export function normalizeSecretCatalog(
  value: unknown,
): Readonly<SecretCatalog> {
  const catalog = parse(
    secretCatalogSchema,
    value,
    "INVALID_SECRET_DECLARATION",
  );
  const declarations = catalog.declarations
    .map((declaration) => ({
      schema_version: declaration.schema_version,
      alias: declaration.alias,
      source: { ...declaration.source },
      target: { ...declaration.target },
      tools: [...declaration.tools].sort(compareSecretTools),
      lease_ms: declaration.lease_ms,
    }))
    .sort((left, right) => compareAscii(left.alias, right.alias));
  return freezeRecord({
    schema_version: catalog.schema_version,
    declarations,
  });
}

/** Fixed field and array order is part of the cross-language digest contract. */
export function canonicalSecretCatalog(value: unknown): string {
  const catalog = normalizeSecretCatalog(value);
  return JSON.stringify({
    schema_version: catalog.schema_version,
    declarations: catalog.declarations.map((declaration) => ({
      schema_version: declaration.schema_version,
      alias: declaration.alias,
      source: {
        kind: declaration.source.kind,
        name: declaration.source.name,
      },
      target: {
        kind: declaration.target.kind,
        name: declaration.target.name,
      },
      tools: declaration.tools,
      lease_ms: declaration.lease_ms,
    })),
  });
}

export function secretDeclarationDigest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalSecretCatalog(value), "utf8")
    .digest("hex");
}

export function normalizeSecretSelection(
  value: unknown,
): readonly SecretAlias[] {
  return Object.freeze(
    [
      ...parse(secretAliasSelectionSchema, value, "INVALID_SECRET_DECLARATION"),
    ].sort(compareAscii),
  );
}

export function validateSecretExecutionEvidence(
  value: unknown,
): Readonly<SecretExecutionEvidence> {
  return freezeRecord(
    parse(secretExecutionEvidenceSchema, value, "SECRET_EVIDENCE_CORRUPT"),
  );
}

function compareSecretTools(left: SecretTool, right: SecretTool): number {
  return compareAscii(left, right);
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freezeRecord<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freezeRecord(nested);
    Object.freeze(value);
  }
  return value;
}
