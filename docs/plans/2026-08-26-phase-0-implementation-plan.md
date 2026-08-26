# Koda Phase 0 Implementation Plan

- Status: Ready
- Design: `2026-08-26-koda-agent-architecture-design.md`

## Objective

Build the smallest deterministic vertical slice of Koda's agent harness: a user message enters a turn, a scripted model requests a validated tool, the runtime executes it, the result returns to the model, and a final answer plus an ordered event history is produced.

## Work packages

### 1. Workspace foundation

- Configure pnpm workspaces, TypeScript strict mode, ESM, Vitest, and shared scripts.
- Add `protocol`, `agent-core`, `providers`, `runtime-node`, and `testkit` packages.
- Keep the CLI package out of Phase 0 except for a future placeholder in documentation.

### 2. Protocol

- Add branded identifier schemas.
- Add conversation item schemas.
- Add agent event schemas with schema version and sequence metadata.
- Export inferred TypeScript types from the runtime schemas.

### 3. Event persistence

- Define `EventSink` and `EventReader` ports.
- Implement deterministic in-memory storage for tests.
- Implement serialized JSONL append and recovery reader for the Node runtime.
- Reject invalid events before persistence.

### 4. Model and tool ports

- Define provider-neutral model requests and streamed events.
- Define tool specifications, registry, validation, execution context, and results.
- Implement an `echo` tool in testkit as the first deterministic tool.

### 5. Agent loop

- Start a turn and persist lifecycle events.
- Stream assistant text and collect tool calls.
- Validate and invoke registered tools.
- Add tool results to the next model request.
- Finish on a final model step with no calls.
- Handle cancellation and maximum-step exhaustion.

### 6. Test harness and acceptance

- Implement a scripted provider with asserted request checkpoints.
- Test model -> tool -> model behavior and exact event ordering.
- Test malformed arguments, unknown tools, cancellation, and step limits.
- Test JSONL append/read and partial trailing-line recovery.
- Run format checks, type checking, build, and tests.

## Deliberate-deferral disposition

These were excluded so Phase 0 could validate the hardest architectural seam—the deterministic orchestration loop—before adding product surface area. Their destinations are now explicit:

| Item                      | Disposition                                                       |
| ------------------------- | ----------------------------------------------------------------- |
| Real provider API calls   | OpenAI completed in Phase 1A; Anthropic is scheduled for Phase 3. |
| Ink UI                    | Phase 3; moved from the original Phase 1 roadmap.                 |
| Repository mutation tools | Completed in Phase 1B.                                            |
| Approval prompts          | Completed in Phase 1B and generalized in Phase 1C.                |
| Strong sandboxing         | Phase 4.                                                          |
| SQLite metadata           | Phase 2.                                                          |
| Context compaction        | Phase 2.                                                          |
| Multi-agent execution     | Phase 5.                                                          |
