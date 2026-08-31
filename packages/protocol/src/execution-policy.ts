import { z } from "zod";

export const EXECUTION_POLICY_SCHEMA_VERSION = 2;
export const EXECUTION_WORKSPACE_MAX_BYTES = 4_096;
export const EXECUTION_SECURITY_MAX_BYTES = 16_384;
export const EXECUTION_SANDBOX_RUNTIME_PATH_MAX_BYTES = 4_096;
export const EXECUTION_SANDBOX_RUNTIME_VERSION_MAX_BYTES = 256;
export const EXECUTION_RESOURCE_LIMIT_MAX = Number.MAX_SAFE_INTEGER;

const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** Lexical validation only. The trusted caller must first resolve the real path.
 * Accept native POSIX, drive, UNC, and extended Windows drive/UNC spellings;
 * never resolve symlinks, normalize Unicode, or case-fold in the wire contract.
 */
export function isExecutionWorkspacePath(path: string): boolean {
  if (
    path.length > EXECUTION_WORKSPACE_MAX_BYTES ||
    utf8Bytes(path) > EXECUTION_WORKSPACE_MAX_BYTES ||
    path.includes("\0") ||
    [...path].some((char) => {
      const code = char.codePointAt(0)!;
      return code >= 0xd800 && code <= 0xdfff;
    })
  ) {
    return false;
  }
  if (path.startsWith("/") && !path.startsWith("//")) {
    return path === "/" || validParts(path.slice(1).split("/"));
  }
  let windows = path;
  if (windows.startsWith("\\\\?\\UNC\\")) {
    windows = `\\\\${windows.slice(8)}`;
  } else if (windows.startsWith("\\\\?\\")) {
    windows = windows.slice(4);
    if (!/^[A-Za-z]:\\/u.test(windows)) return false;
  }
  let parts: string[];
  if (/^[A-Za-z]:\\/u.test(windows)) {
    const rest = windows.slice(3);
    parts = rest === "" ? [] : rest.split("\\");
  } else if (windows.startsWith("\\\\")) {
    parts = windows.slice(2).split("\\");
    if (parts.length === 3 && parts[2] === "") parts.pop();
    if (parts.length < 2) return false;
  } else {
    return false;
  }
  return (
    validParts(parts) &&
    parts.every(
      (part) =>
        !/[<>:"/|?*\u0000-\u001f]/u.test(part) &&
        !/[. ]$/u.test(part) &&
        !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part),
    )
  );
}

function validParts(parts: string[]): boolean {
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

const executionPolicyBaseShape = {
  workspace_root: z
    .string()
    .refine(isExecutionWorkspacePath, "Invalid workspace root."),
  filesystem: z.enum(["unrestricted", "read_only", "workspace_write"]),
  network: z.enum(["inherit", "deny"]),
  process_isolation: z.enum(["inherit", "required"]),
  environment: z.literal("explicit"),
} as const;

const executionResourceLimitSchema = z
  .number()
  .int()
  .safe()
  .positive()
  .max(EXECUTION_RESOURCE_LIMIT_MAX);

export const executionResourceLimitNameSchema = z.enum([
  "process_cpu_time_ms",
  "process_address_space_bytes",
  "job_process_count",
  "process_open_files",
  "process_file_size_bytes",
]);

function rejectUnknownResourceLimitNames(
  value: Record<string, unknown>,
  context: z.RefinementCtx,
): void {
  for (const name of Object.keys(value)) {
    if (!executionResourceLimitNameSchema.safeParse(name).success) {
      context.addIssue({
        code: "custom",
        message: "Unknown resource limit.",
        path: [name],
      });
    }
  }
}

export const executionResourceLimitsSchema = z
  .record(z.string(), executionResourceLimitSchema)
  .superRefine(rejectUnknownResourceLimitNames);

export const executionPolicyV1Schema = z
  .object({
    schema_version: z.literal(1),
    ...executionPolicyBaseShape,
  })
  .strict();

const executionPolicyV2BaseShape = {
  schema_version: z.literal(EXECUTION_POLICY_SCHEMA_VERSION),
  ...executionPolicyBaseShape,
} as const;

export const executionPolicyV2Schema = z.union([
  z.object(executionPolicyV2BaseShape).strict(),
  z
    .object({
      ...executionPolicyV2BaseShape,
      resources: executionResourceLimitsSchema,
    })
    .strict(),
]);

export const executionPolicySchema = z.union([
  executionPolicyV1Schema,
  executionPolicyV2Schema,
]);

// Workspace authority and schema selection are deliberately absent from the
// trusted configuration surface. The application always resolves this shape
// into the current policy schema.
export const executionPolicyConfigSchema = z
  .object({
    filesystem: executionPolicyBaseShape.filesystem,
    network: executionPolicyBaseShape.network,
    process_isolation: executionPolicyBaseShape.process_isolation,
    environment: executionPolicyBaseShape.environment,
    resources: executionResourceLimitsSchema.optional(),
  })
  .strict();
export const executionProfileSchema = z.enum([
  "unconfined",
  "read-only",
  "workspace-write",
]);
export const executionBackendSchema = z.enum([
  "native_posix",
  "native_windows",
  "typescript_posix",
  "typescript_windows",
]);
export const executionPlatformSchema = z.enum(["macos", "linux"]);
export const executionPolicyDimensionSchema = z.enum([
  "filesystem",
  "network",
  "process_isolation",
  "environment",
  "process_cpu_time_ms",
  "process_address_space_bytes",
  "job_process_count",
  "process_open_files",
  "process_file_size_bytes",
]);

const supervisionMechanismSchema = z.enum([
  "posix_process_group",
  "windows_job_object",
  "windows_taskkill_tree",
]);
const enforcementLayerSchema = z.enum(["application", "os"]);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const resourceLimitBackendSchema = z.enum([
  "posix_rlimit",
  "linux_cgroup_v2",
  "windows_job_object",
]);
const resourceLimitScopeSchema = z.enum(["process", "job_tree"]);
const resourceLimitEnforcementSchema = z.enum([
  "kernel_hard",
  "kernel_accounted_hard",
]);
const canonicalU64DecimalSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,19})$/u)
  .refine((value) => {
    try {
      return BigInt(value) <= 18_446_744_073_709_551_615n;
    } catch {
      return false;
    }
  }, "Decimal value exceeds u64.");

const linuxSandboxRuntimePathSchema = z
  .string()
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.startsWith("//") &&
      utf8Bytes(value) <= EXECUTION_SANDBOX_RUNTIME_PATH_MAX_BYTES &&
      isExecutionWorkspacePath(value),
    "Invalid Linux sandbox runtime path.",
  );

const sandboxRuntimeVersionSchema = z.string().refine(
  (value) =>
    value.length > 0 &&
    utf8Bytes(value) <= EXECUTION_SANDBOX_RUNTIME_VERSION_MAX_BYTES &&
    !/\p{Cc}/u.test(value) &&
    ![...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code >= 0xd800 && code <= 0xdfff;
    }),
  "Invalid sandbox runtime version.",
);

/** Versioned, bounded identity for the exact Bubblewrap binary whose real
 * capability probe succeeded. It is pure retained evidence in C2B1.
 */
export const linuxBubblewrapRuntimeDescriptorSchema = z
  .object({
    schema_version: z.literal(1),
    mechanism: z.literal("linux_bubblewrap"),
    canonical_path: linuxSandboxRuntimePathSchema,
    device: canonicalU64DecimalSchema,
    inode: canonicalU64DecimalSchema,
    size: z.number().int().safe().nonnegative(),
    mtime_ns: canonicalU64DecimalSchema,
    sha256: digestSchema,
    version: sandboxRuntimeVersionSchema,
    probe_revision: z.literal(1),
  })
  .strict();

export function executionSupervision(backend: ExecutionBackend) {
  return {
    mechanism:
      backend === "native_windows"
        ? ("windows_job_object" as const)
        : backend === "typescript_windows"
          ? ("windows_taskkill_tree" as const)
          : ("posix_process_group" as const),
    layer:
      backend === "typescript_windows"
        ? ("application" as const)
        : ("os" as const),
    durable: backend === "native_posix" || backend === "native_windows",
  };
}

/** Immutable Phase 4C1 capability contract. */
const executionCapabilitiesV1Schema = z
  .object({
    schema_version: z.literal(1),
    backend: executionBackendSchema,
    filesystem: z
      .object({
        supported: z.tuple([z.literal("unrestricted")]),
        mechanism: z.literal("none"),
      })
      .strict(),
    network: z
      .object({
        supported: z.tuple([z.literal("inherit")]),
        mechanism: z.literal("none"),
      })
      .strict(),
    process_isolation: z
      .object({
        supported: z.tuple([z.literal("inherit")]),
        mechanism: z.literal("none"),
      })
      .strict(),
    environment: z
      .object({
        supported: z.tuple([z.literal("explicit")]),
        mechanism: z.literal("explicit_environment"),
        layer: z.literal("application"),
      })
      .strict(),
    supervision: z
      .object({
        mechanism: supervisionMechanismSchema,
        layer: enforcementLayerSchema,
        durable: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .refine((value) => {
    const expected = executionSupervision(value.backend);
    return (
      value.supervision.mechanism === expected.mechanism &&
      value.supervision.layer === expected.layer &&
      value.supervision.durable === expected.durable
    );
  }, "Inconsistent backend supervision capability.");

/** Phase 4C2A contract shape. The runtime must not advertise this capability
 * until the macOS Seatbelt probe and launch enforcement are implemented.
 */
const executionCapabilitiesV2Schema = z
  .object({
    schema_version: z.literal(2),
    platform: z.literal("macos"),
    backend: z.literal("native_posix"),
    filesystem: z
      .object({
        supported: z.tuple([
          z.literal("unrestricted"),
          z.literal("read_only"),
          z.literal("workspace_write"),
        ]),
        mechanism: z.literal("macos_seatbelt"),
      })
      .strict(),
    network: z
      .object({
        supported: z.tuple([z.literal("inherit"), z.literal("deny")]),
        mechanism: z.literal("macos_seatbelt"),
      })
      .strict(),
    process_isolation: z
      .object({
        supported: z.tuple([z.literal("inherit")]),
        mechanism: z.literal("none"),
      })
      .strict(),
    environment: z
      .object({
        supported: z.tuple([z.literal("explicit")]),
        mechanism: z.literal("explicit_environment"),
        layer: z.literal("application"),
      })
      .strict(),
    supervision: z
      .object({
        mechanism: z.literal("posix_process_group"),
        layer: z.literal("os"),
        durable: z.literal(true),
      })
      .strict(),
  })
  .strict();

/** Phase 4C2B Linux contract shape. C2B1 must not advertise this capability;
 * C2B2 may do so only after the exact retained runtime passes the real probe.
 */
const executionCapabilitiesV3Schema = z
  .object({
    schema_version: z.literal(3),
    platform: z.literal("linux"),
    backend: z.literal("native_posix"),
    sandbox_runtime: linuxBubblewrapRuntimeDescriptorSchema,
    filesystem: z
      .object({
        supported: z.tuple([
          z.literal("unrestricted"),
          z.literal("read_only"),
          z.literal("workspace_write"),
        ]),
        mechanism: z.literal("linux_bubblewrap_mount_namespace"),
      })
      .strict(),
    network: z
      .object({
        supported: z.tuple([z.literal("inherit"), z.literal("deny")]),
        mechanism: z.literal("linux_network_namespace_seccomp"),
      })
      .strict(),
    process_isolation: z
      .object({
        supported: z.tuple([z.literal("inherit")]),
        mechanism: z.literal("none"),
      })
      .strict(),
    environment: z
      .object({
        supported: z.tuple([z.literal("explicit")]),
        mechanism: z.literal("explicit_environment"),
        layer: z.literal("application"),
      })
      .strict(),
    supervision: z
      .object({
        mechanism: z.literal("posix_process_group"),
        layer: z.literal("os"),
        durable: z.literal(true),
      })
      .strict(),
  })
  .strict();

export const executionResourceLimitCapabilitySchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("unsupported") }).strict(),
    z
      .object({
        status: z.literal("supported"),
        backend: resourceLimitBackendSchema,
        scope: resourceLimitScopeSchema,
        enforcement: resourceLimitEnforcementSchema,
        granularity: executionResourceLimitSchema,
      })
      .strict(),
  ],
);

export const executionResourceCapabilitiesSchema = z
  .object({
    process_cpu_time_ms: executionResourceLimitCapabilitySchema,
    process_address_space_bytes: executionResourceLimitCapabilitySchema,
    job_process_count: executionResourceLimitCapabilitySchema,
    process_open_files: executionResourceLimitCapabilitySchema,
    process_file_size_bytes: executionResourceLimitCapabilitySchema,
  })
  .strict();

const executionCapabilitiesV4CommonShape = {
  schema_version: z.literal(4),
  backend: executionBackendSchema,
  filesystem: z
    .object({
      supported: z.union([
        z.tuple([z.literal("unrestricted")]),
        z.tuple([
          z.literal("unrestricted"),
          z.literal("read_only"),
          z.literal("workspace_write"),
        ]),
      ]),
      mechanism: z.enum([
        "none",
        "macos_seatbelt",
        "linux_bubblewrap_mount_namespace",
      ]),
    })
    .strict(),
  network: z
    .object({
      supported: z.union([
        z.tuple([z.literal("inherit")]),
        z.tuple([z.literal("inherit"), z.literal("deny")]),
      ]),
      mechanism: z.enum([
        "none",
        "macos_seatbelt",
        "linux_network_namespace_seccomp",
      ]),
    })
    .strict(),
  process_isolation: z
    .object({
      supported: z.tuple([z.literal("inherit")]),
      mechanism: z.literal("none"),
    })
    .strict(),
  environment: z
    .object({
      supported: z.tuple([z.literal("explicit")]),
      mechanism: z.literal("explicit_environment"),
      layer: z.literal("application"),
    })
    .strict(),
  supervision: z
    .object({
      mechanism: supervisionMechanismSchema,
      layer: enforcementLayerSchema,
      durable: z.boolean(),
    })
    .strict(),
  resource_limits: executionResourceCapabilitiesSchema,
} as const;

function refineExecutionCapabilitiesV4(
  value: {
    resource_limits: z.infer<typeof executionResourceCapabilitiesSchema>;
  },
  context: z.RefinementCtx,
  legacySchema: z.ZodType,
  legacyVersion: 1 | 2 | 3,
): void {
  const { resource_limits: _resourceLimits, ...withoutResources } = value;
  const legacy = legacySchema.safeParse({
    ...withoutResources,
    schema_version: legacyVersion,
  });
  const unsupported = Object.values(value.resource_limits).every(
    (entry) => entry.status === "unsupported",
  );
  if (!legacy.success || !unsupported) {
    context.addIssue({
      code: "custom",
      message: "Inconsistent Phase 4C4A resource capability.",
    });
  }
}

const executionCapabilitiesV4Schema = z.union([
  z
    .object(executionCapabilitiesV4CommonShape)
    .strict()
    .superRefine((value, context) =>
      refineExecutionCapabilitiesV4(
        value,
        context,
        executionCapabilitiesV1Schema,
        1,
      ),
    ),
  z
    .object({
      ...executionCapabilitiesV4CommonShape,
      platform: z.literal("macos"),
    })
    .strict()
    .superRefine((value, context) =>
      refineExecutionCapabilitiesV4(
        value,
        context,
        executionCapabilitiesV2Schema,
        2,
      ),
    ),
  z
    .object({
      ...executionCapabilitiesV4CommonShape,
      platform: z.literal("linux"),
      sandbox_runtime: linuxBubblewrapRuntimeDescriptorSchema,
    })
    .strict()
    .superRefine((value, context) =>
      refineExecutionCapabilitiesV4(
        value,
        context,
        executionCapabilitiesV3Schema,
        3,
      ),
    ),
]);

export const executionCapabilitiesSchema = z.union([
  executionCapabilitiesV1Schema,
  executionCapabilitiesV2Schema,
  executionCapabilitiesV3Schema,
  executionCapabilitiesV4Schema,
]);

export const executionEnforcementEvidenceSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("not_requested") }).strict(),
    z.object({ status: z.literal("not_applied") }).strict(),
    z.object({ status: z.literal("unknown") }).strict(),
    z
      .object({
        status: z.literal("applied"),
        mechanism: z.enum([
          "explicit_environment",
          "macos_seatbelt",
          "linux_bubblewrap_mount_namespace",
          "linux_network_namespace_seccomp",
          "posix_process_group",
          "windows_job_object",
          "windows_taskkill_tree",
        ]),
        layer: enforcementLayerSchema,
      })
      .strict(),
  ],
);

const policySecuritySnapshotV1Schema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("policy"),
    stage: z.enum(["admission", "launch_setup"]),
    policy: executionPolicyV1Schema,
    policy_digest: digestSchema,
    capabilities_digest: digestSchema,
    backend: executionBackendSchema,
    filesystem: executionEnforcementEvidenceSchema,
    network: executionEnforcementEvidenceSchema,
    process_isolation: executionEnforcementEvidenceSchema,
    environment: executionEnforcementEvidenceSchema,
    supervision: executionEnforcementEvidenceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const reject = () =>
      context.addIssue({
        code: "custom",
        message: "Inconsistent execution security evidence.",
      });
    for (const dimension of [
      "filesystem",
      "network",
      "process_isolation",
    ] as const) {
      const requested =
        value.policy[dimension] !==
        (dimension === "filesystem" ? "unrestricted" : "inherit");
      const status = value[dimension].status;
      // No C1 report may turn supervision or application filtering into OS isolation.
      if (
        status === "applied" ||
        (requested ? status === "not_requested" : status !== "not_requested")
      )
        reject();
    }
    for (const dimension of ["environment", "supervision"] as const) {
      const evidence = value[dimension];
      if (evidence.status === "not_requested") reject();
      if (evidence.status !== "applied") continue;
      const expected =
        dimension === "environment"
          ? { mechanism: "explicit_environment", layer: "application" }
          : executionSupervision(value.backend);
      if (
        value.stage !== "launch_setup" ||
        evidence.mechanism !== expected.mechanism ||
        evidence.layer !== expected.layer
      )
        reject();
    }
  });

const policySecuritySnapshotV2Schema = z
  .object({
    schema_version: z.literal(2),
    kind: z.literal("policy"),
    platform: executionPlatformSchema,
    stage: z.enum(["admission", "launch_setup"]),
    policy: executionPolicyV1Schema,
    policy_digest: digestSchema,
    capabilities_digest: digestSchema,
    backend: z.literal("native_posix"),
    filesystem: executionEnforcementEvidenceSchema,
    network: executionEnforcementEvidenceSchema,
    process_isolation: executionEnforcementEvidenceSchema,
    environment: executionEnforcementEvidenceSchema,
    supervision: executionEnforcementEvidenceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const reject = () =>
      context.addIssue({
        code: "custom",
        message: "Inconsistent execution security evidence.",
      });
    for (const dimension of ["filesystem", "network"] as const) {
      const requested =
        value.policy[dimension] !==
        (dimension === "filesystem" ? "unrestricted" : "inherit");
      const evidence = value[dimension];
      if (!requested) {
        if (evidence.status !== "not_requested") reject();
        continue;
      }
      if (evidence.status === "unknown") continue;
      if (value.stage === "admission") {
        if (evidence.status !== "not_applied") reject();
      } else if (
        evidence.status !== "applied" ||
        evidence.mechanism !== "macos_seatbelt" ||
        evidence.layer !== "os"
      ) {
        reject();
      }
    }
    if (value.process_isolation.status !== "not_requested") reject();
    for (const dimension of ["environment", "supervision"] as const) {
      const evidence = value[dimension];
      if (evidence.status === "not_requested") {
        reject();
        continue;
      }
      if (evidence.status !== "applied") continue;
      const expected =
        dimension === "environment"
          ? { mechanism: "explicit_environment", layer: "application" }
          : { mechanism: "posix_process_group", layer: "os" };
      if (
        value.stage !== "launch_setup" ||
        evidence.mechanism !== expected.mechanism ||
        evidence.layer !== expected.layer
      )
        reject();
    }
  });

const policySecuritySnapshotV3Schema = z
  .object({
    schema_version: z.literal(3),
    kind: z.literal("policy"),
    platform: z.literal("linux"),
    sandbox_runtime: linuxBubblewrapRuntimeDescriptorSchema,
    stage: z.enum(["admission", "launch_setup"]),
    policy: executionPolicyV1Schema,
    policy_digest: digestSchema,
    capabilities_digest: digestSchema,
    backend: z.literal("native_posix"),
    filesystem: executionEnforcementEvidenceSchema,
    network: executionEnforcementEvidenceSchema,
    process_isolation: executionEnforcementEvidenceSchema,
    environment: executionEnforcementEvidenceSchema,
    supervision: executionEnforcementEvidenceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const reject = () =>
      context.addIssue({
        code: "custom",
        message: "Inconsistent execution security evidence.",
      });
    for (const dimension of ["filesystem", "network"] as const) {
      const requested =
        value.policy[dimension] !==
        (dimension === "filesystem" ? "unrestricted" : "inherit");
      const evidence = value[dimension];
      if (!requested) {
        if (evidence.status !== "not_requested") reject();
        continue;
      }
      if (evidence.status === "unknown") continue;
      const expectedMechanism =
        dimension === "filesystem"
          ? "linux_bubblewrap_mount_namespace"
          : "linux_network_namespace_seccomp";
      if (value.stage === "admission") {
        if (evidence.status !== "not_applied") reject();
      } else if (
        evidence.status !== "applied" ||
        evidence.mechanism !== expectedMechanism ||
        evidence.layer !== "os"
      ) {
        reject();
      }
    }
    if (value.process_isolation.status !== "not_requested") reject();
    for (const dimension of ["environment", "supervision"] as const) {
      const evidence = value[dimension];
      if (evidence.status === "not_requested") {
        reject();
        continue;
      }
      if (evidence.status !== "applied") continue;
      const expected =
        dimension === "environment"
          ? { mechanism: "explicit_environment", layer: "application" }
          : { mechanism: "posix_process_group", layer: "os" };
      if (
        value.stage !== "launch_setup" ||
        evidence.mechanism !== expected.mechanism ||
        evidence.layer !== expected.layer
      )
        reject();
    }
  });

const nonEmptyExecutionResourceLimitsSchema =
  executionResourceLimitsSchema.refine(
    (value) => Object.keys(value).length > 0,
    "At least one resource limit is required.",
  );

export const executionResourceAppliedLimitSchema = z
  .object({
    limit: executionResourceLimitSchema,
    backend: resourceLimitBackendSchema,
    scope: resourceLimitScopeSchema,
    enforcement: resourceLimitEnforcementSchema,
    granularity: executionResourceLimitSchema,
  })
  .strict();

export const executionResourceAppliedLimitsSchema = z
  .record(z.string(), executionResourceAppliedLimitSchema)
  .superRefine(rejectUnknownResourceLimitNames)
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one applied resource limit is required.",
  );

export const executionResourceEvidenceSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_requested") }).strict(),
  z
    .object({
      status: z.literal("not_applied"),
      requested: nonEmptyExecutionResourceLimitsSchema,
      requested_digest: digestSchema,
      available: executionResourceCapabilitiesSchema,
      available_digest: digestSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("unknown"),
      requested: nonEmptyExecutionResourceLimitsSchema,
      requested_digest: digestSchema,
      available: executionResourceCapabilitiesSchema,
      available_digest: digestSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("applied"),
      requested: nonEmptyExecutionResourceLimitsSchema,
      requested_digest: digestSchema,
      available: executionResourceCapabilitiesSchema,
      available_digest: digestSchema,
      applied: executionResourceAppliedLimitsSchema,
      applied_digest: digestSchema,
    })
    .strict(),
]);

const policySecuritySnapshotV4CommonShape = {
  schema_version: z.literal(4),
  kind: z.literal("policy"),
  stage: z.enum(["admission", "launch_setup"]),
  policy: executionPolicyV2Schema,
  policy_digest: digestSchema,
  capabilities_digest: digestSchema,
  backend: executionBackendSchema,
  filesystem: executionEnforcementEvidenceSchema,
  network: executionEnforcementEvidenceSchema,
  process_isolation: executionEnforcementEvidenceSchema,
  environment: executionEnforcementEvidenceSchema,
  supervision: executionEnforcementEvidenceSchema,
  resources: executionResourceEvidenceSchema,
} as const;

function refinePolicySecuritySnapshotV4(
  value: {
    policy: z.infer<typeof executionPolicyV2Schema>;
    resources: z.infer<typeof executionResourceEvidenceSchema>;
  } & Record<string, unknown>,
  context: z.RefinementCtx,
  legacySchema: z.ZodType,
  legacyVersion: 1 | 2 | 3,
): void {
  const requested =
    "resources" in value.policy &&
    Object.keys(value.policy.resources).length > 0;
  if (requested === (value.resources.status === "not_requested")) {
    context.addIssue({
      code: "custom",
      message: "Inconsistent resource security evidence.",
    });
  }
  const { resources: _resources, ...withoutResourceEvidence } = value;
  const policyWithoutResources =
    "resources" in value.policy
      ? (({ resources: _policyResources, ...policy }) => policy)(value.policy)
      : value.policy;
  const legacy = legacySchema.safeParse({
    ...withoutResourceEvidence,
    schema_version: legacyVersion,
    policy: { ...policyWithoutResources, schema_version: 1 },
  });
  if (!legacy.success) {
    context.addIssue({
      code: "custom",
      message: "Inconsistent Phase 4C4A base security evidence.",
    });
  }
}

const policySecuritySnapshotV4Schema = z.union([
  z
    .object(policySecuritySnapshotV4CommonShape)
    .strict()
    .superRefine((value, context) =>
      refinePolicySecuritySnapshotV4(
        value,
        context,
        policySecuritySnapshotV1Schema,
        1,
      ),
    ),
  z
    .object({
      ...policySecuritySnapshotV4CommonShape,
      platform: z.literal("macos"),
    })
    .strict()
    .superRefine((value, context) =>
      refinePolicySecuritySnapshotV4(
        value,
        context,
        policySecuritySnapshotV2Schema,
        2,
      ),
    ),
  z
    .object({
      ...policySecuritySnapshotV4CommonShape,
      platform: z.literal("linux"),
      sandbox_runtime: linuxBubblewrapRuntimeDescriptorSchema,
    })
    .strict()
    .superRefine((value, context) =>
      refinePolicySecuritySnapshotV4(
        value,
        context,
        policySecuritySnapshotV3Schema,
        3,
      ),
    ),
]);

export const executionSecuritySnapshotSchema = z
  .union([
    policySecuritySnapshotV1Schema,
    policySecuritySnapshotV2Schema,
    policySecuritySnapshotV3Schema,
    policySecuritySnapshotV4Schema,
    z
      .object({
        schema_version: z.literal(1),
        kind: z.literal("legacy_unknown"),
      })
      .strict(),
  ])
  .refine(
    (value) => utf8Bytes(JSON.stringify(value)) <= EXECUTION_SECURITY_MAX_BYTES,
    "Execution security evidence is too large.",
  );

export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;
export type ExecutionPolicyV2 = z.infer<typeof executionPolicyV2Schema>;
export type ExecutionPolicyConfig = z.infer<typeof executionPolicyConfigSchema>;
export type ExecutionResourceLimits = z.infer<
  typeof executionResourceLimitsSchema
>;
export type ExecutionResourceLimitName = z.infer<
  typeof executionResourceLimitNameSchema
>;
export type ExecutionResourceCapabilities = z.infer<
  typeof executionResourceCapabilitiesSchema
>;
export type ExecutionResourceEvidence = z.infer<
  typeof executionResourceEvidenceSchema
>;
export type ExecutionProfile = z.infer<typeof executionProfileSchema>;
export type ExecutionBackend = z.infer<typeof executionBackendSchema>;
export type ExecutionPlatform = z.infer<typeof executionPlatformSchema>;
export type LinuxBubblewrapRuntimeDescriptor = z.infer<
  typeof linuxBubblewrapRuntimeDescriptorSchema
>;
export type ExecutionPolicyDimension = z.infer<
  typeof executionPolicyDimensionSchema
>;
export type ExecutionCapabilities = z.infer<typeof executionCapabilitiesSchema>;
export type ExecutionEnforcementEvidence = z.infer<
  typeof executionEnforcementEvidenceSchema
>;
export type ExecutionSecuritySnapshot = z.infer<
  typeof executionSecuritySnapshotSchema
>;

/** Produces the user-facing OS sandbox claim from retained evidence only.
 * Admission snapshots describe an expected backend; launch snapshots must
 * carry applied evidence before this function names an active sandbox.
 */
export function executionOsSandboxSummary(
  security: ExecutionSecuritySnapshot | undefined,
): string {
  if (security === undefined || security.kind === "legacy_unknown") {
    return "OS sandbox: unknown (legacy evidence)";
  }

  const requestedEvidence = [
    ...(security.policy.filesystem === "unrestricted"
      ? []
      : [security.filesystem]),
    ...(security.policy.network === "inherit" ? [] : [security.network]),
  ];
  if (requestedEvidence.length === 0) {
    return "OS sandbox: none";
  }
  const expectedMechanisms =
    security.schema_version === 2 ||
    (security.schema_version === 4 &&
      "platform" in security &&
      security.platform === "macos")
      ? requestedEvidence.map(() => "macos_seatbelt" as const)
      : security.schema_version === 3 ||
          (security.schema_version === 4 &&
            "platform" in security &&
            security.platform === "linux")
        ? [
            ...(security.policy.filesystem === "unrestricted"
              ? []
              : ["linux_bubblewrap_mount_namespace"]),
            ...(security.policy.network === "inherit"
              ? []
              : ["linux_network_namespace_seccomp"]),
          ]
        : [];
  const sandboxName =
    security.schema_version === 2 ||
    (security.schema_version === 4 &&
      "platform" in security &&
      security.platform === "macos")
      ? "macOS Seatbelt"
      : security.schema_version === 3 ||
          (security.schema_version === 4 &&
            "platform" in security &&
            security.platform === "linux")
        ? "Linux Bubblewrap + seccomp"
        : undefined;
  if (sandboxName === undefined) return "OS sandbox: none";
  if (
    requestedEvidence.every(
      (evidence, index) =>
        evidence.status === "applied" &&
        evidence.mechanism === expectedMechanisms[index] &&
        evidence.layer === "os",
    )
  )
    return `OS sandbox: ${sandboxName}`;
  if (
    security.stage === "admission" &&
    requestedEvidence.every((evidence) => evidence.status === "not_applied")
  ) {
    return `expected OS sandbox: ${sandboxName}`;
  }
  return "OS sandbox: evidence unavailable";
}
