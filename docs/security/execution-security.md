# Koda Execution Security Guarantees

- Scope: Phase 4C2A
- Status: Complete — macOS native Seatbelt enforcement, clients, lifecycle,
  and platform acceptance delivered; Linux isolation is next
- Last updated: 2026-08-30

Koda separates execution admission, process supervision, and operating-system
isolation. A successful command does not imply that a filesystem or network
sandbox was present. Unconfined clients state `OS sandbox: none` explicitly.

On macOS, the native Supervisor advertises protected capability only after a
real startup self-test through the exact system `/usr/bin/sandbox-exec` proves
an allowed read, denied write, denied network operation, and sandbox-internal
confirmation. Protected Pipe and PTY jobs then use that same builder and a
two-way launch handshake. There is no inference from the host name and no
fallback from a protected policy to unconfined execution.

## Supported profiles

| Profile           | Filesystem request | Network request | Verified macOS native | Other current backends   |
| ----------------- | ------------------ | --------------- | --------------------- | ------------------------ |
| `unconfined`      | unrestricted       | inherited       | supported             | supported                |
| `read-only`       | read only          | denied          | supported             | rejected before approval |
| `workspace-write` | workspace only     | denied          | supported             | rejected before approval |

`KODA_EXECUTION_PROFILE` is read and validated when `KodaApplication` is
constructed. A typed `KodaApplicationOptions.executionPolicy` takes precedence
when supplied by a trusted host. Repository files, model output, Skills,
plugins, MCP tools, and later environment mutation cannot change the captured
selection. The canonical workspace root is added only after trusted workspace
opening.

If the macOS self-test fails, or the selected backend is TypeScript, Linux, or
Windows, Koda returns `EXECUTION_POLICY_UNAVAILABLE` before approval, grant
matching, native job creation, or user-process launch. It never silently
downgrades a protected profile to `unconfined`.

## Backend guarantees

| Platform/backend              | Process-tree supervision | Durable across supervisor restart | Filesystem/network sandbox              |
| ----------------------------- | ------------------------ | --------------------------------- | --------------------------------------- |
| macOS `native_posix` verified | POSIX process group      | yes                               | macOS Seatbelt for requested dimensions |
| Linux `native_posix`          | POSIX process group      | yes                               | none                                    |
| `native_windows`              | Windows Job Object       | yes                               | none                                    |
| `typescript_posix`            | POSIX process group      | no                                | none                                    |
| `typescript_windows`          | `taskkill` tree fallback | no                                | none                                    |

All backends launch an explicit argument vector without reconstructing a shell
string and apply Koda's allowlisted environment. Process supervision supports
timeouts, cancellation, and tree cleanup; it is not filesystem, network, or
process-namespace isolation. Seatbelt process inheritance is likewise not
reported as a process namespace. `process_isolation = required` remains
unsupported.

Koda does not currently guarantee read privacy, secret output redaction,
resource quotas, domain/port-level network policy, or sandboxing for providers,
MCP servers, and plugins. Those remain later Phase 4C work.

## Evidence lifecycle

Preparation creates an `admission` snapshot containing the frozen policy,
backend, capability digest, requested dimensions, and expected mechanism. The
approval preview still distinguishes expected protection from applied
evidence. Immediately before execution Koda revalidates the workspace identity,
policy digest, backend, and capability digest. Any change fails before launch.

For protected macOS execution, the sandbox bootstrap first confirms its PID
from inside Seatbelt and then waits on a second release pipe. The Worker checks
the retained process-start identity, records `launch_setup`, publishes
`running`, and only then permits user `exec`. A failure before release creates
no applied filesystem/network evidence and cannot run user code. For
`workspace_write`, `TMPDIR`, `TMP`, and `TEMP` point to one private mode-0700
per-job scratch directory; its lifecycle follows the durable job.

Current command results,
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

Phase 4C2A acceptance runs real macOS protected Pipe and PTY commands, proves
read-only and network-denied side effects, validates workspace/scratch-only
writes, and verifies that inherited network access does not widen either
filesystem policy. It checks v2 applied evidence, kills the Worker between
sandbox confirmation and user release to prove that no user side effect
occurs, and exercises a protected background PTY through attach, input
ownership, resize, detach, Supervisor restart, reattach, and completion.

Shared client tests require the same retained v2 evidence in app-server process
summaries and require CLI diagnostics, TUI activity history, and TUI process
views to derive their sandbox label from that evidence. A client cannot name
Seatbelt merely because a protected policy was requested: admission reports
say `expected OS sandbox`, launch reports require applied evidence, and missing
or historical evidence remains explicitly unknown.

The Linux full-suite job remains the shared regression gate. The macOS native
job must require the real Seatbelt probe and protected matrices; the Windows
native job remains a Job Object/ConPTY and shared-contract regression gate, not
a Windows sandbox acceptance claim.

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
That same-commit result closes Phase 4C1. Phase 4C2A closes only with its own
closing implementation commit passing the revised macOS job and the unchanged
Linux and Windows regression gates. Windows remains a compile/runtime
regression target here, not a Windows sandbox claim.
