# Phase 4C4B macOS Resource Enforcement

- Status: Complete
- Date: 2026-08-31
- Depends on: completed Phase 4C4A resource policy, trusted admission,
  durability, and client projection

## Decision summary

Phase 4C4B enables only the macOS resource limits whose operating-system
semantics exactly match Koda's existing public contract. The native executor
uses POSIX `setrlimit` and `getrlimit` to install and verify per-process hard
limits before releasing user code. It does not reinterpret advisory or
user-wide controls as job-tree guarantees.

The supported subset is:

- `process_cpu_time_ms` through `RLIMIT_CPU`, with 1,000 millisecond
  granularity;
- `process_open_files` through `RLIMIT_NOFILE`, with unit granularity; and
- `process_file_size_bytes` through `RLIMIT_FSIZE`, with byte granularity.

`process_address_space_bytes` remains unsupported. On macOS, `RLIMIT_AS` is an
alias of the resident-set resource and the documented behavior is not a hard
virtual-address-space ceiling matching Koda's contract. `job_process_count`
also remains unsupported because `RLIMIT_NPROC` applies to the complete user
ID, not the Koda-owned job tree.

No limit is rounded. A CPU request that is not an exact multiple of 1,000
milliseconds fails admission with `RESOURCE_LIMIT_UNAVAILABLE`. Unsupported
limits continue to fail before a durable job is created. Linux and Windows
remain on the C4A unsupported-resource capability set; Linux enforcement is
Phase 4C4C and Windows resource enforcement remains deferred.

## Capability contract

The current macOS native capability descriptor remains execution-capability
schema v4 and changes only the three existing resource entries:

| Limit                     | Backend        | Scope     | Enforcement   | Granularity |
| ------------------------- | -------------- | --------- | ------------- | ----------: |
| `process_cpu_time_ms`     | `posix_rlimit` | `process` | `kernel_hard` |    1,000 ms |
| `process_open_files`      | `posix_rlimit` | `process` | `kernel_hard` |           1 |
| `process_file_size_bytes` | `posix_rlimit` | `process` | `kernel_hard` |      1 byte |

The address-space and job-count entries stay `unsupported`. Capability
digests include these values. Generic TypeScript execution, Linux Bubblewrap,
and Windows Job Object capability wrappers do not inherit macOS support.

Admission requires every requested limit to be supported with the exact
public scope and enforcement kind, and the requested value must be divisible
by the advertised granularity. A valid resource request produces
`resources.status=not_applied` with canonical requested and available layers.
Admission is never launch evidence.

## Bootstrap and launch data flow

Resource installation occurs in Koda's existing command bootstrap rather than
inside a Rust `pre_exec` closure. The latter is deliberately kept to
async-signal-safe descriptor and process setup. For a resource-bearing launch,
the Worker creates a dedicated confirmation pipe and passes strict decimal
resource arguments plus the inherited confirmation descriptor to the
bootstrap.

The bootstrap performs the following sequence:

1. Strictly parse the supported resource names and bounded values.
2. Apply each requested limit in fixed order with equal soft and hard values.
3. Read each value back with `getrlimit` and require an exact match.
4. Write a bounded confirmation frame derived from the applied request.
5. Wait on the existing command gate.
6. Execute the prepared command.

The hard limits are inherited across `exec` and child creation and cannot be
raised by an unprivileged descendant. The scope remains per-process; C4B never
describes these controls as aggregate job-tree CPU, file-descriptor, or file
size quotas.

For an unconfined Pipe or PTY launch, the Worker validates the resource
confirmation, persists applied security evidence, and only then releases the
command gate. A Seatbelt launch has two confirmations: resource application
at the outer command bootstrap and the existing sandbox confirmation at the
inner bootstrap. Both must succeed before the final sandbox release gate is
opened. Background jobs use the same path and retain the same evidence through
attach, detach, restart, and completion.

Commands without resource requests keep the current launch path and explicit
`resources.status=not_requested`; they do not create a resource confirmation
channel.

## Evidence and failures

The trusted state progression is:

```text
policy -> admission:not_applied -> bootstrap confirmation -> launch:applied
       -> durable transition -> user-command gate release
```

The Worker constructs the applied object from the retained policy and frozen
capability descriptor. It does not accept arbitrary evidence from the child.
The bootstrap confirmation proves only that the exact requested kernel values
were installed and read back. The Worker recalculates the applied digest and
the complete launch-security snapshot before persistence.

Failure rules are:

- unsupported scope, backend, or granularity:
  `RESOURCE_LIMIT_UNAVAILABLE` before job creation;
- `setrlimit` or `getrlimit` failure, read-back mismatch, malformed
  confirmation, or confirmation timeout: `RESOURCE_LIMIT_APPLY_FAILED` while
  the child remains behind the command gate;
- policy, capability, or digest drift: `EXECUTION_POLICY_CHANGED`;
- partial application followed by failure: terminate the gated child and
  retain `not_applied`; never fabricate an applied claim.

The fixed public error identifies the resource-limit application stage without
disclosing the host's previous hard limits, unrelated process state, or
UID-wide resource usage. A resource-triggered exit retains the actual exit code
or signal; applied evidence means the limit was installed, not that the command
completed successfully.

Recovery never reconstructs applied evidence from current host state. A
Running record must already contain valid applied evidence. A record left in a
pre-release state without a valid confirmation is handled by the existing
conservative start recovery and cannot release user code after restart.

## Version and compatibility boundary

The native external protocol advances from v6 to v7. An old v6 client knows
the shape of resource capabilities but does not construct the C4B admission
state, so sharing a version would be behaviorally unsafe. The new Supervisor
serves v7 only; Koda does not retain a parallel v6 execution path.

The durable store advances from format v6 to v7. Historical formats remain
read-only compatible:

- formats v1-v5 retain their existing schema-specific reconstruction;
- format v6 always reconstructs the frozen C4A schema-v4 capability set with
  every resource unsupported;
- format v7 reconstructs the current platform capability set, including the
  three macOS rlimits.

Historical evidence is not upgraded. A v6 `not_requested` record remains tied
to the v6 unsupported capability digest even when read by a v7 executor.

ExecutionPolicy remains v2, execution capability/security evidence remains
schema v4, and app-server remains v17. The public app-server resource-evidence
shape already supports `not_applied` and `applied`, so C4B adds no public field
or method. CLI and TUI continue using the shared C4A formatter.

## Implementation sequence

1. **C4B1 — capability and version migration:** add the exact macOS capability
   set, strict granularity admission, correct `not_applied` evidence, native
   protocol v7, durable v7, and frozen v6 reconstruction.
2. **C4B2 — bootstrap enforcement:** add strict resource arguments and a
   confirmation channel, `setrlimit`/`getrlimit` application, gated failure
   handling, applied evidence, and shared Pipe/PTY/Seatbelt/background wiring.
3. **C4B3 — platform acceptance:** prove real CPU, open-file, and file-size
   enforcement on macOS; cover failure injection, recovery, projection, and
   the full same-commit platform matrix.

The slices are implementation checkpoints, not separate security claims.
Phase 4C4B is complete only when the full chain passes together.

## Acceptance

Shared TypeScript/Rust tests cover the exact capability descriptor, canonical
digests, supported and unsupported combinations, CPU granularity rejection,
`not_requested`, `not_applied`, and `applied` evidence, and policy/capability
tampering.

Real macOS tests cover:

- a CPU-bound process terminated by `RLIMIT_CPU` before wall timeout;
- file output unable to grow beyond `RLIMIT_FSIZE`;
- descriptor allocation reaching `EMFILE` under `RLIMIT_NOFILE`;
- Pipe, PTY, background, and Seatbelt-plus-resource launches;
- identical retained evidence through process events and
  list/attach/read/terminate projection; and
- injected application, confirmation-corruption, and confirmation-timeout
  failures with a sentinel proving user code never ran.

Durable tests read formats v1 through v6 exactly, round-trip format v7, reject
tampered applied evidence, and conservatively recover pre-release jobs. Linux
and Windows CI continue to reject all resource requests before execution while
accepting no-resource v7 jobs. The final implementation must pass formatting,
type checking, Rust tests, the complete Vitest suite, and the Linux, macOS, and
Windows native CI jobs from the same commit.

## Explicit deferrals

- macOS hard virtual-address-space enforcement;
- macOS aggregate job-tree process limits;
- sampling, polling, or kill-after-observation resource controls;
- Linux cgroup v2 and rlimit enforcement, reserved for Phase 4C4C;
- Windows resource enforcement; and
- new CLI/TUI configuration or presentation beyond the existing trusted
  application profile and shared evidence formatter.

## Implementation result

The implementation follows the approved strict subset without widening any
public scope. Native protocol and durable format are v7; v6 capability
reconstruction remains frozen to the C4A all-unsupported contract. The macOS
command bootstrap installs equal soft/hard limits in fixed order, reads them
back exactly, writes a request-bound confirmation, and remains behind the
existing command gate until the Worker persists applied evidence.

Shared TypeScript/Rust golden fixtures cover the current macOS capability,
canonical digests, admission and applied snapshots, and tampering. Rust tests
cover v1-v6 reads and v7 round trips. Real macOS integration tests cover CPU,
file-size, descriptor exhaustion, Pipe, protected background PTY, attach/list/
terminate retention, app-server projection, and all three injected bootstrap
failure modes with a sentinel proving user code did not run.

Implementation commit `00ab122` introduced the complete C4B contract and
backend. Follow-up commits `b9c9366` and `490d316` reduced the shared launch
surface to satisfy strict Clippy gates and repaired the Windows compatibility
projection without enabling Windows resource enforcement. The finalized
implementation tree passed `verify`, `linux-native`, `macos-native`, and
`windows-native` in
[GitHub Actions run 33377612504](https://github.com/ronaldo123321/koda/actions/runs/33377612504),
closing Phase 4C4B.
