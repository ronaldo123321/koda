# Koda Phase 4B3A PTY and Background Runtime Design

- Status: Accepted — implementation next
- Date: 2026-08-29
- Depends on: Phase 4B2 crash-durable per-job Workers

## Scope

Phase 4B3A adds the runtime needed for interactive PTY jobs and managed
background jobs without yet adding a TUI process pane or app-server product
workflow. It preserves structured argv execution and the Phase 4B2 ownership
model. Existing `exec_command` calls remain non-interactive pipe foreground
jobs.

The slice includes:

- POSIX PTY ownership on macOS and Linux;
- explicit foreground/background lifecycle metadata;
- attach/detach and reconnectable output cursors;
- multiple readers with one fenced input owner;
- bounded input, resize, timeout, cancellation, and durable tail evidence;
- strict Node runtime APIs and deterministic failure tests.

PTY product UX is Phase 4B3B. Windows ConPTY/Job Objects remain Phase 4B4.

## Ownership architecture

Each `koda-exec worker` owns the command process group, PTY master, PTY reader
and writer, segmented output log, terminal size, attachment registry, input
lease, timeout, and termination sequence. The client-facing Supervisor owns
only the public protocol, durable discovery, authentication, and request
routing.

This keeps the Phase 4B2 failure boundary intact: a Supervisor crash does not
close the PTY or stop its command. A replacement Supervisor authenticates the
same Worker with the existing same-UID, HMAC, and process-start-identity checks.
The Worker remains the only live PTY state writer.

Alternatives were rejected:

- Supervisor-owned PTYs would lose input and resize ownership on Supervisor
  failure.
- Per-attachment broker processes would require broker election, distributed
  lease coordination, and output fan-out beyond this slice.

## Start contract

`job/start` gains backward-compatible optional fields:

- `io_mode`: `pipe` by default or `pty`;
- `lifecycle`: `foreground` by default or `background`;
- `pty`: required only for PTY mode, containing initial `rows`, `cols`, bounded
  `TERM`, and retained-output budget.

Pipe foreground validation remains unchanged. Background jobs require an
explicit timeout and may run for at most 24 hours. PTY dimensions are bounded
to 1–500 rows and columns. The approved command remains an argv vector; shell
syntax, pipelines, redirection, command substitution, and implicit `&` remain
unsupported.

`background` changes client waiting semantics, not process ownership. Every job
already belongs to an independent Worker. Detaching the last client never
terminates either foreground or background work; only normal exit, explicit
termination, timeout, or verified orphan cleanup does.

## PTY process creation

The Worker creates a PTY master/slave pair, configures the initial window size,
and starts the existing same-PID command bootstrap as a new session and process
group with the slave as its controlling terminal and stdin/stdout/stderr. The
bootstrap still waits on the one-byte execution gate. The Worker persists the
command PID and start identity before releasing the gate to exec the approved
program.

The Worker retains only the master. One reader task drains all PTY output into
the bounded segmented log. One serialized writer task owns master writes and
resize ioctls. EOF/EIO handling is platform-normalized, but unexpected PTY I/O
failure terminates the process group and records failure evidence.

## Segmented PTY output

PTY output is one raw byte stream because a terminal does not preserve separate
stdout and stderr channels. Each PTY job has:

```text
pty-output/
  <absolute-start-cursor>.bin
```

Segments are private regular files capped at 64 KiB. The default retained tail
is 4 MiB and the maximum is 64 MiB. The Worker synchronizes appended bytes
before removing the oldest whole segments that exceed the budget. Segment names
and lengths derive the absolute `earliest_cursor` and `latest_cursor`, so tail
rotation does not reset client cursors or depend on volatile counters.

Reads are capped at 64 KiB. `attach/read` returns either:

- `status: ok` with cursor bounds, next cursor, completion, and canonical Base64
  bytes; or
- `status: cursor_expired` with the new earliest cursor and no data.

A cursor beyond the latest position is invalid. Terminal and uncertain jobs
retain readable PTY evidence after the Worker exits.

## Attachments and input ownership

Any number of clients may attach as readers. `attach/open` returns a random
attachment ID and a capability token bound to the job and attachment with HMAC
under the private job token. The token is never logged or persisted. The
Supervisor can verify it after Worker exit, allowing terminal output reads
without a live Worker.

At most one attachment owns input. The lease defaults to 15 seconds and clients
normally renew every 5 seconds. Every grant increments a monotonic fencing
number. `input/write` and `terminal/resize` require the attachment capability,
lease token, and current fence. Expired leases, mismatched tokens, and stale
fences fail before touching the PTY.

The input queue is serialized, caps each request at 16 KiB, and admits at most
64 KiB pending data. Excess input returns explicit backpressure; it is never
silently dropped or retried. Resize and input share lease ownership so two
clients cannot fight over terminal geometry.

Detach releases the lease but never terminates the process. Connection loss has
no implicit process effect; its lease expires normally. After Supervisor
restart a client may continue using a still-valid capability and lease against
the original Worker or open a new read attachment. A new writer cannot acquire
ownership until the old lease expires or detaches.

## Public and internal protocol

The public protocol remains version 1 and adds:

- `attach/open`
- `attach/read`
- `attach/renew`
- `attach/acquire-input`
- `attach/detach`
- `input/write`
- `terminal/resize`

The internal Worker protocol mirrors live operations. Job and attachment IDs,
capability tokens, lease tokens, fences, cursor bounds, dimensions, and byte
counts are strictly parsed and bounded. Normal attachment flow errors use
stable codes:

- `ATTACHMENT_NOT_FOUND`
- `INPUT_LEASE_HELD`
- `INPUT_LEASE_EXPIRED`
- `STALE_INPUT_FENCE`
- `PTY_INPUT_BACKPRESSURE`
- `PTY_NOT_SUPPORTED_FOR_JOB`
- `JOB_TERMINAL`
- `CURSOR_INVALID`

Cursor expiry is a successful discriminated read result rather than an RPC
failure.

## Node runtime API

`@koda/runtime-node` exposes strict primitives:

- `startPty`
- `openAttachment`
- `readAttachment`
- `acquireInput`
- `renewInput`
- `writeInput`
- `resizeTerminal`
- `detach`

`NativePtyAttachment` stores its attachment capability, current cursor, lease
token, and fence. It supports explicit renewal and close. Phase 4B3A does not
silently retry input or conceal lease loss, because an automatic retry could
duplicate keystrokes. Phase 4B3B will build TUI behavior on these primitives.

## Recovery and terminal behavior

Supervisor restart authenticates and routes to the live Worker exactly as in
Phase 4B2. Attachment and lease state stays in that Worker. If the Worker dies
after the command boundary, the job becomes `termination_uncertain`; the
replacement Supervisor performs only start-identity-verified process-group
cleanup. It never restarts the PTY command.

After a verified terminal transition, input and resize reject with
`JOB_TERMINAL`. Output reads continue from validated segments. Retention treats
PTY jobs like pipe jobs: only verified `exited` and `start_failed` jobs are
eligible; active, uncertain, corrupt, and quarantined records are never
automatically deleted.

## Delivery slices

### Phase 4B3A1: protocol and storage

- Extend start/job snapshots and validation without changing pipe defaults.
- Implement segmented PTY output, cursor derivation, rotation, and terminal
  reads.
- Implement attachment capability and input lease/fencing state machines.

### Phase 4B3A2: Worker PTY execution

- Add PTY creation, controlling-terminal bootstrap, master read/write, resize,
  timeout, cancellation, output failure, and terminal publication.
- Route authenticated live attachment methods through the Supervisor.

### Phase 4B3A3: Node API and acceptance

- Add strict Node schemas and attachment primitives.
- Add real PTY and failure-injection tests while preserving pipe behavior.

## Acceptance

Phase 4B3A is complete when deterministic tests prove:

1. A child observes a real TTY and receives the configured initial dimensions.
2. Input reaches the PTY once and resize produces the expected terminal size or
   `SIGWINCH` observation.
3. Multiple readers coexist while only one valid fenced lease may write or
   resize.
4. Expired leases, stale fences, oversized input, and queue saturation fail
   without ambiguous writes.
5. Segment rotation keeps disk use bounded and reports cursor expiry with a
   usable new earliest cursor.
6. Detach does not terminate work; reattach observes continued output.
7. Supervisor restart preserves PTY execution, output, timeout, cancellation,
   and the original live lease until expiry.
8. Terminal and uncertain jobs retain bounded readable output evidence.
9. Worker loss never restarts a post-boundary PTY command.
10. Existing pipe jobs, `WorkspaceCommandRunner`, lifecycle audit, Phase 4B2
    recovery, format, typecheck, Clippy, Rust tests, and the full TypeScript suite
    remain green.

## Deferred work

TUI process panes, user key routing, visual attachment state, and app-server
interactive workflow are Phase 4B3B. Windows ConPTY and Job Objects are Phase
4B4. OS sandboxing, network policy, and secret injection remain Phase 4C.
