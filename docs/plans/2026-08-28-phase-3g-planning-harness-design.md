# Koda Phase 3G: Durable Planning and Harness Checkpoints

- Status: Implementation in progress — Phase 3G1 implemented and verified
- Date: 2026-08-28
- Depends on: Phase 2 durable resume and compaction, Phase 3A app-server, Phase 3D Ink interaction, Phase 3E context inspection, and Phase 3F durable execution boundaries
- Scope: thread-scoped Plan/Todo state, explicit model updates, safe long-task checkpoints, resumable paused turns, and human stage acceptance

## 1. Outcome

Phase 3G turns planning from prompt convention into durable runtime state. A model maintains a bounded thread-scoped plan through one built-in `update_plan` control tool. Koda validates every transition, assigns a monotonic revision, appends the accepted state to the thread JSONL log, and exposes the result to providers and clients. Model prose, terminal rendering, and disposable indexes are never authoritative for plan state.

The plan spans turns. Context compaction may summarize prior discussion, but it cannot discard the latest plan. Resume reconstructs the newest valid plan and the last safe checkpoint from JSONL, then supplies both alongside existing recovery evidence. An interrupted tool is never replayed automatically and never becomes completed merely because its Todo was active.

Long tasks gain logical checkpoints at durable safe boundaries. Normal checkpoints do not interrupt a running turn. When a configured hard step or time budget is reached, the Harness pauses at the nearest safe boundary instead of reporting `MAX_STEPS_EXCEEDED` as an unrecoverable failure. Continuing remains explicit in Phase 3G; unattended background scheduling, reconnectable remote jobs, and automatic process-restart continuation remain later work.

Stages may require human acceptance. The model may prepare evidence and reach `awaiting_acceptance`, but only a live user decision can produce `accepted`. Acceptance is a workflow decision, not a reusable execution capability, and therefore has a dedicated broker and protocol rather than approval grants.

## 2. Alternatives and decision

Three plan-ownership approaches were considered:

1. **Model calls a built-in control tool and Runtime validates and persists — selected.** Updates are explicit, provider-neutral, auditable, bounded, and reconstructable without parsing prose.
2. **Runtime infers progress from assistant text and tool activity — rejected.** A tool result does not prove that a larger task is complete, and provider wording is not a stable state protocol.
3. **Only the user edits plans — rejected as the primary path.** It is controllable but prevents the agent from maintaining execution state during long autonomous work. Users continue to steer through normal messages and acceptance feedback.

Three persistence approaches were also considered:

1. **Append plan events to the authoritative thread JSONL — selected.** This gives plan, tool, approval, cancellation, and recovery evidence one total order.
2. **Write a mutable per-thread plan sidecar — rejected.** It creates crash windows and reconciliation rules between the sidecar and JSONL.
3. **Store plans only in SQLite — rejected.** The existing SQLite data is a rebuildable projection and must not become a second source of truth.

Phase 3G uses explicit continuation after a safe pause. Automatically starting more turns after a process restart would require a durable job scheduler, ownership leases across app-server lifetimes, reconnect semantics, and background process policy. That boundary belongs to Phase 4.

## 3. Component boundaries

Plan state belongs to one Thread, not one Turn. A Turn may create or update the plan many times, and later Turns continue the latest valid revision.

- `@koda/protocol` owns Plan, Stage, Todo, Checkpoint, acceptance, event, app-server v11, and stable error schemas.
- `@koda/agent-core` owns the state reducer contract, plan-aware Harness behavior, provider-context injection, checkpoint ordering, and paused-turn result.
- `@koda/runtime-node` owns the built-in `update_plan` implementation, durable reconstruction, corruption validation, and Node composition.
- `@koda/app` exposes thread plan reads and composes plan recovery into start/resume without importing TUI behavior.
- `koda-app-server` owns the transport-facing pending-acceptance registry and protocol v11 request lifecycle.
- `@koda/app-server-client-node` exposes typed plan reads and acceptance resolution.
- `koda` renders terminal acceptance for the one-shot CLI.
- `koda-chat` renders `/plan`, checkpoints, paused state, and acceptance cards while keeping presentation state outside the runtime.

JSONL remains authoritative. SQLite may later project plan titles or status for search, but Phase 3G does not require that projection. Plan inspection never starts a Provider, MCP server, or command.

## 4. Domain model and budgets

The durable snapshot is versioned independently from the JSONL envelope:

```ts
interface PlanSnapshotV1 {
  schemaVersion: 1;
  planId: string;
  revision: number;
  objective: string;
  status: "active" | "completed" | "cancelled";
  stages: PlanStage[];
}

interface PlanStage {
  id: string;
  title: string;
  status:
    "pending" | "active" | "awaiting_acceptance" | "completed" | "accepted";
  requiresAcceptance: boolean;
  acceptanceCriteria: string[];
  summary?: string;
  evidence: PlanEvidenceReference[];
  todos: PlanTodo[];
}

interface PlanTodo {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "blocked" | "completed" | "cancelled";
  outcome?: string;
  blockedReason?: string;
  cancellationReason?: string;
  reopenReason?: string;
}
```

Stable IDs are opaque bounded strings generated by the model on creation and immutable thereafter. IDs are unique within the Plan. Runtime assigns `planId` on first creation and every positive revision. `update_plan` accepts `expected_revision`, using zero only when no plan exists, and rejects stale replacement with `PLAN_REVISION_CONFLICT`.

The model submits the complete objective and Stage/Todo draft. Runtime derives Stage and Plan status where possible instead of trusting contradictory aggregate fields. `accepted` is never accepted from model arguments; it can be produced only by the acceptance path.

Hard limits are:

- 32 Stages;
- 64 Todos per Stage;
- 256 Todos across the Plan;
- 32 acceptance criteria per Stage;
- 32 evidence references per Stage;
- 256 KiB canonical JSON for one snapshot;
- independently bounded IDs, titles, objective, reasons, outcomes, summaries, and acceptance feedback by UTF-8 bytes.

Evidence references point only to bounded durable identifiers already authorized to the Thread, such as Conversation Item IDs, Tool Call IDs, Artifact IDs, or event sequences. Plan snapshots do not copy command output or artifact bodies.

## 5. Todo and Stage state machine

Todo transitions are explicit:

```text
pending ───────→ in_progress ───────→ completed
   │              │    ↑  │                  │
   └→ cancelled   └→ blocked                └→ in_progress (reopen)
                       │
                       └→ cancelled
```

A blocked Todo must return through `in_progress` before completion; it cannot jump directly from `blocked` to `completed`.

The following invariants apply:

- At most one Todo across the entire Plan is `in_progress`.
- An `in_progress` Todo must belong to the first nonterminal Stage.
- `blocked` requires `blockedReason` and cannot coexist with an `in_progress` Todo in a later Stage.
- `completed` requires `outcome`.
- Reopening `completed` requires a new non-empty `reopenReason`.
- Cancelling started work requires `cancellationReason`.
- A started, completed, blocked, or cancelled Todo cannot disappear from a later revision. Pending Todos may be replaced only while their Stage has not started.
- A Stage that has started cannot be removed or moved behind a later started Stage.

Stage state is derived from its Todos and acceptance record:

```text
pending → active → completed
                    or
pending → active → awaiting_acceptance → accepted
```

Only the first nonterminal Stage may be active. When every non-cancelled Todo is completed, a Stage without an acceptance gate becomes `completed`; a gated Stage becomes `awaiting_acceptance`. Later Stages remain locked until the current Stage is terminal. A locked-stage tool update returns `PLAN_STAGE_LOCKED` as a recoverable result.

Rejecting acceptance records feedback but does not guess which Todo is wrong. The model receives the structured rejection and must submit a new revision that returns the Stage to `active` and reopens or adds at least one Todo. Accepting creates a Runtime-authored revision with `accepted`. The Plan becomes `completed` only when every Stage is `completed` or `accepted`.

## 6. Built-in `update_plan` control tool

`update_plan` is a built-in Koda control tool. It is not MCP-discoverable, cannot be shadowed by an external alias, and does not modify workspace files, start a process, call a Provider, or access the network.

Phase 3G adds `control` to the internal tool-effect vocabulary. Only reviewed built-in registrations may use it. The default policy allows control effects without human execution approval; MCP tools and unknown tools cannot claim this classification. Control tools still obey argument validation, cancellation, output limits, event persistence, and tool-call/result ordering.

The tool arguments contain:

```ts
{
  expected_revision: number;
  objective: string;
  explanation?: string;
  stages: Array<{
    id: string;
    title: string;
    requires_acceptance: boolean;
    acceptance_criteria: string[];
    summary?: string;
    evidence: PlanEvidenceReference[];
    todos: Array<{
      id: string;
      title: string;
      status: "pending" | "in_progress" | "blocked" | "completed" | "cancelled";
      outcome?: string;
      blocked_reason?: string;
      cancellation_reason?: string;
      reopen_reason?: string;
    }>;
  }>;
}
```

Runtime normalizes field naming into the protocol representation, validates the full candidate against the prior snapshot, assigns the next revision, and persists `plan.updated` before returning success. The result contains the accepted canonical snapshot and derived active Stage/Todo. Invalid transitions are ordinary recoverable tool errors so the model can correct its call without failing the Turn.

Plan update persistence is fail-closed. If `plan.updated` cannot be appended, the update does not become visible and the tool cannot report success. If the update is durable but a later tool-result event fails, the plan revision remains authoritative and recovery reconstructs it.

## 7. Provider context and compaction

Before every Provider request, the Context Engine includes exactly one latest plan-state representation when a Plan exists. It is derived from the authoritative snapshot and has a deterministic identity tied to `planId` and `revision`. Provider adapters map it to a bounded developer-level planning context; it is never presented as a user message.

Historical `update_plan` calls and tool results remain ordinary Conversation Items and may be compacted with other history. The active plan representation is pinned independently and cannot be summarized away. Context budgets account for its exact estimated size. If the Plan plus mandatory instructions and tool definitions cannot fit, preparation fails with the existing bounded context error instead of silently truncating the plan.

Phase 3E context inspection is upgraded to reconstruct and validate this injected plan state. Request digests must include it. A plan event/order mismatch therefore fails exact context inspection rather than producing a plausible but unverified request view.

All supported Provider adapters receive the same normalized `update_plan` schema. Provider-specific continuation state remains unchanged and cannot become the source of plan truth.

## 8. Safe checkpoints and paused turns

A checkpoint is logical execution evidence, not a filesystem, process, Git, or model-state snapshot:

```ts
interface PlanCheckpoint {
  checkpointId: string;
  planId: string;
  planRevision: number;
  activeStageId?: string;
  activeTodoId?: string;
  lastSafeSequence: number;
  reason:
    | "plan_update"
    | "tool_completion"
    | "stage_acceptance"
    | "turn_completion"
    | "safe_pause";
  completedSummary?: string;
  nextAction?: string;
  evidence: PlanEvidenceReference[];
}
```

Runtime appends `plan.checkpointed` only after a provable safe boundary:

- a durable plan update;
- a matching durable `tool.completed`;
- a durable stage-acceptance transition;
- normal Turn completion; or
- a requested pause when no execution is in flight.

`tool.execution_started` without matching `tool.completed` forbids a newer checkpoint for that call. Cancellation during an execution uses the previous checkpoint and existing uncertain-call evidence. Checkpoints never claim that an active Todo is complete.

Normal checkpoints do not interrupt the AgentLoop. The Harness has a soft budget that asks the model to update its plan and a bounded hard step/time budget. At the hard boundary, it stops only after the current safe unit, writes a `safe_pause` checkpoint, records `turn.paused`, and returns a `paused` RunTurn result instead of `MAX_STEPS_EXCEEDED`. A non-terminating Provider or tool remains governed by existing timeout and cancellation behavior; the Harness does not wait forever to manufacture a safe pause.

Phase 3G does not automatically launch another Turn. The CLI and Ink client show how to continue the same Thread. A resumed Turn receives the plan, checkpoint, and normal recovery notice.

## 9. Recovery semantics

`recoverThread` validates Plan revisions and checkpoints together with the existing event stream:

1. Revisions for one `planId` must be contiguous and strictly increasing.
2. Every update must satisfy the state-machine transition from the previous revision.
3. A checkpoint must reference an existing revision and a prior safe sequence in the same Thread.
4. Acceptance events must match the exact Plan revision and Stage.
5. A partial trailing JSONL line may be discarded under the existing rule, but a complete invalid Plan event makes automatic recovery fail closed.

Recovery returns the latest Plan, last valid checkpoint, previous Turn status, and uncertain execution evidence. If an `in_progress` Todo crosses an interrupted execution boundary, the snapshot is not mutated. The recovery projection adds `needsRevalidation: true` for provider/client presentation. This flag is recovery metadata, not a silently created Plan revision.

The next model request is instructed to inspect durable tool results and current workspace state before deciding whether to complete, reopen, block, or continue the Todo. Koda never automatically replays an uncertain command, write, MCP call, plan update, or acceptance request.

Legacy logs without Plan events recover exactly as before. No migration is required. A log with a Phase 3G capability marker but corrupt Plan ordering is invalid for automatic resume.

## 10. Stage acceptance lifecycle

Entering `awaiting_acceptance` through `update_plan` creates a dedicated acceptance request after the Plan revision and checkpoint are durable. The tool call waits through a `PlanAcceptanceBroker`, analogous to the existing interactive approval wait but with separate types and registries.

Event order is:

```text
plan.updated (awaiting_acceptance)
plan.checkpointed
plan.acceptance_requested
<user decision>
plan.acceptance_resolved
plan.updated (accepted) | model receives changes requested
plan.checkpointed (accepted only)
tool result
tool.completed
```

An acceptance request includes the Thread, Turn, Tool Call, Plan revision, Stage ID, criteria, summary, and bounded evidence references. The client decision must match all identities. Reusing a response against a newer revision fails with `PLAN_ACCEPTANCE_STALE`.

Acceptance creates the Runtime-authored `accepted` revision only after `plan.acceptance_resolved` is durable. Rejection durably stores bounded feedback and returns a structured `changes_requested` result to the model. The model must then produce a valid active revision with reopened or new work.

Client disconnect, Turn cancellation, broker failure, malformed response, timeout, and app-server shutdown never imply acceptance. The Stage remains `awaiting_acceptance`; recovery may issue a new request in a later Turn. Acceptance grants do not exist and approval grants cannot authorize acceptance.

## 11. App-server protocol v11 and clients

Protocol v11 replaces the current pre-release v10 surface and advertises:

```ts
{
  planning: true,
  planCheckpoints: true,
  stageAcceptance: true
}
```

It adds strict bounded methods:

- `plan/get`: returns the latest authorized Plan, last checkpoint, and recovery metadata for one Thread after workspace validation;
- `plan/acceptance/resolve`: resolves one live pending request by exact Thread, Turn, Tool Call, Plan revision, and Stage identity.

The existing durable event notification stream carries `plan.updated`, `plan.checkpointed`, `plan.acceptance_requested`, `plan.acceptance_resolved`, and `turn.paused`. No process-local notification becomes authoritative. `plan/get` rereads and validates JSONL; it does not trust controller state.

The Ink client adds `/plan` with a bounded Stage/Todo view, current revision, active work, last checkpoint, blocked reasons, outcomes, and acceptance evidence. The normal chat status shows only a compact active-step summary. An acceptance card uses `y` to accept and `n` to request changes with a bounded reason. Layered Escape behavior and generation-based stale-response rejection follow the existing thread/context views.

The one-shot CLI renders criteria, summary, and evidence, then accepts only explicit `y` or `yes`; rejection requires or supplies a bounded reason. EOF, input error, cancellation, and all other answers fail closed. Non-interactive input cannot auto-accept a gated Stage and leaves it resumable.

## 12. Stable failures

Expected model or client mistakes are stable recoverable failures:

- `PLAN_INVALID`
- `PLAN_TRANSITION_INVALID`
- `PLAN_REVISION_CONFLICT`
- `PLAN_STAGE_LOCKED`
- `PLAN_ACCEPTANCE_NOT_PENDING`
- `PLAN_ACCEPTANCE_STALE`
- `PLAN_LIMIT_EXCEEDED`
- `PLAN_CHECKPOINT_INVALID`
- `PLAN_RECOVERY_INVALID`

Protocol shape errors remain `INVALID_PARAMS`. Missing or unauthorized Threads use the existing thread/workspace failures. Durable append failure is not downgraded to a plan validation error; the Turn fails conservatively through the existing event-persistence boundary.

Error messages contain stable bounded context such as revision and Stage/Todo ID but never copy oversized plan bodies, artifact contents, repository instructions, credentials, or raw provider state.

## 13. Verification matrix

Offline tests cover:

1. Plan/Stage/Todo schemas, UTF-8 budgets, count limits, canonical size, and stable IDs.
2. Every valid and invalid Todo transition, reopen/cancel reasons, single-active-Todo, and Stage locking.
3. Runtime-derived Stage/Plan status and user-only `accepted` transitions.
4. `expected_revision` creation, sequential update, and stale replacement.
5. Built-in-only control effect, external shadowing rejection, no approval prompt, and provider tool schemas.
6. Event-before-result ordering and injected failures before and after `plan.updated`.
7. Checkpoint safe boundaries, no checkpoint across incomplete execution, and checkpoint reference validation.
8. Soft-budget prompting, hard-budget `turn.paused`, explicit continuation, cancellation, timeout, and non-terminating tool behavior.
9. Completed, failed, cancelled, paused, interrupted, and partial-trailing-line recovery with active Plans.
10. `needsRevalidation` for uncertain calls without mutating the recovered Plan.
11. Compaction retaining exactly one current Plan and Phase 3E request-digest reconstruction.
12. Acceptance, changes requested, stale/double resolution, disconnect, shutdown, timeout, cancellation, and persistence failure.
13. Protocol v11 strictness, capability negotiation, result budgets, workspace authorization, and JSONL rereads.
14. Node client request correlation and event parsing.
15. Ink `/plan`, status summary, acceptance card, feedback input, resize, navigation, Escape, and stale async responses.
16. CLI explicit acceptance, rejection, EOF, and unavailable input.
17. OpenAI, Anthropic, DeepSeek, Kimi, and GLM conformance for the normalized tool and injected plan context.
18. Existing format, typecheck, offline suite, reliability scenarios, subprocess integration, and real TTY smoke gates.

No live provider credentials are required for the Phase 3G acceptance suite.

## 14. Implementation slices

### Phase 3G1: protocol and reducer

Status: **Implemented and verified (2026-08-28).**

- Add Plan, checkpoint, acceptance, and paused-turn schemas and exports.
- Implement a pure revision/state reducer with budgets and stable failures.
- Add exhaustive offline state-machine tests.

Implemented with first-class protocol schemas and Agent Event variants, a pure `@koda/agent-core` revision/acceptance reducer, stable validation failures, and 21 focused state-machine tests. The full repository typecheck, format gate, 337-test offline suite, and six reliability scenarios pass. Runtime tool registration, event emission, checkpoint execution, and recovery consumption remain Phase 3G2.

### Phase 3G2: Harness, tool, checkpoint, and recovery

- Add the built-in `control` effect and `update_plan` registration.
- Persist plan events in the AgentLoop ordering boundary.
- Pin current Plan context across compaction.
- Add safe checkpoints, plan-aware budgets, `turn.paused`, and recovery validation.

### Phase 3G3: application and protocol v11

- Add application Plan reads and acceptance composition.
- Upgrade app-server/client schemas, capabilities, methods, events, and lifecycle.
- Add acceptance concurrency, stale-resolution, disconnect, and result-budget coverage.

### Phase 3G4: CLI and Ink interaction

- Add `/plan`, bounded Plan/checkpoint rendering, active-step status, and acceptance cards.
- Add one-shot terminal acceptance and fail-closed input behavior.
- Add controller, view, subprocess, and TTY coverage.

### Phase 3G5: closure

- Run all provider conformance, compaction/recovery, crash, reliability, app-server, client, CLI, Ink, and real TTY gates.
- Update architecture and roadmap status only after every gate passes.

Each slice must pass format, typecheck, and its focused tests before the next slice begins.

## 15. Deliberate deferrals

- Unattended background continuation, durable job scheduling, reconnect/resubscribe, remote workers, and automatic restart: Phase 4.
- Filesystem snapshots, Git checkpoints, automatic commits, and crash-surviving process supervision: separate Phase 4 hardening designs.
- Direct rich Plan editing by clients, reusable plan templates, cross-thread plan cloning, and shared plans: later measured workflow slices.
- Skills, command templates, dynamic tool discovery, and plugin lifecycle: Phase 3H.
- Child-agent plan delegation, parent/child progress aggregation, worktrees, mailboxes, and shared memory: Phase 5.

## 16. Acceptance criteria

Phase 3G is complete only when:

- a model can create and evolve a bounded plan solely through `update_plan`;
- invalid transitions cannot enter durable state;
- plan, tool, approval, checkpoint, pause, and acceptance evidence share one ordered JSONL history;
- current Plan survives compaction, completed-turn resume, safe pause, cancellation, and process interruption;
- incomplete effects remain uncertain and are never replayed or marked complete automatically;
- gated Stages cannot advance without an exact live user acceptance;
- app-server v11, Node client, CLI, and Ink expose the same authoritative state;
- all supported Provider adapters receive equivalent plan semantics; and
- the complete offline, reliability, subprocess, and real TTY gates pass without credentials.
