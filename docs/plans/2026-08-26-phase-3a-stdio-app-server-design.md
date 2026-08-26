# Koda Phase 3A: Local stdio JSON-RPC App Server

- Status: Accepted for implementation (2026-08-26)
- Date: 2026-08-26
- Depends on: Phase 2F deterministic reliability closure
- Scope: transport-neutral application orchestration, versioned stdio JSON-RPC, durable event streaming, interactive approval, cancellation, and credential-free thread queries

## 1. Outcome

Phase 3A introduces the stable application boundary required by future terminal, desktop, and IDE clients. Koda gains a local app-server process that accepts newline-delimited JSON-RPC 2.0 on stdin and writes responses and notifications to stdout. A client can initialize the protocol, start or resume a turn, receive durable events, resolve approvals, cancel work, query threads, and shut the server down.

The app-server is not a wrapper around the existing CLI process. Turn orchestration moves into a transport-neutral `@koda/app` package used by both the CLI and app-server, so recovery, leases, tools, policies, artifacts, and metadata behavior cannot diverge between clients.

Phase 3A remains local and single-client. HTTP, authentication, remote execution, multi-client broadcasting, MCP, interactive UI, and artifact download APIs are deferred.

## 2. Alternatives and decision

Three implementation approaches were considered:

1. **Spawn and scrape `koda run`, rejected.** Terminal output is a lossy projection, approvals consume terminal input, and cancellation or event correlation would rely on process conventions instead of typed state.
2. **Call the current CLI `runCommand` directly, rejected.** This preserves behavior initially but leaves configuration, console projection, terminal approval, and application orchestration coupled inside `apps/cli`.
3. **Extract a shared application service, selected.** `@koda/app` owns use cases and composes the existing core/provider/runtime ports. CLI and app-server supply transport-specific event sinks, approval brokers, and lifecycle adapters.

The selected dependency shape is:

```text
apps/cli ---------+
                  +--> @koda/app --> agent-core / providers / runtime-node
apps/app-server --+
```

Neither `agent-core` nor `runtime-node` imports JSON-RPC or client presentation code.

## 3. Application service boundary

`KodaApplication` owns the complete turn workflow currently composed by the CLI:

- resolve and validate run configuration;
- open the canonical workspace and load scoped instructions;
- allocate thread, turn, and item IDs;
- acquire the thread lease and check the artifact-maintenance lease;
- recover normalized history and validate resume provenance;
- open the artifact store and register constrained tools;
- construct the provider, policy, context engine, and `AgentLoop`;
- fan durable events out to a client-supplied event sink only after JSONL append succeeds;
- release resources and refresh rebuildable thread metadata.

`startTurn` returns a handle containing the allocated thread ID, turn ID, an idempotent cancel operation, and a completion promise. It performs enough preflight work to return stable IDs, while long-running model/tool work continues asynchronously. A completion result distinguishes `completed`, `cancelled`, and `failed` and preserves the CLI-compatible exit-code mapping.

The application also exposes credential-free thread list/get operations backed by `ThreadMetadataIndex`. The JSON-RPC transport does not open SQLite or JSONL directly.

Different threads may execute concurrently. Existing per-thread leases continue to reject two writers for the same thread. Application events keep authoritative ordering by using a fanout sink whose JSONL destination precedes the client sink. Failure to persist JSONL fails the turn; failure to notify a client cancels that client's active turn but does not erase already durable events.

## 4. Protocol and framing

Phase 3A uses JSON-RPC 2.0 with one UTF-8 JSON object per line. Batch messages are rejected. An inbound line is limited to 1 MiB. stdout is reserved exclusively for protocol messages; diagnostics and fatal transport errors go to stderr. All writes pass through one promise chain so concurrent responses and notifications cannot interleave.

The first request must be `initialize`. It carries protocol version `1` and client name/version. The response returns the negotiated version, server identity, and capabilities. Requests before initialization fail with a stable server-not-initialized error; repeated initialization fails without resetting active state.

Phase 3A methods are:

- `initialize`;
- `thread/list`;
- `thread/get`;
- `turn/start`;
- `turn/cancel`;
- `approval/resolve`;
- `shutdown`.

`turn/start` accepts a prompt, workspace, optional model, optional resume thread ID, and approval mode. Provider credentials come only from the server environment and are never protocol fields. The result immediately identifies the thread and turn.

Server notifications are:

- `turn/event`, carrying a complete versioned `AgentEvent` after durable append;
- `turn/finished`, carrying the application completion result, including pre-event configuration or workspace failures.

JSON-RPC IDs may be strings or finite safe integers. Notifications have no ID. The protocol uses strict Zod schemas in `@koda/protocol`; unknown fields in method parameters are rejected.

## 5. Approval and cancellation

The existing durable `approval.requested` agent event is the client prompt. The app-server's approval broker registers a pending promise keyed by `turnId + callId` and waits after that event has been persisted and notified. The client answers through `approval/resolve` with `approved` or `rejected` plus an optional reason.

An approval can resolve exactly once. Unknown, duplicate, expired, wrong-turn, and already-cancelled resolutions return stable JSON-RPC application errors. A client disconnect, turn cancellation, shutdown, or turn completion rejects all remaining approvals for that turn; none default to approval.

`turn/cancel` targets a live turn ID and invokes its AbortController idempotently. The request reports whether a live turn accepted cancellation. The existing runtime remains responsible for owned-process-tree termination, termination evidence, and the durable `turn.cancelled` terminal event.

The server maintains an `ActiveTurnRegistry` and a `PendingApprovalRegistry`. A finished turn is removed only after its completion notification is queued. The registries are process-local coordination state, not a replacement for JSONL or thread leases.

## 6. Shutdown and failure semantics

`shutdown` stops accepting new turn starts, rejects pending approvals, cancels active turns, waits for their completion and cleanup, then returns. After a successful shutdown response the process may close normally. EOF and termination signals perform the same cancellation path but cannot send a guaranteed response.

Malformed JSON returns parse error `-32700`; invalid JSON-RPC envelopes return `-32600`; unknown methods return `-32601`; invalid method parameters return `-32602`; unexpected handler failures return `-32603`. Stable Koda application conditions use reserved server-error codes with structured `data.code`, including not initialized, already initialized, turn not found, approval not found, approval already resolved, shutting down, and protocol version mismatch.

An individual request failure does not terminate the server. An oversized input line or an unwritable stdout is a transport-fatal condition: the server records a bounded diagnostic, cancels all activity, and exits nonzero. Error messages are bounded and do not include credentials or environment dumps.

## 7. Testing and acceptance criteria

Offline tests cover:

- strict JSON-RPC envelopes, IDs, method params, results, and notifications;
- initialization ordering, version negotiation, duplicate initialization, unknown methods, malformed JSON, invalid params, and input-size limits;
- application-level new turn and resume behavior with `ScriptedModelProvider`;
- durable-before-notify event ordering;
- approval requested/resolve/reject, duplicate and stale decisions, and cancellation while waiting;
- cancellation of a real command through the shared application layer;
- concurrent different-thread turns and same-thread lease rejection;
- thread list/get without provider credentials;
- shutdown, EOF, active-turn cleanup, and serialized output writes;
- CLI behavior remaining compatible after migration;
- a real app-server subprocess smoke test whose stdout contains protocol messages only.

Phase 3A is complete when a local client can initialize, start or resume a turn, consume durable typed events, resolve approval, cancel execution, query thread metadata, and shut down cleanly; the CLI and app-server use the same application workflow; and all tests pass without live model credentials.

## 8. Deferred destinations

- Artifact download, rich previews, and client-managed attachments: a later Phase 3 client API slice.
- HTTP/WebSocket transport, authentication, remote access, and multi-client event broadcasting: Phase 4 distribution and hardening.
- MCP client integration and external tool lifecycle: Phase 3B or later after the app boundary is stable.
- Anthropic provider and provider selection UX: a later Phase 3 provider slice.
- Ink chat REPL, desktop UI, and IDE extension: later Phase 3 clients built on this protocol.
- PTYs, managed background processes, approval caching, trusted command prefixes, and richer patch transactions: separate Phase 3 runtime/product slices.
- Child agents, thread lineage, mailbox, and worktree isolation: Phase 5.
