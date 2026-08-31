import { readFileSync } from "node:fs";
import {
  EXECUTION_RESOURCE_LIMIT_MAX,
  executionCapabilitiesSchema,
  linuxBubblewrapRuntimeDescriptorSchema,
  executionOsSandboxSummary,
  executionPolicySchema,
  executionResourceCapabilitiesSchema,
  executionResourceEvidenceEqual,
  executionResourceEvidenceFromSecurity,
  executionResourceEvidenceSchema,
  executionResourceLimitsSchema,
  executionResourceSummary,
  executionSecuritySnapshotSchema,
  isExecutionWorkspacePath,
  type ExecutionBackend,
  type ExecutionCapabilities,
  type ExecutionPolicy,
  type ExecutionPolicyConfig,
} from "@koda/protocol";
import {
  canonicalExecutionCapabilities,
  canonicalExecutionPolicy,
  canonicalExecutionResourceCapabilities,
  canonicalExecutionResourceLimits,
  c1ExecutionCapabilities,
  createExecutionAdmissionSnapshot,
  createExecutionLaunchSetupSnapshot,
  evaluateExecutionPolicy,
  executionCapabilitiesDigest,
  executionPolicyDigest,
  executionResourceCapabilitiesDigest,
  executionResourceLimitsDigest,
  executionPolicyPreview,
  ExecutionPolicyError,
  linuxBubblewrapExecutionCapabilities,
  macosSeatbeltExecutionCapabilities,
  normalizeExecutionPolicy,
  resourceContractExecutionCapabilities,
  resolveExecutionPolicy,
  validateExecutionSecuritySnapshot,
  unsupportedExecutionResourceCapabilities,
} from "@koda/runtime-node";
import { KodaApplication } from "@koda/app";
import { describe, expect, it } from "vitest";

interface Fixtures {
  policy_cases: {
    name: string;
    policy: ExecutionPolicy;
    canonical: string;
    sha256: string;
  }[];
  capability_cases: {
    backend: ExecutionBackend;
    capabilities: ExecutionCapabilities;
    canonical: string;
    sha256: string;
  }[];
  path_cases: { path: string; valid: boolean }[];
  invalid_policy_cases: { name: string; input: unknown }[];
  snapshot_cases: { name: string; input: unknown; valid: boolean }[];
}

interface MacosFixtures {
  capability: {
    capabilities: ExecutionCapabilities;
    canonical: string;
    sha256: string;
  };
  policy: ExecutionPolicy;
  snapshot_cases: { name: string; input: unknown; valid: boolean }[];
}

interface LinuxFixtures {
  runtime: unknown;
  capability: {
    capabilities: ExecutionCapabilities;
    canonical: string;
    sha256: string;
  };
  policy: ExecutionPolicy;
  snapshot_cases: { name: string; input: unknown; valid: boolean }[];
}

interface ResourceContractFixtures {
  policy_cases: {
    name: string;
    input: unknown;
    normalized: unknown;
    canonical: string;
    sha256: string;
  }[];
  resource_canonical: string;
  resource_sha256: string;
  capability_cases: { name: string; canonical: string; sha256: string }[];
  snapshot_cases: { name: string; input: unknown; valid: boolean }[];
}

const fixtures: Fixtures = JSON.parse(
  readFileSync(
    new URL("../fixtures/execution-policy-v1.json", import.meta.url),
    "utf8",
  ),
);
const base = fixtures.policy_cases[0]!.policy;
const caps = c1ExecutionCapabilities("native_posix");
const macosFixtures: MacosFixtures = JSON.parse(
  readFileSync(
    new URL("../fixtures/execution-policy-v2.json", import.meta.url),
    "utf8",
  ),
);
const macosCaps = macosSeatbeltExecutionCapabilities();
const linuxFixtures: LinuxFixtures = JSON.parse(
  readFileSync(
    new URL("../fixtures/execution-policy-v3.json", import.meta.url),
    "utf8",
  ),
);
const linuxCaps = linuxBubblewrapExecutionCapabilities(linuxFixtures.runtime);
const resourceFixtures: ResourceContractFixtures = JSON.parse(
  readFileSync(
    new URL("../fixtures/execution-policy-v4.json", import.meta.url),
    "utf8",
  ),
);

describe("Phase 4C1A execution policy contract", () => {
  it.each(fixtures.policy_cases)(
    "matches cross-language policy bytes and SHA-256: $name",
    ({ policy, canonical, sha256 }) => {
      expect(canonicalExecutionPolicy(reverseKeys(policy))).toBe(canonical);
      expect(executionPolicyDigest(policy)).toBe(sha256);
      expect(executionPolicySchema.parse(policy)).toEqual(policy);
    },
  );

  it.each(fixtures.capability_cases)(
    "matches cross-language capability bytes and SHA-256: $backend",
    ({ backend, capabilities, canonical, sha256 }) => {
      expect(c1ExecutionCapabilities(backend)).toEqual(capabilities);
      expect(canonicalExecutionCapabilities(reverseKeys(capabilities))).toBe(
        canonical,
      );
      expect(executionCapabilitiesDigest(capabilities)).toBe(sha256);
      expect(capabilities.filesystem.mechanism).toBe("none");
      expect(capabilities.network.mechanism).toBe("none");
      expect(capabilities.process_isolation.mechanism).toBe("none");
    },
  );

  it.each(fixtures.path_cases)(
    "checks portable canonical-path syntax: $path ($valid)",
    ({ path, valid }) => {
      expect(isExecutionWorkspacePath(path)).toBe(valid);
      expect(
        executionPolicySchema.safeParse({ ...base, workspace_root: path })
          .success,
      ).toBe(valid);
    },
  );

  it.each(
    fixtures.invalid_policy_cases.filter(
      ({ name }) => name !== "future-version",
    ),
  )("rejects malformed policy without echoing it: $name", ({ input }) => {
    expect(executionPolicySchema.safeParse(input).success).toBe(false);
    expectCode(
      () => normalizeExecutionPolicy(input),
      "INVALID_EXECUTION_POLICY",
    );
  });

  it("rejects any omitted policy field rather than applying defaults", () => {
    for (const field of Object.keys(base)) {
      const input = { ...base } as Record<string, unknown>;
      delete input[field];
      expectCode(
        () => normalizeExecutionPolicy(input),
        "INVALID_EXECUTION_POLICY",
      );
    }
  });

  it("bounds paths in UTF-8 bytes and rejects lone surrogates", () => {
    expect(isExecutionWorkspacePath("/" + "a".repeat(4095))).toBe(true);
    expect(isExecutionWorkspacePath("/" + "a".repeat(4096))).toBe(false);
    expect(isExecutionWorkspacePath("/" + "中".repeat(1365))).toBe(true);
    expect(isExecutionWorkspacePath("/" + "中".repeat(1366))).toBe(false);
    for (const path of ["/\ud800", "/\udc00", "/\ud800x"]) {
      expectCode(
        () => normalizeExecutionPolicy({ ...base, workspace_root: path }),
        "INVALID_EXECUTION_POLICY",
      );
    }
  });

  it("binds every restriction and preserves spelling, Unicode and case", () => {
    const inputs = [
      base,
      { ...base, filesystem: "read_only" },
      { ...base, filesystem: "workspace_write" },
      { ...base, network: "deny" },
      { ...base, process_isolation: "required" },
      { ...base, workspace_root: "/Workspace" },
      { ...base, workspace_root: "/café" },
      { ...base, workspace_root: "/cafe\u0301" },
    ];
    expect(new Set(inputs.map(executionPolicyDigest)).size).toBe(inputs.length);
    expect(
      new Set(
        fixtures.capability_cases.map(({ capabilities }) =>
          executionCapabilitiesDigest(capabilities),
        ),
      ).size,
    ).toBe(4);
  });

  it("resolves default, named profiles, and explicit configuration priority", () => {
    const currentBase = { ...base, schema_version: 2 } as const;
    expect(resolveExecutionPolicy({ workspaceRoot: "/workspace" })).toEqual(
      currentBase,
    );
    expect(
      resolveExecutionPolicy({
        workspaceRoot: "/workspace",
        environmentProfile: "unconfined",
      }),
    ).toEqual(currentBase);
    expect(
      resolveExecutionPolicy({
        workspaceRoot: "/workspace",
        environmentProfile: "read-only",
      }),
    ).toMatchObject({ filesystem: "read_only", network: "deny" });
    expect(
      resolveExecutionPolicy({
        workspaceRoot: "/workspace",
        environmentProfile: "workspace-write",
      }),
    ).toMatchObject({ filesystem: "workspace_write", network: "deny" });
    const config: ExecutionPolicyConfig = {
      filesystem: "read_only",
      network: "inherit",
      process_isolation: "required",
      environment: "explicit",
      resources: { process_cpu_time_ms: 1_000 },
    };
    const resolved = resolveExecutionPolicy({
      workspaceRoot: "/workspace",
      policy: config,
      environmentProfile: "invalid-ignored-by-explicit-option",
    });
    expect(resolved).toMatchObject(config);
    expect(resolved.schema_version).toBe(2);
    config.filesystem = "unrestricted";
    expect(resolved.filesystem).toBe("read_only");
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it("validates and freezes application profile selection with explicit precedence", () => {
    expect(
      () =>
        new KodaApplication({
          environment: { KODA_EXECUTION_PROFILE: "invalid-profile" },
          processDirectory: "/workspace",
        }),
    ).toThrow("KODA_EXECUTION_PROFILE must be one of");
    const resources = { process_cpu_time_ms: 1_000 };
    const application = new KodaApplication({
      environment: { KODA_EXECUTION_PROFILE: "invalid-profile" },
      processDirectory: "/workspace",
      executionPolicy: {
        filesystem: "unrestricted",
        network: "inherit",
        process_isolation: "inherit",
        environment: "explicit",
        resources,
      },
    });
    const captured = application as unknown as {
      executionPolicyConfig: ExecutionPolicyConfig;
    };
    resources.process_cpu_time_ms = 2_000;
    expect(captured.executionPolicyConfig.resources).toEqual({
      process_cpu_time_ms: 1_000,
    });
    expect(Object.isFrozen(captured.executionPolicyConfig)).toBe(true);
    expect(Object.isFrozen(captured.executionPolicyConfig.resources)).toBe(
      true,
    );
  });

  it("never falls back on invalid configured values or accepts a workspace override", () => {
    for (const environmentProfile of [
      "",
      "READ-ONLY",
      "read_only",
      "unconfined ",
      "fixture-secret-marker",
      null,
      1,
    ]) {
      expectCode(
        () =>
          resolveExecutionPolicy({
            workspaceRoot: "/workspace",
            environmentProfile: environmentProfile as string,
          }),
        "INVALID_EXECUTION_POLICY",
      );
    }
    for (const policy of [{ filesystem: "unrestricted" }, null, base]) {
      expectCode(
        () =>
          resolveExecutionPolicy({
            workspaceRoot: "/workspace",
            policy: policy as ExecutionPolicyConfig,
            environmentProfile: "unconfined",
          }),
        "INVALID_EXECUTION_POLICY",
      );
    }
  });

  it.each(fixtures.capability_cases)(
    "refuses all unsupported combinations without a fallback: $backend",
    ({ capabilities }) => {
      for (const filesystem of [
        "unrestricted",
        "read_only",
        "workspace_write",
      ] as const) {
        for (const network of ["inherit", "deny"] as const) {
          for (const process_isolation of ["inherit", "required"] as const) {
            const policy = { ...base, filesystem, network, process_isolation };
            const expected = [
              ...(filesystem === "unrestricted" ? [] : ["filesystem"]),
              ...(network === "inherit" ? [] : ["network"]),
              ...(process_isolation === "inherit" ? [] : ["process_isolation"]),
            ].map((dimension) => ({ dimension, reason: "not_implemented" }));
            expect(evaluateExecutionPolicy(policy, capabilities)).toEqual({
              allowed: expected.length === 0,
              unmet: expected,
            });
            if (expected.length)
              expectCode(
                () => createExecutionAdmissionSnapshot(policy, capabilities),
                "EXECUTION_POLICY_UNAVAILABLE",
              );
            else {
              const snapshot = createExecutionAdmissionSnapshot(
                policy,
                capabilities,
              );
              expect(snapshot).toMatchObject({
                stage: "admission",
                environment: { status: "not_applied" },
                supervision: { status: "not_applied" },
              });
              const setup = createExecutionLaunchSetupSnapshot(
                policy,
                capabilities,
              );
              expect(setup).toMatchObject({
                stage: "launch_setup",
                environment: {
                  status: "applied",
                  mechanism: "explicit_environment",
                  layer: "application",
                },
                supervision: {
                  status: "applied",
                  mechanism: capabilities.supervision.mechanism,
                  layer: capabilities.supervision.layer,
                },
              });
              expect(executionPolicyPreview(snapshot)).toContain(
                "OS sandbox: none",
              );
              expect(JSON.stringify(snapshot)).not.toContain('"applied"');
            }
          }
        }
      }
    },
  );

  it("refuses fabricated or mismatched capabilities and freezes built-in reports", () => {
    const mutations = [
      { ...caps, schema_version: 2 },
      { ...caps, secret: "fixture-secret-marker" },
      {
        ...caps,
        filesystem: {
          supported: ["unrestricted", "read_only"],
          mechanism: "none",
        },
      },
      { ...caps, network: { supported: ["deny"], mechanism: "none" } },
      {
        ...caps,
        process_isolation: {
          supported: ["required"],
          mechanism: "posix_process_group",
        },
      },
      { ...caps, environment: { ...caps.environment, layer: "os" } },
      { ...caps, supervision: { ...caps.supervision, durable: false } },
      { ...caps, backend: "native_windows" },
    ];
    for (const input of mutations) {
      expect(executionCapabilitiesSchema.safeParse(input).success).toBe(false);
      expectCode(
        () => evaluateExecutionPolicy(base, input),
        "INVALID_EXECUTION_POLICY",
      );
    }
    expect(Object.isFrozen(caps.filesystem.supported)).toBe(true);
    expect(Object.isFrozen(caps.supervision)).toBe(true);
  });

  it.each(fixtures.snapshot_cases)(
    "validates shared retained-evidence cases: $name",
    ({ input, valid }) => {
      if (valid)
        expect(validateExecutionSecuritySnapshot(input)).toEqual(input);
      else
        expectCode(
          () => validateExecutionSecuritySnapshot(input),
          "EXECUTION_SECURITY_CORRUPT",
        );
    },
  );

  it("checks semantic digests in addition to structural report schemas", () => {
    const snapshot = {
      ...createExecutionAdmissionSnapshot(base, caps),
      policy_digest: "a".repeat(64),
    };
    expect(executionSecuritySnapshotSchema.safeParse(snapshot).success).toBe(
      true,
    );
    expectCode(
      () => validateExecutionSecuritySnapshot(snapshot),
      "EXECUTION_SECURITY_CORRUPT",
    );
  });

  it("rejects omitted report fields and extra fields on every empty evidence variant", () => {
    const snapshot = createExecutionAdmissionSnapshot(base, caps);
    for (const field of Object.keys(snapshot)) {
      const input = { ...snapshot } as Record<string, unknown>;
      delete input[field];
      expectCode(
        () => validateExecutionSecuritySnapshot(input),
        "EXECUTION_SECURITY_CORRUPT",
      );
    }
    for (const status of ["not_requested", "not_applied", "unknown"]) {
      const field = status === "not_requested" ? "network" : "environment";
      const input = { ...snapshot, [field]: { status } };
      expect(validateExecutionSecuritySnapshot(input)).toEqual(input);
      expectCode(
        () =>
          validateExecutionSecuritySnapshot({
            ...input,
            [field]: { status, secret: "fixture-secret-marker" },
          }),
        "EXECUTION_SECURITY_CORRUPT",
      );
    }
  });

  it("bounds serialized evidence, including JSON escaping expansion", () => {
    const policy = normalizeExecutionPolicy({
      ...base,
      workspace_root: "/" + "\u0001".repeat(3000),
    });
    expectCode(
      () => createExecutionAdmissionSnapshot(policy, caps),
      "EXECUTION_SECURITY_CORRUPT",
    );
    const snapshot = createExecutionAdmissionSnapshot(base, caps);
    expect(Object.isFrozen(snapshot)).toBe(true);
    if (snapshot.kind === "policy")
      expect(Object.isFrozen(snapshot.policy)).toBe(true);
  });
});

describe("Phase 4C2A1 macOS Seatbelt contract", () => {
  it("matches cross-language v2 capability bytes and SHA-256", () => {
    expect(macosCaps).toEqual(macosFixtures.capability.capabilities);
    expect(canonicalExecutionCapabilities(reverseKeys(macosCaps))).toBe(
      macosFixtures.capability.canonical,
    );
    expect(executionCapabilitiesDigest(macosCaps)).toBe(
      macosFixtures.capability.sha256,
    );
    expect(executionCapabilitiesSchema.parse(macosCaps)).toEqual(macosCaps);
  });

  it("supports the macOS filesystem/network matrix but not process isolation", () => {
    for (const filesystem of [
      "unrestricted",
      "read_only",
      "workspace_write",
    ] as const) {
      for (const network of ["inherit", "deny"] as const) {
        const policy = {
          ...macosFixtures.policy,
          filesystem,
          network,
        };
        expect(evaluateExecutionPolicy(policy, macosCaps)).toEqual({
          allowed: true,
          unmet: [],
        });
        const admission = createExecutionAdmissionSnapshot(policy, macosCaps);
        expect(admission).toMatchObject({
          schema_version: 2,
          platform: "macos",
          stage: "admission",
          filesystem: {
            status:
              filesystem === "unrestricted" ? "not_requested" : "not_applied",
          },
          network: {
            status: network === "inherit" ? "not_requested" : "not_applied",
          },
        });
        expect(JSON.stringify(admission)).not.toContain('"applied"');
        expectCode(
          () => createExecutionLaunchSetupSnapshot(policy, macosCaps),
          "EXECUTION_POLICY_UNAVAILABLE",
        );
      }
    }
    const unsupported = {
      ...macosFixtures.policy,
      process_isolation: "required" as const,
    };
    expect(evaluateExecutionPolicy(unsupported, macosCaps)).toEqual({
      allowed: false,
      unmet: [{ dimension: "process_isolation", reason: "not_implemented" }],
    });
    expectCode(
      () => createExecutionAdmissionSnapshot(unsupported, macosCaps),
      "EXECUTION_POLICY_UNAVAILABLE",
    );
  });

  it.each(macosFixtures.snapshot_cases)(
    "validates shared macOS retained evidence: $name",
    ({ input, valid }) => {
      if (valid)
        expect(validateExecutionSecuritySnapshot(input)).toEqual(input);
      else
        expectCode(
          () => validateExecutionSecuritySnapshot(input),
          "EXECUTION_SECURITY_CORRUPT",
        );
    },
  );

  it("generates shared admission but reserves launch evidence for native confirmation", () => {
    const admission = createExecutionAdmissionSnapshot(
      macosFixtures.policy,
      macosCaps,
    );
    const launch = validateExecutionSecuritySnapshot(
      macosFixtures.snapshot_cases[1]!.input,
    );
    expect(admission).toEqual(macosFixtures.snapshot_cases[0]!.input);
    expect(launch).toEqual(macosFixtures.snapshot_cases[1]!.input);
    expect(executionOsSandboxSummary(admission)).toBe(
      "expected OS sandbox: macOS Seatbelt",
    );
    expect(executionPolicyPreview(admission)).toContain(
      "expected OS sandbox: macOS Seatbelt",
    );
    expect(executionOsSandboxSummary(launch)).toBe(
      "OS sandbox: macOS Seatbelt",
    );
    expect(executionPolicyPreview(launch)).toContain(
      "OS sandbox: macOS Seatbelt",
    );
    expectCode(
      () => createExecutionLaunchSetupSnapshot(macosFixtures.policy, macosCaps),
      "EXECUTION_POLICY_UNAVAILABLE",
    );
  });

  it("rejects platform, mechanism, order, future-version, and v1 evidence confusion", () => {
    const invalidCapabilities = [
      { ...macosCaps, schema_version: 3 },
      { ...macosCaps, platform: "linux" },
      {
        ...macosCaps,
        filesystem: { ...macosCaps.filesystem, mechanism: "none" },
      },
      {
        ...macosCaps,
        network: { ...macosCaps.network, supported: ["deny", "inherit"] },
      },
      { ...macosCaps, secret: "fixture-secret-marker" },
    ];
    for (const input of invalidCapabilities)
      expect(executionCapabilitiesSchema.safeParse(input).success).toBe(false);

    const v1 = createExecutionAdmissionSnapshot(base, caps);
    expect(
      executionSecuritySnapshotSchema.safeParse({
        ...v1,
        filesystem: {
          status: "applied",
          mechanism: "macos_seatbelt",
          layer: "os",
        },
      }).success,
    ).toBe(false);
  });
});

describe("Phase 4C2B1 Linux Bubblewrap contract", () => {
  it("matches cross-language v3 capability bytes and SHA-256", () => {
    expect(linuxCaps).toEqual(linuxFixtures.capability.capabilities);
    expect(canonicalExecutionCapabilities(reverseKeys(linuxCaps))).toBe(
      linuxFixtures.capability.canonical,
    );
    expect(executionCapabilitiesDigest(linuxCaps)).toBe(
      linuxFixtures.capability.sha256,
    );
    expect(executionCapabilitiesSchema.parse(linuxCaps)).toEqual(linuxCaps);
    if (linuxCaps.schema_version !== 3) {
      throw new Error("Expected Linux schema-v3 capabilities.");
    }
    expect(Object.isFrozen(linuxCaps.sandbox_runtime)).toBe(true);
  });

  it("binds the complete runtime identity into the capability digest", () => {
    const runtime = linuxBubblewrapRuntimeDescriptorSchema.parse(
      linuxFixtures.runtime,
    );
    const variants = [
      runtime,
      { ...runtime, canonical_path: "/bin/bwrap" },
      { ...runtime, device: "2050" },
      { ...runtime, inode: "123456790" },
      { ...runtime, size: runtime.size + 1 },
      { ...runtime, mtime_ns: "1788076800123456790" },
      { ...runtime, sha256: "a".repeat(64) },
      { ...runtime, version: "bubblewrap 0.11.1" },
    ];
    expect(
      new Set(
        variants.map((candidate) =>
          executionCapabilitiesDigest(
            linuxBubblewrapExecutionCapabilities(candidate),
          ),
        ),
      ).size,
    ).toBe(variants.length);
  });

  it("strictly bounds and versions every runtime identity field", () => {
    const runtime = linuxBubblewrapRuntimeDescriptorSchema.parse(
      linuxFixtures.runtime,
    );
    const invalid = [
      { ...runtime, schema_version: 2 },
      { ...runtime, mechanism: "macos_seatbelt" },
      { ...runtime, canonical_path: "usr/bin/bwrap" },
      { ...runtime, canonical_path: "//usr/bin/bwrap" },
      { ...runtime, canonical_path: "/" + "a".repeat(4096) },
      { ...runtime, device: "00" },
      { ...runtime, device: "not-a-number" },
      { ...runtime, device: "18446744073709551616" },
      { ...runtime, inode: 123456789 },
      { ...runtime, size: Number.MAX_SAFE_INTEGER + 1 },
      { ...runtime, mtime_ns: "-1" },
      { ...runtime, mtime_ns: "18446744073709551616" },
      { ...runtime, sha256: "A".repeat(64) },
      { ...runtime, version: "bubblewrap\n0.11.0" },
      { ...runtime, version: "bubblewrap\u00850.11.0" },
      { ...runtime, version: "" },
      { ...runtime, version: "x".repeat(257) },
      { ...runtime, probe_revision: 2 },
      { ...runtime, secret: "fixture-secret-marker" },
    ];
    for (const candidate of invalid) {
      expect(
        linuxBubblewrapRuntimeDescriptorSchema.safeParse(candidate).success,
      ).toBe(false);
      expectCode(
        () => linuxBubblewrapExecutionCapabilities(candidate),
        "INVALID_EXECUTION_POLICY",
      );
    }
  });

  it("supports the Linux filesystem/network matrix but not process isolation", () => {
    for (const filesystem of [
      "unrestricted",
      "read_only",
      "workspace_write",
    ] as const) {
      for (const network of ["inherit", "deny"] as const) {
        const policy = { ...linuxFixtures.policy, filesystem, network };
        expect(evaluateExecutionPolicy(policy, linuxCaps)).toEqual({
          allowed: true,
          unmet: [],
        });
        const admission = createExecutionAdmissionSnapshot(policy, linuxCaps);
        expect(admission).toMatchObject({
          schema_version: 3,
          platform: "linux",
          sandbox_runtime: linuxFixtures.runtime,
          stage: "admission",
          filesystem: {
            status:
              filesystem === "unrestricted" ? "not_requested" : "not_applied",
          },
          network: {
            status: network === "inherit" ? "not_requested" : "not_applied",
          },
        });
        expect(JSON.stringify(admission)).not.toContain('"applied"');
        expectCode(
          () => createExecutionLaunchSetupSnapshot(policy, linuxCaps),
          "EXECUTION_POLICY_UNAVAILABLE",
        );
      }
    }
    expect(
      evaluateExecutionPolicy(
        { ...linuxFixtures.policy, process_isolation: "required" },
        linuxCaps,
      ),
    ).toEqual({
      allowed: false,
      unmet: [{ dimension: "process_isolation", reason: "not_implemented" }],
    });
  });

  it.each(linuxFixtures.snapshot_cases)(
    "validates shared Linux retained evidence: $name",
    ({ input, valid }) => {
      if (valid)
        expect(validateExecutionSecuritySnapshot(input)).toEqual(input);
      else
        expectCode(
          () => validateExecutionSecuritySnapshot(input),
          "EXECUTION_SECURITY_CORRUPT",
        );
    },
  );

  it("derives Linux sandbox summaries only from matching retained evidence", () => {
    const admission = validateExecutionSecuritySnapshot(
      linuxFixtures.snapshot_cases[0]!.input,
    );
    const launch = validateExecutionSecuritySnapshot(
      linuxFixtures.snapshot_cases[1]!.input,
    );
    expect(executionOsSandboxSummary(admission)).toBe(
      "expected OS sandbox: Linux Bubblewrap + seccomp",
    );
    expect(executionPolicyPreview(admission)).toContain(
      "expected OS sandbox: Linux Bubblewrap + seccomp",
    );
    expect(executionOsSandboxSummary(launch)).toBe(
      "OS sandbox: Linux Bubblewrap + seccomp",
    );
    const missingRuntime = { ...admission } as Record<string, unknown>;
    delete missingRuntime.sandbox_runtime;
    expectCode(
      () => validateExecutionSecuritySnapshot(missingRuntime),
      "EXECUTION_SECURITY_CORRUPT",
    );
  });
});

describe("Phase 4C4A1 resource policy contract", () => {
  const legacyCapabilities = [caps, macosCaps, linuxCaps] as const;
  const resourceCapabilities = legacyCapabilities.map((value) =>
    resourceContractExecutionCapabilities(value),
  );

  it.each(resourceFixtures.policy_cases)(
    "matches v2 policy bytes and SHA-256: $name",
    ({ input, normalized, canonical, sha256 }) => {
      expect(executionPolicySchema.parse(input)).toEqual(input);
      expect(normalizeExecutionPolicy(reverseKeys(input))).toEqual(normalized);
      expect(canonicalExecutionPolicy(reverseKeys(input))).toBe(canonical);
      expect(executionPolicyDigest(input)).toBe(sha256);
    },
  );

  it("normalizes an empty resource object and fingerprints fixed resource order", () => {
    const resources = (
      resourceFixtures.policy_cases.find(
        ({ name }) => name === "all_resources",
      )!.input as { resources: Record<string, number> }
    ).resources;
    expect(canonicalExecutionResourceLimits(reverseKeys(resources))).toBe(
      resourceFixtures.resource_canonical,
    );
    expect(executionResourceLimitsDigest(resources)).toBe(
      resourceFixtures.resource_sha256,
    );
    expect(resourceFixtures.policy_cases[0]!.sha256).toBe(
      resourceFixtures.policy_cases[1]!.sha256,
    );
  });

  it("strictly validates every resource name and numeric boundary", () => {
    for (const name of [
      "process_cpu_time_ms",
      "process_address_space_bytes",
      "job_process_count",
      "process_open_files",
      "process_file_size_bytes",
    ]) {
      expect(executionResourceLimitsSchema.parse({ [name]: 1 })).toEqual({
        [name]: 1,
      });
      expect(
        executionResourceLimitsSchema.parse({
          [name]: EXECUTION_RESOURCE_LIMIT_MAX,
        }),
      ).toEqual({ [name]: EXECUTION_RESOURCE_LIMIT_MAX });
      for (const invalid of [
        0,
        -1,
        1.5,
        EXECUTION_RESOURCE_LIMIT_MAX + 1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        expect(
          executionResourceLimitsSchema.safeParse({ [name]: invalid }).success,
        ).toBe(false);
      }
    }
    expect(
      executionResourceLimitsSchema.safeParse({
        secret: "fixture-secret-marker",
      }).success,
    ).toBe(false);
    expect(
      executionPolicySchema.safeParse({
        ...base,
        resources: { process_cpu_time_ms: 1 },
      }).success,
    ).toBe(false);
  });

  it.each(resourceFixtures.capability_cases)(
    "wraps immutable isolation capability with unsupported resources: $name",
    ({ name, canonical, sha256 }) => {
      const index = resourceFixtures.capability_cases.findIndex(
        (candidate) => candidate.name === name,
      );
      const capability = resourceCapabilities[index]!;
      if (capability.schema_version !== 4) {
        throw new Error("Expected schema-v4 resource capabilities.");
      }
      expect(executionCapabilitiesSchema.parse(capability)).toEqual(capability);
      expect(canonicalExecutionCapabilities(reverseKeys(capability))).toBe(
        canonical,
      );
      expect(executionCapabilitiesDigest(capability)).toBe(sha256);
      expect(
        canonicalExecutionResourceCapabilities(capability.resource_limits),
      ).toBe(
        canonicalExecutionResourceCapabilities(
          unsupportedExecutionResourceCapabilities(),
        ),
      );
      expect(
        executionResourceCapabilitiesDigest(capability.resource_limits),
      ).toBe(
        executionResourceCapabilitiesDigest(
          unsupportedExecutionResourceCapabilities(),
        ),
      );
    },
  );

  it("rejects fabricated v4 support and wrapping an already wrapped capability", () => {
    const capability = resourceCapabilities[0]!;
    if (capability.schema_version !== 4) {
      throw new Error("Expected schema-v4 resource capabilities.");
    }
    const fabricated = {
      ...capability,
      resource_limits: {
        ...capability.resource_limits,
        process_cpu_time_ms: {
          status: "supported",
          backend: "posix_rlimit",
          scope: "process",
          enforcement: "kernel_hard",
          granularity: 1_000,
        },
      },
    };
    expect(
      executionResourceCapabilitiesSchema.safeParse(fabricated.resource_limits)
        .success,
    ).toBe(true);
    expect(executionCapabilitiesSchema.safeParse(fabricated).success).toBe(
      false,
    );
    expectCode(
      () => resourceContractExecutionCapabilities(capability),
      "INVALID_EXECUTION_POLICY",
    );
  });

  it("reports each requested quota and fails closed with a resource error", () => {
    const capability = resourceCapabilities[0]!;
    for (const name of [
      "process_cpu_time_ms",
      "process_address_space_bytes",
      "job_process_count",
      "process_open_files",
      "process_file_size_bytes",
    ] as const) {
      const policy = {
        ...(resourceFixtures.policy_cases[0]!.normalized as Record<
          string,
          unknown
        >),
        resources: { [name]: 1 },
      };
      expect(evaluateExecutionPolicy(policy, capability)).toEqual({
        allowed: false,
        unmet: [{ dimension: name, reason: "not_implemented" }],
      });
      expectCode(
        () => createExecutionAdmissionSnapshot(policy, capability),
        "RESOURCE_LIMIT_UNAVAILABLE",
      );
    }
  });

  it("projects only current retained evidence and formats every status deterministically", () => {
    const current = validateExecutionSecuritySnapshot(
      resourceFixtures.snapshot_cases[0]!.input,
    );
    expect(executionResourceEvidenceFromSecurity(current)).toEqual({
      status: "not_requested",
    });
    expect(
      executionResourceEvidenceFromSecurity(
        createExecutionAdmissionSnapshot(base, caps),
      ),
    ).toBeUndefined();
    expect(executionResourceSummary({ status: "not_requested" })).toBe(
      "resources not requested",
    );
    const unavailable = {
      status: "not_applied" as const,
      requested: {
        process_file_size_bytes: 4_096,
        process_cpu_time_ms: 1_000,
      },
      requested_digest: "a".repeat(64),
      available: unsupportedExecutionResourceCapabilities(),
      available_digest: "b".repeat(64),
    };
    expect(executionResourceSummary(unavailable)).toBe(
      "resources CPU time 1000 ms, file size 4096 bytes · unavailable",
    );
    expect(
      executionResourceEvidenceEqual(unavailable, {
        ...unavailable,
        requested: {
          process_cpu_time_ms: 1_000,
          process_file_size_bytes: 4_096,
        },
      }),
    ).toBe(true);
    expect(
      executionResourceSummary({ ...unavailable, status: "unknown" }),
    ).toContain("· unknown");
    expect(
      executionResourceSummary({
        ...unavailable,
        status: "applied",
        applied: {
          process_cpu_time_ms: {
            limit: 1_000,
            backend: "posix_rlimit",
            scope: "process",
            enforcement: "kernel_hard",
            granularity: 1,
          },
          process_file_size_bytes: {
            limit: 4_096,
            backend: "posix_rlimit",
            scope: "process",
            enforcement: "kernel_hard",
            granularity: 1,
          },
        },
        applied_digest: "c".repeat(64),
      }),
    ).toBe("resources CPU time 1000 ms, file size 4096 bytes · applied");
    expect(() =>
      executionResourceSummary({ ...unavailable, unexpected: true }),
    ).toThrow();
  });

  it.each(resourceFixtures.snapshot_cases)(
    "validates shared v4 retained evidence: $name",
    ({ input, valid }) => {
      expect(valid).toBe(true);
      expect(
        executionResourceEvidenceSchema.parse({
          status: "not_requested",
        }),
      ).toEqual({ status: "not_requested" });
      expect(validateExecutionSecuritySnapshot(input)).toEqual(input);
    },
  );

  it("rejects missing, fabricated, and digest-tampered resource evidence", () => {
    const baseSnapshot = resourceFixtures.snapshot_cases[0]!.input as Record<
      string,
      unknown
    >;
    const missing = { ...baseSnapshot };
    delete missing.resources;
    expectCode(
      () => validateExecutionSecuritySnapshot(missing),
      "EXECUTION_SECURITY_CORRUPT",
    );
    expectCode(
      () =>
        validateExecutionSecuritySnapshot({
          ...baseSnapshot,
          capabilities_digest: "a".repeat(64),
        }),
      "EXECUTION_SECURITY_CORRUPT",
    );
    expectCode(
      () =>
        validateExecutionSecuritySnapshot({
          ...baseSnapshot,
          resources: {
            status: "not_requested",
            secret: "fixture-secret-marker",
          },
        }),
      "EXECUTION_SECURITY_CORRUPT",
    );
  });

  it("resolves trusted profiles to v2 and normalizes resource limits", () => {
    expect(resolveExecutionPolicy({ workspaceRoot: "/workspace" })).toEqual({
      ...base,
      schema_version: 2,
    });
    expect(
      resolveExecutionPolicy({
        workspaceRoot: "/workspace",
        policy: {
          filesystem: "unrestricted",
          network: "inherit",
          process_isolation: "inherit",
          environment: "explicit",
          resources: { process_open_files: 64 },
        },
      }),
    ).toMatchObject({
      schema_version: 2,
      resources: { process_open_files: 64 },
    });
  });
});

function expectCode(operation: () => unknown, code: string): void {
  expect(operation).toThrow(ExecutionPolicyError);
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain("fixture-secret-marker");
    expect(String(error)).not.toContain("/workspace");
    expect(String(error).length).toBeLessThan(256);
    expect(error).not.toHaveProperty("cause");
  }
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, nested]) => [key, reverseKeys(nested)]),
    );
  return value;
}
