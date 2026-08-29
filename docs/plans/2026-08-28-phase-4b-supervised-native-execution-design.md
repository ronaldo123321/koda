# Koda Phase 4B Supervised Native Execution Design

- Status: In progress — Phase 4B4A design accepted; platform foundations next
- Date: 2026-08-28
- Depends on: Phase 4A complete

## Problem

Koda currently starts approved commands directly from the Node runtime. The
runner already rejects shell strings, validates the workspace working
directory, filters the environment, bounds output, records lifecycle events,
and attempts to terminate a POSIX process group or Windows process tree. That
is a useful application-level boundary, but Node still owns the child process.
A control-plane crash loses the live output channels, in-memory termination
handle, and authoritative task status.

Phase 4B introduces a native execution supervisor without moving agent,
provider, approval, or product policy into Rust.

## Decisions

1. `koda-exec` is an independently running local supervisor, not a per-command
   stdio child and not an in-process native addon.
2. Node remains the policy plane. Rust is the process ownership and observation
   plane.
3. The local protocol is versioned independently of the app-server protocol.
4. Every accepted start has an opaque job ID and an idempotency request ID.
5. A Node disconnect never silently kills or repeats an accepted job.
6. A supervisor restart never automatically repeats a job whose start or exit
   is uncertain.
7. Structured argument vectors remain mandatory. Shell strings, pipelines,
   redirection, and command substitution remain unsupported; PTY input is
   explicit, bounded, capability-protected, and single-owner fenced.
8. The existing TypeScript runner remains an explicit compatibility backend
   during migration. Failure to reach Rust never causes a silent fallback.

## Architecture and responsibility boundary

Node validates the workspace-relative working directory, rejects prohibited
executables, filters environment variables, obtains user approval, persists
thread audit events, materializes artifacts, and presents results. It sends the
already approved exact execution request to the supervisor.

Rust validates the wire-level and operating-system-level request again, starts
the process without a shell, owns its complete process tree, applies timeouts,
captures bounded stdout and stderr, persists operational task state, performs
bounded termination, and reports only outcomes supported by durable evidence.
It does not know about models, tools, approval grants, plugins, or providers.

The client connects over a Unix-domain socket on macOS and Linux. Windows uses
a named pipe once its native implementation lands. A single-user endpoint is
placed beneath the private Koda runtime directory; peer ownership and endpoint
permissions are verified before requests are accepted.

Node may start the supervisor when the endpoint is absent, then performs a
mandatory capability handshake. Starting the daemon and starting a job are
separate operations. The daemon lifetime is therefore not coupled to one CLI,
TUI, app-server, or tool invocation.

## Job state machine

The durable state machine is monotonic:

```text
accepted -> starting -> running -> terminating -> exited
                 |          |             |
                 |          +-------------+-> termination_uncertain
                 +----------------------------> start_failed
```

On restart, a previously running job may additionally be observed as
`supervisor_recovered` before returning to `running`. Terminal records are
immutable. Repeating the same request ID with the same canonical request
returns the original job. Reusing it with different parameters fails with an
idempotency conflict.

Before process creation, the supervisor durably records the canonical request
and `starting` state. After it has a PID and native ownership handle, it records
the process identity and `running` state. On exit it records the exit code or
signal, duration, byte counts, truncation flags, and termination evidence.
Records use a temporary file, file synchronization, atomic replacement, and
best-effort parent-directory synchronization.

If Node disconnects, the supervisor and job continue. A later client can query
the job by ID and continue reading captured output. If the supervisor itself
restarts, it reconciles durable records with platform process identity. A job
is reported as recovered only when identity and ownership can be proven. When
the process or its exit result cannot be proven, the state becomes
`termination_uncertain`; the command is never restarted automatically.

## Output model

The supervisor writes stdout and stderr to separate append-only files beneath
the private job directory while also tracking exact byte counts. Reads specify
the stream, byte offset, and maximum length. Responses indicate the next offset,
whether the stream is complete, and whether the configured retention limit
truncated later bytes.

Phase 4B1 does not promise interactive input or reconstruction of a PTY after a
supervisor crash. Persisted bounded logs make foreground results observable
after a Node reconnect. PTY input ownership and attach/detach sessions are a
later slice.

## Local executor protocol

The transport uses a four-byte unsigned big-endian payload length followed by
UTF-8 JSON. The initial maximum frame size is 1 MiB. Messages are strict tagged
objects with a protocol version, request ID, method, and method-specific body.
Responses echo the request ID. Asynchronous events contain a monotonically
increasing per-job sequence number.

Phase 4B1 defines:

- `system/hello`: negotiate protocol version and report platform capabilities.
- `job/start`: accept an exact argument vector, absolute approved working
  directory, filtered environment, timeout, and output limits.
- `job/get`: return current state and available termination evidence.
- `job/output/read`: read a bounded range of one captured stream.
- `job/terminate`: request graceful and then forced tree termination.

Stable protocol errors distinguish malformed frames, incompatible versions,
invalid requests, idempotency conflicts, missing jobs, unsupported platform
capabilities, start failures, and uncertain termination.

## Process ownership

On POSIX systems the command becomes the leader of a new process group. The
supervisor signals the group, waits for a configured grace period, escalates to
`SIGKILL`, and verifies disappearance before reporting termination. PID reuse
must not be treated as proof of identity during recovery.

On Windows the equivalent contract requires a Job Object configured to close
or terminate all assigned processes. Until that implementation is verified,
the handshake reports `job_object: false` and execution is unavailable rather
than approximated with an unproven portable claim.

## Security and limits

- The socket, job records, and captured output are private to the current user.
- Executables are started directly; the protocol contains no shell field.
- Argument count, individual argument size, total request size, environment
  size, timeout, output retention, read size, and concurrent job count have
  hard bounds on both sides.
- Rust accepts an absolute working directory because Node has already resolved
  and approved it, but Rust rejects missing, non-directory, and NUL-containing
  paths. Filesystem sandbox policy remains Phase 4C.
- The protocol never transports provider credentials implicitly. Only the
  already filtered environment is sent.
- Logs and durable records never include secret policy metadata beyond the
  explicit environment values selected by the caller; scoped secret injection
  and redaction remain Phase 4C.

## Delivery slices

### Phase 4B1: protocol and foreground supervision

- Add the Cargo workspace and `koda-exec` binary.
- Implement framing, strict request validation, handshake, private Unix socket,
  daemon startup, POSIX process-group ownership, foreground jobs, bounded
  output files, timeout, cancellation, status, and output reads.
- Add a Node client behind an executor interface and connect the existing
  `WorkspaceCommandRunner` to an explicitly selected native backend.
- Preserve current tool result and audit event shapes.
- Add deterministic protocol, process, reconnect, timeout, cancellation, output
  bound, malformed-frame, and idempotency tests.

### Phase 4B2: restart reconciliation

- Make job records crash durable.
- Reconcile daemon restart states using platform process identity.
- Add job listing, retention, garbage collection, and orphan policy.
- Add kill-point tests around accepted, started, running, terminating, and exit
  persistence boundaries.

The accepted Worker ownership, durable state, restart authentication, retention,
and fault-injection contract is in [Phase 4B2 Worker recovery](2026-08-29-phase-4b2-worker-recovery-design.md).
The accepted PTY, background lifecycle, attachment, cursor, and input ownership
contract is in [Phase 4B3A PTY and background runtime](2026-08-29-phase-4b3a-pty-background-runtime-design.md).
The accepted Agent Tool, app-server process session, TUI pane, and bounded
terminal projection contract is in [Phase 4B3B interactive process UI](2026-08-29-phase-4b3b-interactive-process-ui-design.md).

### Phase 4B3: interactive and background jobs

- **Phase 4B3A complete:** add PTY-backed foreground jobs, managed background
  jobs, attach/detach, resize, bounded input ownership, and reconnect cursors.
- **Phase 4B3B complete:** expose those runtime primitives through the approved
  `exec_terminal` Tool, app-server process sessions, and the TUI interactive
  process workflow.

### Phase 4B4: platform completion

- **Phase 4B4A next:** add platform seams, authenticated Windows Named Pipes,
  process identity, private state security, bootstrap handle inheritance, and
  Windows-native CI without enabling command execution.
- **Phase 4B4B pending:** implement and verify Windows Job Object process-tree
  ownership, termination, timeout, and restart recovery.
- **Phase 4B4C pending:** implement and verify ConPTY interactive execution,
  input, resize, attachment, and terminal recovery.
- Exercise macOS, Linux, and Windows ownership and shutdown matrices.
- Remove the TypeScript compatibility backend only after migration and release
  packaging are complete.

The accepted Phase 4B4A contract is in [Phase 4B4A Windows platform foundations](2026-08-30-phase-4b4a-windows-platform-foundations-design.md).

## Testing and acceptance

Phase 4B1 is complete when deterministic tests prove that:

1. A validated argument vector executes without shell interpretation.
2. The Node client rejects incompatible or malformed supervisor responses.
3. Duplicate identical start requests create exactly one job; conflicting reuse
   is rejected.
4. A Node disconnect and reconnect can observe the same running or completed
   job and read retained output.
5. Timeout and cancellation address the complete POSIX process group and report
   `uncertain` when disappearance cannot be proven.
6. Output and protocol memory use remain bounded under adversarial input.
7. The existing exec tool result and lifecycle audit contract remains stable.
8. The full local TypeScript test suite and Rust test suite pass without live
   model credentials or network access.

## Deferred work

Filesystem, network, environment capability policy, scoped secrets, and OS
sandbox strength reporting remain Phase 4C. Remote transports remain Phase 4D.
Signed native release packaging remains Phase 4E. Child-agent process ownership
and worktree delegation remain Phase 5.

## Phase 4B1 implementation result

Phase 4B1 is implemented on `main` as a Cargo workspace containing the
`koda-exec` binary plus a strict Node client in `@koda/runtime-node`. The daemon
uses a private Unix Socket, verifies the connecting effective user, negotiates
protocol v1 capabilities, accepts idempotent structured starts, owns a POSIX
process group, retains bounded stream bytes in private files, and exposes live
status, output ranges, and termination. `WorkspaceCommandRunner` preserves its
existing approval, result, Artifact, and audit contracts when the native backend
is explicitly selected with `KODA_EXEC_PATH`; native failures never trigger a
silent TypeScript fallback.

The Phase 4B1 deterministic suite covers strict request parsing, bounds,
idempotency conflicts, timeout escalation, a second Node client's reconnect to
the same job, output integrity and Artifact materialization, cancellation, and
the existing TypeScript compatibility backend.

## Phase 4B2 implementation result

Phase 4B2 moves command ownership into one detached Worker per durable job. A
replacement Supervisor authenticates a live Worker with same-UID peer checks,
an HMAC nonce proof, and stored process-start identity. Durable state uses an
atomic `state.json` plus `state.head`: an exact head match is accepted, a
provable one-step interrupted head update is repaired, and rollback or invalid
structure is quarantined. A same-PID command bootstrap blocks approved command
execution until its identity is durable. `job/list` is bounded and paginated;
retention deletes only verified `exited` or `start_failed` records.

Tests kill the Supervisor before Worker launch and while multiple commands are
running, verify continued output, timeout, cancellation, and idempotency after
restart, kill Workers on both sides of the command gate, verify uncertain
cleanup, reject rollback/symlink/wrong-permission state, and preserve the full
TypeScript runner contract. Capability negotiation now reports
`durable_restart_recovery: true`; `job_object` remains false until Phase 4B4.

## Phase 4B3A implementation result

Phase 4B3A keeps PTY ownership inside each detached Worker. The Worker creates
the controlling terminal, persists the command identity before releasing the
same-PID execution gate, drains one raw PTY stream into fixed 64 KiB segments,
and serializes input and resize operations. Retention uses absolute cursors and
whole-segment rotation, so a stale reader receives an explicit recoverable
`cursor_expired` result instead of ambiguous data.

Attachments use HMAC capabilities bound to the job and attachment identity.
Readers are independent; one renewable 15-second lease owns both input and
terminal geometry, and every grant advances a fencing number. Detach and lease
expiry never terminate the command. A restarted Supervisor reconnects to the
original Worker; terminal jobs remain readable directly from their bounded
durable PTY segments.

The strict Node API includes `startPty`, raw attachment operations, and
`NativePtyAttachment`. Real-PTY tests cover TTY/dimension observation, input,
resize and `SIGWINCH`, competing readers/writers, stale fencing, detached
background execution across Supervisor restart, terminal reads, and cursor
rotation while the existing pipe and Worker recovery suite remains intact.

## Phase 4B3B implementation result

Phase 4B3B adds app-server protocol v14 and a long-lived
`InteractiveProcessService` above the Phase 4B3A primitives. Native attachment
capabilities, lease tokens, and fences remain confined to the server; clients
receive random process-session IDs and bounded, workspace-filtered PTY
metadata. The service handles lease renewal and read-only downgrade, cursor
expiry, resize, detach, explicit process-group termination, and shutdown
cleanup without coupling a durable job to an Agent Turn.

The Agent harness exposes an always-approved `exec_terminal` Tool that shares
the structured command-policy boundary with `exec_command`. The TUI adds a
`/processes` workflow, explicit keyboard ownership, safe `Ctrl+C` delivery,
attach/detach and termination controls, and an incremental bounded terminal
projector. Protocol, service, controller, renderer, native integration,
app-server integration, and real-TTY tests close Phase 4B3. Windows named-pipe,
Job Object, and ConPTY ownership remain Phase 4B4.
