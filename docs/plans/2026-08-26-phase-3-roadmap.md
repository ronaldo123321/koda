# Koda Phase 3 Extensibility Roadmap

- Status: In progress — Phase 3A and Phase 3B implemented; Phase 3C approved (2026-08-26)
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

Status: **Approved for implementation.**

- Add explicit selection across OpenAI, Anthropic, DeepSeek, Kimi, and GLM through a named provider registry.
- Keep OpenAI on Responses, add an Anthropic Messages adapter, and share reviewed Chat Completions mechanics across separate DeepSeek, Kimi, and GLM profiles.
- Preserve required thinking and reasoning continuity in bounded, provider-tagged durable state without storing raw vendor responses.
- Normalize tool calls, usage, stop reasons, cancellation, and errors behind the existing model-provider boundary.
- Move the strict local app-server contract to protocol v2 with provider selection and discovery metadata.
- Add offline provider conformance scenarios covering tools, usage, cancellation, compaction, recovery, and state corruption.

The complete contract, configuration table, recovery rules, verification matrix, and deferred boundaries are in the [Phase 3C multi-provider design](2026-08-26-phase-3c-multi-provider-design.md).

## Later Phase 3 slices

### Provider and context extensions after Phase 3C

- Add arbitrary base URLs and user-defined profiles only with an explicit network and credential trust design.
- Extend the registry to Qwen, Doubao, MiniMax, and other documented providers through the Phase 3C conformance suite.
- Design model discovery, capability negotiation, automatic routing, fallback, retries, and cross-provider migration as separate slices.
- Evaluate provider-assisted semantic compaction and exact tokenizers against the deterministic Phase 2 baseline before adopting either dependency.
- Add exact pricing and budget forecasting only after token accounting is verified per provider.

### Interactive clients and client APIs

- Build an Ink chat REPL, then IDE or desktop clients on the Phase 3A application protocol.
- Add artifact range/download, rich preview, attachments, context-budget inspection, and instruction-change views as versioned client APIs.
- Keep presentation state outside the agent runtime and keep approvals fail-closed on client loss.

### Richer local workflows

- Design richer or native patch support, multi-file transactions, moves, deletion, and explicit rollback evidence.
- Add PTYs and managed background-process UX without weakening process ownership and termination records.
- Add approval caching or trusted command-prefix UX only with inspectable scope, expiry, and revocation.
- Evaluate automatic commits as an explicit product workflow, not an implicit consequence of file edits.

## Explicitly outside Phase 3

- HTTP/WebSocket remote access, authentication, multi-client broadcasting, shared artifact stores, strong OS sandboxing, Windows Job Objects, crash-surviving process supervision, signed releases, a Rust executor, and any retained shell-string execution: **Phase 4 hardening and distribution**.
- Child agents, parent/child thread lineage, mailboxes, wait/interrupt, worktree isolation, curated project memory, and multi-agent scenario matrices: **Phase 5 multi-agent and memory**.

## Phase 3 exit criterion

Phase 3 is complete when multiple model providers and interactive local clients can use one durable application workflow; external tools have explicit lifecycle, policy, approval, cancellation, and recovery semantics; richer local workflows remain auditable; and the full offline regression and provider-conformance gates pass. Phase 3 does not claim remote multi-user security or multi-agent orchestration.
