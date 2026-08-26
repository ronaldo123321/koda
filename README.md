# Koda

Koda is a local-first coding-agent runtime and CLI under active development.

The project is building the control plane around a coding model: typed conversation state, deterministic model/tool loops, runtime-validated tools, append-only events, cancellation, recovery, and explicit security boundaries.

## Current status

Phase 3A is complete. It adds a transport-neutral application layer and a local stdio JSON-RPC app-server on top of the completed Phase 0 through Phase 2 runtime:

- Versioned Thread, Turn, Item, and Agent Event schemas.
- A provider-neutral streaming model interface.
- A runtime-validated tool registry.
- A model -> tool -> model agent loop.
- An OpenAI Responses API adapter with streamed text and function calls.
- Workspace-confined `list_files`, `read_file`, and literal `search_text` tools.
- A one-file `apply_patch` tool for exact UTF-8 creates and replacements.
- Runtime write policy, durable approval events, and terminal patch previews.
- SHA-256 snapshot checks and atomic same-directory writes.
- A structured `exec_command` tool that always uses `shell: false`.
- Workspace-confined command directories, filtered environments, bounded output, timeouts, and cancellation.
- Bounded nested `AGENTS.md` and `KODA.md` discovery with explicit directory scopes, stable broad-to-deep ordering, and hashes.
- Provider-neutral per-response token usage events and turn-level aggregation.
- A single-turn `koda run` command with JSONL event persistence.
- Cross-process `koda run --resume <thread-id>` using normalized local history replay.
- Per-turn context snapshots, globally contiguous event sequences, and typed recovery notices.
- Conservative recovery for unfinished tool calls: uncertain side effects are reported and never automatically retried.
- A local thread lease that prevents two live CLI processes from appending to the same log.
- Content-addressed SHA-256 artifacts for oversized read, search, and command output.
- Uniform 64 KiB model-facing excerpts with exact byte counts and retrievable full output.
- A bounded `read_artifact` tool, missing/corrupt artifact recovery diagnostics, and stale temporary-file cleanup.
- A 256 KiB per-model-step provider-output guard and 64 MiB per-stream artifact hard limit.
- A provider-neutral `ContextEngine` with configured input budgets, conservative token estimates, and measured-usage calibration.
- Append-only structured compaction with exact retained item IDs and atomic tool-call/result retention.
- Recovery validation for compaction metadata plus visible added/removed/changed repository-instruction notices.
- OpenAI response-chain reset after mid-turn compaction and a configured `max_output_tokens` reserve.
- A durable `tool.execution_started` boundary after policy and approval, immediately before handler execution.
- Typed process start, exit, termination-attempt, and termination-outcome events tied to the originating tool call.
- POSIX process-group ownership with graceful-to-force escalation, descendant cleanup, and bounded confirmation.
- Windows tree-aware `taskkill` handling with explicit direct-child fallback and honest uncertain outcomes.
- Structured interrupted-operation recovery that reports effect and process evidence without replaying a side effect or killing a historical PID.
- A rebuildable SQLite projection for thread status, timestamps, context, usage, event counts, and valid JSONL byte offsets.
- Credential-free `koda thread list` and `koda thread show` commands with canonical workspace filtering.
- WAL-backed concurrent metadata writers, source fingerprint refresh, invalid-log visibility, and corrupt-database quarantine.
- Best-effort post-run indexing that never makes the derived database authoritative over JSONL.
- Reference-aware artifact garbage collection derived only from valid JSONL logs, with a global maintenance lease and fail-closed concurrency checks.
- Credential-free `koda artifact gc` dry runs and explicit `--delete` collection with a configurable minimum age.
- Six deterministic binary scenarios for resume, compaction, prompt injection, process-tree cancellation, artifact retrieval, and uncertain side-effect recovery.
- A shared `KodaApplication` workflow used by both CLI and protocol clients.
- A strict, versioned, newline-delimited JSON-RPC 2.0 app-server over local stdio.
- Durable-before-notify event streaming, one-shot interactive approvals, active-turn cancellation, and graceful shutdown/EOF cleanup.
- Credential-free app-server thread list/get operations and different-thread concurrency guarded by existing per-thread leases.
- Offline provider, runtime, CLI, and deterministic agent-loop tests.

Phase 3B MCP client and external-tool lifecycle design is next. Provider-assisted semantic compaction, exact provider tokenizers, the Anthropic adapter, Ink UI, richer patch operations, artifact client APIs, and interactive process UX remain later Phase 3 slices. Shared or remote artifact stores, remote app-server transports, strong sandboxing, Windows Job Objects, crash-surviving supervision, the Rust executor, and any high-risk shell-string support remain Phase 4 work. Parent/child thread lineage and multi-agent scenario matrices remain Phase 5 work. Workspace writes and process execution require explicit approval by default.

## Run the CLI

Build Koda, provide an OpenAI API key, and run one task against a workspace:

```bash
pnpm build
export OPENAI_API_KEY=...
node apps/cli/dist/main.js run "explain this repository" --cwd .
```

Koda prints the generated thread ID at turn start. Continue it from a later CLI process with the same canonical workspace:

```bash
node apps/cli/dist/main.js run "continue with the next task" --cwd . --resume <thread-id>
```

Inspect local thread metadata without provider credentials:

```bash
node apps/cli/dist/main.js thread list --limit 20
node apps/cli/dist/main.js thread list --workspace .
node apps/cli/dist/main.js thread show <thread-id>
```

These commands refresh `KODA_HOME/state.db` from changed JSONL logs before querying. The database is a disposable projection: if it is deleted, Koda recreates it; if it is corrupt, Koda preserves a timestamped `.corrupt-*` copy and rebuilds current rows from JSONL.

## Run the local app-server

Build Koda, place provider credentials in the server environment, and launch the stdio transport:

```bash
pnpm build
OPENAI_API_KEY=... node apps/app-server/dist/main.js
```

The process accepts one JSON-RPC 2.0 object per UTF-8 line. `initialize` must be the first request:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"client":{"name":"my-koda-client","version":"0.1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"turn/start","params":{"prompt":"explain this repository","cwd":"."}}
```

Responses and `turn/event` / `turn/finished` notifications use stdout exclusively; diagnostics use stderr. Clients answer an `approval.requested` event with `approval/resolve`, may stop a live turn with `turn/cancel`, and should finish with `shutdown`. Provider credentials are server configuration and are never protocol fields.

Preview old unreferenced artifacts without provider credentials, then delete them only after reviewing the report:

```bash
node apps/cli/dist/main.js artifact gc
node apps/cli/dist/main.js artifact gc --delete --min-age-hours 24
```

GC derives reachability from every valid JSONL event rather than SQLite. It refuses to delete anything while a thread is active or when a log is partial, corrupt, unsafe, or unreadable. The default minimum age is 24 hours; dry-run is always the default.

Resume reads and validates the local JSONL log, rebuilds provider-neutral history, and starts a fresh OpenAI response chain. A legacy log without a context snapshot, a different workspace, a busy thread, or an invalid log fails closed. If the prior process stopped during a tool call, Koda reports the durable effect and process evidence it has and does not execute the call again automatically. It never sends a signal using only a PID recovered from an earlier process because operating systems can reuse PIDs.

Oversized tool text keeps a bounded head/tail excerpt in the transcript and stores the complete captured bytes under `KODA_HOME/artifacts/sha256`. Artifact references are content-addressed and deduplicated. The model can call `read_artifact` with an ID, byte offset, and range size; missing or corrupt blobs are reported explicitly when a thread resumes. Koda removes stale temporary captures automatically and reclaims published blobs only through explicit reference-aware garbage collection.

Before every model request, Koda budgets base instructions, scoped repository guidance, tool schemas, and the active transcript. The defaults are a 128,000-token context window, a 16,384-token output reserve, and an 8,192-token safety margin. Override the first two with `KODA_CONTEXT_WINDOW_TOKENS` and `KODA_MAX_OUTPUT_TOKENS`. When history no longer fits, Koda appends a structured compaction record to JSONL, preserves the newest coherent suffix, and rebuilds the same model-facing view after restart without deleting original events.

The model defaults to `gpt-5.6-terra`. Override it with `--model <model>` or `KODA_MODEL`. Runtime event logs are written under `~/.koda/threads` by default; set `KODA_HOME` to move them.

Koda discovers `AGENTS.md` and `KODA.md` from the workspace root downward, excluding `.git`, `.koda`, `node_modules`, symlinked directories, and paths deeper than 20 levels. It loads broader scopes before deeper scopes and `AGENTS.md` before `KODA.md` within one directory. Each source applies only to its subtree, must be a regular UTF-8 file no larger than 64 KiB, and cannot override runtime policy or approvals. Discovery is capped at 32 files and 256 KiB total. If these files change between turns, resume records the exact added, removed, or changed paths and uses the current versions.

When Koda proposes a patch or command, it prints the exact action and asks `Approve this action? [y/N]`. A command is represented as a JSON `argv` array, never reconstructed as shell syntax. Use `--approval-mode never` or `KODA_APPROVAL_MODE=never` to deny all writes and process execution without prompting.

Commands run without stdin, have a 30-second default timeout, and retain at most 64 KiB from each output stream. On POSIX, each command owns a process group; timeout, cancellation, output failure, or unsupported surviving descendants trigger `SIGTERM`, a grace period, and then `SIGKILL` when needed. Windows uses tree-aware `taskkill` with explicit uncertainty when termination cannot be confirmed. This TypeScript runtime provides guardrails, not a security sandbox: an approved executable or repository script still runs with the current user's operating-system permissions.

When the provider reports usage, Koda persists normalized input, cached, cache-write, output, reasoning, and total token counts and prints a turn summary. Missing provider usage is reported as unmeasured rather than treated as zero billable usage.

`ripgrep` (`rg`) must be available for the `search_text` tool. `list_files` and `read_file` continue to work without it.

## Development

Requirements:

- Node.js 22.20 or later; CI runs Node.js 24.
- pnpm 10.28.2.

```bash
pnpm install
pnpm format:check
pnpm typecheck
pnpm test
pnpm eval:scenarios
```

## Packages

- `@koda/protocol`: versioned runtime schemas and domain types.
- `@koda/agent-core`: agent loop, provider and tool ports, event ports.
- `@koda/providers`: OpenAI Responses and deterministic scripted providers.
- `@koda/runtime-node`: JSONL, artifact, and rebuildable SQLite metadata persistence plus constrained workspace, patch, and process tools.
- `@koda/app`: transport-neutral turn orchestration and credential-free thread use cases.
- `@koda/cli`: line-oriented command parsing, terminal approval, and console projection over `@koda/app`.
- `@koda/app-server`: local stdio JSON-RPC transport, active-turn coordination, and interactive approval routing.
- `@koda/testkit`: deterministic clocks, IDs, tools, in-memory event storage, and offline reliability scenarios.

## Architecture

- [Architecture design](docs/plans/2026-08-26-koda-agent-architecture-design.md)
- [Phase 0 implementation plan](docs/plans/2026-08-26-phase-0-implementation-plan.md)
- [Phase 1A OpenAI CLI design](docs/plans/2026-08-26-phase-1a-openai-cli-design.md)
- [Phase 1B safe patch design](docs/plans/2026-08-26-phase-1b-safe-patch-design.md)
- [Phase 1C safe exec design](docs/plans/2026-08-26-phase-1c-safe-exec-design.md)
- [Phase 1D context and accounting design](docs/plans/2026-08-26-phase-1d-context-accounting-design.md)
- [Phase 2 reliability roadmap](docs/plans/2026-08-26-phase-2-roadmap.md)
- [Phase 2A durable resume and recovery design](docs/plans/2026-08-26-phase-2a-resume-recovery-design.md)
- [Phase 2B artifacts and output budgets design](docs/plans/2026-08-26-phase-2b-artifacts-output-budgets-design.md)
- [Phase 2C context and compaction design](docs/plans/2026-08-26-phase-2c-context-compaction-design.md)
- [Phase 2D process reliability design](docs/plans/2026-08-26-phase-2d-process-reliability-design.md)
- [Phase 2E SQLite metadata design](docs/plans/2026-08-26-phase-2e-sqlite-metadata-design.md)
- [Phase 2F scenarios and artifact GC design](docs/plans/2026-08-26-phase-2f-scenarios-artifact-gc-design.md)
- [Phase 3 extensibility roadmap](docs/plans/2026-08-26-phase-3-roadmap.md)
- [Phase 3A local stdio app-server design](docs/plans/2026-08-26-phase-3a-stdio-app-server-design.md)

The model can propose actions, but the Koda runtime owns validation, policy, approval, and execution. User interfaces consume typed events and do not own agent state.
