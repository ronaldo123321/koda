# Koda Phase 4 Hardening Roadmap

- Status: In progress — Phase 4B2 complete; Phase 4B3 interactive/background jobs next
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

Status: In progress — Phase 4B2 complete; Phase 4B3 next

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
- **Phase 4B3 next:** PTY-backed foreground work, managed background jobs, attach/detach, resize, bounded input ownership, and reconnect cursors.

The accepted Phase 4B2 contract is in [Phase 4B2 Worker recovery](2026-08-29-phase-4b2-worker-recovery-design.md).

### Phase 4C: sandbox, network, and secret policy

- Add explicit filesystem, process, environment, and network capabilities.
- Implement available OS isolation mechanisms and expose their effective strength rather than a portable boolean claim.
- Add scoped secret injection, output redaction, lifetime limits, and audit metadata without persisting secret values.
- Evaluate shell strings, pipelines, redirection, and command substitution only after the sandbox matrix passes. They may remain unsupported.

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
