# Koda Phase 3F2: Strict Native Patch Documents

- Status: Implemented and verified
- Date: 2026-08-27
- Depends on: Phase 1B structured patching and Phase 3F1 auditable multi-file change transactions
- Scope: a bounded Codex-style patch document grammar compiled into the existing transactional workspace mutation engine

## 1. Outcome

Phase 3F2 adds a provider-neutral `apply_patchset` tool for expressing several line-oriented file changes in one compact patch document. The document can create, update, move, or delete regular UTF-8 text files. It is parsed and compiled without changing the workspace, then delegated to the Phase 3F1 transaction engine for complete approval preview, workspace-scoped writer serialization, pre-mutation revalidation, deterministic commit, compensating rollback, and durable outcome evidence.

This slice improves model ergonomics rather than introducing a second write implementation. The authoritative mutation grammar remains the prepared `WorkspaceChange[]` plan from Phase 3F1. A patch document is only another reviewed input representation for that plan. The existing `apply_patch` exact one-file tool and `apply_changes` structured multi-file tool remain available and schema-compatible.

The guarantee is intentionally strict. Koda Patch v1 is not Git unified diff, GNU patch, fuzzy matching, or a shell command. Context and removed lines must match one unique logical-line sequence in the current file. Koda never searches for a nearby approximate hunk, ignores whitespace, guesses offsets, creates parent directories, or silently applies a partial document.

## 2. Alternatives and decision

Three approaches were considered:

1. **Add a separate strict `apply_patchset` tool — selected.** A small native grammar is token-efficient and familiar to coding models while keeping the stable JSON tools intact. Compilation into Phase 3F1 gives it one safety and recovery model.
2. **Expand `apply_patch` into a polymorphic one-file-or-document tool — rejected.** This would weaken a deliberately simple stable schema, create provider `oneOf` ambiguity at the tool root, and make an old tool name mean two materially different approval scopes.
3. **Accept arbitrary Git unified diffs — rejected for Phase 3F2.** Full unified diff includes line-number drift, path prefixes, quoting, mode changes, binary forms, rename metadata, and implementation-specific fuzz. Supporting only a misleading subset under that name would be worse than defining a precise native grammar.

Git-aware staging, commits, branch creation, and rollback remain separate product workflows. Koda Patch v1 carries no implicit Git side effects.

## 3. Provider-visible contract

The tool input is strict JSON with one field:

```ts
interface ApplyPatchsetInput {
  patch: string;
}
```

The UTF-8 patch document is limited to 262,144 bytes and must not contain NUL or disallowed control characters. Its line-oriented grammar is:

```text
*** Begin Patch
*** Add File: path
+first line
+second line
*** Update File: path
@@
 unchanged context
-removed line
+replacement line
*** Move File: old/path
*** To: new/path
*** Delete File: obsolete/path
*** End Patch
```

The envelope occurs exactly once. It contains between 1 and 16 file sections. Add sections require one or more `+` lines and may finish with `*** No Final Newline`; otherwise created files end with LF. Update sections require between 1 and 32 total hunks across the document. Each hunk starts with exactly `@@`; every following line begins with one space for context, `-` for removal, or `+` for addition. A hunk must change content and must contain at least one context or removal line so its old sequence is non-empty. Move sections contain exactly one `*** To:` destination and no body. Delete sections contain no body.

Paths are literal workspace-relative header remainders. They cannot be empty, have leading or trailing whitespace, or contain control characters. Quoted paths, C-style escapes, `a/` and `b/` stripping, timestamps, modes, symlinks, binary data, and directory operations are not part of v1.

The document accepts LF or consistent CRLF syntax, with one optional line ending after `*** End Patch`. Section order becomes input order in the compiled transaction. A marker-looking file line is unambiguous because update content always has a prefix and add content always begins with `+`.

## 4. Parsing and compilation

Parsing is a pure, single-pass state machine with explicit envelope, section, and hunk states. It rejects unknown markers, content outside a valid section, duplicate envelope markers, empty or no-op hunks, malformed prefixes, missing destinations, trailing data, and all limit violations before any workspace read or approval request. Parser failures use stable `PATCH_DOCUMENT_*` errors with a bounded one-based document line number; errors never echo the whole patch.

The parser produces `WorkspaceChange[]`. Add, move, and delete sections map directly to existing Phase 3F1 operations. Update hunks compile to a line-edit form carrying ordered `oldLines` and `newLines`. During `prepareChangeSet`, after Koda reads the same snapshot used to calculate the plan digest and approval, each line edit is resolved against the evolving candidate:

- matching occurs only at logical-line boundaries;
- line text is byte-exact after UTF-8 decoding;
- the complete old-line sequence must occur exactly once;
- hunks are applied in document order;
- LF and CRLF files are both supported when their line endings are consistent;
- existing final-newline state is preserved for updates;
- mixed or lone-CR line endings fail closed rather than being normalized.

The resolved edit becomes the same exact `oldText`/`newText` representation already used for previews, aggregate text limits, candidate size checks, plan hashing, staging, and revalidation. Patch syntax is therefore absent from the mutation and rollback layers.

## 5. Approval, execution, and recovery

Preparation parses the entire document and prepares the complete Phase 3F1 plan before policy asks the user. The approval contains the generated canonical preview, not the model-supplied raw document, so the user reviews the exact resolved bytes and paths Koda intends to mutate. Oversized previews fail instead of truncating.

`apply_patchset` is a `write` effect and requires one approval under `on-request`; `never` rejects it without mutation. After approval it acquires the shared `WorkspaceMutationCoordinator` used by `apply_patch` and `apply_changes`. It emits the existing `workspace.change_set_prepared` event before mutation and exactly one committed, rolled-back, or uncertain terminal event. Tool name and call ID distinguish patch-document calls without adding duplicate event variants.

Recovery remains the Phase 3F1 model. A committed patchset must not be replayed merely because provider delivery was interrupted. A prepared call without a terminal event or an explicit uncertain outcome requires inspection of every affected path. A rolled-back call records that the observed before state was restored. Raw patch documents are not copied into operational events or recovery Items; the normal tool-call history and bounded approval event remain the durable user/model input record.

## 6. Protocol and client behavior

The local app-server protocol moves from v8 to v9 because initialization advertises a new public capability: `patchDocuments: true`. No new RPC method or event variant is needed. Existing app-server clients continue to receive ordinary approval and workspace change-set events after updating to v9.

CLI and Ink require no patch-specific interaction state. Their existing approval views show the canonical multi-file preview, and their existing change-set projections show preparation and terminal status. Fixtures and real-TTY smoke tests still verify initialization, approval rendering capacity, status, and graceful terminal restoration.

Base instructions teach a narrow selection rule:

- use `apply_patch` for one small exact create or replacement;
- prefer `apply_patchset` for compact line-oriented multi-hunk coding edits;
- use `apply_changes` when exact raw text, pure moves/deletes, or structured operations are clearer;
- never send Git diff headers to `apply_patchset` and never retry uncertain writes without inspection.

## 7. Limits and error model

The patch document inherits Phase 3F1 limits: at most 16 changes, 32 update hunks/edits, 4,096 UTF-8 bytes per path, 65,536 bytes per compiled old or new edit, 262,144 aggregate change text bytes, 1,000,000 bytes per resulting file, 8,000,000 aggregate snapshot bytes, and 524,288 approval-preview bytes. Parser limits are checked before compilation; compiled limits remain authoritative.

Expected failures are recoverable tool results:

- `INVALID_TOOL_ARGUMENTS`: root JSON schema failure;
- `PATCH_DOCUMENT_INVALID`: malformed envelope, section, marker, prefix, path, or no-op hunk;
- `PATCH_DOCUMENT_LIMIT_EXCEEDED`: raw document, section, hunk, line, or path budget exceeded;
- `PATCH_LINE_ENDINGS_UNSUPPORTED`: mixed or lone-CR target text;
- existing `PATCH_MATCH_NOT_FOUND`, `PATCH_MATCH_AMBIGUOUS`, path, snapshot, preview, mutation-busy, changed-workspace, rollback, cancellation, and uncertain errors from Phase 3F1.

All error messages are bounded and identify the relevant path or document line without embedding file bodies, secrets, or the complete patch.

## 8. Verification matrix

Offline tests must cover:

- valid add, ordered multi-hunk update, move, delete, and mixed documents;
- LF and CRLF patch syntax; LF and CRLF target preservation; final-newline preservation;
- malformed envelopes, headers, prefixes, paths, destinations, markers, empty sections, no-op hunks, trailing data, NUL/control text, and exact boundaries;
- unique, missing, ambiguous, and sequentially stale line hunks;
- compilation into one approval and the same prepared/committed ordering as `apply_changes`;
- rejection and cancellation before mutation, transaction rollback after an injected failure, and uncertain recovery inherited from the shared engine;
- provider-visible strict schema, system instructions, protocol v9 negotiation and capability fixtures, CLI end-to-end execution, and unchanged TUI change-set projection;
- formatting, build/typecheck, the complete offline suite, all deterministic reliability scenarios, and a real TTY startup/help/status/exit smoke.

## 9. Deliberate deferrals

Phase 3F2 does not include full Git unified diff compatibility, line-number or whitespace fuzz, three-way merge, combined update-and-rename hunks, directory creation, file modes, binary patches, symlinks, arbitrary encodings, mixed line-ending normalization, patch export, dedicated syntax-highlighted diff UI, Git staging/commits, or post-crash filesystem repair. Those require separate product and safety designs rather than undocumented parser behavior.

## 10. Implementation sequence

1. Add the pure Koda Patch v1 parser and focused grammar tests.
2. Add line-hunk compilation to `ReadOnlyWorkspace.prepareChangeSet` while preserving exact-edit compatibility.
3. Register `apply_patchset` over the shared transaction engine and mutation coordinator.
4. Upgrade protocol initialization to v9 with `patchDocuments: true`, update instructions and client fixtures, and add CLI/integration coverage.
5. Update README and roadmap, run all automated gates plus real TTY smoke, then mark this document implemented and verified.

## 11. Implementation verification

Phase 3F2 is implemented on `main` with protocol v9. `apply_patchset` exposes the accepted strict Koda Patch v1 grammar, compiles add/update/move/delete sections into the Phase 3F1 transaction engine, preserves consistent LF or CRLF update endings and final-newline state, shares the workspace mutation coordinator, and emits the same durable prepared/committed/rolled-back/uncertain evidence. Recovery explicitly accepts both structured and patch-document change-set tool identities without replaying interrupted writes.

The parser and runtime suites cover valid mixed documents, CRLF patch syntax, explicit create final-newline control, ordered evolving-candidate hunks, LF/CRLF target preservation, missing and ambiguous matches, mixed endings, malformed envelopes and markers, forbidden controls, exact section/hunk/line/document limits, one approval, provider-visible schema, instructions, protocol v9 negotiation, CLI execution, app-server/client fixtures, TUI capability fixtures, and recovery. Final verification completed with formatting, build/typecheck, 38/38 offline test files and 304/304 tests, all 6 deterministic reliability scenarios, and a real TTY smoke covering protocol v9 startup, `/help`, `/status`, graceful shutdown, and normal terminal restoration.
