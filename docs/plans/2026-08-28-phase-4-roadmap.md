# Koda Phase 4 Hardening Roadmap

- Status: In progress — Phase 4B, Phase 4C1, Phase 4C2A/C2B, and Phase 4C3A-C3C complete
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

Status: In progress — Phase 4C1, Phase 4C2A/C2B, and Phase 4C3A-C3C are
complete; C3D client/platform closure, resource, provider/MCP/plugin, finer
network, and Windows sandbox slices remain

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

C1A delivers standalone TS/Rust schemas, deterministic profile resolution,
conservative capability evaluation, policy/capability fingerprints, and shared
golden fixtures. C1B connects the contract to native Pipe/PTY admission,
Supervisor/Worker launch boundaries, protocol v2, durable format v2, retained
evidence, and explicit v1 recovery. C1C activates trusted typed application
configuration and `KODA_EXECUTION_PROFILE`, binds policy/backend fingerprints
to command preparation and exact-command grants, applies the same admission to
TypeScript and native Pipe/PTY execution, propagates retained evidence through
events/results/process metadata, and exposes it through CLI, TUI, and
app-server protocol v15. Integrated security/platform acceptance remains C1D.
C1D adds a pinned real-v1 compatibility fixture, closes the old-grant and
backend-fingerprint negative matrices, adds shared execution-policy acceptance
to Windows CI, adds native macOS CI, and publishes the explicit
[execution-security guarantee](../security/execution-security.md). Phase 4C1
closed after implementation commit `4f8f4e9` passed the Linux `verify`, macOS
`macos-native`, and Windows `windows-native` jobs in
[GitHub Actions run 33294887963](https://github.com/ronaldo123321/koda/actions/runs/33294887963).

The approved next slice is
[Phase 4C2A macOS Seatbelt](2026-08-30-phase-4c2a-macos-seatbelt-design.md).
Platform delivery is deliberately ordered **macOS → Linux → Windows**. macOS
must first close protected Pipe/PTY execution and reporting against the C1
contract; Linux follows on the same contract. Windows sandbox enforcement is
deferred until both are complete. Existing Windows CI remains a regression gate
for the shipped Job Object, ConPTY, protocol, and durable runtime, but Windows
sandbox acceptance is not a Phase 4C2A completion condition.

C2A1 is complete: strict macOS capability/snapshot v2 contracts and shared
TS/Rust golden evidence are in place, the native executor protocol and durable
store advanced to version 3 in that slice, and durable v1/v2 history remained
readable without implicit upgrade. C2A2 is also complete: Koda now owns a bounded fixed SBPL
builder, `-D`-only canonical path parameters, a pipe/PID sandbox-bootstrap
confirmation protocol, and a startup probe that verifies real allowed and
denied operations through the exact system `sandbox-exec`. C2A3 is complete:
verified macOS Supervisors now advertise v2, protected Pipe and PTY launches
share the Seatbelt builder, `workspace_write` receives a private per-job
scratch directory, and a two-way sandbox handshake keeps user code gated until
PID/start identity and durable applied evidence are confirmed. C2A4 is also
complete: all clients derive their sandbox claim from retained evidence, real
macOS acceptance covers protected background PTY attach/resize/detach/restart
and typed inherited-network combinations, and the final guarantee is
published. Phase 4C2A closes only with the same implementation commit passing
macOS, Linux, and Windows regression CI.

The approved next platform slice is
[Phase 4C2B Linux Bubblewrap](2026-08-30-phase-4c2b-linux-bubblewrap-design.md).
It uses a trusted Bubblewrap mount/user/network namespace boundary plus a
Koda-owned `no_new_privs`/seccomp bootstrap and the same two-way durable release
gate as macOS. C2B1 is complete with execution-security schema v3, native
protocol v4, durable format v4, runtime fingerprints, shared fixtures,
formats 1–3 compatibility, grant binding, and client projections. App-server
protocol v15 remains compatible. C2B2 is also complete: trusted fixed-path
Bubblewrap discovery freezes executable identity, the typed builder creates a
read-only root/minimal-device view, a synchronous inner bootstrap applies
`no_new_privs` and architecture-specific seccomp, and a fixed confirmation/
release protocol drives a real multi-profile startup self-test. Linux now
advertises schema v3 only after that test. C2B3 connects that frozen builder to
both Pipe and PTY launches, revalidates workspace/scratch/capability/runtime at
the Worker boundary, verifies the inner PID/PGID/namespace/seccomp confirmation,
persists typed applied evidence before release, and preserves process-group,
timeout, cancellation, output, background PTY, attachment, resize, and restart
behavior. Deterministic faults cover every boundary from pre-spawn through
post-release. C2B4 adds the dedicated Linux-native gate, expanded real socket,
descriptor, syscall, Pipe/PTY, runtime-replacement and recovery matrices,
schema-v3 client projection, and the revised guarantee. Closing implementation
commit `abd6d3c` passed `verify`, `linux-native`, `macos-native`, and
`windows-native` in
[GitHub Actions run 33312729690](https://github.com/ronaldo123321/koda/actions/runs/33312729690),
which closes Phase 4C2B without completing the deferred work below.

The approved next security slice is
[Phase 4C3 secret lifecycle and output redaction](2026-08-30-phase-4c3-secret-lifecycle-redaction-design.md).
It introduces trusted host-environment declarations, single-use in-memory
leases, per-job read-only secret files, fresh per-command approval, and exact
byte-stream redaction before native Pipe/PTY persistence. The first supported
runtime is deliberately narrow: verified macOS Seatbelt or Linux Bubblewrap,
protected `read-only`/`workspace-write`, and denied network. C3A-C3C are
implemented: strict TypeScript/Rust declarations, public evidence and error
codes, bounded value-free catalog normalization/digests, exact-byte streaming
redactors, shared binary fixtures, frozen trusted application catalogs,
host-environment resolution into single-use leases, configured alias requests,
fresh approval, expiry, disposal, grant rejection, authenticated non-replayed
native transfer, private mode-`0700`/`0400` files, exact sandbox paths,
pre-persistence Pipe/PTY redaction, and conservative cleanup reconciliation.
C3D adds client projection and same-commit platform acceptance.

Phase 4C3A implementation commit `0846f8c` passed `verify`, `linux-native`,
`macos-native`, and `windows-native` in
[GitHub Actions run 33315958454](https://github.com/ronaldo123321/koda/actions/runs/33315958454).
This closes only the value-free contracts and standalone redaction core; it
does not by itself enable secret resolution, leases, injection, or runtime
output redaction. Phase 4C3B implementation commit `7273895` passed `verify`,
`linux-native`, `macos-native`, and `windows-native` in
[GitHub Actions run 33318090937](https://github.com/ronaldo123321/koda/actions/runs/33318090937).
This adds trusted preparation and approval. C3C now enables the narrow native
runtime described above. The closing C3C implementation tree at commit
`b4ab2c6` passed `verify`, `linux-native`, `macos-native`, and `windows-native`
in
[GitHub Actions run 33322204252](https://github.com/ronaldo123321/koda/actions/runs/33322204252).
This completes C3C, but it does not close Phase 4C3 without C3D.

Phase 4C3 does not claim containment from a process that is intentionally given
a secret. Encoded/transformed output, writes into the workspace, inherited
network, Keychain/Vault backends, Provider/MCP/plugin credentials, TypeScript
execution, and Windows injection remain explicitly deferred.

Until Phase 4C3D closes, safe evidence is not yet projected consistently by
every client and the same-commit platform acceptance matrix remains unclaimed.
Resource quotas, finer-grained network policy, provider/MCP/plugin sandboxing,
shell syntax, Landlock fallback, bundled Bubblewrap distribution, and all
Windows sandbox controls remain later Phase 4C/4E work rather than implicit
parts of Linux or Phase 4C3 completion.

Deferred Windows sandbox work remains explicit: restricted-token and privilege
policy, filesystem workspace/scratch rules, network denial, launch confirmation,
Job Object and ConPTY integration, durable evidence, reparse-point and Named
Pipe escape tests, client reporting, and same-commit platform acceptance. None
of these items is considered complete when macOS or Linux closes.

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
