# Koda Phase 3I: Client Interaction and Observability Closure

- Status: Approved; implementation in progress
- Date: 2026-08-28
- Depends on: Phase 3D Ink chat, Phase 3E history inspection, Phase 3F durable tool evidence, and Phase 3H extension closure
- Scope: compact Tool activity presentation, an authoritative activity inspector, and bounded streaming refresh without changing runtime execution or approval semantics

## 1. Outcome

Phase 3I closes the local Ink client after real-provider end-to-end testing exposed two presentation problems. A Turn with many successful read-only calls leaves one permanent row per call, obscuring the assistant answer. A long streamed answer is correct but causes Ink to redraw the complete growing response for every small delta, producing terminal output far larger than the final answer.

The client will show a compact aggregate plus current and recent Tool activity while a Turn runs. When the Turn finishes, successful read-only calls collapse into one deterministic summary grouped by Tool name. Approvals, writes, command execution, external calls, failures, rejections, rollback, uncertain termination, and other safety-relevant outcomes remain individually visible. `/activity` provides a paginated view of the complete durable activity trace with event sequence and type, so compact presentation never removes auditability.

Assistant deltas continue to accumulate exactly in controller state, but subscriber notifications for adjacent deltas are coalesced into a short bounded frame interval. Tool, approval, failure, completion, disconnect, input, and navigation updates flush immediately. The final assistant text remains complete and is never subject to the generic 8 KiB preview limit.

Phase 3I is a client projection and scheduling change. JSONL remains authoritative. It does not alter Tool policy, effect classification, approval capability, runtime concurrency, process execution, app-server protocol v12, or provider adapters.

## 2. Alternatives and decision

Three approaches were considered:

1. **Client projection over existing durable events — selected.** Extend the TUI controller with Tool effect and prominence metadata, deterministic compact projectors, a `/activity` view backed by existing `thread/events`, and delta-only notification coalescing. This fixes the observed behavior without introducing another storage or protocol authority.
2. **Change runtime events to emit pre-aggregated activity — rejected.** Aggregation is presentation-specific and would make the agent runtime decide what a particular client should hide. It would also duplicate facts already available from typed events.
3. **Replace Ink or move to an alternate-screen renderer — deferred.** A custom terminal renderer could optimize incremental text more deeply, but it would expand scope into scrolling, wrapping, copy behavior, and terminal compatibility before the current architecture has been measured with simple batching.

## 3. Tool activity projection

`TuiToolState` records the durable Tool effect once `tool.execution_started` arrives and records whether safety-relevant lifecycle evidence has occurred. A Tool is collapsible only when all of the following are true:

- execution effect is exactly `read`;
- final status is exactly `success`;
- it did not request or consume approval;
- it did not emit process, workspace mutation, rollback, uncertainty, or external-plugin/MCP evidence.

Unknown effect, incomplete calls, policy rejection, control calls, writes, execution, external calls, errors, and acceptance workflows fail toward visibility rather than collapse.

During a Turn, the live region contains:

- one grouped count for completed collapsible read calls;
- every currently nonterminal call;
- a bounded newest-first window of recently completed calls;
- an omission count when older ordinary live rows are hidden.

At completion, `activeTranscriptEntries` emits the complete assistant response first, one grouped read summary when applicable, then every non-collapsible Tool row in call order, notes, and usage. The grouped summary uses stable name ordering and explicit counts, for example `5 read-only tool calls succeeded (list_files ×1, read_file ×4).`

The history preview keeps its existing conversation-focused projection. It is not an audit surface and does not replay lifecycle events.

## 4. Durable activity inspector

The idle-only `/activity` command opens a new `activity_view` for the current Thread. It uses the existing protocol-v12 `thread/events` operation and therefore requires neither credentials nor a new app-server method. The latest event page opens first; PageUp/PageDown load earlier or later pages, Home/End jump to boundaries, arrows scroll the current projected rows, and Escape returns to chat.

The inspector projects every activity-relevant durable event rather than reconstructing state from completed transcript rows. Rows include sequence, event type, bounded identity/status detail, and Tool call ID where present. Relevant events include Tool start/execution/completion, approval and grant events, process lifecycle, workspace transaction lifecycle, artifact publication, Plan acceptance, Turn terminal outcomes, and recovery evidence. Assistant deltas and ordinary message Items are omitted because `/activity` is an execution trace, not a duplicate transcript viewer.

Pages stay chronological and contiguous according to the existing strict response schema. Navigation uses the controller's generation guard, so late results cannot overwrite a newer mode. Corrupt logs, missing Threads, response-budget failures, and client disconnect remain visible errors and never produce a partial page presented as complete.

This view is complete by pagination, not by loading an unbounded Thread into memory. Compact chat output and activity rows are separate projections over the same authoritative events.

## 5. Streaming refresh scheduler

`assistant.delta` updates the in-memory snapshot immediately but schedules subscriber notification at most once per short frame interval. Multiple deltas inside the interval become one React/Ink update. The scheduler is injectable in tests and owns at most one pending callback.

Any non-delta event flushes a pending delta notification before publishing its own state. Turn completion, cancellation, failure, approval, disconnect, shutdown, and controller disposal also cancel or flush pending work explicitly. This prevents a final fragment from being stranded and preserves event ordering at the UI boundary.

The initial interval is intentionally conservative and fixed; Phase 3I does not add a user-facing performance setting. Acceptance is based on notification count and final content, not terminal timing. A burst regression test proves that many adjacent deltas yield far fewer subscriber notifications while `getSnapshot()` and the completed transcript contain the exact concatenated answer.

If batching is insufficient for very large answers, a future client renderer may commit completed lines or adopt a dedicated terminal diff engine. That decision requires measurements after Phase 3I and is not hidden in this scope.

## 6. Failure and security invariants

- Collapsing is presentation-only; no durable event is deleted, rewritten, or skipped by storage.
- Unknown or malformed lifecycle state remains visible and cannot be classified as a safe read summary.
- Approval, write, execute, external, failed, rejected, rolled-back, and uncertain operations remain individually visible in completed chat output.
- `/activity` grants no new authority and cannot resolve approvals, rerun Tools, or read arbitrary files.
- Streaming batching never delays safety-relevant state changes and never truncates the final assistant response.
- Terminal rows retain existing control-character sanitization and byte bounds.

## 7. Implementation slices

### Phase 3I1: compact Tool activity

- Extend Tool view state with effect and prominence evidence.
- Add deterministic live and completed projectors.
- Render aggregate plus current/recent Tool rows.
- Cover safe collapse and every fail-visible category.

### Phase 3I2: activity inspector

- Add `activity_view` state, `/activity`, pagination, scrolling, and rendering.
- Project authoritative activity events with stable bounded labels.
- Cover stale responses, corrupt/missing history, and boundary navigation.

### Phase 3I3: streaming refresh performance

- Add delta-only subscriber notification coalescing.
- Flush immediately for semantic events and terminal lifecycle.
- Add deterministic burst, completion, disconnect, and disposal tests.
- Repeat the offline suite and a real-TTY fixture gate.

## 8. Acceptance criteria

Phase 3I is complete when:

1. a read-heavy Turn no longer leaves one permanent Tool row per successful read;
2. every safety-relevant Tool outcome remains individually visible;
3. `/activity` can page across the complete durable execution trace without provider credentials;
4. a burst of assistant deltas produces bounded render notifications while retaining exact final text;
5. protocol v12 and runtime semantics remain unchanged;
6. formatting, typecheck, all offline tests, reliability scenarios, and the real-TTY gate pass.

## 9. Deferred destinations

- Rich Markdown, syntax highlighting, diff panes, binary artifact views, attachments, and alternate-screen navigation remain later client-product work.
- PTY/background process panes, crash-surviving supervision, Windows Job Objects, and the Rust executor remain Phase 4 runtime hardening.
- OS sandboxing, network policy, Secret isolation, remote transport/authentication, shared storage, plugin distribution, and signed releases remain Phase 4.
- Child-agent activity, lineage, mailbox, and delegated-plan views remain Phase 5.

