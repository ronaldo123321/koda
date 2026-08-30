# Koda Phase 4C2A macOS Seatbelt Design

- Status: In progress — C2A1 complete; C2A2 next
- Date: 2026-08-30
- Depends on: completed Phase 4C1 execution policy and isolation reporting
- Platform order: macOS first, Linux second, Windows sandboxing last

## Outcome

Phase 4C2A makes the existing `read-only` and `workspace-write` execution
profiles enforceable by the native executor on macOS. It uses macOS Seatbelt at
the Rust Worker launch boundary, reports only controls that were actually
applied, and preserves the existing fail-closed policy, approval, durable
evidence, PTY, background-job, and restart contracts.

The default `unconfined` profile remains available and visibly unconfined.
TypeScript, Linux, and Windows execution continue to reject protected profiles
until their own platform implementations are complete. There is no automatic
downgrade from a protected profile to `unconfined`.

## Platform sequencing decision

Phase 4C platform delivery is intentionally sequential:

1. **macOS:** complete Seatbelt policy, Pipe and PTY integration, clients, and
   native acceptance.
2. **Linux:** implement and accept the Linux isolation backend against the same
   policy and evidence contract.
3. **Windows:** implement restricted-token/AppContainer-style process,
   filesystem, and network controls only after the macOS and Linux paths are
   complete.

Existing Windows CI remains a regression gate for already shipped Job Object,
ConPTY, protocol, and durable-state behavior. Phase 4C2A does not add a Windows
sandbox feature or make future Windows sandbox acceptance a macOS completion
condition. Shared protocol changes must still compile and preserve existing
Windows behavior.

## Why Seatbelt

Koda needs to confine arbitrary local CLI processes rather than only an
App-Sandbox-entitled application bundle. The selected mechanism is the system
`/usr/bin/sandbox-exec` entry point with a generated Seatbelt profile. Koda uses
the absolute system path and never resolves a repository- or `PATH`-provided
binary. OpenAI Codex currently follows the same native boundary and absolute
path rule in its
[Seatbelt implementation](https://github.com/openai/codex/blob/main/codex-rs/sandboxing/src/seatbelt.rs).

`sandbox-exec` is a legacy interface and compatibility problems are possible.
Koda therefore treats availability as a verified runtime capability rather
than assuming it from `target_os = macos`, keeps the mechanism isolated behind
a platform seam, and returns an unavailable/start failure instead of silently
running the command without it.

## Scope

Phase 4C2A includes:

- deterministic macOS Seatbelt policy generation;
- filesystem `unrestricted`, `read_only`, and `workspace_write` capability;
- network `inherit` and `deny` capability;
- native Pipe, foreground PTY, and background PTY execution;
- a sandbox-internal launch confirmation before applied evidence is recorded;
- durable v3 evidence, restart observation, and historical v1/v2 compatibility;
- CLI, TUI, app-server, result, event, and approval-preview reporting;
- real macOS positive and negative acceptance tests.

It does not include:

- Linux or Windows sandbox enforcement;
- `process_isolation = required`;
- arbitrary readable/writable path grants;
- domain, port, proxy, or Unix-socket allowlists;
- secret injection or output redaction;
- resource quotas;
- shell strings, pipelines, redirection, or command substitution;
- provider, MCP server, or plugin sandboxing.

## Policy semantics

The execution policy remains schema version 1. Its meaning does not change:

| Filesystem policy | macOS behavior                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `unrestricted`    | No Koda Seatbelt filesystem restriction is requested.                                                               |
| `read_only`       | Files may be read, but path-based filesystem writes are denied.                                                     |
| `workspace_write` | Files may be read; writes are limited to the canonical workspace and one empty, private, per-job scratch directory. |

| Network policy | macOS behavior                                                                      |
| -------------- | ----------------------------------------------------------------------------------- |
| `inherit`      | No Koda Seatbelt network restriction is requested.                                  |
| `deny`         | Internet, loopback, listen, datagram, and Unix-domain socket operations are denied. |

The per-job scratch directory is an implementation resource, not additional
workspace authority. It is created empty beneath the private job directory,
contains no Koda token or durable metadata, is writable only for
`workspace_write`, and follows job retention. Koda sets `TMPDIR`, `TMP`, and
`TEMP` to that directory for the sandboxed child. `read_only` receives no
writable scratch exception.

Seatbelt process inheritance is not reported as a process namespace or
container. `process_isolation = required` remains unsupported. POSIX process
groups continue to be reported separately as supervision.

## Contract evolution

### Policy

`ExecutionPolicy` stays at schema version 1 so approval identities and existing
configuration remain stable. Canonical workspace resolution remains a trusted
application responsibility.

### Capabilities

`ExecutionCapabilities` becomes a strict versioned union:

- version 1 is the immutable Phase 4C1 contract;
- version 2 permits platform-specific supported-value arrays and adds the
  `macos_seatbelt` enforcement mechanism.

The macOS native hello response retains backend `native_posix` and platform
`macos`. It advertises capability version 2 with all filesystem modes, both
network modes, inherited process isolation, explicit environment filtering,
and durable POSIX process-group supervision. Linux native, Windows native, and
both TypeScript backends retain version-1 capabilities until their platform
work is implemented.

The platform field and capability digest distinguish macOS from the other
`native_posix` implementation. A backend name is not treated as proof of a
mechanism.

### Security evidence

`ExecutionSecuritySnapshot` becomes a strict versioned union:

- version 1 retains the Phase 4C1 no-sandbox rules;
- version 2 permits `macos_seatbelt` applied evidence only for the filesystem
  and network dimensions requested by the frozen policy.

For a protected macOS launch, the launch snapshot reports:

- filesystem: `applied / macos_seatbelt / os` when requested;
- network: `applied / macos_seatbelt / os` when requested;
- process isolation: `not_requested`;
- environment: `applied / explicit_environment / application`;
- supervision: `applied / posix_process_group / os`.

An unconfined dimension remains `not_requested`; it is never described as
applied merely because the same backend could enforce it.

### Native and durable versions

The public executor protocol advances to version 3 because current hello and
security payloads gain a new accepted contract. Version mismatches remain
explicit and never trigger TypeScript fallback.

New jobs use durable format version 3. The new binary continues to read:

- v1 jobs as `legacy_unknown` evidence;
- v2 jobs with their original Phase 4C1 evidence;
- v3 jobs with Phase 4C2 evidence.

Historical jobs are not upgraded using current capabilities. Live historical
Workers may finish under their original contract. Pending historical records
may resume only under the evidence and admission rules their stored version
can prove; no historical record can acquire Seatbelt evidence retroactively.

## Runtime capability verification

The Supervisor computes macOS capabilities once during startup and retains the
result for its lifetime. Protected capability is advertised only when all of
the following pass:

1. the host is macOS;
2. `/usr/bin/sandbox-exec` is the exact selected executable and is usable;
3. the fixed base policy and a bounded self-test profile parse successfully;
4. the sandboxed Koda probe reaches the confirmation handshake;
5. the probe demonstrates an allowed operation and a denied operation without
   relying on repository files.

If verification fails, the Supervisor still supports explicit unconfined
execution and advertises only Phase 4C1 capability. A protected policy is then
rejected before approval or job creation with `EXECUTION_POLICY_UNAVAILABLE`.

Capability state does not broaden while a Supervisor is running. Restart is
required to adopt a newly available mechanism, producing a new capability
digest and invalidating old exact-command grants.

## Seatbelt policy construction

The Rust policy builder owns a fixed, reviewable SBPL base. It starts from
`(deny default)` and adds only the operating-system services required for
ordinary command execution, process inheritance, signals within the sandbox,
standard streams, selected read-only system resources, and PTYs.

Repository content never becomes SBPL source. Dynamic paths are passed through
named `sandbox-exec -D` parameters after canonical validation. The builder has
strict limits for profile bytes, parameter count, and path bytes. It rejects
NUL, unexpected path forms, duplicate roots, and an unavailable scratch
directory.

For `read_only`, no general path-based file write rule is emitted. For
`workspace_write`, the only general write subpaths are the canonical workspace
and the job scratch directory. Network operations are emitted only for
`network = inherit`; a deny policy gains no loopback, listener, datagram, DNS,
or Unix-socket exception.

The final command always begins with `/usr/bin/sandbox-exec`. User argv remains
an argument vector and is never reconstructed as a shell string.

## Launch and confirmation flow

Pipe and PTY execution share one preparation path:

1. The Worker revalidates stored policy, capability digest, workspace identity,
   and job scratch directory.
2. It builds the Seatbelt argv and creates the existing command gate plus a new
   one-way launch-confirmation channel.
3. It spawns the current Koda executable as the unsandboxed command bootstrap
   inside the already-owned POSIX process group.
4. After durable command identity is recorded, the Worker releases the command
   gate.
5. The command bootstrap `exec`s `/usr/bin/sandbox-exec`, which starts a Koda
   sandbox bootstrap under the generated policy.
6. The sandbox bootstrap verifies its inherited descriptor, sends a bounded
   confirmation containing its PID and protocol marker, closes the descriptor,
   and `exec`s the user argv.
7. The Worker verifies that the confirmed PID and start identity still match
   the owned process, then records launch-setup evidence and publishes running.

The sandbox bootstrap does not read the job manifest, token, repository
configuration, or ambient environment. It receives only inherited descriptors
and argv prepared by the trusted Worker.

## Failure semantics

The following fail before user code can run:

- invalid capability or policy digest;
- missing or unusable `/usr/bin/sandbox-exec`;
- profile construction or size failure;
- scratch path/type/ownership failure;
- command/bootstrap spawn failure;
- confirmation timeout, malformed marker, wrong PID, or changed start identity;
- Seatbelt rejection before the sandbox bootstrap starts.

On any failure after process creation, the Worker closes the gate or terminates
the entire process group, confirms cleanup when possible, records
`start_failed` or `termination_uncertain` honestly, and never creates applied
Seatbelt evidence. Raw SBPL, environment values, and secret-bearing argv are
not copied into public errors.

If the sandbox bootstrap confirms and the final user `exec` then fails, the
sandbox itself was applied. The job may retain launch-setup evidence while the
process exits with the ordinary command-start/exit failure; it must not claim
that the requested program succeeded.

## Client behavior

Approval previews show the requested filesystem and network policy, backend,
and expected Seatbelt mechanism before approval. Exact-command grants remain
bound to policy, backend, and capability digests.

After confirmed launch, command results, process events, app-server summaries,
CLI diagnostics, and TUI process views display `OS sandbox: macOS Seatbelt` and
the applied dimensions. Unconfined and historical jobs continue to display
`OS sandbox: none` or legacy unknown evidence explicitly.

No client infers sandboxing from the operating system, profile name, or
successful exit code.

## Delivery slices

### C2A1: contract and compatibility

- Add strict capability/snapshot version unions and `macos_seatbelt`.
  **Completed.** Version 2 is explicitly bound to `platform = macos` and
  `backend = native_posix`; version 1 remains byte-for-byte immutable.
- Add protocol v3 and durable v3 parsing without changing policy v1.
  **Completed.** Durable v1 and v2 remain readable and are never upgraded by
  observation or transition.
- Preserve v1/v2 observation and evidence semantics. **Completed.** Durable v2
  accepts only snapshot v1, while durable v3 can retain snapshot v1 or v2.
- Update cross-language canonical bytes, digests, negative fixtures, and
  approval-grant binding tests. **Completed for the contract boundary.** The
  shared TS/Rust fixture fixes the v2 capability digest at
  `c4b6f5225312147181875e833dcf7fc01387b9786a1622ed1957748d39d9e9b7`.

C2A1 deliberately does not advertise the v2 capability from the native
executor. Both Rust and TypeScript launch-evidence builders reject v2 until a
trusted C2A2/C2A3 Seatbelt launch confirmation exists. The current macOS hello
therefore continues to report C1 unconfined capabilities honestly.

Local C2A1 verification on macOS passed `pnpm typecheck`,
`pnpm format:check`, 41 Rust tests, and 622 TypeScript/integration tests (20
platform-conditional skips), including real PTY, background, reconnect, and
Supervisor-restart coverage.

### C2A2: Seatbelt builder and capability probe

- Add the fixed SBPL assets and bounded parameterized builder.
- Add the sandbox bootstrap command and confirmation framing.
- Add the startup capability probe and no-capability fallback for protected
  admission.
- Test path injection, profile bounds, missing executable, and probe failure.

### C2A3: Pipe and PTY enforcement

- Route macOS protected Pipe and PTY starts through the common builder.
- Add private scratch lifecycle and filtered temp environment.
- Move applied evidence publication behind sandbox confirmation.
- Preserve cancellation, timeout, background, attachment, resize, restart, and
  output contracts.

### C2A4: clients and remote acceptance

- Update previews, results, events, app-server, CLI, and TUI reporting.
- Publish the revised execution-security guarantee.
- Run real macOS negative side-effect and lifecycle matrices.
- Close Phase 4C2A only when the same commit passes the macOS native job and
  the shared Linux suite. Existing Windows jobs remain baseline regressions,
  not a Windows sandbox acceptance requirement.

## Acceptance matrix

1. `read_only + deny` reads normal files but cannot write workspace, external,
   or temporary paths and cannot use network or Unix sockets.
2. `workspace_write + deny` writes the workspace and private scratch but cannot
   write any other path or use network or Unix sockets.
3. Typed combinations with `network = inherit` preserve the requested network
   behavior without broadening filesystem authority.
4. Pipe and PTY commands enforce identical policy semantics.
5. Background PTYs retain sandbox evidence through detach, attach, resize, and
   Supervisor restart.
6. Timeout, cancellation, output failure, and root exit still clean up the
   complete POSIX process group.
7. Missing Seatbelt, malformed policy, confirmation failure, identity mismatch,
   and stale capabilities create no user-process side effect and no applied
   evidence.
8. Policy/backend/capability changes invalidate exact-command grants before
   execution.
9. v1/v2 jobs remain observable without gaining current guarantees; compatible
   live jobs finish without replay.
10. Default unconfined execution and all existing provider, recovery, plugin,
    MCP, app-server, CLI, TUI, native POSIX, and Windows regression tests remain
    green.

## Deferred Windows backlog

The following items are explicitly deferred until the macOS and Linux sandbox
paths are complete:

- select and threat-model the Windows sandbox mechanism;
- restricted primary token and privilege removal;
- filesystem read/write rules for workspace and per-job scratch;
- network denial and later scoped network grants;
- sandbox-internal launch confirmation under Windows process semantics;
- interaction with Job Objects, ConPTY, background jobs, and restart recovery;
- Windows-specific capability and evidence mechanisms;
- negative side-effect, ACL, junction/reparse-point, Named Pipe, loopback, and
  child-process escape tests;
- Windows client reporting and same-commit platform acceptance.

These items must remain visible in the Phase 4 roadmap. They are not silently
treated as complete when macOS or Linux closes.
