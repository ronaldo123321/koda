# Koda

Koda is a local-first coding-agent runtime, CLI, and interactive terminal client under active development.

The project is building the control plane around a coding model: typed conversation state, deterministic model/tool loops, runtime-validated tools, append-only events, cancellation, recovery, and explicit security boundaries.

## Current status

Phase 3E4 is implemented. It adds thread-authorized artifact discovery and bounded UTF-8 inspection to the Phase 3E3 runtime-settings and durable-history client, on top of the Phase 3C five-provider runtime, Phase 3B local MCP client, Phase 3A transport-neutral application layer, and the completed Phase 0 through Phase 2 runtime:

- Versioned Thread, Turn, Item, and Agent Event schemas.
- A provider-neutral streaming model interface.
- A runtime-validated tool registry.
- A model -> tool -> model agent loop.
- An OpenAI Responses adapter, an Anthropic Messages adapter, and reviewed DeepSeek, Kimi, and GLM Chat Completions profiles.
- Explicit provider selection, provider-specific credentials and defaults, normalized usage/errors, and offline adapter conformance tests.
- Bounded durable provider continuation state for signed Anthropic thinking blocks and domestic-provider `reasoning_content` across tool rounds, compaction, and recovery.
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
- A rebuildable SQLite schema v2 projection for thread metadata plus bounded display-worthy history search; JSONL remains authoritative.
- Credential-free `koda thread list` and `koda thread show` commands with canonical workspace filtering.
- WAL-backed concurrent metadata writers, source fingerprint refresh, invalid-log visibility, and corrupt-database quarantine.
- Best-effort post-run indexing that never makes the derived database authoritative over JSONL.
- Reference-aware artifact garbage collection derived only from valid JSONL logs, with a global maintenance lease and fail-closed concurrency checks.
- Credential-free `koda artifact gc` dry runs and explicit `--delete` collection with a configurable minimum age.
- Six deterministic binary scenarios for resume, compaction, prompt injection, process-tree cancellation, artifact retrieval, and uncertain side-effect recovery.
- A shared `KodaApplication` workflow used by both CLI and protocol clients.
- A strict, versioned, newline-delimited JSON-RPC 2.0 app-server over local stdio.
- Durable-before-notify event streaming, one-shot interactive approvals, active-turn cancellation, and graceful shutdown/EOF cleanup.
- Credential-free app-server thread list/get/search operations, bounded bidirectional JSONL event history, and different-thread concurrency guarded by existing per-thread leases.
- A reusable Node app-server client with strict NDJSON framing, typed JSON-RPC correlation, bounded stderr diagnostics, request timeouts, and owned child-process cleanup.
- An Ink `koda-chat` REPL that uses app-server v6 exclusively for sequential chat, approvals, thread browsing, durable search, windowed history navigation, runtime settings, artifact inspection, and resume.
- Typed bidirectional `thread/events` pages over authoritative JSONL with exclusive sequence cursors, a 200-event cap, a 768 KiB result budget, and explicit corruption/oversize errors.
- Revision-paginated `thread/search` over normalized SQLite substring projections, with 256-byte queries, eight-term AND semantics, 512-byte snippets, and an approximately 256 KiB result budget.
- Idle-only `/threads`, `Ctrl+T`, and `/search <query>` interaction across the current canonical workspace, match-centered authoritative preview, metadata recheck before resume, and persisted provider/model adoption.
- Bounded 400-event/200-row preview windows, 500 cached search results, terminal-resize-aware 5–30 row viewports, PageUp/PageDown/Home/End navigation, and stale-response generations.
- Workspace-scoped provider/model preferences with revision-checked atomic persistence, corruption quarantine, credential-availability metadata, and no API-key transport or storage.
- Idle-only `/settings` provider selection and editable model IDs, with explicit Apply, layered Escape, startup precedence, and separate current-thread versus next-new-thread configuration.
- Thread-scoped `thread/artifacts` discovery and `artifact/read` ranges authorized by canonical workspace plus authoritative JSONL references, with ArtifactStore size, SHA-256, regular-file, and UTF-8 verification.
- Idle-only `/artifacts`, `/artifact <id>`, and preview `a` navigation with newest-first deduplication, 16 KiB bidirectional byte pages, terminal-aware wrapping, stale-response rejection, and layered Escape.
- Static completed transcript output plus one bounded live region, normal terminal scrollback, `/help`, `/status`, `/clear`, `/new`, `/exit`, `Esc` cancellation/navigation, and context-sensitive `Ctrl+C`.
- Official MCP v2 client integration for explicitly configured local stdio servers, with one isolated session per turn.
- Frozen, validated MCP tool catalogs exposed as stable `mcp__<server>__<tool>` aliases without importing MCP into `agent-core`.
- Fail-closed MCP effects: external tools require approval by default, and only explicitly reviewed `read` tools bypass approval.
- MCP call timeouts, turn cancellation, reverse-order child cleanup, bounded binary/result normalization, artifact-backed large output, and conservative interrupted-call recovery.
- Offline provider, runtime, CLI, and deterministic agent-loop tests.

Provider-assisted semantic compaction, exact provider tokenizers and pricing, custom endpoints/profiles, live model discovery, automatic routing/fallback, cross-provider resume, additional providers, FTS5/fuzzy/live or cross-workspace search, alternate-screen navigation, rich Markdown/syntax/diff rendering, binary artifact views and export, richer patch operations, interactive process UX, and the non-Tool MCP capability surface remain later Phase 3 slices. Remote MCP/HTTP/OAuth, shared or remote artifact stores, remote app-server transports, strong sandboxing, Windows Job Objects, crash-surviving supervision, the Rust executor, and any high-risk shell-string support remain Phase 4 work. Parent/child thread lineage and multi-agent scenario matrices remain Phase 5 work. Workspace writes, process execution, and MCP tools not explicitly classified as read require approval by default.

## Run the CLI

Build Koda, provide the credential for one built-in provider, and run one task against a workspace. OpenAI remains the default:

```bash
pnpm build
export OPENAI_API_KEY=...
node apps/cli/dist/main.js run "explain this repository" --cwd .
```

Select another provider with `--provider` or `KODA_PROVIDER`:

```bash
export ANTHROPIC_API_KEY=...
node apps/cli/dist/main.js run "explain this repository" --cwd . --provider anthropic

export DEEPSEEK_API_KEY=...
node apps/cli/dist/main.js run "explain this repository" --cwd . --provider deepseek
```

| Provider    | Credential          | Default model     |
| ----------- | ------------------- | ----------------- |
| `openai`    | `OPENAI_API_KEY`    | `gpt-5.6-terra`   |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-5` |
| `deepseek`  | `DEEPSEEK_API_KEY`  | `deepseek-v4-pro` |
| `kimi`      | `MOONSHOT_API_KEY`  | `kimi-k2.6`       |
| `glm`       | `ZAI_API_KEY`       | `glm-5.2`         |

Only the selected provider's credential is required. `--model` or `KODA_MODEL` overrides that provider's default. Resume a thread with the same provider; Koda rejects cross-provider resume before issuing a model request.

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

## Run interactive chat

Build Koda, export the selected provider credential, and start the Ink client in an interactive terminal:

```bash
pnpm build
export OPENAI_API_KEY=...
pnpm chat --cwd . --provider openai
```

The installed binary is `koda-chat`; the built workspace entry can also be run directly:

```bash
node apps/tui/dist/main.js --cwd . --provider deepseek --model deepseek-v4-pro
node apps/tui/dist/main.js --cwd . --provider openai --resume <thread-id>
```

Workspace and approval mode are fixed at startup. Provider/model startup precedence is CLI argument, environment variable, matching workspace preference, then registry default. `/settings` opens the configured-provider list and model editor; Apply persists the choice for the canonical workspace without storing credentials. Existing or resumed threads keep their durable provider/model, while `/new` adopts the saved next-thread choice. Ordinary input starts a turn. `/threads` or `Ctrl+T` opens the latest 100 threads in the current canonical workspace. Press `/` there to search, or run `/search <query>` from chat. Search uses case-normalized substring AND terms across durable display-worthy history; Enter opens authoritative history and marks the hit. `/artifacts` lists UTF-8 text/JSON artifacts referenced by the current thread, `/artifact <sha256:...>` opens a known referenced ID, and `a` opens artifacts from a thread preview without resuming it. `/context` lists prepared model requests for the current thread; `c` opens the same inspector from a thread preview. The context detail shows exact or legacy budget telemetry, measured Usage, active Item identity, Compaction, and current repository-instruction status. Enter opens a bounded current instruction source. Artifact and instruction PageUp/PageDown request adjacent verified UTF-8 byte ranges; Home/End reaches content boundaries. Arrows move one row, `r` resumes a thread preview, and `Esc` returns one layer. `/new` detaches locally without deleting history. `/help`, `/status`, `/clear`, and `/exit` retain their existing behavior. Press `y` or `n` for a pending approval, `d` to toggle details, and `Esc` to cancel an active turn. `Ctrl+C` cancels while a turn is active and exits while idle. The client requires a TTY; scripts should continue to use `koda run` or the stdio app-server.

Workspace preferences are stored under `${KODA_HOME:-$HOME/.koda}/settings/workspaces/` as bounded, versioned files keyed by the canonical workspace hash. API-key values stay only in the app-server environment; the protocol exposes only whether each named credential is configured.

## Run the local app-server

Build Koda, place provider credentials in the server environment, and launch the stdio transport:

```bash
pnpm build
OPENAI_API_KEY=... node apps/app-server/dist/main.js
```

The process accepts one JSON-RPC 2.0 object per UTF-8 line. `initialize` must be the first request:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":7,"client":{"name":"my-koda-client","version":"0.1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"turn/start","params":{"prompt":"explain this repository","cwd":".","provider":"openai"}}
{"jsonrpc":"2.0","id":3,"method":"thread/events","params":{"threadId":"<thread-id>","limit":200}}
{"jsonrpc":"2.0","id":4,"method":"thread/search","params":{"workspace":".","query":"parser failure","limit":50}}
{"jsonrpc":"2.0","id":5,"method":"settings/get","params":{"workspace":"."}}
{"jsonrpc":"2.0","id":6,"method":"settings/update","params":{"workspace":".","provider":"deepseek","model":"deepseek-v4-pro","expectedRevision":0}}
{"jsonrpc":"2.0","id":7,"method":"thread/artifacts","params":{"workspace":".","threadId":"<thread-id>","limit":100}}
{"jsonrpc":"2.0","id":8,"method":"artifact/read","params":{"workspace":".","threadId":"<thread-id>","artifactId":"sha256:<64-lowercase-hex>","maxBytes":16384}}
{"jsonrpc":"2.0","id":9,"method":"thread/context","params":{"workspace":".","threadId":"<thread-id>","limit":100}}
{"jsonrpc":"2.0","id":10,"method":"context/read","params":{"workspace":".","threadId":"<thread-id>","anchorSequence":42}}
{"jsonrpc":"2.0","id":11,"method":"context/instruction/read","params":{"workspace":".","threadId":"<thread-id>","anchorSequence":42,"sourceId":"ctxsrc:<64-lowercase-hex>","maxBytes":16384}}
```

The v7 initialize result advertises `threadEvents`, `bidirectionalThreadEvents`, `threadSearch`, `runtimeSettings`, `artifactInspection`, and `contextInspection` plus the supported providers, credential environment-variable names, default models, and runtime-only availability booleans. `thread/events` returns validated events chronologically; mutually exclusive `beforeSequence` and `afterSequence` are exclusive cursors and `limit` is 1–200. `thread/search` is restricted to the canonical workspace and returns revision-bound cursor pages. `settings/get` returns the canonical workspace preference and revision; `settings/update` requires that revision so concurrent writers cannot silently overwrite one another. `thread/artifacts` lists newest unique references only after canonical-workspace and strict-JSONL authorization. `artifact/read` additionally requires that exact thread reference and returns a bounded, integrity-verified UTF-8 range with mutually exclusive `beforeByte`/`afterByte` cursors. Before each production Provider request, Koda writes `context.prepared` after any Compaction Item. `thread/context` discovers these durable snapshots newest first and projects old logs from `model.usage` without inventing missing estimates. `context/read` reconstructs precise active Items from authoritative JSONL and rejects digest mismatches. `context/instruction/read` accepts only an opaque source ID issued for that authorized request and returns bounded current content; it is not a general workspace file reader. Responses and `turn/event` / `turn/finished` notifications use stdout exclusively; diagnostics use stderr. Clients answer an `approval.requested` event with `approval/resolve`, may stop a live turn with `turn/cancel`, and should finish with `shutdown`. Provider credentials are server configuration and are never protocol fields.

## Configure local MCP tools

Create `${KODA_HOME:-$HOME/.koda}/mcp.json` to start local stdio MCP servers for each turn. An absent default file disables MCP. `KODA_MCP_CONFIG` may select another file relative to the process directory or by absolute path.

```json
{
  "version": 1,
  "servers": {
    "github": {
      "command": "node",
      "args": ["/absolute/path/to/github-mcp-server.js"],
      "cwd": "/absolute/path/to/optional/server-directory",
      "env": ["GITHUB_TOKEN"],
      "startup_timeout_ms": 15000,
      "call_timeout_ms": 60000,
      "tools": {
        "list_repositories": { "effect": "read" }
      }
    }
  }
}
```

`command` and `args` are passed directly without a shell. `env` contains parent environment variable names, never secret values; each child receives only a small runtime baseline plus those allowlisted names. Missing variables, relative or nonexistent `cwd` values, malformed schemas, oversized catalogs, and stale read classifications fail the turn before the model sees a partial catalog.

Every discovered tool defaults to effect `execute`. Under the default `on-request` mode it needs one approval per call; under `never` it is denied. Add `{ "effect": "read" }` only after reviewing that exact server tool. MCP annotations are treated as untrusted hints and cannot weaken this policy. Phase 3B supports MCP Tools over local stdio only; HTTP/OAuth, resources, prompts, sampling, elicitation, dynamic catalog refresh, and cross-turn shared sessions are intentionally deferred.

Preview old unreferenced artifacts without provider credentials, then delete them only after reviewing the report:

```bash
node apps/cli/dist/main.js artifact gc
node apps/cli/dist/main.js artifact gc --delete --min-age-hours 24
```

GC derives reachability from every valid JSONL event rather than SQLite. It refuses to delete anything while a thread is active or when a log is partial, corrupt, unsafe, or unreadable. The default minimum age is 24 hours; dry-run is always the default.

Resume reads and validates the local JSONL log, rebuilds provider-neutral history, and projects it through the thread's selected provider. A legacy log without a context snapshot, a provider or workspace mismatch, a busy thread, or an invalid log fails closed. If the prior process stopped during a tool call, Koda reports the durable effect and process evidence it has and does not execute the call again automatically. It never sends a signal using only a PID recovered from an earlier process because operating systems can reuse PIDs.

Oversized tool text keeps a bounded head/tail excerpt in the transcript and stores the complete captured bytes under `KODA_HOME/artifacts/sha256`. Artifact references are content-addressed and deduplicated. The model can call `read_artifact` with an ID, byte offset, and range size; the TUI can inspect only text artifacts authorized by the current or previewed thread's JSONL. Missing or corrupt blobs are reported explicitly rather than repaired silently. Koda removes stale temporary captures automatically and reclaims published blobs only through explicit reference-aware garbage collection.

Before every model request, Koda budgets base instructions, scoped repository guidance, tool schemas, and the active transcript. The defaults are a 128,000-token context window, a 16,384-token output reserve, and an 8,192-token safety margin. Override the first two with `KODA_CONTEXT_WINDOW_TOKENS` and `KODA_MAX_OUTPUT_TOKENS`. When history no longer fits, Koda appends a structured compaction record to JSONL, preserves the newest coherent suffix, and rebuilds the same model-facing view after restart without deleting original events.

The provider defaults to `openai`; select it with `--provider <provider>` or `KODA_PROVIDER`. The model defaults to the selected provider's registry entry and can be overridden with `--model <model>` or `KODA_MODEL`. Runtime event logs are written under `~/.koda/threads` by default; set `KODA_HOME` to move them.

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
- `@koda/providers`: OpenAI Responses, Anthropic Messages, named OpenAI-compatible profiles, normalized provider errors, and deterministic scripted providers.
- `@koda/runtime-node`: JSONL, artifact, and rebuildable SQLite metadata persistence plus constrained workspace, patch, and process tools.
- `@koda/mcp-client-node`: strict local MCP configuration, official stdio client lifecycle, tool adaptation, policy metadata, and bounded result conversion.
- `@koda/app`: transport-neutral turn orchestration and credential-free thread metadata/history use cases.
- `@koda/cli`: line-oriented command parsing, terminal approval, and console projection over `@koda/app`.
- `@koda/app-server`: local stdio JSON-RPC transport, active-turn coordination, and interactive approval routing.
- `@koda/app-server-client-node`: typed local JSON-RPC client, NDJSON framing, request lifecycle, diagnostics, and owned app-server process cleanup.
- `@koda/tui`: React/Ink controller, static transcript and live-region rendering, keyboard interaction, and `koda-chat` entry point.
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
- [Phase 3B local MCP client design](docs/plans/2026-08-26-phase-3b-mcp-client-design.md)
- [Phase 3C multi-provider runtime design](docs/plans/2026-08-26-phase-3c-multi-provider-design.md)
- [Phase 3D Ink chat REPL design](docs/plans/2026-08-26-phase-3d-ink-chat-repl-design.md)
- [Phase 3E1 thread browser and history restore design](docs/plans/2026-08-27-phase-3e1-thread-browser-history-design.md)
- [Phase 3E2 history search and windowed navigation design](docs/plans/2026-08-27-phase-3e2-history-search-navigation-design.md)
- [Phase 3E3 workspace runtime settings design](docs/plans/2026-08-27-phase-3e3-runtime-settings-design.md)
- [Phase 3E4 thread-scoped artifact inspection design](docs/plans/2026-08-27-phase-3e4-artifact-inspection-design.md)

The model can propose actions, but the Koda runtime owns validation, policy, approval, and execution. User interfaces consume typed events and do not own agent state.
