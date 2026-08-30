# Koda Phase 4B4C Windows ConPTY Design

- Status: Complete — Phase 4B4C1 through Phase 4B4C3 implemented and verified
- Date: 2026-08-30
- Depends on: Phase 4B3A PTY runtime and Phase 4B4B Windows Job Object execution
- Target: Windows 10 version 1809 and later, with unchanged macOS/Linux behavior

## Scope

Phase 4B4C completes the native interactive terminal path on Windows. A PTY
request uses ConPTY for terminal semantics and the existing per-job Job Object
for process-tree ownership. The shared attachment, cursor, input lease,
fencing, timeout, cancellation, durable state, and Node client protocols remain
unchanged.

This phase includes:

- ConPTY creation with the requested initial rows and columns;
- direct suspended process creation with both ConPTY and Job Object attributes;
- raw ConPTY UTF-8/VT stream capture into the existing segmented PTY log;
- fenced input, serialized resize, attach/detach, and reconnect;
- descendant-aware natural completion and complete-tree termination;
- Supervisor restart reattachment and conservative Worker-loss recovery; and
- Windows-native acceptance before advertising the `pty` capability.

This phase does not add terminal emulation to the Supervisor, Node runtime, or
TUI. Those layers continue to consume raw terminal bytes and project them with
the existing bounded terminal state.

## Approaches considered

### Reuse pipe execution and emulate a terminal in Node

This would avoid ConPTY but would not provide real Windows console handles,
screen dimensions, control-key behavior, or terminal-aware child behavior. It
would also make a client process responsible for command lifetime. Rejected.

### Add a separate Windows terminal broker

A broker could own each ConPTY independently from `koda-exec`, but it would
duplicate Worker authentication, durable identity, attachment routing, lease
state, crash recovery, and shutdown policy. Rejected for this phase.

### Let the existing Worker own ConPTY and the Job Object

This is the selected approach. It preserves the accepted Phase 4B3A ownership
model and Phase 4B4B failure boundary: the Worker owns all live terminal and
process-tree handles, while the Supervisor only authenticates and routes
requests. No second job state machine or recovery authority is introduced.

## Ownership architecture

Each PTY Worker owns:

- one anonymous ConPTY `HPCON`;
- the host input-write and output-read pipe handles;
- one anonymous `KILL_ON_JOB_CLOSE` Job Object and its completion port;
- the root process and suspended primary thread handles;
- one dedicated output-drain OS thread, a bounded async handoff, and one
  serialized input/resize task;
- the existing segmented PTY output store;
- attachment capabilities and the fenced input lease; and
- timeout and termination state.

The ConPTY handle is never sent to the Supervisor or persisted. A Supervisor
restart reconnects to the same Worker and therefore the same live terminal. A
Worker exit lets Windows close both the Job Object and ConPTY handles; the Job
Object remains the authoritative process-tree containment boundary.

## ConPTY channel construction

The Worker creates two synchronous anonymous pipes, as required by ConPTY:

- ConPTY reads from the input pipe's read side; the Worker writes to its write
  side.
- ConPTY writes to the output pipe's write side; the Worker reads from its read
  side.

These handles are not inherited by the command. The ConPTY-facing ends remain
open through `CreatePseudoConsole` and child `CreateProcessW`, then the Worker
closes its duplicate references. Only the host input-write and output-read ends
remain in the Worker.

Input and output are serviced independently. A blocked input write can never
prevent the output channel from draining. Output bytes remain raw from Koda's
perspective: the executor does not decode UTF-8 or interpret VT sequences.
ConPTY may consume the application's console or VT operations and emit its own
projected VT screen stream, so retained bytes are not promised to be
byte-for-byte identical to child writes.

`PSEUDOCONSOLE_INHERIT_CURSOR` is not enabled. Koda starts a new terminal
session and has no parent console cursor to inherit.

## Atomic process start

PTY process creation preserves the Phase 4B4B persist-before-execute boundary:

1. Persist `CommandStarting`.
2. Create and configure the Job Object and completion port.
3. Create both synchronous ConPTY channels.
4. Call `CreatePseudoConsole` with validated dimensions.
5. Build one `STARTUPINFOEXW` attribute list containing
   `PROC_THREAD_ATTRIBUTE_JOB_LIST` and
   `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`.
6. Resolve the executable, quote argv, build the case-insensitive UTF-16
   environment block, and set `TERM` to the validated PTY value.
7. Call `CreateProcessW` directly with `CREATE_SUSPENDED`,
   `CREATE_NEW_PROCESS_GROUP`, `CREATE_UNICODE_ENVIRONMENT`, and
   `EXTENDED_STARTUPINFO_PRESENT`. Handle inheritance is disabled.
   `STARTF_USESTDHANDLES` explicitly supplies null standard handles so a
   redirected Supervisor or CI host cannot bypass ConPTY through ambient
   standard handles.
8. Persist the root PID and creation-time identity in `CommandStarting`.
9. Resume the primary thread and persist `Running`.

A failure before resume closes ConPTY and the Job Object without executing user
code. A failure after resume terminates the Job Object before publishing a
terminal failure.

The generic Windows process attribute builder accepts three optional attribute
classes: inherited handles, Job Objects, and ConPTY. Worker bootstrap continues
to use only a restricted handle list; Pipe execution uses handles plus a Job;
PTY execution uses a Job plus ConPTY and inherits no handles.

## Input and resize

The existing `PtyCommand` queue remains the single mutation lane for the live
terminal. The writer owns the host input pipe and a clone of the managed
ConPTY controller:

- `Input(bytes)` writes and flushes the exact admitted bytes, then releases the
  pending-byte budget.
- `Resize { rows, cols }` calls `ResizePseudoConsole` with the validated
  dimensions.
- an internal interrupt command writes the terminal control byte used for a
  best-effort Ctrl+C request without consuming a user input lease budget.

Public input and resize continue to require a valid attachment capability,
lease token, and current fence. Queue count, per-write size, and pending byte
limits remain unchanged. Koda never retries a possibly completed input write.

Detach releases input ownership but does not close either ConPTY or the Job
Object. Any number of readers can continue reading the durable output stream.

## Output and natural completion

The output reader continuously drains the host output pipe into
`PtyOutputStore`. The same absolute cursors, 64 KiB segments, retention limit,
cursor-expiry response, and post-terminal reads used on Unix apply on Windows.

Root-process exit alone is not terminal. Natural completion requires:

1. the Job Object reports `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO`;
2. the root exit status is captured;
3. the input writer is stopped and its host pipe handle is closed;
4. `ClosePseudoConsole` runs while the output reader remains active;
5. the output channel reaches EOF and the segmented log is synchronized; and
6. the durable terminal snapshot is published.

This ordering is mandatory. `ClosePseudoConsole` can emit a final frame and can
deadlock if the synchronous output channel is not drained concurrently. The
close operation therefore runs outside the async executor thread while the
reader remains live. A bounded drain timeout records `PTY_OUTPUT_DRAIN_TIMEOUT`
instead of silently dropping final output.

The Windows 10 version 1809 baseline excludes `ReleasePseudoConsole`, which is
available only on newer Windows releases. Koda does not dynamically weaken its
lifetime contract based on that optional API.

## Cancellation and timeout

For a live PTY, graceful termination first attempts to enqueue an internal
Ctrl+C byte on the serialized ConPTY input lane and records
`windows_conpty_ctrl_c`. If the control queue is unavailable or the Job Object
does not become empty within `termination_grace_ms`, the Worker records
`windows_job_object_terminate` and calls `TerminateJobObject`.

Only `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO` proves complete-tree termination.
The Worker then performs the same ConPTY close and output-drain sequence as
natural exit. Failure to observe an empty Job Object within
`termination_confirmation_ms` produces `TerminationUncertain`.

Closing ConPTY is a terminal I/O teardown step, not the proof of process-tree
termination. The Job Object remains authoritative even though closing ConPTY
may also terminate attached console clients.

## Restart and recovery

A restarted Supervisor authenticates the live Worker over its existing
per-job Named Pipe. Attachment open/read, lease acquisition and renewal,
input, resize, cancellation, and status continue against that Worker. Existing
attachment capability and lease state remain in memory and preserve their
original expiry/fence semantics.

If the Worker is lost, the Job Object closes and kills the contained command
tree. The ConPTY and its pipe handles also close with the Worker. Recovery uses
the already implemented PID plus creation-time identity disappearance check,
synchronizes retained PTY segments, and records conservative
`TerminationUncertain` evidence. It never recreates ConPTY, restarts the
command, restores a lease, or claims a complete exit code.

Terminal output remains readable from durable segments after Worker loss.
Input and resize reject because no authenticated live Worker owns the terminal.

## Capability and protocol behavior

No public RPC method or protocol version changes. The existing PTY start,
attachment, input, resize, output cursor, and job snapshot schemas are shared.
After native Windows acceptance passes, Windows reports:

```json
{
  "process_group": false,
  "job_object": true,
  "pty": true,
  "reattach": true,
  "durable_restart_recovery": true
}
```

Lifecycle evidence adds `windows_conpty_ctrl_c` as a platform-specific graceful
termination mechanism. Ownership remains `windows_job_object`; ConPTY provides
terminal semantics, not an alternative process-tree ownership claim.

## Failure behavior

- Invalid dimensions, TERM, cwd, argv, environment, or executable fail before
  user code executes.
- Pipe, ConPTY, attribute-list, Job Object, process creation, identity
  persistence, or resume failure closes all acquired resources and fails
  closed.
- Input write and resize failures surface as PTY I/O failures and trigger
  complete-tree termination.
- Output read failure triggers complete-tree termination and preserves already
  synchronized output evidence.
- ConPTY close and final output drain are bounded and never block the
  Supervisor protocol loop.
- Root exit does not complete a job while Job Object descendants remain.
- Errors identify the failed stage without exposing raw handles, tokens, SIDs,
  security descriptors, or environment contents.

## Delivery slices

### Phase 4B4C1: ConPTY platform substrate

- Generalize the Windows process attribute list for handle, Job, and ConPTY
  combinations.
- Add synchronous ConPTY channels, `CreatePseudoConsole`, resize, and explicit
  close ownership.
- Add suspended ConPTY process creation inside the existing Job Object.
- Keep the advertised Windows PTY capability false.

### Phase 4B4C2: Worker execution and terminal I/O

- Add the Windows PTY execution path with segmented output capture.
- Connect fenced input, resize, timeout, cancellation, descendant completion,
  ConPTY close, and bounded final drain.
- Add platform-correct lifecycle evidence.

### Phase 4B4C3: recovery and acceptance

- Verify Supervisor restart, detach/reattach, live input after restart, timeout,
  cancellation, and Worker-loss retained output.
- Add crash-point coverage before resume and after `Running`.
- Open the Windows `pty` capability only after native acceptance passes.
- Preserve clean Linux and Windows CI gates.

## Implementation result

Phase 4B4C1 generalizes Windows process attributes for restricted inherited
handles, Job Objects, and `HPCON`; constructs synchronous ConPTY channels; and
creates the terminal root suspended inside the existing Job Object. The
process start clears ambient standard handles, persists PID identity before
resume, and keeps the Job Object as the only process-tree authority.

Phase 4B4C2 routes Windows PTY starts through that substrate. A dedicated OS
thread continuously drains the synchronous ConPTY output pipe into a bounded
Tokio channel so `ClosePseudoConsole` cannot block the async Worker. The
Worker serializes exact-byte input and resize, supports fenced attachment
ownership, records best-effort `windows_conpty_ctrl_c`, and escalates through
`windows_job_object_terminate` when required.

Phase 4B4C3 activates `pty: true` after native Windows tests proved real TTY
and dimensions, raw input, UTF-8/projected VT retention, resize, competing
attachments, detach/reattach, descendant-aware completion, timeout and
cancellation, Supervisor restart continuity, deterministic Worker-loss output
retention, and the suspended pre-resume gate. The cross-platform verification
and Windows-native acceptance gates passed in [GitHub Actions run 65](https://github.com/ronaldo123321/koda/actions/runs/33290693542).

## Acceptance criteria

Phase 4B4C is complete when tests prove:

1. A Windows child observes a real console and the configured initial size.
2. Raw input reaches the terminal once and output retains UTF-8 plus VT bytes.
3. Resize changes the console dimensions through the fenced writer lease.
4. Multiple readers coexist while only one current lease may write or resize.
5. Detach leaves the terminal alive and a new attachment reads continued
   output.
6. Natural completion waits for all Job Object descendants and final ConPTY
   output drain.
7. Cancellation and timeout terminate the complete Job Object tree and retain
   terminal output.
8. Supervisor restart reconnects to the same Worker and terminal; input,
   resize, output, and termination continue.
9. Worker loss leaves no verified root command alive, never restarts the
   terminal command, and retains readable output evidence.
10. A suspended pre-resume crash never executes user code.
11. Windows advertises `pty: true` only in the verified implementation.
12. Existing Unix PTY, Pipe, Background, app-server, and TUI behavior remains
    unchanged.

## Verified platform references

- [Microsoft CreatePseudoConsole](https://learn.microsoft.com/en-us/windows/console/createpseudoconsole)
- [Microsoft creating a pseudoconsole session](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)
- [Microsoft ResizePseudoConsole](https://learn.microsoft.com/en-us/windows/console/resizepseudoconsole)
- [Microsoft ClosePseudoConsole](https://learn.microsoft.com/en-us/windows/console/closepseudoconsole)
- [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Microsoft UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)

## Deferred work

Release packaging, signed Windows binaries, automatic Windows native artifact
selection, and removal of the TypeScript compatibility backend remain later
release work. Filesystem/network sandbox policy, restricted tokens, resource
quotas, secret injection, and sandbox strength reporting remain Phase 4C.
