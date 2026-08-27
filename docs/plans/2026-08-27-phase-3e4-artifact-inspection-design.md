# Koda Phase 3E4: Thread-scoped Artifact Inspection

- Status: Approved; implementation pending
- Date: 2026-08-27
- Depends on: Phase 2B content-addressed ArtifactStore, Phase 3A app-server, and Phase 3E1/3E2 thread browsing
- Scope: safe discovery and bounded UTF-8 reading of text artifacts referenced by one authoritative thread log

## 1. Outcome

Phase 3E4 closes the gap between Koda's durable artifact capture and its interactive client. An idle TTY user can list artifacts referenced by the current thread, list artifacts from a thread history preview, or open a known artifact ID within the current thread. The viewer reads bounded text ranges without adding artifact content to the chat transcript or model context.

Artifact access is thread scoped. Knowing a SHA-256 artifact ID is insufficient: the application must prove that the requested artifact is referenced by a valid `artifact.recorded` event in the requested thread and that the thread's durable `turn.context` belongs to the canonical workspace supplied by the client. JSONL remains authoritative for identity, workspace membership, and reference authorization. ArtifactStore remains authoritative for content integrity. SQLite is not an authorization source.

The slice supports only existing UTF-8 artifacts with media types `text/plain; charset=utf-8` and `application/json`. Binary data, images, download, export, external-open integration, rich Markdown, syntax highlighting, and dedicated diff rendering are separate future slices.

## 2. Alternatives and decisions

Three access scopes were considered:

1. **Thread-scoped references — selected.** It matches the user's current or previewed conversation, prevents hash-only cross-project reads, and establishes an authorization boundary future clients can reuse.
2. **All artifacts referenced anywhere in the workspace — rejected for this slice.** It requires a cross-thread reference index or repeated log scans and makes the first viewer broader than the interaction needs.
3. **Global read by artifact ID — rejected.** It is simple and resembles the model's internal `read_artifact` tool, but it creates a weak client API boundary that would be unsafe to carry into a remote transport.

Three TUI entry models were considered:

1. **Artifact list plus direct-ID shortcut — selected.** `/artifacts` provides discovery, `/artifact <id>` serves experienced users, and the same list can open from thread preview.
2. **Direct-ID command only — rejected.** It requires copying a long content hash from bounded output and does not help users discover past artifacts.
3. **Embed artifact actions directly in every transcript row — deferred.** It would require a larger transcript-row identity and focus redesign before the shared list and viewer boundary is proven.

Three content encodings were considered:

1. **Bounded UTF-8 text — selected.** Every current production artifact is plain text or JSON, and the TUI can render it without an additional encoding layer.
2. **Text plus hexadecimal binary rendering — deferred.** Koda has no production binary artifact capture path yet.
3. **Base64 for every response — rejected for the text path.** It adds transport overhead and client complexity without increasing the usable Phase 3E4 surface.

## 3. App-server protocol v6

Phase 3E4 replaces the pre-release app-server protocol v5 with v6. Parallel v5 and v6 handlers are not maintained. `initialize` advertises `artifactInspection: true` alongside the existing capabilities.

The discovery method has this logical contract:

```ts
type ThreadArtifactsParams = {
  workspace: string;
  threadId: ThreadId;
  beforeSequence?: number;
  limit?: number;
};

type ThreadArtifactDescriptor = {
  sequence: number;
  callId: ToolCallId;
  name: string;
  artifact: ArtifactReference;
};

type ThreadArtifactsResult = {
  workspace: string;
  threadId: ThreadId;
  artifacts: ThreadArtifactDescriptor[];
  nextBeforeSequence?: number;
  hasEarlier: boolean;
};
```

`thread/artifacts` returns the newest unique artifact IDs first. If one content-addressed artifact appears more than once, the newest authorized occurrence supplies its descriptor. Pagination is calculated over the complete newest-occurrence projection so an older occurrence cannot reappear on a later page. `beforeSequence` is exclusive. The default and maximum limit are 100. Workspace input is bounded to 4,096 UTF-8 bytes and the result has an explicit 256 KiB serialized budget.

The content method has this logical contract:

```ts
type ArtifactReadParams = {
  workspace: string;
  threadId: ThreadId;
  artifactId: ArtifactId;
  beforeByte?: number;
  afterByte?: number;
  maxBytes?: number;
};

type ArtifactReadResult = {
  workspace: string;
  threadId: ThreadId;
  artifact: ArtifactReference;
  content: string;
  startByte: number;
  endByte: number;
  totalBytes: number;
  hasEarlier: boolean;
  hasLater: boolean;
};
```

`beforeByte` and `afterByte` are mutually exclusive half-open byte-boundary cursors. Omitting both reads from byte zero. A forward request begins at `afterByte`; a backward request returns the largest valid range ending at `beforeByte`. The default TUI request is 16 KiB and the protocol maximum is 64 KiB. All byte values are non-negative safe integers. Results are capped at 80 KiB serialized so content plus metadata and JSON escaping cannot exceed the app-server boundary.

## 4. Authoritative authorization and storage reads

Both operations canonicalize the supplied workspace through `realpath`, require an existing directory, parse the local thread ID, and read the complete thread JSONL through the strict event store. Missing logs, partial trailing records, invalid events, sequence corruption, or conflicting thread IDs fail closed.

The application examines durable `turn.context` events and requires every usable context snapshot to identify the canonical workspace. A mismatch fails before returning descriptors or opening the artifact store. The artifact list is derived only from validated `artifact.recorded` events. `artifact/read` locates an exact ID in that derived set and uses its recorded byte count and media type as the expected reference. An artifact that exists globally but is not referenced by the thread returns `ARTIFACT_NOT_REFERENCED`.

ArtifactStore gains a verified text-range read that operates through one owned file handle. It rejects symlinks and non-regular files, checks the recorded size, hashes the content, validates the artifact ID, reads the requested range, and rechecks relevant file metadata before returning. Replacement, truncation, digest mismatch, or an invalid UTF-8 sequence returns `ARTIFACT_CORRUPT`.

Range selection preserves exact UTF-8 code-point boundaries. Forward responses end at the last complete code point at or below the byte budget. Backward responses start at the earliest complete code point that fits while ending exactly at the requested boundary. A client that sends the returned `endByte` as the next `afterByte`, or `startByte` as the next `beforeByte`, receives contiguous content without duplication, omission, or replacement characters.

## 5. TUI interaction and state

The controller adds `artifact_list` and `artifact_view` modes. Artifact navigation is idle-only and cannot overlap an active turn, approval, settings flow, thread search, or another asynchronous navigation request. It shares the existing generation counter so Escape or a mode change invalidates late results.

From chat:

- `/artifacts` opens the current thread's artifact list. With no current thread it shows a notice without mutating the transcript.
- `/artifact <sha256:...>` validates and opens that artifact directly within the current thread.

From `thread_preview`, pressing `a` opens the artifact list for the previewed thread without resuming it. The artifact-navigation state records its origin (`chat` or `thread_preview`), target thread, list page, selection, content page, scroll position, viewport height, and loading flag. It never stores a disk path.

The list renders tool name, media type, byte count, and a shortened presentation ID while retaining the full ID in controller state. Up/Down moves one item. Enter opens the selected artifact. PageUp/PageDown fetch adjacent descriptor pages and Home/End reach list boundaries. Empty lists retain their origin and show a bounded notice.

The viewer requests 16 KiB ranges by default. It wraps sanitized content to the terminal width and shows 5–30 rows. Up/Down scroll within the loaded range. PageUp/PageDown request adjacent byte ranges; Home and End request the first and last range. The header shows the full artifact ID, media type, and `startByte–endByte / totalBytes`. ANSI escape sequences and non-display control characters are stripped only for presentation; stored content is unchanged.

Escape is layered. A viewer opened from a list returns to that list. A direct-ID viewer returns to chat. A list opened from preview returns to the unchanged preview; a chat list returns to chat. Artifact content and navigation messages do not enter completed chat output, JSONL, or model-visible items.

## 6. Failure and consistency behavior

Artifact inspection is read-only and never requests approval. Clients cannot supply storage paths, media types, recorded sizes, or hashes separately from the strict artifact ID. Stable application data codes include:

- `INVALID_ARTIFACT_RANGE`;
- `ARTIFACT_NOT_REFERENCED`;
- `ARTIFACT_NOT_FOUND`;
- `ARTIFACT_CORRUPT`;
- `ARTIFACT_MEDIA_TYPE_UNSUPPORTED`;
- the existing thread-not-found, workspace-mismatch, and event-log-corruption codes.

Failure to open the first list or direct artifact preserves the source chat or preview. Failure while paging preserves the currently displayed descriptors or content and exposes a retryable bounded notice. Missing and corrupt artifacts are not automatically repaired, quarantined, or removed, and their JSONL references remain unchanged.

Artifact garbage collection derives reachability from valid JSONL, so an artifact referenced by the authorized thread is not an eligible collection candidate. External deletion or corruption may still race with a read; the viewer reports the resulting stable error and retains its prior page. A late success or failure after Escape is ignored by generation checks.

Strict protocol schema failures, response-budget violations, malformed NDJSON, and incompatible protocol versions retain the existing client disconnect behavior. They are not converted into empty lists or empty artifact pages. All diagnostics, names, media types, IDs, content ranges, and rendered rows are byte bounded and terminal sanitized at the presentation boundary.

## 7. Testing and acceptance criteria

Protocol tests cover v6 initialization, rejection of v5, `artifactInspection`, strict list/read schemas, mutually exclusive cursors, safe-integer and limit bounds, artifact IDs, supported media types, result coherence, and serialized response budgets.

Runtime tests cover UTF-8 multi-byte boundaries, contiguous forward and backward reads, first and last ranges, empty content, long lines, JSON, non-regular files, size mismatch, digest corruption, invalid UTF-8, and file changes during a read.

Application tests cover canonical workspace resolution, thread ownership, valid JSONL authorization, newest-occurrence deduplication, stable list pagination, unreferenced IDs, missing and corrupt artifacts, and unsupported media types. App-server and Node client tests cover typed round trips, real subprocess framing, stable data codes, timeouts, and strict response parsing.

Controller and Ink tests cover `/artifacts`, `/artifact <id>`, the preview `a` shortcut, selection, list pagination, direct and list-based viewer origins, within-range scrolling, byte paging, Home/End, resize behavior, layered Escape, empty state, failure preservation, and stale-response rejection.

A real TTY smoke uses an isolated `KODA_HOME` and deterministic stored artifact to exercise list discovery, direct open, forward/backward navigation, the preview entry point, layered Escape, and graceful shutdown. Acceptance requires formatting, build, workspace typechecks, test TypeScript checks, the complete offline suite, all six deterministic reliability scenarios, and the real TTY smoke to pass.

## 8. Deferred destinations

- Binary, image, hexadecimal, or Base64 viewers.
- Download, export, clipboard, and operating-system external-open integration.
- Markdown layout, syntax highlighting, and dedicated diff rendering.
- Artifact search, cross-thread aggregation, workspace-wide catalogs, and cross-workspace reads.
- Artifact deletion, editing, republishing, or manual import.
- Attachments, uploads, remote artifact stores, HTTP transport, and shared-client authorization.
- Live following of an artifact that is still being captured or any general file-manager behavior.
