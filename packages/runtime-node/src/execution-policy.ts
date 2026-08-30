import { createHash } from "node:crypto";
import {
  executionBackendSchema,
  executionCapabilitiesSchema,
  linuxBubblewrapRuntimeDescriptorSchema,
  executionPolicyConfigSchema,
  executionPolicySchema,
  executionProfileSchema,
  executionOsSandboxSummary,
  executionSecuritySnapshotSchema,
  executionSupervision,
  type ExecutionBackend,
  type ExecutionCapabilities,
  type ExecutionPolicy,
  type ExecutionPolicyConfig,
  type ExecutionPolicyDimension,
  type ExecutionSecuritySnapshot,
  type LinuxBubblewrapRuntimeDescriptor,
} from "@koda/protocol";
import type { z } from "zod";

export type ExecutionPolicyErrorCode =
  | "INVALID_EXECUTION_POLICY"
  | "EXECUTION_POLICY_UNAVAILABLE"
  | "EXECUTION_POLICY_CHANGED"
  | "INCOMPATIBLE_PROTOCOL"
  | "EXECUTION_SECURITY_CORRUPT";

const errorMessages: Record<ExecutionPolicyErrorCode, string> = {
  INVALID_EXECUTION_POLICY: "Execution policy configuration is invalid.",
  EXECUTION_POLICY_UNAVAILABLE:
    "The selected backend cannot enforce the requested execution policy.",
  EXECUTION_POLICY_CHANGED:
    "The prepared execution security contract has changed.",
  INCOMPATIBLE_PROTOCOL: "The executor protocol is incompatible.",
  EXECUTION_SECURITY_CORRUPT:
    "Execution security evidence is invalid or inconsistent.",
};

export class ExecutionPolicyError extends Error {
  public constructor(public readonly code: ExecutionPolicyErrorCode) {
    super(errorMessages[code]);
    this.name = "ExecutionPolicyError";
  }
}

// Never propagate validator input, raw errors, environment values, or paths.
function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: ExecutionPolicyErrorCode,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ExecutionPolicyError(code);
  return result.data;
}

export function normalizeExecutionPolicy(
  value: unknown,
): Readonly<ExecutionPolicy> {
  return Object.freeze(
    parse(executionPolicySchema, value, "INVALID_EXECUTION_POLICY"),
  );
}

export interface ResolveExecutionPolicyOptions {
  /** Already canonicalized by the trusted application, never by model arguments. */
  workspaceRoot: string;
  policy?: ExecutionPolicyConfig;
  /** Explicitly supplied KODA_EXECUTION_PROFILE value; no ambient env reads. */
  environmentProfile?: string;
}

export function resolveExecutionPolicy(
  options: ResolveExecutionPolicyOptions,
): Readonly<ExecutionPolicy> {
  let config: ExecutionPolicyConfig;
  if (options.policy !== undefined) {
    config = parse(
      executionPolicyConfigSchema,
      options.policy,
      "INVALID_EXECUTION_POLICY",
    );
  } else {
    const profile = parse(
      executionProfileSchema,
      options.environmentProfile === undefined
        ? "unconfined"
        : options.environmentProfile,
      "INVALID_EXECUTION_POLICY",
    );
    config = {
      filesystem:
        profile === "unconfined"
          ? "unrestricted"
          : profile === "read-only"
            ? "read_only"
            : "workspace_write",
      network: profile === "unconfined" ? "inherit" : "deny",
      process_isolation: "inherit",
      environment: "explicit",
    };
  }
  return normalizeExecutionPolicy({
    schema_version: 1,
    workspace_root: options.workspaceRoot,
    ...config,
  });
}

/** Fixed order is part of the cross-language fingerprint contract. */
export function canonicalExecutionPolicy(value: unknown): string {
  const policy = normalizeExecutionPolicy(value);
  return JSON.stringify({
    schema_version: policy.schema_version,
    workspace_root: policy.workspace_root,
    filesystem: policy.filesystem,
    network: policy.network,
    process_isolation: policy.process_isolation,
    environment: policy.environment,
  });
}

export function executionPolicyDigest(value: unknown): string {
  return sha256(canonicalExecutionPolicy(value));
}

export function c1ExecutionCapabilities(
  backend: ExecutionBackend,
): ExecutionCapabilities {
  const selected = parse(
    executionBackendSchema,
    backend,
    "INVALID_EXECUTION_POLICY",
  );
  return freezeRecord(
    parse(
      executionCapabilitiesSchema,
      {
        schema_version: 1,
        backend: selected,
        filesystem: { supported: ["unrestricted"], mechanism: "none" },
        network: { supported: ["inherit"], mechanism: "none" },
        process_isolation: { supported: ["inherit"], mechanism: "none" },
        environment: {
          supported: ["explicit"],
          mechanism: "explicit_environment",
          layer: "application",
        },
        supervision: executionSupervision(selected),
      },
      "INVALID_EXECUTION_POLICY",
    ),
  );
}

/** Pure Phase 4C2A contract. Runtime advertisement remains gated by the
 * native macOS capability probe introduced in C2A2.
 */
export function macosSeatbeltExecutionCapabilities(): ExecutionCapabilities {
  return freezeRecord(
    parse(
      executionCapabilitiesSchema,
      {
        schema_version: 2,
        platform: "macos",
        backend: "native_posix",
        filesystem: {
          supported: ["unrestricted", "read_only", "workspace_write"],
          mechanism: "macos_seatbelt",
        },
        network: {
          supported: ["inherit", "deny"],
          mechanism: "macos_seatbelt",
        },
        process_isolation: {
          supported: ["inherit"],
          mechanism: "none",
        },
        environment: {
          supported: ["explicit"],
          mechanism: "explicit_environment",
          layer: "application",
        },
        supervision: {
          mechanism: "posix_process_group",
          layer: "os",
          durable: true,
        },
      },
      "INVALID_EXECUTION_POLICY",
    ),
  );
}

/** Pure Phase 4C2B contract builder. C2B1 callers may use it for retained
 * evidence and compatibility tests, but runtime advertisement stays disabled
 * until the complete C2B2 probe succeeds.
 */
export function linuxBubblewrapExecutionCapabilities(
  runtimeInput: unknown,
): ExecutionCapabilities {
  const sandboxRuntime = parse(
    linuxBubblewrapRuntimeDescriptorSchema,
    runtimeInput,
    "INVALID_EXECUTION_POLICY",
  );
  return freezeRecord(
    parse(
      executionCapabilitiesSchema,
      {
        schema_version: 3,
        platform: "linux",
        backend: "native_posix",
        sandbox_runtime: sandboxRuntime,
        filesystem: {
          supported: ["unrestricted", "read_only", "workspace_write"],
          mechanism: "linux_bubblewrap_mount_namespace",
        },
        network: {
          supported: ["inherit", "deny"],
          mechanism: "linux_network_namespace_seccomp",
        },
        process_isolation: {
          supported: ["inherit"],
          mechanism: "none",
        },
        environment: {
          supported: ["explicit"],
          mechanism: "explicit_environment",
          layer: "application",
        },
        supervision: {
          mechanism: "posix_process_group",
          layer: "os",
          durable: true,
        },
      },
      "INVALID_EXECUTION_POLICY",
    ),
  );
}

export function canonicalExecutionCapabilities(value: unknown): string {
  const caps = parse(
    executionCapabilitiesSchema,
    value,
    "INVALID_EXECUTION_POLICY",
  );
  return JSON.stringify({
    schema_version: caps.schema_version,
    ...(caps.schema_version === 2 || caps.schema_version === 3
      ? { platform: caps.platform }
      : {}),
    backend: caps.backend,
    ...(caps.schema_version === 3
      ? { sandbox_runtime: canonicalSandboxRuntime(caps.sandbox_runtime) }
      : {}),
    filesystem: {
      supported: caps.filesystem.supported,
      mechanism: caps.filesystem.mechanism,
    },
    network: {
      supported: caps.network.supported,
      mechanism: caps.network.mechanism,
    },
    process_isolation: {
      supported: caps.process_isolation.supported,
      mechanism: caps.process_isolation.mechanism,
    },
    environment: {
      supported: caps.environment.supported,
      mechanism: caps.environment.mechanism,
      layer: caps.environment.layer,
    },
    supervision: {
      mechanism: caps.supervision.mechanism,
      layer: caps.supervision.layer,
      durable: caps.supervision.durable,
    },
  });
}

export function executionCapabilitiesDigest(value: unknown): string {
  return sha256(canonicalExecutionCapabilities(value));
}

export type ExecutionPolicyEvaluation = {
  allowed: boolean;
  unmet: { dimension: ExecutionPolicyDimension; reason: "not_implemented" }[];
};

/** Pure admission, not an OS probe or enforcement operation. */
export function evaluateExecutionPolicy(
  policyInput: unknown,
  capabilitiesInput: unknown,
): ExecutionPolicyEvaluation {
  const policy = normalizeExecutionPolicy(policyInput);
  const caps = parse(
    executionCapabilitiesSchema,
    capabilitiesInput,
    "INVALID_EXECUTION_POLICY",
  );
  const unmet: ExecutionPolicyEvaluation["unmet"] = [];
  for (const dimension of [
    "filesystem",
    "network",
    "process_isolation",
    "environment",
  ] as const) {
    const supported: readonly string[] = caps[dimension].supported;
    if (!supported.includes(policy[dimension]))
      unmet.push({ dimension, reason: "not_implemented" });
  }
  return { allowed: unmet.length === 0, unmet };
}

/** No applied evidence can be manufactured from advertised capabilities. */
export function createExecutionAdmissionSnapshot(
  policyInput: unknown,
  capabilitiesInput: unknown,
): ExecutionSecuritySnapshot {
  const policy = normalizeExecutionPolicy(policyInput);
  const caps = parse(
    executionCapabilitiesSchema,
    capabilitiesInput,
    "INVALID_EXECUTION_POLICY",
  );
  if (!evaluateExecutionPolicy(policy, caps).allowed)
    throw new ExecutionPolicyError("EXECUTION_POLICY_UNAVAILABLE");
  return validateExecutionSecuritySnapshot({
    schema_version: caps.schema_version,
    kind: "policy",
    ...(caps.schema_version === 2 || caps.schema_version === 3
      ? { platform: caps.platform }
      : {}),
    ...(caps.schema_version === 3
      ? { sandbox_runtime: caps.sandbox_runtime }
      : {}),
    stage: "admission",
    policy,
    policy_digest: executionPolicyDigest(policy),
    capabilities_digest: executionCapabilitiesDigest(caps),
    backend: caps.backend,
    filesystem:
      policy.filesystem === "unrestricted"
        ? { status: "not_requested" }
        : { status: "not_applied" },
    network:
      policy.network === "inherit"
        ? { status: "not_requested" }
        : { status: "not_applied" },
    process_isolation: { status: "not_requested" },
    environment: { status: "not_applied" },
    supervision: { status: "not_applied" },
  });
}

/** Application-level launch evidence for the TypeScript fallback. This is
 * created only after the child has spawned and its process-tree ownership is
 * established. It does not claim filesystem, network, or process isolation. */
export function createExecutionLaunchSetupSnapshot(
  policyInput: unknown,
  capabilitiesInput: unknown,
): ExecutionSecuritySnapshot {
  const policy = normalizeExecutionPolicy(policyInput);
  const caps = parse(
    executionCapabilitiesSchema,
    capabilitiesInput,
    "INVALID_EXECUTION_POLICY",
  );
  if (!evaluateExecutionPolicy(policy, caps).allowed)
    throw new ExecutionPolicyError("EXECUTION_POLICY_UNAVAILABLE");
  // C2A1 defines the v2 evidence shape, but only the trusted native launch
  // path may construct it after C2A2/C2A3 confirm Seatbelt installation.
  if (caps.schema_version !== 1)
    throw new ExecutionPolicyError("EXECUTION_POLICY_UNAVAILABLE");
  return validateExecutionSecuritySnapshot({
    schema_version: 1,
    kind: "policy",
    stage: "launch_setup",
    policy,
    policy_digest: executionPolicyDigest(policy),
    capabilities_digest: executionCapabilitiesDigest(caps),
    backend: caps.backend,
    filesystem: { status: "not_requested" },
    network: { status: "not_requested" },
    process_isolation: { status: "not_requested" },
    environment: {
      status: "applied",
      mechanism: "explicit_environment",
      layer: "application",
    },
    supervision: {
      status: "applied",
      mechanism: caps.supervision.mechanism,
      layer: caps.supervision.layer,
    },
  });
}

export function executionPolicyPreview(snapshotInput: unknown): string {
  const snapshot = validateExecutionSecuritySnapshot(snapshotInput);
  if (snapshot.kind === "legacy_unknown") {
    return "Execution security: legacy evidence unknown";
  }
  const supervision = executionSupervision(snapshot.backend);
  return [
    "Execution security:",
    `backend: ${snapshot.backend}`,
    `filesystem: ${snapshot.policy.filesystem}`,
    `network: ${snapshot.policy.network}`,
    `process isolation: ${snapshot.policy.process_isolation}`,
    "environment: explicit application filtering",
    `expected process supervision: ${supervision.mechanism} (${supervision.layer})`,
    executionOsSandboxSummary(snapshot),
  ].join("\n");
}

/** Use at trust boundaries in addition to the structural protocol schema.
 * Checking a retained report never promotes evidence or assumes a command ran.
 */
export function validateExecutionSecuritySnapshot(
  value: unknown,
): ExecutionSecuritySnapshot {
  const snapshot = parse(
    executionSecuritySnapshotSchema,
    value,
    "EXECUTION_SECURITY_CORRUPT",
  );
  if (snapshot.kind === "policy") {
    const capabilities =
      snapshot.schema_version === 1
        ? c1ExecutionCapabilities(snapshot.backend)
        : snapshot.schema_version === 2
          ? macosSeatbeltExecutionCapabilities()
          : linuxBubblewrapExecutionCapabilities(snapshot.sandbox_runtime);
    if (
      snapshot.policy_digest !== executionPolicyDigest(snapshot.policy) ||
      snapshot.capabilities_digest !== executionCapabilitiesDigest(capabilities)
    ) {
      throw new ExecutionPolicyError("EXECUTION_SECURITY_CORRUPT");
    }
  }
  return freezeRecord(snapshot);
}

function canonicalSandboxRuntime(
  runtime: LinuxBubblewrapRuntimeDescriptor,
): LinuxBubblewrapRuntimeDescriptor {
  return {
    schema_version: runtime.schema_version,
    mechanism: runtime.mechanism,
    canonical_path: runtime.canonical_path,
    device: runtime.device,
    inode: runtime.inode,
    size: runtime.size,
    mtime_ns: runtime.mtime_ns,
    sha256: runtime.sha256,
    version: runtime.version,
    probe_revision: runtime.probe_revision,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function freezeRecord<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freezeRecord(nested);
    Object.freeze(value);
  }
  return value;
}
