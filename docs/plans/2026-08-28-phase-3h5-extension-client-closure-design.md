# Koda Phase 3H5: Extension Protocol and Client Closure

- Status: Accepted for implementation
- Date: 2026-08-28
- Depends on: Phase 3H1 project Skills, Phase 3H2 command templates, Phase 3H3 dynamic tool generations, and Phase 3H4 isolated plugins
- Scope: app-server protocol v12, authoritative extension inspection, CLI and Ink presentation, and Phase 3H closure gates

## 1. Outcome

Phase 3H5 exposes the completed extension system through one bounded client contract without giving clients new execution authority. A user can inspect the currently discoverable project Skills, command templates, and user-owned plugin manifests before starting a Turn. For an existing Thread, a user can separately inspect the exact durable extension snapshot that governed a selected Turn: Skills, templates, tool-catalog generation, and active or disabled plugins.

Current-workspace inspection never starts a Provider, MCP server, or plugin process. Runtime-only contributions are therefore reported only from authoritative Thread history. Template activation remains an explicit `/template` Turn input, Skill activation remains the model's `read_skill` call, dynamic MCP refresh remains owned by Harness safe boundaries, and plugin activation remains owned by the user manifest plus Turn startup transaction.

## 2. Alternatives and decision

Three closures were considered:

1. **Inspection-first protocol v12 with existing explicit operations — selected.** Add current and historical extension catalog reads, typed Node client methods, CLI inspection, and an idle-only Ink view. This completes observability while retaining every existing trust boundary.
2. **Client-controlled plugin enablement and catalog refresh — rejected.** The current design makes the user manifest authoritative and gives each Turn ownership of child processes. Mutable client controls would require a persistent session manager, new concurrency rules, and a second activation authority.
3. **Expose only existing `thread/context` snapshots — rejected.** This cannot inspect the current workspace before a Turn and forces every client to reconstruct extension semantics from a broader context API.

## 3. Authoritative views

The protocol exposes two deliberately different views.

`extension/catalog` accepts one workspace path and returns its canonical absolute identity, a deterministic catalog digest, project Skill snapshots, project command-template snapshots, and safe configured-plugin descriptors. A configured-plugin descriptor contains only plugin ID, required status, requested capabilities, and manifest digest. It never exposes command paths, arguments, working directories, environment-variable names or values, timeouts, reviewed tool names, or contribution content. Project discovery uses the same strict loaders as Turn startup, so malformed sources or manifests fail closed rather than producing a partial catalog.

`thread/extensions` accepts a workspace, Thread ID, and optional exact `turn.context` anchor sequence. Without an anchor it returns the newest durable context. It validates the complete JSONL log, canonical workspace ownership, and exact anchor identity, then projects the historical Skill snapshots, command-template snapshots, tool-catalog generation, and plugin snapshots. It does not rediscover current files and never claims that historical content remains readable.

The current and historical views are not merged. Clients label them explicitly so a source that changed after a Turn cannot be mistaken for the source used by that Turn.

## 4. Current source reads

`extension/read` accepts the canonicalizable workspace, a source kind (`skill` or `command_template`), and the exact stable source identity returned by `extension/catalog`. Koda rediscovers and validates the complete current catalog, selects the exact identity, and returns the current path, scope, digest, total bytes, and complete UTF-8 source.

Each accepted source is already limited to 48 KiB, so Phase 3H5 returns the complete source instead of creating another cursor grammar. Missing, changed-identity, ambiguous, symlinked, escaped, or invalid sources fail closed. Plugin-provided virtual sources are not returned because reading them would require starting a plugin; historical Thread snapshots intentionally contain metadata only.

The API is credential-free, but it is not a general filesystem read. Only files accepted by the current Skill or template discovery rules may be returned.

## 5. Protocol v12

Protocol v12 replaces the pre-release v11 surface and adds four literal capabilities:

```ts
{
  extensionInspection: true,
  skills: true,
  commandTemplates: true,
  dynamicToolCatalog: true,
  plugins: true
}
```

It adds three strict methods:

- `extension/catalog`
- `extension/read`
- `thread/extensions`

Workspace inputs retain the 4 KiB UTF-8 limit. Result budgets are 256 KiB for catalogs, 80 KiB for source reads, and 256 KiB for historical snapshots. Existing schema limits bound every nested array and string. Responses are strict JSON-RPC values and unknown fields fail both server and Node client validation.

No v12 method activates a Skill or template, starts or refreshes an external tool, enables or disables a plugin, grants approval, or mutates configuration. The version change is required because strict v11 clients cannot parse the new initialize capabilities and cannot safely infer the new methods.

## 6. Application and client architecture

`KodaApplication` owns current discovery and historical authorization. It resolves the workspace relative to the server process directory, canonicalizes it, invokes the existing project Skill and command-template loaders, and parses the existing user plugin configuration. It calculates one canonical digest over the safe sorted projections. This code path does not create an ArtifactStore, Thread lease, Provider, MCP session, or plugin session.

Historical reads reuse the validated Thread-log and workspace-authorization boundary already used by context, artifact, and Plan inspection. The app-server only parses parameters, calls the application, validates the returned schema, enforces the result budget, and maps stable application errors.

`@koda/app-server-client-node` adds matching typed methods and performs strict response validation. It does not synthesize catalogs or downgrade v12 data for older clients.

## 7. CLI and Ink surfaces

The direct CLI adds:

```text
koda extension list [--workspace <directory>]
koda extension read <skill|command-template> <source-id> [--workspace <directory>]
```

List output separates Skills, command templates, and configured plugins and displays source/scope, byte count, digest, required status, and capabilities. Read output writes the validated current source to stdout. Both commands are credential-free and return nonzero on invalid or unavailable catalogs.

Ink adds idle-only `/extensions`. It requests the current catalog and, when a Thread is selected, the newest historical snapshot. The view clearly separates “Current workspace” from “Thread snapshot”, shows tool-generation identity/count and plugin active/disabled status, supports bounded scrolling, and closes with Escape. It does not start a Turn, require Provider credentials, or keep external processes alive. Source bodies remain available through the direct CLI in this slice; the Ink view focuses on catalog comparison and status.

## 8. Failure and security model

- Invalid workspace, malformed source, invalid plugin manifest, result overflow, corrupt Thread log, workspace mismatch, or unknown anchor fails the request without returning a partial catalog.
- Current inspection does not spawn plugin or MCP subprocesses. Tests prove a configured marker-writing plugin remains unstarted.
- Manifest command, argv, environment references, and stderr are never returned by inspection APIs.
- Historical disabled-plugin diagnostics expose only the existing bounded error code.
- A disconnect cancels only the inspection request/connection lifecycle; it cannot alter extension activation.
- Presentation state and catalog digests are never treated as policy or approval evidence.

## 9. Verification and completion

Offline coverage includes protocol v12 capability negotiation, strict schemas, catalog digest stability, malformed discovery, safe manifest projection, current source authorization, historical latest/exact-anchor reads, legacy empty snapshots, corrupt logs, workspace mismatch, result budgets, Node client correlation, and disconnect behavior.

Client coverage includes CLI list/read/error behavior, Ink `/extensions` loading, scrolling, current-versus-historical labels, disabled plugin status, idle-only behavior, and stale-response suppression. Subprocess gates cover v12 startup, wrong-version rejection, catalog inspection without plugin spawn, crash cleanup, and graceful shutdown. Provider conformance proves all supported adapters receive the same frozen extension metadata, while the real-TTY gate opens `/extensions`, navigates it, returns to chat, and exits with normal terminal restoration.

Phase 3H and Phase 3 are marked complete only after formatting, build/typecheck, the complete offline suite, six deterministic reliability scenarios, app-server subprocess checks, all-provider conformance, and the automated real-TTY gate pass without live credentials or network access.

## 10. Deliberate deferrals

- Plugin enable/disable RPCs, forced refresh, persistent plugin sessions, and background supervision: Phase 4.
- Remote registries, installation, updates, signatures, marketplace UX, and OS sandbox claims: Phase 4.
- Historical extension source-body retention or export: a separate storage and privacy design.
- Ink source-body browsing and template-form generation: later client UX slices after the catalog contract is stable.
- Child-agent extension delegation and cross-agent plugin coordination: Phase 5.
