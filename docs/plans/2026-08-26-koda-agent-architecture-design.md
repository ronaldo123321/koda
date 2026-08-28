# Koda Agent Architecture Design

- Status: Implemented through Phase 3B
- Date: 2026-08-26
- Owners: Koda maintainers
- Scope: Local-first coding agent CLI and its reusable agent runtime

## Roadmap status: Phase 3B complete

Phase 0 and Phase 1A through 1D are complete. Phase 2A provides durable local transcript replay, safe interrupted-turn recovery, context snapshots, continuous event sequencing, `--resume`, and single-host writer leases. Phase 2B adds content-addressed output artifacts, uniform model-facing byte budgets, bounded artifact retrieval, recovery diagnostics, and provider-output limits. Phase 2C adds provider-neutral context budgets, measured estimate calibration, append-only compaction, scoped nested repository instructions, and resume provenance. Phase 2D adds a durable side-effect boundary, owned process trees, bounded termination escalation, lifecycle events, and structured interrupted-operation evidence. Phase 2E adds rebuildable SQLite thread metadata, corrupt-database quarantine, source-fingerprint refresh, and credential-free list/show commands. Phase 2F closes the phase with six deterministic reliability scenarios and JSONL-derived, reference-aware artifact collection guarded by a global maintenance lease. Phase 3A adds the shared `@koda/app` application boundary and a strict local stdio JSON-RPC app-server with durable event notifications, interactive approval, cancellation, thread queries, and cleanup semantics. Phase 3B adds the official MCP v2 stdio client behind `@koda/mcp-client-node`, strict environment-isolated configuration, frozen tool catalogs, fail-closed external-tool policy, bounded result artifacts, per-turn child lifecycle, and conservative interrupted-call recovery. All moved work remains listed explicitly in the Phase 3 roadmap and the revised phase sections below.

## Roadmap revision: Phase 1 closeout

The original roadmap placed both Anthropic support and an Ink terminal UI in Phase 1. Phase 1A through Phase 1C showed that neither is a dependency for the first reliable OpenAI coding loop. On 2026-08-26 the roadmap was revised as follows:

| Capability                    | Original phase | Revised phase | Reason                                                                                    |
| ----------------------------- | -------------- | ------------- | ----------------------------------------------------------------------------------------- |
| Anthropic provider            | Phase 1        | Phase 3       | Add the second provider after recovery and context behavior are stable.                   |
| Ink terminal UI and chat REPL | Phase 1        | Phase 3       | Keep the line-oriented approval CLI until long-lived UI state has a durable app boundary. |
| Root repository instructions  | Phase 1        | Phase 1D      | Required before resume and compaction.                                                    |
| Provider token accounting     | Phase 1        | Phase 1D      | Required to measure future context budgets.                                               |

Moved work is retained explicitly in its destination phase below. Phase 1 closes with an OpenAI-first, single-turn local agent; it does not claim multi-provider or interactive-TUI completion.

## 1. Problem statement

Koda aims to be a local coding agent similar in product shape to Codex: it can inspect a repository, reason over a user request, invoke constrained tools, modify files, run commands, stream progress, and resume interrupted work.

The product is not only a chat client. Its primary engineering problem is building a reliable harness around a probabilistic model. That harness must keep conversation state consistent, validate and schedule tool calls, enforce permissions outside the prompt, recover from failures, and expose the same typed events to terminal and future clients.

The current repository has no implementation constraints, so Koda can start with explicit boundaries instead of inheriting accidental ones.

## 2. Goals

1. Deliver a useful single-agent local coding loop before adding orchestration features.
2. Keep model providers, user interfaces, storage, and process execution replaceable.
3. Treat tool execution as an untrusted proposal that requires runtime validation and policy enforcement.
4. Make every meaningful state transition observable, persistent, and testable.
5. Support cancellation, crash recovery, context compaction, and session resume.
6. Leave a clean protocol boundary for a desktop app, IDE extension, MCP integration, and a hardened Rust executor.

## 3. Non-goals for the first release

- Autonomous multi-agent planning.
- Vector-database-backed long-term memory.
- A remote execution cluster.
- A public plugin marketplace.
- A complete secure sandbox implemented in TypeScript.
- A framework abstraction that exposes every provider feature identically.
- A large monorepo mirroring the current size of Codex.

## 4. Design principles derived from Codex

### 4.1 The harness, not the model, owns control

The model may request a tool call. It cannot execute a command or write a file directly. The runtime parses the request, validates it, evaluates policy, obtains approval when required, and only then invokes an execution backend.

### 4.2 Thread, turn, step, and item are distinct

- A **Thread** is a durable conversation that can be resumed or forked.
- A **Turn** is one user-directed unit of work.
- A **Step** is one model sampling request within a turn.
- An **Item** is a typed transcript entry such as a message, tool call, tool result, approval, or compaction record.

A turn can contain several model steps because every tool result becomes a new observation for the next step.

### 4.3 Events are the integration boundary

The core emits typed events. The terminal UI reduces those events into presentation state. A future app server will expose the same concepts over JSON-RPC or another transport. No product state may exist only in an Ink component.

### 4.4 Policies are not prompts

Instructions guide the model. Policies constrain the runtime. Approval, sandboxing, path access, network access, timeouts, and cancellation remain effective even when the model is mistaken or prompt-injected.

### 4.5 State is append-first

The transcript and execution history use an append-only JSONL event log as the source of truth. SQLite provides queryable metadata and indexes, but it is not the only copy of the conversation.

### 4.6 Multi-agent execution means multiple sessions

When added, each child agent will have an independent thread, context, loop, cancellation token, and status. Write-capable children will use isolated Git worktrees. Multi-agent work is not multiple personas sharing one mutable prompt.

## 5. System context

```text
User
  |
  v
Terminal CLI ---- future Desktop / IDE
  |                       |
  +------ typed protocol -+
              |
              v
        Koda Application
              |
              v
          Agent Core
        /     |      \
 Model API  Tools   State Store
                    |
                 Local repo
```

Koda runs locally by default. Model inference may be remote, while repository access and tools remain under the local runtime's control.

## 6. Logical architecture

```text
+---------------------------------------------------------+
| apps/cli                                                |
| command parsing, line UI, approval UI; future Ink       |
+------------------------------+--------------------------+
                               | commands / events
+------------------------------v--------------------------+
| Koda application service                                 |
| ThreadManager, TurnManager, cancellation, configuration |
+------------------------------+--------------------------+
                               |
+------------------------------v--------------------------+
| agent-core                                               |
|                                                         |
| AgentLoop -------- ModelGateway                         |
|    |                                                    |
|    +-- ContextEngine                                    |
|    +-- ToolScheduler -- PolicyEngine -- ApprovalBroker  |
|    +-- EventSink                                        |
+-------------------+----------------------+--------------+
                    |                      |
+-------------------v-----+    +-----------v--------------+
| runtime-node             |    | providers                |
| fs, git, process, store  |    | OpenAI, fake; future Anthropic |
+-------------------+-----+    +--------------------------+
                    |
          future Rust koda-exec
```

Dependency rule: `agent-core` may depend on `protocol`, but it must not import Ink, provider SDKs, SQLite, `node-pty`, or a platform sandbox implementation.

## 7. Repository layout

```text
koda/
  apps/
    cli/
  packages/
    protocol/
    agent-core/
    providers/
    runtime-node/
    testkit/
  crates/
    koda-exec/          # introduced only when hardening begins
  docs/
    plans/
```

The first implementation may leave empty future packages out. Package boundaries are introduced only when code has a real dependency boundary.

## 8. Core domain model

Identifiers are opaque strings generated by an injected ID factory. Time comes from an injected clock so tests are deterministic.

```ts
type ThreadStatus = "idle" | "running" | "waiting" | "completed" | "failed";
type TurnStatus = "running" | "completed" | "cancelled" | "failed";

interface Thread {
  id: string;
  parentThreadId?: string;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
}

interface Turn {
  id: string;
  threadId: string;
  status: TurnStatus;
  createdAt: string;
  completedAt?: string;
}
```

Transcript items are a discriminated union. Provider-specific response objects never enter the core transcript.

```ts
type ConversationItem =
  | UserMessageItem
  | AssistantMessageItem
  | ToolCallItem
  | ToolResultItem
  | ApprovalItem
  | RecoveryItem
  | CompactionItem;
```

Oversized tool output remains a normal `ToolResultItem`, but its bounded excerpt may include a standard `ArtifactReference`. The referenced bytes are stored outside JSONL by SHA-256 and can be retrieved only through a bounded read-only runtime tool. Artifact events are projections; tool results remain the durable transcript source.

`StepContext` is captured at the beginning of a model request. It includes model configuration, working directory, permissions, instruction version, advertised tool definitions, and token budget. A tool call must execute against the same snapshot that advertised it.

## 9. Agent loop

```text
start turn
  -> load transcript and world state
  -> compact if the context budget requires it
  -> capture StepContext
  -> build provider-neutral ModelRequest
  -> stream ModelEvents
  -> persist and emit assistant items
  -> validate requested tool calls
  -> evaluate policy and approval
  -> execute tools with cancellation
  -> persist tool results
  -> repeat when the model needs another observation
  -> finish when the model emits a final response with no calls
```

The loop has explicit limits: maximum model steps per turn, maximum tool calls, context budget, command timeout, output budget, and a caller-provided `AbortSignal`.

User steering is queued in a mailbox. Input received during a step is consumed before the next model request, avoiding mutation of an in-flight request.

## 10. Model provider boundary

```ts
interface ModelProvider {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}
```

The common contract covers messages, streaming text, tool calls, finish reasons, usage, and recoverable errors. Provider capabilities such as prompt caching, previous response identifiers, reasoning effort, and computer-use metadata remain capability-gated extensions instead of being flattened away.

Server-side KV cache is not Koda state. Koda improves cache reuse by maintaining stable instruction and tool prefixes and by forwarding provider cache identifiers through the adapter.

## 11. Tool runtime

```ts
interface Tool<I, O> {
  spec: ToolSpec;
  inputSchema: ZodType<I>;
  concurrency: "parallel" | "exclusive";
  execute(context: ToolContext, input: I): Promise<ToolExecutionResult<O>>;
}
```

`ToolRegistry.register` receives the visible specification, validation schema, and handler together. This prevents schema-handler drift.

Initial tools:

- `read_file`
- `list_files`
- `search_text`
- `apply_patch`
- `exec_command`
- `git_status`
- `ask_user`

Read-only tools may execute in parallel. Workspace mutation, Git mutation, and process-level tools are exclusive by default. Every call has a stable call ID. The event store records whether a call started and finished so recovery does not silently repeat a side effect.

## 12. Policy, approval, and execution

Policy returns one of three results:

```ts
type PolicyDecision =
  | { decision: "allow" }
  | { decision: "ask"; reason: string }
  | { decision: "deny"; reason: string };
```

Policy evaluates tool type, normalized target paths, working directory, command form, network requirements, and configured workspace roots. Approval is a user interaction. Sandbox policy is the constraint applied to an approved process. Execution is the mechanism that starts it.

Phase 1 TypeScript protections include path canonicalization, workspace-root enforcement, environment filtering, command classification, timeouts, output limits, cancellation, and process-group termination. These are guardrails, not a strong sandbox. A later `koda-exec` Rust sidecar will implement OS-specific isolation.

Shell strings are treated as a high-risk escape hatch. Structured `argv` execution is preferred wherever possible.

## 13. Persistence and recovery

Each thread owns an ordered JSONL log:

```text
.koda/
  threads/<thread-id>.jsonl
  artifacts/
  state.db
```

Events include a schema version, sequence number, timestamp, thread ID, optional turn ID, type, and typed payload. Appends are serialized per thread. A partial trailing line is ignored during recovery and reported as a diagnostic.

SQLite stores rebuildable thread listings, status, timestamps, provider/model metadata, usage totals, and event-log offsets. `ThreadMetadataIndex` isolates `better-sqlite3`, allowing the backend to move to Node's built-in SQLite API when it is stable across Koda's supported Node range. Parent-child relationships are not synthesized without durable fork provenance and remain Phase 5 work.

On recovery, a started but unfinished turn becomes interrupted. A started but unfinished side-effecting tool call is not automatically retried; the model and user receive an interruption record.

## 14. Context and memory

Prompt order is deliberately stable:

1. Base product instructions.
2. Repository instructions such as `AGENTS.md` or `KODA.md`.
3. Current environment and permission snapshot.
4. Compacted history.
5. Recent typed transcript.
6. Current user input and queued steering.

Compaction emits structured state containing the objective, decisions, modified files, completed work, pending work, failed attempts, and critical facts. The original event log remains available even when only the compacted view is sent to the model.

Long-term automatic memory and vector search are deferred. The first persistent memory feature will be explicit, inspectable project notes that users can edit and delete.

## 15. Error handling

Errors are classified instead of collapsed into strings:

- Provider transient, rate-limit, authentication, and protocol errors.
- Tool validation, policy denial, approval rejection, execution, timeout, and cancellation errors.
- Storage corruption or append errors.
- Core invariant violations.

Expected tool failures become tool results so the model can recover. Authentication errors and state-persistence failures stop the turn. Cancellation is a normal terminal state, not an exception presented as a crash.

Large outputs are truncated in the prompt-facing result and stored as artifacts with byte counts and content hashes.

## 16. Observability

The event stream is also the primary debugging surface. Logs add operational fields that do not belong in the transcript, such as latency, retry count, cache usage, process ID, and memory usage.

Secrets, authorization headers, and configured sensitive environment variables are redacted before persistence. Reasoning content is represented as an optional typed item and is never assumed to be available from every provider.

## 17. Testing and evaluation

Unit and integration tests use a scripted provider that yields deterministic model events. Core tests never require API keys.

Required scenarios:

1. A read-only task cannot mutate files.
2. A write remains inside the requested workspace.
3. An external path requires approval or is denied.
4. Cancellation terminates the active process tree.
5. A thread can be recovered from its event log.
6. Compaction preserves pending work and user constraints.
7. Prompt injection in repository content cannot change policy.
8. Parallel read-only calls preserve deterministic transcript ordering.
9. An unknown or malformed tool call becomes a recoverable result.
10. Recovery does not automatically repeat an uncertain side effect.

Scenario evaluations use binary assertions over file diffs, commands, policy decisions, events, and final status rather than subjective output scoring.

The Phase 2F dedicated suite composes the six cross-cutting recovery and safety scenarios offline. The remaining read/write confinement, deterministic parallel ordering, and malformed-tool cases stay in the ordinary deterministic integration suite, which runs under the same `pnpm test` gate.

## 18. Technology decisions

- TypeScript with strict compiler settings for the control plane.
- Node.js LTS as the supported runtime; development remains compatible with Node 22 while CI targets Node 24.
- pnpm workspaces for dependency and package management.
- ESM packages.
- Zod for runtime protocol and tool validation.
- A line-oriented terminal and approval UI through Phase 2; Ink is scheduled for Phase 3.
- The official OpenAI SDK behind the first adapter; the Anthropic adapter is scheduled for Phase 3.
- Official MCP TypeScript SDK behind the internal tool contract.
- JSONL plus SQLite for local state.
- `node-pty` behind a replaceable process interface when interactive terminal support is added.
- Vitest for deterministic unit and integration tests.
- Rust only for the later hardened execution sidecar.

Koda will not depend on LangChain for its main loop. The core orchestration is small enough to own, and owning it preserves control over events, recovery, tool semantics, context construction, and provider capabilities.

## 19. Delivery phases

### Phase 0: deterministic foundation

Status: **Complete.**

- Workspace and package scaffolding.
- Versioned protocol schemas.
- Append-only in-memory and JSONL event sinks.
- Single-turn agent loop.
- Scripted model provider.
- One deterministic test tool.
- Cancellation, limits, and core tests.

Exit criterion: the scripted model requests a tool, receives its result, produces a final response, and the exact ordered event sequence is asserted in tests.

### Phase 1: usable local agent

Status: **Complete through Phase 1D under the revised OpenAI-first scope.**

- OpenAI adapter and a line-oriented terminal CLI.
- Repository read/search/edit/exec tools.
- Policy and approval UI.
- Root repository instructions and provider token accounting.

Moved from Phase 1 to Phase 3: the Anthropic adapter, Ink terminal UI, and long-lived chat REPL.

### Phase 2: reliability

Status: **Complete; Phase 2A through 2F are implemented and pass offline regression gates.**

- Resume and recovery.
- Context compaction.
- Output artifacts and truncation.
- Durable side-effect boundaries and process-tree cancellation with explicit termination evidence.
- Rebuildable SQLite metadata index with materialized thread usage. Monetary cost metadata is deferred until a versioned pricing source exists.
- Scenario evaluation suite.
- Reference-aware artifact garbage collection. **Moved from the earlier Phase 2E expectation to Phase 2F.**
- Nested instruction scoping and instruction-snapshot validation during resume.
- Recovery records for uncertain mutations. Automatic rollback and multi-file transactions remain Phase 3 work.

### Phase 3: extensibility

Status: **Phase 3A through Phase 3H are complete; Phase 3I client interaction and observability closure is in progress.**

- Shared transport-neutral application workflow. **Completed in Phase 3A.**
- Local stdio JSON-RPC app-server protocol. **Completed in Phase 3A.**
- MCP client and external tool lifecycle. **Completed in Phase 3B for local stdio Tools. HTTP/OAuth and the non-Tool capability surface remain deferred as documented.**
- IDE and desktop integration boundary.
- Hooks and provider extensions.
- Anthropic adapter. **Moved from Phase 1.**
- Ink terminal UI and long-lived chat REPL. **Moved from Phase 1.**
- Native or richer patch capabilities, multi-file operations, moves, and deletion.
- Interactive PTY and managed background-process UX.
- Approval caching and trusted command-prefix UX.
- Compact Tool activity, a durable activity inspector, and bounded streaming refresh. **Phase 3I closure in progress.**

### Phase 4: hardening

- Rust execution sidecar.
- OS-specific sandboxing and network policy.
- Secret handling and signed cross-platform releases.
- High-risk shell-string execution, if retained after sandbox evaluation.
- Progressive Tool activity presentation and its complete durable inspector moved to **Phase 3I client closure** so Phase 4 remains focused on runtime, security, remote operation, and distribution hardening.

### Phase 5: multi-agent and curated memory

- Child threads, registry, mailbox, wait, and interrupt.
- Durable fork provenance and parent/child thread lineage queries.
- Read-only delegation and Git-worktree write isolation.
- User-visible project notes and later measured retrieval features.

## 20. Phase 0 acceptance criteria

- `pnpm build`, `pnpm typecheck`, and `pnpm test` pass without credentials.
- Core has no imports from concrete provider SDKs or UI packages.
- The event contract is runtime-validated and versioned.
- Tool arguments are runtime-validated.
- A scripted two-step model/tool/model loop completes deterministically.
- Cancellation and maximum-step exhaustion have explicit terminal results.
- JSONL events can be appended and read back in sequence.
- Public packages expose documented entry points and avoid deep imports.
