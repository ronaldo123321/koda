# Koda Phase 2D: Process Ownership, Termination, and Side-effect Recovery

- Status: Implemented (2026-08-26)
- Date: 2026-08-26
- Depends on: Phase 2C context budgets and compaction
- Scope: durable side-effect boundaries, owned foreground process trees, termination escalation, and structured interrupted-operation recovery

## 1. Outcome

Phase 2D makes foreground command termination observable and conservative across timeout, cancellation, output failure, and process loss. Koda records the point at which an approved tool actually begins execution, records an owned process identity after spawn, records every graceful or forced termination attempt, and records whether the owned target was confirmed gone.

Recovery distinguishes an interrupted handler from an operation that crossed the side-effect boundary. It never repeats an incomplete write or command. It also never kills a process solely from a PID stored by an earlier Koda process: operating systems can reuse PIDs, so historical identity is insufficient authority after restart.

## 2. Alternatives and decisions

Three process ownership approaches were considered:

1. **Keep `child.kill`, rejected.** It can leave descendants running and does not explain whether termination was attempted or confirmed.
2. **TypeScript platform controller, selected.** POSIX commands own a dedicated process group. Windows uses the operating-system `taskkill /T` path and explicitly reports best-effort or uncertain outcomes. This fits the current runtime and can be tested without adding a native dependency.
3. **Native Job Objects and a supervisor sidecar, deferred.** This gives the strongest Windows ownership and could survive control-plane failure, but it prematurely introduces the Phase 4 Rust/native execution boundary.

For recovery, durable operational events are selected over putting lifecycle data only in a tool result. Cancellation and process crashes may prevent a result from being written; events must therefore exist independently of the transcript observation.

## 3. Durable event model

Phase 2D adds these version-1 event variants:

- `tool.execution_started`: emitted after policy and approval, immediately before invoking a prepared handler; contains tool effect.
- `process.started`: emitted after a successful OS spawn; contains PID and ownership mechanism.
- `process.exited`: emitted when the root child exits; contains exit code and signal.
- `process.termination_requested`: one event for each graceful or force attempt, including reason and mechanism.
- `process.termination_completed`: contains `terminated`, `already_exited`, or `uncertain`.

The events carry call ID and tool name so recovery can validate their ordering against `tool.started` and `tool.completed`. `tool.started` retains its existing meaning: Koda began handling the model request. It is not proof that a side effect began.

## 4. Active process lifecycle

On POSIX, Koda spawns the root command detached so its PID is also a dedicated process-group ID. Timeout, cancellation, orphan cleanup, or output-capture failure sends `SIGTERM` to the group, waits the configured grace period, then sends `SIGKILL` if the group still exists. Completion is confirmed by probing the group rather than observing only the root child.

On Windows, Koda keeps the child hidden and invokes `taskkill /PID <pid> /T` for the graceful attempt, followed by `/F` when escalation is needed. A missing or failed `taskkill` falls back to direct child termination and records an uncertain tree outcome. True Job Object ownership is not claimed in TypeScript.

Normal foreground completion also checks for descendants on POSIX. Because background sessions are unsupported, remaining group members trigger `orphan_cleanup` before the command result is returned.

A termination confirmation deadline prevents Koda from waiting forever after a failed signal. An unconfirmed process tree is surfaced as `PROCESS_TERMINATION_UNCERTAIN`; it is never silently treated as stopped.

## 5. Agent-core and runtime boundary

`ToolContext` receives a narrow operational-event reporter. Trusted runtime tools use it to report process lifecycle data; the agent loop adds thread, turn, call, name, sequence, and timestamp through the normal recorder. This keeps JSONL ordering authoritative and avoids giving `runtime-node` direct access to the thread store.

The agent loop emits `tool.execution_started` itself immediately before every prepared invocation. For an approval-gated operation this happens only after `approval.resolved: approved`. A denial, rejection, validation error, or crash during preparation therefore cannot be mislabeled as an executed side effect.

`WorkspaceCommandRunner` remains responsible for spawn, output capture, timeouts, and platform termination. `registerExecCommandTool` only maps command lifecycle callbacks to the tool-context reporter.

## 6. Recovery semantics

An incomplete call is classified from the latest turn:

- no `tool.execution_started`: interrupted handling, with no recorded proof of execution;
- execution started with effect `write`: uncertain mutation;
- execution started with effect `execute` but no `process.started`: command launch outcome unknown;
- process started and exited: process is no longer running, but command side effects and missing output remain uncertain;
- termination completed as `terminated` or `already_exited`: owned target is no longer running, but the missing command result remains uncertain;
- missing or `uncertain` termination completion: process state and command outcome are both uncertain.

The typed recovery item extends each uncertain tool entry with optional effect and process state. Its developer notice tells the model to inspect current repository/process state and never automatically repeat the operation.

Legacy logs without `tool.execution_started` keep the Phase 2A conservative behavior based on unmatched `tool.started` events.

## 7. Failure behavior

- Spawn failure before `process.started` returns the existing stable command error.
- Failure to append a lifecycle event is a persistence failure and prevents the runtime from claiming durable progress; an already-started owned process is still terminated before that failure propagates.
- Timeout normally remains a tool observation with `timed_out: true` after confirmed termination.
- Cancellation confirms or attempts termination before `turn.cancelled` is written.
- An unconfirmed active target returns `PROCESS_TERMINATION_UNCERTAIN` and records the uncertainty.
- Recovery rejects impossible event order, mismatched tool names, duplicate process starts/exits, and termination events without a process start.

## 8. Testing and acceptance criteria

Offline tests cover:

- execution-start ordering after approval;
- no execution-start event for policy denial or approval rejection;
- POSIX descendant termination on timeout and cancellation;
- graceful-to-force escalation for a process that ignores `SIGTERM`;
- normal-exit orphan cleanup;
- bounded confirmation and uncertain outcomes;
- lifecycle event ordering and protocol round trips;
- interrupted write, pre-spawn command, exited command, confirmed termination, and uncertain process recovery;
- unchanged output artifacts, context compaction, and CLI resume behavior.

Phase 2D is complete when the active Koda process either confirms its owned POSIX process group is gone or records an explicit uncertainty, Windows termination has an honest tree-aware best-effort path, and resumed threads contain structured side-effect evidence without automatic replay or PID-based reaping.

## 9. Deferred destinations

- Windows Job Objects, crash-surviving supervision, and safe cross-process orphan reaping: Phase 4 Rust executor.
- Managed background services, PTYs, and interactive process sessions: Phase 3.
- Automatic rollback, multi-file transactions, and richer mutation recovery: Phase 3 patch/runtime work.
- Shell strings, pipelines, and redirection: Phase 4 after sandbox review.
- Cross-platform binary scenario fixtures beyond unit/integration coverage: Phase 2F.
