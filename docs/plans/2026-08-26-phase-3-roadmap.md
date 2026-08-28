# Koda Phase 3 Extensibility Roadmap

- Status: In progress — Phase 3A through Phase 3F3 and Phase 3G1 complete; Phase 3G2 next; Phase 3H queued (2026-08-28)
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

## Phase 3E4: thread-scoped artifact inspection

Status: **Complete.**

- Upgrade the local app-server contract to protocol v6 with `thread/artifacts` discovery and thread-authorized `artifact/read` byte ranges. **Completed without a parallel pre-release v5 handler.**
- Keep JSONL authoritative for workspace and reference authorization; keep ArtifactStore authoritative for regular-file, size, SHA-256, and UTF-8 integrity. **Completed with canonical-workspace checks, strict log validation, one-handle verified reads, and fail-closed stable errors.**
- Add `/artifacts`, `/artifact <id>`, preview-origin discovery, bounded list navigation, and a bidirectional text viewer to the Ink client. **Completed with 100-reference pages and 16 KiB UTF-8 ranges.**
- Preserve the normal terminal buffer, generation-based stale-response rejection, layered Escape, source views on failure, and strict response budgets. **Completed across list, direct-view, preview-view, paging, resize, and late-response paths.**
- Support current UTF-8 plain-text and JSON artifacts while deferring binary, download, rich Markdown, diff, and cross-thread catalogs. **Completed at the intended media and authorization boundary.**
- Verify protocol, storage ranges, authorization, app-server/client paths, TUI navigation, subprocess behavior, real TTY interaction, and every existing reliability gate. **Completed with 258/258 offline tests, 6/6 scenarios, and a real TTY list/direct-open/byte-paging/preview/Escape/shutdown smoke test.**

The accepted authorization, protocol, UTF-8 pagination, interaction, failure, and verification contract is in the [Phase 3E4 thread-scoped artifact inspection design](2026-08-27-phase-3e4-artifact-inspection-design.md).

## Phase 3E5: auditable context and instruction inspection

Status: **Implemented and verified.**

- Add a durable, bounded `context.prepared` event immediately before every provider request so context selection, estimates, calibration, Item identity, tool identity, and Compaction state remain auditable after restart.
- Upgrade the local app-server contract to protocol v7 with thread-scoped request discovery, exact snapshot detail, and opaque-source bounded instruction reads.
- Reconstruct active Items from authoritative JSONL and fail closed when recorded request summaries do not match durable history; never start MCP or a Provider for inspection.
- Compare current repository instructions with the selected request's `turn.context` and expose unchanged, modified, missing, and added status without persisting historical file bodies.
- Add `/context`, preview `c`, newest-first request history, budget and Compaction detail, current effective-instruction viewing, layered Escape, and generation-based stale-response rejection to Ink.
- Preserve all credential, response-budget, path-confinement, UTF-8, normal-terminal-buffer, and source-view-on-failure boundaries established by earlier Phase 3 slices.
- Verify event ordering, deterministic summaries, legacy logs, authorization, instruction races, typed app-server/client paths, TUI navigation, real TTY interaction, and every existing reliability gate.

The accepted telemetry, reconstruction, protocol, instruction, interaction, failure, and verification contract is in the [Phase 3E5 auditable context and instruction inspection design](2026-08-27-phase-3e5-context-inspection-design.md).

## Phase 3F1: auditable multi-file change transactions

Status: **Implemented and verified.**

- Add a separate strict `apply_changes` tool for bounded coordinated text-file create, exact update, same-device move, and delete operations while preserving the existing `apply_patch` contract.
- Prepare and preview the complete change set without mutation, ask once, then acquire a workspace-scoped mutation lease and revalidate every path before committing.
- Serialize both Koda write tools across threads and processes without pretending that the lease can exclude external editors or Git.
- Stage candidates, commit independent paths deterministically, and compensate completed operations in reverse order after ordinary failure or cancellation.
- Persist bounded prepared, committed, rolled-back, or uncertain evidence; never truncate an approval, overwrite a third-party rollback conflict, or automatically replay an incomplete write.
- Upgrade the local protocol to v8 for the new public event variants and advertise `multiFileChanges: true`.
- Verify transaction limits, path confinement, exact edits, moves/deletes, races, fault-injected rollback, mutation leases, recovery classification, provider schemas, app-server/client behavior, Ink/CLI approvals, and real TTY interaction.

The complete accepted tool grammar, safety invariants, transaction state machine, protocol, recovery model, failure semantics, verification matrix, and deliberate deferrals are in the [Phase 3F1 auditable multi-file change transactions design](2026-08-27-phase-3f1-multi-file-change-transactions-design.md).

## Phase 3F2: strict native patch documents

Status: **Implemented and verified.**

- Add a separate `apply_patchset` tool with a bounded Codex-style Koda Patch v1 document grammar while preserving `apply_patch` and `apply_changes` schemas.
- Parse the complete document without workspace mutation, compile line hunks to unique exact edits, and delegate all approval, serialization, revalidation, commit, rollback, and recovery behavior to Phase 3F1.
- Support bounded create, ordered multi-hunk update, pure move, and delete sections without claiming Git unified-diff compatibility or fuzzy matching.
- Preserve consistent LF or CRLF target line endings and update final-newline state; reject mixed or ambiguous text instead of normalizing it silently.
- Upgrade the local protocol to v9 with `patchDocuments: true` while reusing existing approval and change-set event projections.
- Verify grammar limits, exact matching, line endings, one-shot approval, transaction evidence, recovery, provider schemas, CLI/app-server clients, Ink fixtures, reliability scenarios, and real TTY behavior.

The accepted grammar, compilation rules, transaction reuse, failure model, verification matrix, and deliberate deferrals are in the [Phase 3F2 strict native patch documents design](2026-08-27-phase-3f2-native-patch-documents-design.md).

## Phase 3F3: session-scoped exact-command approval grants

Status: **Implemented and verified.**

- Let a user approve one exact normalized built-in `exec_command` for a short application session without caching writes, MCP calls, unknown tools, or command prefixes.
- Scope every grant to one canonical workspace and exact prepared command identity, with a 15-minute default, one-hour maximum, capacity bound, process-restart revocation, and `never` mode precedence.
- Persist bounded grant-created and grant-used audit evidence before activation or execution while never reconstructing capabilities from historical JSONL.
- Upgrade the local protocol to v10 with `approvalGrants: true` and strict list, revoke, and revoke-all use cases.
- Add Ink `a` approval plus `/approvals` inspection and revocation commands while keeping the one-shot CLI on one-time `y/N` approval.
- Verify identity normalization, expiry, concurrency, ordering, failure boundaries, recovery, protocol/app-server/client paths, TUI interaction, reliability scenarios, and real TTY behavior.

The accepted authorization identity, lifecycle, audit, protocol, interaction, failure, and verification contract is in the [Phase 3F3 session-scoped exact-command approval grants design](2026-08-28-phase-3f3-session-command-approval-grants-design.md).

## Phase 3G: durable planning and Harness checkpoints

Status: **Implementation in progress — Phase 3G1 implemented and verified; Phase 3G2 next.**

- Add a thread-scoped Plan/Stage/Todo state machine maintained explicitly through a built-in `update_plan` control tool.
- Keep JSONL authoritative, pin the latest Plan across context compaction, and reconstruct it without parsing model prose.
- Add safe logical checkpoints, plan-aware bounded execution, resumable `turn.paused`, and conservative recovery after uncertain effects.
- Add optional per-Stage human acceptance that is separate from tool approvals and cannot be granted by the model.
- Upgrade the local protocol to v11 with bounded Plan inspection and exact live acceptance resolution.
- Add CLI and Ink Plan views, acceptance interaction, provider conformance, crash recovery, and real TTY verification.

The accepted domain model, state machine, checkpoint and recovery rules, acceptance lifecycle, protocol boundary, verification matrix, and five implementation slices are in the [Phase 3G durable planning and Harness checkpoints design](2026-08-28-phase-3g-planning-harness-design.md).

## Phase 3H: Skills and extension system

Status: **Queued for design after Phase 3G acceptance.**

- Add project Skills with explicit discovery, precedence, scope, budgets, and instruction trust boundaries.
- Add reviewed command templates without turning repository text into implicit execution authority.
- Add dynamic tool discovery and refresh without weakening policy, approval, cancellation, or recovery semantics.
- Add a bounded plugin lifecycle for activation, capability registration, failure isolation, shutdown, and diagnostics.

Phase 3H receives its own alternatives review and accepted design after Phase 3G is implemented and verified. Skills, templates, tools, and plugins will reuse the Phase 3G Plan/Harness boundary rather than create a parallel agent loop.

## Other later Phase 3 slices

### Provider and context extensions after Phase 3C

- Add arbitrary base URLs and user-defined profiles only with an explicit network and credential trust design.
- Extend the registry to Qwen, Doubao, MiniMax, and other documented providers through the Phase 3C conformance suite.
- Design model discovery, capability negotiation, automatic routing, fallback, retries, and cross-provider migration as separate slices.
- Evaluate provider-assisted semantic compaction and exact tokenizers against the deterministic Phase 2 baseline before adopting either dependency.
- Add exact pricing and budget forecasting only after token accounting is verified per provider.

### Interactive clients and client APIs

- Maintain the completed Phase 3D Ink chat REPL on the Phase 3A application protocol.
- Maintain the completed Phase 3E1 semantics for recent-thread selection, bounded history preview, and safe resume through the current protocol v10 transport.
- Maintain the completed Phase 3E2 boundary as bounded bidirectional history navigation and workspace-scoped substring search over app-server protocol v10; retain the normal terminal buffer and a disposable SQLite projection.
- Maintain the completed Phase 3E3 boundary for explicit provider/model preferences that affect only new threads.
- Maintain the completed Phase 3E4 boundary for thread-scoped discovery and bounded UTF-8 artifact reads.
- Maintain the completed Phase 3E5 boundary for durable per-request context telemetry and bounded current-instruction inspection.
- Defer FTS5, fuzzy/relevance ranking, live search, cross-workspace search, alternate-screen navigation, and real-time subscriptions beyond Phase 3E2.
- In Phase 3E or Phase 4, add Markdown/syntax rendering, dedicated diff views, artifact download/export, attachments, and richer prompt-diff or context-export views beyond Phase 3E5.
- Build IDE or desktop clients only after the local protocol client and TUI have validated the shared boundary.
- Keep presentation state outside the agent runtime and keep approvals fail-closed on client loss.

### Richer local workflows

- Maintain the completed Phase 3F1 boundary for bounded multi-file transactions, moves, deletion, mutation serialization, and explicit rollback evidence.
- Maintain the completed Phase 3F2 Koda Patch v1 boundary as a strict line-oriented input representation compiled into Phase 3F1; do not imply Git unified-diff or fuzzy matching support.
- Add PTYs and managed background-process UX without weakening process ownership and termination records.
- Consider broader trusted command-prefix UX only as a separate design with inspectable scope, expiry, and revocation; keep the completed Phase 3F3 boundary exact-command only.
- Evaluate automatic commits as an explicit product workflow, not an implicit consequence of file edits.

## Explicitly outside Phase 3

- HTTP/WebSocket remote access, authentication, reconnect/resubscribe, multi-client broadcasting, shared app-server processes, shared artifact stores, strong OS sandboxing, Windows Job Objects, crash-surviving process supervision, signed releases, a Rust executor, and any retained shell-string execution: **Phase 4 hardening and distribution**.
- PTY-backed foreground/background workflow panes and managed process UX: **Phase 4 process UX and hardening**.
- Child agents, parent/child thread lineage, mailboxes, wait/interrupt, worktree isolation, curated project memory, and multi-agent scenario matrices: **Phase 5 multi-agent and memory**.

## Phase 3 exit criterion

Phase 3 is complete when multiple model providers and interactive local clients can use one durable application workflow; external tools have explicit lifecycle, policy, approval, cancellation, and recovery semantics; durable Plan/Harness workflows and the Skills extension boundary are implemented and auditable; and the full offline regression and provider-conformance gates pass. Phase 3 does not claim remote multi-user security or multi-agent orchestration.
