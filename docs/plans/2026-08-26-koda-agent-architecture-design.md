# Koda Agent Architecture Design

- Status: Accepted for Phase 0 implementation
- Date: 2026-08-26
- Owners: Koda maintainers
- Scope: Local-first coding agent CLI and its reusable agent runtime

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
| command parsing, Ink UI, approval UI, event reducer     |
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
| fs, git, process, store  |    | OpenAI, Anthropic, fake |
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
  | CompactionItem;
```

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
  stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent>;
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

SQLite stores thread listings, status, timestamps, provider/model metadata, usage totals, parent-child relationships, and event-log offsets. Storage is hidden behind `StateStore`, allowing `better-sqlite3` to be replaced when Node's built-in SQLite API becomes fully stable.

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

## 18. Technology decisions

- TypeScript with strict compiler settings for the control plane.
- Node.js LTS as the supported runtime; development remains compatible with Node 22 while CI targets Node 24.
- pnpm workspaces for dependency and package management.
- ESM packages.
- Zod for runtime protocol and tool validation.
- Ink for the first terminal UI.
- Official model provider SDKs behind Koda adapters.
- Official MCP TypeScript SDK behind the internal tool contract.
- JSONL plus SQLite for local state.
- `node-pty` behind a replaceable process interface when interactive terminal support is added.
- Vitest for deterministic unit and integration tests.
- Rust only for the later hardened execution sidecar.

Koda will not depend on LangChain for its main loop. The core orchestration is small enough to own, and owning it preserves control over events, recovery, tool semantics, context construction, and provider capabilities.

## 19. Delivery phases

### Phase 0: deterministic foundation

- Workspace and package scaffolding.
- Versioned protocol schemas.
- Append-only in-memory and JSONL event sinks.
- Single-turn agent loop.
- Scripted model provider.
- One deterministic test tool.
- Cancellation, limits, and core tests.

Exit criterion: the scripted model requests a tool, receives its result, produces a final response, and the exact ordered event sequence is asserted in tests.

### Phase 1: usable local agent

- OpenAI and Anthropic adapters.
- Ink terminal UI.
- Repository read/search/edit/exec tools.
- Policy and approval UI.
- Repository instructions and token accounting.

### Phase 2: reliability

- Resume and recovery.
- Context compaction.
- Output artifacts and truncation.
- Process-tree cancellation.
- SQLite metadata index.
- Scenario evaluation suite.

### Phase 3: extensibility

- MCP client.
- App-server protocol.
- IDE and desktop integration boundary.
- Hooks and provider extensions.

### Phase 4: hardening

- Rust execution sidecar.
- OS-specific sandboxing and network policy.
- Secret handling and signed cross-platform releases.

### Phase 5: multi-agent and curated memory

- Child threads, registry, mailbox, wait, and interrupt.
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

