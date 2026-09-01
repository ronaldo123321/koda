# Koda Mac Release 1A Design

- Status: In progress — MR1A1 through MR1A3 complete; MR1A4 implementation and
  credential-free GitHub infrastructure complete, credentialed publication
  acceptance pending
- Date: 2026-08-31
- Target: macOS CLI/TUI developer preview
- Depends on: completed Phase 3, Phase 4A, Phase 4B, Phase 4C2A, Phase 4C3,
  Phase 4C4A, and Phase 4C4B

## Decision

Koda will deliver a self-contained macOS CLI/TUI release before adding new
Linux or Windows platform features. This is a delivery-order change, not an
architecture rewrite. The existing TypeScript agent/application layer, stdio
app-server, Rust `koda-exec`, durable stores, protocols, approvals, and security
evidence remain authoritative.

The first release is a developer preview distributed as architecture-specific
GitHub Release archives and installed through Homebrew. It does not require a
user-installed Node.js, pnpm, or Rust toolchain.

## Scope

Mac Release 1A delivers:

- native `darwin-arm64` and `darwin-x64` release bundles;
- one unified `koda` command plus a compatible `koda-chat` alias;
- a pinned embedded Node.js runtime;
- a production-only portable JavaScript dependency tree;
- the matching signed Rust `koda-exec` and native Node add-ons;
- strict installed-runtime discovery and integrity diagnostics;
- unsigned pull-request artifacts and signed/notarized tag releases;
- a Homebrew Formula and installed-bundle smoke tests;
- environment-variable Provider credentials for the first preview.

It does not deliver a native graphical application, `.pkg`, self-updater,
Keychain credentials, remote transport, Linux resource enforcement, new
Windows sandbox/resource/secret features, or Phase 5 child agents and memory.

## User-facing command contract

The installed command surface is:

```text
koda                         # open the interactive TUI
koda chat [options]          # explicitly open the interactive TUI
koda run <prompt> [options]  # run one non-interactive task
koda app-server              # run the local stdio JSON-RPC server
koda doctor [--bundle-only] [--json]
koda --version
koda-chat [options]          # compatibility alias for `koda chat`
```

Existing non-interactive CLI subcommands remain available. `koda --help`
documents the combined installed surface instead of exposing separate package
entry points. Automation using `koda run` keeps its current behavior.

## Installed layout

Each release archive has one immutable runtime root:

```text
koda/
├── bin/
│   ├── koda
│   └── koda-chat
└── libexec/koda/
    ├── node/bin/node
    ├── app/
    ├── native/koda-exec
    ├── runtime-manifest.json
    └── integrity.json
```

The launchers are minimal POSIX scripts. They resolve the real installation
root, including Homebrew Cellar symlinks, quote every path, and invoke only the
embedded Node entry point. They do not evaluate shell strings or search `PATH`
for application components.

`KODA_HOME` continues to own user data. Installing, upgrading, downgrading, or
removing the runtime never mutates thread history, artifacts, settings,
workspace mutation journals, or native execution state.

## Runtime manifest and integrity

`runtime-manifest.json` is strict, versioned, and generated rather than edited.
Its initial schema binds:

- product and Koda version;
- `darwin` platform and `arm64` or `x64` architecture;
- pinned Node version and relative executable path;
- CLI, TUI, app-server, and doctor entry paths;
- native executor path and native protocol version;
- app-server protocol version;
- the digest of the complete sorted integrity inventory.

`integrity.json` contains a canonical sorted inventory of immutable payload
files with relative path, byte length, and SHA-256. It rejects absolute paths,
parent traversal, duplicates, symlinks inside the immutable payload, unknown
fields, unsafe integers, and unbounded input.

Normal startup checks the strict manifest, platform, architecture, inventory
digest, and the critical Node, entry-point, and executor files. `koda doctor
--bundle-only` verifies the complete inventory. These hashes detect assembly or
local corruption; release archive checksums, Homebrew checksums, and code
signatures establish release provenance.

## Development and release path resolution

Release mode is discovered structurally from a valid manifest anchored to the
running distribution entry point. It cannot be enabled or disabled by an
environment variable.

In release mode:

- app-server and `koda-exec` resolve only beneath the manifest-owned runtime;
- `KODA_EXEC_PATH` and application-entry overrides are ignored;
- a missing, mismatched, or corrupt component fails before a turn or job starts;
- no TypeScript executor fallback is allowed after native resolution fails.

In source/development mode, the manifest is absent. Existing package resolution
and explicit `KODA_EXEC_PATH` behavior remain available for contributors and
tests. The two modes share the same protocol and application behavior.

## Build and assembly

The distribution implementation is split at a deliberate dependency boundary.
The low-level `@koda/distribution` workspace package owns versions, manifest
schemas, installed-runtime discovery, integrity checks, bounded errors, and the
doctor report contract. It depends only on the public protocol package. The
`@koda/distribution-app` package owns the installed bootstrap and unified
dispatcher, and depends on `@koda/distribution`, CLI, TUI, and app-server. This
keeps runtime components free to consume release resolution without creating a
dependency cycle. MR1A2 uses the frozen lockfile to create a temporary isolated
production `pnpm deploy` tree, bundles the dispatcher, CLI, TUI, and app-server
into four ESM entry points, and copies only the target `better-sqlite3` native
add-on closure. The temporary pnpm links never enter the immutable payload.

The assembly pipeline:

1. checks out an exact commit and installs the frozen lockfile;
2. runs formatting, type checking, Rust clippy, and the complete test suite;
3. builds TypeScript packages and `koda-exec` in release mode;
4. deploys the locked production dependency graph to a temporary build tree,
   bundles four stable ESM entry points, and rejects every link in the final
   payload;
5. downloads an exact Node.js release for the target architecture and verifies
   its pinned SHA-256 against an OpenPGP-verified official checksum inventory;
6. assembles a fresh staging directory with fixed permissions and timestamps;
7. inventories all payload files and writes the strict manifests;
8. runs the bundle from outside the repository with development tool paths
   removed;
9. signs/notarizes only in an authorized tag-release job;
10. publishes the exact verified archive and its SHA-256.

The native dependency inventory includes both `koda-exec` and packaged Node
add-ons such as `better-sqlite3`; release validation detects Mach-O files by
content rather than trusting filename extensions.

## Architecture matrix

Two native jobs build and test independently:

- Apple Silicon on an arm64 macOS runner;
- Intel on an Intel macOS runner.

Each archive contains exactly one architecture. Koda does not combine binaries
with `lipo`, silently run Intel code through Rosetta, or claim an architecture
that was not natively smoke-tested.

## Signing, notarization, and release authority

Pull requests and ordinary branch builds create unsigned test bundles. They
must prove assembly and execution behavior without access to signing secrets.

Only a protected `v*` tag workflow can create a public release. That workflow:

- verifies the tag version against the manifest version;
- verifies the official Node.js checksum inventory with a commit- and
  digest-pinned `nodejs/release-keys` keyring and the expected release signer;
- signs the embedded Node Mach-O, Koda-owned executables, and packaged native
  add-ons using a Developer ID Application identity, Hardened Runtime, and
  secure timestamp;
- rejects unsigned or unexpectedly signed executable code;
- submits the exact public ZIP archive with `notarytool` and waits for an
  accepted result (unsigned CI retains deterministic `.tar.gz` candidates);
- verifies the resulting Gatekeeper assessment and code signatures;
- publishes immutable checksums and the Homebrew Formula update.

Unavailable Apple credentials block only the signed MR1A4 release step. They do
not block the runtime contract, local bundle, or unsigned dual-architecture CI.

## Homebrew delivery and upgrades

The Formula selects an immutable architecture-specific URL and SHA-256, installs
the payload beneath its versioned prefix, and exposes only `koda` and
`koda-chat` in `bin`. It does not depend on a global Node installation and does
not download required application code at runtime.

The Formula test runs at least `koda --version` and `koda doctor --bundle-only`
against the installed prefix. Release acceptance additionally runs a real local
app-server/native handshake outside the repository.

Mac Release 1A has no self-modifying updater. Users install and upgrade with
Homebrew. Koda may report its current version, but it does not overwrite its
own Cellar files or fetch executable updates.

## Provider credentials

The developer preview retains the current trusted environment-variable
catalog, including the supported OpenAI, Anthropic, DeepSeek, Kimi, and GLM
profiles. `koda doctor` reports only whether the selected Provider's credential
is present; it never prints, hashes, stores, or transmits the value for
diagnostics.

Keychain-backed `koda auth` commands remain a later Mac release slice. Plaintext
credential files are not introduced as an interim shortcut.

## Failure contract

Distribution failures use stable public codes and bounded messages. Initial
categories are:

- `KODA_BUNDLE_MANIFEST_INVALID`;
- `KODA_BUNDLE_PLATFORM_MISMATCH`;
- `KODA_BUNDLE_ARCH_MISMATCH`;
- `KODA_BUNDLE_INTEGRITY_FAILED`;
- `KODA_BUNDLE_COMPONENT_MISSING`;
- `KODA_BUNDLE_VERSION_MISMATCH`;
- `KODA_APP_SERVER_START_FAILED`;
- `KODA_NATIVE_EXECUTOR_UNAVAILABLE`;
- `KODA_PROVIDER_CREDENTIAL_MISSING`.

Messages may include bounded canonical component paths and versions but never
environment values, Provider keys, secret contents, unbounded child stderr, or
raw protocol frames. Every actionable failure points to `koda doctor` or one
specific installation/configuration remedy.

TUI or CLI shutdown terminates its owned app-server child. Jobs already handed
to the native Supervisor retain the existing durable background ownership and
recovery semantics.

## Diagnostics

`koda doctor --bundle-only` performs offline checks for:

- manifest and inventory schemas;
- platform and architecture;
- critical and full payload digests;
- Node, native add-on, and executor architecture/signature state;
- expected versions and protocol compatibility;
- immutable-root path containment.

`koda doctor` additionally checks `KODA_HOME` privacy/writeability, app-server
initialization, native Supervisor handshake, macOS Seatbelt/resource capability
self-tests, TTY availability, and value-free Provider credential presence.

`--json` returns one bounded versioned report with check IDs, status, public
code, and safe remediation. Human output is a projection of the same report.

## Verification and acceptance

Unit and integration tests cover strict schemas, canonical manifests, path
traversal, symlink and duplicate rejection, platform/architecture mismatches,
unknown versions, corruption, missing components, override rejection in release
mode, source-mode compatibility, bounded diagnostics, and secret-free errors.

Packaged smoke tests run with:

- a working directory outside the repository;
- Node, pnpm, Cargo, and Rust removed from `PATH`;
- a malicious `KODA_EXEC_PATH` override that release resolution must ignore;
- a read-only installed payload;
- paths containing spaces and Unicode;
- fresh and pre-existing `KODA_HOME` directories.

The native acceptance suite proves protected Pipe and PTY commands, Seatbelt,
rlimit evidence, foreground cancellation, background detach/attach, Supervisor
restart, app-server shutdown, and durable history compatibility. A credentialed
manual release gate performs one real Provider turn without recording the key.

## Delivery slices

### MR1A1 — release runtime contract

Status: Complete.

- authoritative Koda release version;
- manifest/inventory schemas and canonicalization;
- development/release installation resolver;
- unified command dispatcher;
- stable bundle errors;
- `koda doctor --bundle-only` core;
- deterministic tests and fixtures.

Implementation notes:

- `@koda/distribution` owns the strict low-level runtime contract and
  `@koda/distribution-app` owns the cycle-free unified executable;
- normal release discovery verifies manifest/inventory compatibility and every
  critical file, rejects symlink traversal, and ignores executor overrides;
- `koda doctor --bundle-only` performs the complete immutable payload scan;
- the canonical v1 fixture and distribution suite cover source/release mode,
  corruption, missing metadata, platform/architecture/protocol mismatch,
  bounded public errors, routing, and launch plans.

### MR1A2 — local standalone bundle

Status: Complete.

- `@koda/distribution` portable production deploy;
- pinned verified Node acquisition;
- release-mode app-server and executor resolution;
- release Rust build and native add-on inventory;
- deterministic archive assembly;
- repository-independent arm64 smoke and full doctor.

Implementation notes:

- Node.js 22.20.0 arm64/x64 archive names and SHA-256 digests are exact source
  constants; local assembly rechecks the official HTTPS inventory and archive
  bytes. OpenPGP verification of the signed inventory remains MR1A4 release
  provenance work.
- The final runtime contains four symlink-free ESM entry points, embedded Node,
  release `koda-exec`, and only the selected Darwin `better-sqlite3` prebuild.
  Release CLI, TUI, and app-server resolve their installation from
  `import.meta.url`; executor and app-server environment overrides cannot move
  them outside the manifest-owned root.
- Assembly rejects output replacement, payload links, control-character paths,
  fat or cross-architecture Mach-O files, corrupt Node downloads, incomplete
  metadata, and failed repository-independent runtime checks.
- Local arm64 acceptance passed full integrity, an extracted-archive
  `--version` and doctor run, app-server initialize/list/shutdown with native
  interactive-process capability, Unicode/space paths, a restricted tool
  `PATH`, and a malicious executor override.
- Two independent assemblies produced byte-identical payloads and the same
  archive SHA-256. The tar file list and payload metadata are normalized, and
  gzip runs with filename/timestamp recording disabled.

### MR1A3 — dual-architecture CI and Homebrew contract

Status: Complete.

- native arm64 and Intel build jobs;
- unsigned artifact retention;
- clean-install and corruption-negative tests;
- Formula template/generation and Formula smoke;
- same-commit bundle metadata comparison.

Implementation notes:

- each native job runs on an explicit GitHub-hosted `macos-15` arm64 or
  `macos-15-intel` x64 runner, rejects an unexpected host architecture, and
  retains the unsigned archive, checksum, and strict architecture-specific
  release metadata for 14 days;
- release metadata binds the exact source commit, runtime contract, manifest
  and inventory digests, native Mach-O inventory, archive byte length, and
  archive SHA-256. The aggregate job accepts exactly one arm64 and one x64
  document and requires their architecture-neutral contracts to match;
- archive acceptance rechecks size and SHA-256, validates a sorted single-root
  tar inventory, extracts to a fresh directory outside the repository, reruns
  full payload and Mach-O verification, executes the standalone smoke on the
  matching native host, and proves a deterministic byte-flipped archive is
  rejected before extraction;
- the Formula generator derives both immutable sources and hashes from the
  compared metadata. CI checks Ruby syntax, creates an isolated local tap,
  installs the arm64 candidate through Homebrew, and runs the Formula test
  against the real Cellar layout;
- branch and pull-request jobs remain unsigned and read-only with respect to
  GitHub Releases and the public Tap. Developer ID signing, notarization,
  signed Node checksum provenance, and publication remain exclusively MR1A4.

### MR1A4 — signed public preview

Status: Implementation and credential-free GitHub infrastructure complete;
protected credentials and first publication acceptance pending.

- protected Developer ID and notarization credentials;
- nested Mach-O signing and signature audit;
- notarized release archive;
- GitHub Release checksums and provenance metadata;
- Homebrew Tap publication;
- clean-machine and real-Provider release checklist.

Implementation notes:

- `.github/workflows/macos-public-release.yml` runs only for `v*` tag pushes,
  requires the exact `v0.1.0` version authority, pins all invoked GitHub Actions
  by commit, and separates read-only provenance from the protected
  `macos-public-release` environment;
- Node `v22.20.0` is bound to the exact signed `SHASUMS256.txt.asc` digest, the
  exact `nodejs/release-keys` commit/keyring digest, signer fingerprint, and
  both architecture archive hashes. A missing `gpgv`, changed keyring,
  unexpected signer, or changed inventory blocks signing;
- public assembly re-signs all three detected Mach-O roles (embedded Node,
  `koda-exec`, and `better-sqlite3`) with fixed identifiers. Audit requires one
  expected Developer ID team, valid strict signatures, Hardened Runtime,
  secure timestamps, exact architecture, and no extra native payload;
- signing happens before integrity metadata is generated, so the installed
  runtime hashes the signed bytes. The exact resulting deterministic ZIP is
  verified, corruption-tested, submitted to Apple, and never repacked after
  notarization;
- accepted Notary response, post-submission code-signature audit, online
  Gatekeeper assessment, release metadata, Formula, Node provenance, and both
  architectures are transitively bound by strict canonical evidence documents
  and `SHA256SUMS`;
- publication is idempotent but immutable: a retry accepts an existing GitHub
  prerelease only when every downloaded asset and the complete asset-name set
  match the locally regenerated checksums. The Tap commit is similarly a no-op
  only when the Formula already matches;
- the protected Environment, active `refs/tags/v*` ruleset, initialized public
  Tap repository, and Tap repository variable are configured. No release tag
  exists yet, and no private credential is recorded in repository history;
- the repository cannot prove possession or correctness of external
  Developer ID, App Store Connect, protected-environment, or Tap credentials.
  Their setup and the first clean-machine/real-Provider acceptance are tracked
  in [the MR1A4 release runbook](../release/macos-public-preview-runbook.md).

## Completion criterion

Mac Release 1A is complete when a clean supported arm64 or Intel Mac can install
Koda through Homebrew, run `koda` without a development toolchain or path
override, complete a real Provider turn, execute a protected native command,
recover a background PTY across control-plane restart, pass `koda doctor`, and
upgrade through Homebrew without modifying user state.

## Explicit deferrals

The following remain planned but are not Mac Release 1A completion conditions:

- Linux C4C2-C4C4 rlimit/cgroup enforcement and closure;
- new Windows sandbox, secret, and resource enforcement;
- authenticated remote app-server/MCP operation;
- full plugin registry and update supply chain;
- `.pkg`, graphical macOS application, automatic updater, and Keychain auth;
- Phase 5 multi-agent coordination and curated memory.

Existing Linux and Windows implementations remain supported regression gates
for shared protocol and durable-format changes. Deferral does not delete or
reinterpret completed cross-platform work.
