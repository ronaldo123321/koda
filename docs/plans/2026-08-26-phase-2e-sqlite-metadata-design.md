# Koda Phase 2E: Rebuildable SQLite Thread Metadata

- Status: Accepted for implementation
- Date: 2026-08-26
- Depends on: Phase 2D durable side-effect and process lifecycle recovery
- Scope: rebuildable local thread metadata, post-run projection, and credential-free `thread list/show` commands

## 1. Outcome

Phase 2E adds a queryable SQLite projection for local threads without changing Koda's source of truth. Every row can be reconstructed from `KODA_HOME/threads/*.jsonl`; deleting `state.db` must lose no conversation or execution history.

Users gain `koda thread list` and `koda thread show <thread-id>` without an OpenAI API key. The index exposes status, timestamps, latest provider/model/workspace context, turn and event counts, aggregate token usage, valid JSONL byte offsets, and projection errors.

## 2. Alternatives and decision

Three storage approaches were considered:

1. **Scan JSONL for every query, rejected.** This is correct but makes thread listing cost proportional to complete transcript history and does not satisfy the metadata-index goal.
2. **Node's built-in `node:sqlite`, deferred.** Koda supports Node 22.20, where importing this API still emits an experimental warning. Exposing an experimental runtime surface in every CLI process is not justified yet.
3. **`better-sqlite3` behind a runtime repository, selected.** Its synchronous transaction model fits the small local projection, supports WAL and busy timeouts, and remains isolated so the backend can later move to stable `node:sqlite`.

The index will not be an `EventSink` in the authoritative `FanoutEventSink`. A derived-store failure must not convert a successfully persisted JSONL turn into an agent failure. Instead, Koda refreshes the affected thread after a run and refreshes changed logs before list/show queries.

## 3. Storage boundary and schema

`ThreadMetadataIndex` lives in `runtime-node` and owns `KODA_HOME/state.db`. Schema version 1 uses one `threads` table plus SQLite's `user_version`:

- identity: `thread_id` and relative `log_file`;
- state: `status`, optional `error_message`, `last_turn_id`;
- time: `created_at`, `updated_at`;
- context: optional `provider`, `model`, `workspace_root`, `approval_mode`;
- counts: `turn_count`, `event_count`, `last_sequence`;
- usage: model requests, reported requests, input, cached input, cache-write input, output, reasoning output, and total tokens;
- source fingerprint: file size, modification time, and `indexed_bytes`, the end offset of the last valid event.

Indexes cover descending update time, status plus update time, and workspace plus update time. Thread IDs are validated from both the filename and events. Absolute database paths are never stored in rows, so a complete `KODA_HOME` directory remains movable.

Parent-child relationships are not synthesized because the current event protocol has no fork provenance. They remain Phase 5 work. Monetary cost is also deferred until Koda has a versioned provider-pricing source rather than a mutable hard-coded price table.

## 4. Projection semantics

A changed log is read through `JsonlEventStore` and validated through the existing recovery invariants. Metadata is projected as follows:

- first and last valid event timestamps become creation and update time;
- the latest `turn.context` supplies provider, model, workspace, and approval mode;
- the latest terminal event yields `completed`, `failed`, or `cancelled`;
- a nonterminal latest turn is `running` only while a live thread lease exists, otherwise `interrupted`;
- terminal turn usage is summed across turns; an unfinished turn contributes its recorded per-request usage;
- a partial trailing line is excluded from `indexed_bytes` and produces an interrupted projection;
- an invalid log produces an `invalid` row with a bounded diagnostic instead of aborting the whole refresh.

Refresh compares file size and modification time before reparsing. A full rebuild first calculates projections, then replaces all rows in one transaction. Missing log files remove stale rows during a complete refresh. The stored byte offset makes staleness inspectable and leaves a safe optimization point for future incremental tail projection, but Phase 2E reparses a changed log to preserve simple whole-log validation.

## 5. Failure and corruption behavior

SQLite uses WAL mode, foreign keys, and a bounded busy timeout. Writes are transactional and parameterized.

If `state.db` is not a SQLite database or fails an integrity check with a corruption-class error, Koda closes it, renames the database and any WAL/SHM companions with a timestamped `.corrupt-*` suffix, and rebuilds from JSONL. Permission, disk-full, or lock failures are reported without renaming because they do not prove corruption.

Post-run index refresh is best effort: Koda prints a warning but keeps the already determined turn exit code. Query commands fail with an explicit CLI error if the index cannot be opened or refreshed. A corrupt individual JSONL file remains visible as `invalid`; its diagnostic is truncated to a bounded length and no transcript content is copied into SQLite.

No query or rebuild path modifies JSONL. No resume path trusts SQLite to choose sequence numbers, history, workspace ownership, or recovery status.

## 6. CLI surface

`koda thread list` refreshes the projection and prints a stable table ordered by `updated_at DESC, thread_id ASC`. It supports a bounded `--limit` and an optional `--workspace` filter.

`koda thread show <thread-id>` refreshes local metadata, then prints all projected fields and aggregate usage. A valid but unknown ID returns a distinct not-found exit code. Both commands resolve only `KODA_HOME`; they do not require credentials, a provider, or workspace access.

The existing `koda run` path refreshes its own log after releasing the thread lease. A process crash may therefore leave the index stale, but the next metadata query repairs it from JSONL.

## 7. Testing and acceptance criteria

Offline tests cover:

- projection of completed, failed, cancelled, interrupted, and live-lease threads;
- aggregate usage across multiple turns without double counting;
- unchanged-log skipping, changed-log refresh, missing-log deletion, and full rebuild;
- partial trailing lines and per-log invalid diagnostics;
- corrupt-database quarantine and automatic recreation;
- concurrent database writers under WAL and busy timeout;
- credential-free list/show CLI output, filtering, limits, and not-found behavior;
- best-effort post-run indexing without changing the agent result;
- unchanged resume behavior and JSONL authority.

Phase 2E is complete when `state.db` can be deleted or corrupted and rebuilt solely from JSONL, metadata commands remain useful without provider credentials, and no index failure can cause Koda to claim that durable agent history was lost.

## 8. Deferred destinations

- Parent/child thread lineage and fork queries: Phase 5 multi-agent protocol.
- Provider pricing tables and monetary cost materialization: a later accounting slice after versioned pricing inputs exist.
- Incremental event-tail projection using `indexed_bytes`: future optimization after profiling.
- Transcript full-text search or embeddings: not part of the metadata index.
- Artifact reference-aware garbage collection: Phase 2F or a dedicated storage-maintenance slice.
