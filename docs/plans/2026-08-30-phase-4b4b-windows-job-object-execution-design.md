# Koda Phase 4B4B Windows Job Object Execution Design

- Status: In progress — Phase 4B4B2 complete; Phase 4B4B3 next
- Date: 2026-08-30
- Depends on: Phase 4B4A Windows platform foundations complete
- Target: Windows 10 version 1809 and later, with unchanged macOS/Linux behavior

## Scope

Phase 4B4B enables the existing native Supervisor and per-job Worker runtime on
Windows for Pipe and Background command execution. Windows commands gain
Job Object-backed process-tree ownership, bounded output capture, cancellation,
timeouts, Supervisor restart reattachment, and conservative Worker-loss
recovery.

This phase does not implement a Windows terminal. Requests with `io_mode: pty`
continue to fail with `PLATFORM_CAPABILITY_UNAVAILABLE`. ConPTY, interactive
input, resize, terminal attachment, and terminal recovery remain Phase 4B4C.

The existing executor protocol, durable job schema, idempotency records, output
limits, Worker authentication, lifecycle values, and Node client contracts stay
shared. Koda does not gain a second Windows Supervisor or a second job state
machine.

## Goals

- Run validated argv vectors on Windows without a shell.
- Place the root command and every non-breakaway descendant in one per-job Job
  Object before user code can execute.
- Preserve the existing persist-before-execute command identity boundary.
- Capture bounded stdout and stderr for foreground and background Pipe jobs.
- Treat the complete Job Object process set, not only the root process, as the
  unit of completion and termination.
- Let a restarted Supervisor reconnect to a live Worker and continue observing
  or terminating the same task.
- Ensure Worker loss closes the Job Object and prevents an unmanaged command
  tree from surviving.
- Expose only capabilities proven by Windows-native acceptance tests.

## Non-goals

- ConPTY or any Windows PTY emulation.
- Portable POSIX signal semantics on Windows.
- Persisting or reopening a raw Job Object handle after Worker loss.
- Resource quotas, CPU affinity, memory limits, sandboxing, AppContainer, or
  restricted tokens; those belong to the later isolation phase.
- Shell lookup, command-string parsing, batch-file execution, or
  `cmd.exe /c` fallback.
- Removing the TypeScript compatibility executor.

## Approaches considered

### Create, then assign a running process

Using Rust `Command::spawn()` followed by `AssignProcessToJobObject` leaves a
window in which user code can create descendants before the root is owned. It
also cannot express the required restricted inheritance list through stable
Rust process APIs. This approach is rejected.

### Create suspended, then assign

Calling `CreateProcessW` with `CREATE_SUSPENDED`, assigning the process with
`AssignProcessToJobObject`, and then resuming the main thread closes the
user-code race. It remains more sensitive to ambient/nested jobs and spreads
the ownership transaction across separate operations.

### Assign at creation with `PROC_THREAD_ATTRIBUTE_JOB_LIST`

The selected approach calls `CreateProcessW` with `CREATE_SUSPENDED`,
`EXTENDED_STARTUPINFO_PRESENT`, and one `STARTUPINFOEX` attribute list containing
both `PROC_THREAD_ATTRIBUTE_JOB_LIST` and
`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`. Windows assigns the new process to the Job
Object as part of creation, while the suspended thread preserves the durable
start gate. The API is supported by the Phase 4B4A Windows baseline.

## Ownership architecture

Each durable Koda task still owns one Worker. The Worker remains outside the
command Job Object so it can survive a Supervisor restart and retain the Job
handle. It creates one anonymous Job Object for the command tree and is its
sole long-lived owner.

The Job Object uses `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. It does not set
`JOB_OBJECT_LIMIT_BREAKAWAY_OK` or
`JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`. Descendants therefore join the same Job
Object by default. The anonymous object avoids global name collision and
pre-creation attacks.

The Supervisor never owns a command Job handle. It communicates with the Worker
over the existing authenticated per-job endpoint. A Supervisor crash leaves the
Worker, Job handle, command tree, and output capture alive. A Worker crash closes
the last Job handle and causes Windows to terminate the associated tree.

## Shared runtime and platform boundary

`Supervisor`, `WorkerRuntime`, `JobStore`, Worker HMAC authentication, output
stores, and protocol dispatch compile on Unix and Windows. Platform-specific
process mechanics move behind `platform::process` and `platform::bootstrap`.

The Windows backend provides:

- `WorkerProcessLauncher`, which starts a detached Worker with only the control
  token read handle inherited;
- `PipeCommandBuilder`, which validates and constructs a direct Windows process
  request;
- `ManagedProcessTree`, which owns the Job, root process, root thread,
  completion port, and parent pipe handles;
- `ProcessTreeEvents`, which converts blocking process/Job notifications into
  bounded Tokio events; and
- `TerminationController`, which performs best-effort console interruption and
  authoritative Job termination.

Unix continues to use Tokio commands, POSIX process groups, bootstrap pipes,
and the existing PTY backend. Platform abstractions must preserve Unix behavior
rather than forcing Windows semantics into the Unix implementation.

## Worker bootstrap

The Supervisor opens the durable control token and creates a Windows anonymous
pipe. Only the child read handle is inheritable. The Worker process is created
with `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` containing that handle and receives its
numeric value through `--token-handle`.

Unix retains `--token-fd`. Argument parsing maps both forms to the platform
`BootstrapHandle` type instead of storing Windows handles in `i32`. The token
bytes never appear in argv, environment variables, logs, or durable state.

After authenticating the token, the Worker acquires the exclusive durable lock,
binds its private endpoint, persists its PID and creation-time identity, and
starts the existing Worker protocol server.

## Windows command construction

The command builder consumes the validated `StartParams` without invoking a
shell.

`argv[0]` is resolved to an explicit executable using the canonical cwd and the
request environment's case-insensitive `PATH`. A path-bearing program name is
resolved relative to the canonical cwd. Bare names may receive the executable
extension used by `CreateProcessW`; batch files and shell-only commands are not
silently accepted.

Every argument is encoded using the Windows C runtime quoting rules, including
empty strings, whitespace, embedded quotes, trailing backslashes, and Unicode.
The executable path is also supplied separately as `lpApplicationName`, so a
space-containing path cannot change which executable is launched.

The environment is encoded as a case-insensitively sorted UTF-16 block with one
null terminator per entry and a final extra null. Duplicate keys differing only
by case are rejected before job creation. The canonical cwd is passed as an
explicit UTF-16 directory.

stdin is a read handle for `NUL`. stdout and stderr are anonymous pipe write
handles. Only those three child-side handles appear in the inheritance list;
parent-side output handles, Job handles, process handles, completion ports, and
Worker control handles are non-inheritable.

## Atomic start transaction

The Worker performs command start in this order:

1. Persist `CommandStarting`.
2. Create and configure the anonymous Job Object and completion port.
3. Create stdin/stdout/stderr handles and the restricted attribute list.
4. Call `CreateProcessW` with `CREATE_SUSPENDED`,
   `CREATE_NEW_PROCESS_GROUP`, `CREATE_UNICODE_ENVIRONMENT`, and
   `EXTENDED_STARTUPINFO_PRESENT`.
5. Read the root PID and creation-time identity from the returned process
   handle.
6. Persist a new `CommandStarting` revision containing that PID and identity.
7. Resume the root thread.
8. Persist `Running` and begin event/output observation.

The durable transition validator permits
`CommandStarting -> CommandStarting` only for this identity publication. A
failure before resume closes the Job handle and publishes `StartFailed`. A
failure after resume terminates the Job Object and publishes a terminal failure;
it does not return while leaving an unowned process.

## Output and natural completion

Parent stdout and stderr handles are converted into asynchronous readers backed
by Tokio's blocking file pool. The existing byte counters, output limits,
retained-file format, sync behavior, and protocol results remain unchanged.

The Worker observes both the root process and the Job Object. Root exit captures
the root exit code but does not make the task terminal. Descendants may continue
running and holding output handles. Natural completion requires:

1. the Job Object reports `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO`;
2. stdout and stderr reach EOF and synchronize their retained files; and
3. the root exit code is known or a durable `COMMAND_WAIT_FAILED` failure is
   recorded.

The completion port wait runs in a dedicated blocking task and forwards only
bounded structured events. A Worker shutdown posts an internal completion
packet so no blocking wait is leaked.

Foreground and background lifecycle values do not alter ownership. They only
alter whether the calling client waits for the terminal snapshot.

## Cancellation and timeout

Windows cannot promise POSIX signal behavior. The Worker creates a new process
group and may attempt `CTRL_BREAK_EVENT` when the Worker and target share a
console. This is best-effort and is recorded as
`windows_console_ctrl_break`; failure is not treated as proof of termination.

After `termination_grace_ms`, or immediately when graceful delivery is
unavailable, the Worker calls `TerminateJobObject`. This non-cooperative force
operation is recorded as `windows_job_object_terminate`. The Worker then waits
up to `termination_confirmation_ms` for
`JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO` and drains output.

Only confirmed process-tree disappearance produces termination outcome
`terminated`. Failure to terminate or observe an empty Job Object produces
`TerminationUncertain`. Timeout and cancellation continue to differ only in
their durable `reason` and `timed_out` value.

## Restart and crash recovery

The existing Worker lock and HMAC handshake remain the primary recovery proof.
A restarted Supervisor connects to the per-job Windows Named Pipe and validates:

- same-user peer SID;
- durable Worker PID and creation-time identity;
- job ID and protocol version; and
- nonce-bound HMAC proof from the durable control token.

If the Worker is alive, status, output synchronization, cancellation, and
background discovery continue through that Worker. No Job handle must cross the
Supervisor boundary.

If the Worker is gone, acquiring its lock proves exclusive recovery authority.
`KILL_ON_JOB_CLOSE` should already be terminating the command tree. The
Supervisor verifies the persisted command PID and creation-time identity,
performs bounded disappearance checks, synchronizes retained output lengths,
and records `TerminationUncertain` with
`WORKER_LOST_AFTER_COMMAND_BOUNDARY`. It never invents an exit code or claims
complete descendant enumeration after losing the Job handle.

Crash-point expectations are:

- before command creation: a replacement Worker may retry;
- after suspended creation but before resume: the command never executes and
  Job close removes it;
- after resume: identity is already durable and recovery is conservative;
- after `Running`: Supervisor restart reconnects to the live Worker;
- during termination: the live Worker completes or Worker loss triggers
  fail-closed cleanup.

## Endpoint and state security

Worker endpoints use the Phase 4B4A Named Pipe backend. Their names are derived
from the current user SID, canonical state root, and job identity hashes. Raw
paths, user names, SIDs, tokens, and handles are not embedded in public names or
errors.

Durable directories, manifests, state revisions, token files, output files, and
locks retain the explicit current-user plus LocalSystem protected DACL. Reparse
points and unrelated ACL principals remain rejected.

## Capabilities and protocol behavior

After Windows-native acceptance passes, Windows reports:

```json
{
  "process_group": false,
  "job_object": true,
  "pty": false,
  "reattach": true,
  "durable_restart_recovery": true
}
```

Pipe foreground and background `job/start` requests use the shared Supervisor.
PTY requests fail with `PLATFORM_CAPABILITY_UNAVAILABLE`; the Node client does
not silently fall back to the TypeScript compatibility executor.

Protocol version and public job schemas remain unchanged unless implementation
uncovers a wire-visible incompatibility. Internal platform errors map to the
existing stable protocol codes.

## Failure behavior

- Invalid argv, executable resolution, environment, cwd, or PTY use fails before
  user code executes.
- Job creation, limit configuration, completion-port association, pipe setup,
  process creation, identity publication, or resume failure closes all handles
  and fails closed.
- Output capture failure requests complete-tree termination before publishing a
  failure.
- Root-process wait failure does not imply that descendants exited.
- Completion-port failure makes terminal ownership uncertain and triggers Job
  termination.
- Error messages expose the failed stage and OS error without exposing tokens,
  raw security descriptors, or inherited handle values.

## Delivery slices

### Phase 4B4B1: shared runtime and Worker startup

- Compile the shared Supervisor, Worker, durable store, internal protocol, and
  Pipe output runtime on Windows.
- Generalize bootstrap handle parsing and per-job endpoint construction.
- Implement restricted Windows Worker startup and authenticated reconnect.
- Keep Windows command execution and all PTY methods fail closed.

### Phase 4B4B2: managed Pipe and Background execution

- Implement Job Object, completion port, direct process builder, argv quoting,
  environment block, executable resolution, and output pipe ownership.
- Implement suspended identity publication, resume, natural tree completion,
  timeout, cancellation, and forced tree termination.
- Preserve Unix process-group and PTY behavior.

### Phase 4B4B3: recovery and acceptance

- Implement Supervisor restart reattachment and Worker-loss reconciliation on
  Windows.
- Open only verified Windows capabilities.
- Add Rust and Node tests for real Windows command trees and crash points.
- Keep clean Linux and Windows CI gates green.

## Implementation progress

Phase 4B4B1 was implemented and verified on 2026-08-30:

- `Supervisor`, `WorkerRuntime`, durable storage, internal Worker protocol,
  attachment state, and PTY output storage now compile through the shared
  Windows runtime instead of a separate control-plane stub.
- Windows Worker endpoints use SID-, canonical job-directory-, and job-ID-bound
  Named Pipe names. The shared stream wrapper supports authenticated server and
  client peers without duplicating framing or HMAC handshake logic.
- Worker bootstrap parses a pointer-width `--token-handle`, uses
  `CreateProcessW` plus `STARTUPINFOEX`, and restricts inheritance to the
  anonymous token pipe and standard `NUL` handle. Token bytes never enter argv
  or the environment.
- Durable atomic replacement, output flushing, exclusive lock sharing, and
  terminal-record retention now honor Windows filesystem semantics while
  preserving the Unix implementation.
- Windows `job/start` remains fail closed with
  `PLATFORM_CAPABILITY_UNAVAILABLE`; shared durable reads such as `job/list`
  are enabled. No execution or recovery capability bit is opened early.
- Local macOS verification passed 22 native tests, strict workspace Clippy,
  formatting, type checking, and the complete 504-test suite. GitHub Actions
  run [33285427198](https://github.com/ronaldo123321/koda/actions/runs/33285427198)
  passed both Linux `verify` and Windows `windows-native`, including 30 Windows
  native tests and all 5 Windows Node control-plane tests.

Phase 4B4B2 was implemented and verified on 2026-08-30:

- Each Pipe command is created suspended and atomically assigned to an
  anonymous `KILL_ON_JOB_CLOSE` Job Object through one combined
  `PROC_THREAD_ATTRIBUTE_JOB_LIST` and restricted handle list. The Worker stays
  outside the Job and persists PID plus creation-time identity before resume.
- Direct `CreateProcessW` construction now covers explicit executable
  resolution, Windows argv quoting, case-insensitive UTF-16 environment blocks,
  canonical cwd, `NUL` stdin, and isolated stdout/stderr pipe inheritance
  without a shell fallback.
- A Job-associated completion port owns natural descendant completion. Root
  exit alone is insufficient; terminal publication waits for
  `ACTIVE_PROCESS_ZERO` and bounded stdout/stderr EOF, while an internal packet
  releases exceptional blocking waits.
- Foreground and background Pipe jobs share bounded retained output,
  idempotency, durable discovery, timeout, cancellation, best-effort console
  interruption, and authoritative `TerminateJobObject` escalation. Windows PTY
  requests remain explicitly unavailable.
- The Node client exposes Pipe lifecycle/display-name fields and validates the
  Windows termination evidence. Native Windows tests prove late descendant
  output, whole-tree cancellation, timeout, stable PTY rejection, durable list
  routing, concurrent handshakes, and endpoint exclusivity.
- Local macOS verification passed strict native and Windows cross-target
  Clippy, formatting, type checking, and the complete 504-test suite. GitHub
  Actions run
  [33286571429](https://github.com/ronaldo123321/koda/actions/runs/33286571429)
  passed both Linux `verify` and Windows `windows-native`, including 34 Windows
  native tests and all 8 Windows Node acceptance tests.

Phase 4B4B3 is next. It owns Supervisor restart reattachment acceptance,
Worker-loss disappearance checks, crash-point coverage, platform-correct
lifecycle evidence, and Windows capability activation. Phase 4B4C still owns
ConPTY and all interactive Windows terminal behavior.

## Acceptance criteria

Phase 4B4B is complete when tests prove:

1. Windows argv quoting and environment blocks round-trip empty values,
   whitespace, quotes, trailing backslashes, Unicode, and case-insensitive
   environment keys.
2. The Worker and command receive only explicitly listed inheritable handles.
3. The root command is in its Job Object before it can execute, and ordinary
   descendants cannot escape.
4. Root exit does not complete the task while descendants remain active.
5. Natural completion waits for `ACTIVE_PROCESS_ZERO` and drained output.
6. Cancellation, timeout, and output failure terminate the complete Job Object
   and report only confirmed outcomes.
7. Foreground and background Pipe jobs preserve output bounds, idempotency, job
   discovery, and terminal snapshots.
8. Supervisor restart reconnects to the same live Worker and can read output or
   terminate the task.
9. Worker loss leaves no verified root command alive and records a conservative
   uncertain terminal state.
10. Windows PTY requests remain explicitly unavailable.
11. Existing macOS/Linux command, recovery, background, PTY, and app-server
    behavior remains unchanged.
12. Clean Linux and Windows CI gates pass.

## Verified platform references

- [Microsoft UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Microsoft nested jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs)
- [Microsoft AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)
- [Microsoft SetInformationJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-setinformationjobobject)
- [Microsoft TerminateJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject)
- [Microsoft Job Object completion-port association](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_associate_completion_port)
- [Microsoft GenerateConsoleCtrlEvent](https://learn.microsoft.com/en-us/windows/console/generateconsolectrlevent)
- [Microsoft process creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)

## Deferred work

Phase 4B4C adds ConPTY creation, terminal I/O, input ownership, resize,
attachment, and interactive recovery on Windows. Resource quotas, sandboxing,
restricted tokens, filesystem/network capability enforcement, and stronger
isolation remain Phase 4C. Release packaging and removal of the TypeScript
compatibility backend remain later work.
