import type { ExecutionSecuritySnapshot } from "@koda/protocol";
import {
  createExecutionAdmissionSnapshot,
  macosSeatbeltExecutionCapabilities,
  normalizeExecutionPolicy,
  validateExecutionSecuritySnapshot,
} from "@koda/runtime-node";

export function macosProtectedAdmissionSecurity(): ExecutionSecuritySnapshot {
  return createExecutionAdmissionSnapshot(
    normalizeExecutionPolicy({
      schema_version: 1,
      workspace_root: "/workspace",
      filesystem: "workspace_write",
      network: "deny",
      process_isolation: "inherit",
      environment: "explicit",
    }),
    macosSeatbeltExecutionCapabilities(),
  );
}

export function macosProtectedLaunchSecurity(): ExecutionSecuritySnapshot {
  const admission = macosProtectedAdmissionSecurity();
  if (admission.kind !== "policy" || admission.schema_version !== 2) {
    throw new Error("Expected macOS v2 admission evidence.");
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
