import type { ExecutionSecuritySnapshot } from "@koda/protocol";
import {
  createExecutionAdmissionSnapshot,
  linuxBubblewrapExecutionCapabilities,
  macosSeatbeltExecutionCapabilities,
  normalizeExecutionPolicy,
  resourceContractExecutionCapabilities,
  validateExecutionSecuritySnapshot,
} from "@koda/runtime-node";

export function macosProtectedAdmissionSecurity(): ExecutionSecuritySnapshot {
  return createExecutionAdmissionSnapshot(
    normalizeExecutionPolicy({
      schema_version: 2,
      workspace_root: "/workspace",
      filesystem: "workspace_write",
      network: "deny",
      process_isolation: "inherit",
      environment: "explicit",
    }),
    resourceContractExecutionCapabilities(macosSeatbeltExecutionCapabilities()),
  );
}

const linuxBubblewrapRuntime = {
  schema_version: 1 as const,
  mechanism: "linux_bubblewrap" as const,
  canonical_path: "/usr/bin/bwrap",
  device: "2049",
  inode: "123456789",
  size: 123456,
  mtime_ns: "1788076800123456789",
  sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  version: "bubblewrap 0.11.0",
  probe_revision: 1 as const,
};

export function linuxProtectedExecutionCapabilities() {
  return resourceContractExecutionCapabilities(
    linuxBubblewrapExecutionCapabilities(linuxBubblewrapRuntime),
  );
}

export function linuxProtectedAdmissionSecurity(
  workspaceRoot = "/workspace",
): ExecutionSecuritySnapshot {
  return createExecutionAdmissionSnapshot(
    normalizeExecutionPolicy({
      schema_version: 2,
      workspace_root: workspaceRoot,
      filesystem: "workspace_write",
      network: "deny",
      process_isolation: "inherit",
      environment: "explicit",
    }),
    linuxProtectedExecutionCapabilities(),
  );
}

export function linuxProtectedLaunchSecurity(
  workspaceRoot = "/workspace",
): ExecutionSecuritySnapshot {
  const admission = linuxProtectedAdmissionSecurity(workspaceRoot);
  if (admission.kind !== "policy" || admission.schema_version !== 4) {
    throw new Error("Expected Linux v4 admission evidence.");
  }
  return validateExecutionSecuritySnapshot({
    ...admission,
    stage: "launch_setup",
    filesystem: {
      status: "applied",
      mechanism: "linux_bubblewrap_mount_namespace",
      layer: "os",
    },
    network: {
      status: "applied",
      mechanism: "linux_network_namespace_seccomp",
      layer: "os",
    },
    environment: {
      status: "applied",
      mechanism: "explicit_environment",
      layer: "application",
    },
    supervision: {
      status: "applied",
      mechanism: "posix_process_group",
      layer: "os",
    },
  });
}

export function macosProtectedLaunchSecurity(): ExecutionSecuritySnapshot {
  const admission = macosProtectedAdmissionSecurity();
  if (admission.kind !== "policy" || admission.schema_version !== 4) {
    throw new Error("Expected macOS v4 admission evidence.");
  }
  return validateExecutionSecuritySnapshot({
    ...admission,
    stage: "launch_setup",
    filesystem: {
      status: "applied",
      mechanism: "macos_seatbelt",
      layer: "os",
    },
    network: {
      status: "applied",
      mechanism: "macos_seatbelt",
      layer: "os",
    },
    environment: {
      status: "applied",
      mechanism: "explicit_environment",
      layer: "application",
    },
    supervision: {
      status: "applied",
      mechanism: "posix_process_group",
      layer: "os",
    },
  });
}
