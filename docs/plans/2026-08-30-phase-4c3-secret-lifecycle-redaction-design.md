# Phase 4C3 Secret Lifecycle and Output Redaction

- Status: In progress — Phase 4C3A/C3B/C3C complete; Phase 4C3D pending
- Date: 2026-08-30
- Depends on: Phase 4C1 execution-policy admission, Phase 4C2A macOS
  Seatbelt, and Phase 4C2B Linux Bubblewrap

## Decision summary

Phase 4C3 adds narrowly scoped command secrets without claiming that Koda can
hide a secret from the process that is intentionally allowed to consume it.
The first supported source is a trusted host-environment reference. The first
supported target is a per-job read-only secret file whose path is exposed
through a declared `*_FILE` environment variable.

Secret-bearing commands are limited to `exec_command` and `exec_terminal` on a
verified macOS or Linux native protected backend with denied network access.
They always require a fresh approval. TypeScript execution, Windows native
execution, inherited network access, providers, MCP servers, and plugins reject
secret injection in this slice.

Exact secret bytes are redacted in the native Worker before stdout, stderr, or
PTY output reaches a durable log, artifact, event, or client. Redaction is a
defense against accidental disclosure through Koda-owned channels. It is not a
defense against a malicious command that transforms, encodes, copies, or
otherwise exfiltrates a secret.

## Goals

1. Let trusted host configuration expose named secrets to explicitly approved
   protected commands without placing values in argv or durable configuration.
2. Keep secret values out of command events, approval text, manifests, job
   state, artifacts, diagnostics, and client responses.
3. Apply exact-byte streaming redaction before the first output persistence
   boundary, including across arbitrary chunk boundaries.
4. Bind secret use to command preparation, execution admission, native Worker
   identity, a bounded lifetime, and auditable cleanup evidence.
5. Fail before user code starts whenever the requested secret contract cannot
   be established and verified.

## Non-goals

- Preventing a process that received a secret from transforming or copying it.
- Treating exact-match redaction as a data-loss-prevention system.
- Allowing secret-bearing commands to inherit host network access.
- Keychain, 1Password, Vault, cloud secret-manager, or interactive credential
  acquisition.
- Provider API-key, MCP-server, plugin, or Skill credential injection.
- Windows secret injection or TypeScript execution fallback.
- Retrofitting secrets into already-running or recovered commands.
- Secure erasure guarantees on journaled or solid-state filesystems.
- Fine-grained domain, address, port, executable, or destination allowlists.

These remain explicit later Phase 4C/4E work. In particular, useful remote
credential workflows depend on the later fine-grained network-policy slice.

## Threat model and guarantee boundary

Koda protects against accidental disclosure caused by its own output capture,
event recording, artifact storage, diagnostics, approval UI, protocol
persistence, and process recovery. It also prevents repository content, model
output, Skills, MCP tools, and plugins from naming an arbitrary host environment
variable. They may request only a secret alias that trusted application
configuration already declared.

The child process is inside the trust boundary for the value it receives. It
can read the secret file by design. Exact-match redaction prevents a plain copy
from appearing in Koda-controlled output, but the process can still Base64
encode the value, split it into smaller fragments, encrypt it, write it into
the workspace, or derive another credential. `workspace_write` therefore does
not provide secret-write containment, and `read_only` does not prevent output
transformation.

The first release permits secrets only when retained execution evidence proves
one of these boundaries:

- macOS Seatbelt with a protected `read-only` or `workspace-write` profile and
  `network = deny`; or
- Linux Bubblewrap plus seccomp with a protected `read-only` or
  `workspace-write` profile and `network = deny`.

Admission refuses unconfined execution, inherited network, an unavailable or
changed native backend, missing applied sandbox evidence, and every unsupported
platform. Client text must say "exact output redaction" and "network denied";
it must not say that the command cannot disclose the secret.

## Trusted declaration contract

Trusted application configuration freezes a bounded catalog of declarations
when `KodaApplication` is constructed. A declaration contains public metadata,
not the value:

```typescript
interface SecretDeclaration {
  alias: SecretAlias;
  source: {
    kind: "host_env";
    name: HostEnvironmentVariableName;
  };
  target: {
    kind: "file_env";
    name: SecretFileEnvironmentVariableName;
  };
  tools: readonly ("exec_command" | "exec_terminal")[];
  leaseMs: number;
}
```

Aliases and target names are unique after normalization. Target names must end
in `_FILE`, must not use Koda-reserved names, and must not collide with an
ordinary command environment entry. Source environment names are trusted
configuration and never come from a tool argument.

The catalog is bounded to 32 declarations. An execution may request at most 16
aliases. Each UTF-8 value must contain between 8 bytes and 8 KiB; the combined
resolved value budget is 64 KiB. Empty, missing, malformed, duplicate, expired,
or oversized values fail closed without echoing the value.

Tool input may contain only a list of configured aliases. The canonical alias
set, target names, allowed tools, and declaration digest become part of command
preparation. The source environment name is covered by the digest but does not
need to appear in events or clients.

## Resolver and lease lifecycle

`SecretResolver` is a trusted host interface so later Keychain or vault
implementations can be added without changing tool input or execution policy.
Phase 4C3 ships only `HostEnvironmentSecretResolver`.

Resolution happens once for a prepared execution after the ordinary policy and
backend checks and before user approval. It returns a `SecretLease` containing:

- a random, single-use lease identifier;
- the canonical declaration digest;
- a monotonic expiration deadline;
- the resolved bytes in an explicitly owned buffer; and
- public target metadata.

The lease is not JSON serializable, cloneable into application events, or
accepted by generic logging helpers. Koda drops JavaScript string references as
soon as the host environment value is encoded into the owned buffer and makes a
best effort to overwrite owned buffers when the lease is destroyed. It cannot
erase the original host process environment or guarantee that runtime and
kernel copies are overwritten.

A lease expires before launch if approval or scheduling exceeds its configured
lifetime. A missing or expired lease requires fresh resolution and approval.
Process restart never reconstructs a lease from durable state.

## Approval and grant binding

Approval text identifies the command, protected execution profile, denied
network, secret aliases, target `*_FILE` names, and expiration time. It never
contains values, value lengths, value hashes, or current source contents.

Secret-bearing commands always use an on-request approval. Existing
exact-command grants and future reusable grants do not match when the canonical
secret set is non-empty. Preparation binds the command to:

- canonical workspace and cwd;
- argv and timeout;
- execution policy, backend, capability, builder, and runtime fingerprints;
- canonical secret declaration digest and target mapping; and
- the single-use lease identifier.

Changing any bound field invalidates the prepared execution. Values and hashes
are deliberately absent from durable evidence because hashes can expose
low-entropy secrets to offline guessing.

## Native injection boundary

Secret values travel only in the authenticated, bounded start exchange for a
new native job. They are not command-line arguments, inherited Supervisor
environment entries, manifest fields, idempotency material, or diagnostic
payloads. The Supervisor forwards the one-shot lease to the authenticated
Worker control channel and immediately releases its copy.

Before spawning user code, the Worker:

1. revalidates its job identity, policy, native runtime, secret declaration
   digest, lease identifier, and expiration;
2. creates a private per-job secret directory with mode `0700` and exclusive,
   non-following file creation;
3. writes one opaque-named file per secret, synchronizes and closes it, and
   applies mode `0400`;
4. extends the existing macOS or Linux sandbox builder with the exact read-only
   secret path;
5. injects only the target `*_FILE` path into the child environment;
6. establishes the existing launch confirmation and durable applied-evidence
   gate; and
7. releases user code only after every check succeeds.

The secret directory is outside the workspace. It is not included in artifacts
or workspace mutation recovery. A background process retains the files until
its complete verified process tree terminates. Attach, detach, resize, and
Supervisor restart do not create another copy.

The Worker unlinks secret files and removes the directory after verified
termination, timeout, cancellation, or a pre-launch failure. If process-tree
termination is uncertain, it must not delete files that a live descendant may
still require; it retains a cleanup-pending state and reports that uncertainty.
After a confirmed lost/dead Worker, Supervisor reconciliation removes orphaned
files without reconstructing values.

Secret-bearing prepared jobs that lose their in-memory lease before user code
starts become `SECRET_REAUTH_REQUIRED`. They are never replayed. Duplicate
requests may observe an already-live job by request identity, but cannot replace
or refresh its secret lease.

## Streaming redaction contract

The Rust Worker performs the authoritative redaction before bytes enter Pipe
capture files, PTY cursor segments, attach streams, final results, or error
summaries. TypeScript implements the same primitive and shared fixtures for
contract validation and future backends, but Phase 4C3 does not use TypeScript
execution for a secret-bearing command.

The redactor treats secrets and output as bytes:

- each exact occurrence becomes the fixed ASCII marker `[REDACTED]`;
- the marker never contains a secret alias;
- the longest matching secret wins when values overlap;
- duplicate secret values produce one replacement at each output position;
- no-match bytes retain their original order;
- a streaming implementation retains enough unresolved suffix bytes to match a
  secret split across arbitrary chunks; and
- EOF flush uses the same longest-match rules.

Redaction precedes bounded-output truncation and artifact writing. Existing
`stdout_bytes` and `stderr_bytes` fields describe sanitized bytes, so raw byte
lengths are not added to persistent metadata. Audit evidence may retain an
aggregate replacement count per stream, not a value, hash, match offset, or
per-secret occurrence map.

The same sanitized byte stream drives live PTY attachment and durable replay;
clients cannot receive a separate raw path. Manual terminal input is redacted
only if it exactly matches one of the active lease values in subsequent echoed
output. User-entered secrets outside the active lease are out of scope.

## Event and evidence contract

Durable evidence may contain:

- public secret aliases and target `*_FILE` names;
- the declaration digest and random lease identifier;
- requested, resolved, injected, expired, destroyed, or cleanup-pending state;
- lease start and destruction timestamps;
- aggregate stdout/stderr/PTY replacement counts; and
- cleanup result and any conservative termination status.

It must not contain:

- secret values or reversible encodings;
- value hashes or lengths;
- raw output match offsets;
- the current contents of a source environment variable; or
- a serialized resolver or lease object.

The existing execution-security snapshot remains the authority for sandbox
claims. Secret evidence is an additional typed section; a successful command
does not imply successful cleanup, and successful cleanup does not imply that
the process could not transform the value.

## Failure semantics

These failures occur before user code starts:

- unknown or unauthorized alias;
- missing, malformed, too short, too large, duplicate, or expired value;
- unsupported backend, platform, profile, tool, or network policy;
- changed workspace, cwd, policy, native runtime, declaration, or Worker
  identity;
- target environment collision;
- secret directory, file, permission, sandbox-rule, or redactor initialization
  failure; and
- lost lease or Worker before the durable launch gate.

Errors use typed codes and fixed messages that do not interpolate rejected
values. Once user code starts, an output redaction or persistence failure
terminates the complete verified process tree. Existing
`PROCESS_TERMINATION_UNCERTAIN` semantics remain authoritative when cleanup
cannot be proved.

Deletion means verified unlink and directory removal, not secure media erasure.
A cleanup error remains durable and visible. Koda never reports a secret as
destroyed merely because a JavaScript reference or Worker process disappeared.

## Delivery plan

### Phase 4C3A: contract and redaction core

Status: Complete

- Add strict TypeScript and Rust secret declaration, public evidence, and error
  contracts.
- Add bounded normalization and declaration digests without value material.
- Implement byte-stream redactors in both languages.
- Add shared golden fixtures for chunk boundaries, longest match, duplicate
  values, UTF-8 bytes, EOF, truncation interaction, and invalid bounds.
- Keep all runtime secret injection disabled.

Implementation includes one strict contract in each language, a shared fixture
that pins limits, error codes, canonical JSON, SHA-256 digests, evidence cases,
binary output, arbitrary chunk boundaries, longest-match behavior, duplicate
values, UTF-8 byte splits, EOF, and post-redaction output limiting. Both
redactors cover owned buffers on finish, explicit destruction, and error paths.
The application, command tools, native protocol, Supervisor, and Worker do not
yet accept a secret lease, so completing C3A does not expose a runtime secret
feature.

Implementation commit `0846f8c` passed `verify`, `linux-native`,
`macos-native`, and `windows-native` in
[GitHub Actions run 33315958454](https://github.com/ronaldo123321/koda/actions/runs/33315958454).

### Phase 4C3B: trusted configuration and approval

Status: Complete

- Freeze declarations at `KodaApplication` construction.
- Add the host-environment resolver and single-use in-memory leases.
- Let command tools request configured aliases only.
- Add secret-aware preparation, approval copy, expiry, and grant rejection.
- Reject every runtime backend until C3C is available.

Implementation commit `7273895` freezes a normalized trusted catalog at
application construction, adds `HostEnvironmentSecretResolver`, monotonic
single-use leases with owned-buffer destruction, target-collision and bounded
value checks, and binding across command, workspace, policy/capability
evidence, declaration digest, target map, and lease identifier. Both command
tools expose only configured aliases in their model schema, require a fresh
approval even when a host policy would otherwise allow execution, omit grant
candidates for secret-bearing calls, and show value-free protected-profile,
denied-network, alias, target, expiry, and exact-redaction requirements.

Prepared tools now have an idempotent disposal lifecycle, so lease buffers are
covered after rejection, policy denial, cancellation, error, or execution.
All C3B backends intentionally return `SECRET_POLICY_UNAVAILABLE` after fresh
approval and before calling the prepared Pipe/PTY command. Tests prove expiry,
single use, changed bindings, missing/malformed/duplicate values, unknown and
tool-unauthorized aliases, target collisions, non-serialization, grant
non-reuse, zero value/source leakage in approval and events, and absence of
process side effects. The commit passed `verify`, `linux-native`,
`macos-native`, and `windows-native` in
[GitHub Actions run 33318090937](https://github.com/ronaldo123321/koda/actions/runs/33318090937).

### Phase 4C3C: native injection and lifecycle

Status: Complete

- Extend the authenticated Supervisor/Worker start exchange without adding
  values to durable formats.
- Create and clean private secret files for protected macOS and Linux Pipe/PTY
  jobs.
- Extend Seatbelt and Bubblewrap builders with exact read-only secret paths.
- Redact before Pipe/PTY persistence and live attachment.
- Add crash, retry, timeout, cancellation, and cleanup-pending reconciliation.

Implementation uses native protocol v5 and durable format v5. The outer start
request carries a bounded value-bearing lease separately from the durable
`StartParams`; only value-free declaration/lease/target/expiry evidence enters
the request digest and records. Secret starts disable client request replay.
After authenticated Worker hello, the Supervisor provisions the lease once and
the Worker blocks until it arrives or expires. The Worker creates an
executor-state directory outside the workspace with mode `0700`, writes opaque
mode-`0400` files, extends Seatbelt/Bubblewrap with exact read-only paths,
injects only declared `*_FILE` names, and then follows the existing confirmed
sandbox release gate.

Separate longest-match streaming redactors run for stdout, stderr, and PTY
before output limits, files, segments, or live attachment reads. Durable/public
state retains only aliases, targets, lease identity, lifecycle, aggregate
replacement counts, and cleanup status. Normal exit, timeout, cancellation,
and verified prelaunch failure clean files; uncertain termination retains
`cleanup_pending`, and a lost pre-release Worker becomes
`SECRET_REAUTH_REQUIRED` instead of replaying the lease. TypeScript and Windows
secret execution remain fixed unsupported paths for C3D acceptance.

The closing C3C implementation tree at commit `b4ab2c6` passed `verify`,
`linux-native`, `macos-native`, and `windows-native` in
[GitHub Actions run 33322204252](https://github.com/ronaldo123321/koda/actions/runs/33322204252).
This completes native injection, redaction, lifecycle, and cross-platform
compatibility for C3C only. Phase 4C3 remains open until C3D projects the safe
evidence through every client and closes the same-commit platform acceptance
matrix.

### Phase 4C3D: clients and platform acceptance

- Project safe secret evidence through CLI, TUI, and app-server responses.
- Add real macOS and Linux protected Pipe/PTY acceptance.
- Keep Windows and TypeScript behavior explicitly unsupported and covered by
  compatibility tests.
- Update the execution-security guarantee and close the slice only from
  same-commit platform evidence.

## Test strategy

Shared fixtures use high-entropy sentinel values and split every value at every
byte boundary. They cover prefix/suffix overlap, duplicate values, adjacent
matches, replacement-marker input, binary output, multibyte UTF-8, empty
chunks, EOF, and output-limit boundaries.

Application tests prove that untrusted inputs cannot name host variables,
approval never contains values, reusable grants never match, leases expire,
and every unsupported backend fails before execution.

Native fault tests cover every boundary before and after directory creation,
file write, permission change, sandbox construction, Worker confirmation,
durable launch evidence, user release, output persistence, termination, and
unlink. They assert that no pre-release fault runs user code and that no
automatic restart replays a lost lease.

Real macOS and Linux tests run Pipe and background PTY commands whose output
contains each secret at adversarial chunk boundaries. After success, timeout,
cancellation, launch failure, Supervisor restart, and Worker loss, the harness
scans thread JSONL, artifacts, native manifests, state heads, cursor logs,
diagnostics, and client responses for the raw sentinel. It also verifies mode
`0700`/`0400`, denied network, live attach redaction, and cleanup evidence.

Windows CI remains a protocol, durable compatibility, Job Object, and ConPTY
regression gate. It does not become a Windows secret-injection claim.

## Completion criteria

Phase 4C3 closes only when one implementation commit passes:

- Linux shared `verify`;
- Linux `linux-native` with real Bubblewrap secret acceptance;
- `macos-native` with real Seatbelt secret acceptance; and
- `windows-native` compatibility and explicit-rejection regression.

Closure also requires the security guarantee to state the exact supported
profiles, injection target, redaction limitations, persistence evidence,
cleanup semantics, and deferred work. Passing C3A, C3B, or C3C alone does not
complete Phase 4C3.
