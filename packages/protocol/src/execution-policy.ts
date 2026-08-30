import { z } from "zod";

export const EXECUTION_POLICY_SCHEMA_VERSION = 1;
export const EXECUTION_WORKSPACE_MAX_BYTES = 4_096;
export const EXECUTION_SECURITY_MAX_BYTES = 16_384;

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

export const executionPolicySchema = z
  .object({
    schema_version: z.literal(EXECUTION_POLICY_SCHEMA_VERSION),
    workspace_root: z
      .string()
      .refine(isExecutionWorkspacePath, "Invalid workspace root."),
    filesystem: z.enum(["unrestricted", "read_only", "workspace_write"]),
    network: z.enum(["inherit", "deny"]),
    process_isolation: z.enum(["inherit", "required"]),
    environment: z.literal("explicit"),
  })
  .strict();

// Workspace authority is deliberately absent from the configuration surface.
export const executionPolicyConfigSchema = executionPolicySchema
  .omit({ schema_version: true, workspace_root: true })
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
export const executionPolicyDimensionSchema = z.enum([
  "filesystem",
  "network",
  "process_isolation",
  "environment",
]);

const supervisionMechanismSchema = z.enum([
  "posix_process_group",
  "windows_job_object",
  "windows_taskkill_tree",
]);
const enforcementLayerSchema = z.enum(["application", "os"]);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

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

/** C1 has no implemented OS-isolation mechanism. Adding one requires an
 * explicit contract change, not inferring support from the host platform.
 */
export const executionCapabilitiesSchema = z
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
          "posix_process_group",
          "windows_job_object",
          "windows_taskkill_tree",
        ]),
        layer: enforcementLayerSchema,
      })
      .strict(),
  ],
);

const policySecuritySnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("policy"),
    stage: z.enum(["admission", "launch_setup"]),
    policy: executionPolicySchema,
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

export const executionSecuritySnapshotSchema = z
  .union([
    policySecuritySnapshotSchema,
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
export type ExecutionPolicyConfig = z.infer<typeof executionPolicyConfigSchema>;
export type ExecutionProfile = z.infer<typeof executionProfileSchema>;
export type ExecutionBackend = z.infer<typeof executionBackendSchema>;
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
