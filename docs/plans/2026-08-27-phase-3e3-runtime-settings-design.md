# Koda Phase 3E3: Workspace Runtime Settings

- Status: Approved; implementation pending
- Date: 2026-08-27
- Depends on: Phase 3C provider registry, Phase 3D Ink client, and Phase 3E1/3E2 safe thread switching
- Scope: explicit workspace-scoped provider/model preferences for new threads without credential persistence or cross-provider thread migration

## 1. Outcome

Phase 3E3 lets an idle TTY user inspect provider availability, choose a provider, edit its model ID, and persist that choice for the next new thread in the canonical workspace. The setting is shared through the app-server boundary so the Ink client and future local clients observe one contract instead of creating client-specific configuration stores.

Existing threads do not change identity when a preference changes. A running, completed, or resumed thread continues with the provider/model recorded in its durable `turn.context`. Applying settings while a thread is selected updates only the next-new-thread preference; `/new` intentionally adopts it. If no thread has started yet, the preference becomes the configuration for the first prompt.

Only provider and model identifiers are persisted. API keys remain app-server environment configuration. Their values never enter the protocol, the preference store, JSONL history, SQLite projections, controller state, diagnostics, or terminal output. The server may expose only whether a provider's named credential environment variable is configured.

Phase 3E3 keeps Ink in the normal terminal buffer and adds two small controller modes rather than a full-screen settings application. It does not introduce provider discovery, automatic routing, model capability negotiation, fallback, cross-provider context conversion, or a general configuration framework.

## 2. Alternatives and decisions

Three persistence placements were considered:

1. **App-server-owned, versioned per-workspace files — selected.** Every local client shares the same canonicalization, validation, concurrency, and recovery semantics. Independent workspace files avoid unrelated-project lost updates and keep authoritative preferences separate from disposable projections.
2. **A TUI-private JSON file — rejected.** It is initially smaller but creates a second configuration contract that future IDE or desktop clients cannot reuse.
3. **Rows in `state.db` — rejected.** The metadata index is deliberately disposable and rebuildable from JSONL; user preferences are authoritative input and must survive an index rebuild.

Three model-selection mechanisms were considered:

1. **Built-in provider list plus an editable model ID — selected.** The registry supplies a stable default while users may enter a newer or account-specific model without waiting for a Koda release.
2. **A fixed model allowlist — rejected.** Vendor catalogs change too quickly, and a stale allowlist would reject otherwise valid identifiers.
3. **Live vendor model discovery — deferred.** It adds provider-specific network, credential, availability, pagination, and capability semantics that are not needed to make runtime selection explicit.

Settings use an explicit provider page followed by a model editor and Apply action. Immediate mutation, command-only selection, API-key entry, and a full-screen settings center are outside this slice.

## 3. Protocol v5 and provider availability

Phase 3E3 replaces the pre-release app-server protocol v4 with v5; parallel v4 and v5 handlers are not maintained. `initialize` advertises `runtimeSettings: true`. Static `ProviderMetadata` remains environment-neutral. The initialize result wraps each provider with a runtime-only `configured: boolean` field derived from a non-empty credential environment variable. It continues to expose the variable's name for actionable help but never its value.

The settings methods have this logical contract:

```ts
type RuntimePreference = {
  provider: ModelProviderId;
  model: string;
  updatedAt: string;
};

type SettingsGetParams = {
  workspace: string;
};

type SettingsGetResult = {
  workspace: string;
  revision: number;
  preference?: RuntimePreference;
  diagnostics: RuntimeSettingsDiagnostic[];
  recovery?: RuntimeSettingsRecovery;
};

type SettingsUpdateParams = {
  workspace: string;
  provider: ModelProviderId;
  model: string;
  expectedRevision: number;
};

type SettingsUpdateResult = {
  workspace: string;
  revision: number;
  preference: RuntimePreference;
  diagnostics: RuntimeSettingsDiagnostic[];
  recovery?: RuntimeSettingsRecovery;
};
```

The application canonicalizes `workspace` through `realpath` before reading, hashing, or writing. Workspace input is bounded to 4,096 UTF-8 bytes. Model IDs are trimmed, non-empty, terminal-safe, free of control characters, and at most 256 UTF-8 bytes. The response budget is 64 KiB; diagnostics are individually bounded. Schemas are strict at the server and Node client boundaries.

`settings/update` validates that the provider is built in and configured before storage mutation. Stable application data codes are `INVALID_RUNTIME_SETTINGS`, `PROVIDER_CREDENTIAL_MISSING`, `SETTINGS_CHANGED`, `SETTINGS_BUSY`, and `SETTINGS_CORRUPT`.

## 4. Workspace preference store

`@koda/runtime-node` owns a `WorkspacePreferenceStore` rooted at:

```text
$KODA_HOME/settings/workspaces/<sha256(canonical-workspace)>.json
```

The filename is the lowercase SHA-256 digest of the exact canonical workspace string. File schema v1 contains `version`, `workspace`, `provider`, `model`, positive safe-integer `revision`, and `updatedAt`. Absence is a valid state with revision zero. The store verifies the file is regular, stays below 16 KiB, parses against a strict schema, and repeats the workspace/hash consistency check before returning a preference.

Directories are created for the current user, preference and lease files use mode `0600`, and preference writes use a unique same-directory temporary file. The writer validates and serializes bounded JSON, writes a trailing newline, syncs and closes the temporary handle, atomically renames it over the target, and syncs the directory where supported. Temporary files are cleaned up only by exact known paths.

Malformed, oversized, non-regular, or inconsistent targets are never treated as valid preferences. A recoverable target is moved to a unique timestamped `.corrupt-...` backup, and the read returns revision zero plus bounded diagnostics and a recovery path. This quarantine cannot modify thread JSONL, artifacts, SQLite metadata, or provider state.

Each update acquires a per-workspace exclusive lease using the existing PID, token, active-process check, stale-owner cleanup, and ownership-safe release pattern. Under the lease it re-reads the file and compares `expectedRevision`; mismatch fails before writing. Two active app-server processes therefore cannot silently overwrite each other's choices. A live owner returns `SETTINGS_BUSY` instead of waiting indefinitely.

## 5. Startup resolution and controller state

The TUI canonicalizes its workspace, connects to app-server, reads `settings/get`, then resolves the initial new-thread configuration. Provider precedence is:

```text
--provider > KODA_PROVIDER > workspace preference > openai
```

Model precedence is:

```text
--model > KODA_MODEL > matching workspace preference > selected-provider default
```

A stored model is eligible only when its stored provider equals the final selected provider. This prevents an explicit provider override from inheriting a model ID belonging to another vendor. CLI arguments and environment variables are startup inputs, not permanent locks: a later successful Apply is a more recent explicit user action and updates the session's next-thread choice plus persisted preference. Restarting with the same CLI or environment override gives those inputs precedence again.

The controller separates `configuration`, which belongs to the selected/current thread, from `nextThreadConfiguration`, which mirrors the latest successful workspace preference or startup selection. Resuming a thread updates only `configuration` from refreshed durable metadata. Applying settings updates `nextThreadConfiguration`; it also updates `configuration` when no thread has been created. `/new` detaches without deleting durable data and copies `nextThreadConfiguration` into `configuration`.

When current and next values differ, `/status` and the status line show the pending `next: provider/model` selection. An explicitly selected but unconfigured startup provider is not silently replaced. The TUI remains usable for `/settings`, `/help`, and exit, but locally blocks prompts until a configured provider is applied or adopted through `/new` as appropriate.

## 6. TUI interaction

The controller adds `settings_provider` and `settings_model` to the existing chat and thread-navigation modes. `/settings` opens only from idle chat state with no pending approval. Active turns, approvals, thread browsing, search, and history preview cannot overlap the settings flow.

The provider page lists the five initialized providers, display names, defaults, and availability. Up/Down moves the bounded selection. Enter on a configured provider creates or updates a draft and opens the model editor. Enter on an unavailable provider stays on the page and names the missing credential environment variable without displaying a value.

The model page starts with the saved model for that provider when available; otherwise it uses the provider registry default. Ordinary terminal-safe text and Backspace edit a bounded input. `Ctrl+R` restores the selected provider's default. Enter is the explicit Apply action. Escape returns from model to provider, then from provider to chat, discarding all unsaved draft changes.

Apply sends the draft and its loaded revision to `settings/update`. While the request is pending, repeat input is ignored and the mode remains bounded. Success replaces the controller revision and next-thread configuration, clears the draft, returns to chat, and explains whether the selection is active immediately or will be used after `/new`. Failure preserves the draft, selected provider, model input, current thread, and prior next-thread configuration.

Settings requests participate in generation-based stale-response rejection. Escape or a mode change advances the generation so a late successful or failed RPC cannot mutate a newer screen. Ink continues to render only the bounded live region in the normal screen buffer.

## 7. Consistency and failure behavior

Preference state never becomes model-visible context and never changes durable thread identity. `turn/start` continues receiving an explicit provider/model from the controller. Runtime provider construction and thread recovery remain authoritative: even after a saved preference, missing credentials, a provider mismatch, or invalid resume state still fails closed before a model request.

`SETTINGS_CHANGED` means another writer committed after the draft loaded. The client keeps the draft and offers a reload instead of silently retrying with a new revision. `SETTINGS_BUSY` preserves state and asks the user to retry. A provider that becomes unavailable between initialize and update fails with `PROVIDER_CREDENTIAL_MISSING`. Protocol/schema violations keep the existing strict-client disconnect behavior and are not downgraded to empty settings.

Startup preference corruption produces a visible diagnostic and uses the ordinary precedence fallback after quarantine. It does not prevent thread browsing or recovery. A failed write leaves the previous atomically committed preference and both controller configurations unchanged. No settings operation deletes or rewrites JSONL, artifacts, metadata projections, credentials, chat output, or current thread context.

All user-controlled strings in settings screens, notices, diagnostics, status, and recovery paths are byte-bounded and terminal-sanitized. The protocol never transports environment contents, filesystem file contents, SDK errors containing request bodies, or arbitrary provider responses.

## 8. Testing and acceptance criteria

Protocol tests cover v5 initialization, rejection of v4, `runtimeSettings`, runtime-only provider availability, strict get/update schemas, workspace/model/revision bounds, response budgets, and stable application errors.

Store tests cover canonical workspace hashing, per-workspace isolation, absent revision zero, atomic replacement, permission intent, monotonic revisions, expected-revision conflicts, active and stale leases, same-workspace concurrent writers, large/model-control rejection, corrupt and inconsistent files, quarantine naming, bounded diagnostics, and unaffected thread/index files.

Application, app-server, and Node client tests cover `realpath`, provider support, credential availability, get/update round trips, typed validation, recovery propagation, subprocess framing, timeouts, and failure codes without live vendor credentials.

Controller and Ink tests cover startup precedence, provider selection, availability labels, model editing, default restoration, Apply, layered Escape, idle-only guards, draft preservation, stale response rejection, current-versus-next status, no-thread immediate adoption, `/new` adoption, resume isolation, and local prompt blocking for unavailable providers.

A real app-server subprocess test performs credential-safe settings get/update against an isolated `KODA_HOME`. A real TTY smoke exercises `/settings`, provider selection, model edit and Apply, `/status`, `/new`, layered Escape, and graceful shutdown. Acceptance requires formatting, build, workspace typechecks, test TypeScript checks, all offline tests, all six deterministic reliability scenarios, and the real TTY smoke to pass.

## 9. Deferred destinations

- API-key input, display, transport, operating-system keychain integration, or disk persistence.
- Live provider model discovery, fixed model allowlists, capability negotiation, pricing, or account-specific availability.
- Custom providers, arbitrary base URLs, user-defined profiles, Qwen, Doubao, MiniMax, and additional provider adapters.
- Mid-thread model replacement, cross-provider resume or context migration, automatic routing, fallback, retries, and provider-state conversion.
- Global or cross-workspace settings management, approval-mode settings, MCP configuration, sandbox policy, and network policy.
- Alternate-screen settings UI, mouse interaction, a general form framework, and remote or multi-client settings subscriptions.
