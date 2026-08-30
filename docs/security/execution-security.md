# Koda Execution Security Guarantees

- Scope: Phase 4C1
- Status: Phase 4C1 complete; application and native enforcement contracts
  accepted on Linux, macOS, and Windows
- Last updated: 2026-08-30

Koda separates execution admission, process supervision, and operating-system
isolation. A successful command does not imply that a filesystem or network
sandbox was present. Current clients state `OS sandbox: none` explicitly.

## Supported profiles

| Profile           | Filesystem request | Network request | C1 result                |
| ----------------- | ------------------ | --------------- | ------------------------ |
| `unconfined`      | unrestricted       | inherited       | supported                |
| `read-only`       | read only          | denied          | rejected before approval |
| `workspace-write` | workspace only     | denied          | rejected before approval |

`KODA_EXECUTION_PROFILE` is read and validated when `KodaApplication` is
constructed. A typed `KodaApplicationOptions.executionPolicy` takes precedence
when supplied by a trusted host. Repository files, model output, Skills,
plugins, MCP tools, and later environment mutation cannot change the captured
selection. The canonical workspace root is added only after trusted workspace
opening.

The protected profiles are intentionally unavailable in C1 because none of the
four current backends can enforce their filesystem and network requirements.
Koda returns `EXECUTION_POLICY_UNAVAILABLE` before approval, grant matching,
native job creation, or user-process launch. It never silently downgrades a
protected profile to `unconfined`.

## Backend guarantees

| Backend              | Process-tree supervision | Durable across supervisor restart | Filesystem/network/process sandbox |
| -------------------- | ------------------------ | --------------------------------- | ---------------------------------- |
| `typescript_posix`   | POSIX process group      | no                                | none                               |
| `typescript_windows` | `taskkill` tree fallback | no                                | none                               |
| `native_posix`       | POSIX process group      | yes                               | none                               |
| `native_windows`     | Windows Job Object       | yes                               | none                               |

All backends launch an explicit argument vector without reconstructing a shell
string and apply Koda's allowlisted environment. Process supervision supports
timeouts, cancellation, and tree cleanup; it is not filesystem, network, or
process-namespace isolation. An approved executable or repository script still
runs with the current operating-system user's authority.

Koda does not currently guarantee read privacy, secret output redaction,
resource quotas, domain-level network policy, temporary-directory isolation, or
protection from an already-approved malicious executable. Those remain later
Phase 4C work.

## Evidence lifecycle

Preparation creates an `admission` snapshot containing the frozen policy,
backend, capability digest, and requested dimensions. The approval preview
shows that snapshot's contract and states `OS sandbox: none`. Immediately
before execution Koda revalidates the workspace identity, policy digest,
backend, and capability digest. Any change fails with
`EXECUTION_POLICY_CHANGED` before launch.

After process-tree ownership and explicit environment setup succeed, Koda
records a `launch_setup` snapshot. Current command results,
`process.started` events, native job state, PTY process summaries, app-server
v15 responses, CLI diagnostics, and TUI process views retain or display this
evidence. A failed launch never upgrades admission evidence to applied launch
evidence.

Exact-command grants are memory-only and bind the canonical workspace, cwd,
argument vector, timeout, policy digest, backend, and capability digest. Policy
preparation happens before grant matching. An old or otherwise valid grant
therefore cannot bypass an unavailable policy or a changed backend contract.

Version-1 durable jobs remain observable as `legacy_unknown`. Koda never
retrofits current guarantees onto historical evidence. A live v1 terminal may
finish under its original Worker; a pending v1 record cannot start a new
command implicitly.

## Failure and compatibility rules

- Invalid, unknown, oversized, or future policy/evidence fields fail strict
  TypeScript and Rust validation without echoing the rejected payload.
- Native protocol mismatch returns `INCOMPATIBLE_PROTOCOL`; there is no silent
  TypeScript fallback.
- Missing or inconsistent new-format evidence returns
  `EXECUTION_SECURITY_CORRUPT` and preserves the durable record for diagnosis.
- Duplicate identical native starts observe one job. Reusing a request ID with
  a different policy is an idempotency conflict and cannot start a second job.
- Supervisor restart, PTY detach/attach, and Worker-loss recovery retain only
  evidence already persisted at the relevant launch boundary.

## Acceptance and CI

The Linux full-suite job runs application, TypeScript fallback, native Pipe and
PTY, negative-launch, restart, and real v1→v2 compatibility tests. The macOS
native job runs the POSIX native and real legacy matrices. The Windows native
job runs Job Object/ConPTY tests plus the shared policy-negative and retained
evidence suite.

The legacy executable is built from pinned commit `3aa84ee`, whose public
executor protocol is version 1. The fixture is created outside the working
tree and is never checked into the repository:

```bash
./scripts/build-phase-4c1-v1-executor.sh /tmp/koda-exec-v1
KODA_LEGACY_EXECUTOR_BINARY=/tmp/koda-exec-v1 \
  pnpm exec vitest run packages/testkit/src/native-execution-policy.test.ts
```

Local results do not substitute for a platform result. Implementation commit
`4f8f4e9` passed the Linux `verify`, macOS `macos-native`, and Windows
`windows-native` jobs in
[GitHub Actions run 33294887963](https://github.com/ronaldo123321/koda/actions/runs/33294887963).
That same-commit result closes Phase 4C1. It does not change the guarantee
matrix above: every current backend still reports no Koda-enforced OS sandbox.
