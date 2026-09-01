# macOS Preview UX1: First-Run Onboarding and Provider Setup

- Status: Accepted for implementation
- Date: 2026-09-01
- Scope: credential-safe first-run setup, workspace Provider/model preference,
  explicit connection checking, and clearer CLI/TUI readiness guidance
- Depends on: completed unsigned macOS preview installer, existing app-server
  runtime settings, and built-in Provider profiles
- Does not add: credential persistence, macOS Keychain integration, a global
  configuration layer, a graphical application, or automatic network requests

## Diagnosis

Koda can now be installed and rolled back as an unsigned macOS preview, but a
new user still has to infer the correct Provider environment variable, model,
workspace preference, and next command from documentation or a configuration
error. The runtime already exposes built-in Provider metadata and stores
revision-checked non-secret workspace preferences, so a separate setup store
would duplicate policy and create another precedence layer.

The first-run path must improve product usability without weakening the current
secret boundary. Provider credentials remain process environment only. They
must not enter command arguments, JSON-RPC fields, durable events, settings,
logs, test snapshots, or setup output.

## Guiding policies

1. Reuse the current Provider profiles, app-server initialization metadata, and
   workspace settings instead of creating another configuration subsystem.
2. Persist only non-secret Provider/model preference; credentials remain in the
   host environment.
3. Never perform a billable or externally visible Provider request unless the
   user explicitly supplies `--check`.
4. Keep non-interactive CLI behavior deterministic: missing selections never
   cause an input wait.
5. Let credential-free TUI users inspect history and settings; block only the
   operation that actually requires a Provider request.
6. Normalize errors into bounded categories without returning request headers,
   credential values, or unbounded Provider bodies.

## Selected approach

Add a thin `koda setup` workflow over the existing application boundary. It
connects to the app-server, reads initialization Provider metadata and current
workspace settings, selects a Provider and model, and writes the preference
with the exact settings revision. The command does not own a database or
configuration file.

Alternatives were rejected for this slice:

- a global setup file creates new precedence and migration rules;
- a TUI-only wizard cannot serve scripts or ordinary CLI users;
- automatic first-launch setup makes existing commands unexpectedly
  interactive;
- plaintext credential storage violates the existing secret model;
- macOS Keychain support is a separate security and lifecycle design.

## Command surface

```bash
koda setup
koda setup --provider deepseek --model deepseek-v4-pro
koda setup --check
koda setup --json
```

An interactive terminal may prompt for Provider and model. In a non-interactive
environment, missing selections are resolved only from explicit flags, existing
workspace preference, environment defaults, and built-in defaults; the command
never waits for input.

Human output includes the canonical workspace, selected Provider/model,
credential environment-variable name, current availability, save result, and
next commands. JSON output uses a versioned strict schema with the same
value-safe facts. Neither output includes an environment-variable value.

## Data flow and persistence

1. Canonicalize the requested workspace.
2. Start or connect to the installed/repository app-server.
3. Read the strict Provider list returned by `initialize`.
4. Read `settings/get` for the canonical workspace.
5. Resolve selection in this order: explicit flags, interactive choice,
   workspace preference, `KODA_PROVIDER`/`KODA_MODEL`, built-in default.
6. Save Provider/model through `settings/update` with the exact observed
   revision.
7. Re-read or validate the returned preference and render a bounded result.
8. When `--check` is present, perform the explicit Provider check only after
   local setup succeeds.

Concurrent revision conflicts fail without overwriting another client. Setup
does not modify shell startup files. It prints a current-shell `export` example
and a neutral instruction to place the variable in the user's preferred secret
management mechanism.

## Provider check

`--check` is opt-in and sends one minimal, no-Tool request through the existing
Provider adapter. The check verifies that the selected credential, endpoint,
and model can complete a bounded response. It does not create a durable coding
thread or mutate the workspace.

Results distinguish success, missing credential, authentication, unknown or
unsupported model, rate limiting, network failure, cancellation, and bounded
unknown Provider failure. Raw Provider output and credentials are never copied
into the result. Credential-free CI uses fake Providers; live checking is an
explicit local acceptance step.

## CLI and TUI guidance

`koda run` retains its non-interactive failure behavior but adds the exact
`koda setup` recovery command and credential variable name. The TUI may start
without the selected Provider credential so users can inspect history,
settings, extensions, artifacts, and help. It presents a visible readiness
notice and blocks Prompt submission with actionable setup/restart guidance.

`/status` projects selected Provider, model, and a boolean credential-ready
state. No client receives or stores the credential itself.

## Delivery slices

### UX1A: setup core and CLI

- strict setup input/result contracts;
- `koda setup` dispatcher and argument parsing;
- interactive and deterministic non-interactive selection;
- revision-safe workspace preference persistence;
- bounded human and JSON output;
- local credential-availability detection without value projection.

### UX1B: existing-client guidance

- actionable `koda run` missing-credential errors;
- credential-free TUI startup and readiness notice;
- Prompt-time request blocking and `/status` projection;
- consistent help and next-command guidance.

### UX1C: explicit check and dogfooding

- opt-in minimal live Provider check;
- fake-Provider conformance and error normalization;
- installed unsigned-bundle setup acceptance;
- explicit real-Provider macOS dogfooding across chat, approval, patch,
  command, PTY, background process, and recovery flows.

## Verification

Unit and integration tests cover selection precedence, Provider metadata,
interactive and non-interactive behavior, revision conflicts, corrupt settings,
missing credentials, every normalized check result, cancellation, and strict
JSON output. Adversarial fixtures place credential-like sentinels in the
environment and Provider errors and prove they never appear in stdout, stderr,
settings, or durable events.

The unsigned macOS acceptance path verifies setup status and preference saving
through the installed bundle without credentials. Live Provider acceptance is
manual and explicit; CI remains credential-free.

## Completion criterion

UX1 is complete when a newly installed macOS preview user can discover and
select a supported Provider/model, configure the named environment variable,
optionally verify the live connection, and enter CLI/TUI work without any
credential persistence or ambiguous recovery instructions.
