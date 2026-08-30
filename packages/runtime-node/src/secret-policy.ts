import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  EXECUTION_SECRET_VALUE_MAX_BYTES,
  EXECUTION_SECRET_VALUE_MIN_BYTES,
  EXECUTION_SECRET_VALUES_MAX_BYTES,
  secretAliasSelectionSchema,
  secretCatalogSchema,
  secretExecutionEvidenceSchema,
  type ExecutionSecuritySnapshot,
  type SecretAlias,
  type SecretCatalog,
  type SecretDeclaration,
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

export interface SecretResolver {
  /** The returned Buffer transfers to the caller and must not be retained. */
  resolve(declaration: Readonly<SecretDeclaration>): Buffer | Promise<Buffer>;
}

export class HostEnvironmentSecretResolver implements SecretResolver {
  public constructor(private readonly environment: NodeJS.ProcessEnv) {}

  public resolve(declaration: Readonly<SecretDeclaration>): Buffer {
    const value = this.environment[declaration.source.name];
    if (value === undefined) {
      throw new SecretPolicyError("SECRET_VALUE_UNAVAILABLE");
    }
    if (value.includes("\0") || containsUnpairedSurrogate(value)) {
      throw new SecretPolicyError("SECRET_VALUE_INVALID");
    }
    return Buffer.from(value, "utf8");
  }
}

export interface SecretCommandBinding {
  toolName: SecretTool;
  workspaceRoot: string;
  cwd: string;
  argv: readonly string[];
  timeoutMs: number;
  security: ExecutionSecuritySnapshot;
  lifecycle?: "foreground" | "background";
  displayName?: string;
}

export interface SecretLeaseManagerOptions {
  monotonicNow?: () => number;
  wallNow?: () => number;
  nextLeaseId?: () => string;
  targetEnvironment?: NodeJS.ProcessEnv;
}

interface ResolvedSecretValue {
  alias: SecretAlias;
  target: string;
  value: Buffer;
}

export class SecretLease {
  readonly #leaseId: string;
  readonly #declarationDigest: string;
  readonly #aliases: readonly SecretAlias[];
  readonly #targets: readonly {
    alias: SecretAlias;
    environmentVariable: string;
  }[];
  readonly #expiresAtMs: number;
  readonly #deadline: number;
  readonly #monotonicNow: () => number;
  readonly #bindingDigest: string;
  readonly #values: ResolvedSecretValue[];
  readonly #publicPolicy: Extract<
    ExecutionSecuritySnapshot,
    { kind: "policy" }
  >["policy"];
  #consumed = false;
  #destroyed = false;

  public constructor(options: {
    leaseId: string;
    declarationDigest: string;
    expiresAtMs: number;
    deadline: number;
    monotonicNow: () => number;
    binding: SecretCommandBinding;
    values: ResolvedSecretValue[];
  }) {
    try {
      assertSecretSecurityAvailable(options.binding.security);
      if (!/^[a-f0-9]{32}$/u.test(options.leaseId)) {
        throw new SecretPolicyError("SECRET_POLICY_UNAVAILABLE");
      }
    } catch (error) {
      destroyResolvedValues(options.values);
      throw error;
    }
    this.#leaseId = options.leaseId;
    this.#declarationDigest = options.declarationDigest;
    this.#expiresAtMs = options.expiresAtMs;
    this.#deadline = options.deadline;
    this.#monotonicNow = options.monotonicNow;
    this.#values = options.values;
    this.#publicPolicy = options.binding.security.policy;
    this.#aliases = Object.freeze(options.values.map(({ alias }) => alias));
    this.#targets = Object.freeze(
      options.values.map(({ alias, target }) =>
        Object.freeze({ alias, environmentVariable: target }),
      ),
    );
    this.#bindingDigest = secretBindingDigest(
      options.binding,
      this.#declarationDigest,
      this.#leaseId,
      this.#targets,
    );
  }

  public get leaseId(): string {
    return this.#leaseId;
  }

  public get declarationDigest(): string {
    return this.#declarationDigest;
  }

  public get aliases(): readonly SecretAlias[] {
    return this.#aliases;
  }

  public get targets(): readonly {
    alias: SecretAlias;
    environmentVariable: string;
  }[] {
    return this.#targets;
  }

  public get expiresAtMs(): number {
    return this.#expiresAtMs;
  }

  public get destroyed(): boolean {
    return this.#destroyed;
  }

  public approvalDetails(basePreview: string): string {
    const policy = this.#assertPublicPolicyBinding();
    return [
      basePreview,
      "secret execution: fresh approval required",
      `protected profile: ${policy.filesystem === "read_only" ? "read-only" : "workspace-write"}`,
      "network: denied",
      `secret aliases: ${JSON.stringify(this.#aliases)}`,
      `secret file targets: ${JSON.stringify(
        this.#targets.map(
          ({ alias, environmentVariable }) =>
            `${alias} -> ${environmentVariable}`,
        ),
      )}`,
      `secret lease expires: ${new Date(this.#expiresAtMs).toISOString()}`,
      "exact output redaction: required before process release",
    ].join("\n");
  }

  /** C3B intentionally consumes and rejects every secret-bearing launch. */
  public rejectUnavailable(binding: SecretCommandBinding): never {
    this.#assertUsable(binding);
    this.#consumed = true;
    this.destroy();
    throw new SecretPolicyError("SECRET_POLICY_UNAVAILABLE");
  }

  public destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    destroyResolvedValues(this.#values);
  }

  public toJSON(): never {
    throw new SecretPolicyError("SECRET_EVIDENCE_CORRUPT");
  }

  #assertUsable(binding: SecretCommandBinding): void {
    if (this.#destroyed || this.#consumed) {
      throw new SecretPolicyError("SECRET_REAUTH_REQUIRED");
    }
    if (this.#monotonicNow() >= this.#deadline) {
      this.destroy();
      throw new SecretPolicyError("SECRET_LEASE_EXPIRED");
    }
    if (
      this.#bindingDigest !==
      secretBindingDigest(
        binding,
        this.#declarationDigest,
        this.#leaseId,
        this.#targets,
      )
    ) {
      this.destroy();
      throw new SecretPolicyError("SECRET_POLICY_CHANGED");
    }
  }

  #assertPublicPolicyBinding(): Extract<
    ExecutionSecuritySnapshot,
    { kind: "policy" }
  >["policy"] {
    return this.#publicPolicy;
  }
}

export class SecretLeaseManager {
  public readonly catalog: Readonly<SecretCatalog>;
  public readonly declarationDigest: string;
  readonly #byAlias: ReadonlyMap<SecretAlias, Readonly<SecretDeclaration>>;
  readonly #resolver: SecretResolver;
  readonly #monotonicNow: () => number;
  readonly #wallNow: () => number;
  readonly #nextLeaseId: () => string;
  readonly #targetEnvironment: NodeJS.ProcessEnv;

  public constructor(
    catalogInput: unknown,
    resolver: SecretResolver,
    options: SecretLeaseManagerOptions = {},
  ) {
    this.catalog = normalizeSecretCatalog(catalogInput);
    this.declarationDigest = secretDeclarationDigest(this.catalog);
    this.#byAlias = new Map(
      this.catalog.declarations.map((declaration) => [
        declaration.alias,
        declaration,
      ]),
    );
    this.#resolver = resolver;
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#wallNow = options.wallNow ?? Date.now;
    this.#nextLeaseId =
      options.nextLeaseId ?? (() => randomBytes(16).toString("hex"));
    this.#targetEnvironment = options.targetEnvironment ?? {};
  }

  public aliasesFor(toolName: SecretTool): readonly SecretAlias[] {
    return Object.freeze(
      this.catalog.declarations
        .filter(({ tools }) => tools.includes(toolName))
        .map(({ alias }) => alias),
    );
  }

  public catalogIdentity(toolName: SecretTool): {
    schema_version: 1;
    declaration_digest: string;
    aliases: SecretAlias[];
  } {
    return {
      schema_version: 1,
      declaration_digest: this.declarationDigest,
      aliases: [...this.aliasesFor(toolName)],
    };
  }

  public async prepare(
    toolName: SecretTool,
    selectionInput: unknown,
    binding: SecretCommandBinding,
  ): Promise<SecretLease | undefined> {
    const aliases = normalizeSecretSelection(selectionInput);
    if (aliases.length === 0) return undefined;
    if (binding.toolName !== toolName) {
      throw new SecretPolicyError("SECRET_POLICY_CHANGED");
    }
    assertSecretSecurityAvailable(binding.security);

    const declarations = aliases.map((alias) => {
      const declaration = this.#byAlias.get(alias);
      if (declaration === undefined || !declaration.tools.includes(toolName)) {
        throw new SecretPolicyError("SECRET_ALIAS_NOT_CONFIGURED");
      }
      if (this.#targetEnvironment[declaration.target.name] !== undefined) {
        throw new SecretPolicyError("SECRET_POLICY_UNAVAILABLE");
      }
      return declaration;
    });

    const values: ResolvedSecretValue[] = [];
    try {
      let totalBytes = 0;
      for (const declaration of declarations) {
        let value: Buffer;
        try {
          value = await this.#resolver.resolve(declaration);
        } catch (error) {
          if (error instanceof SecretPolicyError) throw error;
          throw new SecretPolicyError("SECRET_VALUE_UNAVAILABLE");
        }
        if (!Buffer.isBuffer(value)) {
          throw new SecretPolicyError("SECRET_VALUE_INVALID");
        }
        if (
          value.byteLength < EXECUTION_SECRET_VALUE_MIN_BYTES ||
          value.byteLength > EXECUTION_SECRET_VALUE_MAX_BYTES
        ) {
          value.fill(0);
          throw new SecretPolicyError("SECRET_VALUE_INVALID");
        }
        totalBytes += value.byteLength;
        if (totalBytes > EXECUTION_SECRET_VALUES_MAX_BYTES) {
          value.fill(0);
          throw new SecretPolicyError("SECRET_VALUE_INVALID");
        }
        if (values.some((resolved) => resolved.value.equals(value))) {
          value.fill(0);
          throw new SecretPolicyError("SECRET_VALUE_INVALID");
        }
        values.push({
          alias: declaration.alias,
          target: declaration.target.name,
          value,
        });
      }
      const leaseMs = Math.min(
        ...declarations.map((declaration) => declaration.lease_ms),
      );
      const monotonicNow = this.#monotonicNow();
      const wallNow = this.#wallNow();
      assertSafeClock(monotonicNow);
      assertSafeClock(wallNow);
      return new SecretLease({
        leaseId: this.#nextLeaseId(),
        declarationDigest: this.declarationDigest,
        expiresAtMs: wallNow + leaseMs,
        deadline: monotonicNow + leaseMs,
        monotonicNow: this.#monotonicNow,
        binding,
        values,
      });
    } catch (error) {
      destroyResolvedValues(values);
      throw error;
    }
  }
}

function assertSecretSecurityAvailable(
  security: ExecutionSecuritySnapshot,
): asserts security is Extract<ExecutionSecuritySnapshot, { kind: "policy" }> {
  if (
    security.kind !== "policy" ||
    security.stage !== "admission" ||
    (security.schema_version !== 2 && security.schema_version !== 3) ||
    security.backend !== "native_posix" ||
    security.policy.network !== "deny" ||
    (security.policy.filesystem !== "read_only" &&
      security.policy.filesystem !== "workspace_write")
  ) {
    throw new SecretPolicyError("SECRET_POLICY_UNAVAILABLE");
  }
}

function secretBindingDigest(
  binding: SecretCommandBinding,
  declarationDigest: string,
  leaseId: string,
  targets: readonly { alias: SecretAlias; environmentVariable: string }[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        tool_name: binding.toolName,
        workspace_root: binding.workspaceRoot,
        cwd: binding.cwd,
        argv: binding.argv,
        timeout_ms: binding.timeoutMs,
        ...(binding.lifecycle === undefined
          ? {}
          : { lifecycle: binding.lifecycle }),
        ...(binding.displayName === undefined
          ? {}
          : { display_name: binding.displayName }),
        security: binding.security,
        declaration_digest: declarationDigest,
        lease_id: leaseId,
        targets: targets.map(({ alias, environmentVariable }) => ({
          alias,
          environment_variable: environmentVariable,
        })),
      }),
      "utf8",
    )
    .digest("hex");
}

function destroyResolvedValues(values: readonly ResolvedSecretValue[]): void {
  for (const { value } of values) value.fill(0);
}

function assertSafeClock(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SecretPolicyError("SECRET_POLICY_UNAVAILABLE");
  }
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
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
