# Koda Phase 4C1 Execution Policy and Isolation Reporting Design

- Status: Approved — C1A implementation in progress; C1B–C1D pending
- Date: 2026-08-30
- Depends on: completed Phase 4B supervised native execution

## Approved compatibility principle

Existing approved, non-sandboxed execution remains available and is explicitly
labeled as having no Koda-enforced OS sandbox. When a caller explicitly requires
isolation, execution must satisfy every requirement or be refused before user
code starts. Approval is not permission to silently discard an isolation
requirement. Native startup, negotiation, or enforcement failure never selects
the TypeScript compatibility backend automatically.

## Scope and non-goals

Phase 4C1 establishes one execution-policy contract, strict admission, durable
security evidence, and honest user-facing reporting. It applies to Koda's
`exec_command` and `exec_terminal` paths, including native Pipe, PTY, foreground,
and background execution, and to the TypeScript command compatibility backend.

It does not install or implement an OS sandbox. It does not cover provider
network calls, MCP servers, plugin processes, or the filesystem tools with a
global isolation claim. Their existing approval and confinement rules remain
unchanged. Scoped secret injection, output redaction, quotas, arbitrary path
grants, shell strings, and remote execution remain separate work.

The threat model is an untrusted command or repository running through the
approved execution path, not an attacker already controlling Koda's trusted
host process or user account. Current process groups, Job Objects, and private
control endpoints remain supervision mechanisms, not evidence of filesystem,
network, or host-process isolation.

## Alternatives

1. **Policy contract, strict admission, and evidence first — selected.** This
   permits incremental OS backends without changing what approval or a reported
   guarantee means. Unsupported requirements are useful negative test cases.
2. **Reporting only.** Smaller, but leaves no requirement that the runtime can
   reject and risks presenting a label as enforcement.
3. **All OS sandboxes immediately.** Delivers isolation sooner only if every
   platform works; couples unrelated platform risks to protocol and recovery
   changes. Deferred to subsequent Phase 4C slices.

## Three separate records

### ExecutionPolicy: requested restrictions

Add a strict, versioned policy value shared conceptually by TypeScript and Rust:

| Field               | Values / meaning                                                              |
| ------------------- | ----------------------------------------------------------------------------- |
| `schema_version`    | `1`                                                                           |
| `workspace_root`    | Canonical absolute workspace root, bounded to 4,096 UTF-8 bytes               |
| `filesystem`        | `unrestricted`, `read_only`, or `workspace_write`                             |
| `network`           | `inherit` or `deny`                                                           |
| `process_isolation` | `inherit` or `required`                                                       |
| `environment`       | `explicit`: only the supplied launch environment, without ambient inheritance |

`unrestricted` and `inherit` mean that Koda requests no additional OS restriction
in that dimension; they do not claim that the host grants unlimited access.
`read_only` requests OS-enforced denial of filesystem writes.
`workspace_write` requests OS-enforced denial of writes outside the approved
workspace. Neither mode promises read privacy outside the workspace. Additional
read scopes or temporary writable directories require a future explicit policy
revision; they must not be silently added by a backend.

`process_isolation: required` is an unimplemented requirement in C1. Process-tree
termination alone cannot satisfy it. A later platform design must specify the
host-process and privilege boundaries before advertising support for it.

The application continues to filter environment names through its existing
allowlist before producing the explicit launch map. The native executor's
environment guarantee is only that it uses that supplied map without inheriting
ambient variables; it must not claim to have applied the application's allowlist
when called directly. Neither guarantee prevents a command from reading secrets
from accessible files, so this is not secret isolation.

All new policy objects reject unknown keys, unsupported versions, malformed
paths, invalid enums, and oversized fields. New wire requests carry a complete
policy, not a set of optional permissions whose omission can broaden access.

### ExecutionCapabilities: what this backend can provide

Keep the existing process-group, Job Object, PTY, and recovery flags. Add a
separate, versioned execution-security capability record to the handshake.
It reports supported policy values and their implementation mechanisms.

In C1, all backends report filesystem, network, and host-process isolation as
unimplemented. They can accept only `unrestricted` / `inherit` / `inherit`
requirements. Native and compatibility process-ownership mechanisms remain
distinct, even though both lack an OS sandbox. Do not infer support from the OS
name, an installed executable, or the presence of a Job Object.

### ExecutionSecuritySnapshot: evidence for one job

Store the normalized requested policy, its digest, selected backend, report
version, and per-dimension enforcement evidence with the job. Separate launch
environment handling and process supervision from isolation dimensions.

Use explicit statuses for `not_requested`, `not_applied`, `applied`, and
`unknown`. Any `applied` claim also names its mechanism and enforcement layer
(`application` or `os`). Thus an application cwd check can be reported without
being mistaken for an OS filesystem restriction. Advertised capability alone
never produces an `applied` status.

Before command launch, a snapshot represents admission/setup evidence, not a
claim that a command ran. C1 never emits an applied OS-isolation claim. Historical
records without evidence are `legacy_unknown`, not retroactively assigned the
current backend's report. Retained evidence is bounded to 16 KiB and contains
no environment values, credentials, attachment tokens, or raw handles.

## Configuration and authority

The trusted application configuration selects policy; model arguments,
repository instructions, Skills, plugins, and MCP output cannot set or weaken it.
The shared application options provide a typed policy configuration, so CLI,
TUI, app-server, and tests resolve the same policy.

For initial manual testing, `KODA_EXECUTION_PROFILE` selects one fixed profile:

| Profile                | Filesystem        | Network   | Process isolation |
| ---------------------- | ----------------- | --------- | ----------------- |
| `unconfined` (default) | `unrestricted`    | `inherit` | `inherit`         |
| `read-only`            | `read_only`       | `deny`    | `inherit`         |
| `workspace-write`      | `workspace_write` | `deny`    | `inherit`         |

The workspace root is supplied by the application after canonicalization, not
by the model. All profiles use the explicit launch-environment contract. The
protected profiles are recognized but refused in C1, on every platform, until
a later backend can meet their requirements. Profile names do not imply full
host-process isolation; reporting always remains per dimension.

Explicit application options take precedence over the named environment
profile; otherwise the default is `unconfined`. Invalid configured values fail
configuration validation rather than falling back. Policy is immutable for the
application instance; there is no hot reload, interactive downgrade prompt, or
per-tool model override in C1.

## Preparation, approval, and execution

```text
trusted configuration -> normalize policy -> check selected backend
  -> freeze command + policy + security preview -> normal approval
  -> revalidate -> native Supervisor admission -> Worker launch boundary
  -> persist evidence -> run -> retain evidence with terminal result
```

1. `WorkspaceCommandRunner.prepare` and `prepareTerminal` resolve the same
   canonical policy and reject known-unavailable restrictions before requesting
   approval. They continue to validate argv, cwd, and ordinary command limits.
2. Approval preview includes the requested restrictions and the expected actual
   enforcement, explicitly stating `OS sandbox: none` for C1's unconfined mode.
   Expected enforcement is not presented as launch evidence.
3. The exact-command grant key advances its input version and includes the
   policy digest, backend identity, and semantic capability digest in addition
   to the existing workspace/cwd/argv/timeout inputs. A changed restriction or
   backend cannot match an older grant. Do not include credentials or volatile
   lease tokens. PTY starts retain their existing per-start approval behavior.
4. The prepared operation freezes its normalized inputs. Before execution it
   revalidates cwd and backend support. A changed preview contract invalidates
   the prepared operation; it cannot silently substitute a new backend or policy.
5. The native Supervisor validates the full policy independently, binds it to
   start idempotency, and rejects unsupported new starts before creating a
   Worker. A retry of an already accepted exact request observes that same job;
   it does not launch again or relabel the job with current capabilities.
6. The Worker independently checks the persisted policy before the command
   execution gate / suspended-process resume. Future OS setup must complete
   successfully before that boundary; on failure the command never runs.
7. Results, audit events, and process-session metadata expose the job's retained
   security snapshot. Clients render it without recomputing guarantees from
   the current platform. Application policy denial cannot be overridden by an
   existing approval grant.

The TypeScript backend uses the same admission and preview rules. It cannot
accept protected profiles, and it never claims native durable ownership.

## Fingerprints and persistence

Policy fingerprinting is SHA-256 over compact UTF-8 JSON with a specified fixed
field order, validated enum spellings, and the canonical workspace path. Do not
normalize or case-fold paths generically across platforms. Shared golden
fixtures cover non-ASCII and Windows paths and JSON escaping in both languages.
Rust recomputes the fingerprint rather than trusting a client-supplied digest.

The requested policy is immutable and included in the durable start request
digest. Evidence is persisted through the existing manifest/state/head integrity
boundaries, not an unrelated mutable side file. Missing evidence on a new-format
record is corruption, not permission to assume unconfined execution.

Retained pre-launch evidence must not become stronger after an uncertain crash.
A Supervisor restart reconnects to a live Worker and preserves its job-specific
record. Worker loss preserves the last verified evidence with the existing
uncertain-outcome semantics. Never retrofit current policy onto a running job.

## Version and legacy compatibility

The current public native protocol and Node handshake are strict. Introduce
native protocol v2 for policy-bearing starts and security reports. New clients
require v2 and do not retry a start as v1. A still-running v1 Supervisor produces
an actionable incompatibility error, not an automatic kill/replacement.

Use a new durable format for new policy-bearing jobs. The loader explicitly
supports legacy v1 and new v2 records, validates each under its original hash
rules, and does not rewrite legacy records merely to read them. Unknown future
formats are left untouched and block unsafe adoption rather than being deleted
or reinterpreted. Downgrading a runtime over new-format state is unsupported.

Keep the existing internal Worker control envelope compatible for legacy
observation, attachment, and termination. A new Supervisor must continue to
observe live legacy Workers with `legacy_unknown` security evidence. It must
not turn a missing legacy policy into a new policy-backed launch: legacy
pre-command records are stopped before executing user code and require a fresh
approved request. Old terminal logs remain readable.

New policy-bearing jobs require complete security data even though legacy jobs
may lack it. Tests must distinguish that absence from malformed or missing
new-format evidence. App-server process-security response changes use a new
app-server protocol revision; historical JSONL records remain replayable with
explicit absence/unknown handling, without rewriting history.

## Errors and UI

- `INVALID_EXECUTION_POLICY`: malformed, inconsistent, or unsupported policy
  schema; fail before approval or command launch.
- `EXECUTION_POLICY_UNAVAILABLE`: selected backend cannot meet one or more
  restrictions; report bounded dimension/reason metadata and do not run.
- `EXECUTION_POLICY_CHANGED`: prepared security contract no longer matches the
  backend; invalidate preparation and any assumed grant match.
- `INCOMPATIBLE_PROTOCOL`: explicit native-version mismatch; no fallback.
- `EXECUTION_SECURITY_CORRUPT`: new-format security evidence is missing,
  inconsistent, or fails integrity validation; preserve evidence and fail closed.

Reuse the approval preview, command result, and existing process inspection
surfaces. Do not build a new security dashboard or interactive grant editor.
Keep the actual `OS sandbox: none` / `legacy evidence: unknown` text visible and
test that application filtering or process ownership never changes it to
`sandboxed`. State-directory privacy is not a substitute for command isolation.

## Implementation sequence

1. **C1A — schemas and pure evaluation.** Add shared TypeScript policy/report
   schemas and matching Rust types, canonical policy fixtures, deterministic
   profile resolution, backend capability evaluation, and bounded errors.
2. **C1B — native admission and durable evidence.** Introduce native v2 and
   version-aware durable loading, carry policy across Pipe and PTY starts,
   enforce it at Supervisor and Worker boundaries, and preserve legacy reads.
3. **C1C — application and clients.** Wire trusted configuration into both
   execution paths, bind preparation/grants, propagate snapshots into events
   and results, and update CLI/TUI/app-server inspection and previews.
4. **C1D — acceptance and documentation.** Complete negative launch tests,
   restart/legacy matrices, platform CI, and explicit guarantee documentation.

Implement on `main` unless a later platform sandbox requires a separately
approved major refactor. Do not mark Phase 4C complete when C1 finishes.

## Acceptance matrix

1. Default unconfined commands and PTYs retain existing behavior and visibly
   report no Koda OS isolation on macOS, Linux, and Windows.
2. Filesystem, network, and process-isolation requirements rejected by C1 create
   no user-process side effects, even with an approved tool or valid old grant.
3. Direct native policy-bearing starts and prepared application starts reject
   the same unsupported requirements; no silent compatibility fallback occurs.
4. Unknown fields/versions and malformed/oversized policy or report data fail
   strict TypeScript and Rust validation; shared digests match exactly.
5. Different policy or backend means a different approval grant key; changing
   prepared inputs cannot broaden the approved execution contract.
6. Duplicate identical start requests observe one job; changing policy with the
   same request ID is an idempotency conflict, not a second execution.
7. Supervisor restart, detach/reattach, and Worker loss retain policy/evidence;
   historical jobs never acquire current guarantees retroactively.
8. Legacy live/terminal jobs remain observable with unknown evidence; legacy
   pending jobs and missing new-format evidence cannot execute implicitly.
9. Security previews, events, snapshots, and error messages contain no new
   secret-bearing payloads. This does not claim existing launch environments or
   arbitrary command output are comprehensively redacted.
10. Existing provider, approval, command, PTY, recovery, app-server, TUI, and
    native Windows tests remain green, supplemented by policy-negative tests.

## Deferred Phase 4C work

- Concrete Linux, macOS, and Windows filesystem/network/process isolation
  mechanisms and platform-specific enforcement tests.
- Read privacy, explicit extra roots, temporary-directory grants, domain-level
  network allowlists, and CPU/memory/process-count quotas.
- Secret references, scoped in-memory injection, output redaction, and secret
  lifetime/audit policy. Existing environment persistence is not solved by C1.
- MCP/plugin isolation integration, live policy editing, approval-based sandbox
  escalation, and shell-string support; none are enabled incidentally by C1.
