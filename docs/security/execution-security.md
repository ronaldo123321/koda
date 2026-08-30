# Koda Execution Security Guarantees

- Scope: Phase 4C1, Phase 4C2A, and Phase 4C2B
- Status: Linux closure candidate — implementation and acceptance gates are in
  place; final status requires one commit to pass all four platform jobs
- Last updated: 2026-08-30

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

The native Supervisor advertises schema-v2 protection only after a real startup
self-test through the fixed system `/usr/bin/sandbox-exec` proves normal reads,
denied writes, denied network access, and sandbox-internal confirmation. Pipe
and PTY jobs share the same bounded SBPL builder and two-way launch gate.

### Linux

The native Supervisor advertises schema-v3 protection only after a real,
multi-profile startup probe succeeds through the exact Bubblewrap executable
recorded in its capability descriptor. Koda accepts only a trusted fixed system
path or the explicit `KODA_BWRAP_PATH` administrator override. It records the
canonical path, device, inode, size, nanosecond mtime, SHA-256, bounded version,
and probe revision, and revalidates that identity before every protected launch.

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

## What is not guaranteed

The current profiles do not provide workspace or host read privacy: protected
commands can read ordinary host files visible through the read-only root. They
do not provide a PID namespace, cgroup resource quotas, domain/address/port
network allowlists, secret injection or output redaction, or isolation for
providers, MCP servers, and plugins. `process_isolation = required` remains
unsupported.

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
app-server v15 responses, CLI diagnostics, and TUI activity/process views all
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

The legacy executable is built from pinned commit `3aa84ee` outside the working
tree:

```bash
./scripts/build-phase-4c1-v1-executor.sh /tmp/koda-exec-v1
KODA_LEGACY_EXECUTOR_BINARY=/tmp/koda-exec-v1 \
  pnpm exec vitest run packages/testkit/src/native-execution-policy.test.ts
```
