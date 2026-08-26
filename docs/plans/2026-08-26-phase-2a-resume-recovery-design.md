# Koda Phase 2A: Durable Resume and Safe Recovery

- Status: Accepted for implementation
- Date: 2026-08-26
- Depends on: Phase 1D repository context and token accounting
- Scope: multi-turn JSONL continuity, transcript replay, recovery notices, thread leases, and `--resume`

## 1. Outcome

Phase 2A lets a user continue a Koda thread after the original CLI process exits:

```bash
koda run --resume <thread-id> "continue with the next task" --cwd .
```

The existing thread JSONL remains the source of truth. Koda reads and validates it, reconstructs normalized conversation history, appends a new turn with the next global sequence number, and sends history plus the new user message to a fresh provider session.

## 2. Alternatives and decision

Three recovery approaches were considered:

1. **Local transcript replay, selected.** Rebuild provider-neutral items and create a new OpenAI response chain. This survives provider-side expiry and keeps local state authoritative.
2. **Persist `previous_response_id`.** This is efficient but depends on server-side retention and couples recovery to OpenAI.
3. **Hybrid fallback.** Try the provider ID, then replay locally. This adds two recovery paths before the local path is proven.

Within an active turn, the OpenAI adapter still uses `previous_response_id` for efficient tool continuations. Across process restarts, Phase 2A always uses local replay.

## 3. Context snapshot

Every new turn records `turn.context` immediately after `turn.started`. Its payload contains provider, model, canonical workspace root, approval mode, full instruction SHA-256, and root repository-instruction paths, sizes, and hashes. It never contains API keys or instruction contents.

Resume requires the current canonical workspace root to match the latest recorded context. Model, approval mode, and instruction hashes may change; the new snapshot makes that change explicit. Stronger user-facing provenance choices are deferred to Phase 2C.

Legacy logs without `turn.context` are rejected for automatic resume because Koda cannot prove which workspace they belong to.

## 4. Recovery model

Recovery groups the ordered event log into turns and validates that turns do not overlap. It derives the previous turn status from its terminal event:

- `completed`: clean terminal state.
- `failed`: explicit failure.
- `cancelled`: explicit cancellation.
- `interrupted`: no terminal event, usually process loss.

Every resume records a typed `recovery` conversation item before the new user message. It identifies the prior turn and status and lists tool calls that started without a matching `tool.completed`. These calls are `uncertain`: Koda does not assume success or failure and never automatically executes them again.

Transcript replay includes user and assistant messages plus tool-call/result pairs whose results were durably recorded. Approval items remain in local history but are not sent as model messages. Unmatched tool calls are omitted from provider replay and represented only by the recovery notice.

## 5. Event continuity and writer ownership

`TurnEventRecorder` starts from `lastSequence + 1` on resume. New threads still start at zero. The event reader continues ignoring one partial trailing line with a diagnostic; recovery adds that fact to its notice.

Before reading or appending a thread, the CLI acquires a sibling lock file with exclusive creation. The lock contains process ID, creation time, and a random ownership token. A live owner causes `THREAD_BUSY`. A dead owner's lock may be replaced. Release removes the file only when its token still matches, preventing one process from deleting another process's lease.

This is a local single-host lease, not a distributed lock.

## 6. OpenAI history replay

The first request of a resumed turn maps normalized items as follows:

- user message -> `user` message.
- assistant message -> `assistant` message.
- completed tool call -> `function_call`.
- tool result -> `function_call_output`.
- recovery notice -> `developer` message.
- compaction item -> `developer` summary when Phase 2C begins.
- approval item -> omitted from provider input.

After the first resumed response, the existing per-turn `previous_response_id` behavior resumes. SDK objects and response IDs do not enter the core transcript.

## 7. CLI and errors

`--resume` accepts only bounded filesystem-safe thread IDs. It cannot contain slashes, dots, whitespace, or traversal syntax. A resumed thread keeps its original thread ID and receives a new turn ID.

Stable recovery errors include:

- `THREAD_NOT_FOUND`: no durable events exist.
- `THREAD_BUSY`: another live Koda process owns the thread.
- `THREAD_ID_MISMATCH`: events do not belong to the requested thread.
- `THREAD_CONTEXT_MISSING`: legacy or incomplete context metadata.
- `THREAD_WORKSPACE_MISMATCH`: current `--cwd` differs from the recorded workspace.
- `THREAD_LOG_INVALID`: turn ordering or tool-pair invariants are corrupt.

The CLI prints the thread ID at turn start so users can resume it later.

## 8. Testing and acceptance criteria

Offline tests cover completed-turn resume, full OpenAI replay mapping, global sequence continuation, interrupted-turn recovery, uncertain tool calls, failed and cancelled turns, partial trailing lines, context mismatch, unsafe IDs, missing threads, live locks, stale locks, and rejected automatic retries.

Phase 2A is complete when:

- A second CLI process can append a new turn to an existing thread.
- The resumed first model request contains durable normalized history exactly once.
- Sequence numbers remain contiguous across turns.
- An unfinished side effect is labeled uncertain and is not replayed as a tool request.
- Workspace mismatch and missing context fail before provider creation.
- Concurrent local writers cannot append to the same thread.
- Existing single-turn behavior remains unchanged.
- `pnpm format:check`, `pnpm typecheck`, and `pnpm test` pass without credentials.

## 9. Deferred destinations

- Persisted output artifacts: Phase 2B.
- Context compaction and nested instruction scoping: Phase 2C.
- Robust cross-platform process recovery: Phase 2D.
- Thread listing and materialized metadata: Phase 2E.
- Full recovery scenario suite: Phase 2F.
