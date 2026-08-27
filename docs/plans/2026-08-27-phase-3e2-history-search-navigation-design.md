# Koda Phase 3E2: History Search and Windowed Navigation

- Status: Implemented and verified (2026-08-27)
- Date: 2026-08-27
- Depends on: Phase 3E1 thread browser, authoritative JSONL history, and rebuildable SQLite metadata
- Scope: workspace-scoped durable-history search and bounded bidirectional navigation without turning presentation state into runtime state

## 1. Outcome

Phase 3E2 extends the Phase 3E1 thread browser into a practical local history navigator. An idle user can search durable display-worthy history across every thread in the current canonical workspace, open a match in its surrounding context, move backward and forward through a bounded history window, and safely resume the selected thread through the existing authoritative checks.

The slice keeps three boundaries intact. JSONL remains the authority for history and resume. SQLite is a disposable search projection rather than a transcript store. Ink continues to use the normal terminal screen buffer, with a bounded live region instead of an alternate-screen application that obscures native scrollback.

The user experience may feel continuous at page boundaries, but memory is deliberately bounded. The controller can discard the far side of its event window and fetch it again through stable sequence cursors. Phase 3E2 therefore implements continuation-style history navigation, not an unbounded in-memory transcript.

## 2. Alternatives and decision

Three search implementations were considered:

1. **A rebuildable ordinary SQLite projection with bounded substring matching — selected.** It gives Chinese, English, and short terms consistent semantics, isolates the TUI from storage details, and remains disposable because every row can be reconstructed from JSONL.
2. **SQLite FTS5 — deferred.** Tokenizer behavior for Chinese and short identifiers would require an explicit ranking and compatibility design that is unnecessary for the first local search slice.
3. **Scan every JSONL log for every query — rejected.** It preserves authority but makes repeated interactive searches scale with the complete workspace history and duplicates validation work on every request.

For navigation, Phase 3E2 extends the existing event API with a forward cursor and maintains a bounded client window. It does not add a server-side viewport or terminal-formatted transcript API. Search hits are navigation pointers; opening one re-reads authoritative JSONL rather than trusting text stored in SQLite.

## 3. Protocol v4 and application boundary

Phase 3E2 replaces the pre-release app-server protocol v3 with v4. Parallel v3 and v4 handlers are not maintained. `initialize` requires v4 and advertises `threadSearch: true` and `bidirectionalThreadEvents: true` in addition to the existing capabilities.

`thread/events` accepts mutually exclusive sequence cursors:

```ts
type ThreadEventsParams = {
  threadId: string;
  beforeSequence?: number;
  afterSequence?: number;
  limit?: number;
};

type ThreadEventsResult = {
  events: DurableThreadEvent[];
  hasEarlier: boolean;
  hasLater: boolean;
  nextBeforeSequence?: number;
  nextAfterSequence?: number;
};
```

With neither cursor, the method returns the latest page. `beforeSequence` returns up to the newest `limit` events below the exclusive cursor. `afterSequence` returns up to the oldest `limit` events above the exclusive cursor. Every result is chronological. Home follows stable `beforeSequence` cursors until `hasEarlier` is false; End requests the latest page directly. `limit` remains 1 through 200, defaults to 200, and every result remains under the 768 KiB budget established in Phase 3E1.

The new `thread/search` method has this logical contract:

```ts
type ThreadSearchParams = {
  workspace: string;
  query: string;
  cursor?: {
    revision: number;
    updatedAt: string;
    threadId: string;
    sequence: number;
  };
  limit?: number;
};

type ThreadSearchResult = {
  matches: ThreadSearchMatch[];
  revision: number;
  hasMore: boolean;
  nextCursor?: ThreadSearchCursor;
};
```

The app layer canonicalizes and enforces the workspace. Queries are at most 256 UTF-8 bytes and contain at most eight non-empty whitespace-separated terms. Terms have AND semantics; regular expressions, operators, and a query language are not supported. `limit` is 1 through 100, and a result is bounded to approximately 256 KiB. Matches are ordered by thread update time descending, thread ID ascending, then event sequence descending. Each match contains bounded thread summary metadata, sequence, event kind, timestamp, and a terminal-safe snippet of at most 512 UTF-8 bytes.

`@koda/app-server-client-node` exposes typed `readThreadEvents()` and `searchThreads()` operations and validates every v4 result. Opening a search hit obtains context with one `beforeSequence` request and one `afterSequence` request; no separate server-side `around` API is introduced.

## 4. Rebuildable search projection

The SQLite metadata schema advances from v1 to v2 and adds `thread_search_items`. The table is keyed by `(thread_id, sequence)` and stores the canonical workspace association, event timestamp, searchable kind, original bounded display text, normalized search text, and whether the source was truncated. Thread update time and summary metadata may be joined from the existing thread projection rather than copied into an authoritative transcript.

Only durable, display-worthy content is indexed:

- user messages and completed assistant replies;
- bounded tool-result summaries and tool failures;
- context-compaction, recovery, cancellation, and terminal failure summaries.

The projection excludes assistant deltas, provider continuation state, approval details, tool-call arguments, process lifecycle events, and raw artifact content. Each indexed item is capped at 256 KiB of UTF-8 text. Oversized text is deterministically reduced with a visible head/tail truncation marker before both original and normalized forms are stored.

Index refresh validates the same thread ID and contiguous event sequence invariants as authoritative history reads. A missing or malformed log, a non-contiguous sequence, a thread mismatch, or an incomplete tail produces no search rows for that thread and deletes its stale projection. Diagnostics remain visible through the existing metadata/index reporting path. A schema mismatch or corrupt `state.db` rebuilds the complete disposable projection without modifying JSONL or artifacts.

Search normalization is deterministic and shared by indexed text and query terms. Parameterized SQLite `instr(normalized_text, ?)` predicates implement substring matching with AND semantics. The snippet is centered around the earliest match where practical, bounded to 512 UTF-8 bytes, and sanitized for terminal display.

Every refresh that changes a metadata or search projection advances a monotonic revision; a no-op fingerprint refresh preserves it so continuation pages remain usable. Search cursors bind that revision to their stable sort tuple. A cursor from an older revision fails with `THREAD_SEARCH_INDEX_CHANGED`; the client retains the query and prompts the user to rerun it instead of silently mixing result snapshots.

## 5. TUI states and interaction

The controller supports five interface states: `chat`, `thread_list`, `thread_search_input`, `thread_search_results`, and the shared `thread_preview`. Preview state records whether it was opened from the list or search results so Escape returns to the correct layer. Browsing, searching, and thread switching are allowed only while idle and without a pending approval.

- `/threads` or `Ctrl+T` opens the thread list.
- `/` from the list opens search input; `/search <query>` from chat executes a search directly.
- Search input supports ordinary editing, Backspace, Enter, and Escape.
- Up and down move one result or history row. PageUp and PageDown move one visible window. Enter opens the selected search hit or list item.
- A search preview merges its before and after pages, positions the matching event in the visible window, and marks and colors matching display rows.
- A normal preview starts at the newest history. Home loads the earliest window and End returns to the latest window.
- Reaching an event-window edge automatically fetches older or newer history. Pressing `r` performs the existing safe resume flow.

The controller retains at most 400 raw events and 200 projected rows. When a merge exceeds those limits it discards the side farthest from the user's current position while retaining enough cursor state to fetch that side again. Search results are cached up to 500 matches; reaching that ceiling produces an explicit message rather than unbounded growth.

The visible viewport follows terminal resize and is clamped between 5 and 30 rows. Ink remains in the normal screen buffer. Only the current bounded live region changes; rows already emitted through `<Static>` are never presented as though they were erased.

## 6. Authoritative navigation and resume

SQLite matches are pointers, not history records. Entering a match first refreshes the selected thread with `thread/get`, then reads the hit and its surrounding events from JSONL through `thread/events`. If the log changed and the target sequence is missing or no longer corresponds to the indexed kind, preview fails safely and asks the user to rerun the search.

Opening or moving through a preview does not change the current chat thread. Pressing `r` repeats the Phase 3E1 canonical-workspace, status, provider, and model checks before committing the resume. The runtime remains authoritative for writer leases, recovery, provider compatibility, and the ability to continue a turn.

Historical approvals, tool calls, and process records are inert display data. They can never trigger approval, execution, cancellation, or effect replay. Search and preview do not delete or rewrite JSONL, artifacts, metadata, or chat output.

## 7. Concurrency, consistency, and errors

The browsing controller serializes list, search, page, preview, and resume operations. Each async navigation generation receives an identifier. Changing layers or pressing Escape advances the identifier, so a late response from an obsolete request is ignored even if the underlying RPC finishes normally.

Page merges require the same thread ID, chronological order, contiguous sequences at the join, and no duplicates. Exclusive sequence cursors remain stable while a thread appends new events. `afterSequence` can expose later appends when explicitly requested, but Phase 3E2 does not subscribe to background updates.

List, search, preview, pagination, and resume errors preserve the current layer, query, selected item, input, and original chat thread wherever that layer remains meaningful. `THREAD_SEARCH_INDEX_CHANGED` keeps the query visible and offers a rerun. A protocol/schema violation follows the existing strict-client disconnect path; it is never treated as an empty result.

Search strings, snippets, metadata, event-derived rows, and diagnostics are byte-bounded and terminal-sanitized. Search rows contain no raw credentials, provider continuation payloads, environment variables, approval details, tool arguments, process output, or artifact bodies.

## 8. Testing and acceptance criteria

Protocol and application tests cover:

- v4 initialization, capability flags, and rejection of v3;
- mutually exclusive cursors, default latest reads, earliest/older/newer windows, ascending output, and cursor flags;
- stable bidirectional paging across concurrent appends, the 200-event cap, and the 768 KiB history budget;
- strict search parameters, the 100-match page limit, the approximately 256 KiB result budget, stable ordering, and revision-bound cursors;
- authoritative preview reads and safe failure when an indexed sequence no longer exists.

SQLite tests cover schema v2 rebuild, Chinese, English, and short-term substring queries, multi-term AND matching, workspace isolation, deterministic ranking, pagination, revision mismatch, snippet selection, terminal sanitation, large-item truncation, excluded event classes, invalid-log cleanup, and stale-row removal.

Node client tests cover `searchThreads()`, both history directions, schema validation, RPC errors, timeouts, and oversized responses. Controller and Ink tests cover all five states, search editing, layered Escape, resize clamping, selection and page movement, Home and End, automatic edge loading, bounded eviction and refetch, match positioning and highlighting, idle-only guards, resume revalidation, preserved failure state, and ignored stale async responses.

A credential-free real app-server subprocess test exercises v4 search and bidirectional history. A real TTY smoke test exercises `/threads`, `/search`, search preview, navigation, Escape, and shutdown. Acceptance requires formatting, full typechecking, every offline unit and integration test, and all six existing deterministic reliability scenarios to pass.

Implementation verification completed with 232/232 offline tests, 6/6 deterministic reliability scenarios, and a real TTY smoke covering thread listing, search input/results, authoritative match preview, highlighted context, layered Escape navigation, and graceful shutdown. The shipped boundary remains within the deferred destinations below.

## 9. Deferred destinations

- FTS5 tokenization, relevance ranking, fuzzy matching, query operators, and live/debounced search: **a later measured search slice**.
- Cross-workspace or global search: **a later workspace-management slice**.
- Alternate-screen/full-screen rendering, a complex focus system, and unbounded client history: **not part of Phase 3E2; reconsider only with a dedicated terminal UX design**.
- Real-time event subscriptions and background result refresh: **Phase 4 transport/reconnect work or a separately designed local subscription slice**.
- Dedicated provider/model settings and intentional runtime selection changes: **Phase 3E3 runtime settings**.
- Markdown and syntax rendering, diff and artifact viewers, artifact range/download APIs, attachments, context-budget inspection, and instruction-change views: **later Phase 3E slices or Phase 4 rich presentation**.
- Remote transports, authentication, shared app-server processes, and multi-client broadcasting: **Phase 4 hardening and distribution**.
