# Unsigned macOS Internal Preview Installer Design

- Status: Complete — local two-commit acceptance and native arm64/Intel CI lifecycle verified
- Date: 2026-09-01
- Scope: user-local installation, activation, rollback, and removal of unsigned
  macOS internal-preview bundles
- Depends on: MR1A1-MR1A3 and the existing `@koda/distribution` bundle contract
- Does not complete: MR1A4 signing, notarization, public GitHub Release, public
  Homebrew publication, or clean-machine public acceptance

## Context

MR1A4 is paused because no release maintainer currently has an Apple Developer
Program account. Koda must not weaken its Developer ID, notarization,
provenance, or Gatekeeper requirements to bypass that external blocker. The
existing unsigned arm64/x64 bundle and CI contracts are nevertheless sufficient
for internal macOS testing.

The immediate product need is a repeatable loop from a repository or downloaded
CI archive to a normal user command, without requiring `sudo`, overwriting an
active installation in place, modifying shell startup files, or deleting Koda
runtime data.

## Goals

- Install a verified unsigned Koda bundle beneath one user-owned preview root.
- Keep installed versions immutable and switch the active version atomically.
- Preserve the last active version as a rollback target.
- Recover deterministically after interruption at every activation boundary.
- Reuse release manifests, integrity verification, dispatchers, and doctor
  behavior from `@koda/distribution`.
- Support repository-built bundles and explicit local CI archive paths.
- Keep output concise, deterministic, and useful to both people and scripts.
- Exercise the complete lifecycle on macOS without touching the developer's
  actual preview installation during automated tests.

## Non-goals

- Signing, notarizing, stapling, or claiming Gatekeeper acceptance.
- Publishing or downloading GitHub Releases or updating the public Homebrew Tap.
- Editing `.zshrc`, `.bashrc`, system PATH configuration, `/usr/local`, or
  `/Applications`.
- Automatically pruning old versions in the first slice.
- Migrating, deleting, or interpreting `${KODA_HOME:-$HOME/.koda}` data.
- Self-update from the installed `koda` command.
- Linux or Windows installation behavior.

## Selected approach

Use a versioned user-local store with stable launchers and atomic symlink
activation. This is preferred over overwriting one directory because a failed
upgrade cannot damage the active bundle. It is preferred over an internal
Homebrew Tap because it keeps unsigned internal testing independent from the
public release and signing path.

The default layout is:

```text
~/.local/share/koda-preview/
├── versions/
│   └── 0.1.0+<commit>/
├── transactions/
├── current -> versions/<active>
├── previous -> versions/<previous>
├── state.json
└── operation.lock/

~/.local/bin/
├── koda
└── koda-chat
```

Tests and advanced internal workflows may override the roots with
`KODA_PREVIEW_ROOT` and `KODA_PREVIEW_BIN_DIR`. Overrides must be absolute and
must pass the same containment checks as defaults. `KODA_HOME` remains runtime
data and is never reused as an installation root.

## Version identity and immutable payloads

An installed identity is derived from the validated release manifest version
and exact source commit: `<version>+<short-commit>`. Both full values remain in
state; the display identity is not used as the only integrity key.

The installer rejects:

- an archive whose architecture differs from the current Mac;
- a bundle whose manifest, integrity inventory, critical files, component
  versions, or native executor fail existing distribution validation;
- an existing identity whose bytes do not match the candidate;
- absolute archive paths, `..` traversal, duplicate entries, unsupported entry
  types, escaping symlinks, or extraction outside the staging directory;
- an archive or extracted tree that exceeds explicit entry, file, or total-byte
  limits.

Successfully installed version directories are treated as immutable. A repeat
installation with the same identity succeeds only when the verified payload is
identical; otherwise it fails closed.

## Components and command surface

`@koda/distribution` owns reusable preview-installation types, schemas, path
validation, archive inspection/extraction, state recovery, activation, rollback,
status, and uninstall operations. A thin repository-side command entry point
parses arguments and renders results. It does not duplicate bundle assembly or
runtime verification.

Repository scripts expose:

```bash
pnpm preview:build
pnpm preview:install [--archive <absolute-path>]
pnpm preview:status [--json]
pnpm preview:rollback
pnpm preview:uninstall --yes
```

`preview:build` builds only the current host architecture through the existing
bundle implementation. `preview:install` uses that build by default or an
explicit local archive. The first implementation performs no network request.

## Install and activation flow

Every mutating command acquires the preview operation lock before recovery or
mutation. Installation then:

1. resolves and validates all managed roots;
2. reconciles any interrupted activation journal;
3. inspects the archive into a new staging directory on the versions
   filesystem;
4. validates paths and extracts with bounded resource limits;
5. loads the release installation and verifies full integrity;
6. runs the staged bundle's `koda doctor --bundle-only` entry point;
7. atomically renames the staged directory to its immutable version path;
8. writes and synchronizes an activation journal containing before/after
   targets and the exact operation identity;
9. updates `previous`, then updates `current`, using temporary relative
   symlinks and atomic rename;
10. installs stable user launchers that resolve through `current`;
11. writes the validated state projection and commits/removes the journal.

The current active installation is not changed until candidate validation and
doctor both pass.

## Locking and crash recovery

The lock is an atomically created directory containing bounded owner metadata:
schema version, PID, start time, command, and random operation ID. A live owner
causes a deterministic conflict. A dead owner may be recovered; a reused PID or
ambiguous owner fails closed and reports the exact managed lock path.

The activation journal is written before link mutation. Recovery compares the
journal with actual `current` and `previous` targets:

- if `current` still names the before target, restore the before projection and
  leave the candidate inactive;
- if `current` names the after target, finish `previous` and state publication;
- if neither exact state matches, retain the journal and reject every mutation.

Status remains read-only. It reports unresolved recovery evidence rather than
changing it. No recovery path guesses from timestamps or directory ordering.

## Rollback and uninstall

Rollback requires both current and previous targets, validates the previous
bundle again, journals the exact swap, and then atomically activates it. The
former current version becomes the new previous target. A corrupt or missing
previous version is never activated.

Uninstall requires explicit `--yes`. It removes only validated stable launchers,
managed links, journals, state, and version directories contained beneath the
preview root. It never removes runtime state, Provider credentials, threads,
artifacts, settings, or arbitrary files. Unknown files, unexpected links, root
escape, an active mutation, or ambiguous ownership stop deletion. Users are
warned to exit running Koda sessions first.

The first slice retains every installed version during ordinary install and
rollback. A separate, later design may add explicit pruning after live-process
and rollback safety are defined.

## Status and output contract

Human output reports the active and previous identities, absolute managed paths,
architecture, integrity/doctor result, unsigned status, pending recovery, and a
PATH remedy when the bin directory is not discoverable. It never edits shell
configuration.

Example:

```text
Koda preview installed
active:   0.1.0+8b94d5c
previous: 0.1.0+59c9f2c
bin:      /Users/example/.local/bin/koda
doctor:   passed
signing:  unsigned internal preview
```

`--json` returns a versioned schema with the same value-safe facts and stable
error codes. Errors do not include environment values, Provider credentials, or
unbounded child output.

## Verification

Unit tests cover path containment, roots, schemas, identities, link plans,
archive limits, lock ownership, and every recovery classification.

Temporary-directory integration tests cover first install, idempotent install,
upgrade, rollback, status, uninstall, damaged state, damaged payload, wrong
architecture, malicious archives, launcher drift, lock conflicts, and unknown
managed-root content.

Fault-injection tests interrupt every journal, directory rename, symlink rename,
launcher, state, and cleanup boundary. After restart, the active installation
must be either the exact old verified bundle or the exact new verified bundle;
no partial payload may become active.

A macOS acceptance job uses temporary `HOME`, preview root, bin directory, and
runtime data. It builds and installs the real current-architecture bundle, then
runs:

- `koda --version`;
- `koda doctor` and `koda doctor --bundle-only`;
- app-server initialization/shutdown smoke;
- upgrade and rollback verification;
- uninstall verification with runtime data preserved.

The job explicitly records `unsigned internal preview`. It does not execute or
claim Developer ID, Notary, Gatekeeper, public Release, or public Tap checks.

## Implementation and acceptance record

The reusable `@koda/distribution` core now owns strict target/state/journal
schemas, managed-root validation, atomic JSON and relative-link replacement,
single-owner operation locking, dead-owner recovery, and exact activation
reconciliation. The repository-side distribution app implements build,
install, status, rollback, and confirmed uninstall commands. Candidate archives
reuse the release verifier, are copied into a controlled staging root, are
checked for the current architecture and full integrity, and pass one complete
standalone doctor/app-server/native smoke before activation.

Focused tests cover path and identity validation, canonical projections,
atomic state/link I/O, live and stale locks, pre-switch and post-switch crash
recovery, divergent evidence, launcher drift, explicit uninstall confirmation,
unknown managed-root content, and runtime-data preservation. The existing
release tests continue to cover archive corruption, malformed entries,
architecture metadata, integrity inventories, and Mach-O auditing.

Local arm64 acceptance exercised two honest repository commits. It installed
`0.1.0+db07bc75ff37`, installed `0.1.0+d9393031ac15` as an upgrade with the first
target preserved as `previous`, rolled back to the first target, and then
uninstalled. Both active targets passed full integrity plus the native
supervisor/app-server smoke; the stable launcher passed `koda --version` and
bundle doctor, and a sibling runtime-data sentinel survived uninstall.

The unsigned macOS release workflow now runs first install, read-only JSON
status, stable-launcher version and doctor, idempotent reinstall, explicit
uninstall, launcher removal, and runtime-data preservation on native arm64 and
Intel runners. Upgrade/rollback remains covered by deterministic state/recovery
tests and the two-commit local acceptance above; a CI two-version artifact
matrix is a later hardening item because CI must not fabricate a source commit
that does not match its checked-out bytes.

Implementation commit `50ae01c` passed the complete local suite and
[GitHub Actions macOS Release Contract run 33505291467](https://github.com/ronaldo123321/koda/actions/runs/33505291467):
native arm64 and Intel bundles both passed the new unsigned lifecycle before
the shared metadata and isolated Homebrew contract completed successfully. The
same commit also passed
[CI run 33505291652](https://github.com/ronaldo123321/koda/actions/runs/33505291652)
across verify, Linux, macOS, and Windows jobs.

## Acceptance criteria

This slice is complete when a developer can build or select an explicit local
unsigned archive, install it without elevated privileges, use stable `koda` and
`koda-chat` commands, inspect exact state, upgrade without risking the active
bundle, recover from injected interruption, roll back, and uninstall without
changing Koda runtime data.
