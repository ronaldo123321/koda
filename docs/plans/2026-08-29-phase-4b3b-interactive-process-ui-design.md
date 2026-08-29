# Koda Phase 4B3B Interactive Process UI Design

- Status: Accepted — implementation next
- Date: 2026-08-29
- Depends on: Phase 4B3A PTY and background runtime complete

## Scope

Phase 4B3B exposes the Phase 4B3A native PTY runtime through the Agent harness,
stdio app-server, and Ink TUI. A model may propose a long-running interactive
command, the user approves its exact structured request, and the Tool returns a
durable job handle once the native Worker reaches `running`. The user then uses
the TUI process pane to attach, read, write, resize, detach, reattach, or
explicitly terminate that job.

This slice does not implement a complete VT/xterm emulator. It provides a safe,
bounded terminal-screen projection for shells, REPLs, test runners, development
servers, and ordinary interactive CLIs. Exact `vim`, `top`, `less`, alternate
screen, mouse reporting, and other full-screen terminal behavior remain later
work.

## Responsibility boundaries

`exec_terminal` is an Agent Tool. It reuses the existing command-policy boundary:
structured argv, workspace-confined cwd, filtered environment, prohibited shell
interpreters, execution approval, cancellation before start, and bounded
limits. Unlike `exec_command`, it does not wait for process exit. It returns a
durable `job_id`, `state`, `lifecycle`, and display metadata after the native
Worker owns the live PTY.

`InteractiveProcessService` is a long-lived app-server dependency. It owns one
shared `NativeExecutorClient`, registers the Tool-facing start operation, lists
workspace jobs, creates native attachments, retains native capabilities and
lease/fence material, renews leases, reads output, writes input, resizes,
detaches, terminates, and closes all UI attachment sessions during app-server
shutdown. A Turn never owns the native client or the UI attachment lifecycle.

The app-server exposes only random `processSessionId` values. Native attachment
capabilities, lease tokens, and fence values remain server-side and are never
sent to the TUI, written to the thread transcript, or logged. Losing an
app-server connection stops renewal and detaches the UI session; it never
terminates the native job.

The TUI owns presentation and keyboard routing only. It never reconstructs
lease validity or process state from chat events. PTY output is not appended to
the chat transcript and never enters model context.

## Native discovery metadata

The native `job/start` contract gains an optional bounded `display_name` that
is persisted in the manifest and omitted for legacy jobs. `job/list` summaries
include the safe display name and canonical cwd in addition to job identity,
state, mode, lifecycle, timestamps, and PID. The app-server filters listed jobs
to the selected canonical workspace and exposes PTY jobs only.

Arguments and environment values are not returned by process listing. The
approval preview and Tool result contain the already bounded user-visible
command description, while the process pane avoids turning executor discovery
into a secret-bearing command-history API.

## `exec_terminal` Tool

The Tool input contains:

- `argv`: 1–64 separate strings with the existing byte limits;
- optional workspace-relative `cwd`;
- required `timeout_ms`, from 100 ms through 24 hours;
- required `lifecycle`: `foreground` or `background`;
- optional bounded `display_name`.

The initial PTY is 24 rows by 80 columns with `TERM=xterm-256color` and the
default 4 MiB retained tail. The first TUI attachment immediately applies its
actual viewport dimensions.

Preparation uses the same executable, cwd, environment, and approval-preview
policy as `exec_command`. Session approval grants are not reused in this slice:
every interactive start requires a visible approval because it creates an
independently continuing process and grants future input capability. The Tool
result is a normal durable Tool result containing the job handle. It does not
emit an unfinished `process.started` lifecycle pair; the executor store remains
the authoritative long-lived process record.

## App-server protocol v14

Initialization adds `interactiveProcesses: boolean`. It is true only when the
native executor is configured and available. When false, `exec_terminal` is not
registered and process methods fail with a stable application error.

The protocol adds:

- `process/list`: bounded cursor listing for PTY jobs in one workspace;
- `process/attach`: open a UI session at an optional absolute cursor and try to
  acquire input ownership;
- `process/read`: read at most 64 KiB and advance the server-owned cursor;
- `process/acquire-input`: retry ownership for a read-only session;
- `process/input`: send 1–16 KiB of canonical Base64 input exactly once;
- `process/resize`: resize through the current input lease;
- `process/detach`: release the session and stop renewal;
- `process/terminate`: explicitly cancel the complete native process group.

Attach returns `inputState: owned | read_only`, dimensions, job state, cursor
bounds, and a random session ID. Input and resize requests never contain native
credentials. The service renews owned leases every five seconds. Renewal loss
atomically downgrades the session to read-only; input is not retried. A read
cursor expiry advances to the new earliest cursor and reports a visible gap.

## TUI process workflow

`/processes` opens `process_list`, showing display name, abbreviated job ID,
state, lifecycle, PID, and update time. Only idle chat mode opens navigation in
this slice. The list supports Up/Down, PageUp/PageDown, Home/End, `r` refresh,
Enter attach, and Escape back.

Attach enters `process_view`. The header shows job identity, state, lease mode,
cursor range, and terminal dimensions. When input is owned, printable bytes,
Enter, Tab, Backspace, arrows, and Ctrl combinations are encoded for the PTY.
When read-only, keys do not reach the process and `w` retries ownership.
`Ctrl+]` always detaches. `k` opens `process_terminate_confirm`; `y` terminates
and `n` or Escape cancels. `Ctrl+C` in an owned PTY sends byte `0x03`; it does
not cancel an Agent Turn or exit Koda.

The active process view polls bounded output approximately every 50 ms and
resizes on host terminal resize. Terminal jobs remain viewable until detached.
An invalidated app-server session returns to the list with an explanatory
notice rather than guessing attachment state.

## Safe terminal projection

`TerminalScreenProjector` is an incremental byte-to-screen state machine. A
streaming `TextDecoder` preserves split UTF-8 characters. The parser buffers
split escape sequences and supports newline, carriage return, backspace, tab,
basic CSI cursor movement, erase-in-line, erase-in-display, and SGR removal or
safe style normalization. OSC, device control, clipboard, title, hyperlink,
mouse, and unknown control sequences are consumed without reaching the host
terminal.

The projection retains at most 2,000 logical lines and 512 KiB of decoded text,
then drops the oldest complete lines with a visible truncation marker. Width is
bounded by the current viewport. Cursor movement is clamped to retained rows and
columns. The projector produces plain display rows for Ink, so PTY bytes cannot
address the outer Koda terminal.

## Failure behavior

- Missing native configuration disables the capability and Tool explicitly.
- A terminal job rejects input/resize but remains readable.
- A held or lost lease yields read-only state; input is never queued for retry.
- Native input backpressure is shown without duplicating bytes.
- Cursor expiry clears the local projection, advances to the retained tail, and
  reports that older output rotated away.
- App-server disconnect detaches sessions during shutdown; a new server can
  rediscover the durable job and create a new attachment.
- Worker loss follows Phase 4B3A reconciliation and never restarts the command.
- TUI unmount and normal shutdown restore ordinary chat keyboard ownership.

## Delivery slices

### Phase 4B3B1: protocol, service, and Tool

- Add protocol v14 process schemas and conditional capability.
- Add durable display metadata and workspace-filtered native discovery.
- Add `InteractiveProcessService` and explicit shutdown cleanup.
- Register the approved `exec_terminal` Tool only when native execution exists.
- Add service, protocol, approval, restart-discovery, and failure tests.

### Phase 4B3B2: TUI process pane

- Add client methods and strict result parsing.
- Add process list/view/confirmation controller states.
- Add lease renewal/read polling, key encoding, resize, detach, and termination.
- Add the safe terminal projector and bounded screen rendering.

### Phase 4B3B3: acceptance and closure

- Add controller/view tests for every navigation and ownership state.
- Extend the real-TTY harness through approved Tool start and PTY interaction.
- Verify app-server restart, cursor expiry, terminal reads, and restoration.
- Run format, typecheck, Clippy, Rust, TypeScript, and deterministic scenario
  gates, then mark Phase 4B3 complete.

## Acceptance criteria

Phase 4B3B is complete when tests prove:

1. A scripted model can propose `exec_terminal`, obtain exact approval, and
   receive one durable job handle without waiting for process exit.
2. The process pane discovers only PTY jobs in its canonical workspace.
3. Attach, output, input, resize, detach, reattach, and explicit termination work
   through app-server without exposing native credentials.
4. Lease loss becomes read-only and neither TUI nor service retries input.
5. Cursor expiry produces a visible, recoverable output gap.
6. Split UTF-8 and escape sequences cannot escape the bounded Ink projection.
7. App-server restart rediscovers running jobs without restarting commands.
8. Real-TTY key routing never leaks PTY input into chat and restores the host
   terminal after detach and shutdown.
9. Existing non-interactive `exec_command`, approval, audit, provider, CLI,
   app-server, and TUI behavior remains green.

## Deferred work

Complete VT/xterm alternate-screen emulation, exact `vim/top/less` behavior,
mouse protocols, clipboard integration, remote multi-client arbitration, and
Windows ConPTY remain outside Phase 4B3B. Remote authenticated transport remains
Phase 4D; Windows process ownership remains Phase 4B4.
