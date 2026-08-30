import { readFileSync } from "node:fs";

import {
  EXECUTION_SECRET_ALIAS_MAX_BYTES,
  EXECUTION_SECRET_ENVIRONMENT_NAME_MAX_BYTES,
  EXECUTION_SECRET_EVIDENCE_MAX_BYTES,
  EXECUTION_SECRET_LEASE_MAX_MS,
  EXECUTION_SECRET_LEASE_MIN_MS,
  EXECUTION_SECRET_MAX_DECLARATIONS,
  EXECUTION_SECRET_MAX_SELECTION,
  EXECUTION_SECRET_VALUE_MAX_BYTES,
  EXECUTION_SECRET_VALUE_MIN_BYTES,
  EXECUTION_SECRET_VALUES_MAX_BYTES,
  secretCatalogSchema,
  secretExecutionEvidenceSchema,
  secretPolicyErrorCodeSchema,
} from "@koda/protocol";
import {
  canonicalSecretCatalog,
  normalizeSecretCatalog,
  normalizeSecretSelection,
  secretDeclarationDigest,
  SecretPolicyError,
  StreamingSecretRedactor,
  validateSecretExecutionEvidence,
} from "@koda/runtime-node";
import { describe, expect, it } from "vitest";

interface ExecutionSecretsFixtures {
  limits: {
    max_declarations: number;
    max_selection: number;
    alias_max_bytes: number;
    environment_name_max_bytes: number;
    value_min_bytes: number;
    value_max_bytes: number;
    values_max_bytes: number;
    lease_min_ms: number;
    lease_max_ms: number;
    evidence_max_bytes: number;
  };
  error_codes: string[];
  catalog_cases: {
    name: string;
    input: unknown;
    canonical: string;
    sha256: string;
  }[];
  invalid_catalog_cases: { name: string; input: unknown }[];
  evidence_cases: { name: string; valid: boolean; input: unknown }[];
  redaction_cases: {
    name: string;
    secrets_base64: string[];
    chunks_base64: string[];
    expected_base64: string;
    replacements: number;
    output_limit_bytes?: number;
    expected_limited_base64?: string;
  }[];
}

const fixtures: ExecutionSecretsFixtures = JSON.parse(
  readFileSync(
    new URL("../fixtures/execution-secrets-v1.json", import.meta.url),
    "utf8",
  ),
);

describe("Phase 4C3A secret contract", () => {
  it.each(fixtures.catalog_cases)(
    "matches cross-language catalog bytes and SHA-256: $name",
    ({ input, canonical, sha256 }) => {
      expect(canonicalSecretCatalog(input)).toBe(canonical);
      expect(secretDeclarationDigest(input)).toBe(sha256);
      expect(secretCatalogSchema.safeParse(input).success).toBe(true);
    },
  );

  it.each(fixtures.invalid_catalog_cases)(
    "rejects malformed catalogs without echoing values: $name",
    ({ input }) => {
      expect(secretCatalogSchema.safeParse(input).success).toBe(false);
      expectCode(
        () => normalizeSecretCatalog(input),
        "INVALID_SECRET_DECLARATION",
      );
    },
  );

  it("normalizes and recursively freezes declarations without mutating input", () => {
    const input = structuredClone(fixtures.catalog_cases[2]!.input);
    const before = structuredClone(input);
    const normalized = normalizeSecretCatalog(input);
    expect(input).toEqual(before);
    expect(normalized.declarations.map(({ alias }) => alias)).toEqual([
      "api-token",
      "signing-key",
    ]);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.declarations)).toBe(true);
    expect(Object.isFrozen(normalized.declarations[0]!.source)).toBe(true);
  });

  it("binds every public declaration field without hashing a resolved value", () => {
    const base = normalizeSecretCatalog(fixtures.catalog_cases[1]!.input);
    const declaration = base.declarations[0]!;
    const variants = [
      base,
      catalogWith(base, { alias: "other-token" }),
      catalogWith(base, {
        source: { kind: "host_env", name: "OTHER_TOKEN" },
      }),
      catalogWith(base, {
        target: { kind: "file_env", name: "OTHER_TOKEN_FILE" },
      }),
      catalogWith(base, { tools: ["exec_command"] }),
      catalogWith(base, { lease_ms: declaration.lease_ms + 1 }),
    ];
    expect(new Set(variants.map(secretDeclarationDigest)).size).toBe(
      variants.length,
    );
    expect(canonicalSecretCatalog(base)).not.toContain("fixture-secret-marker");
  });

  it("bounds catalogs and alias selections and produces canonical selection order", () => {
    const declaration = normalizeSecretCatalog(fixtures.catalog_cases[1]!.input)
      .declarations[0]!;
    expect(
      secretCatalogSchema.safeParse({
        schema_version: 1,
        declarations: Array.from(
          { length: EXECUTION_SECRET_MAX_DECLARATIONS + 1 },
          (_, index) => ({
            ...declaration,
            alias: `secret-${index}`,
            source: { kind: "host_env", name: `SECRET_${index}` },
            target: { kind: "file_env", name: `SECRET_${index}_FILE` },
          }),
        ),
      }).success,
    ).toBe(false);
    expect(normalizeSecretSelection(["signing-key", "api-token"])).toEqual([
      "api-token",
      "signing-key",
    ]);
    expectCode(
      () => normalizeSecretSelection(["api-token", "api-token"]),
      "INVALID_SECRET_DECLARATION",
    );
    expectCode(
      () =>
        normalizeSecretSelection(
          Array.from(
            { length: EXECUTION_SECRET_MAX_SELECTION + 1 },
            (_, index) => `secret-${index}`,
          ),
        ),
      "INVALID_SECRET_DECLARATION",
    );
  });

  it.each(fixtures.evidence_cases)(
    "validates shared public evidence: $name",
    ({ input, valid }) => {
      expect(secretExecutionEvidenceSchema.safeParse(input).success).toBe(
        valid,
      );
      if (valid) {
        const parsed = validateSecretExecutionEvidence(input);
        expect(Object.isFrozen(parsed)).toBe(true);
        expect(JSON.stringify(parsed)).not.toContain("fixture-secret-marker");
      } else {
        expectCode(
          () => validateSecretExecutionEvidence(input),
          "SECRET_EVIDENCE_CORRUPT",
        );
      }
    },
  );

  it("keeps all secret error codes stable and value-free", () => {
    expect(secretPolicyErrorCodeSchema.options).toEqual(fixtures.error_codes);
    expect(new Set(fixtures.error_codes).size).toBe(
      fixtures.error_codes.length,
    );
    for (const code of secretPolicyErrorCodeSchema.options) {
      const error = new SecretPolicyError(code);
      expect(error.code).toBe(code);
      expect(error.message).not.toContain("fixture-secret-marker");
    }
  });

  it("matches the cross-language resource limits", () => {
    expect({
      max_declarations: EXECUTION_SECRET_MAX_DECLARATIONS,
      max_selection: EXECUTION_SECRET_MAX_SELECTION,
      alias_max_bytes: EXECUTION_SECRET_ALIAS_MAX_BYTES,
      environment_name_max_bytes: EXECUTION_SECRET_ENVIRONMENT_NAME_MAX_BYTES,
      value_min_bytes: EXECUTION_SECRET_VALUE_MIN_BYTES,
      value_max_bytes: EXECUTION_SECRET_VALUE_MAX_BYTES,
      values_max_bytes: EXECUTION_SECRET_VALUES_MAX_BYTES,
      lease_min_ms: EXECUTION_SECRET_LEASE_MIN_MS,
      lease_max_ms: EXECUTION_SECRET_LEASE_MAX_MS,
      evidence_max_bytes: EXECUTION_SECRET_EVIDENCE_MAX_BYTES,
    }).toEqual(fixtures.limits);
  });
});

describe("Phase 4C3A streaming secret redactor", () => {
  it.each(fixtures.redaction_cases)(
    "matches shared byte fixture: $name",
    ({
      secrets_base64,
      chunks_base64,
      expected_base64,
      replacements,
      output_limit_bytes,
      expected_limited_base64,
    }) => {
      const redactor = new StreamingSecretRedactor(
        secrets_base64.map(decodeBase64),
      );
      const chunks = chunks_base64.map(decodeBase64);
      const output = Buffer.concat([
        ...chunks.map((chunk) => redactor.push(chunk)),
        redactor.finish(),
      ]);
      expect(output).toEqual(decodeBase64(expected_base64));
      expect(redactor.replacementCount).toBe(replacements);
      if (
        output_limit_bytes !== undefined &&
        expected_limited_base64 !== undefined
      ) {
        expect(output.subarray(0, output_limit_bytes)).toEqual(
          decodeBase64(expected_limited_base64),
        );
      }
    },
  );

  it("redacts a value split at every byte boundary", () => {
    const secret = Buffer.from("boundary-secret-value");
    const input = Buffer.from("before boundary-secret-value after");
    const expected = Buffer.from("before [REDACTED] after");
    for (let split = 0; split <= input.byteLength; split += 1) {
      const redactor = new StreamingSecretRedactor([secret]);
      const output = Buffer.concat([
        redactor.push(input.subarray(0, split)),
        redactor.push(input.subarray(split)),
        redactor.finish(),
      ]);
      expect(output).toEqual(expected);
      expect(redactor.replacementCount).toBe(1);
    }
  });

  it("redacts when every input byte arrives in its own chunk", () => {
    const secret = Buffer.from("one-byte-chunks-secret");
    const input = Buffer.from("prefix one-byte-chunks-secret suffix");
    const redactor = new StreamingSecretRedactor([secret]);
    const output = Buffer.concat([
      ...Array.from(input, (byte) => redactor.push(Uint8Array.of(byte))),
      redactor.finish(),
    ]);
    expect(output.toString()).toBe("prefix [REDACTED] suffix");
    expect(redactor.replacementCount).toBe(1);
  });

  it("rejects unsafe value sets and use after finish or destroy", () => {
    for (const values of [
      [Buffer.from("short")],
      [Buffer.alloc(EXECUTION_SECRET_VALUE_MAX_BYTES + 1, "x")],
      Array.from({ length: 9 }, () =>
        Buffer.alloc(EXECUTION_SECRET_VALUE_MAX_BYTES, "x"),
      ),
      Array.from({ length: EXECUTION_SECRET_MAX_SELECTION + 1 }, () =>
        Buffer.from("valid-secret"),
      ),
    ]) {
      expectCode(
        () => new StreamingSecretRedactor(values),
        "SECRET_VALUE_INVALID",
      );
    }

    const finished = new StreamingSecretRedactor([Buffer.from("valid-secret")]);
    finished.finish();
    expectCode(
      () => finished.push(Buffer.from("value")),
      "SECRET_REDACTION_FAILED",
    );

    const destroyed = new StreamingSecretRedactor([
      Buffer.from("valid-secret"),
    ]);
    destroyed.destroy();
    expectCode(() => destroyed.finish(), "SECRET_REDACTION_FAILED");
  });
});

function catalogWith(
  catalog: ReturnType<typeof normalizeSecretCatalog>,
  patch: Partial<(typeof catalog.declarations)[number]>,
) {
  return {
    schema_version: catalog.schema_version,
    declarations: [{ ...catalog.declarations[0]!, ...patch }],
  };
}

function decodeBase64(value: string): Buffer {
  return Buffer.from(value, "base64");
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(SecretPolicyError);
    expect((error as SecretPolicyError).code).toBe(code);
    expect(String(error)).not.toContain("fixture-secret-marker");
    return;
  }
  throw new Error(`Expected ${code}.`);
}
