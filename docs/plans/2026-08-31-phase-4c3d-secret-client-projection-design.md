# Phase 4C3D Secret Client Projection and Platform Acceptance

- Status: Implemented — same-commit four-job CI closure pending
- Date: 2026-08-31
- Depends on: Phase 4C3A value-free contracts, Phase 4C3B trusted leases,
  and Phase 4C3C native injection, redaction, and cleanup

## Decision summary

Phase 4C3D closes the supported secret boundary by projecting the same strict,
value-free `SecretExecutionEvidence` from the native executor through runtime
results, durable process events, app-server responses, CLI diagnostics, and TUI
activity/process views. No client reconstructs lifecycle state from exit codes,
platform names, approval text, or requested aliases.

The projection is optional at every historical boundary. An absent field means
that the command did not use a secret or that an older record predates secret
evidence; clients must not invent an empty or successful lifecycle. A present
field must pass the shared strict schema. Unknown, malformed, oversized, or
inconsistent evidence fails closed.

The app-server protocol advances from v15 to v16 and advertises
`secretEvidence: true`. This is intentional because v15 clients use strict
schemas and would reject the new event and process fields. Koda does not retain
a parallel pre-release v15 handler.

## Public contract

`SecretExecutionEvidence` remains the only public secret execution type. It
contains aliases, declared target environment names, a declaration digest,
opaque lease identity, expiry, lifecycle, per-stream exact-match redaction
counts, and cleanup status. It never contains a source environment name, raw
value, file path, argv value, inherited environment value, or transformed
output.

The optional `secrets` field is added to:

- foreground `ExecCommandResult` and PTY start results;
- native job summaries used by process discovery;
- `process.started` and `process.exited` durable events;
- app-server interactive process summaries returned by list, attach, read, and
  terminate workflows; and
- CLI/TUI projections of those results and events.

Running evidence normally reports `lifecycle = injected` and
`cleanup = pending`. Terminal evidence reports `destroyed/completed`,
`expired/completed`, `cleanup_pending/pending`, or `cleanup_failed/failed`.
The runtime copies the native evidence; it does not normalize a failure into a
successful cleanup state.

## Runtime data flow

For `exec_command`, the native client validates the snapshot and the workspace
runner emits the current evidence with `process.started`. After the job reaches
a native terminal state, it emits final evidence with `process.exited` and
returns the same evidence in the tool result. Secret failures continue to use
fixed typed errors, while retained safe evidence remains available in native
state for diagnosis.

For `exec_terminal`, the start result carries the running evidence. Native job
list summaries retain safe evidence so an app-server restart can rediscover a
background PTY without an in-memory cache. Attach and read reuse the authorized
process summary. Terminate refreshes both execution-security and secret
evidence from the terminal native snapshot.

The native protocol and durable format remain v5 because C3C already persists
and transports the safe evidence. C3D changes only TypeScript/public client
projection and acceptance coverage.

## Client presentation

The protocol package owns one deterministic, bounded formatter. CLI and TUI do
not stringify the complete evidence object. The compact text shows at most the
first three aliases plus a remaining count, lifecycle, cleanup status, and the
total number of exact-byte replacements. It omits lease IDs, declaration
digests, expiry timestamps, source names, file paths, and target environment
names because they add noise to routine diagnostics.

CLI prints the compact summary alongside process start and exit diagnostics.
TUI retains it in activity details and the process list/attached-session
header. App-server responses expose the full strict safe object for clients
that need structured audit evidence. Tool results also retain the object so
thread event readers observe the same evidence without a new RPC method.

No presentation says that the child process was unable to disclose a secret.
User-facing language remains limited to exact output redaction, denied network,
and observed cleanup state.

## Compatibility and failure rules

- Historical events and jobs without `secrets` remain readable.
- Present evidence is strict; clients never drop unknown fields and continue.
- Windows native and every TypeScript execution path reject secret use with
  `SECRET_POLICY_UNAVAILABLE` before user code starts.
- A transport interruption during a value-bearing start remains
  `SECRET_REAUTH_REQUIRED`; client projection does not add retry.
- `cleanup_pending` and `cleanup_failed` are safety-relevant and remain visible
  in CLI/TUI instead of being summarized as ordinary success.
- Exact-match redaction does not cover encoded, transformed, split, encrypted,
  or workspace-written derivatives.

## Acceptance

Shared TypeScript tests cover strict schema parsing, bounded formatting,
historical absence, app-server v16 negotiation, thread-event replay, process
list/attach/read/terminate projection, CLI diagnostics, and TUI activity/process
views. Tests scan serialized responses and rendered strings for raw sentinel
values and secret file paths.

Real macOS and Linux acceptance runs protected Pipe and background PTY jobs
with denied network. It verifies exact-byte redaction before persistence/live
attach, final cleanup evidence, process rediscovery, and app-server/client
projection. Windows CI verifies protocol/durable compatibility and fixed
pre-execution rejection; it does not claim Windows secret injection.

Phase 4C3 closes only when one implementation commit passes `verify`,
`linux-native`, `macos-native`, and `windows-native`, and the security/roadmap
documents record the exact guarantee and deferred work.
