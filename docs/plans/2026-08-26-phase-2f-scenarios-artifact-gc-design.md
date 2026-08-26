# Koda Phase 2F: Deterministic Scenarios and Reference-Aware Artifact GC

- Status: Implemented (2026-08-26)
- Date: 2026-08-26
- Depends on: Phase 2E rebuildable thread metadata
- Scope: deterministic offline reliability scenarios, reference-aware local artifact garbage collection, and credential-free maintenance commands

## 1. Outcome

Phase 2F closes Phase 2 with two operational guarantees.

First, Koda's recovery and safety promises are exercised as complete offline scenarios rather than only as isolated unit tests. Each scenario runs real package composition, reports named binary checks, and can be executed without a model credential.

Second, content-addressed artifacts can be reclaimed without treating the rebuildable SQLite index as authoritative. Garbage collection derives reachability from every valid JSONL event log, fails closed whenever that proof is incomplete, and deletes nothing unless the operator explicitly requests deletion.

## 2. Scenario evaluation design

The evaluator uses TypeScript scenario definitions and a small shared runner on top of Vitest. A custom JSON/YAML scenario language is rejected because it would duplicate control flow, fixtures, and assertions already expressed safely in TypeScript. Snapshot-only tests are also rejected because large textual snapshots make the important pass/fail contract difficult to see.

Each `ScenarioDefinition` has a stable ID, a short description, and an asynchronous execution function. Execution produces a `ScenarioReport` containing named binary checks and optional bounded diagnostics. A scenario passes only when every check passes; failed reports identify the exact violated invariant.

The root `pnpm eval:scenarios` command builds the workspace and runs only the deterministic scenario suite. It performs no network access and requires no API key. The ordinary `pnpm test` command continues to include the same suite so regressions cannot bypass normal CI.

The required scenarios are:

1. durable resume reconstructs a previous thread and appends a contiguous new turn;
2. compaction emits durable state that can reconstruct bounded model history;
3. repository prompt injection cannot override tool policy;
4. cancellation terminates a real command and records the process and turn lifecycle;
5. oversized tool output is published, referenced, verified, and retrieved as an artifact;
6. an interrupted side effect is surfaced as uncertain and is not silently replayed on resume.

Fixtures use deterministic IDs, clocks, scripted model responses, temporary workspaces, and local processes. They assert externally meaningful outcomes rather than private implementation call counts unless the count itself is a durability invariant.

## 3. Artifact reachability

`KODA_HOME/threads/*.jsonl` remains the sole source of truth. The collector scans every event in every thread log and retains artifacts referenced by either:

- `artifact.recorded.payload.artifact.id`; or
- typed artifact references nested inside an `item.recorded` tool result, discovered through the protocol's recursive `collectArtifactReferences` helper.

SQLite metadata is never consulted for reachability. It may be stale, deleted, or rebuilt and therefore cannot authorize deletion.

Only regular files at the exact content-addressed layout `artifacts/sha256/<first-two-hex>/<64-lowercase-hex>` are eligible. The prefix must match the digest. Symlinks, unexpected files, malformed names, and directories outside this shape are reported and retained. Reachable artifacts are retained regardless of age.

An unreachable artifact becomes a candidate only after the configured minimum age. The default is 24 hours to avoid collecting a just-published blob whose reference has not yet been observed by an operator or a recovering process.

## 4. Concurrency and fail-closed behavior

Collection starts by acquiring a global artifact-maintenance lease under `KODA_HOME/artifacts`. The lease uses exclusive creation, an owner PID, and a random token. A dead owner is reclaimed; a malformed lease is treated as active.

Normal `run` execution retains its per-thread lease ordering, then checks the global GC lease before opening the artifact store or appending events. This ordering closes both races:

- if a run owns a thread before GC starts, GC observes the active thread lease and refuses to collect;
- if GC owns its lease first, a new run may briefly acquire its thread lease but then refuses to start and releases it before publishing an artifact.

After acquiring the global lease, GC fails without deletion if any thread lease is active or unreadable. It also fails if any candidate source log has a partial trailing line, corrupt JSON, an invalid event, a discontinuous sequence, an unsafe filename, or an unreadable path. A collector that cannot prove global reachability must never guess.

Dry-run and delete mode use the same scan. Delete mode performs no work until the complete scan succeeds. It then removes only the recorded candidate paths while the global lease remains held. Empty digest-prefix directories may be removed afterward; unexpected content is never touched.

## 5. CLI surface and report

`koda artifact gc` performs a dry run by default. Actual deletion requires:

```text
koda artifact gc --delete
```

`--min-age-hours <number>` overrides the 24-hour minimum and accepts zero for explicit test or maintenance use. The command resolves only `KODA_HOME`; it does not load a provider or require credentials.

Human-readable output reports scan mode, logs inspected, artifacts inspected, reachable artifacts, deletion candidates, deleted artifacts, reclaimable or reclaimed bytes, and bounded diagnostics. Programmatic runtime results expose the same counts and candidate metadata.

Stable errors distinguish an already-running collector, an active agent thread, invalid options, and an unsafe or incomplete reachability scan. Errors leave every artifact untouched.

## 6. Testing and acceptance criteria

Offline tests cover:

- the six end-to-end reliability scenarios and their named binary reports;
- references from both durable artifact events and nested tool results;
- reachable, too-young, and old unreachable blobs;
- dry-run idempotence and explicit deletion;
- stale, live, and malformed global leases;
- active thread leases and the run-versus-GC startup ordering;
- partial, corrupt, discontinuous, unsafe, and unreadable logs;
- unexpected artifact entries and symlinks being retained;
- credential-free CLI parsing, output, option validation, and error exits.

Phase 2F is complete when the dedicated scenario command passes offline, all six Phase 2 reliability promises have binary assertions, and no artifact can be deleted unless Koda has an exclusive maintenance lease and a complete JSONL-derived reachability proof.

## 7. Deferred destinations

- Shared or remote artifact stores and distributed collection leases: Phase 4 runtime distribution.
- Retention quotas, per-workspace policies, and automatic scheduled collection: a later operations slice after real usage data exists.
- Trash or quarantine-based recovery for deleted artifacts: a later local-operations enhancement; Phase 2F uses content-addressed regeneration and explicit deletion.
- Artifact references outside the versioned event protocol: introduce through a future protocol migration before they affect reachability.
- Parent/child thread lineage and multi-agent scenario matrices: Phase 5 multi-agent protocol.
