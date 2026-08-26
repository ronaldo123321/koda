# Koda Phase 1B: Safe Structured Patch

- Status: Accepted for implementation
- Date: 2026-08-26
- Depends on: Phase 1A OpenAI read-only CLI slice
- Scope: one-file structured patching, runtime policy, per-patch approval, and safe workspace writes

## 1. Outcome

Phase 1B lets Koda create or update a UTF-8 text file after showing the user an exact preview and receiving approval. It keeps the existing OpenAI function-calling adapter and adds one `apply_patch` function with structured arguments:

```ts
interface ApplyPatchInput {
  path: string;
  operation: "create" | "update";
  old_text: string;
  new_text: string;
}
```

Each call changes one file. An update succeeds only when `old_text` has exactly one match in the current file. A create succeeds only when the target does not exist and `old_text` is empty.

This is intentionally smaller than OpenAI's native V4A Apply Patch protocol. It establishes Koda's provider-neutral policy, approval, and write boundaries before adding a more capable diff grammar.

## 2. User experience

```bash
export OPENAI_API_KEY=...
koda run "add a short Development section to README.md" --cwd .
```

When the model proposes a patch, stderr shows the operation, path, and exact removed and inserted text, followed by:

```text
Apply this patch? [y/N]
```

Only `y` or `yes`, case-insensitively, approves the call. Empty input, EOF, any other answer, or an approval read error rejects it. Rejection is returned to the model as a recoverable tool result so it can explain that no change was made.

`--approval-mode never` and `KODA_APPROVAL_MODE=never` deny every write without prompting. The default is `on-request`.

## 3. Architecture

```text
OpenAI function call
  -> ToolRegistry validates arguments and prepares invocation
  -> Workspace prepares candidate content and immutable preview
  -> ToolPolicy returns allow / ask / deny
  -> ApprovalBroker asks the user when policy returns ask
  -> prepared invocation revalidates the file snapshot
  -> atomic workspace write
  -> normalized tool result goes back to the model
```

`agent-core` owns policy and approval sequencing. `runtime-node` owns filesystem facts and mutation. `apps/cli` owns terminal input and presentation. The OpenAI adapter remains unaware of approvals and local paths.

Tool registrations declare an effect category: `read`, `write`, or `execute`. Phase 1B allows reads, asks for writes in `on-request` mode, and denies execution. A write-capable registration must prepare its preview before approval and return a closure that performs the previously previewed mutation.

## 4. Preparation and time-of-check safety

Preparation reads the current file, validates the operation, computes the candidate content, and records a SHA-256 digest of the original bytes. It does not mutate the workspace.

After approval, execution reads the target again. An update fails with `WORKSPACE_CHANGED` when the current digest differs from the prepared digest. A create fails when the path appeared after preparation. The model receives the failure and must inspect the new state before proposing another patch.

The preview and executable mutation are produced by the same prepared object, preventing the approval text and write behavior from being constructed by separate code paths.

## 5. Workspace boundary

Patch paths must be non-empty, relative, and free of null bytes. The workspace uses its canonical root and rejects lexical traversal. Updates reject symlinks, including path components that resolve through a symlink. Creates require an existing real parent directory inside the workspace and reject symlinked parents.

Phase 1B supports only regular UTF-8 text files. It rejects binary or invalid UTF-8 data, files larger than the existing one-megabyte read limit, patch fields larger than 64 KiB, unchanged replacements, file deletion, directory creation, and writes into `.git`, `.koda`, or `node_modules`.

Writes use a uniquely named temporary file in the target directory, flush and close it, preserve the existing file mode for updates, and rename it over the destination. Temporary files are removed after failures. Multi-file transaction semantics are deferred because each tool call owns one file.

## 6. Events and transcript

Before prompting, the loop persists `approval.requested` with the call ID, tool name, title, summary, and preview. After the decision, it records an existing `approval` conversation item and an `approval.resolved` event.

Approved calls then execute normally. Rejected or policy-denied calls produce `tool_result` errors with stable codes. The following model step receives the tool result; provider-specific state remains contained in `@koda/providers`.

Approval events are the durable integration boundary for a future Ink or desktop UI. Phase 1B's terminal broker performs the synchronous question itself, while the console event sink avoids rendering the same preview twice.

## 7. Error model

Expected failures are recoverable tool results:

- `POLICY_DENIED`: configured policy forbids the write.
- `APPROVAL_REJECTED`: the user did not approve it.
- `INVALID_TOOL_ARGUMENTS`: arguments fail schema validation.
- `INVALID_PATCH`: operation-specific preconditions are invalid.
- `PATCH_TARGET_EXISTS` or `PATCH_TARGET_MISSING`: create/update target mismatch.
- `PATCH_MATCH_NOT_FOUND` or `PATCH_MATCH_AMBIGUOUS`: update precondition mismatch.
- `PATH_OUTSIDE_WORKSPACE` or `SYMLINK_WRITE_FORBIDDEN`: unsafe path.
- `WORKSPACE_CHANGED`: target changed between preview and execution.

Cancellation while waiting for approval or writing terminates the turn with exit code 130. Persistence failures still stop the turn because Koda must not present or perform an unrecorded approval flow.

## 8. Testing

All automated tests remain offline and cover:

1. Create and unique update success.
2. Missing and ambiguous matches.
3. Traversal, symlink, ignored-directory, binary, and oversized input rejection.
4. No mutation before approval.
5. Approved execution and rejected/denied recoverable results.
6. Concurrent file change detection after preview.
7. Approval event and item ordering.
8. Terminal yes/no parsing and cancellation.
9. CLI configuration precedence and `--approval-mode` validation.
10. OpenAI function schema exposure through the existing provider.

## 9. Acceptance criteria

- `pnpm format:check`, `pnpm typecheck`, and `pnpm test` pass without credentials.
- The model cannot write without a prepared patch and an explicit allow decision.
- Default CLI behavior asks once for every patch call.
- `never` mode cannot be overridden by model arguments or repository content.
- A rejected patch leaves bytes unchanged and returns a recoverable tool result.
- A changed target cannot be overwritten using stale approval.
- Writes cannot escape the workspace through `..` or symlinks.
- API keys and full file contents are not stored outside the existing event log and user-visible preview.

## 10. Deferred work

- Native OpenAI V4A Apply Patch calls.
- Multi-file atomic patches, moves, and deletion.
- Shell execution and process sandboxing.
- Approval caching or "approve all" modes.
- Ink approval UI.
- Git rollback and automatic commits.
