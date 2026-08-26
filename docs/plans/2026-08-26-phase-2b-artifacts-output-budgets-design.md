# Koda Phase 2B: Artifacts and Output Budgets

- Status: Accepted for implementation
- Date: 2026-08-26
- Depends on: Phase 2A durable resume and safe recovery
- Scope: content-addressed tool-output artifacts, bounded model-facing excerpts, artifact retrieval and diagnostics, and provider-output limits

## 1. Outcome

Phase 2B stops treating truncation as silent data loss. When a text-producing tool exceeds the model-facing byte budget, Koda keeps a bounded excerpt in the tool result and stores the complete captured bytes in a local content-addressed artifact. The model can retrieve bounded byte ranges through a dedicated read-only tool, while JSONL remains compact enough to replay.

The first implementation covers `read_file`, `search_text`, `exec_command` stdout and stderr, and provider-emitted assistant text or tool-call arguments. It does not turn artifacts into general user files or permit artifact writes from the model.

## 2. Alternatives and decision

Three approaches were considered:

1. **Budget after tool execution.** Serialize every result in the agent loop, then truncate and store it. This is small but cannot recover bytes already discarded by command or search implementations and may hold unbounded output in memory.
2. **Tool-specific artifact handling.** Add separate truncation and persistence logic to every tool. This preserves data but produces inconsistent schemas and budget rules.
3. **Shared streaming capture, selected.** Runtime tools use one bounded excerpt and content-addressed capture abstraction. The agent loop only understands standard artifact references and a provider-output hard limit.

The selected approach keeps storage in `runtime-node`, preserves provider neutrality in `agent-core`, and reuses one byte-based policy across output producers.

## 3. Artifact identity and layout

An artifact reference is provider-neutral JSON:

```json
{
  "type": "artifact",
  "id": "sha256:<64 lowercase hex characters>",
  "sha256": "<64 lowercase hex characters>",
  "bytes": 123456,
  "mediaType": "text/plain; charset=utf-8"
}
```

Artifact bytes live under:

```text
KODA_HOME/artifacts/sha256/<first-two-hex>/<sha256>
```

Writers stream to an exclusive temporary file, update SHA-256 incrementally, sync and close it, then publish with a same-filesystem atomic link. An existing blob with the same hash and size is reused. Temporary files left by a crash are removed after a bounded stale age when the store opens. Referenced blobs are not automatically garbage-collected until Phase 2E can provide a rebuildable reference index.

Artifact IDs, not absolute paths, enter events and model context. Reads derive a path only from the validated hash, so model input cannot perform path traversal.

## 4. Model-facing output budget

Text fields use a 64 KiB model-facing byte budget by default. Content at or below the budget remains inline and does not create an artifact. Oversized content returns a UTF-8-safe head/tail excerpt, total byte count, a truncation flag, and an artifact reference. The marker between head and tail states how many bytes were omitted.

Tool result compatibility is preserved:

- `read_file` keeps `content` and adds `content_bytes`, `content_truncated`, and optional `content_artifact`.
- `search_text` keeps `matches` and its source-level `truncated` flag, then adds `matches_bytes`, `matches_truncated`, and optional `matches_artifact`.
- `exec_command` keeps stdout/stderr fields and byte counts. Its existing truncation flags now describe the model-facing excerpt; optional stdout/stderr artifact references hold the complete captured streams.

Search still has a separate raw-result safety ceiling and `max_results`; an artifact cannot claim completeness beyond those source limits. Command capture streams to disk and uses backpressure, so artifact size does not become process memory usage.

## 5. Retrieval and lifecycle

`read_artifact` accepts a validated artifact ID, a non-negative byte offset, and at most 64 KiB. It returns a UTF-8-decoded byte range, offsets, total size, and whether more bytes remain. It is read-only, does not require approval, and cannot access arbitrary `KODA_HOME` paths.

On resume, Koda recursively finds standard artifact references in durable tool results and checks that their blob paths exist with the recorded size. Missing references do not prevent recovery because the bounded excerpt remains useful. Instead, the typed recovery item lists missing IDs and its developer notice tells the model that those blobs are unavailable. A direct read returns `ARTIFACT_NOT_FOUND`; a size mismatch returns `ARTIFACT_CORRUPT`.

Every artifact reference recorded in a tool result also produces an `artifact.recorded` event associated with its tool call. The event is observational; the tool result remains the transcript source of truth.

## 6. Provider-output guard

Each model step receives a provider-output byte limit, defaulting to 256 KiB. Assistant deltas and serialized tool-call arguments count toward the same limit before they are recorded. Exceeding it ends the turn with `MODEL_OUTPUT_LIMIT_EXCEEDED`; the over-budget delta or call is not persisted or executed.

Provider output is not converted into an artifact in Phase 2B. Final assistant messages are semantic transcript entries, so silently replacing them with excerpts would change conversation meaning. Artifact-backed assistant continuation can be designed with context compaction in Phase 2C.

## 7. Failure behavior

- Artifact publication failure returns `ARTIFACT_WRITE_FAILED` as a tool error; the result never claims a durable reference.
- Missing or corrupt blobs produce stable artifact read errors and resume diagnostics.
- Invalid artifact IDs fail schema validation before filesystem access.
- A process cancellation aborts tool execution and removes active temporary captures where possible.
- A crash may leave only a temporary file, never a partially published hash path.
- Existing small-output behavior remains inline and requires no artifact lookup.

## 8. Testing and acceptance criteria

Offline tests cover:

- deterministic SHA-256 IDs and deduplication;
- inline output without blob creation;
- UTF-8-safe head/tail excerpts and exact byte counts;
- streamed command stdout/stderr artifacts;
- read and search artifact references;
- bounded `read_artifact` ranges and traversal-safe IDs;
- stale temporary cleanup;
- missing/corrupt artifact diagnostics during resume;
- `artifact.recorded` events;
- provider-output limit failure before execution;
- unchanged small-output and Phase 2A resume behavior.

Phase 2B is complete when full captured oversized tool output is durable and retrievable, every model-facing output is explicitly byte-bounded, missing artifacts are visible rather than silently ignored, and all repository checks pass without live credentials.

## 9. Deferred destinations

- Artifact reference indexing and safe unreferenced-blob garbage collection: Phase 2E.
- Artifact-backed assistant-message compaction: Phase 2C.
- Rich artifact previews and downloads in an interactive UI: Phase 3.
- OS-level storage quotas and sandbox enforcement: Phase 4.
