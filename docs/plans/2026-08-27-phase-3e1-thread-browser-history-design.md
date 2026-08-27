# Koda Phase 3E1: Thread Browser and History Restore

- Status: Approved for implementation (2026-08-27)
- Date: 2026-08-27
- Depends on: Phase 3D Ink chat REPL and Phase 3C durable multi-provider thread metadata
- Scope: browse recent threads in the current workspace, inspect bounded durable history, and resume a selected thread without weakening runtime ownership, recovery, or approval guarantees

## 1. Outcome

Phase 3E1 turns the Phase 3D chat REPL from a single-session client into a small durable-session browser. An idle user can open the recent-thread list, inspect a selected thread's latest durable events, resume it with its persisted provider and model, or detach from the current thread so the next prompt creates a new one.

The app-server gains a typed, paginated `thread/events` read API. Its result contains validated durable events rather than terminal-formatted rows or raw JSONL text. The TUI remains responsible for projecting those events into bounded history rows. JSONL remains the authoritative event history; SQLite remains a metadata index and is not promoted into a second transcript store.

This slice deliberately stops before full-text search, older-page navigation in the TUI, a full-screen alternate-buffer interface, runtime settings, rich Markdown, and artifact viewers. The protocol pagination boundary is added now so those later client features can grow without replacing the history API.

## 2. Alternatives and decision

Three history boundaries were considered:

1. **Typed paginated durable events through app-server — selected.** This preserves the existing client boundary, lets every future client build its own presentation, and keeps event validation and storage knowledge on the server side.
2. **Return preformatted transcript rows from app-server — rejected.** It would couple the protocol to the Ink UI and make IDE or desktop clients inherit terminal-specific presentation decisions.
3. **Let the TUI read thread JSONL directly — rejected.** It would bypass protocol versioning, canonical workspace checks, storage validation, error normalization, and the application service boundary established in Phase 3A.

For terminal interaction, Phase 3E1 keeps the normal terminal screen buffer. Opening the browser changes the bounded live region but does not enter an alternate screen or pretend to remove rows already emitted into native scrollback.

## 3. Protocol v3 and application boundary

Phase 3E1 replaces the pre-release app-server protocol v2 with v3. Koda does not maintain parallel v2 and v3 handlers. `initialize` requires v3 and advertises `threadEvents: true` in its capabilities, allowing typed clients to establish the history boundary before enabling browsing.

The new JSON-RPC method is `thread/events`:

```ts
type ThreadEventsParams = {
  threadId: string;
  beforeSequence?: number;
  limit?: number;
};

type ThreadEventsResult = {
  events: DurableThreadEvent[];
  hasEarlier: boolean;
  nextBeforeSequence?: number;
};
```

`beforeSequence` is an exclusive cursor. When omitted, the server reads the latest page. `limit` is an integer from 1 through 200 and defaults to 200. The server chooses up to the newest `limit` events whose sequence is lower than the cursor, then returns them in chronological ascending order. When an earlier page exists, `nextBeforeSequence` is the first returned event's sequence and can be sent unchanged as the next exclusive cursor.

`@koda/app` exposes a transport-neutral `KodaApplication.readThreadEvents` use case. The app-server validates request and result schemas, delegates to this use case, and maps stable application failures into JSON-RPC errors. `@koda/app-server-client-node` adds a typed `readThreadEvents()` operation and validates both success and error responses before exposing them to the TUI.

## 4. Authoritative read and resource bounds

History is read from the thread's authoritative JSONL event log and each record is validated as a durable event. SQLite metadata may identify and summarize a thread, but its projections never become the source of event history. A missing log, malformed JSON line, invalid durable event, duplicate or non-monotonic sequence, or invalid cursor produces a stable explicit error; the reader never silently skips corruption.

Each response is bounded by both event count and serialized size:

- at most 200 durable events;
- a target result budget of 768 KiB, leaving headroom under the Node client's 1 MiB NDJSON logical-line limit;
- no string or event is truncated to fit the history page.

The reader evaluates a stable snapshot of the log for one request. If adding the next event would exceed the byte budget, it returns the events already selected, reports that earlier history remains, and supplies the next exclusive cursor. If a single durable event cannot fit in an otherwise empty response, the request fails with an explicit oversized-event error. This avoids ambiguous partial records and keeps protocol framing safe.

Exclusive sequence cursors remain stable if the selected thread appends new events between page requests: a later append cannot move the boundary for an older page. Phase 3E1 does not subscribe to background changes in threads that are merely being browsed.

## 5. Workspace and provider semantics

`thread/list` is reused with a canonical-workspace filter. The browser requests at most the 100 most recently updated threads, sorted newest first. It shows every provider and model represented in that workspace rather than filtering to the TUI's current startup provider.

Selecting a thread does not migrate it between providers. On successful resume, the TUI adopts the selected thread's persisted provider and model. `/new` detaches the current thread ID but retains the currently selected provider and model, so the next ordinary prompt creates a new thread with that selection.

The browser cannot cross the current canonical workspace. Metadata returned by list and preview is treated as advisory; immediately before committing a resume, the TUI calls `thread/get` again and verifies that the thread still exists, is not `invalid`, and still belongs to the same canonical workspace. It then refreshes provider, model, status, and other displayed metadata from that response.

The runtime remains authoritative for leases, recovery, provider compatibility, and whether a later turn can actually resume. The TUI does not infer that a selectable metadata row guarantees write ownership.

## 6. TUI modes and interaction

The controller gains three explicit modes:

- `chat`: the Phase 3D conversation and prompt;
- `thread_list`: the bounded recent-thread selector;
- `thread_preview`: metadata plus projected recent history for one selected thread.

While the client is idle, `/threads` or `Ctrl+T` opens the list. Up and down move the selection. Each row exposes bounded updated-time, status, provider, model, turn-count, and token metadata. Enter requests the latest history page and opens its preview. Escape returns from preview to the list, or from the list to chat.

Pressing `r` in preview attempts resume. After the mandatory `thread/get` recheck succeeds, the controller:

1. adopts the refreshed thread ID, provider, and model;
2. clears the editable input;
3. returns to chat mode;
4. emits a visible `resumed thread` divider;
5. appends the projected recent history;
6. uses that thread ID for the next prompt.

The preview itself is non-mutating: moving selection or opening history does not replace the current chat thread. `/new` emits a visible divider and clears only the current thread ID. It never deletes JSONL, SQLite metadata, artifacts, or terminal output.

Thread browsing and switching are disabled while a turn, cancellation, or approval is active. Historical approval requests are never shown as actionable approvals, and historical process or tool records can never trigger execution or cancellation.

## 7. History projection

The first preview requests the latest 200 durable events. The TUI projects at most 100 display rows and bounds each rendered row to 8 KiB after terminal-safe sanitization.

Projection is driven primarily by durable `item.recorded` events. It renders:

- user and completed assistant conversation items;
- compact tool-result summaries;
- recovery and context-compaction summaries;
- final terminal usage or completion information;
- failure, cancellation, and uncertain-side-effect summaries when they affect the durable outcome.

`assistant.delta` events are ignored during replay because their completed assistant item is already durable and rendering both would duplicate content. Intermediate approval, process, and tool lifecycle states are omitted unless they ended in failure, cancellation, or an uncertain side-effect state that the user must see.

If more than 100 projected rows are available, the preview retains the newest bounded rows and clearly indicates that older display history was omitted. Protocol-level pagination is complete in this slice, but a TUI command for fetching older pages is deferred to Phase 3E2.

## 8. Consistency, errors, and security

Browsing is read-only and errors preserve the user's active conversation:

- a list failure leaves the client in chat mode;
- a preview failure leaves it in list mode;
- a resume recheck failure leaves it in preview mode;
- no browsing failure clears or changes the current thread ID, provider, model, transcript, or input.

An `invalid` thread is visible for diagnosis but cannot be resumed. Other metadata states may be attempted; the server's lease, recovery, and durable state checks remain the final authority. A workspace mismatch is a hard client-visible rejection even if stale list data previously displayed the thread.

Protocol strings, metadata, errors, and event-derived rows are bounded and sanitized before Ink rendering. Browsing never reveals raw credentials, provider request bodies, environment variables, or unvalidated JSONL text. Disconnecting the owned app-server closes browser state and enters the existing client error path; it cannot approve a pending action or imply that a turn completed.

## 9. Testing and acceptance criteria

All tests remain offline and require no model credentials.

Protocol and application tests cover:

- protocol v3 initialization, `threadEvents: true`, and rejection of v2;
- strict `thread/events` parameter and result schemas;
- default latest page, exclusive cursors, chronological page output, and limit validation;
- the 200-event cap and approximately 768 KiB result budget;
- missing logs, malformed JSONL, invalid event sequences, and an oversized single event;
- authoritative JSONL reads without a SQLite transcript dependency;
- stable pagination when new events append between page requests.

Node client tests cover `readThreadEvents()` request construction, result validation, RPC errors, timeouts, and disconnect on an oversized response.

TUI controller tests cover `/threads`, `Ctrl+T`, selection movement, preview, escape navigation, durable-item projection, delta de-duplication, invalid-thread blocking, metadata recheck before resume, provider/model adoption, workspace mismatch, `/new`, failure-state preservation, and the idle-only switching rule. Ink tests verify list, selected state, preview, error messages, and shortcut routing. A real credential-free app-server subprocess test verifies v3 initialization, thread listing, event pagination, and shutdown.

The implementation is accepted when:

1. an idle TTY user can browse and preview recent threads in the canonical workspace;
2. resuming adopts refreshed durable metadata and the next prompt continues the selected thread;
3. history rendering is bounded, de-duplicated, and cannot replay approvals or effects;
4. malformed or oversized history fails explicitly without mutating the active chat;
5. the TUI communicates only through app-server protocol v3;
6. formatting, typechecking, all offline tests, the six reliability scenarios, and a real TTY smoke test pass.

## 10. Deferred destinations

- Fetching older pages from the TUI, infinite scrolling, and full-text history search: **Phase 3E2 history navigation and search**.
- Alternate-screen/full-screen navigation, custom viewport scrolling, and a more complex focus system: **Phase 3E2 interactive navigation**.
- A dedicated provider/model settings panel and intentional runtime selection changes: **Phase 3E3 runtime settings**.
- Markdown layout, syntax highlighting, diff and artifact viewers, artifact range/download UI, attachments, context-budget inspection, and instruction-change views: **later Phase 3E slices or Phase 4 rich presentation**.
- Remote transports, authentication, reconnect/resubscribe, and shared app-server processes: **Phase 4 transport and distribution**.
