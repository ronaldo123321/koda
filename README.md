# Koda

Koda is a local-first coding-agent runtime, CLI, and interactive terminal client under active development.

The project is building the control plane around a coding model: typed conversation state, deterministic model/tool loops, runtime-validated tools, append-only events, cancellation, recovery, and explicit security boundaries.

## Current status

The Phase 3 local-agent foundation, Phase 4A crash-safe workspace recovery,
Phase 4B supervised native execution, Phase 4C1 execution policy/reporting,
Phase 4C2A macOS Seatbelt delivery, Phase 4C2B Linux Bubblewrap delivery,
Phase 4C3 secret lifecycle/client closure, Phase 4C4A resource contract/client
projection, Phase 4C4B macOS resource enforcement, and Phase 4C4C1 contract
evolution are complete; Linux resource enforcement remains in C4C2-C4C4.
Verified macOS and Linux native executors advertise and enforce protected Pipe/PTY
execution. macOS additionally enforces exact per-process CPU time, open-file,
and file-size hard limits through `RLIMIT_CPU`, `RLIMIT_NOFILE`, and
`RLIMIT_FSIZE`; it verifies the installed values before durably recording
`applied` evidence and releasing user code. Native protocol v8, durable format
v8 with exact v1-v7 recovery, app-server v18 resource evidence, grant binding,
background PTY recovery, safe secret lifecycle evidence, adversarial
syscall/network/resource tests, and dedicated native gates are shared or
explicitly verified. Current policy v3 and capability/security v5 call the
cgroup-backed dimension `job_task_count`; frozen policy v2/security v4 records
retain `job_process_count` without reinterpretation. Linux and Windows resource
requests remain fail-closed; macOS address-space and aggregate job-task limits
also remain unsupported.
Windows sandboxing and resource enforcement remain deferred. Koda has an
opt-in Rust execution supervisor with a versioned local protocol, reconnectable
job observation, POSIX process groups, Windows Job Objects and ConPTY, bounded
retained output, explicit native capability reporting, and end-to-end
execution-policy evidence on top of those foundations:

The current delivery priority is
[Mac Release 1A](docs/plans/2026-08-31-macos-cli-release-design.md): a
self-contained macOS CLI/TUI developer preview with an embedded Node runtime,
the matching native executor, strict installed-runtime diagnostics, native
arm64/Intel artifacts, signing/notarization, and Homebrew delivery. Remaining
Linux resource and new Windows security work is deferred, not removed; existing
cross-platform CI remains a regression gate.

MR1A1 through MR1A3 are complete: Koda now has one version authority, strict
versioned runtime and integrity manifests, structural source/release discovery,
fail-closed critical-file verification, a unified `koda`/`koda-chat`
dispatcher, and a reproducible repository-independent macOS arm64 bundle with
embedded Node.js, release `koda-exec`, target-only native add-ons, full doctor,
and real app-server/native smoke coverage. Explicit native arm64/Intel jobs now
retain unsigned artifacts, compare strict same-commit release metadata, rerun
clean-archive and corruption-negative acceptance, and install/test a generated
Formula through an isolated Homebrew tap. MR1A4 now implements OpenPGP Node
provenance, all-Mach-O Developer ID signing/audit, exact-ZIP notarization,
transitive release evidence, immutable GitHub prerelease publication, and
idempotent public Tap updates. Protected credential setup and the first
clean-machine/real-Provider publication acceptance are still pending. The
protected Environment, active `v*` tag ruleset, public
[`homebrew-koda`](https://github.com/ronaldo123321/homebrew-koda) repository,
Tap repository variable, and repository-scoped Tap token secret are configured;
Apple credentials are not.

MR1A4 is therefore paused waiting for an Apple Developer Program account. Koda
continues with unsigned macOS internal testing and CLI/TUI experience work; the
project will not create the public `v0.1.0` tag or weaken signing/notarization
gates to bypass the missing external credential.

The unsigned internal-preview installer is now implemented. It uses a
versioned user-local store, atomic `current`/`previous` activation, strict
release integrity and native smoke checks, stable launchers, exact rollback,
crash recovery, and ownership-checked uninstall. The macOS release workflow
also exercises the credential-free lifecycle on native arm64 and Intel runners;
implementation commit `50ae01c` passed both architectures in
[macOS Release Contract run 33505291467](https://github.com/ronaldo123321/koda/actions/runs/33505291467).
This remains an unsigned internal path and does not complete MR1A4.

Phase 4C3A/C3B/C3C/C3D are complete with strict value-free secret
declarations/evidence, stable cross-language digests and limits, matching
TypeScript/Rust exact-byte streaming redactors, frozen trusted application
catalogs, host-environment resolution into single-use in-memory leases, and
fresh secret-aware command approval. C3C adds a non-replayed authenticated
native start exchange, per-job `0700` directories and `0400` files, declared
`*_FILE` targets, exact Seatbelt/Bubblewrap read-only paths, pre-persistence
Pipe/PTY redaction, and value-free cleanup/redaction evidence. C3D adds strict
app-server v16 evidence, durable process/result projection, and bounded
value-free CLI/TUI summaries. Implementation commit `7a34668` passed the
same-commit Linux verify/native, macOS native, and Windows native acceptance
matrix in [GitHub Actions run 33354068315](https://github.com/ronaldo123321/koda/actions/runs/33354068315).

- Versioned Thread, Turn, Item, and Agent Event schemas.
- A provider-neutral streaming model interface.
- A runtime-validated tool registry.
- A model -> tool -> model agent loop.
- An OpenAI Responses adapter, an Anthropic Messages adapter, and reviewed DeepSeek, Kimi, and GLM Chat Completions profiles.
- Explicit provider selection, provider-specific credentials and defaults, normalized usage/errors, and offline adapter conformance tests.
- Bounded durable provider continuation state for signed Anthropic thinking blocks and domestic-provider `reasoning_content` across tool rounds, compaction, and recovery.
- Workspace-confined `list_files`, `read_file`, and literal `search_text` tools.
- A one-file `apply_patch` tool for exact UTF-8 creates and replacements.
- Runtime write policy, durable approval events, and terminal patch previews.
- SHA-256 snapshot checks and atomic same-directory writes.
- A structured `exec_command` tool that always uses `shell: false`.
- Workspace-confined command directories, filtered environments, bounded output, timeouts, and cancellation.
- Bounded nested `AGENTS.md` and `KODA.md` discovery with explicit directory scopes, stable broad-to-deep ordering, and hashes.
- Provider-neutral per-response token usage events and turn-level aggregation.
- A single-turn `koda run` command with JSONL event persistence.
- Cross-process `koda run --resume <thread-id>` using normalized local history replay.
- Per-turn context snapshots, globally contiguous event sequences, and typed recovery notices.
- Conservative recovery for unfinished tool calls: uncertain side effects are reported and never automatically retried.
- A local thread lease that prevents two live CLI processes from appending to the same log.
- Content-addressed SHA-256 artifacts for oversized read, search, and command output.
- Uniform 64 KiB model-facing excerpts with exact byte counts and retrievable full output.
- A bounded `read_artifact` tool, missing/corrupt artifact recovery diagnostics, and stale temporary-file cleanup.
- A 256 KiB per-model-step provider-output guard and 64 MiB per-stream artifact hard limit.
- A provider-neutral `ContextEngine` with configured input budgets, conservative token estimates, and measured-usage calibration.
- Append-only structured compaction with exact retained item IDs and atomic tool-call/result retention.
- Recovery validation for compaction metadata plus visible added/removed/changed repository-instruction notices.
- OpenAI response-chain reset after mid-turn compaction and a configured `max_output_tokens` reserve.
- A durable `tool.execution_started` boundary after policy and approval, immediately before handler execution.
- Typed process start, exit, termination-attempt, and termination-outcome events tied to the originating tool call.
- POSIX process-group ownership with graceful-to-force escalation, descendant cleanup, and bounded confirmation.
- An independent Rust `koda-exec` supervisor over a private same-user Unix Socket or authenticated Windows Named Pipe, with strict length-prefixed framing, capability negotiation, idempotent starts, reconnectable status/output reads, and no silent TypeScript fallback.
- A startup-frozen execution profile, policy-bound exact-command grants, pre-approval admission evidence, and retained launch-security snapshots across TypeScript Pipe, native Pipe, and native PTY execution.
- Native POSIX process-group and Windows Job Object ownership, plus Worker-owned POSIX PTYs and Windows ConPTY with background jobs, attach/detach, fenced input, resize, restart continuity, and bounded retained terminal output.
- A TypeScript compatibility backend whose Windows tree-aware `taskkill` fallback reports uncertainty honestly rather than claiming native Job Object guarantees.
- Structured interrupted-operation recovery that reports effect and process evidence without replaying a side effect or killing a historical PID.
- A rebuildable SQLite schema v2 projection for thread metadata plus bounded display-worthy history search; JSONL remains authoritative.
- Credential-free `koda thread list` and `koda thread show` commands with canonical workspace filtering.
- WAL-backed concurrent metadata writers, source fingerprint refresh, invalid-log visibility, and corrupt-database quarantine.
- Best-effort post-run indexing that never makes the derived database authoritative over JSONL.
- Reference-aware artifact garbage collection derived only from valid JSONL logs, with a global maintenance lease and fail-closed concurrency checks.
- Credential-free `koda artifact gc` dry runs and explicit `--delete` collection with a configurable minimum age.
- Six deterministic binary scenarios for resume, compaction, prompt injection, process-tree cancellation, artifact retrieval, and uncertain side-effect recovery.
- A shared `KodaApplication` workflow used by both CLI and protocol clients.
- A strict, versioned, newline-delimited JSON-RPC 2.0 app-server over local stdio.
- Durable-before-notify event streaming, one-shot interactive approvals, active-turn cancellation, and graceful shutdown/EOF cleanup.
- Credential-free app-server thread list/get/search operations, bounded bidirectional JSONL event history, and different-thread concurrency guarded by existing per-thread leases.
- A reusable Node app-server client with strict NDJSON framing, typed JSON-RPC correlation, bounded stderr diagnostics, request timeouts, and owned child-process cleanup.
- An Ink `koda-chat` REPL that uses app-server v18 exclusively for sequential chat, approvals, thread browsing, durable search, windowed history navigation, runtime settings, artifact, context, Plan, extension, activity, process/secret/resource evidence, and mutation-recovery inspection, Stage acceptance, and resume.
- Typed bidirectional `thread/events` pages over authoritative JSONL with exclusive sequence cursors, a 200-event cap, a 768 KiB result budget, and explicit corruption/oversize errors.
- Revision-paginated `thread/search` over normalized SQLite substring projections, with 256-byte queries, eight-term AND semantics, 512-byte snippets, and an approximately 256 KiB result budget.
- Idle-only `/threads`, `Ctrl+T`, and `/search <query>` interaction across the current canonical workspace, match-centered authoritative preview, metadata recheck before resume, and persisted provider/model adoption.
- Bounded 400-event/200-row preview windows, 500 cached search results, terminal-resize-aware 5–30 row viewports, PageUp/PageDown/Home/End navigation, and stale-response generations.
- Workspace-scoped provider/model preferences with revision-checked atomic persistence, corruption quarantine, credential-availability metadata, and no API-key transport or storage.
- Idle-only `/settings` provider selection and editable model IDs, with explicit Apply, layered Escape, startup precedence, and separate current-thread versus next-new-thread configuration.
- Thread-scoped `thread/artifacts` discovery and `artifact/read` ranges authorized by canonical workspace plus authoritative JSONL references, with ArtifactStore size, SHA-256, regular-file, and UTF-8 verification.
- Idle-only `/artifacts`, `/artifact <id>`, and preview `a` navigation with newest-first deduplication, 16 KiB bidirectional byte pages, terminal-aware wrapping, stale-response rejection, and layered Escape.
- Static completed transcript output plus one bounded live region, normal terminal scrollback, `/help`, `/status`, `/clear`, `/new`, `/exit`, `Esc` cancellation/navigation, and context-sensitive `Ctrl+C`.
- Official MCP v2 client integration for explicitly configured local stdio servers, with one isolated session per turn.
- Frozen, validated MCP tool catalogs exposed as stable `mcp__<server>__<tool>` aliases without importing MCP into `agent-core`.
- Atomic MCP namespace generations refreshed only between model steps, with complete-candidate validation and no partial visibility.
- Generation-bound prepared calls, durable catalog diffs, exact recovery-chain validation, and aggregate resume change evidence.
- Fail-closed MCP effects: external tools require approval by default, and only explicitly reviewed `read` tools bypass approval.
- MCP call timeouts, turn cancellation, reverse-order child cleanup, bounded binary/result normalization, artifact-backed large output, and conservative interrupted-call recovery.
- Strict user-configured local plugins over NDJSON JSON-RPC, with one isolated owned process per active plugin and Turn.
- Transactional required/optional plugin startup, capability allowlists, filtered named environments, bounded diagnostics, reverse shutdown, and process-tree cleanup.
- Plugin tools behind normal policy and approval plus qualified, immutable plugin Skills and command templates validated by the existing parsers.
- A bounded thread-scoped Plan/Stage/Todo state machine maintained through the built-in, provider-neutral `update_plan` control tool.
- Durable safe checkpoints, Plan-aware step/time pauses, exact recovery validation, and pinned current-Plan context that survives compaction.
- App-server `plan/get` and exact live `plan/acceptance/resolve`, plus CLI and Ink `/plan`, acceptance, rejection-feedback, and recovery views.
- Strict `<scope>/.koda/skills/<name>/SKILL.md` discovery with deterministic broad-to-deep ordering, byte/count budgets, canonical containment, and fail-closed symlink handling.
- Bounded Skill metadata in effective instructions, immutable Skill bodies through the built-in `read_skill` tool, durable catalog snapshots, resume changes, and current-source inspection.
- Strict `<scope>/.koda/commands/<name>.md` prompt templates with bounded string parameters, one-pass literal rendering, explicit CLI/Ink `/template` activation, and no executable handlers.
- Credential-free protocol v17 `extension/catalog`, `extension/read`, and `thread/extensions`, direct CLI inspection, and idle-only Ink `/extensions` with current-versus-historical labeling.
- Crash-durable `apply_changes` and `apply_patchset` journals with synchronized original backups, endpoint/staging evidence, conservative restart classification, safe automatic rollback, thread-audit reconciliation, and fail-closed writes after divergence.
- Credential-free conflict list/inspection, explicit token-bound backup export, `restore-original` and `accept-current` resolution, idempotent `workspace.change_set_resolved` audit, protocol/CLI/TUI clients, and restart-safe pending-resolution receipts.
- Compact live Tool activity and deterministic completed summaries for proven successful local reads, while approvals, mutations, execution, external calls, failures, rollback, and uncertainty stay individually visible.
- Idle-only `/activity` pagination over the complete durable execution trace plus 32 ms assistant-delta notification coalescing that preserves exact final output and flushes semantic events immediately.
- Offline provider, runtime, CLI, and deterministic agent-loop tests.

Provider-assisted semantic compaction, exact provider tokenizers and pricing, custom endpoints/profiles, live model discovery, automatic routing/fallback, cross-provider resume, additional providers, FTS5/fuzzy/live or cross-workspace search, alternate-screen navigation, rich Markdown/syntax/diff rendering, binary artifact views, overlapping/fuzzy/directory change operations, and the non-Tool MCP capability surface are deliberately deferred beyond the completed Phase 3 baseline. Phase 4A provides durable post-crash journals, safe automatic change-set recovery, audit reconciliation, conflict write blocking, and explicit human resolution clients. Phase 4B provides restart-safe native process ownership, PTY/background jobs, attachments, POSIX process groups, Windows Job Objects, and ConPTY. Strong sandboxing, remote MCP/HTTP/OAuth, shared storage, remote app-server transports, signed releases, and any high-risk shell-string support remain later Phase 4 work. Parent/child thread lineage and multi-agent scenario matrices remain Phase 5 work. Workspace writes, process execution, and MCP tools not explicitly classified as read require approval by default.

## Build the standalone macOS bundle

On an Apple Silicon Mac, build and verify the local standalone archive with:

```bash
pnpm install --frozen-lockfile
pnpm bundle:macos --output dist/release/local-arm64
```

The output directory must not already exist. Assembly builds release
`koda-exec`, pins and verifies Node.js 22.20.0, rejects mixed Mach-O
architectures and payload symlinks, runs `koda --version`, full bundle doctor,
and an app-server/native handshake outside the repository, then emits a
deterministic archive, `.sha256` file, and strict `.release.json` metadata. Run
the same clean-extraction and corruption-negative acceptance used by CI:

```bash
node apps/distribution/dist/release-main.js verify \
  --archive dist/release/local-arm64/koda-v0.1.0-darwin-arm64.tar.gz \
  --metadata dist/release/local-arm64/koda-v0.1.0-darwin-arm64.release.json \
  --corruption-check
```

Try the unpacked candidate directly:

```bash
dist/release/local-arm64/koda/bin/koda --version
dist/release/local-arm64/koda/bin/koda doctor --bundle-only
dist/release/local-arm64/koda/bin/koda
```

This is an unsigned local developer-preview bundle. MR1A3 supplies native
dual-architecture CI artifacts and the generated/tested Formula contract.
MR1A4's protected tag workflow adds Developer ID signing, Node
checksum-signature verification, notarization, GitHub Release publication, and
the public Tap; it cannot run until the protected credentials and environment
described in the release runbook are configured.

## Install the unsigned macOS internal preview

Build the current native architecture and install it beneath
`~/.local/share/koda-preview` without `sudo`:

```bash
pnpm preview:build
pnpm preview:install
pnpm preview:status
```

If `~/.local/bin` is not already on `PATH`, add it in your current shell before
running the stable commands. Koda reports this remedy but never edits shell
startup files:

```bash
export PATH="$HOME/.local/bin:$PATH"
koda --version
koda doctor
```

Install a downloaded CI candidate by passing its absolute archive path. The
installer uses the sibling `.release.json` automatically; `--metadata` can
select an explicit metadata document when needed:

```bash
pnpm preview:install --archive /absolute/path/koda-v0.1.0-darwin-arm64.tar.gz
```

Every upgrade preserves the former active target as `previous`:

```bash
pnpm preview:rollback
pnpm preview:uninstall --yes
```

Uninstall removes only preview-owned launchers and version state. It does not
remove `KODA_HOME`, Provider credentials, threads, artifacts, or settings.
These commands intentionally report `unsigned internal preview`; they do not
sign, notarize, publish, or claim Gatekeeper acceptance.

## Run the CLI

Build Koda, provide the credential for one built-in provider, and run one task against a workspace. OpenAI remains the default:

```bash
pnpm build
export OPENAI_API_KEY=...
node apps/cli/dist/main.js run "explain this repository" --cwd .
```

Select another provider with `--provider` or `KODA_PROVIDER`:

```bash
export ANTHROPIC_API_KEY=...
node apps/cli/dist/main.js run "explain this repository" --cwd . --provider anthropic

export DEEPSEEK_API_KEY=...
node apps/cli/dist/main.js run "explain this repository" --cwd . --provider deepseek
```

| Provider    | Credential          | Default model     |
| ----------- | ------------------- | ----------------- |
| `openai`    | `OPENAI_API_KEY`    | `gpt-5.6-terra`   |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-5` |
| `deepseek`  | `DEEPSEEK_API_KEY`  | `deepseek-v4-pro` |
| `kimi`      | `MOONSHOT_API_KEY`  | `kimi-k2.6`       |
| `glm`       | `ZAI_API_KEY`       | `glm-5.2`         |

Only the selected provider's credential is required. `--model` or `KODA_MODEL` overrides that provider's default. Resume a thread with the same provider; Koda rejects cross-provider resume before issuing a model request.

Koda prints the generated thread ID at turn start. Continue it from a later CLI process with the same canonical workspace:

```bash
node apps/cli/dist/main.js run "continue with the next task" --cwd . --resume <thread-id>
```

Koda exposes three bounded write representations to the selected model. `apply_patch` creates or exactly updates one UTF-8 text file. `apply_patchset` accepts one strict Koda Patch v1 document for compact Codex-style line edits; it is not Git unified diff and every context/removal sequence must match exactly once without fuzz. `apply_changes` exposes the underlying structured transaction grammar for up to 16 independent creates, ordered exact updates, same-filesystem moves, or deletions. Patchsets and structured change sets are fully prepared and previewed before one approval, revalidated under a workspace-scoped writer lease, and compensated in reverse order after ordinary failure or cancellation. If rollback cannot prove that it is undoing Koda's own bytes, the result is explicitly uncertain and must be inspected rather than automatically repeated.

Koda Patch v1 uses one `*** Begin Patch` / `*** End Patch` envelope. Add sections contain `+` lines, update sections contain `@@` hunks with space/`-`/`+` line prefixes, pure moves use `*** Move File:` followed by `*** To:`, and deletes use `*** Delete File:`. Updates preserve consistent LF or CRLF endings and the target's final-newline state; malformed, missing, ambiguous, or mixed-ending hunks fail before approval.

If restart recovery quarantines an external edit, inspect it without provider credentials. Copy the exact `stateToken` returned by the latest inspection; any endpoint or staging change invalidates it:

```bash
node apps/cli/dist/main.js recovery list --workspace .
node apps/cli/dist/main.js recovery inspect <conflict-id> --workspace .
node apps/cli/dist/main.js recovery export <conflict-id> <operation-index> --workspace . --state-token <sha256> --output ./original.txt
node apps/cli/dist/main.js recovery resolve <conflict-id> --workspace . --state-token <sha256> --action accept-current
node apps/cli/dist/main.js recovery resolve <conflict-id> --workspace . --state-token <sha256> --action restore-original
```

Export creates a new mode-`0600` file and refuses to overwrite an existing path. `accept-current` preserves current workspace endpoints. `restore-original` deliberately replaces divergent endpoints from verified backups and therefore requires reviewing the inspection evidence first. Both decisions append an idempotent resolution event to the originating thread before Koda removes the private journal.

Inspect local thread metadata without provider credentials:

```bash
node apps/cli/dist/main.js thread list --limit 20
node apps/cli/dist/main.js thread list --workspace .
node apps/cli/dist/main.js thread show <thread-id>
```

These commands refresh `KODA_HOME/state.db` from changed JSONL logs before querying. The database is a disposable projection: if it is deleted, Koda recreates it; if it is corrupt, Koda preserves a timestamped `.corrupt-*` copy and rebuilds current rows from JSONL.

Inspect current project Skills, command templates, and safe plugin-manifest metadata without Provider credentials or starting a plugin/MCP process:

```bash
node apps/cli/dist/main.js extension list --workspace .
node apps/cli/dist/main.js extension read skill <skill-id> --workspace .
node apps/cli/dist/main.js extension read command-template <template-id> --workspace .
```

## Run interactive chat

Build Koda, export the selected provider credential, and start the Ink client in an interactive terminal:

```bash
pnpm build
export OPENAI_API_KEY=...
pnpm chat --cwd . --provider openai
```

The installed binary is `koda-chat`; the built workspace entry can also be run directly:

```bash
node apps/tui/dist/main.js --cwd . --provider deepseek --model deepseek-v4-pro
node apps/tui/dist/main.js --cwd . --provider openai --resume <thread-id>
```

Workspace and approval mode are fixed at startup. Provider/model startup precedence is CLI argument, environment variable, matching workspace preference, then registry default. `/settings` opens the configured-provider list and model editor; Apply persists the choice for the canonical workspace without storing credentials. Existing or resumed threads keep their durable provider/model, while `/new` adopts the saved next-thread choice. Ordinary input starts a turn. `/threads` or `Ctrl+T` opens the latest 100 threads in the current canonical workspace. Press `/` there to search, or run `/search <query>` from chat. Search uses case-normalized substring AND terms across durable display-worthy history; Enter opens authoritative history and marks the hit. `/artifacts` lists UTF-8 text/JSON artifacts referenced by the current thread, `/artifact <sha256:...>` opens a known referenced ID, and `a` opens artifacts from a thread preview without resuming it. `/context` lists prepared model requests for the current thread; `c` opens the same inspector from a thread preview. `/plan` opens the current authoritative Plan, Stage/Todo state, last safe checkpoint, and recovery evidence without starting a provider or tool. `/extensions` compares the current workspace catalog with the newest durable extension snapshot for the selected Thread without starting a Provider, MCP server, or plugin. `/activity` opens the current Thread's authoritative execution trace; PageUp/PageDown move across event pages, Home/End reach event boundaries, and Escape returns to chat. `/recovery` lists quarantined workspace changes; `inspect` prints exact evidence, `export` writes one verified backup to a new path, and `resolve` stages either action for a separate `/recovery confirm`. A live Stage acceptance card uses `y` to accept or `n` to submit bounded change feedback against the exact Plan revision. The context detail shows exact or legacy budget telemetry, measured Usage, active Item identity, Compaction, and current repository-instruction status. Enter opens a bounded current instruction source. Artifact and instruction PageUp/PageDown request adjacent verified UTF-8 byte ranges; Home/End reaches content boundaries. Arrows move one row, `r` resumes a thread preview, and `Esc` returns one layer. `/new` detaches locally without deleting history. `/approvals` lists active exact-command grants, `/approvals revoke <id>` revokes one, and `/approvals clear` revokes all grants for the current workspace. `/help`, `/status`, `/clear`, and `/exit` retain their existing behavior. On an eligible `exec_command` approval, press `y` to approve once or `a` to approve that exact normalized command for 15 minutes; `n` rejects and `d` toggles details. `Esc` cancels an active turn. `Ctrl+C` cancels while a turn is active and exits while idle. The client requires a TTY; scripts should continue to use `koda run` or the stdio app-server.

Workspace preferences are stored under `${KODA_HOME:-$HOME/.koda}/settings/workspaces/` as bounded, versioned files keyed by the canonical workspace hash. API-key values stay only in the app-server environment; the protocol exposes only whether each named credential is configured.

## Run the local app-server

Build Koda, place provider credentials in the server environment, and launch the stdio transport:

```bash
pnpm build
OPENAI_API_KEY=... node apps/app-server/dist/main.js
```

The process accepts one JSON-RPC 2.0 object per UTF-8 line. `initialize` must be the first request:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":15,"client":{"name":"my-koda-client","version":"0.1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"turn/start","params":{"prompt":"explain this repository","cwd":".","provider":"openai"}}
{"jsonrpc":"2.0","id":3,"method":"thread/events","params":{"threadId":"<thread-id>","limit":200}}
{"jsonrpc":"2.0","id":4,"method":"thread/search","params":{"workspace":".","query":"parser failure","limit":50}}
{"jsonrpc":"2.0","id":5,"method":"settings/get","params":{"workspace":"."}}
{"jsonrpc":"2.0","id":6,"method":"settings/update","params":{"workspace":".","provider":"deepseek","model":"deepseek-v4-pro","expectedRevision":0}}
{"jsonrpc":"2.0","id":7,"method":"thread/artifacts","params":{"workspace":".","threadId":"<thread-id>","limit":100}}
{"jsonrpc":"2.0","id":8,"method":"artifact/read","params":{"workspace":".","threadId":"<thread-id>","artifactId":"sha256:<64-lowercase-hex>","maxBytes":16384}}
{"jsonrpc":"2.0","id":9,"method":"thread/context","params":{"workspace":".","threadId":"<thread-id>","limit":100}}
{"jsonrpc":"2.0","id":10,"method":"context/read","params":{"workspace":".","threadId":"<thread-id>","anchorSequence":42}}
{"jsonrpc":"2.0","id":11,"method":"context/instruction/read","params":{"workspace":".","threadId":"<thread-id>","anchorSequence":42,"sourceId":"ctxsrc:<64-lowercase-hex>","maxBytes":16384}}
{"jsonrpc":"2.0","id":12,"method":"approval/resolve","params":{"turnId":"<turn-id>","callId":"<call-id>","decision":"approved","grant":{"expiresInSeconds":900}}}
{"jsonrpc":"2.0","id":13,"method":"approval/grants/list","params":{"workspace":"."}}
{"jsonrpc":"2.0","id":14,"method":"approval/grants/revoke","params":{"workspace":".","grantId":"grant:<id>"}}
{"jsonrpc":"2.0","id":15,"method":"approval/grants/revokeAll","params":{"workspace":"."}}
{"jsonrpc":"2.0","id":16,"method":"plan/get","params":{"workspace":".","threadId":"<thread-id>"}}
{"jsonrpc":"2.0","id":17,"method":"plan/acceptance/resolve","params":{"threadId":"<thread-id>","turnId":"<turn-id>","callId":"<call-id>","planId":"<plan-id>","planRevision":1,"stageId":"<stage-id>","decision":"accepted"}}
{"jsonrpc":"2.0","id":18,"method":"extension/catalog","params":{"workspace":"."}}
{"jsonrpc":"2.0","id":19,"method":"extension/read","params":{"workspace":".","kind":"skill","sourceId":"skill:<64-lowercase-hex>"}}
{"jsonrpc":"2.0","id":20,"method":"thread/extensions","params":{"workspace":".","threadId":"<thread-id>"}}
{"jsonrpc":"2.0","id":21,"method":"workspace/mutation/conflicts","params":{"workspace":"."}}
{"jsonrpc":"2.0","id":22,"method":"workspace/mutation/conflict/get","params":{"workspace":".","conflictId":"wmc_<64-lowercase-hex>"}}
{"jsonrpc":"2.0","id":23,"method":"workspace/mutation/backup/export","params":{"workspace":".","conflictId":"wmc_<64-lowercase-hex>","stateToken":"<64-lowercase-hex>","operationIndex":0}}
{"jsonrpc":"2.0","id":24,"method":"workspace/mutation/conflict/resolve","params":{"workspace":".","conflictId":"wmc_<64-lowercase-hex>","stateToken":"<64-lowercase-hex>","resolution":"accept_current"}}
```

The v16 initialize result advertises `secretEvidence` and `workspaceMutationRecovery` alongside extension inspection, planning, and the existing capabilities, supported providers, credential environment-variable names, default models, and runtime-only availability booleans. Interactive process list, attach, read, and terminate responses expose the same strict value-free secret evidence retained by the native job; historical and non-secret jobs omit it. The four `workspace/mutation/*` methods are credential-free control-plane operations: list/get return metadata only, backup export is explicit and bounded, and resolution requires the exact latest state token. `restore_original` may replace divergent endpoints; `accept_current` does not change them. Neither method is exposed as an agent Tool. A successful resolution appends `workspace.change_set_resolved` after the matching uncertain event before journal acknowledgement. `extension/catalog` performs strict current project discovery and exposes only safe plugin-manifest metadata; it never starts an external process. `extension/read` returns only one currently validated project Skill or command-template source. `thread/extensions` rereads authorized JSONL and returns the newest or exact anchored durable extension snapshot without rediscovering historical content. `thread/events` returns validated events chronologically; mutually exclusive `beforeSequence` and `afterSequence` are exclusive cursors and `limit` is 1–200. `workspace.change_set_prepared`, `workspace.change_set_committed`, `workspace.change_set_rolled_back`, and `workspace.change_set_uncertain` provide bounded path-and-digest evidence for both `apply_changes` and `apply_patchset` without file bodies. `thread/search` is restricted to the canonical workspace and returns revision-bound cursor pages. `settings/get` returns the canonical workspace preference and revision; `settings/update` requires that revision so concurrent writers cannot silently overwrite one another. `thread/artifacts` lists newest unique references only after canonical-workspace and strict-JSONL authorization. `artifact/read` additionally requires that exact thread reference and returns a bounded, integrity-verified UTF-8 range with mutually exclusive `beforeByte`/`afterByte` cursors. Before each production Provider request, Koda writes `context.prepared` after any Compaction Item. `thread/context` discovers these durable snapshots newest first and projects old logs from `model.usage` without inventing missing estimates. `context/read` reconstructs precise active Items from authoritative JSONL and rejects digest mismatches. `context/instruction/read` accepts only an opaque source ID issued for that authorized request and returns bounded current content; it is not a general workspace file reader. `plan/get` rereads the authorized thread JSONL and returns the latest Plan, checkpoint, and recovery metadata without starting execution. `plan/acceptance/resolve` accepts only an exact live pending identity; restart recovery never turns historical acceptance evidence into a reusable capability. Responses and `turn/event` / `turn/finished` notifications use stdout exclusively; diagnostics use stderr. Clients answer an `approval.requested` event with `approval/resolve`, answer a `plan.acceptance_requested` event with `plan/acceptance/resolve`, may optionally create a bounded session grant only from an eligible command candidate, may inspect or revoke grants through the three `approval/grants/*` methods, may stop a live turn with `turn/cancel`, and should finish with `shutdown`. Provider credentials are server configuration and are never protocol fields.

## Configure project Skills

Place a Skill at `<scope>/.koda/skills/<name>/SKILL.md`. The scope is the directory containing `.koda`; a nested Skill applies to that subtree and is listed after broader sources. Phase 3H1 accepts only `name` and `description` single-line frontmatter fields, and the name must match its directory:

```markdown
---
name: code-review
description: Review changes for correctness, recovery, and missing tests.
---

Inspect the affected flow, verify failure boundaries, and run focused tests.
```

Koda injects only bounded catalog metadata. The model calls `read_skill` to obtain one immutable Skill body for the current Turn. Skill text is lower-priority project guidance: it cannot register tools, bypass approval, escape the workspace, or weaken Runtime policy. Files are limited to 48 KiB, with at most 32 Skills and 192 KiB combined content per workspace.

## Configure command templates

Place a reviewed prompt template at `<scope>/.koda/commands/<name>.md`. Parameters use one single-line JSON array in frontmatter; Phase 3H2 accepts bounded strings only:

```markdown
---
name: review
description: Review one target for correctness and missing tests.
parameters:
  [
    {
      "name": "target",
      "description": "Workspace-relative target.",
      "type": "string",
      "required": true,
      "max_bytes": 1024,
    },
  ]
---

Review {{target}} for correctness, recovery gaps, and missing tests.
```

Invoke a root template with `koda run '/template review {"target":"src/agent.ts"}' --cwd .` or enter the same `/template` prompt in Ink. Nested templates use selectors such as `packages/ui/review`. Koda freezes and validates the catalog, performs one literal substitution pass, and records source, argument, and rendered-input digests before the Provider starts. Templates are ordinary user prompts: they cannot define argv, environment, effects, approvals, tools, or local slash-command handlers.

## Configure local MCP tools

Create `${KODA_HOME:-$HOME/.koda}/mcp.json` to start local stdio MCP servers for each turn. An absent default file disables MCP. `KODA_MCP_CONFIG` may select another file relative to the process directory or by absolute path.

```json
{
  "version": 1,
  "servers": {
    "github": {
      "command": "node",
      "args": ["/absolute/path/to/github-mcp-server.js"],
      "cwd": "/absolute/path/to/optional/server-directory",
      "env": ["GITHUB_TOKEN"],
      "startup_timeout_ms": 15000,
      "call_timeout_ms": 60000,
      "tools": {
        "list_repositories": { "effect": "read" }
      }
    }
  }
}
```

`command` and `args` are passed directly without a shell. `env` contains parent environment variable names, never secret values; each child receives only a small runtime baseline plus those allowlisted names. Missing variables, relative or nonexistent `cwd` values, malformed schemas, oversized catalogs, and stale read classifications fail the turn before the model sees a partial catalog.

Every discovered tool defaults to effect `execute`. Under the default `on-request` mode it needs one approval per call; under `never` it is denied. Add `{ "effect": "read" }` only after reviewing that exact server tool. MCP annotations are treated as untrusted hints and cannot weaken this policy. MCP Tools use local stdio and refresh complete catalogs only at safe model-step boundaries; HTTP/OAuth, resources, prompts, sampling, elicitation, notifications, and cross-turn shared sessions remain deferred.

## Configure local plugins

Create `${KODA_HOME:-$HOME/.koda}/plugins.json` to start reviewed local plugins for each Turn. An absent default file disables plugins. `KODA_PLUGIN_CONFIG` may explicitly select another file relative to the process directory or by absolute path.

```json
{
  "version": 1,
  "plugins": {
    "reviewer": {
      "command": "node",
      "args": ["/absolute/path/to/reviewer-plugin.mjs"],
      "required": true,
      "capabilities": ["tools", "skills", "command_templates"],
      "env": ["REVIEWER_TOKEN"],
      "tools": {
        "inspect": { "effect": "read" }
      },
      "startup_timeout_ms": 15000,
      "call_timeout_ms": 60000,
      "shutdown_timeout_ms": 5000
    }
  }
}
```

Plugin stdout is strict NDJSON JSON-RPC 2.0 protocol traffic. Koda negotiates protocol version 1, copies and validates only requested `tools`, `skills`, and `command_templates`, qualifies all contributed identities, and publishes nothing until the complete required set is healthy. Optional failures are isolated and recorded without copying plugin stderr. Tool names become `plugin__<plugin-id>__<tool-name>` and default to `execute`; an exact manifest entry may review one as `read`. Plugin Skills and templates must contain the same complete Markdown/frontmatter accepted from project sources.

Plugins are ordinary local executables running with the current user's operating-system permissions; process isolation and filtered environments are lifecycle guardrails, not an OS security sandbox. Koda never auto-discovers plugin executables from a repository, installs packages, restarts crashed plugins, or keeps them alive across Turns.

`koda extension list` and protocol `extension/catalog` parse this manifest but never execute the configured command. Active contribution metadata is available only from a durable Thread snapshot after normal transactional Turn startup.

Preview old unreferenced artifacts without provider credentials, then delete them only after reviewing the report:

```bash
node apps/cli/dist/main.js artifact gc
node apps/cli/dist/main.js artifact gc --delete --min-age-hours 24
```

GC derives reachability from every valid JSONL event rather than SQLite. It refuses to delete anything while a thread is active or when a log is partial, corrupt, unsafe, or unreadable. The default minimum age is 24 hours; dry-run is always the default.

Resume reads and validates the local JSONL log, rebuilds provider-neutral history, and projects it through the thread's selected provider. A legacy log without a context snapshot, a provider or workspace mismatch, a busy thread, or an invalid log fails closed. If the prior process stopped during a tool call, Koda reports the durable effect and process evidence it has and does not execute the call again automatically. It never sends a signal using only a PID recovered from an earlier process because operating systems can reuse PIDs.

Oversized tool text keeps a bounded head/tail excerpt in the transcript and stores the complete captured bytes under `KODA_HOME/artifacts/sha256`. Artifact references are content-addressed and deduplicated. The model can call `read_artifact` with an ID, byte offset, and range size; the TUI can inspect only text artifacts authorized by the current or previewed thread's JSONL. Missing or corrupt blobs are reported explicitly rather than repaired silently. Koda removes stale temporary captures automatically and reclaims published blobs only through explicit reference-aware garbage collection.

Before every model request, Koda budgets base instructions, scoped repository guidance, tool schemas, and the active transcript. The defaults are a 128,000-token context window, a 16,384-token output reserve, and an 8,192-token safety margin. Override the first two with `KODA_CONTEXT_WINDOW_TOKENS` and `KODA_MAX_OUTPUT_TOKENS`. When history no longer fits, Koda appends a structured compaction record to JSONL, preserves the newest coherent suffix, and rebuilds the same model-facing view after restart without deleting original events.

The provider defaults to `openai`; select it with `--provider <provider>` or `KODA_PROVIDER`. The model defaults to the selected provider's registry entry and can be overridden with `--model <model>` or `KODA_MODEL`. Runtime event logs are written under `~/.koda/threads` by default; set `KODA_HOME` to move them. `KODA_EXECUTION_PROFILE` selects the startup-frozen execution profile described below.

Koda discovers `AGENTS.md` and `KODA.md` from the workspace root downward, excluding `.git`, `.koda`, `node_modules`, symlinked directories, and paths deeper than 20 levels. It loads broader scopes before deeper scopes and `AGENTS.md` before `KODA.md` within one directory. Each source applies only to its subtree, must be a regular UTF-8 file no larger than 64 KiB, and cannot override runtime policy or approvals. Discovery is capped at 32 files and 256 KiB total. If these files change between turns, resume records the exact added, removed, or changed paths and uses the current versions.

When Koda proposes a patch or command, it prints the exact action and asks for approval. The line-oriented CLI remains one-shot with `Approve this action? [y/N]`. In one TUI/app-server process, an eligible built-in command can instead receive a 15-minute grant scoped to the canonical workspace, exact normalized `argv`, working directory, and timeout. Grants are memory-only, inspectable, revocable, capped at one hour, never apply to writes, MCP tools, or plugin tools, and disappear on restart. A command is represented as a JSON `argv` array, never reconstructed as shell syntax. Use `--approval-mode never` or `KODA_APPROVAL_MODE=never` to deny all writes and process execution even when a matching grant exists.

The TypeScript compatibility backend runs commands without stdin, has a 30-second default timeout, and retains at most 64 KiB from each output stream. On POSIX, each command owns a process group; timeout, cancellation, output failure, or unsupported surviving descendants trigger `SIGTERM`, a grace period, and then `SIGKILL` when needed. Its Windows fallback uses tree-aware `taskkill` with explicit uncertainty when termination cannot be confirmed. These guardrails are not a security sandbox: an approved executable or repository script still runs with the current user's operating-system permissions.

Execution policy defaults to `unconfined` and may be selected before startup with `KODA_EXECUTION_PROFILE`. A macOS native executor that passes Koda's real Seatbelt startup self-test and a Linux native executor that passes the exact Bubblewrap/namespace/seccomp startup probe support `read-only` and `workspace-write`; TypeScript and Windows backends reject those profiles before approval or job creation. There is no silent downgrade:

```bash
export KODA_EXEC_PATH="$PWD/target/debug/koda-exec"
export KODA_EXECUTION_PROFILE=read-only
```

Every prepared command records its requested policy dimensions, selected backend, capability digest, expected launch controls, and the frozen Linux Bubblewrap runtime identity where applicable. A protected macOS or Linux start publishes `running` and applied filesystem/network evidence only after sandbox-internal confirmation, process-identity recheck, durable evidence, and a second release gate; user code cannot run during that validation window. Linux launch evidence is displayed as `OS sandbox: Linux Bubblewrap + seccomp`; unconfined and unsupported backends state `OS sandbox: none`. Process-tree supervision and environment filtering are reported separately. Exact-command approval grants bind the policy, backend, capabilities, and runtime fingerprint, so changing any of them invalidates the grant before execution.

The complete guarantee, evidence, failure, legacy-compatibility, and platform acceptance contract is documented in [Koda execution security guarantees](docs/security/execution-security.md).

Phase 4B provides the Rust Supervisor and per-job Workers on macOS, Linux, and Windows. `pnpm build` builds `target/debug/koda-exec` (`target/debug/koda-exec.exe` on Windows); set its absolute path to select the native backend explicitly:

```bash
export KODA_EXEC_PATH="$PWD/target/debug/koda-exec"
node apps/cli/dist/main.js run "run the tests" --cwd .
```

When selected, Koda starts or reconnects to the private Supervisor beneath `KODA_HOME/executor`, performs a mandatory version/capability handshake, and delegates each accepted command to an independently detached Worker. Durable manifests, state heads, bounded output stores, authenticated Worker control, and PID start identities let a replacement Supervisor reconnect without restarting a running command. POSIX process groups and Windows Job Objects own complete process trees; POSIX PTYs and ConPTY provide managed background terminals, attach/detach, fenced input, resize, and restart-safe observation. Pre-command jobs resume safely; loss after the command boundary becomes `termination_uncertain` and never guesses success. Removing `KODA_EXEC_PATH` selects the existing TypeScript compatibility backend during the migration. Koda never silently falls back after a native startup or protocol failure.

When the provider reports usage, Koda persists normalized input, cached, cache-write, output, reasoning, and total token counts and prints a turn summary. Missing provider usage is reported as unmeasured rather than treated as zero billable usage.

`ripgrep` (`rg`) must be available for the `search_text` tool. `list_files` and `read_file` continue to work without it.

## Development

Requirements:

- Node.js 22.20 or later; CI runs Node.js 24.
- pnpm 10.28.2.
- Rust 1.85 or later with Cargo; the workspace uses Rust 2024 edition.

```bash
pnpm install
pnpm format:check
pnpm typecheck
pnpm test
pnpm eval:scenarios
```

## Packages

- `@koda/protocol`: versioned runtime schemas and domain types.
- `@koda/agent-core`: agent loop, provider and tool ports, event ports.
- `@koda/providers`: OpenAI Responses, Anthropic Messages, named OpenAI-compatible profiles, normalized provider errors, and deterministic scripted providers.
- `@koda/runtime-node`: JSONL, artifact, and rebuildable SQLite metadata persistence plus constrained workspace, patch, and process tools.
- `@koda/mcp-client-node`: strict local MCP configuration, official stdio client lifecycle, tool adaptation, policy metadata, and bounded result conversion.
- `@koda/plugin-host-node`: strict local plugin manifests, NDJSON protocol, transactional capability validation, tool adaptation, diagnostics, and owned process lifecycle.
- `@koda/app`: transport-neutral turn orchestration and credential-free thread metadata/history use cases.
- `@koda/cli`: line-oriented command parsing, terminal approval, and console projection over `@koda/app`.
- `@koda/app-server`: local stdio JSON-RPC transport, active-turn coordination, and interactive approval routing.
- `@koda/app-server-client-node`: typed local JSON-RPC client, NDJSON framing, request lifecycle, diagnostics, and owned app-server process cleanup.
- `@koda/tui`: React/Ink controller, static transcript and live-region rendering, keyboard interaction, and `koda-chat` entry point.
- `@koda/testkit`: deterministic clocks, IDs, tools, in-memory event storage, and offline reliability scenarios.
- `koda-exec`: native POSIX process supervisor, private local protocol, bounded output ownership, timeout, cancellation, and reconnectable live job status.

## Architecture

- [Architecture design](docs/plans/2026-08-26-koda-agent-architecture-design.md)
- [Phase 0 implementation plan](docs/plans/2026-08-26-phase-0-implementation-plan.md)
- [Phase 1A OpenAI CLI design](docs/plans/2026-08-26-phase-1a-openai-cli-design.md)
- [Phase 1B safe patch design](docs/plans/2026-08-26-phase-1b-safe-patch-design.md)
- [Phase 1C safe exec design](docs/plans/2026-08-26-phase-1c-safe-exec-design.md)
- [Phase 1D context and accounting design](docs/plans/2026-08-26-phase-1d-context-accounting-design.md)
- [Phase 2 reliability roadmap](docs/plans/2026-08-26-phase-2-roadmap.md)
- [Phase 2A durable resume and recovery design](docs/plans/2026-08-26-phase-2a-resume-recovery-design.md)
- [Phase 2B artifacts and output budgets design](docs/plans/2026-08-26-phase-2b-artifacts-output-budgets-design.md)
- [Phase 2C context and compaction design](docs/plans/2026-08-26-phase-2c-context-compaction-design.md)
- [Phase 2D process reliability design](docs/plans/2026-08-26-phase-2d-process-reliability-design.md)
- [Phase 2E SQLite metadata design](docs/plans/2026-08-26-phase-2e-sqlite-metadata-design.md)
- [Phase 2F scenarios and artifact GC design](docs/plans/2026-08-26-phase-2f-scenarios-artifact-gc-design.md)
- [Phase 4 hardening roadmap](docs/plans/2026-08-28-phase-4-roadmap.md)
- [macOS public preview release runbook](docs/release/macos-public-preview-runbook.md)
- [Phase 4B supervised native execution design](docs/plans/2026-08-28-phase-4b-supervised-native-execution-design.md)
- [Phase 3 extensibility roadmap](docs/plans/2026-08-26-phase-3-roadmap.md)
- [Phase 3A local stdio app-server design](docs/plans/2026-08-26-phase-3a-stdio-app-server-design.md)
- [Phase 3B local MCP client design](docs/plans/2026-08-26-phase-3b-mcp-client-design.md)
- [Phase 3C multi-provider runtime design](docs/plans/2026-08-26-phase-3c-multi-provider-design.md)
- [Phase 3D Ink chat REPL design](docs/plans/2026-08-26-phase-3d-ink-chat-repl-design.md)
- [Phase 3E1 thread browser and history restore design](docs/plans/2026-08-27-phase-3e1-thread-browser-history-design.md)
- [Phase 3E2 history search and windowed navigation design](docs/plans/2026-08-27-phase-3e2-history-search-navigation-design.md)
- [Phase 3E3 workspace runtime settings design](docs/plans/2026-08-27-phase-3e3-runtime-settings-design.md)
- [Phase 3E4 thread-scoped artifact inspection design](docs/plans/2026-08-27-phase-3e4-artifact-inspection-design.md)
- [Phase 3E5 auditable context and instruction inspection design](docs/plans/2026-08-27-phase-3e5-context-inspection-design.md)
- [Phase 3F1 auditable multi-file change transactions design](docs/plans/2026-08-27-phase-3f1-multi-file-change-transactions-design.md)
- [Phase 3F2 strict native patch documents design](docs/plans/2026-08-27-phase-3f2-native-patch-documents-design.md)
- [Phase 3F3 session-scoped exact-command approval grants design](docs/plans/2026-08-28-phase-3f3-session-command-approval-grants-design.md)
- [Phase 3G durable planning and Harness checkpoints design](docs/plans/2026-08-28-phase-3g-planning-harness-design.md)
- [Phase 3H Skills and extension system design](docs/plans/2026-08-28-phase-3h-skills-extension-system-design.md)

The model can propose actions, but the Koda runtime owns validation, policy, approval, and execution. User interfaces consume typed events and do not own agent state.
