# Koda Phase 1D: Repository Instructions and Token Accounting

- Status: Accepted for implementation
- Date: 2026-08-26
- Depends on: Phase 1C approval-gated structured commands
- Scope: bounded root instruction files, provider-neutral usage records, turn aggregation, and an explicit Phase 1 roadmap closeout

## 1. Outcome

Phase 1D closes the prerequisites for Phase 2 reliability. Koda will load inspectable repository guidance before creating the model provider and will preserve provider-reported token usage in the typed event log. This gives future resume and compaction work two stable inputs: the instruction sources used for a run and measured context consumption.

The implementation remains OpenAI-first and line-oriented. Anthropic and Ink do not block reliability work and are explicitly moved from Phase 1 to Phase 3. This is a roadmap correction, not an implicit deletion of scope.

## 2. Alternatives and decisions

Instruction discovery considered three approaches:

1. **Workspace-root files, selected.** Load only `AGENTS.md` and `KODA.md` from the canonical workspace root. It is deterministic and never expands filesystem authority.
2. **Git-root-to-cwd hierarchy.** This resembles mature coding agents but may expand above `--cwd`, and Koda does not yet have a contextual instruction engine for nested tool targets.
3. **Recursive discovery.** Loading every instruction file is ambiguous, expensive, and vulnerable to unrelated nested files influencing the whole turn.

Token accounting considered provider values, local tokenization, and hybrid estimates. Phase 1D records only values reported by the provider. Local estimates would add model-specific tokenizers and could be mistaken for billable usage. Missing provider usage remains explicit through request and reported-request counts.

## 3. Repository instruction contract

The loader checks the canonical workspace root for exact filenames in this order:

1. `AGENTS.md` for ecosystem-compatible repository guidance.
2. `KODA.md` for Koda-specific repository guidance.

Both files are included when present. `KODA.md` is later in the model instructions and resolves repository-workflow conflicts, but neither file may override runtime policy, approval, workspace boundaries, or higher-priority product instructions.

Each source must be a regular, non-symlinked UTF-8 text file without null bytes. Each file is limited to 64 KiB and their combined bytes are limited to 128 KiB. Missing files are normal. An unreadable, invalid, binary, symlinked, or oversized source fails before the provider is created instead of being silently ignored.

The loader returns source path, byte count, SHA-256 digest, and content. Prompt rendering includes explicit source boundaries and hashes in deterministic order. Phase 2 will persist and validate instruction snapshots during resume and add nested directory scoping; Phase 1D does not infer a Git root or inspect paths above `--cwd`.

## 4. Provider-neutral usage model

Every completed model response may carry normalized usage:

```ts
interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}
```

All fields are non-negative integers. Cached and cache-write tokens are subsets or annotations of input usage; reasoning tokens are a subset of output usage. Koda preserves the provider's total rather than recomputing it.

OpenAI maps `response.completed.response.usage` into this contract. Providers that omit usage still complete normally. No SDK-specific usage object crosses `@koda/providers`.

## 5. Events and aggregation

When a completed model step reports usage, AgentLoop appends `model.usage` with the step number, optional response ID, and normalized values. It also maintains a turn summary:

```ts
interface TurnUsage {
  modelRequests: number;
  reportedRequests: number;
  tokens: TokenUsage;
}
```

`modelRequests` counts attempted model steps; `reportedRequests` counts steps with provider usage. Their difference prevents zero tokens from being confused with missing measurement. Terminal turn events include the summary for completed, failed, and cancelled turns. New fields remain optional in the version-1 read schema so existing JSONL logs remain readable, while new AgentLoop writes always include them.

Thread usage is derived by summing terminal turn summaries in the append-only thread log. Phase 2's SQLite index will materialize that derived value for listings and queries. Phase 1D does not introduce a second mutable counter store.

## 6. CLI behavior

The CLI loads instructions after opening the workspace and before creating the provider. The stable base instructions remain first. Repository text is appended under a warning that it cannot alter runtime authorization.

On turn completion, the console prints one concise diagnostic such as:

```text
[koda] tokens: 1200 input (800 cached), 300 output (100 reasoning), 1500 total; 2/2 requests reported
```

Token data remains in JSONL even when terminal output is redirected. Koda does not calculate currency cost because pricing is provider-, model-, tier-, and date-dependent.

## 7. Errors and security

Repository instruction failures use stable `RepositoryInstructionError` codes for invalid type, invalid encoding, oversize content, and read failure. Error messages identify the workspace-relative source but never print its content.

Instruction content is intentionally supplied as model guidance, but the runtime continues to enforce policies outside the prompt. File contents are not copied into approval previews or diagnostic logs. SHA-256 hashes are metadata, not trust signatures.

Provider usage values are validated at the provider boundary. Invalid or negative values produce a provider protocol error rather than corrupting aggregate counters.

## 8. Testing and acceptance criteria

Offline tests cover deterministic dual-file ordering, missing files, invalid UTF-8, binary data, symlinks, file and total size limits, instruction prompt injection boundaries, OpenAI usage mapping, missing usage, per-step events, multi-step aggregation, and terminal display.

Phase 1D is complete when:

- Root `AGENTS.md` and `KODA.md` reach the provider in deterministic order.
- Instruction discovery cannot read above the canonical workspace root.
- Invalid instruction sources fail before a model request.
- OpenAI usage is normalized without leaking SDK types into core.
- JSONL records per-step usage and terminal turn summaries.
- Missing usage is distinguishable from zero usage.
- Existing version-1 JSONL events remain readable.
- The architecture and phase documents explicitly name the destination phase for every deferred item.
- `pnpm format:check`, `pnpm typecheck`, and `pnpm test` pass without credentials.

## 9. Deferred work and destinations

- Nested directory instruction scoping and resume snapshot validation: Phase 2.
- Context budgets and compaction: Phase 2.
- SQLite materialized thread totals and cost metadata: Phase 2.
- Anthropic provider: Phase 3.
- Ink terminal UI and long-lived chat REPL: Phase 3.
- Strong prompt provenance UX across IDE and desktop clients: Phase 3.
