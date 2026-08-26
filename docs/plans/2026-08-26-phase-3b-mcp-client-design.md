# Koda Phase 3B: Local MCP Client and External Tool Lifecycle

- Status: Implemented and verified (2026-08-26)
- Date: 2026-08-26
- Depends on: Phase 3A transport-neutral application boundary
- Scope: official MCP v2 client, explicitly configured local stdio servers, tool discovery and invocation, fail-closed effect policy, bounded outputs, cancellation, cleanup, and conservative recovery

## 1. Outcome

Phase 3B lets a Koda turn use tools published by local MCP servers without moving MCP protocol concerns into `agent-core` or weakening existing approval and recovery guarantees. Koda launches explicitly configured stdio servers, completes the MCP initialize handshake, discovers their tools, registers stable model-facing aliases, invokes them through the existing tool loop, bounds their results through the artifact store, and closes every child process when its owning turn ends.

This phase is deliberately Tools only. It does not add Streamable HTTP, OAuth, resources, prompts, sampling, elicitation, dynamic tool refresh, remote hosting, or shared long-lived sessions.

## 2. Alternatives and decision

Three approaches were considered:

1. **Official MCP v2 client, local stdio, Tools only — selected.** This delegates wire compatibility and subprocess transport to the maintained SDK while keeping the first integration slice small and locally testable.
2. **Add stdio and HTTP plus the full MCP capability surface — rejected for Phase 3B.** Authentication, network policy, context injection, server-to-client requests, and multi-client lifecycle would mix several independent security boundaries.
3. **Implement MCP JSON-RPC directly — rejected.** Koda would duplicate version negotiation, message validation, transport cleanup, and compatibility work without product benefit.

The implementation uses the stable split `@modelcontextprotocol/client` v2 package and its `StdioClientTransport`.

## 3. Architecture

Phase 3B adds a Node-specific `@koda/mcp-client-node` package:

```text
@koda/app
 ├─ @koda/runtime-node
 ├─ @koda/mcp-client-node
 ├─ @koda/providers
 └─ @koda/agent-core
```

`@koda/mcp-client-node` owns configuration parsing, stdio client construction, MCP lifecycle, tool catalog normalization, Koda tool registration, result conversion, and MCP-specific errors. It may use `ArtifactStore` from `runtime-node`, but `runtime-node` and `agent-core` never import MCP. The CLI and app-server receive MCP behavior only through their shared `KodaApplication` workflow.

After the workspace, thread lease, maintenance lease, and artifact store are ready, `KodaApplication` opens one `McpTurnSession`. The session starts configured servers in deterministic configuration order, discovers every tool page, validates aliases and schemas, then registers the complete catalog into the current turn's `ToolRegistry`. Only after all configured servers are ready does Koda construct `AgentLoop`; a partial catalog is never sent to the model.

Every turn owns independent MCP clients and child processes. Different threads may run concurrently without sharing sessions. Session closure is idempotent and runs in the application `finally` path for completion, failure, cancellation, app-server disconnect, and signal termination.

## 4. Configuration and environment isolation

Koda reads `${KODA_HOME}/mcp.json` by default. `KODA_MCP_CONFIG` may point to another file. An absent default file means MCP is disabled and preserves current behavior; an explicitly selected missing or invalid file is an `MCP_CONFIGURATION_INVALID` turn failure.

Configuration is strict and versioned:

```json
{
  "version": 1,
  "servers": {
    "github": {
      "command": "node",
      "args": ["/absolute/path/github-mcp.js"],
      "cwd": "/optional/absolute/directory",
      "env": ["GITHUB_TOKEN"],
      "tools": {
        "github_list_repos": { "effect": "read" }
      }
    }
  }
}
```

Server IDs use a bounded lowercase identifier. `command` and `args` are passed as an argv vector and never interpreted by a shell. `cwd`, when present, must resolve to an existing absolute directory. Each child receives a small runtime baseline plus only the parent environment variables named in its `env` allowlist. Missing allowlisted variables fail startup. Configuration contains environment names, not secret values; Koda does not persist environment values or raw MCP wire traffic.

The server map is sorted by ID before startup so behavior does not depend on JSON property insertion order. Duplicate model aliases, invalid names, oversized catalogs, or malformed tool schemas fail the whole session and close already connected servers.

## 5. Tool naming, schema, and policy

An MCP tool named `github_list_repos` from server `github` becomes `mcp__github__github_list_repos`. The alias is stable, bounded, and valid for model provider tool names. Koda retains a process-local mapping to the original server and tool name; the stable alias is what appears in model requests and JSONL conversation items.

The model receives the MCP tool's original object `inputSchema`. Koda's registry first validates that arguments are a JSON object; the MCP SDK and server remain responsible for complete JSON Schema validation. Empty descriptions receive a deterministic fallback that identifies the source server.

MCP annotations are untrusted hints and never grant authority. Every MCP tool defaults to Koda effect `execute`, which requires approval under `on-request` and is denied under `never`. A server config may explicitly classify named, reviewed tools as `read`; only those tools bypass approval. Phase 3B does not expose an MCP-specific `write` classification because external writes do not share the workspace-confined semantics of Koda's patch tool.

Approval previews identify the MCP server, original tool, stable alias, and bounded formatted arguments. Approval is still decided by `EffectToolPolicy` and the transport-specific broker; MCP cannot request or cache approval itself.

## 6. Invocation, outputs, and errors

When the model calls an MCP alias, the adapter invokes the owning client's `callTool` with the original name and unchanged JSON arguments. Each call is bound to the turn abort signal and a configured Phase 3B timeout. MCP tools are registered as exclusive because arbitrary external tools may share server session state. The current agent loop executes tool calls serially; the exclusive declaration preserves that safety constraint if a later scheduler introduces parallel execution.

The complete MCP result is normalized into JSON containing `content`, optional `structured_content`, optional resource links or embedded resources, and the `is_error` flag. Binary content is represented by bounded metadata in Phase 3B rather than being copied unbounded into JSONL. The normalized JSON is serialized deterministically and passed through `ArtifactStore.materializeText`. Small results return parsed JSON inline; oversized results return a bounded textual excerpt plus byte counts and an artifact reference that can be read with the existing `read_artifact` tool.

An MCP result with `isError: true` becomes a Koda tool error with code `MCP_TOOL_ERROR`; it does not fail the turn. Startup, protocol, timeout, disconnect, invalid-result, and output-limit failures use stable bounded error codes and messages. Error messages never include environment values or full process environments.

## 7. Lifecycle and recovery

Each configured server follows:

```text
configured -> starting -> connected -> ready -> closing -> closed
                         \-> failed
```

Startup has a bounded timeout covering spawn, initialize, and initial discovery. The tool catalog is frozen for the turn; `tools/list_changed` is not applied until a later turn creates a new session. Shutdown closes clients in reverse startup order and is best effort across all servers. An initialization failure rolls back previously connected servers before the turn reports failure.

Koda never automatically retries an MCP tool. If a read fails, the model may decide to call it again. Once an approved external tool crosses the existing durable `tool.execution_started` boundary, a crash or disconnect before its durable result leaves an unmatched effectful call. Existing recovery reconstructs it as an uncertain tool call and warns the next turn that the external side effect may already have happened. Koda does not reconnect to an old MCP session, infer completion, or replay the call.

## 8. Testing and acceptance criteria

Offline tests use repository-owned minimal MCP fixture servers and cover:

- strict configuration, absent-default behavior, explicit missing files, safe IDs, absolute working directories, argv transport, and environment allowlists;
- initialize, paginated tool discovery, deterministic aliases, invalid schemas, collisions, and catalog limits;
- successful calls, server `isError`, protocol errors, timeouts, disconnects, cancellation, and invalid results;
- default execute approval, explicit read classification, and denial under approval mode `never`;
- bounded approval previews, output artifact materialization, and binary-content metadata;
- startup rollback, reverse idempotent close, EOF/shutdown cleanup, and different-turn isolation;
- interrupted effectful MCP calls appearing in conservative recovery without replay;
- unchanged CLI and app-server behavior when no MCP config exists;
- a real stdio MCP fixture smoke test and all existing offline gates.

Phase 3B is complete when a local configured MCP tool can participate in the same model/tool/model loop as native tools, all external effects remain under Koda policy, outputs remain bounded and retrievable, every owned subprocess is cleaned up, interrupted calls recover conservatively, and all repository checks pass without external credentials or services.

## 9. Deferred destinations

- Streamable HTTP, OAuth, remote MCP hosting, shared sessions, network policy, and multi-client lifecycle: Phase 4 distribution and hardening.
- MCP resources, prompts, subscriptions, sampling, elicitation, and dynamic tool refresh: later Phase 3 slices after measured product need.
- User-facing MCP configuration management through app-server or UI: a later Phase 3 client API slice; Phase 3B reads local configuration only.
- Per-tool concurrency declarations, trusted server profiles, and approval caching: later Phase 3 policy work.
- Cross-turn MCP session reuse and resumable asynchronous MCP tasks: deferred until lifecycle and isolation scenarios justify the complexity.
