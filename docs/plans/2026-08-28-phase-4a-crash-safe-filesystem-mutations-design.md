# Koda Phase 4A: Crash-Safe Filesystem Mutation Recovery

- Status: Approved for implementation
- Date: 2026-08-28
- Depends on: Phase 2 durable recovery, Phase 3F1 change transactions, and the workspace mutation coordinator
- Scope: durable local journals, bounded backups, orphan reconciliation, safe automatic rollback, conflict quarantine, and thread-audit reconciliation

## 1. Outcome

Phase 4A closes the gap between in-process compensation and process-death recovery for `apply_changes` and the change-set engine shared by native patch documents. Before the first workspace mutation, Koda persists everything needed to classify and, when safe, restore the approved before state. A later Koda process can finish reconciliation without asking the model to repeat the tool call.

The guarantee is deliberately conditional. Koda automatically repairs only states that exactly match an approved before state, an approved after state, or a known operation-specific intermediate state. If any endpoint contains bytes, mode, type, or existence that cannot be attributed to the transaction, Koda preserves both the journal and its backups, reports the conflict, and refuses later workspace writes. It never overwrites a third-party edit merely to make a transaction look atomic.

Phase 4A covers bounded regular UTF-8 file changes already accepted by the change-set grammar. It does not claim filesystem snapshots, distributed transactions, directory mutation, or crash safety for arbitrary plugin and command side effects.

## 2. Alternatives and decision

Three approaches were evaluated:

1. **A Koda-owned durable mutation journal — selected.** It works in Git and non-Git workspaces, preserves exact approved bytes and modes, and can classify recovery using the existing before/after evidence.
2. **Git checkpoints and reset-based recovery — rejected.** Workspaces may not be Git repositories, may be dirty, and may contain user changes that Koda has no authority to stage, commit, or reset.
3. **Move the existing in-memory algorithm into Rust first — rejected for this slice.** A native sidecar improves process ownership but does not create durable rollback material. The transaction contract must become crash-safe before its execution process changes language.

Thread JSONL is not used to store backup bodies. It remains the append-only audit record, while the mutation journal is a short-lived operational recovery store.

## 3. Storage layout and identity

Journals live outside the workspace:

```text
KODA_HOME/workspace-mutations/
  <sha256(canonical-workspace-root)>/
    <thread-id>/
      <call-id>/
        manifest.json
        state.json
        backups/
          <operation-index>.before
```

Directories use mode `0700`; journal files and backups use `0600`. The immutable manifest contains:

- schema version, canonical workspace root and its digest;
- originating thread ID, turn ID, tool call ID, and tool name;
- `planSha256` and creation timestamp;
- every ordered operation, normalized source/destination paths, before/after SHA-256 values, byte count, and before mode;
- the relative backup path for update, move, and delete operations.

Create has no backup because its before state is absence. Move still receives a byte backup so recovery does not depend on a surviving hard link. Journal identity uses thread and call IDs rather than `planSha256` alone because the same approved plan can legitimately appear in different calls.

The mutable state file records `active`, `committed`, `rolled_back`, or `conflicted` plus bounded recovery metadata. It is diagnostic and lifecycle state, not the source used to decide which filesystem operations happened.

## 4. Durable publication order

After approval and workspace-lease acquisition, execution uses this order:

1. Revalidate the complete approved plan.
2. Stage create/update candidates beside their targets and synchronize them.
3. Create the private journal directory.
4. Copy every required before snapshot to a backup file and synchronize each file.
5. Atomically publish the immutable manifest and active state, then best-effort synchronize their parent directories.
6. Persist `workspace.change_set_prepared` to the thread event log.
7. Mutate workspace paths in deterministic order.
8. Persist a terminal change-set event.
9. Atomically mark the journal terminal, then remove its staging material and journal directory.

If any step before step 7 fails, the workspace is unchanged and temporary material is removed. A crash after journal publication leaves enough evidence for recovery even when the thread event log or mutable journal state ends in an earlier step.

The implementation does not depend on a progress counter being current. There is always an unavoidable crash window between changing a workspace path and recording that fact. Recovery therefore derives the outcome from the immutable plan and current endpoint identities.

## 5. Operation-state classification

Each operation has a finite set of recognized states:

- **create:** target absent is before; target with the approved after hash and mode is after.
- **update:** target with the approved before hash and mode is before; target with the approved after hash and mode is after.
- **delete:** target with the approved before hash and mode is before; target absent is after.
- **move:** source with the approved hash and destination absent is before; source absent and destination with the approved hash is after; both matching is the known link-before-unlink intermediate state.

Symlinks, non-regular files, unexpected modes, unexpected hashes, and impossible endpoint combinations are divergent. Parent resolution is rechecked beneath the canonical workspace root before classification and again before repair.

Whole-transaction classification is:

- every operation before: `not_started`;
- every operation after: `committed`;
- only recognized before, after, or move-intermediate states: `safely_partial`;
- any divergent operation: `conflicted`.

## 6. Recovery behavior

Recovery runs under the same workspace mutation lease before a new Koda write may begin.

- `not_started`: mark rolled back and remove the journal; no workspace mutation is needed.
- `committed`: recognize the approved after state, reconcile committed audit evidence, and remove the journal.
- `safely_partial`: restore applied operations in reverse deterministic order from durable backups, verify every before state, reconcile rolled-back audit evidence, and remove the journal.
- `conflicted`: atomically mark the journal conflicted, retain all backups, return bounded affected-path evidence, and block subsequent writes.

Recovery is idempotent. A crash during recovery produces another recognized before/after/intermediate combination or remains conflicted. A terminal thread event that was already persisted wins over an obsolete active state only after the current filesystem is verified to match that terminal outcome.

Automatic rollback uses fresh internal cancellation-independent cleanup signals. It never follows symlinks and never overwrites an endpoint that does not match a recognized transaction state.

## 7. Audit reconciliation

The journal and thread log serve different authorities:

- current filesystem plus immutable journal evidence determines operational recovery;
- normalized thread events determine conversation history and user-visible audit;
- a model tool call is never replayed to repair either store.

The manifest contains the originating event identity so recovery can append one bounded terminal recovery event to the correct thread after holding its thread lease. Existing committed, rolled-back, and uncertain semantics remain visible to thread recovery. Reconciliation is idempotent: if a matching terminal event already exists, recovery verifies it and does not append a duplicate.

If the originating thread log is missing, corrupt, or currently live, Koda does not invent an audit sequence. It completes only filesystem work whose safety is independently provable, retains a recovery receipt, and exposes a diagnostic for later audit reconciliation.

## 8. Conflict resolution boundary

The first implementation exposes conflict inspection and write blocking. A follow-on Phase 4A client slice may add explicit `restore-original` and `accept-current` commands or RPCs. Those actions are never model-initiated implicit cleanup:

- `restore-original` must show the current-versus-backup evidence and receive user approval because it can overwrite an external edit;
- `accept-current` preserves the workspace as-is, records that the user accepted a non-transactional outcome, and then removes retained recovery material;
- exporting a backup is read-only and may precede either decision.

Until one of those decisions is durably recorded, all Koda workspace mutations fail closed. Read, search, history, and artifact inspection remain available.

## 9. Component changes

- `@koda/runtime-node`: mutation-journal schemas and store, secure atomic persistence, backup verification, state classification, idempotent repair, and coordinator integration.
- `@koda/protocol`: bounded recovery evidence and terminal audit event where required by implementation.
- `@koda/agent-core`: forwarding for any new operational recovery event without filesystem knowledge.
- `@koda/app`: startup/orphan reconciliation before tool registration and user-visible recovery diagnostics.
- CLI, app-server, and TUI: bounded recovered/conflicted projections; explicit conflict resolution remains a separately accepted Phase 4A client slice.
- `@koda/testkit`: deterministic kill-point fixtures, corrupt-journal cases, recovery idempotency, and regression coverage.

## 10. Verification matrix

Automated tests cover at least:

1. Secure layout, strict manifest parsing, bounded paths and backup sizes.
2. No journal before approval and no workspace mutation when journal publication fails.
3. File and best-effort directory synchronization before the first mutation.
4. Crash before operation 1, after every operation, after the final operation, after terminal audit persistence, and during cleanup.
5. Create, update, move, and delete classification in before, after, and known intermediate states.
6. Automatic reverse rollback of every safely partial combination.
7. Committed recognition when all approved after states exist.
8. Hash, mode, type, parent, symlink, and endpoint divergence quarantine.
9. No overwrite of an external edit and fail-closed later writes.
10. Corrupt, truncated, oversized, mismatched-workspace, and forged manifest rejection.
11. Recovery idempotency when killed during rollback or audit reconciliation.
12. Existing in-process rollback, approval, mutation lease, thread recovery, provider, CLI, app-server, TUI, and scenario behavior.

## 11. Acceptance criteria

- A process kill at any change-set commit point leaves either the approved before state, the approved after state, or a durable journal that safely explains why automatic repair stopped.
- Safely partial transactions automatically return to the complete approved before state on the next recovery pass.
- External edits are never silently overwritten and block later Koda writes until explicitly resolved.
- Backup bodies never enter provider context, thread JSONL, ordinary diagnostics, or Tool output.
- Journal publication precedes the first mutation and terminal audit evidence precedes journal deletion.
- Recovery is deterministic, bounded, idempotent, and does not replay the model tool call.
- Format, typecheck, unit tests, all reliability scenarios, and targeted crash fixtures pass without credentials.

## 12. Deliberate deferrals

- Explicit conflict-resolution RPC and full CLI/TUI inspection workflow: next Phase 4A client slice after the recovery core proves stable.
- Crash-safe arbitrary command, plugin, or MCP side effects: their owning Phase 4 supervisor or remote subsystem.
- Rust executor, PTY/background jobs, Windows Job Objects, sandboxing, network policy, and secrets: Phase 4B and 4C.
- Remote audit/storage reconciliation and distributed mutation leases: Phase 4D.
- Directory, symlink, binary, ownership, ACL, extended-attribute, and cross-filesystem transaction support: separate explicit filesystem designs.
- Child-agent and worktree mutation isolation: Phase 5.
