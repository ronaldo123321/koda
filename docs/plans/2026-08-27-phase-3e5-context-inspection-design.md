# Koda Phase 3E5: Auditable Context and Instruction Inspection

- Status: Approved; implementation pending
- Date: 2026-08-27
- Depends on: Phase 2C context budgeting and compaction, Phase 3A app-server, Phase 3E1/3E2 thread inspection, and Phase 3E4 thread-scoped authorization
- Scope: durable per-model-request context telemetry, strict JSONL reconstruction, bounded current-instruction inspection, and an idle Ink viewer

## 1. Outcome

Phase 3E5 makes model context inspectable without asking the TUI to recreate or guess a historical provider request. Before every provider call, Koda durably records a bounded `context.prepared` event describing the exact context selection and budget state. An idle user can inspect the current thread with `/context` or press `c` from a thread preview without resuming that thread.

The inspector answers four questions:

1. What input budget applied to this model request?
2. How many tokens Koda estimated, calibrated, and later measured?
3. Which durable conversation state and compaction governed the request?
4. Which repository instructions were in force, and do the current files still match them?

JSONL remains authoritative for thread identity, workspace ownership, durable Items, Compaction, Usage, and request telemetry. SQLite is not used for context authorization or reconstruction. Current `AGENTS.md` and `KODA.md` content is discovered from the canonical workspace only when the user requests it; instruction bodies are not copied into `context.prepared`.

The feature is explanatory and read-only. It does not modify context, retry provider requests, start MCP servers, open tools, edit instructions, or add inspection output to the transcript or model input.

## 2. Alternatives and decisions

Three telemetry strategies were considered:

1. **Durable per-request telemetry — selected.** It records what Koda selected immediately before a provider call, survives restart, and supports deterministic audit.
2. **Recompute when the panel opens — rejected.** Repository instructions, MCP catalogs, runtime configuration, and history may have changed, so a fresh calculation could be presented as historical truth incorrectly.
3. **Configuration and hashes only — rejected.** It cannot explain compaction, estimate changes, or the effective request composition.

Three instruction presentation strategies were considered:

1. **Summary plus on-demand current content — selected.** The default view stays compact while Enter can open the current effective instructions or an individual current source. Hash comparison labels whether current content exactly matches the selected historical request.
2. **Inline all instruction bodies — rejected.** It makes ordinary context inspection noisy and creates unnecessarily large responses.
3. **Paths and hashes only — rejected.** It does not let the user inspect the actual current instruction text.

The request history is newest first, defaults to 100 entries, and supports sequence-cursor pagination. Loading an entire thread into TUI state is not required.

## 3. Durable `context.prepared` event

`AgentLoop` records `context.prepared` after context preparation succeeds and before calling the provider. If preparation creates a Compaction Item, the ordering is:

1. append the Compaction `item.recorded` event;
2. append `context.prepared`;
3. invoke `provider.stream`.

Failure to append either durable record prevents the provider call. A provider error after `context.prepared` leaves an honest record of the attempted request even when no `model.usage` event follows.

The payload contains:

```ts
type ContextPreparedPayload = {
  step: number;
  contextWindowTokens: number;
  maxOutputTokens: number;
  safetyMarginTokens: number;
  inputBudgetTokens: number;
  fixedInputTokens: number;
  rawEstimatedInputTokens: number;
  estimatedInputTokens: number;
  calibrationFactor: number;
  activeItemCount: number;
  activeItemTypes: Array<{ type: ConversationItem["type"]; count: number }>;
  activeItemsSha256: string;
  toolCount: number;
  toolsSha256: string;
  compactionItemId?: ItemId;
};
```

The Item digest is SHA-256 over the ordered, schema-normalized active Item array encoded as UTF-8 JSON. The tool digest uses the ordered, schema-normalized provider tool definitions. Type counts use stable type ordering. The event does not contain Item bodies, instruction bodies, tool schemas, provider payloads, API keys, MCP configuration values, or environment contents.

`ContextEngine.prepare` exposes the immutable budget snapshot required by the payload. A shared pure projector reconstructs the active context from durable Items and Compaction metadata so `agent-core` and the application layer use one algorithm.

## 4. App-server protocol v7

Phase 3E5 replaces the pre-release protocol v6 with v7; no parallel v6 handler is retained. `initialize` advertises `contextInspection: true`.

Three read-only methods are added:

- `thread/context` accepts canonical-workspace input, a local thread ID, an exclusive `beforeSequence`, and a limit from 1 to 100. It returns newest-first request descriptors and an earlier-page cursor.
- `context/read` accepts the workspace, thread ID, and a request anchor sequence. It returns detailed budget telemetry, optional measured Usage, reconstructed Item counts and digest validation, Compaction information, the governing `turn.context`, and instruction-source comparison descriptors.
- `context/instruction/read` accepts the same authorized request plus a server-issued source ID and mutually exclusive UTF-8 byte cursors. It returns current content only.

For new logs, the request anchor is the `context.prepared` event sequence. For an old log without these events, bounded descriptors may be projected from `model.usage`; their detail is marked `precise: false` and includes only facts supported by the nearest governing `turn.context`, Compaction, and Usage. Missing exact telemetry is never synthesized.

`context/read` strictly reconstructs the active Items preceding a precise snapshot and compares the count, type counts, and digest. Mismatch returns `CONTEXT_SNAPSHOT_CORRUPT`. Historical tool definitions are not reconstructed by starting MCP; their durable count and digest are presented as recorded identities.

Workspace inputs are capped at 4,096 UTF-8 bytes. List and detail responses have explicit serialized budgets. Instruction reads default to 16 KiB, allow at most 64 KiB per range, preserve code-point boundaries, and use a response budget that covers worst-case JSON escaping.

## 5. Instruction discovery and content reads

The application finds the `turn.context` for the selected request by matching the event Turn and requiring one preceding durable context snapshot. It then runs the existing bounded repository-instruction discovery against the canonical workspace and compares current sources with the historical snapshots.

Each descriptor is classified as:

- `unchanged`: path, scope, byte count, and SHA-256 match;
- `modified`: the historical path still exists in discovery but its metadata differs;
- `missing`: the historical source is no longer discovered;
- `added`: a current source was absent from the selected request.

The detail also exposes a virtual `effective` source. It combines Koda's current base instructions with the current scoped repository instructions through the same builder used for a live turn. When its digest equals the historical `instructionsSha256`, the UI labels it `exact historical match`; otherwise it is explicitly the current version and not a recovered historical body.

Every readable descriptor receives an opaque source ID derived by the server from the selected request and current discovery result. `context/instruction/read` accepts only one of these current IDs; clients cannot submit an arbitrary path. A `missing` source is not readable.

Each range read repeats canonical confinement and current discovery, opens one regular file snapshot or the bounded virtual effective source, validates UTF-8, and rejects replacement or mutation during the read. Symlinks and non-regular sources fail closed. Content is sanitized only at the TUI presentation boundary; the workspace file is never changed.

## 6. TUI interaction and state

The controller adds `context_list`, `context_detail`, and `context_instruction_view` modes. Context navigation is idle-only and shares the existing asynchronous generation counter.

From chat, `/context` targets the current thread. With no current thread it displays a notice without adding transcript content. From `thread_preview`, `c` targets the previewed thread without resuming it. The origin and browser state remain unchanged.

The request list emphasizes the latest or selected request with estimated tokens, input budget percentage, measured input when available, Item count, tool count, and Compaction status. Rows include Turn, step, timestamp, estimate/budget, and a precise or legacy marker. Up/Down selects; PageUp/PageDown loads adjacent request pages; Home/End reaches list boundaries; Enter opens detail.

The detail renders provider/model identity, all budget components, raw and calibrated estimates, measured Usage, calibration factor, Item type counts, digest validation, tool identity, and the latest Compaction summary. It then lists the effective source and repository sources with status, scope, bytes, and shortened digest. Up/Down selects a readable source and Enter opens its current body.

The instruction viewer reuses the verified UTF-8 range, wrapping, viewport, control-character sanitization, PageUp/PageDown, Home/End, and resize behavior established by the Artifact viewer. Escape returns from body to detail, detail to request list, and list to the original chat or thread preview. Late responses after Escape are ignored. No inspection state is appended as a Conversation Item or completed transcript row.

## 7. Failure and security behavior

Context inspection never asks for approval and never starts a Provider, MCP server, or tool. Stable data codes include:

- `CONTEXT_SNAPSHOT_NOT_FOUND`;
- `CONTEXT_SNAPSHOT_CORRUPT`;
- `INVALID_CONTEXT_CURSOR`;
- `CONTEXT_INSTRUCTION_NOT_FOUND`;
- `CONTEXT_INSTRUCTION_CHANGED_DURING_READ`;
- `CONTEXT_RESULT_TOO_LARGE`;
- existing thread-not-found, workspace-mismatch, and event-log-corruption codes.

Missing logs, partial trailing records, invalid events, non-contiguous sequences, conflicting thread IDs, invalid Compaction metadata, and workspace mismatches fail closed. They are not converted into empty request lists. Initial-load failure preserves the source chat or preview; paging failure preserves the current page; instruction-read failure preserves the detail or previously displayed range with a bounded retryable notice.

The feature never transports credentials, arbitrary environment values, provider request bodies, raw MCP configuration, or tool arguments beyond the already durable Conversation Items. Opaque source IDs prevent the instruction endpoint from becoming a general workspace file reader.

## 8. Testing and acceptance

Protocol tests cover v7 initialization, rejection of v6, `contextInspection`, strict list/detail/instruction schemas, exclusive cursors, safe-integer bounds, source IDs, legacy descriptors, result coherence, and response budgets.

Agent tests prove Compaction → `context.prepared` → provider ordering, provider suppression on durable-write failure, deterministic Item/tool digests and type counts, calibration snapshots, multi-step requests, and a prepared request without Usage after provider failure.

Application tests cover canonical authorization, newest-first pagination, exact reconstruction, digest mismatch, governing Turn context, legacy logs, corrupt and partial logs, Compaction history, Usage joining, and no MCP startup. Instruction tests cover effective-hash equality, unchanged/modified/missing/added sources, opaque-ID authorization, UTF-8 forward/backward ranges, symlinks, size limits, and read races.

Client and TUI tests cover typed round trips, real subprocess framing, `/context`, preview `c`, all three modes, list and content pagination, resize, unavailable sources, legacy markers, failure preservation, layered Escape, and stale responses. Acceptance requires formatting, build, workspace and test typechecks, the complete offline suite, all six deterministic reliability scenarios, and an isolated real-TTY context/list/detail/instruction/preview/shutdown smoke test.

## 9. Deferred destinations

- Persisting or reconstructing historical instruction bodies when current files differ.
- Editing instructions, approving instruction changes, or writing files from the inspector.
- Automatic prompt diffs, raw provider payloads, complete historical tool schemas, or Context export.
- Live following of a request while a turn is running.
- Cross-thread or cross-workspace context aggregation and SQLite context indexing.
- Remote transport authorization, shared app-server processes, and multi-client subscriptions.
