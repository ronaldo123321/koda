# Koda Phase 4A2: Explicit Workspace Conflict Resolution

- Status: Accepted for implementation
- Date: 2026-08-28
- Depends on: Phase 4A1 durable workspace mutation journals
- Scope: read-only conflict inspection, backup export, explicit resolution, stale-confirmation protection, durable resolution audit, and CLI/app-server/TUI clients

## 1. Outcome

Phase 4A2 turns a quarantined Phase 4A1 mutation journal into a user-resolvable workflow without weakening its fail-closed guarantee. A user can inspect bounded filesystem evidence, export an original backup, preserve the current workspace with `accept-current`, or deliberately restore the approved before state with `restore-original`.

Neither resolution is available to a model tool. Both are control-plane actions initiated by a human-facing client. Until the selected action and its originating thread audit are durably reconciled, later workspace writes remain blocked while reads continue.

## 2. Alternatives and decision

Three approaches were evaluated:

1. **Snapshot token, explicit resolution, and durable audit — selected.** The client confirms the exact filesystem evidence it displayed, and a post-resolution receipt makes audit reconciliation crash-replayable without repeating destructive work.
2. **Document manual file edits and journal deletion — rejected.** It has no stale-state protection, can discard the only backup, and creates no trustworthy audit boundary.
3. **Automatically restore every divergent journal — rejected.** A divergent endpoint may be an editor, formatter, Git operation, or user change. Automatic restoration would silently overwrite work Koda cannot attribute to its transaction.

## 3. Public conflict projection

Each retained conflict receives an opaque `conflictId` derived from its journal identity. Inspection returns only bounded metadata:

- originating thread, turn, tool call, tool name, plan digest, and creation time;
- a `stateToken` covering the immutable manifest plus every current source, destination, and staged-candidate observation;
- ordered operations with before/after digests and modes;
- current endpoint kind (`absent`, `file`, or `divergent`), digest and mode when it is a bounded regular file;
- whether a verified original backup exists and its byte count.

Backup bytes never appear in conflict lists, diagnostics, thread JSONL, model context, or ordinary event rendering. The token is recomputed while holding the workspace mutation lease. Any path, type, byte, mode, or staged-candidate change invalidates an earlier confirmation.

## 4. Resolution actions

`accept-current` preserves every current endpoint. It writes a durable resolution receipt recording the exact accepted `stateToken`, then reconciles the originating thread audit and deletes the journal.

`restore-original` is intentionally destructive. With a matching `stateToken` and under the mutation lease it restores the complete approved before state:

- remove a created target;
- replace an updated target from its verified backup;
- recreate a deleted source from its verified backup;
- recreate a moved source from backup and remove its destination;
- remove transaction-owned staged candidates.

The operation replaces or removes the endpoint itself but never follows symlinks. Every parent is revalidated beneath the canonical workspace immediately before publication. After restoration, all operations must classify as `before` and all staged candidates must be absent.

Backup export is read-only, requires the same current `stateToken`, and addresses one operation index. Only update, move, and delete operations have an exportable backup. Clients either write it to an explicitly selected local path or consume a bounded response; no implicit workspace path is chosen.

## 5. Crash and concurrency contract

Conflict inspection and resolution run under the same workspace mutation coordinator as normal writes. A conflict journal has these additional lifecycle semantics:

1. `conflicted`: inspection and a new decision are allowed.
2. `resolution_pending`: filesystem resolution has completed and a durable receipt contains the action, accepted token, and completion time.
3. audit reconciled: append one idempotent `workspace.change_set_resolved` event to the originating thread.
4. acknowledged: delete the journal and its backups.

If the process dies before `resolution_pending`, the journal remains conflicted and a new inspection/token is required. If it dies afterward, startup verifies the receipt and current resolved state, appends or recognizes the audit event, and deletes the journal without executing the resolution action again. A pending receipt whose resolved filesystem evidence no longer verifies remains quarantined and blocks writes.

## 6. Thread audit and recovery

The new terminal-follow-up event is:

```text
workspace.change_set_resolved {
  callId,
  name,
  planSha256,
  resolution: "restored_original" | "accepted_current",
  stateToken
}
```

It is valid only after the matching `workspace.change_set_uncertain` event. Duplicate identical resolution events are idempotent; conflicting resolution evidence is rejected. Once resolved, thread recovery omits the change set from active uncertain recovery state while retaining both events in history. Because this changes the public event union and RPC surface, the app-server protocol advances from v12 to v13.

## 7. Client contract

The application layer exposes transport-neutral operations to list conflicts for a workspace, inspect one conflict, export one backup, and resolve one conflict. The app-server publishes corresponding versioned JSON-RPC methods.

The CLI provides non-interactive commands suitable for scripts: list/inspect emit structured evidence, export requires an output path, and resolution requires both the conflict ID and state token. The TUI provides slash commands and a confirmation view; it never guesses a token or collapses inspection and destructive confirmation into one unreviewable step.

All clients render conflict evidence outside provider messages. Resolution commands cannot be reached through the agent tool registry, MCP tool discovery, Skills, project command templates, or plugins.

## 8. Verification matrix

Automated coverage includes:

1. bounded, stable conflict IDs and state tokens;
2. token changes for bytes, mode, type, absence, destination, and staged-candidate changes;
3. no backup bodies in inspection, diagnostics, events, or model-facing tool output;
4. verified backup export and rejection of create/no-backup indexes;
5. `accept-current` preserving divergent endpoints;
6. `restore-original` for create, update, move, and delete conflicts;
7. stale-token rejection before any mutation;
8. symlinked parent and endpoint race rejection;
9. crash before receipt, after receipt, after audit append, and during acknowledgement;
10. restart reconciliation without repeating a destructive resolution;
11. missing, busy, corrupt, duplicate, and conflicting originating audits;
12. write blocking throughout unresolved or unreconciled states;
13. app-server protocol, process client, CLI, TUI, and thread-recovery projections;
14. all Phase 4A1 recovery and existing reliability scenarios remain green.

## 9. Acceptance criteria

- A displayed token authorizes only the exact filesystem state the user inspected.
- `restore-original` never silently follows symlinks or writes outside the canonical workspace.
- A completed destructive resolution is never automatically repeated after a crash.
- `accept-current` does not alter workspace endpoints.
- Backup bytes remain private unless a user explicitly exports one operation's backup.
- The originating thread contains durable, idempotent uncertain and resolved audit boundaries before retained recovery material is removed.
- Reads remain available and writes remain fail-closed until the journal is safely acknowledged.

## 10. Deliberate deferrals

- Batch resolution across multiple conflicts; each conflict is confirmed independently.
- Editing or merging backup/current content inside Koda; clients export and external editors own that work.
- Binary, directory, symlink, ACL, ownership, and extended-attribute recovery.
- Remote multi-user authorization and distributed leases; Phase 4D owns that boundary.
- Model-initiated conflict resolution; it remains intentionally unsupported.
