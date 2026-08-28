# Koda Phase 3H: Skills and Extension System

- Status: Implementation in progress — Phase 3H1–3H3 implemented and verified; Phase 3H4 next
- Date: 2026-08-28
- Depends on: Phase 3B MCP lifecycle, Phase 3E context inspection, Phase 3F execution boundaries, and Phase 3G durable Plan/Harness
- Scope: project Skills, reviewed command templates, safe dynamic tool-catalog refresh, bounded plugin lifecycle, inspection, and closure

## 1. Outcome

Phase 3H gives Koda one extension boundary without creating another agent loop. Extensions may contribute guidance, prompt templates, or reviewed capabilities, but the existing Harness remains the sole owner of model steps, Plan state, tool policy, approval, cancellation, JSONL ordering, and recovery.

The first-class unit is a declarative extension snapshot frozen for a Turn. Discovery happens before Provider creation. The Runtime validates paths, encoding, budgets, identity, precedence, and capability declarations, then records the accepted snapshot in `turn.context`. Providers see only bounded catalog metadata until the model explicitly reads one Skill. A repository file cannot register executable authority merely by describing a tool or command.

Phase 3H remains local-first. It does not add remote marketplaces, automatic package installation, arbitrary in-process JavaScript loading, background jobs, child agents, or a general-purpose sandbox. Those require separate trust and distribution designs.

## 2. Alternatives and decision

Three architectures were considered:

1. **Declarative manifests plus Runtime-owned adapters — selected.** Skills and templates are data. Executable capabilities enter through reviewed built-ins, the existing MCP boundary, or a later isolated plugin host. Every Turn freezes a validated catalog and reuses current policy and recovery semantics.
2. **Load arbitrary JavaScript or TypeScript plugins into the app-server process — rejected.** An imported module receives the Runtime's filesystem, process, environment, and memory authority before Koda can classify or approve its effects. Error isolation and shutdown also become unreliable.
3. **Let the model scan the repository and infer Skills, templates, or tools from prose — rejected.** Discovery would be unbounded, non-deterministic, difficult to audit, and vulnerable to ordinary repository content claiming instruction or execution authority.

For Skill delivery, Phase 3H uses progressive disclosure. Injecting every Skill body would consume context even when irrelevant; exposing only filesystem paths would make discovery provider-dependent. Koda therefore injects bounded metadata and provides one built-in `read_skill` tool that returns the immutable Turn snapshot.

## 3. Trust and precedence

The instruction order is:

1. Koda product instructions and Runtime policy;
2. scoped `AGENTS.md` and `KODA.md` repository guidance;
3. explicitly activated Skill content;
4. ordinary repository and tool output.

No lower layer can weaken workspace confinement, approval mode, effect classification, cancellation, output budgets, or recovery rules. A Skill may recommend a command, but the model must still call `exec_command`, and the Runtime applies the normal exact invocation policy. A template may produce a prompt, but it cannot directly invoke a tool. A plugin capability must register through a reviewed adapter with a conservative effect.

Project Skill sources use broad-to-deep scope ordering. The scope is the directory containing `.koda`; a source under `packages/ui/.koda/skills/...` applies to `packages/ui` and its descendants. When sources with the same name apply to one target, the deepest scope wins. Duplicate names in one scope fail discovery instead of depending on directory enumeration.

## 4. Project Skill layout and schema

Phase 3H1 discovers only regular files at:

```text
<scope>/.koda/skills/<skill-name>/SKILL.md
```

`<skill-name>` and the frontmatter `name` must match and use lower-case ASCII letters, digits, and single hyphens. The accepted Phase 3H1 frontmatter is deliberately small:

```yaml
---
name: code-review
description: Review a change for correctness, recovery, and missing tests.
---
```

Only single-line scalar `name` and `description` fields are accepted in Phase 3H1. Unknown fields, duplicate fields, aliases, tags, multiline YAML, missing delimiters, empty bodies, invalid UTF-8, NUL bytes, symlinks, and sources outside the canonical workspace fail closed. Rich manifests, assets, and bundled dependencies belong to later slices.

Hard limits are 32 Skills, 48 KiB per `SKILL.md`, 192 KiB combined source bytes, 64 UTF-8 bytes for a name, 512 UTF-8 bytes for a description, 4 KiB for frontmatter, and discovery depth 20. `.git`, `node_modules`, and unrelated `.koda` contents are not traversed.

Each accepted source receives a stable path identity `skill:<sha256>` derived from canonical workspace-relative path, scope, and name. Content changes retain identity but change the recorded byte count and digest.

## 5. Frozen catalog and `read_skill`

Discovery reads and validates complete bytes before the model starts. The in-memory catalog contains identity, name, description, path, scope, byte count, SHA-256, and immutable content. The base instructions expose only identity, name, description, scope, path, size, and digest in deterministic broad-to-deep order.

`read_skill` accepts exactly one `skill_id`. It is a built-in `read` tool, cannot be shadowed by MCP or plugins, does not access the live file after Turn start, and returns the frozen metadata plus complete bounded content. Standard `tool.started`, execution, result, completion, compaction, and recovery behavior provides durable activation evidence. Reading a Skill never grants permission for later actions.

If the file changes or disappears during a Turn, the frozen snapshot remains the source for that Turn. The next Turn discovers current state and reports the difference during resume. This avoids a time-of-check/time-of-use gap in which the model sees metadata for one file and instructions from another.

## 6. Durable audit and context inspection

`turn.context` records a bounded Skill snapshot list beside repository-instruction snapshots. Each entry contains identity, name, path, scope, bytes, and SHA-256, never the body. The effective instruction hash includes the catalog metadata. Legacy logs default to an empty Skill list.

Resume compares the previous and current catalogs by stable Skill identity and emits structured `skillChanges` entries for added, removed, or changed sources. A move or re-scope appears explicitly as one removal plus one addition because path and scope participate in identity. A changed catalog never mutates prior tool results or reinterprets historical model requests. It adds a recovery notice and the current catalog governs only the new Turn.

Phase 3E context inspection recognizes Skill sources separately from repository instructions. It reports historical/current identity and offers bounded reads only for current authorized sources. Exact request-digest reconstruction continues to use the historical effective instruction hash and does not fabricate missing historical bodies.

## 7. Reviewed command templates

Phase 3H2 adds declarative prompt templates, not command execution. Templates live under scoped `.koda/commands/`, have validated names, descriptions, typed bounded parameters, and one UTF-8 prompt body. Expansion is deterministic and recorded as user-visible input before a Turn starts.

Templates cannot contain an executable argv field, effect classification, approval grant, environment value, or hidden system instruction. A rendered template is ordinary user content under the same Provider and Runtime policy. CLI and Ink invocation remain explicit; name collisions use the same scope rules as Skills. Automatic template execution, shell aliases, and repository-defined slash-command handlers are rejected.

Phase 3H2 accepts exactly one regular Markdown file per template:

```text
<scope>/.koda/commands/<template-name>.md
```

The basename and frontmatter `name` must match. Frontmatter accepts only `name`, `description`, and `parameters`; `parameters` is a single-line JSON array so Koda does not inherit YAML tags, aliases, or executable constructors. Parameters are named bounded UTF-8 strings in this slice:

```yaml
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

Every declared parameter must occur in the body and every `{{placeholder}}` must be declared. Names are unique lower-case snake case, parameter order is manifest order, and substitutions are literal text rather than a second template or shell evaluation pass. Unknown frontmatter fields, unsupported types, duplicate or unused parameters, unknown placeholders, missing required values, extra values, invalid UTF-8, NUL, symlinks, and budget overflow fail closed before Provider creation.

Hard limits are 32 templates, 48 KiB per file, 192 KiB combined source bytes, 16 parameters per template, 64 UTF-8 bytes for names, 512 UTF-8 bytes for descriptions, 4 KiB for frontmatter, 4 KiB as the largest declared per-parameter value, 16 KiB for an invocation, 64 KiB for the rendered user prompt, and discovery depth 20. A stable `command-template:<sha256>` identity is derived from path, scope, and name.

Invocation is explicit and has no shell grammar:

```text
/template <selector> <JSON-object>
```

A root template uses its name as selector (`review`); a nested template uses its scope plus name (`packages/ui/review`). The JSON object is optional only when the template declares no required values, must contain string values only, and is canonicalized for audit hashing. CLI accepts the invocation as the `koda run` prompt; Ink forwards the same `/template` form through the app-server instead of installing repository-defined local command handlers. Rich catalog browsing remains part of the Phase 3H5 protocol/client inspection surface.

Application discovery freezes the template catalog before Provider construction. Successful activation replaces the invocation with a visible ordinary-user header and the rendered body, records template/source/argument/rendered digests in `turn.context`, and stores only the rendered user input in model history. Resume reports added, removed, and changed template snapshots without reinterpreting old turns. Phase 3E current-source inspection may read currently authorized template sources, but command-template metadata and bodies never participate in the effective system-instruction hash.

## 8. Dynamic tool discovery

Phase 3H3 extends the existing frozen MCP catalog with explicit refresh at a safe Harness boundary. A model request always sees one immutable tool generation. Refresh validates the complete replacement catalog, checks alias and built-in collisions, records a bounded added/removed/changed diff, then atomically installs the next generation before another model request.

Removal never cancels an in-flight call, and a call is resolved against the generation that advertised it. New or changed external tools default to `execute` until local configuration explicitly reviews them as `read`. Refresh cannot weaken approval grants, invent a `control` tool, or cause automatic retry after disconnect. Subscription-driven refresh, remote registries, and cross-Turn shared MCP sessions remain deferred.

Three refresh mechanisms were considered. Mutating one live registry in place is rejected because a failed refresh can expose a partial catalog and a multi-call model response can observe mixed definitions. Resolving a tool against the MCP server's latest catalog at call time is rejected because the definition used for validation and approval could differ from the definition advertised to the model. Phase 3H3 therefore uses **atomic namespace generations**: built-ins remain immutable, the `mcp` namespace is built off to the side, the complete candidate is validated, and one registry reference changes only after success.

The Harness polls `tools/list` before model steps after step one. This is an explicit safe boundary: the preceding model stream has ended and every tool call from that response has completed, while the next Provider request has not started. Notifications and background refresh remain deferred. An unchanged candidate produces no generation or event. A malformed, colliding, oversized, disconnected, or policy-inconsistent candidate leaves the prior generation installed and fails the Turn before another Provider request; Koda never silently continues with a partially refreshed catalog.

Generation identity covers sorted model definitions plus Runtime effect and concurrency metadata. `turn.context` records the initial generation aggregate. Every `context.prepared` and newly recorded Tool Call binds to the generation exposed for that model step. A successful change emits one durable `tool.catalog_changed` event with previous/current identities and bounded added/removed/changed entries. Across resume, Koda reports an aggregate generation change without claiming historical names that were not persisted.

MCP registrations retain the exact SDK Tool definition and connection captured by their generation. Replacing or removing a registration does not mutate an already prepared invocation; that invocation may complete once through the normal policy, approval, cancellation, timeout, artifact, and recovery path. Newly added tools remain `execute` by default. A configured `read` classification remains tied to the exact server tool name and the complete candidate fails if that reviewed name disappears.

## 9. Plugin lifecycle

Phase 3H4 introduces a local out-of-process plugin host with a strict versioned manifest and stdio control channel. A plugin declares a bounded identity, executable argv, requested capabilities, startup timeout, health status, and shutdown behavior. Koda allowlists capability adapters; a manifest cannot register arbitrary Runtime callbacks.

Plugin startup is transactional: validate all manifests, start in deterministic order, negotiate versions, freeze registrations, and expose capabilities only after the complete required set is healthy. Failure isolates the plugin, produces bounded diagnostics, and either disables an optional plugin or fails the Turn for a required plugin. Shutdown runs once in reverse order with timeouts and process-tree cleanup. Plugin stdout is protocol-only and secrets remain named environment references.

Skills and templates supplied by plugins are copied through the same validators and become immutable Turn snapshots. Plugin tools enter the same ToolRegistry, conservative effect policy, approval, cancellation, artifact, and recovery boundaries as MCP tools.

## 10. Client and protocol boundary

Phase 3H reserves app-server protocol v12 for extension capabilities. Capability negotiation distinguishes `skills`, `commandTemplates`, `dynamicToolCatalog`, and `plugins`. Inspection methods are credential-free, workspace-authorized, bounded, and read authoritative snapshots; activation or refresh methods require exact generation identities.

CLI and Ink show catalog source, scope, digest, status, and diagnostics without treating presentation state as authority. A client disconnect cannot activate a template, accept a new tool generation, or keep a plugin capability alive beyond its owning Turn/session policy.

## 11. Failure model

Discovery is fail-closed for malformed sources, ambiguous identities, symlinks, workspace escapes, unsupported manifests, and budget overflow. An absent `.koda/skills` or `.koda/commands` directory means the capability is empty, not erroneous. Unreadable files that were explicitly discovered are errors rather than silently skipped.

Runtime error messages include bounded source identity and path but never copy an entire Skill, template body, plugin stderr stream, secret, or environment value. Optional plugin failures are diagnostics; required plugin failures prevent Provider startup. A catalog persistence failure prevents the affected generation from becoming visible.

## 12. Verification matrix

Offline tests cover:

1. Skill name, frontmatter, UTF-8, byte/count/depth, duplicate, ordering, scope, symlink, race, and workspace containment rules.
2. Stable identities, immutable content, deterministic catalog metadata, duplicate ToolRegistry rejection, and exact `read_skill` output.
3. Provider instruction projection, fixed-input budgeting, compaction, tool-call/result persistence, and all five provider adapters.
4. Turn-context snapshots, legacy logs, resume diffs, context inspection, source authorization, and digest mismatch failures.
5. Template parsing, parameter expansion, injection boundaries, client invocation, and durable rendered input.
6. Tool generations, safe refresh boundaries, collisions, effect defaults, in-flight calls, cancellation, disconnect, and recovery.
7. Plugin manifest validation, version negotiation, optional/required failure, process ownership, timeout, reverse shutdown, diagnostics, and hostile child output.
8. Format, typecheck, full offline suite, reliability scenarios, app-server subprocess, and real-TTY gates.

No live Provider, remote registry, package installation, or network access is required.

## 13. Implementation slices

### Phase 3H1: project Skills foundation

Status: **Implemented and verified (2026-08-28).**

- Add Skill protocol identities and snapshots, strict scoped discovery, immutable catalog, and `read_skill`.
- Inject bounded catalog metadata, persist Turn snapshots, report resume changes, and extend context inspection.
- Verify security, budgets, application integration, recovery, providers, and compaction.

Implemented with strict recursive discovery of scoped `<scope>/.koda/skills/<name>/SKILL.md` sources, a bounded frontmatter subset, canonical containment and no-symlink checks, deterministic broad-to-deep ordering, stable path identities, immutable per-Turn content, and structured catalog diffs. Catalog metadata is included in the effective instruction hash while bodies remain progressively disclosed through the built-in `read_skill` read tool.

`turn.context` now records bounded Skill snapshots, legacy logs default to an empty catalog, resume emits structured `skillChanges`, and Phase 3E context inspection distinguishes current Skill sources from repository instructions. Verification covers layout, encoding, NUL, per-file/count budgets, symlinks, stable identities, empty catalogs, invalid tool identities, immutable reads after file changes, durable tool evidence, resume changes, and authorized current-source inspection. The repository format gate, full typecheck, 46-file/396-test offline suite, and six reliability scenarios pass at the Phase 3H1 checkpoint.

### Phase 3H2: reviewed command templates

Status: **Implemented and verified (2026-08-28).**

- Add strict template manifests, deterministic parameters/expansion, and durable rendered-input evidence.
- Add explicit CLI and Ink discovery/invocation without repository-defined executable handlers.

Implemented with strict recursive discovery of scoped `<scope>/.koda/commands/<name>.md` sources, bounded JSON parameter manifests, portable exact selectors, canonical containment and no-symlink checks, immutable per-Turn catalogs, and single-pass literal placeholder expansion. CLI and Ink share the explicit `/template <selector> <JSON-object>` application path; malformed catalogs, selectors, invocations, or arguments fail before Provider creation.

`turn.context` records bounded template snapshots plus an optional activation containing source, canonical-argument, and rendered-prompt digests. Rendered prompts carry a visible ordinary-user header and never enter system instructions. Resume emits structured `commandTemplateChanges`, Phase 3E inspection distinguishes currently authorized command-template sources, and legacy logs default to an empty catalog. The repository format gate, full typecheck, 49-file/411-test offline suite, and six reliability scenarios pass at the Phase 3H2 checkpoint. Rich client catalog browsing remains Phase 3H5 as documented.

### Phase 3H3: dynamic tool generations

Status: **Implemented and verified (2026-08-28).**

- Add immutable catalog generations, safe-boundary refresh, durable diffs, and generation-bound calls.
- Preserve built-in precedence, conservative effects, approvals, cancellation, and recovery.

Implemented with a Runtime-owned `ToolRegistry` namespace transaction that stages and validates a complete replacement before one atomic swap. Generation identity covers sorted model definitions, concurrency, effect, and opaque source identity; the MCP adapter snapshots the exact SDK Tool definition and passes a fresh copy to each call, so later discovery or connection mutation cannot alter an advertised or prepared generation.

The Harness polls every connected local stdio MCP server before model steps after step one. Unchanged catalogs are silent; malformed, duplicate, oversized, colliding, disconnected, or stale-read candidates fail before the next Provider request and leave the installed generation unchanged. Successful changes emit a bounded `tool.catalog_changed` event before `context.prepared`; the Turn context, every prepared request, and every Tool Call carry the governing generation identity.

Recovery validates generation chains, request bindings, and Tool Call bindings while preserving legacy logs whose new fields are absent. Resume compares the last durable generation from the preceding Turn with the newly discovered initial generation and adds aggregate recovery evidence when they differ. Verification covers atomic replacement, policy/source digests, old prepared-call bindings, failed refresh rollback, safe Harness ordering, real stdio add/change/remove discovery, default-execute approval, restart/resume evidence, and hostile recovery chains. The repository format gate, full typecheck, 51-file/422-test offline suite, and six reliability scenarios pass at the Phase 3H3 checkpoint.

### Phase 3H4: isolated plugin lifecycle

Status: **Planned.**

- Add strict local manifests, out-of-process startup/health/shutdown, capability allowlists, isolation, and diagnostics.
- Route contributed capabilities through the existing Skill/template/tool validators.

### Phase 3H5: clients and closure

Status: **Planned.**

- Complete protocol v12/client inspection and control surfaces, CLI/Ink views, subprocess/crash/provider matrices, and real-TTY gates.
- Mark Phase 3 complete only after the entire verification matrix passes.

## 14. Deliberate deferrals

- Remote extension registries, package download/install/update, signatures, provenance, and marketplace UX: Phase 4 distribution/security.
- Strong OS sandboxing for third-party executables, remote plugins, tenants, and shared daemons: Phase 4.
- In-process arbitrary JavaScript/TypeScript/native plugins: not accepted without a separate capability-security design.
- Skill assets, scripts, generated binaries, transitive dependencies, and automatic dependency installation: later measured slices.
- Background jobs, reconnect/resubscribe, and crash-surviving plugin supervision: Phase 4.
- Child-agent Skill delegation, shared memory, worktrees, and cross-agent plugin coordination: Phase 5.

## 15. Acceptance criteria

Phase 3H is complete only when:

- extension discovery is deterministic, bounded, scoped, and auditable;
- Skills and templates cannot create execution authority;
- model-visible catalogs are immutable for one request/Turn generation;
- every executable capability uses existing policy, approval, cancellation, output, and recovery boundaries;
- refresh and plugin failures are isolated and never leave a partial catalog visible;
- resume and context inspection distinguish historical and current extension state;
- CLI, Ink, app-server, and providers agree on the authoritative catalog; and
- the complete offline, reliability, subprocess, provider, and real-TTY gates pass without credentials.
