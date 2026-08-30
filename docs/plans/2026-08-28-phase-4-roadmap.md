# Koda Phase 4 Hardening Roadmap

- Status: In progress — Phase 4B complete; Phase 4C1 C1A implementation in progress
- Date: 2026-08-28
- Depends on: completed Phase 3A through Phase 3I baseline

## Diagnosis

Koda now has a transport-neutral agent loop, durable thread events, bounded artifacts and context, coordinated workspace changes, multi-provider adapters, local MCP and plugin processes, an app-server, CLI, and TUI. The remaining risks sit below or beyond that application layer.

The current multi-file transaction retains rollback bytes only in process memory. A process kill or power loss can therefore leave a prepared change set partially applied with no executable recovery material. Process ownership also ends at the Node control process, remote transports have no authentication or reconnect contract, plugins have no trusted distribution path, and current execution guardrails are not an operating-system sandbox.

Phase 4 hardens these boundaries before Koda adds child-agent execution in Phase 5.

## Guiding policies

1. Never claim an outcome that cannot be proven from durable evidence and current operating-system state.
2. Never automatically repeat or overwrite an uncertain side effect.
3. Keep normalized thread events as the audit record; use purpose-built operational stores for recovery, supervision, secrets, and distribution state.
4. Add Rust only where process ownership or operating-system isolation requires a native boundary. Product policy and provider behavior remain TypeScript.
5. Reads may continue while a recovery conflict exists, but overlapping writes remain fail-closed until explicitly resolved.
6. Local and credential-free tests remain the default gate. Live, remote, and platform-specific checks supplement rather than replace deterministic fault injection.
7. Phase 4 does not absorb Phase 5 child agents, worktree delegation, mailbox coordination, or curated memory.

## Delivery slices

### Phase 4A: crash-safe filesystem mutation recovery

Status: Complete — recovery core and explicit conflict-resolution clients implemented and verified

- Persist bounded before-state backups and immutable change manifests beneath `KODA_HOME` before the first workspace mutation.
- Make journal publication and terminal-state transitions crash durable with file and best-effort directory synchronization.
- Reconcile orphaned journals under the existing workspace mutation lease.
- Classify all-before, all-after, safely partial, and externally divergent filesystem states without trusting an in-memory progress counter.
- Automatically discard all-before transactions, recognize all-after commits, and roll safely partial transactions back to their approved before state.
- Preserve divergent journals and block later workspace mutations until an explicit recovery decision is available.
- Reconcile the operational journal with the originating thread audit without automatically replaying a model tool call.

The recovery-core contract is in [Phase 4A crash-safe filesystem mutation recovery](2026-08-28-phase-4a-crash-safe-filesystem-mutations-design.md). The accepted client and explicit-resolution contract is in [Phase 4A2 explicit workspace conflict resolution](2026-08-28-phase-4a2-conflict-resolution-design.md).

Implementation status:

- **Phase 4A1 complete:** private journals, synchronized backups and manifests, staged-candidate tracking, startup classification and repair, symlink/type/hash conflict quarantine, audit reconciliation, recovery receipts, write blocking, and deterministic crash-state tests.
- **Phase 4A2 complete:** read-only conflict inspection, state-fingerprint tokens, token-bound `restore-original` and `accept-current`, verified backup export, crash-replayable resolution receipts, durable resolution audit, app-server protocol v13, and CLI/TUI workflows.

### Phase 4B: supervised native execution boundary

Status: Complete — native execution ownership is verified on macOS, Linux, and Windows

- Define a versioned local executor protocol independent of providers and clients.
- Add the Rust `koda-exec` sidecar for durable process ownership and bounded shutdown.
- Implement POSIX process-group and Windows Job Object ownership behind one contract.
- Support PTY-backed foreground work, managed background jobs, attach/detach, and crash-surviving status.
- Keep shell strings disabled while the isolation boundary is incomplete.

The accepted architecture, crash semantics, protocol, delivery slices, and
acceptance criteria are in [Phase 4B supervised native execution](2026-08-28-phase-4b-supervised-native-execution-design.md).

Implementation status:

- **Phase 4B1 complete:** Cargo workspace and `koda-exec`, private same-user Unix Socket, strict length-prefixed protocol v1, capability handshake, idempotent foreground starts, POSIX process groups, timeout/cancellation escalation, bounded file-backed stdout/stderr, reconnectable live job status and output, strict Node client validation, explicit `KODA_EXEC_PATH` selection, existing exec-tool result/audit compatibility, and cross-language tests.
- **Phase 4B2 complete:** per-job detached Workers, crash-durable manifests/state heads, authenticated Supervisor restart attachment, start-identity reconciliation, command start gates, bounded job listing, conservative retention/quarantine, and deterministic Supervisor/Worker kill-point tests.
- **Phase 4B3A complete:** POSIX PTY/background starts, Worker-owned controlling terminals, attach/detach, bounded segmented cursor logs, HMAC attachment capabilities, renewable fenced input ownership, resize, strict Node primitives, and real-PTY restart/failure tests.
- **Phase 4B3B complete:** approved `exec_terminal`, app-server protocol v14 process sessions, workspace-filtered discovery, TUI process pane, safe key routing, visible attachment/lease state, bounded terminal projection, and real-TTY acceptance.
- **Phase 4B4A complete:** platform seams, authenticated Windows Named Pipes, Windows process identity, private state ACL/locking, restricted bootstrap handle inheritance, fail-closed capability reporting, negative framing/identity tests, and clean Linux/Windows CI.
- **Phase 4B4B1 complete:** shared Windows Supervisor/Worker and durable runtime, SID/state/job-bound Worker Named Pipes, restricted token-handle Worker startup, Windows atomic state replacement and file semantics, fail-closed command execution, and clean Linux/Windows CI.
- **Phase 4B4B2 complete:** atomic Job Object process ownership, suspended direct Pipe/Background execution, restricted standard-handle inheritance, descendant-aware completion, bounded output, timeout, cancellation, force termination, and clean Linux/Windows CI.
- **Phase 4B4B3 complete:** live Worker reattachment after Supervisor restart, Worker-loss and suspended-start crash reconciliation, platform-correct lifecycle evidence, verified capability activation, and clean Linux/Windows CI.
- **Phase 4B4C complete:** Worker-owned ConPTY plus Job Object execution, real
  Windows TTY semantics, raw input, resize, fenced attachments, detach and
  Supervisor-restart continuity, descendant-aware completion, bounded final
  drain, timeout/cancellation escalation, and conservative Worker-loss
  recovery are verified by native Windows CI.

The accepted Phase 4B2 contract is in [Phase 4B2 Worker recovery](2026-08-29-phase-4b2-worker-recovery-design.md).
The accepted runtime-first Phase 4B3A contract is in [Phase 4B3A PTY and background runtime](2026-08-29-phase-4b3a-pty-background-runtime-design.md).
The accepted product-layer Phase 4B3B contract is in [Phase 4B3B interactive process UI](2026-08-29-phase-4b3b-interactive-process-ui-design.md).
The accepted Windows platform-foundation contract is in [Phase 4B4A Windows platform foundations](2026-08-30-phase-4b4a-windows-platform-foundations-design.md).
The accepted Windows Job Object execution contract is in [Phase 4B4B Windows Job Object execution](2026-08-30-phase-4b4b-windows-job-object-execution-design.md).
The completed Windows terminal contract and acceptance evidence are in [Phase 4B4C Windows ConPTY](2026-08-30-phase-4b4c-windows-conpty-design.md).

### Phase 4C: sandbox, network, and secret policy

Status: In progress — Phase 4C1 design approved; C1A implementation in progress

- Add explicit filesystem, process, environment, and network capabilities.
- Implement available OS isolation mechanisms and expose their effective strength rather than a portable boolean claim.
- Add scoped secret injection, output redaction, lifetime limits, and audit metadata without persisting secret values.
- Evaluate shell strings, pipelines, redirection, and command substitution only after the sandbox matrix passes. They may remain unsupported.

The approved Phase 4C1 design is in [Execution policy and isolation reporting](2026-08-30-phase-4c1-execution-policy-design.md).
It preserves explicitly labeled unconfined execution and refuses unsupported
isolation requirements without automatic downgrade. C1 covers the policy
contract, admission, approval binding, durable evidence, and client reporting;
it does not implement an OS sandbox. Concrete platform isolation, secret
injection/redaction, additional grants, and resource quotas remain later
Phase 4C work. Completing C1 will not complete Phase 4C.

### Phase 4D: authenticated remote operation

- Add HTTP/WebSocket app-server transport with authentication, reconnect cursors, event replay, and multi-client subscription ownership.
- Add remote MCP transport and OAuth lifecycle.
- Define shared or remote artifact storage, distributed leases, integrity verification, and retention ownership.
- Separate tenant identity, workspace authorization, and thread authorization.

### Phase 4E: extension and release supply chain

- Add plugin discovery, enable/disable, install, update, provenance, signature verification, and bounded lifecycle supervision.
- Define registry trust roots and safe rollback of failed updates.
- Produce signed cross-platform Koda and executor releases with reproducible release metadata.

### Phase 4F: hardening acceptance

- Run kill-point and power-loss simulations around every durable boundary.
- Exercise POSIX, macOS, Linux, and Windows execution ownership and sandbox capability matrices.
- Verify remote reconnect, authorization separation, shared artifact integrity, plugin signatures, and release provenance.
- Publish the exact guarantees and known platform limitations of the completed Phase 4 system.

## Phase 4 exit criterion

Koda can recover or safely quarantine interrupted filesystem changes, retain process ownership across control-plane failures through a native supervisor, enforce and report an OS-specific isolation policy, protect scoped secrets, reconnect authenticated remote clients without event ambiguity, verify installed extensions and releases, and pass deterministic and platform-specific hardening scenarios.

## Work explicitly kept beyond Phase 4

- Child-agent registry, lineage, delegation, wait/interrupt, mailbox, and worktree write isolation: Phase 5.
- Curated project memory, measured retrieval, and user-visible durable notes: Phase 5.
- Unrestricted shell compatibility, privileged containers, and transparent access to arbitrary host credentials are not roadmap commitments.
