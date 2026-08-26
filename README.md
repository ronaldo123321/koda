# Koda

Koda is a local-first coding-agent runtime and CLI under active development.

The project is building the control plane around a coding model: typed conversation state, deterministic model/tool loops, runtime-validated tools, append-only events, cancellation, recovery, and explicit security boundaries.

## Current status

Phase 1D closes the OpenAI-first usable local-agent milestone and prepares the event model for Phase 2 reliability:

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
- Bounded workspace-root `AGENTS.md` and `KODA.md` instruction loading with stable ordering and hashes.
- Provider-neutral per-response token usage events and turn-level aggregation.
- A single-turn `koda run` command with JSONL event persistence.
- Offline provider, runtime, CLI, and deterministic agent-loop tests.

Nested instruction scoping, resume, compaction, artifacts, SQLite metadata, and scenario evaluations are scheduled for Phase 2. The Anthropic adapter, Ink UI, richer patch operations, and interactive process UX were explicitly moved from Phase 1 to Phase 3. Strong sandboxing, the Rust executor, and any high-risk shell-string support remain Phase 4 work. Workspace writes and process execution require explicit approval by default.

## Run the CLI

Build Koda, provide an OpenAI API key, and run one task against a workspace:

```bash
pnpm build
export OPENAI_API_KEY=...
node apps/cli/dist/main.js run "explain this repository" --cwd .
```

The model defaults to `gpt-5.6-terra`. Override it with `--model <model>` or `KODA_MODEL`. Runtime event logs are written under `~/.koda/threads` by default; set `KODA_HOME` to move them.

If the workspace root contains `AGENTS.md` or `KODA.md`, Koda loads both in that order before the first model request. Each must be a regular UTF-8 file no larger than 64 KiB. Root instruction files provide project guidance but cannot override runtime policy or approvals.

When Koda proposes a patch or command, it prints the exact action and asks `Approve this action? [y/N]`. A command is represented as a JSON `argv` array, never reconstructed as shell syntax. Use `--approval-mode never` or `KODA_APPROVAL_MODE=never` to deny all writes and process execution without prompting.

Commands run without stdin, have a 30-second default timeout, and retain at most 64 KiB from each output stream. This TypeScript runtime provides guardrails, not a security sandbox: an approved executable or repository script still runs with the current user's operating-system permissions.

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
```

## Packages

- `@koda/protocol`: versioned runtime schemas and domain types.
- `@koda/agent-core`: agent loop, provider and tool ports, event ports.
- `@koda/providers`: OpenAI Responses and deterministic scripted providers.
- `@koda/runtime-node`: JSONL persistence plus constrained workspace, patch, and process tools.
- `@koda/cli`: single-turn CLI composition root, approval input, and console projection.
- `@koda/testkit`: deterministic clocks, IDs, tools, and in-memory event storage.

## Architecture

- [Architecture design](docs/plans/2026-08-26-koda-agent-architecture-design.md)
- [Phase 0 implementation plan](docs/plans/2026-08-26-phase-0-implementation-plan.md)
- [Phase 1A OpenAI CLI design](docs/plans/2026-08-26-phase-1a-openai-cli-design.md)
- [Phase 1B safe patch design](docs/plans/2026-08-26-phase-1b-safe-patch-design.md)
- [Phase 1C safe exec design](docs/plans/2026-08-26-phase-1c-safe-exec-design.md)
- [Phase 1D context and accounting design](docs/plans/2026-08-26-phase-1d-context-accounting-design.md)

The model can propose actions, but the Koda runtime owns validation, policy, approval, and execution. User interfaces consume typed events and do not own agent state.
