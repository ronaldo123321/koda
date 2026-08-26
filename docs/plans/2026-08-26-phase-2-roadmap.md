# Koda Phase 2 Reliability Roadmap

- Status: In progress — Phase 2A and 2B complete; Phase 2C next
- Date: 2026-08-26
- Depends on: Phase 1D repository context and token accounting

## Diagnosis

Koda now has a useful OpenAI coding loop, but each CLI process still behaves as a disposable session. JSONL events are durable, yet the application cannot continue their sequence, reconstruct a model transcript, or distinguish a cleanly completed turn from a crash during a side effect. Large outputs are truncated in place, context grows without a budget, and thread listings require scanning files.

The reliability phase must make the append-only log operationally useful before introducing another mutable index or more product surfaces.

## Guiding policies

1. Local normalized events remain the source of truth; provider response IDs are optimization state.
2. Recovery never automatically repeats a side effect whose completion is uncertain.
3. Every slice remains offline-testable and backward-compatible with existing version-1 logs where safe.
4. Derived stores such as SQLite can be rebuilt from JSONL.
5. Use the existing TypeScript and Node standard kit until an OS sandbox is the actual bottleneck.

## Delivery slices

### Phase 2A: durable resume and safe recovery

Status: Complete (2026-08-26)

- Continue global event sequence numbers across turns.
- Reconstruct normalized transcript history from JSONL.
- Add `koda run --resume <thread-id>`.
- Persist and validate workspace/model/instruction context snapshots.
- Emit typed recovery notices for completed, failed, cancelled, or interrupted prior turns.
- Mark unfinished tool calls uncertain and never replay them automatically.
- Replay normalized history into a fresh OpenAI response chain.
- Serialize writers with a local thread lease.

### Phase 2B: artifacts and output budgets

Status: Complete (2026-08-26)

- Store oversized tool output as content-addressed artifacts.
- Keep bounded prompt-facing excerpts with byte counts and hashes.
- Add artifact cleanup and missing-artifact diagnostics.
- Apply budgets consistently to read, search, command, and provider output.

### Phase 2C: context budgets and compaction

Status: Next

- Build a provider-neutral ContextEngine.
- Use measured usage plus conservative estimates for preflight budgets.
- Emit structured compaction items without deleting original events.
- Add nested repository-instruction scoping and resume snapshot validation.

### Phase 2D: process reliability

Status: Planned

- Harden cross-platform process-tree ownership and termination.
- Record termination attempts and uncertain process outcomes.
- Add recovery records for incomplete writes and commands.

### Phase 2E: SQLite metadata index

Status: Planned

- Materialize thread status, timestamps, model, workspace, usage, and log offsets.
- Rebuild the index entirely from JSONL.
- Add thread list/show commands without making SQLite authoritative.

### Phase 2F: scenario evaluations

Status: Planned

- Add binary end-to-end assertions for recovery, compaction, prompt injection, cancellation, output artifacts, and uncertain side effects.
- Publish deterministic fixtures and regression commands.

## Phase 2 exit criterion

A multi-turn thread can survive process restart, preserve context within budget, avoid repeating uncertain side effects, expose bounded artifact-backed output, terminate owned processes, rebuild query metadata, and pass the scenario suite without live credentials.
