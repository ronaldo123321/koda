# Koda Phase 3F1: Auditable Multi-File Change Transactions

- Status: Design complete; implementation pending
- Date: 2026-08-27
- Depends on: Phase 1B structured patching, Phase 2 recovery records, Phase 3A app-server, and Phase 3D Ink approvals
- Scope: bounded coordinated text-file creates, exact updates, moves, deletions, compensating rollback, mutation serialization, and durable outcome evidence

## 1. Outcome

Phase 3F1 adds a provider-neutral `apply_changes` tool for changes that must be reviewed and executed as one coordinated unit. One call can create, update, move, or delete several regular UTF-8 files after one complete approval preview. Preparation is read-only. Execution revalidates every touched path before the first mutation, serializes Koda writers for the workspace, and either commits every operation or attempts compensating rollback in reverse order.

The guarantee is intentionally precise: Phase 3F1 is atomic with respect to validation and ordinary in-process failures, but it does not claim filesystem-wide crash atomicity. Files in different directories cannot be committed by one portable atomic primitive. A process kill, power loss, rollback conflict, or concurrent external edit can therefore produce an explicitly recorded uncertain outcome. Koda never describes such an outcome as successful and never automatically repeats the change set.

The existing `apply_patch` contract remains available and unchanged for a one-file create or exact replacement. `apply_changes` is the preferred tool only when two or more paths must move together, a file needs several exact edits, or move/delete semantics are required.

## 2. Alternatives and decision

Three approaches were considered:

1. **Add a separate bounded `apply_changes` tool — selected.** It gives the model a finite transaction grammar, preserves `apply_patch` compatibility, and makes one approval correspond to one visible change set.
2. **Expand `apply_patch` into a polymorphic batch tool — rejected.** It would change a stable schema already used by provider adapters, tests, recovery fixtures, and user instructions while making simple edits harder to reason about.
3. **Expose a native diff language or shell patch command — deferred.** Those formats are expressive but add parser ambiguity, platform differences, directory and mode semantics, and a larger prompt-injection surface before the transaction boundary is proven.

Phase 3F1 chooses exact structured edits over fuzzy hunks. Failed preconditions are recoverable tool errors; Koda does not guess how to rebase a stale change set.

## 3. Tool contract

The provider-visible input is a strict discriminated union:

```ts
interface ApplyChangesInput {
  changes: Array<
    | {
        operation: "create";
        path: string;
        content: string;
      }
    | {
        operation: "update";
        path: string;
        edits: Array<{ old_text: string; new_text: string }>;
      }
    | {
        operation: "move";
        from_path: string;
        to_path: string;
      }
    | {
        operation: "delete";
        path: string;
      }
  >;
}
```

The runtime and JSON Schema enforce all of these limits:

- 1 to 16 operations per call and at most 32 exact update edits in total;
- at least one edit for every update;
- at most 4,096 UTF-8 bytes per path;
- at most 65,536 UTF-8 bytes per text field and 262,144 aggregate text bytes per call;
- at most 1,000,000 bytes per existing or resulting file and 8,000,000 aggregate snapshot bytes;
- at most 524,288 UTF-8 bytes in the generated approval details;
- no unknown fields, null bytes, absolute paths, empty paths, unchanged replacements, or empty `old_text` values;
- no path may be touched more than once across all sources and destinations in the same call.

An update applies its edits in array order to one in-memory candidate. Each `old_text` must have exactly one match in the candidate produced by the preceding edit. This supports several deliberate hunks in one file without allowing overlapping independent operations. A move cannot participate in a chain or swap because its source and destination are both reserved by that operation.

The success result is bounded and contains no file bodies:

```ts
interface ApplyChangesResult {
  status: "committed";
  planSha256: string;
  changes: Array<{
    index: number;
    operation: "create" | "update" | "move" | "delete";
    path: string;
    destination?: string;
    beforeSha256: string | null;
    afterSha256: string | null;
    bytes: number;
  }>;
}
```

`planSha256` is SHA-256 over canonical JSON containing the input index, operation, normalized workspace-relative endpoints, before/after digests, mode, and byte count for every operation. Object keys and operations use a specified stable order, so runtime events, tool output, tests, and future inspectors calculate the same identity. `bytes` is the affected file's content length: resulting length for create/update and original length for move/delete.

## 4. Filesystem and path boundary

Every source, destination, and parent is resolved beneath the canonical workspace root. The existing `.git`, `.koda`, and `node_modules` exclusions apply to every path component. Symlink targets and symlinked parents remain forbidden. Parents must already exist and be real directories; Phase 3F1 does not create directories.

Create destinations and move destinations must be absent. Update, move source, and delete paths must be existing regular files. Update and delete targets must be valid UTF-8 text. Move is also restricted to a regular UTF-8 file so the first richer write slice does not silently introduce binary mutation semantics. Directory moves, recursive deletion, hard-link preservation, symlinks, devices, sockets, chmod, ownership, timestamps, and extended attributes are outside the contract.

Moves require source and destination parents to be on the same filesystem device so a single `rename` is available. Cross-device moves fail during preparation rather than degrading into an unapproved copy-and-delete sequence.

The runtime compares normalized absolute endpoints and rejects duplicate lexical paths before approval. Filesystem case folding or an external process can still create a collision after preparation; execution detects that through revalidation and rolls back any earlier operations.

## 5. Preparation and approval

`prepareChangeSet` performs no mutation. It validates the complete input, resolves every path, reads the initial snapshots, applies exact edits in memory, computes before/after SHA-256 digests, records modes needed for restoration, validates move device identity, and constructs one immutable plan. Preparation fails before approval if any operation is invalid; a user is never asked to approve a plan that cannot succeed against the observed workspace.

The approval title is `Apply <N> coordinated workspace changes`. Its summary lists operation counts and affected paths. Its details preserve input order and contain:

- full created content;
- every exact removed and inserted update fragment;
- move source, destination, byte count, and content digest;
- full deleted content.

Because deletion approval contains the complete removed text, delete targets are additionally limited to 65,536 bytes. Move approval uses path, size, and digest because content bytes are unchanged. If the exact preview exceeds the aggregate approval budget, preparation fails with `CHANGE_PREVIEW_TOO_LARGE`; it is never silently truncated.

Policy sees the whole call as one `write` effect. `on-request` asks once; `never` denies before execution. Rejection means no path changed. Approval bodies remain durable through the existing `approval.requested` event and work in the CLI, app-server, and Ink UI without a second approval protocol.

## 6. Workspace mutation coordinator

Tool-registry `exclusive` concurrency is local to one turn and is not sufficient when two threads or two Koda processes target the same workspace. Phase 3F1 adds a `WorkspaceMutationCoordinator`, rooted under `KODA_HOME`, keyed by SHA-256 of the canonical workspace path.

Both `apply_patch` and `apply_changes` acquire this lease only after approval and release it in `finally`. Holding a lease while a user considers an approval is forbidden. Acquisition is cancellable and bounded; a live owner produces `WORKSPACE_MUTATION_BUSY`, while stale-owner metadata is recovered using the same conservative PID/ownership principles as the existing thread lease.

The coordinator serializes Koda writers but cannot lock out editors, Git, build tools, or unrelated processes. Hash and existence revalidation therefore remains authoritative. The transaction revalidates the entire plan after acquiring the lease and immediately before the first mutation. Each later operation also verifies the state it is about to replace, and each rollback step verifies that it is undoing Koda's own after-state rather than overwriting a third-party edit.

Retrofitting `apply_patch` to use the coordinator changes scheduling only; its schema, preview, result, errors, and one-file behavior remain compatible.

## 7. Execution state machine

Execution has five explicit states:

```text
prepared in memory
  -> lease acquired + all paths revalidated
  -> candidates staged and workspace.change_set_prepared persisted
  -> committing operations in deterministic order
     -> workspace.change_set_committed
     -> or reverse rollback
        -> workspace.change_set_rolled_back
        -> or workspace.change_set_uncertain
```

Create and update candidates are written to uniquely named temporary files beside their targets, flushed, closed, and mode-adjusted before the first workspace mutation. The commit order is deterministic by canonical primary path, with the original input index retained in previews and results. Create links or renames its staged file into place, update atomically renames its staged file over the target, move uses same-device rename, and delete removes the verified target.

The plan keeps bounded original bytes and modes for update/delete restoration. If an operation fails or cancellation arrives after the first mutation, execution enters a non-cancellable bounded cleanup section and compensates completed operations in reverse order:

- remove a created file only when it still has the planned after digest;
- restore an updated or deleted file through the same atomic-write primitive;
- rename a moved destination back only when the destination digest and source absence still match the plan.

Rollback success returns the original failure as `CHANGE_SET_APPLY_FAILED` and proves that observed before states were restored. Rollback conflict or failure returns `CHANGE_SET_OUTCOME_UNCERTAIN`, names the affected paths, and forbids any success claim. Temporary candidates are cleaned on every reachable terminal path.

## 8. Durable event and protocol contract

Phase 3F1 adds four bounded operational events:

- `workspace.change_set_prepared`: plan digest, operation descriptors, and before/after hashes, persisted before the first mutation;
- `workspace.change_set_committed`: plan digest and committed operation count;
- `workspace.change_set_rolled_back`: plan digest, applied count, restored paths, and initiating error code;
- `workspace.change_set_uncertain`: plan digest, applied count, uncertain paths, and error code.

All events include the existing tool call ID and tool name. Bodies contain paths, counts, modes only when needed, sizes, and digests; they never contain file content. Exactly one terminal change-set event may follow a prepared event. Event persistence failure before `prepared` leaves the workspace untouched. Persistence failure after mutation causes the turn to fail conservatively, and recovery treats the call as incomplete even if the filesystem may already match the plan.

Protocol schemas are strict and repeat the runtime limits: at most 16 operation descriptors or paths, 4,096 UTF-8 bytes per path, 128 bytes per error code, and fixed 64-character lowercase hexadecimal digests. The existing approval event gains explicit summary and detail byte budgets large enough for the accepted 524,288-byte preview; any tool that exceeds them fails before event persistence rather than emitting an invalid or truncated record.

The local app-server protocol moves from v7 to v8 because strict v7 clients cannot parse the new public event variants. `initialize` advertises `multiFileChanges: true`. No new RPC is needed: approvals and events already flow through the transport-neutral app-server contract.

## 9. Recovery semantics

Thread recovery validates change-set event ordering and enriches incomplete write evidence with the plan digest and affected paths.

- Prepared with no terminal event: outcome is uncertain; never replay automatically.
- Committed with no `tool.completed`: filesystem outcome is known committed, but provider delivery is incomplete; tell the model not to repeat it.
- Rolled back with no `tool.completed`: filesystem outcome is known restored; retain the failed call as recovery context rather than replaying it.
- Explicit uncertain: require inspection of every listed path before another overlapping write is proposed.

The recovery Conversation Item gains an optional bounded `workspaceChangeSets` array so the model and clients can distinguish committed, rolled-back, and uncertain incomplete calls. Existing logs without these events retain their current behavior.

Phase 3F1 does not automatically roll back after process death. Portable crash recovery would require a durable filesystem journal, backup retention, repair/accept-current UX, and platform-specific directory durability guarantees. That is a separate hardening slice. The existing execution-boundary rule remains: a write that started without a durable completion must not be assumed successful.

## 10. Error model

Expected failures remain recoverable tool results:

- `INVALID_TOOL_ARGUMENTS`: strict schema failure;
- `CHANGE_SET_LIMIT_EXCEEDED`: operation, edit, path, text, snapshot, or result budget exceeded;
- `CHANGE_PATH_CONFLICT`: a path is reused by multiple operations;
- `CHANGE_PREVIEW_TOO_LARGE`: the exact approval cannot fit its durable budget;
- existing path, patch-match, UTF-8, file-size, forbidden-path, and symlink errors where their meaning is unchanged;
- `MOVE_CROSS_DEVICE`: source and destination cannot use one rename;
- `WORKSPACE_CHANGED`: any source, destination, parent, digest, mode, or existence precondition changed before the first mutation;
- `WORKSPACE_MUTATION_BUSY`: another live Koda writer owns the workspace lease;
- `CHANGE_SET_APPLY_FAILED`: commit failed and rollback verified every before state;
- `CHANGE_SET_OUTCOME_UNCERTAIN`: rollback could not safely prove restoration.

Cancellation before the first mutation leaves no changes. Cancellation after the first mutation requests rollback; cleanup is not interrupted by the caller's aborted signal. If all operations crossed the commit boundary first, the committed event is authoritative even if provider delivery or the surrounding turn is later cancelled.

## 11. Component changes

Implementation is divided along existing package boundaries:

- `@koda/runtime-node`: strict tool schema, prepared change-set engine, staging/rollback primitives, workspace mutation coordinator, and `apply_patch` coordinator integration;
- `@koda/protocol`: protocol v8 capability, change-set event schemas, operation evidence schemas, and recovery metadata;
- `@koda/agent-core`: operational event forwarding and recovery-safe persistence behavior, without filesystem imports;
- `@koda/app`: create one workspace mutation coordinator per turn, register both write tools, and update model instructions;
- app-server client and Ink: accept v8 events and show bounded progress/failure summaries while reusing the existing approval panel;
- `@koda/testkit`: deterministic runtime, loop, recovery, app-server, client, TUI, CLI, and scenario coverage.

No provider adapter receives transaction-specific code. Providers only translate the ordinary model tool definition and JSON arguments.

## 12. Verification matrix

Automated tests remain credential-free and cover at least:

1. Two-file create/update success after one approval.
2. Several ordered exact edits in one file.
3. Move and delete success with complete preview evidence.
4. No mutation during preparation or rejected/denied approval.
5. Empty, oversized, unknown-field, duplicate-path, chained-move, and unchanged-edit rejection.
6. Missing/existing targets, ambiguous/missing exact matches, binary files, missing parents, traversal, forbidden directories, and symlinks.
7. Cross-device move rejection where the platform fixture supports it.
8. Whole-plan revalidation when any path changes after approval.
9. Staging failure before the first mutation.
10. Failure after operation 1 of N with verified reverse rollback.
11. Rollback refusal when an external edit replaces Koda's after-state.
12. Cancellation before mutation, during commit, during rollback, and after commit evidence.
13. One-shot execution and temporary-file cleanup.
14. Workspace lease serialization across threads and processes, live-owner timeout, stale-owner recovery, and cancellation while waiting.
15. Existing `apply_patch` compatibility under the shared coordinator.
16. Durable prepared-to-terminal event ordering and bounded schemas.
17. Event-persistence failure before and after the mutation boundary.
18. Recovery classification for committed, rolled-back, uncertain, incomplete, and legacy calls.
19. OpenAI Responses, OpenAI-compatible Chat, and Anthropic tool-schema exposure through the existing conformance tests.
20. CLI and Ink approval rendering, app-server v8 negotiation, real TTY behavior, and all six reliability scenarios.

Fault injection is a first-class test dependency: the runtime engine accepts deterministic hooks around staging, revalidation, each commit, each rollback, and cleanup. Production does not expose those hooks through configuration or model arguments.

## 13. Acceptance criteria

- One approved `apply_changes` call can safely coordinate up to 16 independent text-file operations.
- Every operation is visible in one complete, untruncated approval preview.
- No mutation occurs before policy approval, lease acquisition, full revalidation, staging, and durable prepared evidence.
- Ordinary execution failure or cancellation restores every already changed path or returns an explicit uncertain outcome.
- Rollback never overwrites a path that no longer matches Koda's planned after-state.
- Koda never automatically repeats an incomplete or uncertain change set.
- `apply_patch` remains schema- and behavior-compatible while sharing workspace serialization.
- Protocol v8, app-server/client, CLI, Ink, recovery, provider conformance, format, typecheck, unit tests, scenario tests, and a real TTY smoke all pass without credentials.
- Design and roadmap documentation name every deferred capability and destination.

## 14. Deliberate deferrals

- Directory creation, directory moves, recursive deletion, chmod/chown, symlinks, binary writes, and hard-link or extended-attribute preservation: later measured local-workflow slices.
- Overlapping operations, move chains/swaps, fuzzy patching, native V4A grammar, three-way merge, and automatic rebase: later patch-language evaluation.
- Durable crash journal, automatic post-crash rollback, orphan backup repair, and accept-current UI: Phase 4 filesystem hardening.
- Git commits, branch creation, staging, rollback through Git, and commit-message generation: a separate explicit product workflow.
- Approval caching and trusted scopes: a later Phase 3 policy slice.
- Strong OS sandboxing, network policy, Rust execution, PTY/background processes, and shell strings: Phase 4.
- Worktree isolation and child-agent writes: Phase 5 multi-agent execution.
