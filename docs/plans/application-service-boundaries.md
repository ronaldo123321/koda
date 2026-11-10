# Application service boundaries

`KodaApplication` remains the public application facade used by CLI and app-server.
The extraction preserves its method signatures and re-exports existing query
interfaces and `ThreadHistoryError` from their original entry point.

- `ThreadHistoryService` owns authoritative event-log reads, corruption checks,
  bidirectional cursor pagination, and response byte limits. It does not read the
  metadata database or execute turns.
- `ThreadQueryService` owns metadata index acquisition, refresh and closure for
  list/get/search operations and post-turn metadata refresh. Query results retain
  index diagnostics and corruption-recovery information. Indexes are always
  closed in `finally`, including failures in the recovery callback.
- `ChildTaskService` registers per-turn delegation, spawn, wait, steer, interrupt
  and worktree tools. It owns durable-start waiting and owned historical child
  lookup. It receives a child-application factory and the existing shared
  `ChildRegistry`; registry lifetime, parent cancellation, timeout cleanup and
  active-child limits remain unchanged. Restricted child applications still
  cannot delegate recursively.
- `TurnExecutionService` owns a turn's workspace validation, lease, mutation
  recovery, tool registration, provider/context construction, AgentLoop and ordered
  resource cleanup. Its host supplies application-lifetime registries, configuration,
  child construction and metadata refresh. It does not own global mutable state.
- `KodaApplication` retains public input validation, turn handles, child-application
  construction, inspection APIs and diagnostic delivery. Post-turn metadata refresh
  uses the captured run configuration; ad-hoc reads resolve the current configured
  Koda home at query time.
- `application-helpers` shares instruction assembly, completion mapping and best-effort
  diagnostics between the facade and executor without a runtime circular dependency.

The metadata database remains rebuildable from event logs. This refactoring does
not introduce a second source of truth, a long-lived database connection, or a
new RPC surface. Planning, artifacts and context inspection continue to use the
validated history service through the facade.

Execution cleanup remains in the executor's `finally`: project notes, MCP session,
plugin session, thread lease, then metadata refresh. Exceptions and cancellation
map to the same TurnCompletion contract. Existing application, IPC and scenario
coverage exercises this through the public facade.
