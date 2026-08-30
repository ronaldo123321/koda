# Koda Phase 4B4A Windows Platform Foundations Design

- Status: Complete — implemented and verified
- Date: 2026-08-30
- Depends on: Phase 4B3 native PTY and interactive-process workflow complete
- Target: Windows 10 version 1809 and later, plus unchanged macOS/Linux support

## Scope

Phase 4B4A removes the POSIX-only shape of `koda-exec` and establishes the
authenticated Windows control plane needed by later process ownership and
terminal work. It adds platform boundaries, Windows Named Pipe transport,
same-user identity checks, Windows process-start identity, private state
security, constrained bootstrap handle inheritance, and Windows CI.

This slice does not execute user commands on Windows. Until a Windows Job Object
owns the complete process tree, `job/start` fails closed with
`PLATFORM_CAPABILITY_UNAVAILABLE`. Phase 4B4B adds Job Object-backed pipe and
background execution. Phase 4B4C adds ConPTY and interactive terminal support.

The existing executor wire protocol, Supervisor state machine, Worker
authentication, durable job schema, bounded output stores, attachment leases,
app-server sessions, and TUI remain shared. Koda does not gain a second Windows
Supervisor implementation.

## Platform architecture

The native executor gains an internal `platform` boundary:

```text
platform/
  mod.rs
  transport.rs
  bootstrap.rs
  identity.rs
  state_security.rs
  process.rs
  unix/...
  windows/...
```

The initial implementation may use cfg-selected concrete types rather than
object-safe async traits. The contract matters more than dynamic dispatch:

- `transport` owns local endpoint validation, listening, connecting, accepting,
  and peer verification;
- `bootstrap` owns one-way secret and execution-gate channels plus the exact
  inherited handle set;
- `identity` returns a stable PID start identity and compares it during
  reconciliation;
- `state_security` creates and validates private directories/files and provides
  an exclusive non-blocking store lock;
- `process` reports executable platform capabilities and later hosts Job Object
  ownership and termination.

`main.rs`, `supervisor.rs`, and `worker.rs` stop naming `UnixStream`,
`UnixListener`, POSIX file descriptors, `flock`, UID helpers, or `libc` process
operations directly. PTY-specific execution moves behind a terminal backend;
the existing implementation remains the Unix backend and ConPTY remains
Phase 4B4C.

## Local endpoint and transport

The executor CLI accepts `--endpoint`. POSIX continues to accept `--socket` as
a compatibility alias during Phase 4, but newly launched clients use the
transport-neutral name.

On Unix, the endpoint remains a private filesystem Unix Socket. On Windows, the
endpoint is a local Named Pipe derived from a hash of the current logon SID and
canonical executor state directory:

```text
\\.\pipe\koda-exec-<sid-hash>-<state-hash>
```

The name contains no raw SID or workspace path. The first server instance uses
`FILE_FLAG_FIRST_PIPE_INSTANCE`, so an existing endpoint is never removed or
silently replaced. The accept loop creates the next pipe instance before
handing the connected instance to a task, avoiding a transient no-listener
window.

Named Pipes use byte mode because Koda already owns strict length-prefixed
framing. The frame size and malformed-request behavior remain identical on both
transports.

## Windows peer authentication

The pipe receives an explicit security descriptor. Its DACL grants the current
logon SID and LocalSystem only; it does not rely on the permissive default Named
Pipe descriptor. Remote clients are rejected.

After the first frame is available, the server verifies the live peer again:

1. obtain the Named Pipe client PID;
2. open the client process with query-only rights;
3. read its access token user SID;
4. compare it with the Supervisor's logon SID;
5. close every temporary token and process handle.

Any unavailable PID, token, SID, or failed comparison rejects the connection.
The executor never continues under the server's own security context after an
impersonation or token-query failure.

The same transport and verification contract applies to per-job Worker control
endpoints. A replacement Supervisor must additionally verify durable Worker
PID, process creation time, and the existing HMAC nonce challenge before
adopting a Worker.

## Process identity

Linux keeps `/proc/<pid>/stat` start ticks and macOS keeps `proc_pidinfo` start
seconds/microseconds. Windows opens the process with
`PROCESS_QUERY_LIMITED_INFORMATION` and reads its creation `FILETIME` through
`GetProcessTimes`. The stored identity is:

```text
windows-process-created:<unsigned 100ns value>
```

Failure to open the process because it no longer exists returns `None`. Access
denial or malformed timing information is an error, not proof that a PID is
gone. Reconciliation never treats PID equality alone as identity.

The durable schema already stores process identities as bounded strings, so
existing POSIX job records require no migration.

## State security and locking

POSIX retains real-directory checks, owner-only mode validation, same-UID
ownership, atomic publication, directory synchronization, and `flock`.

Windows state roots, job directories, manifests, tokens, and output stores are
created with an explicit DACL for the current logon SID and LocalSystem.
Validation rejects reparse points and objects whose effective DACL grants
write access to unrelated principals. The store lock uses an exclusive file
handle with no sharing instead of emulating `flock`.

ACL construction and validation live in one module so later secrets, plugin
state, and release storage can reuse the same proof. If Koda cannot construct or
verify the security descriptor, startup fails before serving a client.

## Bootstrap channels and handle inheritance

Worker authentication material and command start gates never appear in argv,
environment variables, logs, or durable state.

Unix preserves the inherited descriptor design. Windows creates anonymous
pipes with inheritable child ends and uses `STARTUPINFOEX` with
`PROC_THREAD_ATTRIBUTE_HANDLE_LIST` so only the listed bootstrap handles enter
the child. The parent ends are non-inheritable. Child arguments identify only
the numeric handle values; the values are capabilities, not secret bytes, and
are useful only inside the child process that inherited them.

4B4A proves the channel abstraction and Worker control bootstrap without
starting a user command. Phase 4B4B reuses the same channel for the persisted
command-identity gate and assigns the suspended child to a Job Object before it
can run.

## Protocol and capability behavior

Executor protocol v1 remains valid because request and successful result shapes
do not change. `system/hello` computes capabilities from the platform backend
instead of hard-coding them.

macOS and Linux continue to report their verified Phase 4B3 capabilities.
Windows Phase 4B4A reports:

```json
{
  "process_group": false,
  "job_object": false,
  "pty": false,
  "reattach": false,
  "durable_restart_recovery": false
}
```

`job/start` returns `PLATFORM_CAPABILITY_UNAVAILABLE`. The Node client preserves
that stable error and does not silently select the TypeScript compatibility
executor. Job Object tests in Phase 4B4B unlock pipe/background execution;
ConPTY tests in Phase 4B4C unlock PTY capabilities.

## Failure behavior

- An occupied endpoint is never deleted or replaced on Windows.
- Missing or unverifiable peer identity closes the connection before dispatch.
- A bootstrap handle leak, invalid inherited-handle list, or early channel close
  prevents Worker adoption or command execution.
- PID start-identity mismatch quarantines the durable job.
- ACL or reparse-point ambiguity fails closed.
- Named Pipe busy/not-found states use bounded retries only on clients; servers
  never loop without a deadline during startup reconciliation.
- Platform errors map to stable executor errors without exposing SID, token,
  handle, or state-root details.

## Delivery slices

### Phase 4B4A1: platform seams

- Add platform capability, endpoint, transport, bootstrap, identity,
  state-security, and process contracts.
- Move the current Unix implementations behind those contracts.
- Remove the top-level non-Unix compile error without weakening Unix behavior.
- Keep the complete macOS/Linux native and TypeScript suites green.

### Phase 4B4A2: Windows control plane

- Add cfg-scoped `windows-sys` dependencies.
- Implement Named Pipe listener/client and same-user verification.
- Implement Windows process identity, ACL security, exclusive locks, and
  restricted bootstrap handle inheritance.
- Start the Windows Supervisor, complete `system/hello`, and reject `job/start`
  with the stable capability error.

### Phase 4B4A3: Windows acceptance

- Add Windows-native transport, identity, ACL, handle inheritance, framing,
  concurrency, endpoint collision, and fail-closed tests.
- Add `windows-latest` CI alongside the existing Linux gate.
- Run a Node-to-real-Supervisor handshake test on Windows.
- Record exact guarantees and mark only Phase 4B4A complete.

## Acceptance criteria

Phase 4B4A is complete when tests prove:

1. Existing macOS/Linux command, recovery, PTY, and app-server behavior is
   unchanged.
2. Windows builds natively and serves concurrent protocol v1 connections over a
   private Named Pipe.
3. Endpoint collision, wrong-user identity, malformed frames, and partial
   disconnects fail closed.
4. Windows process identity detects PID reuse through creation time.
5. State ACLs and exclusive locking reject unsafe or ambiguous state.
6. Bootstrap tokens and gate bytes do not appear in argv, environment, logs, or
   durable records, and only explicitly listed handles are inherited.
7. Windows capabilities remain false and `job/start` remains unavailable until
   its ownership backend is verified.
8. Linux and Windows CI gates pass from clean checkouts.

## Completion record

Phase 4B4A was implemented and verified on 2026-08-30:

- Phase 4B4A1 moved transport, process identity, state security, bootstrap,
  process-tree, and terminal behavior behind platform boundaries while retaining
  the existing Unix implementations.
- Phase 4B4A2 added the Windows Named Pipe control plane, explicit current-user
  and LocalSystem ACLs, peer-process SID checks, creation-time process identity,
  exclusive state locking, restricted bootstrap handle lists, shared protocol
  framing, and stable fail-closed capability behavior.
- Phase 4B4A3 added Windows-native Rust and Node acceptance coverage for
  authenticated concurrent connections, endpoint exclusivity, ACL
  normalization, identity mismatch, invalid and partial frames, capability
  reporting, and unavailable command execution.
- Local macOS verification passed the Rust native suite, Windows cross-target
  compilation and Clippy, and the complete TypeScript/native test suite.
- [GitHub Actions run 33283759220](https://github.com/ronaldo123321/koda/actions/runs/33283759220)
  passed both the clean Linux `verify` gate and the Windows-native gate.

Only Phase 4B4A is complete. Job Object execution remains Phase 4B4B and ConPTY
interactive execution remains Phase 4B4C.

## Verified platform references

- [Tokio Named Pipe server](https://docs.rs/tokio/latest/tokio/net/windows/named_pipe/struct.ServerOptions.html)
- [Tokio Named Pipe client](https://docs.rs/tokio/latest/tokio/net/windows/named_pipe/struct.NamedPipeClient.html)
- [Microsoft Named Pipe security and access rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)
- [Microsoft Named Pipe client process identity](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeclientprocessid)
- [Microsoft process handle inheritance](https://learn.microsoft.com/en-us/windows/win32/procthread/inheritance)
- [Microsoft restricted handle-list inheritance](https://learn.microsoft.com/en-us/windows/desktop/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- [Microsoft process timing identity](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes)

## Deferred work

Windows Job Object creation, assignment, timeout/cancellation, process-tree
disappearance proof, and restart ownership are Phase 4B4B. ConPTY creation,
terminal I/O, resize, signal-equivalent behavior, and interactive acceptance are
Phase 4B4C. Removing the TypeScript compatibility backend requires completed
release packaging and remains after the native platform matrix is proven.
