# Phase 4C4A Resource Policy Contract and Evidence

- Status: In progress — C4A1 standalone contracts and C4A2 trusted
  admission/durability complete; C4A3 client projection/acceptance remains
- Date: 2026-08-31
- Depends on: Phase 4C1 execution-policy admission, Phase 4C2 native sandbox
  enforcement, and Phase 4C3 secret lifecycle and client projection

## Decision summary

Phase 4C4A introduces the strict, cross-runtime contract for resource limits
before Koda claims that any operating-system resource backend is active. It
defines what a command requests, what a frozen executor capability can provide,
and what a Worker actually applies as three separate facts. No client may infer
resource enforcement from a platform name, timeout, output truncation, sandbox
backend, exit signal, or process ownership.

The first contract covers five explicitly scoped limits:

- `process_cpu_time_ms`: CPU time consumed by one process;
- `process_address_space_bytes`: virtual address space of one process;
- `job_process_count`: simultaneously live processes in the owned job tree;
- `process_open_files`: open file descriptors or handles in one process; and
- `process_file_size_bytes`: maximum size of one file written by one process.

The names deliberately expose scope. Koda does not describe a per-process
`rlimit` as a job-tree memory or CPU guarantee. Wall-clock `timeoutMs` and
bounded captured output remain lifecycle and persistence controls. They are
reported beside resource evidence but are not resource-enforcement claims.

Phase 4C4A adds no native enforcement backend. A command without resource
requirements continues to run. A command that requests any resource limit is
rejected before user code starts because the C4A capability descriptor reports
those limits as unsupported. Phase 4C4B will add macOS enforcement where exact
semantics are available; Phase 4C4C will add Linux cgroup v2 and `rlimit`
enforcement. Windows implementation remains deferred and receives only strict
compatibility and rejection coverage in C4A.

## Policy contract

`ExecutionPolicy` advances from schema v1 to v2 and gains an optional, strict
`resources` object. Each present field is a positive, bounded safe integer in
the unit named by that field. Missing `resources`, or an empty object after
trusted resolution, means no resource limits were requested. Koda does not add
implicit quotas in this slice.

Unknown keys, zero, negative values, floating-point values, non-finite values,
and values outside the shared TypeScript/Rust bounds fail with
`INVALID_EXECUTION_POLICY`. The exact bounds are protocol constants exercised
by shared fixtures. Canonical serialization uses fixed field order and decimal
integers so TypeScript and Rust calculate identical policy digests.

Trusted application profiles may declare the five fields. User/model command
input cannot raise, remove, or replace them. The normalized v2 policy participates
in command preparation, approval text, policy digest, and exact-command grant
binding. Any resource-policy change invalidates a previously issued grant even
when argv, cwd, filesystem, environment, and network policy are unchanged.

Historical v1 policies remain readable. New trusted configuration resolves to
v2, including profiles that do not request resource limits, so new execution
records have one unambiguous current contract. An absent resource field in a v1
record means the record predates resource evidence; it must not be presented as
`not-requested` or `applied`.

## Capability and evidence contract

Execution capabilities advance to schema v4. The v4 descriptor preserves the
verified macOS Seatbelt or Linux Bubblewrap fields and adds strict
`resource_limits` support entries for all five names. Each entry reports either
`unsupported` or a fixed backend, scope, enforcement kind, and granularity.
Capability digests cover the complete descriptor.

C4A emits `unsupported` for every resource entry on every platform. Future
backends must express only semantics they actually enforce. Observation plus a
later kill is not equivalent to a kernel hard limit and must use a different
enforcement kind if it is ever introduced.

Execution-security snapshots advance to schema v4 and carry `resources` with
three distinct layers:

- `requested` is the normalized policy requirement;
- `available` is the frozen capability subset evaluated at admission; and
- `applied` is present only after the Worker verifies an active backend before
  releasing user code.

Each layer has a deterministic digest. `not-requested` is an explicit current
v4 state. It is different from an absent field in historical evidence. A
requested C4A policy never reaches an applied snapshot because admission fails.
Clients copy retained evidence and never reconstruct it from current host
capabilities.

## Admission and runtime data flow

Trusted application configuration resolves a v2 policy before command
preparation. Preparation freezes its digest into the approval request and any
grant. Immediately before native start, the runtime compares every requested
limit with the Supervisor capability snapshot. An unsupported or weaker scope
fails before a native job is created.

The native protocol advances from v5 to v6. For admitted commands, the
Supervisor persists the v4 admission snapshot before handing the request to a
Worker. The Worker reparses the strict policy, obtains the capability descriptor
from the authenticated runtime boundary, recalculates all digests, and requires
an exact match with retained admission. Capability drift or payload tampering
fails before spawn.

The durable store advances from format v5 to v6 and persists v4 snapshots in
the job manifest and terminal result. Formats v1 through v5 remain read-only
compatible without implicit upgrade. A new Supervisor serves protocol v6 only;
Koda does not retain a parallel pre-release v5 execution path.

The app-server protocol advances from v16 to v17 and advertises
`resourceEvidence: true`. Foreground results, PTY start/read/terminate results,
process summaries, and process lifecycle events carry the same optional strict
resource evidence. CLI and TUI use one shared bounded formatter. Historical
absence is displayed as unknown only when relevant; it is never displayed as a
successful limit.

## Failure rules

- Malformed policies and evidence use `INVALID_EXECUTION_POLICY` or
  `EXECUTION_SECURITY_CORRUPT` at their existing trust boundaries.
- A well-formed request that the frozen capability cannot enforce uses
  `RESOURCE_LIMIT_UNAVAILABLE` and names only the unsupported public limit.
- Policy, capability, or layer-digest drift uses `EXECUTION_POLICY_CHANGED`.
- `RESOURCE_LIMIT_APPLY_FAILED` is reserved for Phase 4C4B and later, when an
  advertised backend can fail during application. C4A never fabricates it.
- Rejection is pre-spawn. Tests use a sentinel side effect to prove that user
  code did not run.
- Errors and public evidence contain limits, backend identifiers, digests, and
  statuses only. They do not expose unrelated host resource state.

## Client presentation

The shared formatter reports requested limit names and bounded values, followed
by `not requested`, `unavailable`, or the retained enforcement status. It does
not print complete capability objects or imply that timeout/output controls are
kernel quotas. App-server clients receive the full strict safe object for audit
and automation.

Old clients are protected by the app-server v17 negotiation boundary. Old
durable records remain readable, and old events without resource evidence retain
their historical meaning. Present but malformed v4 evidence fails closed rather
than being dropped from a result or process summary.

## Implementation sequence

1. **C4A1 — standalone contracts:** TypeScript/Rust policy v2, capability and
   snapshot v4 schemas, canonical serialization, digests, bounds, and shared
   golden fixtures.
2. **C4A2 — trusted admission and durability:** application profile resolution,
   approval/grant binding, native protocol v6, Supervisor/Worker revalidation,
   durable format v6, and formats v1-v5 recovery.
3. **C4A3 — projection and acceptance:** app-server v17, result/event/process
   projection, shared CLI/TUI formatting, pre-spawn rejection evidence, and the
   same-commit platform CI matrix.

No sequence item enables an operating-system resource backend. Phase 4C4A is
complete only when all three items pass together.

### C4A1 closure

C4A1 is complete. TypeScript and Rust now share strict policy-v2 resource
limits, schema-v4 capability/snapshot contracts, fixed canonical field order,
SHA-256 digests, unsupported-resource capability wrappers over generic,
macOS Seatbelt, and Linux Bubblewrap isolation contracts, and fail-closed
`RESOURCE_LIMIT_UNAVAILABLE` evaluation. Empty resource objects normalize to
the same bytes as omission, while policy v1 rejects any resource field.

At the C4A1 implementation commit, the runtime application resolver deliberately
remained on policy v1 and native protocol/durable/app-server versions remained
v5/v5/v16. Therefore that slice changed no command execution behavior and
advertised no resource backend. The trusted admission and durability wiring is
closed separately by C4A2 below.

Implementation commit `ca5c5a9` passed `verify`, `linux-native`,
`macos-native`, and `windows-native` in
[GitHub Actions run 33357380456](https://github.com/ronaldo123321/koda/actions/runs/33357380456).

### C4A2 closure

C4A2 is complete. Trusted typed application configuration is parsed as a
strict resource-aware shape, copied and deeply frozen at the resource boundary,
and resolved to policy v2 even when no limit is requested. Preparation and
approval now show the resource request, the complete policy digest participates
in exact-command grant identity, and both the TypeScript fallback and native
runtime expose schema-v4 capability wrappers over their existing isolation
contracts.

Native protocol v6 carries the current policy and capabilities. The Supervisor
persists schema-v4 admission evidence before Worker handoff; the Worker
reconstructs the authenticated generic, macOS Seatbelt, or Linux Bubblewrap
capability, recalculates admission, and requires an exact match before spawn.
Durable format v6 accepts only current schema-v4 evidence, while formats v1
through v5 remain readable and retain their original format and historical
evidence during transitions.

All five resource names still report `unsupported`. Each well-formed request
therefore returns `RESOURCE_LIMIT_UNAVAILABLE` before native job creation, and
sentinel tests prove user code does not run. Commands without resource limits
continue through Pipe, PTY, background, sandbox, secret, restart, and recovery
paths with explicit `not_requested` evidence. C4A2 adds no OS resource backend
and does not project resource evidence through app-server/CLI/TUI; that remains
C4A3.

Implementation commit `9395da3` passed `verify`, `linux-native`,
`macos-native`, and `windows-native` in
[GitHub Actions run 33365855082](https://github.com/ronaldo123321/koda/actions/runs/33365855082).

## Acceptance

Shared TypeScript/Rust golden fixtures cover canonical JSON, digest equality,
field ordering, every numeric boundary, empty and partial policies, and unknown
key rejection. Application tests cover trusted configuration, attempted model
override, approval text, grant invalidation, and unchanged behavior without a
resource request.

Native tests cover protocol v6 framing, Supervisor and Worker admission,
capability drift, digest tampering, unsupported limits, and a sentinel proving
that failed admission never starts user code. Durable tests cover current v6
round trips, corruption rejection, and exact reading of formats v1 through v5.

App-server, CLI, and TUI tests cover strict optional projection, bounded
formatting, historical absence, and protocol v17 negotiation. macOS, Linux, and
Windows CI run the same contract and fixed-rejection matrix. Existing Pipe,
PTY, background, attach, resize, restart, timeout, output, sandbox, and secret
acceptance must remain green when no resource limit is requested.

Phase 4C4A does not claim that Koda limits resources. Its security guarantee is
that a requested resource limit cannot run unless the complete chain has
verified support and retained applied evidence; in C4A, such requests fail
closed before execution.
