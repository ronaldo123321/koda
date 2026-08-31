import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import {
  c1ExecutionCapabilities,
  canonicalExecutionCapabilities,
  canonicalExecutionPolicy,
  canonicalExecutionResourceCapabilities,
  canonicalExecutionResourceLimits,
  executionCapabilitiesDigest,
  executionPolicyDigest,
  executionResourceCapabilitiesDigest,
  executionResourceLimitsDigest,
  linuxBubblewrapExecutionCapabilities,
  macosResourceExecutionCapabilities,
  macosSeatbeltExecutionCapabilities,
  resourceContractExecutionCapabilities,
  validateExecutionSecuritySnapshot,
} from "../packages/runtime-node/dist/index.js";

const sourceUrl = new URL(
  "../packages/testkit/fixtures/execution-policy-v4.json",
  import.meta.url,
);
const targetUrl = new URL(
  "../packages/testkit/fixtures/execution-policy-v5.json",
  import.meta.url,
);
const source = JSON.parse(readFileSync(sourceUrl, "utf8"));

function migrate(value) {
  if (Array.isArray(value)) return value.map(migrate);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key === "job_process_count" ? "job_task_count" : key,
      migrate(nested),
    ]),
  );
}

const fixture = migrate(source);
for (const policyCase of fixture.policy_cases) {
  policyCase.input.schema_version = 3;
  policyCase.normalized.schema_version = 3;
  policyCase.canonical = canonicalExecutionPolicy(policyCase.input);
  policyCase.sha256 = executionPolicyDigest(policyCase.input);
}

const allResources = fixture.policy_cases.find(
  ({ name }) => name === "all_resources",
).input.resources;
fixture.resource_canonical = canonicalExecutionResourceLimits(allResources);
fixture.resource_sha256 = executionResourceLimitsDigest(allResources);

const linuxRuntime = source.snapshot_cases.find(
  ({ name }) => name === "linux_admission",
).input.sandbox_runtime;
const capabilities = {
  generic_native_posix: resourceContractExecutionCapabilities(
    c1ExecutionCapabilities("native_posix"),
  ),
  macos_seatbelt: resourceContractExecutionCapabilities(
    macosSeatbeltExecutionCapabilities(),
  ),
  linux_bubblewrap: resourceContractExecutionCapabilities(
    linuxBubblewrapExecutionCapabilities(linuxRuntime),
  ),
};
for (const capabilityCase of fixture.capability_cases) {
  const capability = capabilities[capabilityCase.name];
  capabilityCase.canonical = canonicalExecutionCapabilities(capability);
  capabilityCase.sha256 = executionCapabilitiesDigest(capability);
}

const macosRlimits = macosResourceExecutionCapabilities();
fixture.macos_rlimit_capability = {
  resource_limits: macosRlimits.resource_limits,
  resource_canonical: canonicalExecutionResourceCapabilities(
    macosRlimits.resource_limits,
  ),
  resource_sha256: executionResourceCapabilitiesDigest(
    macosRlimits.resource_limits,
  ),
  canonical: canonicalExecutionCapabilities(macosRlimits),
  sha256: executionCapabilitiesDigest(macosRlimits),
};

for (const snapshotCase of fixture.snapshot_cases) {
  const snapshot = snapshotCase.input;
  snapshot.schema_version = 5;
  snapshot.policy.schema_version = 3;
  snapshot.policy_digest = executionPolicyDigest(snapshot.policy);
  const capability = snapshotCase.name.startsWith("macos_rlimit")
    ? macosRlimits
    : snapshot.platform === "macos"
      ? macosRlimits
      : snapshot.platform === "linux"
        ? capabilities.linux_bubblewrap
        : capabilities.generic_native_posix;
  snapshot.capabilities_digest = executionCapabilitiesDigest(capability);
  if (snapshot.resources.status !== "not_requested") {
    snapshot.resources.requested_digest = executionResourceLimitsDigest(
      snapshot.resources.requested,
    );
    snapshot.resources.available = capability.resource_limits;
    snapshot.resources.available_digest = executionResourceCapabilitiesDigest(
      capability.resource_limits,
    );
    if (snapshot.resources.status === "applied") {
      snapshot.resources.applied_digest = createHash("sha256")
        .update(JSON.stringify(snapshot.resources.applied), "utf8")
        .digest("hex");
    }
  }
  try {
    validateExecutionSecuritySnapshot(snapshot);
  } catch (error) {
    throw new Error(`invalid generated snapshot: ${snapshotCase.name}`, {
      cause: error,
    });
  }
}

writeFileSync(targetUrl, `${JSON.stringify(fixture, null, 2)}\n`);
