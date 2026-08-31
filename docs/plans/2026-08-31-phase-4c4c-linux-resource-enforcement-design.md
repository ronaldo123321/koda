# Phase 4C4C Linux Resource Enforcement

- Status: C4C1 implemented and locally verified; C4C2-C4C4 pending
- Date: 2026-08-31
- Depends on: completed Phase 4C4A resource contracts and Phase 4C4B macOS
  resource enforcement

## Decision summary

Phase 4C4C adds exact Linux resource enforcement without reinterpreting the
frozen C4A contract. Four per-process limits use Linux `rlimit` controls. The
job-tree count becomes a new `job_task_count` field whose name matches the
Linux PIDs controller's kernel-task semantics, including threads.

The current Linux subset is:

| Limit                         | Kernel control    | Scope          | Granularity |
| ----------------------------- | ----------------- | -------------- | ----------: |
| `process_cpu_time_ms`         | `RLIMIT_CPU`      | one process    |    1,000 ms |
| `process_address_space_bytes` | `RLIMIT_AS`       | one process    |      1 byte |
| `job_task_count`              | cgroup `pids.max` | owned job tree |      1 task |
| `process_open_files`          | `RLIMIT_NOFILE`   | one process    |           1 |
| `process_file_size_bytes`     | `RLIMIT_FSIZE`    | one process    |      1 byte |

No value is rounded. An inexact CPU request fails admission. The cgroup limit
is advertised only after the executor proves that it owns a delegated cgroup
v2 subtree, the `pids` controller and `cgroup.kill` work, and verified
Bubblewrap can prevent same-UID user code from changing or escaping the
control group.

## Contract evolution

`ExecutionPolicy` advances to schema v3. The v3 resource object replaces
`job_process_count` with `job_task_count`. Historical schema-v2 policies retain
`job_process_count` exactly and remain readable, but Koda never upgrades or
reinterprets that value as a task limit. New trusted configuration accepts only
the v3 name.

Execution capability and security evidence advance from schema v4 to v5. The
four per-process entries use `posix_rlimit`, `process`, `kernel_hard`, and their
exact granularities. `job_task_count` uses `linux_cgroup_v2_pids`, `job_tree`,
`kernel_hard`, and unit granularity. Capability and requested/available/applied
digests cover the v3 field order and the full v5 descriptor.

Current TypeScript fallbacks and Windows report every v3 resource as
unsupported. macOS retains its C4B CPU/open-file/file-size subset and reports
address-space and job-task limits as unsupported. Linux independently reports
the rlimit subset and the dynamically verified cgroup subset, so failure to
obtain cgroup delegation does not disable exact rlimits.

Native protocol and durable format advance from v7 to v8. App-server protocol
advances from v17 to v18 because public resource evidence changes schema.
Durable formats v1 through v7 remain readable without upgrade. The native and
app-server transports serve only their current versions and do not negotiate a
weaker execution path.

## Linux capability discovery

Linux rlimit support is frozen from the target operating system and verified
with strict constants and read-back behavior. Cgroup support is a runtime fact,
not a platform inference. Supervisor startup resolves the unified cgroup v2
mount and its own cgroup from `/proc/self/mountinfo` and `/proc/self/cgroup`,
then validates an explicitly delegated descendant owned by Koda.

The cgroup runtime descriptor binds a fixed mechanism and probe revision, the
mount identity, delegated-root device and inode, the `pids` controller, and
availability of `pids.max`, `cgroup.procs`, `cgroup.events`, and `cgroup.kill`.
The probe creates a private child, writes and reads a bounded limit, moves only
the probe process through a controlled bootstrap, kills it, waits for
`populated=0`, and removes the directory. Partial probes are cleaned up and do
not produce a supported capability.

Koda follows cgroup delegation's single-writer rule. It never writes directly
below a systemd-managed slice or scope that was not delegated. A service or
scope configured with `Delegate=pids` is the supported systemd deployment.
Other service managers may provide an equivalent exclusive subtree, but it
must pass the same native self-test.

## Per-job cgroup ownership

Every admitted `job_task_count` request receives one child below the verified
Koda delegation root. Its name is derived from the durable job identifier and a
bounded internal generation; no path component comes from model or user input.
All operations use a pre-opened root plus relative `openat`-style traversal,
reject symlinks, and validate device, inode, ownership, and file types.

The Worker creates the directory, writes `pids.max`, reads it back exactly,
and opens the minimum control descriptors before spawning the command. The
absolute host path and writable descriptors are private runtime state and are
never included in public evidence or client events.

Same-UID code could otherwise modify a user-delegated cgroup. Therefore every
job-task-limited launch requires the verified Bubblewrap backend, including an
otherwise unrestricted filesystem policy. Bubblewrap preserves the requested
ordinary filesystem and network semantics while hiding or read-only masking
the cgroup v2 mount. No writable cgroup control descriptor survives command
`exec`.

## Gated launch data flow

Pipe, PTY, protected background PTY, and sandboxed launches share one resource
activation path:

1. The application freezes policy v3 and capability/evidence v5 at admission.
2. The Worker reparses and revalidates the frozen descriptor before spawn.
3. It creates and verifies the per-job cgroup when `job_task_count` is present.
4. It passes a dedicated `cgroup.procs` descriptor through Bubblewrap to the
   final command bootstrap.
5. After namespace setup, the final bootstrap writes `0` through that
   descriptor, moving only itself into the task cgroup, then closes it.
6. The same bootstrap applies equal soft/hard rlimits in fixed order and reads
   every installed value back exactly.
7. It returns a bounded confirmation frame bound to the request, applied
   limits, cgroup identity, and current command PID.
8. The Worker independently verifies `pids.max`, membership, and
   `pids.current`, persists applied evidence, and only then releases the
   existing command gate.

Bubblewrap helper processes remain outside the per-job cgroup. The exact task
budget therefore applies to the final command and descendants, not to Koda's
launcher infrastructure. Forked and cloned descendants inherit membership;
the kernel returns `EAGAIN` when the hierarchy would exceed `pids.max`.

## Runtime integrity and cleanup

Public resource evidence records the requested, frozen available, and applied
values and digests. Private durable state records only a relative cgroup name,
directory inode, delegated-root identity, and creation generation. It never
treats a stored host path as authority.

Supervisor or Worker recovery re-resolves the current delegated root, requires
an exact identity match, opens the job directory without following links, and
verifies membership and configured limits. Attach, detach, resize, input
ownership, and output cursors do not recreate or mutate the cgroup.

When the main command exits or the job is terminated, the Worker uses
`cgroup.kill`, waits for `cgroup.events` to report `populated=0`, verifies the
directory identity, and removes it. This also closes descendants that escaped
the POSIX process group but remain in the cgroup. A recovery sweeper cleans only
verified terminal-job cgroups; ambiguous directories are quarantined rather
than deleted.

The Worker checks the retained limit and membership at lifecycle boundaries.
If `pids.max`, membership, or directory identity changes after release, it
terminates the verified process group and cgroup and retains an integrity
failure rather than continuing to claim enforcement.

## Failure rules

- Invalid v3 policy, capability, evidence, or private identity fields fail at
  their existing strict trust boundaries.
- Missing delegation, controller, Bubblewrap, `cgroup.kill`, or a failed
  self-test makes only `job_task_count` unavailable and returns
  `RESOURCE_LIMIT_UNAVAILABLE` before job creation when requested.
- Rlimit or cgroup creation, application, read-back, membership, confirmation,
  or timeout failure before gate release returns
  `RESOURCE_LIMIT_APPLY_FAILED`, kills the gated process and verified cgroup,
  and retains `not_applied` evidence.
- Post-release limit drift, membership escape, inode replacement, or recovery
  mismatch returns the new stable code `RESOURCE_LIMIT_INTEGRITY_LOST`, stops
  the verified job, and retains the last trustworthy evidence.
- Cleanup never follows stored absolute paths, broad globs, symlinks, or
  unverified directory identities.

## Implementation sequence

1. **C4C1 — contract upgrade (completed):** policy v3, capability/security v5, native
   protocol and durable v8, app-server v18, `job_task_count`, frozen historical
   reconstruction, shared fixtures, and fail-closed platform matrices.
2. **C4C2 — Linux rlimits:** exact `RLIMIT_CPU`, `RLIMIT_AS`, `RLIMIT_NOFILE`,
   and `RLIMIT_FSIZE` application, read-back, confirmation, evidence, and
   shared launch wiring.
3. **C4C3 — cgroup v2:** delegated-root discovery and self-test, private
   per-job cgroups, final-bootstrap placement, Bubblewrap masking, recovery,
   integrity checks, and cleanup.
4. **C4C4 — acceptance and closure:** real Linux enforcement, failure
   injection, cross-platform compatibility, documentation, and same-commit CI.

The slices are checkpoints, not separate security claims. Phase 4C4C is
complete only when the entire chain passes together.

## Acceptance

Shared TypeScript/Rust golden tests cover v3 canonical ordering and digests,
v5 capability/admission/applied evidence, independent rlimit/cgroup
availability, exact granularity, tampering, and frozen v2/v4 history. Durable
tests read v1-v7 and round-trip v8 without implicit upgrade.

Real Linux tests run inside a CI-only systemd service with a delegated `pids`
subtree and cover:

- CPU termination, virtual-address-space allocation failure, `EMFILE`, and
  file-size enforcement;
- process and thread creation reaching `job_task_count` and returning
  `EAGAIN`;
- denied cgroup mutation and membership escape from user code;
- Pipe, PTY, background, attach/detach, and Supervisor/Worker recovery;
- residual-descendant cleanup and absence of leaked job cgroups; and
- application, confirmation, identity, timeout, integrity, and cleanup fault
  injection with pre-release sentinels where applicable.

A non-delegated Linux run verifies truthful capability degradation and
pre-creation rejection. macOS proves its exact C4B subset under the new
protocol. Windows and TypeScript fallbacks reject every v3 resource request.
All platforms continue to accept no-resource current jobs and frozen historical
records.

## Explicit deferrals

- cgroup CPU, memory, I/O, cpuset, pressure, and accounting policies;
- aggregate job memory and CPU contracts;
- privileged cgroup broker or bundled system service installation;
- container-orchestrator-specific delegation setup;
- sampling or kill-after-observation quotas;
- Windows Job Object resource enforcement; and
- new CLI/TUI resource configuration beyond current trusted profiles and the
  shared evidence formatter.

## Primary references

- [Linux kernel cgroup v2 documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
- [systemd cgroup delegation](https://systemd.io/CGROUP_DELEGATION/)
