# Koda Phase 2C: Context Budgets, Compaction, and Scoped Instructions

- Status: Accepted for implementation
- Date: 2026-08-26
- Depends on: Phase 2B artifacts and output budgets
- Scope: provider-neutral context preparation, measured token calibration, durable structured compaction, nested repository instructions, and resume provenance

## 1. Outcome

Phase 2C makes long-running threads bounded and reproducible. Before every model step, a provider-neutral `ContextEngine` estimates the complete request cost, including instructions, tool schemas, and transcript items. If the request exceeds its input budget, the engine creates a structured compaction item, retains a coherent recent suffix, and sends only the compacted view to the provider. Original JSONL events are never deleted.

Repository guidance expands from workspace-root files to bounded nested `AGENTS.md` and `KODA.md` sources. Each source carries a directory scope, broader scopes are applied before deeper scopes, and `KODA.md` follows `AGENTS.md` within one directory. Resume compares the previous snapshot with the newly discovered sources and records added, removed, or changed instructions in the recovery notice.

## 2. Alternatives and decisions

For compaction, three approaches were considered:

1. **Delete old transcript entries.** Small and simple, but destroys audit history and makes crash recovery unsafe.
2. **Build a temporary truncated prompt on each process.** Preserves JSONL but can choose a different context after restart and offers no durable explanation of what was omitted.
3. **Append a compaction item, selected.** Record a structured summary and the exact IDs retained in the model-facing suffix. A later process reconstructs the same view from normalized events.

For nested instructions, eagerly loading every bounded source is selected over implicit tool-time discovery. Tool-time discovery can reveal guidance only after a model has already proposed an action. Eager discovery makes the applicable scopes visible in the first request and lets the context budget account for them. Strict count, depth, per-file, and total-byte limits prevent unbounded instruction trees.

## 3. Budget model

Default limits are configurable without hard-coding a provider model table:

- context window: 128,000 tokens;
- reserved model output: 16,384 tokens;
- safety margin: 8,192 tokens;
- effective input budget: context window minus output reserve and safety margin.

`KODA_CONTEXT_WINDOW_TOKENS` and `KODA_MAX_OUTPUT_TOKENS` override the first two values. Invalid or impossible combinations fail configuration before provider creation. The OpenAI adapter receives the same maximum output value as `max_output_tokens`.

Without a tokenizer dependency, the engine estimates text conservatively as one token per three UTF-8 bytes plus per-item structural overhead. JSON tool definitions and structured items use stable serialization. When a provider reports actual input tokens, the engine observes the ratio between measured and estimated input and raises a high-water calibration multiplier for later steps. It never calibrates downward below the conservative baseline.

## 4. Durable compaction model

A new compaction item contains:

- a structured summary using the existing objective, decisions, modified files, completed work, pending work, failed attempts, and critical facts fields;
- `retainedItemIds`, the exact non-compaction items preserved after the summary;
- estimated input tokens before and after compaction;
- reason `context_budget`.

The item is appended after the items it summarizes because JSONL is append-only. Its retained IDs therefore cannot be inferred from physical event position. On every later step or resumed process, the engine finds the newest durable compaction, places it first, restores its retained items in original transcript order, and then includes items recorded after that compaction.

Tool call, approval, and result records form one retention group so compaction never sends an orphan `function_call_output`. The newest user message is mandatory. If fixed instructions, tool definitions, the newest user group, and a bounded summary still cannot fit, the turn fails before provider invocation with `CONTEXT_BUDGET_EXCEEDED`.

The first strategy is deterministic rather than model-generated: it extracts bounded assistant conclusions, patch paths, failed tool attempts, recovery facts, and the latest objective. This keeps compaction offline-testable and avoids a hidden extra model request. The strategy remains behind an interface so a provider-assisted summarizer can replace it later without changing transcript semantics.

## 5. Agent-loop data flow

Before each `ModelProvider.stream` call:

1. Build the active view from the newest durable compaction or the full transcript.
2. Estimate fixed instructions, tool schemas, and active items.
3. Return the active view unchanged when it fits.
4. Otherwise group items, select a recent suffix, create and record one compaction item, and return `[compaction, ...retained items]`.
5. Invoke the provider with the prepared items and the configured maximum output tokens.
6. Feed reported input usage back to the engine after completion.

Compaction items enter normal `item.recorded` events and OpenAI replay as developer summaries. The full `RunTurnResult.items` remains the durable transcript, not the reduced provider view.

## 6. Nested instruction discovery and precedence

Koda discovers `AGENTS.md` and `KODA.md` from the canonical workspace root downward while excluding `.git`, `.koda`, and `node_modules`, symlinked directories, and paths deeper than 20 levels. Limits are:

- at most 64 KiB per file;
- at most 32 instruction files;
- at most 256 KiB in total.

Every source records portable relative path, portable scope directory, byte count, SHA-256, and UTF-8 content. Ordering is scope depth, then lexical scope, then `AGENTS.md` before `KODA.md`. A source applies only to files inside its scope. Deeper scopes override broader guidance for their subtree; `KODA.md` resolves same-scope workflow conflicts after `AGENTS.md`. No repository instruction can override runtime policy, approvals, workspace confinement, or product instructions.

The full source list and hashes enter each `turn.context` snapshot. On resume, Koda compares old and current snapshots. Added, removed, and changed paths become structured `instructionChanges` on the recovery item and a visible developer/user notice. Resume proceeds using current instructions and records a new snapshot; this supports legitimate repository evolution without silently changing provenance.

## 7. Failure behavior

- Invalid budget configuration returns a CLI configuration error.
- A request that cannot fit after compaction returns `CONTEXT_BUDGET_EXCEEDED` without calling the provider.
- Invalid compaction metadata in a durable log returns `THREAD_LOG_INVALID` through normal schema or recovery validation.
- Too many, too deep, too large, binary, symlinked, or unreadable instruction sources fail before provider creation.
- Instruction changes do not execute anything and do not bypass approval; they are recorded before the new user item.
- Provider usage remains optional. Missing usage leaves the conservative estimator unchanged.

## 8. Testing and acceptance criteria

Offline tests cover:

- requests below budget remaining unchanged;
- deterministic compaction above budget;
- tool call/result grouping and newest-user retention;
- second-step and cross-process reconstruction from retained IDs;
- measured usage increasing later estimates;
- impossible budgets failing before provider invocation;
- OpenAI `max_output_tokens` mapping;
- nested discovery, precedence, exclusions, and size/count limits;
- instruction added/removed/changed recovery notices;
- unchanged Phase 2A resume and Phase 2B artifact references after compaction.

Phase 2C is complete when long threads remain inside a configured request budget, durable compaction reconstructs identically after restart, provider usage can tighten later estimates, nested instruction provenance is explicit, and every repository check passes without live credentials.

## 9. Deferred destinations

- Provider-assisted semantic compaction: a later Phase 2C refinement if deterministic summaries prove insufficient.
- Artifact reference indexing and compaction-aware garbage collection: Phase 2E.
- Interactive context-budget and instruction-change views: Phase 3.
- Provider-specific exact tokenizers: add only when measured estimation error justifies the dependency.
