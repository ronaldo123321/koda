import type { SecretExecutionEvidence } from "@koda/protocol";

export function destroyedSecretEvidence(): SecretExecutionEvidence {
  return {
    schema_version: 1,
    declaration_digest: "a".repeat(64),
    lease_id: "0123456789abcdef0123456789abcdef",
    aliases: ["api-token"],
    targets: [{ alias: "api-token", environment_variable: "APP_TOKEN_FILE" }],
    lifecycle: "destroyed",
    expires_at_ms: 1_788_000_060_000,
    redactions: { stdout: 1, stderr: 0, pty: 0 },
    cleanup: "completed",
  };
}
