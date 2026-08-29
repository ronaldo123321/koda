# Koda Phase 4B2 Worker Recovery Design

- Status: Accepted — implementation next
- Date: 2026-08-29
- Depends on: Phase 4B1 native foreground supervision

## Problem

Phase 4B1 keeps a job alive when one Node client disconnects because the
independent `koda-exec serve` process continues owning the command. It does not
survive failure of that Supervisor itself. The Supervisor currently owns the
child handle, timeout, termination channel, and stdout/stderr pipe readers. If
it crashes, a child can lose its output readers, its exit status becomes
unrecoverable, and a replacement Supervisor cannot safely reconstruct the
in-memory job registry.

Persisting the current in-memory snapshot alone would create a false recovery
claim. Phase 4B2 moves each command's operating-system ownership into a separate
per-job Worker and makes its task state crash durable.

## Decisions

1. `koda-exec serve` is the client-facing registry and discovery process.
2. One independent `koda-exec worker` is the sole lifecycle and state writer for
   each accepted job.
3. The Worker, not the client-facing Supervisor, creates and owns the command
   process group, output readers, timeout, and termination sequence.
4. A Supervisor restart reconnects to a verified live Worker; it never recreates
   a command from a `running` record.
5. A Worker failure after the command-start boundary is permanently uncertain.
   A replacement Supervisor may clean up a verified process group but cannot
   invent an exit result.
6. Identical start retries return one durable job. Conflicting reuse remains a
   permanent idempotency error across Supervisor restarts.
7. Terminal retention is automatic but conservative. Active, uncertain,
   corrupt, or quarantined jobs are never automatically deleted.

## Components and ownership

### Client-facing Supervisor

The Supervisor owns the public Unix Socket, external protocol handshake,
in-memory index reconstructed from disk, serialized start decisions, Worker
discovery, and terminal retention. It never writes normal Worker state after a
Worker has acquired the task lock. It may write a reconciliation-only uncertain
terminal state only after proving that no Worker owns the lock.

### Per-job Worker

The Worker is launched as:

```text
koda-exec worker --job-dir ABSOLUTE_PATH --token-fd FD
```

It receives the recovery token through an inherited read-only descriptor,
acquires an exclusive lifetime lock on the job, publishes its identity, binds a
private per-job Socket, starts the approved command without a shell, captures
bounded output, applies timeout or termination, and durably publishes the final
result before notifying any caller.

The Worker is detached from the Supervisor's process group and uses null
standard streams so a Supervisor exit does not close any Worker-owned command
pipe.

## Private task layout

Each job has a private mode-`0700` directory beneath
`KODA_HOME/executor/jobs`:

```text
jobs/<job-id>/
  manifest.json
  state.json
  control.token
  worker.lock
  worker.sock
  stdout.bin
  stderr.bin
```

Files are regular, non-symlink entries. Manifest and state files are bounded,
strictly parsed, versioned JSON. `control.token`, output, and lock files use
mode `0600`; the Worker Socket uses mode `0600`.

The immutable manifest contains the public job ID, external request ID,
canonical start parameters, their SHA-256 digest, token SHA-256, creation time,
and protocol format version. The raw 32-byte token exists only in
`control.token`; it is never returned by either protocol or written to logs.

## Durable state machine

The single-writer, monotonic state machine is:

```text
accepted
  -> worker_ready
  -> command_starting
  -> running
  -> terminating
  -> exited

command_starting -> start_failed | termination_uncertain
running           -> termination_uncertain
terminating       -> termination_uncertain
```

Each state contains a strictly increasing revision, previous-state digest,
timestamp, Worker identity when known, command identity when known, byte counts,
and applicable termination or failure evidence. Updates use a same-directory
temporary file, file sync, atomic rename, and best-effort directory sync.
Terminal states are immutable.

The Worker holds `worker.lock` for its entire lifetime. It writes
`worker_ready` before the command boundary, then writes `command_starting`
before calling the operating system. A crash in `accepted` with an unlocked job
is safe to resume by starting a Worker. A crash in `command_starting` without a
live Worker is uncertain even if no PID was recorded, because process creation
may already have occurred.

## Worker authentication and process identity

The manifest stores only the token digest, but restart authentication requires
the token itself to be recoverable. The replacement Supervisor reads the
private `control.token`, verifies its SHA-256 against the manifest, and uses it
for a nonce challenge. The Worker response binds the nonce, job ID, Worker PID,
Worker start identity, and protocol version with HMAC-SHA-256. Both peers also
verify the effective UID of the Unix Socket connection.

The Worker state stores PID plus a platform start identity rather than PID
alone. Linux uses `/proc/<pid>/stat` start time. macOS uses the process start
time returned by the native process-information API. PID reuse, missing start
identity, a failed token challenge, or an unexpected Socket type causes
quarantine rather than attachment.

The command identity similarly binds process-group leader PID and start
identity. If a Worker disappears after the command boundary, the Supervisor
signals a process group only when that identity still matches. Regardless of
cleanup success, the durable terminal result remains `termination_uncertain`
because the original Worker exit observation was lost.

## Internal Worker protocol

The per-job Socket uses the same bounded four-byte length framing as the public
protocol but has its own version and strict message types:

- `worker/hello`: nonce challenge and live identity proof.
- `worker/status`: returns the latest durable revision and live ownership.
- `worker/terminate`: requests cancellation or output-failure termination.
- `worker/output/sync`: flushes current output metadata before a range is read
  from the authoritative job files.

The public Supervisor remains responsible for external response validation and
continues serving `job/get`, `job/output/read`, and `job/terminate`. Phase 4B2
adds `job/list` with a bounded page of current jobs. Disk state is authoritative;
Worker responses prove liveness and may trigger a reload but cannot roll a
revision backward.

## Restart reconciliation

At startup the Supervisor scans bounded direct child job directories and
validates every entry without following symlinks:

- Immutable valid terminal state: load it.
- `accepted`, unlocked, and no Worker evidence: start one Worker.
- Nonterminal, lock held, identity matches, challenge succeeds: attach.
- `worker_ready`, unlocked, and no command-start evidence: restart the Worker.
- `command_starting`, `running`, or `terminating` with no verified Worker:
  verify and clean the recorded command group when possible, then publish
  `termination_uncertain` under the acquired task lock.
- Invalid structure, digest, revision, permissions, state transition, identity,
  or challenge: quarantine and expose no executable mutation method.

The Supervisor never repairs a corrupt manifest, guesses an exit code, repeats
an uncertain command, or signals a historical PID without a matching start
identity.

## Retention and garbage collection

The initial defaults retain completed jobs for seven days and at most 1,000
verified terminal jobs. Active, uncertain, and quarantined jobs are excluded.
GC requires an unlocked job, valid immutable manifest, valid terminal state,
and matching job identity. It atomically renames the directory beneath a
private `trash` directory and synchronizes the jobs parent before recursive
deletion. A crash leaves a recoverable trash entry that is safe to finish
deleting on the next startup.

`job/list` returns at most 100 records per call, ordered newest first, with an
opaque cursor. It never returns arguments, environment values, token material,
or absolute host paths.

## Fault injection and acceptance

Tests use explicit test-only fault points at manifest publication, Worker
launch, `worker_ready`, `command_starting`, command start, `running`,
`terminating`, and terminal publication. Phase 4B2 is complete when tests prove:

1. Killing only the Supervisor does not kill a running Worker or command.
2. A new Supervisor authenticates the original Worker and observes the same job
   and continuing output.
3. Start retries across a lost response never create a second Worker or command.
4. Accepted and pre-boundary jobs resume safely; post-boundary jobs never
   restart automatically.
5. Killing a Worker after the boundary produces durable uncertainty and bounded
   verified process-group cleanup.
6. Terminal result, output counts, timeout, and cancellation remain correct
   across a Supervisor restart.
7. Corrupt, symlinked, wrong-permission, or revision-regressed tasks quarantine.
8. GC deletes only eligible verified terminal jobs and safely resumes trash
   cleanup.
9. Existing public protocol results, tool lifecycle audit, TypeScript fallback,
   and Phase 4B1 tests remain compatible.

## Deferred work

PTY input, attach ownership, background-job UX, and resize remain Phase 4B3.
Windows named pipes and Job Objects remain Phase 4B4. Filesystem, environment,
network, and secret capability enforcement remains Phase 4C. Remote execution
and multi-tenant authorization remain Phase 4D.
