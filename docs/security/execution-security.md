# Koda Execution Security Guarantees

- Scope: Phase 4C1, Phase 4C2A, Phase 4C2B, Phase 4C3A-C3D, and Phase 4C4A-C4B
- Status: Current through C4B — sandbox and secret guarantees are complete;
  exact macOS per-process CPU, open-file, and file-size hard limits are enabled
- Last updated: 2026-08-31

Koda separates execution admission, process supervision, and operating-system
isolation. A successful command does not imply that a filesystem or network
sandbox was present. Unconfined clients state `OS sandbox: none` explicitly.
Protected execution is fail-closed: if the selected native backend cannot prove
the requested controls, Koda rejects it instead of silently running with fewer
controls.

## Supported profiles

| Profile           | Filesystem request  | Network request | Verified macOS native | Verified Linux native |
| ----------------- | ------------------- | --------------- | --------------------- | --------------------- |
| `unconfined`      | unrestricted        | inherited       | supported             | supported             |
| `read-only`       | read only           | denied          | Seatbelt              | Bubblewrap + seccomp  |
| `workspace-write` | workspace + scratch | denied          | Seatbelt              | Bubblewrap + seccomp  |

TypeScript and Windows native backends reject protected profiles. Windows Job
Objects and ConPTY provide process ownership and terminal lifecycle, not a
filesystem or network sandbox.

`KODA_EXECUTION_PROFILE` is read and validated when `KodaApplication` is
constructed. A trusted typed `KodaApplicationOptions.executionPolicy` takes
precedence. Repository content, model output, Skills, plugins, MCP tools, and
later environment mutation cannot change the captured selection. The canonical
workspace root is added only after trusted workspace opening.

## Platform guarantees

### macOS

The native Supervisor advertises the current schema-v4 macOS contract only
after a real startup self-test through the fixed system
`/usr/bin/sandbox-exec` proves normal reads, denied writes, denied network
access, and sandbox-internal confirmation. Pipe and PTY jobs share the same
bounded SBPL builder and two-way launch gate. Resource-bearing jobs additionally
use a dedicated outer bootstrap confirmation: the bootstrap installs and reads
back the exact kernel hard limits, the Worker persists `applied` evidence, and
only then can either an unconfined command gate or the final Seatbelt gate open.

### Linux

The native Supervisor advertises the current schema-v4 resource wrapper over
Linux schema-v3 protection only after a real, multi-profile startup probe
succeeds through the exact Bubblewrap executable recorded in its capability
descriptor. Koda accepts only a trusted fixed system path or the explicit
`KODA_BWRAP_PATH` administrator override. It records the canonical path,
device, inode, size, nanosecond mtime, SHA-256, bounded version, and probe
revision, and revalidates that identity before every protected launch.

The Linux protected boundary consists of:

- a new user, mount, and IPC namespace;
- a read-only bind of `/`, a minimal read-only `/dev`, and read-only `/run`;
- writable binds only for the canonical workspace and a private mode-0700
  per-job scratch directory when `workspace_write` is selected;
- a new network namespace when `network = deny`;
- `PR_SET_NO_NEW_PRIVS` plus a Koda-owned architecture-specific seccomp filter;
- all capabilities dropped by Bubblewrap;
- a fixed confirmation frame binding PID, process group, namespace identities,
  network mode, `no_new_privs`, seccomp mode, policy, capabilities, builder, and
  runtime identity;
- a second release pipe that remains closed until applied evidence is durable.
- a verified `PR_SET_PDEATHSIG(SIGKILL)` chain from Bubblewrap to the inner
  bootstrap/user process, closing the orphan window if the Worker disappears.

The denied-network filter blocks socket and socketpair creation, io_uring
setup/enter/register, nested user-namespace entry, setuid/setgid transitions,
and `TIOCSTI`. The real probe covers TCP, UDP, raw, netlink, pathname Unix,
abstract Unix, inherited-descriptor, and `/proc/self/fd` cases. On the supported
x86-64 and arm64 architectures there is no legacy `socketcall` multiplexor;
direct socket syscalls are filtered.

`network = inherit` preserves TCP, UDP, pathname Unix, and abstract Unix sockets
without making an otherwise read-only filesystem writable. Pipe and PTY use the
same policy builder, confirmation, evidence, and release path. Protected
background PTYs retain applied evidence across attach, input acquisition,
resize, detach, Supervisor restart, reattach, and completion.

## Resource contract status

Phase 4C4A defines TypeScript/Rust policy-v2 resource limits and schema-v4
capability/security evidence for per-process CPU time, per-process address
space, job-tree process count, per-process open files, and per-process file
size. It also binds trusted configuration, approval identity, native admission,
durability, and app-server/CLI/TUI projection without fabricating applied
evidence.

C4B enables the exact macOS subset whose operating-system semantics match the
public contract:

| Limit                     | Kernel control  | Scope       | Granularity |
| ------------------------- | --------------- | ----------- | ----------: |
| `process_cpu_time_ms`     | `RLIMIT_CPU`    | per process |    1,000 ms |
| `process_open_files`      | `RLIMIT_NOFILE` | per process |           1 |
| `process_file_size_bytes` | `RLIMIT_FSIZE`  | per process |      1 byte |

Soft and hard values are equal, read back exactly with `getrlimit`, inherited
across `exec`, and never rounded. An inexact CPU request fails admission.
`process_address_space_bytes` remains unsupported because Darwin's available
limit does not provide the promised hard virtual-address-space semantics.
`job_process_count` remains unsupported because `RLIMIT_NPROC` is user-wide,
not scoped to a Koda job tree.

Native protocol and durable format are v7. Formats v1-v6 remain readable
without implicit upgrade; v6 always reconstructs the frozen all-unsupported
C4A capability digest. A command without limits retains explicit
`not_requested` evidence. Unsupported Linux, Windows, macOS address-space, and
macOS job-count requests fail before job creation with
`RESOURCE_LIMIT_UNAVAILABLE`. Application, read-back, malformed confirmation,
and confirmation-timeout failures retain `not_applied`, terminate the still
gated child, and report `RESOURCE_LIMIT_APPLY_FAILED`.

App-server v17 projects the same strict evidence through command/terminal
results, process events, and process list/attach/read/terminate summaries.
Present public evidence must match retained schema-v4 security; historical
absence remains absent. CLI and TUI use one bounded formatter and never expand
capability objects or digests.

## What is not guaranteed

The current profiles do not provide workspace or host read privacy: protected
commands can read ordinary host files visible through the read-only root. They
do not provide a PID namespace, cgroup resource quotas, domain/address/port
network allowlists or isolation for providers, MCP servers, and plugins.
Secret redaction is exact-byte only and does not cover transformed, encoded,
or workspace-copied values. `process_isolation = required` remains unsupported.

Phase 4C3A/C3B/C3C define value-free secret declarations/evidence, matching
TypeScript/Rust exact-byte streaming-redaction primitives, frozen trusted
`KodaApplication` catalogs, host-environment resolution into bounded
single-use in-memory leases, and secret-aware fresh approval for
`exec_command` and `exec_terminal`. Approval and events contain public aliases,
`*_FILE` targets, protected profile, denied network, and expiry only; they do
not contain the value, source environment name, value hash, or value length.
Prepared leases are destroyed on rejection, policy denial, cancellation,
error, expiry, or execution completion, and reusable command grants are never
matched for a non-empty secret set.

C3C enables only verified macOS Seatbelt and Linux Bubblewrap native Pipe/PTY
jobs using `read_only` or `workspace_write` with denied network. The bounded
authenticated start exchange excludes values from argv, inherited Supervisor
environment, idempotency material, manifests, state, diagnostics, and public
evidence. The Worker creates an executor-state directory outside the workspace
with mode `0700`, writes one opaque mode-`0400` file per declared target,
injects only its path through `*_FILE`, and releases user code only after the
existing sandbox confirmation and durable launch evidence succeed. Exact bytes
are redacted before Pipe truncation/persistence and before PTY segment/live
attachment publication. Verified process-tree completion removes the files;
uncertain termination retains `cleanup_pending` evidence rather than removing
files a live descendant may still use. Lost pre-release leases require fresh
resolution and approval and are never replayed.

C3D projects the same strict optional evidence through foreground results,
`process.started`/`process.exited`, native PTY summaries, and app-server v16
list/attach/read/terminate responses. CLI and TUI share a bounded formatter
that shows at most three aliases, lifecycle, cleanup, and total exact-byte
redactions; it omits lease IDs, digests, expiry, and target names. Historical
and non-secret records omit the field rather than inventing success.
Implementation commit `7a34668` passed the four-job platform matrix in
[GitHub Actions run 33354068315](https://github.com/ronaldo123321/koda/actions/runs/33354068315),
closing C3D and Phase 4C3.
C3A is verified by all four jobs in
[GitHub Actions run 33315958454](https://github.com/ronaldo123321/koda/actions/runs/33315958454),
and C3B implementation commit `7273895` is verified by all four jobs in
[GitHub Actions run 33318090937](https://github.com/ronaldo123321/koda/actions/runs/33318090937).

`workspace_write` is path based. A pre-existing hard link inside the workspace
still names the same inode as an outside path, so writes through that workspace
name can modify the aliased inode. Koda does not currently copy, de-alias, or
protect nested paths such as `.git` with a separate mount rule. These limits are
explicit later work, not part of the Phase 4C2B claim.

Koda does not install Bubblewrap or change host namespace/AppArmor policy at
runtime. If Bubblewrap is missing, replaced, malformed, or unable to establish
the required namespaces/seccomp state, protected capability is unavailable.

## Evidence lifecycle

Preparation creates an `admission` snapshot containing the frozen policy,
backend, capability digest, requested dimensions, expected mechanism, and—on
Linux—the sandbox runtime descriptor. Approval text says
`expected OS sandbox: ...`; it never presents expected protection as applied.
Immediately before execution, Koda revalidates the canonical workspace,
working directory identity, policy digest, backend, capability digest, and
Linux runtime identity. Any change invalidates an exact-command grant and fails
before user code is released.

For protected execution, the inner bootstrap confirms its live identity and
controls, then blocks on the release pipe. The Worker verifies the retained
process identity, persists the `launch_setup` snapshot with applied controls,
publishes `running`, and only then sends the release byte. Failure before that
point retains admission-only evidence and cannot run user code. Failure after
durable launch evidence retains that evidence and cleans the verified process
group or reports conservative `termination_uncertain`.

Command results, `process.started` events, native job state, PTY summaries,
app-server v16 responses, CLI diagnostics, and TUI activity/process views all
retain or derive their label from the same snapshot. Linux applied evidence is
reported as `OS sandbox: Linux Bubblewrap + seccomp`; it is never inferred from
the platform name, requested profile, or exit code.

Exact-command grants are memory-only and bind the canonical workspace, cwd,
argument vector, timeout, policy digest, backend, capability digest, and Linux
runtime fingerprint. Policy preparation occurs before grant matching, so an
old grant cannot bypass a changed or unavailable security contract.

## Failure and compatibility rules

- Invalid, unknown, oversized, or future policy/evidence fields fail strict
  TypeScript and Rust validation without echoing rejected payloads.
- Native protocol mismatch returns `INCOMPATIBLE_PROTOCOL`; there is no silent
  TypeScript fallback after a native backend was selected.
- Missing or inconsistent current evidence returns
  `EXECUTION_SECURITY_CORRUPT` and preserves the durable record for diagnosis.
- Duplicate identical starts observe one job. Reusing a request ID with a
  different policy is an idempotency conflict.
- Missing/replaced Bubblewrap, invalid confirmation, PID/PGID/namespace
  mismatch, seccomp failure, stale capabilities, and every pre-release Worker
  fault produce no applied evidence and no user side effect.
- Timeout, cancellation, output-persistence failure, root exit, Bubblewrap
  failure, and Worker loss clean the complete verified process group or retain
  conservative termination uncertainty.
- Durable formats 1 through 4 remain observable. Historical format-1 jobs are
  `legacy_unknown`; Koda never retrofits current guarantees onto old evidence or
  replays a pending historical command.

## Host prerequisites

Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor. On a
clean host, Koda's supported CI setup installs the distro Bubblewrap,
`apparmor-profiles`, and `apparmor-utils`, loads the scoped packaged
`bwrap-userns-restrict` profile, and runs a fixed namespace preflight. It does
not disable `kernel.apparmor_restrict_unprivileged_userns` globally.
Administrators must inspect existing host profiles before applying this setup.

## Acceptance and CI

The shared `verify` job runs the complete Linux suite with
`KODA_REQUIRE_LINUX_BUBBLEWRAP=1`. The separate `linux-native` job records the
Bubblewrap path/version/identity, runs Rust format and Clippy checks, executes
the native Rust suite, builds the pinned legacy executor, and runs the real
protected Pipe/PTY, side-effect, descriptor, syscall, network, background,
restart, fault-boundary, client-projection, and compatibility matrices. Both
jobs retain bounded failure summaries.

Phase 4C2B closes only when one implementation commit passes all four jobs:

- Linux shared `verify`;
- Linux `linux-native`;
- `macos-native`, including real Seatbelt and legacy compatibility;
- `windows-native`, including Job Object, ConPTY, shared schema, and durable
  compatibility.

The Windows job remains a regression target, not a Windows sandbox claim.

Phase 4C3D uses the same four-job gate. Real macOS/Linux acceptance covers
protected secret Pipe and background PTY redaction, cleanup, rediscovery, and
app-server projection. Windows acceptance proves fixed pre-execution
`SECRET_POLICY_UNAVAILABLE` rejection without claiming injection support.
Implementation commit `7a34668` passed all four jobs in
[GitHub Actions run 33354068315](https://github.com/ronaldo123321/koda/actions/runs/33354068315),
closing Phase 4C3.

Implementation commit `abd6d3c` passed all four jobs in
[GitHub Actions run 33312729690](https://github.com/ronaldo123321/koda/actions/runs/33312729690).
That same-commit result closes Phase 4C2B. It does not complete the deferred
resource enforcement, provider/MCP/plugin, finer network, bundled Bubblewrap,
Landlock, PID-namespace, or Windows sandbox work listed above.

Phase 4C4A1 implementation commit `ca5c5a9` passed all four jobs in
[GitHub Actions run 33357380456](https://github.com/ronaldo123321/koda/actions/runs/33357380456).
This closes only the standalone resource contract. It does not enable resource
configuration, native enforcement, durable applied evidence, or client
projection.

Phase 4C4A2 implementation commit `9395da3` passed all four jobs in
[GitHub Actions run 33365855082](https://github.com/ronaldo123321/koda/actions/runs/33365855082).
This closes trusted admission and durability only. It enables resource-aware
configuration and deterministic pre-spawn rejection, not resource enforcement
or client projection.

Phase 4C4A3 implementation commit `32874c9` passed all four jobs in
[GitHub Actions run 33368506996](https://github.com/ronaldo123321/koda/actions/runs/33368506996).
This closes client projection and Phase 4C4A. It still does not enable an OS
resource backend: every non-empty resource request continues to fail before
job creation.

The legacy executable is built from pinned commit `3aa84ee` outside the working
tree:

```bash
./scripts/build-phase-4c1-v1-executor.sh /tmp/koda-exec-v1
KODA_LEGACY_EXECUTOR_BINARY=/tmp/koda-exec-v1 \
  pnpm exec vitest run packages/testkit/src/native-execution-policy.test.ts
```
