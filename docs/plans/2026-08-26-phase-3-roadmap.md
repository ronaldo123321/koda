# Koda Phase 3 Extensibility Roadmap

- Status: In progress — Phase 3A through Phase 3E3 implemented and verified (2026-08-27)
- Date: 2026-08-26
- Depends on: Phase 2 reliability closure
- Scope: stable client/tool/provider extension boundaries without weakening the local runtime's durable state and approval guarantees

## Sequencing principles

Phase 3 extends Koda around the durable single-agent runtime instead of adding parallel implementations of it. Every client uses the shared application service, every external tool remains behind runtime policy and approval, and JSONL remains authoritative over projections and process-local registries.

The labels after Phase 3B are planning destinations rather than a promise to implement every item in that exact order. Each slice receives its own accepted design before code changes begin.

## Phase 3A: local stdio app-server

Status: **Complete.**

- Extract `@koda/app` as the transport-neutral composition and use-case layer shared by the CLI and app-server.
- Add a versioned, strict, newline-delimited JSON-RPC 2.0 protocol.
- Support initialization, start/resume, cancellation, interactive approval, credential-free thread queries, and graceful shutdown.
- Notify clients only after each typed event is durably appended.
- Bound input, serialize protocol output, keep stdout protocol-only, and clean up active turns on shutdown or EOF.
- Preserve different-thread concurrency and existing same-thread writer leases.

The detailed contract and deferred boundaries are in the [Phase 3A app-server design](2026-08-26-phase-3a-stdio-app-server-design.md).

## Phase 3B: MCP client and external tool lifecycle

Status: **Complete.**

- Discover and configure local stdio MCP servers without importing MCP concepts into `agent-core`. **Completed with `@koda/mcp-client-node`.**
- Translate MCP tools into the existing validated tool registry and preserve effect classification, approval, cancellation, and output budgets. **Completed with fail-closed execute defaults and explicit reviewed read overrides.**
- Define server start, initialization, frozen discovery, timeout, disconnect, cancellation, and reverse-order shutdown behavior. **Completed with one isolated session per turn.**
- Persist enough tool identity and lifecycle evidence for safe resume without automatically replaying uncertain external effects. **Completed through stable aliases and the existing durable execution boundary.**
- Keep credentials in server-side configuration; do not pass secrets through model-visible arguments or the app-server protocol. **Completed with environment-name allowlists and no raw wire persistence.**

The detailed contract, security model, verification matrix, and deferred boundaries are in the [Phase 3B MCP client design](2026-08-26-phase-3b-mcp-client-design.md). MCP HTTP/OAuth, remote hosting, shared sessions or tenants, and network sandbox policy remain Phase 4 concerns. Resources, prompts, subscriptions, sampling, elicitation, and dynamic tool refresh remain later measured Phase 3 capability slices.

## Phase 3C: explicit multi-provider runtime

Status: **Complete.**

- Add explicit selection across OpenAI, Anthropic, DeepSeek, Kimi, and GLM through a named provider registry. **Completed with provider-specific credentials, defaults, and fixed reviewed endpoints.**
- Keep OpenAI on Responses, add an Anthropic Messages adapter, and share reviewed Chat Completions mechanics across separate DeepSeek, Kimi, and GLM profiles. **Completed with official Anthropic and OpenAI SDKs.**
- Preserve required thinking and reasoning continuity in bounded, provider-tagged durable state without storing raw vendor responses. **Completed with a 256 KiB hard limit and atomic tool-step compaction.**
- Normalize tool calls, usage, stop reasons, cancellation, and errors behind the existing model-provider boundary. **Completed with stable `PROVIDER_*` failures.**
- Move the strict local app-server contract to protocol v2 with provider selection and discovery metadata. **Completed without a parallel pre-release v1 stack.**
- Add offline provider conformance scenarios covering tools, usage, cancellation, compaction, recovery, and state corruption. **Completed within the 198-test offline suite and existing 6-scenario reliability gate.**

The complete contract, configuration table, recovery rules, verification matrix, and deferred boundaries are in the [Phase 3C multi-provider design](2026-08-26-phase-3c-multi-provider-design.md).

## Phase 3D: Ink chat REPL

Status: **Complete.**

- Add a local interactive Ink client that starts and owns one stdio app-server child process. **Completed with the `koda-chat` entry point and root `pnpm chat` script.**
- Introduce a reusable Node app-server client for NDJSON framing, JSON-RPC request correlation, typed notifications, bounded diagnostics, timeouts, and graceful child cleanup. **Completed with `@koda/app-server-client-node`.**
- Route all TUI turns, approvals, cancellation, thread operations, and shutdown through app-server protocol v2 instead of importing `@koda/app` directly. **Completed with no TUI dependency on `@koda/app`.**
- Render completed transcript entries through Ink static output and keep the active response, tool state, approval card, status, and prompt in a bounded live region. **Completed in the normal terminal screen buffer.**
- Support startup provider/model/workspace/resume configuration, sequential multi-turn chat, one-shot interactive approvals, token usage, visible errors, `/help`, `/status`, `/clear`, `/exit`, `Esc` cancellation, and context-sensitive `Ctrl+C`. **Completed with provider/model fixed for one TUI process.**
- Keep approval fail-closed on cancellation, malformed protocol, child failure, or client loss. **Completed with strict protocol disconnect and approval-state cleanup.**
- Verify the protocol client, controller state machine, focused Ink rendering, real app-server initialization/shutdown, and all existing reliability gates without live provider credentials. **Completed with 214/214 offline tests, 6/6 reliability scenarios, and a real TTY startup/status/shutdown smoke test.**

The complete component boundary, interaction contract, failure semantics, verification matrix, and deferred destinations are in the [Phase 3D Ink chat REPL design](2026-08-26-phase-3d-ink-chat-repl-design.md).

## Phase 3E1: thread browser and history restore

Status: **Complete.**

- Upgrade the local app-server contract to protocol v3 and add typed, bounded, cursor-paginated `thread/events` reads over authoritative JSONL history. **Completed with exclusive sequence cursors, a 200-event cap, and a 768 KiB result budget.**
- Add idle-only recent-thread browsing and preview modes to the Ink client while preserving the normal terminal screen buffer. **Completed with `/threads`, `Ctrl+T`, arrow selection, Enter preview, and Escape navigation.**
- Resume a selected thread only after refreshing its metadata and verifying canonical workspace and non-invalid status. **Completed with a mandatory `thread/get` recheck.**
- Adopt the resumed thread's persisted provider/model; let `/new` detach locally without deleting durable data. **Completed without cross-provider migration or storage deletion.**
- Project recent durable conversation items into bounded terminal rows without replaying deltas, historical approvals, processes, or tool effects. **Completed with 100 rows and 8 KiB per UTF-8 row.**
- Preserve the active chat on every list, preview, or resume failure and keep runtime leases/recovery authoritative. **Completed with explicit controller failure-state coverage.**
- Verify the v3 protocol, application history reader, Node client, controller, Ink rendering, subprocess path, and reliability gates without live credentials. **Completed with 225/225 offline tests, 6/6 reliability scenarios, and a real TTY browser/new/shutdown smoke test.**

The complete API contract, interaction model, consistency rules, verification matrix, and deferred boundaries are in the [Phase 3E1 thread browser and history restore design](2026-08-27-phase-3e1-thread-browser-history-design.md).

## Phase 3E2: history search and windowed navigation

Status: **Complete.**

- Upgrade the local app-server contract to protocol v4 with bidirectional `thread/events` cursors and workspace-scoped `thread/search`. **Completed without a parallel pre-release v3 handler.**
- Add a rebuildable SQLite schema v2 search projection for bounded substring matching across display-worthy durable history; JSONL remains authoritative. **Completed with revision-bound pagination, Chinese/English/short-term consistency, AND terms, and stale-row removal.**
- Add explicit search input and result modes, match-centered preview, highlighted hits, and layered Escape navigation to the Ink client. **Completed with `/search <query>` and `/` from the thread list.**
- Add bounded older/newer history loading with arrows, PageUp/PageDown, Home, and End while retaining the normal terminal screen buffer. **Completed with a resize-aware 5–30 row viewport.**
- Bound raw events, projected rows, search results, query size, snippets, response sizes, and async request concurrency. **Completed with 400 events, 200 rows, 500 matches, generation-based stale-response rejection, and protocol byte budgets.**
- Revalidate authoritative metadata and JSONL before preview or resume; never replay historical approvals, tools, or processes. **Completed with `thread/get` plus before/after JSONL reads for every search hit.**
- Verify protocol v4, index rebuild/search semantics, client paging, TUI navigation, subprocess integration, TTY behavior, and all existing reliability gates. **Completed with 232/232 offline tests, 6/6 scenarios, and a real TTY list/search/preview/navigation/shutdown smoke test.**

The accepted API contract, index rules, navigation model, verification matrix, and deferred boundaries are in the [Phase 3E2 history search and windowed navigation design](2026-08-27-phase-3e2-history-search-navigation-design.md).

## Phase 3E3: workspace runtime settings

Status: **Complete.**

- Upgrade the local app-server contract to protocol v5 with shared, workspace-scoped `settings/get` and revision-checked `settings/update` operations. **Completed without a parallel pre-release v4 handler.**
- Expose only credential availability through runtime provider metadata; never transport or persist API-key values. **Completed with per-provider `configured` booleans derived from non-empty named environment variables.**
- Persist provider/model preferences in bounded, versioned, atomically replaced per-workspace files outside disposable SQLite metadata. **Completed with canonical-workspace SHA-256 keys, monotonic revisions, per-workspace leases, atomic rename, and corruption quarantine.**
- Add explicit Ink provider and model modes through `/settings`, preserving the normal terminal buffer and rejecting unavailable providers. **Completed with editable bounded model IDs, explicit Apply, default reset/reload, and layered Escape.**
- Separate current-thread configuration from next-new-thread preference; existing and resumed threads keep their durable provider/model, while `/new` intentionally adopts the saved choice. **Completed with visible pending-next status and startup precedence across CLI, environment, preference, and registry default.**
- Verify storage concurrency/recovery, startup precedence, typed app-server/client paths, controller interaction, TTY behavior, and every existing reliability gate. **Completed with 247/247 offline tests, 6/6 scenarios, and a real TTY settings/apply/status/new/Escape/shutdown smoke test.**

The accepted persistence, protocol, interaction, consistency, and verification contract is in the [Phase 3E3 workspace runtime settings design](2026-08-27-phase-3e3-runtime-settings-design.md).

## Later Phase 3 slices

### Provider and context extensions after Phase 3C

- Add arbitrary base URLs and user-defined profiles only with an explicit network and credential trust design.
- Extend the registry to Qwen, Doubao, MiniMax, and other documented providers through the Phase 3C conformance suite.
- Design model discovery, capability negotiation, automatic routing, fallback, retries, and cross-provider migration as separate slices.
- Evaluate provider-assisted semantic compaction and exact tokenizers against the deterministic Phase 2 baseline before adopting either dependency.
- Add exact pricing and budget forecasting only after token accounting is verified per provider.

### Interactive clients and client APIs

- Maintain the completed Phase 3D Ink chat REPL on the Phase 3A application protocol.
- Maintain the completed Phase 3E1 semantics for recent-thread selection, bounded history preview, and safe resume; protocol v5 supersedes its pre-release v3 transport.
- Maintain the completed Phase 3E2 boundary as bounded bidirectional history navigation and workspace-scoped substring search over app-server protocol v5; retain the normal terminal buffer and a disposable SQLite projection.
- Maintain the completed Phase 3E3 boundary for explicit provider/model preferences that affect only new threads.
- Defer FTS5, fuzzy/relevance ranking, live search, cross-workspace search, alternate-screen navigation, and real-time subscriptions beyond Phase 3E2.
- In Phase 3E or Phase 4, add Markdown/syntax rendering, diff and artifact viewers, range/download APIs, attachments, context-budget inspection, and instruction-change views.
- Build IDE or desktop clients only after the local protocol client and TUI have validated the shared boundary.
- Keep presentation state outside the agent runtime and keep approvals fail-closed on client loss.

### Richer local workflows

- Design richer or native patch support, multi-file transactions, moves, deletion, and explicit rollback evidence.
- Add PTYs and managed background-process UX without weakening process ownership and termination records.
- Add approval caching or trusted command-prefix UX only with inspectable scope, expiry, and revocation.
- Evaluate automatic commits as an explicit product workflow, not an implicit consequence of file edits.

## Explicitly outside Phase 3

- HTTP/WebSocket remote access, authentication, reconnect/resubscribe, multi-client broadcasting, shared app-server processes, shared artifact stores, strong OS sandboxing, Windows Job Objects, crash-surviving process supervision, signed releases, a Rust executor, and any retained shell-string execution: **Phase 4 hardening and distribution**.
- PTY-backed foreground/background workflow panes and managed process UX: **Phase 4 process UX and hardening**.
- Child agents, parent/child thread lineage, mailboxes, wait/interrupt, worktree isolation, curated project memory, and multi-agent scenario matrices: **Phase 5 multi-agent and memory**.

## Phase 3 exit criterion

Phase 3 is complete when multiple model providers and interactive local clients can use one durable application workflow; external tools have explicit lifecycle, policy, approval, cancellation, and recovery semantics; richer local workflows remain auditable; and the full offline regression and provider-conformance gates pass. Phase 3 does not claim remote multi-user security or multi-agent orchestration.
