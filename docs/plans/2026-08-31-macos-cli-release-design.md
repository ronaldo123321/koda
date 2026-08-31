# Koda Mac Release 1A Design

- Status: Approved — implementation pending
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

An internal `@koda/distribution` workspace package owns the installed bootstrap,
manifest schemas, doctor command, and release assembly contract. It depends on
the CLI, TUI, and app-server packages so a production `pnpm deploy` operation
can create one portable dependency tree after the normal workspace build.

The assembly pipeline:

1. checks out an exact commit and installs the frozen lockfile;
2. runs formatting, type checking, Rust clippy, and the complete test suite;
3. builds TypeScript packages and `koda-exec` in release mode;
4. deploys production dependencies without workspace links that escape the
   payload;
5. downloads an exact Node.js release for the target architecture and verifies
   it against the official signed checksum inventory;
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
- preserves and verifies the official Node.js signature;
- signs Koda-owned Mach-O executables and packaged native add-ons using a
  Developer ID Application identity, Hardened Runtime, and secure timestamp;
- rejects unsigned or unexpectedly signed executable code;
- submits the exact distribution archive with `notarytool` and waits for an
  accepted result;
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
- no `KODA_EXEC_PATH`;
- a read-only installed payload;
- paths containing spaces and Unicode;
- fresh and pre-existing `KODA_HOME` directories.

The native acceptance suite proves protected Pipe and PTY commands, Seatbelt,
rlimit evidence, foreground cancellation, background detach/attach, Supervisor
restart, app-server shutdown, and durable history compatibility. A credentialed
manual release gate performs one real Provider turn without recording the key.

## Delivery slices

### MR1A1 — release runtime contract

- authoritative Koda release version;
- manifest/inventory schemas and canonicalization;
- development/release installation resolver;
- unified command dispatcher;
- stable bundle errors;
- `koda doctor --bundle-only` core;
- deterministic tests and fixtures.

### MR1A2 — local standalone bundle

- `@koda/distribution` portable production deploy;
- pinned verified Node acquisition;
- release-mode app-server and executor resolution;
- release Rust build and native add-on inventory;
- deterministic archive assembly;
- repository-independent arm64 smoke and full doctor.

### MR1A3 — dual-architecture CI and Homebrew contract

- native arm64 and Intel build jobs;
- unsigned artifact retention;
- clean-install and corruption-negative tests;
- Formula template/generation and Formula smoke;
- same-commit bundle metadata comparison.

### MR1A4 — signed public preview

- protected Developer ID and notarization credentials;
- nested Mach-O signing and signature audit;
- notarized release archive;
- GitHub Release checksums and provenance metadata;
- Homebrew Tap publication;
- clean-machine and real-Provider release checklist.

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
