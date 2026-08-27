# Koda Phase 3F3: Session-Scoped Exact-Command Approval Grants

- Status: Implemented and verified
- Date: 2026-08-28
- Depends on: Phase 1C structured command execution, Phase 2 durable execution boundaries, Phase 3A app-server, and Phase 3D Ink approvals
- Scope: bounded, inspectable, expiring, revocable in-memory grants for repeating one exact normalized `exec_command` within one canonical workspace

## 1. Outcome

Phase 3F3 reduces repetitive approval prompts during a multi-turn local coding session without weakening Koda's default fail-closed policy. When an `exec_command` approval is pending, a capable client may approve it once or approve the exact normalized command for a short session window. A later call is automatically authorized only when the canonical workspace, built-in tool, normalized working directory, complete argument vector, and effective timeout all match the grant.

Grants are process-local capabilities owned by one `KodaApplication`. They are never loaded from disk, inherited by another process, shared across workspaces, inferred from previous approvals, or created by the model. Restarting the app-server revokes every grant. The default lifetime is 15 minutes, the allowed range is 60–3,600 seconds, and at most 64 active or pending grants may exist. Users can inspect active grants, revoke one grant, or revoke all grants for the current workspace.

Only the built-in `exec_command` tool can propose a Phase 3F3 grant. Writes, `apply_patch`, `apply_changes`, `apply_patchset`, MCP tools, unknown tools, shell interpreters, and command prefixes remain one-approval-per-call. The existing `never` approval mode always denies side effects and ignores grants. A grant does not bypass tool argument validation, command-runner confinement, process lifecycle recording, cancellation, output budgets, or the durable execution boundary.

## 2. Alternatives and decision

Three approaches were considered:

1. **Session-scoped exact normalized command grants — selected.** They address repeated tests, builds, and checks while keeping the authorization identity finite and reviewable. Process lifetime provides a natural hard revocation boundary.
2. **User-selected command prefixes — deferred.** Prefixes such as `pnpm test` are convenient but suffixes can materially change behavior; interpreters and task runners make safe automatic prefix suggestions unreliable. Prefix grants require a separate selector and risk model.
3. **Persisted workspace trust rules — rejected for Phase 3F3.** Durable grants need secure storage, startup disclosure, migration, expiry under clock changes, cross-process coordination, and protection against repository-controlled configuration. A stale rule should not silently survive a restart.

Automatic Git commits are also deferred. They are repository workflows, not approval policy, and require explicit dirty-tree, staging, branch, conflict, and recovery semantics.

## 3. Exact authorization identity

`exec_command` continues to accept structured `argv`, optional workspace-relative `cwd`, and optional `timeout_ms`. During read-only preparation, the command runner validates the executable token and arguments, resolves the canonical working directory, and applies the effective timeout. The tool adds one optional approval grant candidate:

```ts
interface ApprovalGrantCandidate {
  kind: "exact_command";
  key: string; // lowercase SHA-256 of canonical identity JSON
  summary: string;
  defaultExpiresInSeconds: 900;
  maximumExpiresInSeconds: 3600;
}
```

The canonical identity JSON uses a fixed key order and contains the tool name, canonical workspace root, canonical prepared working directory, complete argument vector exactly as executed, and effective timeout. Omitting a default and explicitly supplying that same default therefore produce one identity; different paths, arguments, ordering, environment-independent executable text, or timeouts do not. The SHA-256 key is a lookup identity, not a security signature.

The candidate is produced only after strict tool validation and safe command preparation. It is included in the bounded `approval.requested` event so clients know whether session approval is available. The human-facing summary is terminal-safe and bounded; the existing approval details remain the authoritative exact command preview.

## 4. Grant lifecycle and concurrency

An application-scoped `ApprovalGrantRegistry` stores active and pending records:

```ts
interface ApprovalGrantRecord {
  id: string;
  kind: "exact_command";
  toolName: "exec_command";
  workspaceRoot: string;
  key: string;
  summary: string;
  createdAt: string;
  expiresAt: string;
  uses: number;
}
```

The registry receives an injectable clock and ID source for deterministic tests. Expired entries are purged before matching, listing, reserving, or capacity checks. Creation first reserves an invisible pending slot. The AgentLoop durably records the user's approval and `approval.grant_created`, then activates the prepared grant synchronously. If any durable write fails, the pending reservation is cancelled and cannot match. Duplicate active identities are replaced only after the new grant is durably recorded.

Concurrent turns may reserve distinct grants without exceeding the global capacity. Matching never consumes a grant. Before a matched command crosses the execution boundary, the AgentLoop must durably append `approval.grant_used`; only then does the registry increment its in-memory use count and execution begin. A failure to persist usage leaves the process unstarted. Expiry is checked again at match time; an already-running command is not cancelled merely because its grant expires after authorization.

Revocation is synchronous registry state removal exposed through application use cases. Revoking an active grant prevents future matches but does not cancel a command whose durable execution boundary already began. Pending approval requests cannot be revoked through the registry; they remain cancellable through the existing turn flow.

## 5. Policy and approval semantics

The base `EffectToolPolicy` remains authoritative:

1. Read effects are allowed as before.
2. `never` denies execute and write effects before grant lookup.
3. `on-request` produces an ask decision.
4. Only then may the AgentLoop match the prepared grant candidate.
5. A match produces durable `approval.grant_used` evidence instead of `approval.requested`.
6. No match follows the existing interactive approval path.

An approval decision may add `grant: { expiresInSeconds }` only when the decision is `approved` and the request carries a candidate. Invalid, oversized, unsupported, expired, or capacity-exceeding grant selections fail closed and do not execute the tool. Ordinary one-time approval is unchanged.

The approval Conversation Item and `approval.resolved` event gain an optional `grantId`. This tells recovery and the model that the user approved the current action and also created a session capability. The grant itself is not reconstructed during resume. Historical grant-created or grant-used events are audit evidence only; restart still begins with an empty registry.

## 6. Durable event and recovery contract

Phase 3F3 adds two bounded operational events:

- `approval.grant_created`: call ID, grant ID, kind, tool name, canonical workspace, key, bounded summary, creation and expiry timestamps;
- `approval.grant_used`: call ID, grant ID, kind, tool name, key, and expiry timestamp.

Creation is ordered after `approval.resolved` and before `tool.execution_started`. Use is ordered before `tool.execution_started`. No file contents, command output, credentials, or environment values are included. The tool call Item already contains model-supplied arguments; the approval preview contains the reviewed effective command.

Recovery validates event ordering and identity consistency but never reactivates a grant. A created grant without tool execution remains historical evidence only. A used grant followed by an incomplete execution retains the existing uncertain execute-effect recovery behavior; the grant-use event does not imply that the process completed. Legacy logs remain valid.

## 7. Protocol v10 and client APIs

The local app-server protocol moves from v9 to v10 and advertises `approvalGrants: true`. `approval/resolve` accepts the optional grant duration. Three credential-free, idle-or-active-safe methods expose current process state:

- `approval/grants/list { workspace }` → bounded active records for that canonical workspace;
- `approval/grants/revoke { workspace, grantId }` → `{ revoked }`;
- `approval/grants/revokeAll { workspace }` → `{ revokedCount }`.

Workspace canonicalization uses the same read-only workspace boundary as turns. Listing returns at most 64 records ordered by expiry then ID and filters expired records. Revocation requires both ID and matching canonical workspace so a client cannot use an ID learned in one workspace to mutate another workspace's registry view. RPC responses are bounded and strict.

The Ink client adds:

- `a` on an eligible approval: approve and grant the exact command for 15 minutes;
- `y`: approve once; `n`: reject; `d`: toggle details;
- `/approvals`: list active grants for the current workspace in the transcript;
- `/approvals revoke <id>` and `/approvals clear`: revoke one or all current-workspace grants.

The approval card shows the additional key only when a candidate exists. CLI remains one-shot and continues to offer only one-time `y/N`; it accepts the extended protocol/domain types without advertising a useless session choice.

## 8. Limits and error model

- maximum 64 active plus pending grants per application;
- expiration range 60–3,600 seconds, default 900;
- grant ID at most 128 UTF-8 bytes;
- candidate key exactly 64 lowercase hexadecimal characters;
- summary at most 1,024 UTF-8 bytes;
- workspace at most 4,096 UTF-8 bytes;
- list response at most 128 KiB.

Stable expected failures include `APPROVAL_GRANT_INVALID`, `APPROVAL_GRANT_UNAVAILABLE`, `APPROVAL_GRANT_LIMIT_EXCEEDED`, and protocol `INVALID_PARAMS`. Registry or audit persistence failures prevent execution. Revoking an unknown or already expired grant is idempotent and returns `false`; revoke-all returns zero when nothing is active.

## 9. Verification matrix

Offline tests must cover:

- canonical exact-command identity, explicit/default normalization, and mismatch on argv/cwd/timeout/workspace;
- one-time approval, 15-minute grant creation, reuse without a second broker call, expiry, capacity, replacement, and concurrent pending reservations;
- `never` ignoring a matching grant, writes and MCP calls never receiving candidates, and invalid selections failing before execution;
- durable created/used/execution ordering, persistence failure before activation/use, and recovery that audits but never reconstructs grants;
- protocol v10 strict schemas, capability negotiation, list/revoke/revoke-all authorization and response budgets;
- Node client methods, app-server multi-turn reuse, CLI compatibility, TUI `a` handling, `/approvals` commands, status rendering, and stale/disconnected failures;
- all existing format, build/typecheck, offline tests, deterministic reliability scenarios, app-server grant create/reuse/revoke integration, and a real TTY flow that lists and clears grants, reports status, shuts down cleanly, and restores the terminal without a live provider request.

## 10. Deliberate deferrals

Phase 3F3 does not include command-prefix, executable-only, directory-wide, provider, write, MCP, network, persisted, cross-process, cross-workspace, or indefinite grants. It does not add environment-variable trust, shell strings, PTY/background execution, automatic retries, automatic Git commits, or permission prompts generated by the model. Those require separate safety and product slices.

## 11. Implementation sequence

1. Add protocol grant schemas, approval fields, public events, protocol v10 capability, and RPC contracts.
2. Add the bounded application-scoped registry and exact command candidate generation.
3. Integrate AgentLoop match/create/use ordering and recovery validation.
4. Add app-server/client list and revocation paths plus Ink approval and command UX.
5. Add focused and end-to-end tests, update README/roadmap, run all gates and real TTY smoke, then mark the slice verified.

## 12. Implementation result

Phase 3F3 is implemented on `main` with protocol v10. The built-in `exec_command` emits a SHA-256 candidate over the canonical workspace, normalized working directory, complete argument vector, and effective timeout. One `KodaApplication` owns the bounded in-memory registry; duplicate exact identities are replaced only after new creation evidence is durable, expiry and revocation are rechecked before use, and `never` remains authoritative.

AgentLoop records `approval.grant_created` before activation and `approval.grant_used` before the execution boundary. Recovery validates creation/use ordering and workspace identity but exposes no capability-restoration path. App-server and the Node client implement strict, bounded list/revoke/revoke-all RPCs. Ink supports `a`, `/approvals`, `/approvals revoke <id>`, and `/approvals clear`; the CLI remains one-shot.

Verification completed with formatting, build/typecheck, 40/40 offline test files and 316/316 tests, all 6 deterministic reliability scenarios, app-server multi-turn reuse without a second approval request, and a real TTY smoke covering protocol v10 startup, empty grant listing, revoke-all, `/status`, graceful shutdown, and normal terminal restoration.
