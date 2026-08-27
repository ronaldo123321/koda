import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import {
  THREAD_SEARCH_DEFAULT_LIMIT,
  THREAD_SEARCH_MAXIMUM_LIMIT,
  THREAD_SEARCH_MAXIMUM_TERMS,
  modelProviderIdSchema,
  threadIdSchema,
  turnIdSchema,
  type AgentEvent,
  type ThreadId,
  type ThreadSearchCursor,
  type ThreadSearchItemKind,
  type ThreadSearchMatch,
  type TokenUsage,
  type TurnId,
  type TurnUsage,
} from "@koda/protocol";

import {
  JsonlEventStore,
  type JsonlEventReadResult,
} from "./jsonl-event-store.js";
import { ThreadLease } from "./thread-lease.js";
import { ThreadRecoveryError, recoverThread } from "./thread-recovery.js";

export type ThreadMetadataStatus =
  "running" | "completed" | "failed" | "cancelled" | "interrupted" | "invalid";

export interface ThreadUsageSummary {
  modelRequests: number;
  reportedRequests: number;
  tokens: TokenUsage;
}

export interface ThreadMetadata {
  threadId: ThreadId;
  logFile: string;
  status: ThreadMetadataStatus;
  createdAt: string;
  updatedAt: string;
  lastTurnId?: TurnId;
  provider?: string;
  model?: string;
  workspaceRoot?: string;
  approvalMode?: string;
  turnCount: number;
  eventCount: number;
  lastSequence?: number;
  usage: ThreadUsageSummary;
  sourceBytes: number;
  indexedBytes: number;
  sourceMtimeMs: number;
  errorMessage?: string;
}

export interface ThreadMetadataListOptions {
  limit?: number;
  workspaceRoot?: string;
}

export interface ThreadIndexDiagnostic {
  logFile: string;
  message: string;
}

export interface ThreadIndexRefreshResult {
  indexed: number;
  skipped: number;
  removed: number;
  diagnostics: ThreadIndexDiagnostic[];
}

export interface ThreadIndexRecovery {
  databaseBackup: string;
}

export interface ThreadSearchOptions {
  workspaceRoot: string;
  query: string;
  cursor?: ThreadSearchCursor;
  limit?: number;
}

export interface ThreadSearchPage {
  matches: ThreadSearchMatch[];
  revision: number;
  hasMore: boolean;
  nextCursor?: ThreadSearchCursor;
}

export class ThreadSearchIndexChangedError extends Error {
  public readonly code = "THREAD_SEARCH_INDEX_CHANGED";

  public constructor() {
    super("Thread search index changed; rerun the search from the first page.");
    this.name = "ThreadSearchIndexChangedError";
  }
}

export interface ThreadMetadataIndexOpenOptions {
  now?: () => string;
}

interface ThreadProjectionRow {
  thread_id: string;
  log_file: string;
  status: ThreadMetadataStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  last_turn_id: string | null;
  provider: string | null;
  model: string | null;
  workspace_root: string | null;
  approval_mode: string | null;
  turn_count: number;
  event_count: number;
  last_sequence: number | null;
  model_requests: number;
  reported_requests: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  source_bytes: number;
  indexed_bytes: number;
  source_mtime_ms: number;
}

interface SourceFingerprintRow {
  thread_id: string;
  status: ThreadMetadataStatus;
  source_bytes: number;
  source_mtime_ms: number;
}

interface LogDescriptor {
  threadId: ThreadId;
  logFile: string;
  path: string;
  sourceBytes: number;
  sourceMtimeMs: number;
}

interface SearchProjectionRow {
  thread_id: string;
  sequence: number;
  timestamp: string;
  kind: ThreadSearchItemKind;
  display_text: string;
  normalized_text: string;
  truncated: 0 | 1;
}

interface ThreadProjection {
  thread: ThreadProjectionRow;
  searchItems: SearchProjectionRow[];
}

interface SearchResultRow {
  thread_id: string;
  sequence: number;
  timestamp: string;
  kind: ThreadSearchItemKind;
  display_text: string;
  normalized_text: string;
  updated_at: string;
  status: ThreadMetadataStatus;
  provider: string | null;
  model: string | null;
  turn_count: number;
}

const SCHEMA_VERSION = 2;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const MAX_DIAGNOSTIC_LENGTH = 1_000;
const MAX_SEARCH_ITEM_BYTES = 256 * 1_024;
const SEARCH_SNIPPET_BYTES = 512;
const LOCAL_THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export class ThreadMetadataIndex {
  public readonly databasePath: string;
  public readonly recovery: ThreadIndexRecovery | undefined;
  private closed = false;

  private constructor(
    private readonly kodaHome: string,
    private readonly database: Database.Database,
    recovery?: ThreadIndexRecovery,
  ) {
    this.databasePath = join(kodaHome, "state.db");
    this.recovery = recovery;
  }

  public static async open(
    kodaHome: string,
    options: ThreadMetadataIndexOpenOptions = {},
  ): Promise<ThreadMetadataIndex> {
    const databasePath = join(kodaHome, "state.db");
    await mkdir(dirname(databasePath), { recursive: true });
    let database: Database.Database | undefined;
    try {
      database = openDatabase(databasePath);
      initializeDatabase(database);
      return new ThreadMetadataIndex(kodaHome, database);
    } catch (error) {
      try {
        database?.close();
      } catch {
        // The invalid handle is abandoned before its files are quarantined.
      }
      if (!isCorruptionError(error)) {
        throw error;
      }
      const databaseBackup = await quarantineDatabase(
        databasePath,
        (options.now ?? (() => new Date().toISOString()))(),
      );
      const replacement = openDatabase(databasePath);
      try {
        initializeDatabase(replacement);
      } catch (replacementError) {
        replacement.close();
        throw replacementError;
      }
      return new ThreadMetadataIndex(kodaHome, replacement, {
        databaseBackup,
      });
    }
  }

  public async refresh(): Promise<ThreadIndexRefreshResult> {
    this.assertOpen();
    const { descriptors, diagnostics } = await this.discoverLogs();
    const fingerprints = this.readFingerprints();
    const projections: ThreadProjection[] = [];
    let skipped = 0;
    let leaseStatusChanged = false;

    for (const descriptor of descriptors) {
      const existing = fingerprints.get(descriptor.threadId);
      if (
        existing !== undefined &&
        existing.source_bytes === descriptor.sourceBytes &&
        existing.source_mtime_ms === descriptor.sourceMtimeMs
      ) {
        leaseStatusChanged =
          (await this.refreshLeaseStatus(descriptor, existing)) ||
          leaseStatusChanged;
        skipped += 1;
        continue;
      }
      const projection = await this.project(descriptor);
      projections.push(projection);
      if (projection.thread.status === "invalid") {
        diagnostics.push({
          logFile: descriptor.logFile,
          message: projection.thread.error_message ?? "Thread log is invalid.",
        });
      }
    }

    const currentThreadIds = new Set(
      descriptors.map((descriptor) => descriptor.threadId),
    );
    const missingThreadIds = [...fingerprints.keys()].filter(
      (threadId) => !currentThreadIds.has(threadId),
    );
    this.database
      .transaction(() => {
        for (const projection of projections) {
          this.upsert(projection.thread);
          this.replaceSearchItems(
            projection.thread.thread_id,
            projection.searchItems,
          );
        }
        const remove = this.database.prepare(
          "DELETE FROM threads WHERE thread_id = ?",
        );
        for (const threadId of missingThreadIds) {
          remove.run(threadId);
        }
        if (
          projections.length > 0 ||
          missingThreadIds.length > 0 ||
          leaseStatusChanged
        ) {
          this.advanceRevision();
        }
      })
      .immediate();

    return {
      indexed: projections.length,
      skipped,
      removed: missingThreadIds.length,
      diagnostics,
    };
  }

  public async rebuild(): Promise<ThreadIndexRefreshResult> {
    this.assertOpen();
    const { descriptors, diagnostics } = await this.discoverLogs();
    const projections: ThreadProjection[] = [];
    for (const descriptor of descriptors) {
      const projection = await this.project(descriptor);
      projections.push(projection);
      if (projection.thread.status === "invalid") {
        diagnostics.push({
          logFile: descriptor.logFile,
          message: projection.thread.error_message ?? "Thread log is invalid.",
        });
      }
    }
    this.database
      .transaction(() => {
        this.database.exec("DELETE FROM thread_search_items");
        this.database.exec("DELETE FROM threads");
        for (const projection of projections) {
          this.upsert(projection.thread);
          this.replaceSearchItems(
            projection.thread.thread_id,
            projection.searchItems,
          );
        }
        this.advanceRevision();
      })
      .immediate();
    return {
      indexed: projections.length,
      skipped: 0,
      removed: 0,
      diagnostics,
    };
  }

  public async refreshThread(
    threadIdInput: ThreadId | string,
  ): Promise<ThreadIndexRefreshResult> {
    this.assertOpen();
    const threadId = parseLocalThreadId(threadIdInput);
    const logFile = `${threadId}.jsonl`;
    const path = join(this.kodaHome, "threads", logFile);
    let descriptor: LogDescriptor;
    try {
      descriptor = await describeLog(threadId, logFile, path);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        let removed = 0;
        this.database
          .transaction(() => {
            removed = this.database
              .prepare("DELETE FROM threads WHERE thread_id = ?")
              .run(threadId).changes;
            if (removed > 0) {
              this.advanceRevision();
            }
          })
          .immediate();
        return {
          indexed: 0,
          skipped: 0,
          removed,
          diagnostics: [],
        };
      }
      throw error;
    }
    const projection = await this.project(descriptor);
    this.database
      .transaction(() => {
        this.upsert(projection.thread);
        this.replaceSearchItems(
          projection.thread.thread_id,
          projection.searchItems,
        );
        this.advanceRevision();
      })
      .immediate();
    return {
      indexed: 1,
      skipped: 0,
      removed: 0,
      diagnostics:
        projection.thread.status === "invalid"
          ? [
              {
                logFile,
                message:
                  projection.thread.error_message ?? "Thread log is invalid.",
              },
            ]
          : [],
    };
  }

  public list(options: ThreadMetadataListOptions = {}): ThreadMetadata[] {
    this.assertOpen();
    const limit = options.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new RangeError(
        `Thread list limit must be between 1 and ${MAX_LIMIT}.`,
      );
    }
    const rows =
      options.workspaceRoot === undefined
        ? this.database
            .prepare<[number], ThreadProjectionRow>(
              "SELECT * FROM threads ORDER BY updated_at DESC, thread_id ASC LIMIT ?",
            )
            .all(limit)
        : this.database
            .prepare<[string, number], ThreadProjectionRow>(
              "SELECT * FROM threads WHERE workspace_root = ? ORDER BY updated_at DESC, thread_id ASC LIMIT ?",
            )
            .all(options.workspaceRoot, limit);
    return rows.map(toThreadMetadata);
  }

  public get(threadIdInput: ThreadId | string): ThreadMetadata | undefined {
    this.assertOpen();
    const threadId = threadIdSchema.parse(threadIdInput);
    const row = this.database
      .prepare<[string], ThreadProjectionRow>(
        "SELECT * FROM threads WHERE thread_id = ?",
      )
      .get(threadId);
    return row === undefined ? undefined : toThreadMetadata(row);
  }

  public search(options: ThreadSearchOptions): ThreadSearchPage {
    this.assertOpen();
    const limit = options.limit ?? THREAD_SEARCH_DEFAULT_LIMIT;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > THREAD_SEARCH_MAXIMUM_LIMIT
    ) {
      throw new RangeError(
        `Thread search limit must be between 1 and ${THREAD_SEARCH_MAXIMUM_LIMIT}.`,
      );
    }
    const normalizedQuery = normalizeSearchText(options.query);
    const terms = normalizedQuery.split(" ").filter(Boolean);
    if (terms.length === 0) {
      throw new RangeError(
        "Thread search query must contain a non-empty term.",
      );
    }
    if (terms.length > THREAD_SEARCH_MAXIMUM_TERMS) {
      throw new RangeError(
        `Thread search query must contain at most ${THREAD_SEARCH_MAXIMUM_TERMS} terms.`,
      );
    }
    const revision = this.readRevision();
    if (options.cursor !== undefined && options.cursor.revision !== revision) {
      throw new ThreadSearchIndexChangedError();
    }

    const predicates = terms.map(() => "instr(search.normalized_text, ?) > 0");
    const parameters: Array<string | number> = [
      options.workspaceRoot,
      ...terms,
    ];
    if (options.cursor !== undefined) {
      predicates.push(`(
        thread.updated_at < ? OR
        (thread.updated_at = ? AND thread.thread_id > ?) OR
        (thread.updated_at = ? AND thread.thread_id = ? AND search.sequence < ?)
      )`);
      parameters.push(
        options.cursor.updatedAt,
        options.cursor.updatedAt,
        options.cursor.threadId,
        options.cursor.updatedAt,
        options.cursor.threadId,
        options.cursor.sequence,
      );
    }
    parameters.push(limit + 1);
    const rows = this.database
      .prepare(
        `SELECT
          search.thread_id, search.sequence, search.timestamp, search.kind,
          search.display_text, search.normalized_text,
          thread.updated_at, thread.status, thread.provider, thread.model,
          thread.turn_count
        FROM thread_search_items AS search
        INNER JOIN threads AS thread ON thread.thread_id = search.thread_id
        WHERE thread.workspace_root = ? AND ${predicates.join(" AND ")}
        ORDER BY thread.updated_at DESC, thread.thread_id ASC, search.sequence DESC
        LIMIT ?`,
      )
      .all(...parameters) as SearchResultRow[];
    const hasMore = rows.length > limit;
    const selected = hasMore ? rows.slice(0, limit) : rows;
    const matches = selected.map((row): ThreadSearchMatch => ({
      threadId: threadIdSchema.parse(row.thread_id),
      sequence: row.sequence,
      kind: row.kind,
      timestamp: row.timestamp,
      snippet: searchSnippet(row.display_text, terms),
      threadUpdatedAt: row.updated_at,
      status: row.status,
      ...(row.provider === null
        ? {}
        : { provider: modelProviderIdSchema.parse(row.provider) }),
      ...(row.model === null ? {} : { model: row.model }),
      turnCount: row.turn_count,
    }));
    if (!hasMore) {
      return { matches, revision, hasMore: false };
    }
    const last = matches.at(-1);
    if (last === undefined) {
      throw new Error("Thread search pagination produced no cursor match.");
    }
    return {
      matches,
      revision,
      hasMore: true,
      nextCursor: {
        revision,
        updatedAt: last.threadUpdatedAt,
        threadId: last.threadId,
        sequence: last.sequence,
      },
    };
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.database.close();
  }

  private async discoverLogs(): Promise<{
    descriptors: LogDescriptor[];
    diagnostics: ThreadIndexDiagnostic[];
  }> {
    const threadsDirectory = join(this.kodaHome, "threads");
    let names: string[];
    try {
      names = await readdir(threadsDirectory);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { descriptors: [], diagnostics: [] };
      }
      throw error;
    }
    const descriptors: LogDescriptor[] = [];
    const diagnostics: ThreadIndexDiagnostic[] = [];
    for (const logFile of names.sort()) {
      if (!logFile.endsWith(".jsonl")) {
        continue;
      }
      const rawThreadId = logFile.slice(0, -".jsonl".length);
      if (!LOCAL_THREAD_ID_PATTERN.test(rawThreadId)) {
        diagnostics.push({
          logFile,
          message: "Ignored a JSONL file whose name is not a valid thread ID.",
        });
        continue;
      }
      const parsedThreadId = threadIdSchema.parse(rawThreadId);
      const path = join(threadsDirectory, logFile);
      try {
        descriptors.push(await describeLog(parsedThreadId, logFile, path));
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) {
          diagnostics.push({
            logFile,
            message: boundedMessage(error),
          });
        }
      }
    }
    return { descriptors, diagnostics };
  }

  private readFingerprints(): Map<ThreadId, SourceFingerprintRow> {
    const rows = this.database
      .prepare<[], SourceFingerprintRow>(
        "SELECT thread_id, status, source_bytes, source_mtime_ms FROM threads",
      )
      .all();
    return new Map(
      rows.map((row) => [threadIdSchema.parse(row.thread_id), row]),
    );
  }

  private async refreshLeaseStatus(
    descriptor: LogDescriptor,
    existing: SourceFingerprintRow,
  ): Promise<boolean> {
    if (existing.status !== "running" && existing.status !== "interrupted") {
      return false;
    }
    const active = await ThreadLease.isActive(descriptor.path);
    const status: ThreadMetadataStatus = active ? "running" : "interrupted";
    if (status !== existing.status) {
      this.database
        .prepare("UPDATE threads SET status = ? WHERE thread_id = ?")
        .run(status, descriptor.threadId);
      return true;
    }
    return false;
  }

  private async project(descriptor: LogDescriptor): Promise<ThreadProjection> {
    const active = await ThreadLease.isActive(descriptor.path);
    let readResult: JsonlEventReadResult | undefined;
    try {
      readResult = await new JsonlEventStore(descriptor.path).readAll();
      const recovered = recoverThread(readResult, descriptor.threadId);
      const firstEvent = readResult.events[0];
      const lastEvent = readResult.events.at(-1);
      if (firstEvent === undefined || lastEvent === undefined) {
        throw new Error("Thread log does not contain a valid event.");
      }
      const hasPartialTail = readResult.diagnostics.some(
        (diagnostic) => diagnostic.code === "PARTIAL_TRAILING_LINE",
      );
      const status: ThreadMetadataStatus =
        hasPartialTail || recovered.previousStatus === "interrupted"
          ? active
            ? "running"
            : "interrupted"
          : recovered.previousStatus;
      const usage = aggregateUsage(readResult.events);
      return {
        thread: {
          thread_id: descriptor.threadId,
          log_file: descriptor.logFile,
          status,
          error_message: null,
          created_at: firstEvent.timestamp,
          updated_at: lastEvent.timestamp,
          last_turn_id: lastEvent.turnId,
          provider: recovered.context.provider,
          model: recovered.context.model,
          workspace_root: recovered.context.workspaceRoot,
          approval_mode: recovered.context.approvalMode,
          turn_count: readResult.events.filter(
            (event) => event.type === "turn.started",
          ).length,
          event_count: readResult.events.length,
          last_sequence: lastEvent.sequence,
          model_requests: usage.modelRequests,
          reported_requests: usage.reportedRequests,
          input_tokens: usage.tokens.inputTokens,
          cached_input_tokens: usage.tokens.cachedInputTokens,
          cache_write_input_tokens: usage.tokens.cacheWriteInputTokens,
          output_tokens: usage.tokens.outputTokens,
          reasoning_output_tokens: usage.tokens.reasoningOutputTokens,
          total_tokens: usage.tokens.totalTokens,
          source_bytes: readResult.sourceBytes,
          indexed_bytes: readResult.indexedBytes,
          source_mtime_ms: descriptor.sourceMtimeMs,
        },
        searchItems:
          readResult.diagnostics.length === 0
            ? projectSearchItems(readResult.events)
            : [],
      };
    } catch (error) {
      if (
        active &&
        readResult !== undefined &&
        error instanceof ThreadRecoveryError &&
        error.code === "THREAD_CONTEXT_MISSING"
      ) {
        return {
          thread: projectActivePrefix(descriptor, readResult),
          searchItems: [],
        };
      }
      const timestamp = new Date(descriptor.sourceMtimeMs).toISOString();
      return {
        thread: {
          thread_id: descriptor.threadId,
          log_file: descriptor.logFile,
          status: "invalid",
          error_message: boundedMessage(error),
          created_at: timestamp,
          updated_at: timestamp,
          last_turn_id: null,
          provider: null,
          model: null,
          workspace_root: null,
          approval_mode: null,
          turn_count: 0,
          event_count: 0,
          last_sequence: null,
          ...flatUsage(zeroUsage()),
          source_bytes: descriptor.sourceBytes,
          indexed_bytes: 0,
          source_mtime_ms: descriptor.sourceMtimeMs,
        },
        searchItems: [],
      };
    }
  }

  private upsert(row: ThreadProjectionRow): void {
    this.database.prepare<ThreadProjectionRow>(UPSERT_THREAD_SQL).run(row);
  }

  private replaceSearchItems(
    threadId: string,
    rows: readonly SearchProjectionRow[],
  ): void {
    this.database
      .prepare("DELETE FROM thread_search_items WHERE thread_id = ?")
      .run(threadId);
    const insert = this.database.prepare<SearchProjectionRow>(
      `INSERT INTO thread_search_items (
        thread_id, sequence, timestamp, kind, display_text,
        normalized_text, truncated
      ) VALUES (
        @thread_id, @sequence, @timestamp, @kind, @display_text,
        @normalized_text, @truncated
      )`,
    );
    for (const row of rows) {
      insert.run(row);
    }
  }

  private advanceRevision(): void {
    this.database
      .prepare(
        "UPDATE thread_index_state SET revision = revision + 1 WHERE id = 1",
      )
      .run();
  }

  private readRevision(): number {
    const row = this.database
      .prepare<[], { revision: number }>(
        "SELECT revision FROM thread_index_state WHERE id = 1",
      )
      .get();
    if (row === undefined || !Number.isSafeInteger(row.revision)) {
      throw new Error("Thread metadata index revision is unavailable.");
    }
    return row.revision;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Thread metadata index is closed.");
    }
  }
}

function projectActivePrefix(
  descriptor: LogDescriptor,
  readResult: JsonlEventReadResult,
): ThreadProjectionRow {
  const firstEvent = readResult.events[0];
  const lastEvent = readResult.events.at(-1);
  if (firstEvent === undefined || lastEvent === undefined) {
    throw new Error("Active thread log does not contain a valid event.");
  }
  const context = [...readResult.events]
    .reverse()
    .find((event) => event.type === "turn.context");
  const usage = aggregateUsage(readResult.events);
  return {
    thread_id: descriptor.threadId,
    log_file: descriptor.logFile,
    status: "running",
    error_message: null,
    created_at: firstEvent.timestamp,
    updated_at: lastEvent.timestamp,
    last_turn_id: lastEvent.turnId,
    provider:
      context?.type === "turn.context" ? context.payload.provider : null,
    model: context?.type === "turn.context" ? context.payload.model : null,
    workspace_root:
      context?.type === "turn.context" ? context.payload.workspaceRoot : null,
    approval_mode:
      context?.type === "turn.context" ? context.payload.approvalMode : null,
    turn_count: readResult.events.filter(
      (event) => event.type === "turn.started",
    ).length,
    event_count: readResult.events.length,
    last_sequence: lastEvent.sequence,
    ...flatUsage(usage),
    source_bytes: readResult.sourceBytes,
    indexed_bytes: readResult.indexedBytes,
    source_mtime_ms: descriptor.sourceMtimeMs,
  };
}

function projectSearchItems(
  events: readonly AgentEvent[],
): SearchProjectionRow[] {
  const recordedToolResults = new Set(
    events.flatMap((event) =>
      event.type === "item.recorded" &&
      event.payload.item.type === "tool_result"
        ? [event.payload.item.callId]
        : [],
    ),
  );
  const rows: SearchProjectionRow[] = [];
  for (const event of events) {
    const projected = searchableEvent(event, recordedToolResults);
    if (projected === undefined) {
      continue;
    }
    const sanitized = terminalSafeText(projected.text);
    if (sanitized.trim().length === 0) {
      continue;
    }
    const bounded = boundSearchItem(sanitized);
    rows.push({
      thread_id: event.threadId,
      sequence: event.sequence,
      timestamp: event.timestamp,
      kind: projected.kind,
      display_text: bounded.text,
      normalized_text: boundSearchItem(normalizeSearchText(bounded.text)).text,
      truncated: bounded.truncated ? 1 : 0,
    });
  }
  return rows;
}

function searchableEvent(
  event: AgentEvent,
  recordedToolResults: ReadonlySet<string>,
): { kind: ThreadSearchItemKind; text: string } | undefined {
  if (event.type === "item.recorded") {
    const item = event.payload.item;
    switch (item.type) {
      case "user_message":
        return { kind: "user_message", text: item.content };
      case "assistant_message":
        return { kind: "assistant_message", text: item.content };
      case "tool_result":
        return {
          kind: "tool_result",
          text:
            item.status === "error"
              ? `${item.name}: ${item.error?.code ?? "error"}${
                  item.error?.message === undefined
                    ? ""
                    : ` — ${item.error.message}`
                }`
              : `${item.name}: success${
                  item.output === undefined
                    ? ""
                    : ` — ${jsonSearchSummary(item.output)}`
                }`,
        };
      case "compaction":
        return {
          kind: "compaction",
          text: [
            `Context compacted: ${item.summary.objective || "summary recorded"}.`,
            ...item.summary.decisions.map((value) => `Decision: ${value}`),
            ...item.summary.completedWork.map((value) => `Completed: ${value}`),
            ...item.summary.pendingWork.map((value) => `Pending: ${value}`),
            ...item.summary.failedAttempts.map(
              (value) => `Failed attempt: ${value}`,
            ),
            ...item.summary.criticalFacts.map((value) => `Fact: ${value}`),
          ].join("\n"),
        };
      case "recovery":
        return {
          kind: "recovery",
          text: `Recovery (${item.previousStatus}): ${item.message}${
            item.uncertainToolCalls.length === 0
              ? ""
              : ` Uncertain operations: ${item.uncertainToolCalls
                  .map((call) => call.name)
                  .join(", ")}.`
          }`,
        };
      default:
        return undefined;
    }
  }
  if (
    event.type === "tool.completed" &&
    event.payload.status === "error" &&
    !recordedToolResults.has(event.payload.callId)
  ) {
    return {
      kind: "tool_failure",
      text: `${event.payload.name}: tool execution failed.`,
    };
  }
  if (event.type === "turn.cancelled") {
    return {
      kind: "turn_cancelled",
      text: `Turn cancelled: ${event.payload.reason}`,
    };
  }
  if (event.type === "turn.failed") {
    return {
      kind: "turn_failed",
      text: `${event.payload.code}: ${event.payload.message}`,
    };
  }
  return undefined;
}

function jsonSearchSummary(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable output]";
  }
}

function terminalSafeText(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
}

export function normalizeThreadSearchText(text: string): string {
  return normalizeSearchText(text);
}

function normalizeSearchText(text: string): string {
  return terminalSafeText(text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

function boundSearchItem(text: string): {
  text: string;
  truncated: boolean;
} {
  if (Buffer.byteLength(text, "utf8") <= MAX_SEARCH_ITEM_BYTES) {
    return { text, truncated: false };
  }
  const marker = "\n… [content truncated] …\n";
  const remaining = MAX_SEARCH_ITEM_BYTES - Buffer.byteLength(marker, "utf8");
  const prefixBudget = Math.floor(remaining / 2);
  const suffixBudget = remaining - prefixBudget;
  return {
    text: `${takeUtf8Prefix(text, prefixBudget)}${marker}${takeUtf8Suffix(
      text,
      suffixBudget,
    )}`,
    truncated: true,
  };
}

function searchSnippet(text: string, terms: readonly string[]): string {
  const comparable = text.normalize("NFKC").toLowerCase();
  const positions = terms
    .map((term) => comparable.indexOf(term))
    .filter((position) => position >= 0);
  const earliest = positions.length === 0 ? 0 : Math.min(...positions);
  const start = Math.max(0, earliest - 160);
  const prefix = start > 0 ? "…" : "";
  const prefixBytes = Buffer.byteLength(prefix, "utf8");
  const body = takeUtf8Prefix(
    text.slice(start),
    SEARCH_SNIPPET_BYTES - prefixBytes - 3,
  );
  const consumed = start + body.length;
  const suffix = consumed < text.length ? "…" : "";
  return terminalSafeText(`${prefix}${body}${suffix}`);
}

function takeUtf8Prefix(text: string, budget: number): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf8") <= budget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  let result = text.slice(0, low);
  if (/\p{Surrogate}$/u.test(result)) {
    result = result.slice(0, -1);
  }
  return result;
}

function takeUtf8Suffix(text: string, budget: number): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(text.length - middle), "utf8") <= budget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  let result = text.slice(text.length - low);
  if (/^\p{Surrogate}/u.test(result)) {
    result = result.slice(1);
  }
  return result;
}

const UPSERT_THREAD_SQL = `
  INSERT INTO threads (
    thread_id, log_file, status, error_message, created_at, updated_at,
    last_turn_id, provider, model, workspace_root, approval_mode,
    turn_count, event_count, last_sequence, model_requests,
    reported_requests, input_tokens, cached_input_tokens,
    cache_write_input_tokens, output_tokens, reasoning_output_tokens,
    total_tokens, source_bytes, indexed_bytes, source_mtime_ms
  ) VALUES (
    @thread_id, @log_file, @status, @error_message, @created_at, @updated_at,
    @last_turn_id, @provider, @model, @workspace_root, @approval_mode,
    @turn_count, @event_count, @last_sequence, @model_requests,
    @reported_requests, @input_tokens, @cached_input_tokens,
    @cache_write_input_tokens, @output_tokens, @reasoning_output_tokens,
    @total_tokens, @source_bytes, @indexed_bytes, @source_mtime_ms
  )
  ON CONFLICT(thread_id) DO UPDATE SET
    log_file = excluded.log_file,
    status = excluded.status,
    error_message = excluded.error_message,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    last_turn_id = excluded.last_turn_id,
    provider = excluded.provider,
    model = excluded.model,
    workspace_root = excluded.workspace_root,
    approval_mode = excluded.approval_mode,
    turn_count = excluded.turn_count,
    event_count = excluded.event_count,
    last_sequence = excluded.last_sequence,
    model_requests = excluded.model_requests,
    reported_requests = excluded.reported_requests,
    input_tokens = excluded.input_tokens,
    cached_input_tokens = excluded.cached_input_tokens,
    cache_write_input_tokens = excluded.cache_write_input_tokens,
    output_tokens = excluded.output_tokens,
    reasoning_output_tokens = excluded.reasoning_output_tokens,
    total_tokens = excluded.total_tokens,
    source_bytes = excluded.source_bytes,
    indexed_bytes = excluded.indexed_bytes,
    source_mtime_ms = excluded.source_mtime_ms
`;

function openDatabase(path: string): Database.Database {
  return new Database(path, { timeout: 5_000 });
}

function initializeDatabase(database: Database.Database): void {
  database.pragma("busy_timeout = 5000");
  const quickCheck = database.pragma("quick_check") as Array<
    Record<string, unknown>
  >;
  if (
    quickCheck.length !== 1 ||
    Object.values(quickCheck[0] ?? {}).some((value) => value !== "ok")
  ) {
    throw new ThreadMetadataCorruptionError(
      "SQLite quick_check reported corruption.",
    );
  }
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  const version = database.pragma("user_version", { simple: true });
  if (version !== SCHEMA_VERSION || !hasCurrentSchema(database)) {
    resetSchema(database);
  }
}

function hasCurrentSchema(database: Database.Database): boolean {
  try {
    database
      .prepare(
        `SELECT
          thread_id, log_file, status, error_message, created_at, updated_at,
          last_turn_id, provider, model, workspace_root, approval_mode,
          turn_count, event_count, last_sequence, model_requests,
          reported_requests, input_tokens, cached_input_tokens,
          cache_write_input_tokens, output_tokens, reasoning_output_tokens,
          total_tokens, source_bytes, indexed_bytes, source_mtime_ms
        FROM threads LIMIT 0`,
      )
      .all();
    database
      .prepare(
        `SELECT
          thread_id, sequence, timestamp, kind, display_text,
          normalized_text, truncated
        FROM thread_search_items LIMIT 0`,
      )
      .all();
    const state = database
      .prepare("SELECT revision FROM thread_index_state WHERE id = 1")
      .get();
    if (state === undefined) {
      return false;
    }
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      String((error as { code?: unknown }).code).startsWith("SQLITE_ERROR")
    ) {
      return false;
    }
    throw error;
  }
}

function resetSchema(database: Database.Database): void {
  database
    .transaction(() => {
      database.exec(`
        DROP TABLE IF EXISTS thread_search_items;
        DROP TABLE IF EXISTS thread_index_state;
        DROP TABLE IF EXISTS threads;
        CREATE TABLE threads (
          thread_id TEXT PRIMARY KEY,
          log_file TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK (
            status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted', 'invalid')
          ),
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_turn_id TEXT,
          provider TEXT,
          model TEXT,
          workspace_root TEXT,
          approval_mode TEXT,
          turn_count INTEGER NOT NULL CHECK (turn_count >= 0),
          event_count INTEGER NOT NULL CHECK (event_count >= 0),
          last_sequence INTEGER,
          model_requests INTEGER NOT NULL CHECK (model_requests >= 0),
          reported_requests INTEGER NOT NULL CHECK (reported_requests >= 0),
          input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
          cached_input_tokens INTEGER NOT NULL CHECK (cached_input_tokens >= 0),
          cache_write_input_tokens INTEGER NOT NULL CHECK (cache_write_input_tokens >= 0),
          output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
          reasoning_output_tokens INTEGER NOT NULL CHECK (reasoning_output_tokens >= 0),
          total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
          source_bytes INTEGER NOT NULL CHECK (source_bytes >= 0),
          indexed_bytes INTEGER NOT NULL CHECK (indexed_bytes >= 0),
          source_mtime_ms REAL NOT NULL
        );
        CREATE INDEX threads_updated_idx
          ON threads(updated_at DESC, thread_id ASC);
        CREATE INDEX threads_status_updated_idx
          ON threads(status, updated_at DESC);
        CREATE INDEX threads_workspace_updated_idx
          ON threads(workspace_root, updated_at DESC);
        CREATE TABLE thread_search_items (
          thread_id TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK (sequence >= 0),
          timestamp TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (
            kind IN (
              'user_message', 'assistant_message', 'tool_result',
              'compaction', 'recovery', 'tool_failure',
              'turn_cancelled', 'turn_failed'
            )
          ),
          display_text TEXT NOT NULL,
          normalized_text TEXT NOT NULL,
          truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
          PRIMARY KEY (thread_id, sequence),
          FOREIGN KEY (thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
        );
        CREATE INDEX thread_search_items_thread_sequence_idx
          ON thread_search_items(thread_id, sequence DESC);
        CREATE TABLE thread_index_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          revision INTEGER NOT NULL CHECK (revision >= 0)
        );
        INSERT INTO thread_index_state (id, revision) VALUES (1, 0);
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    })
    .immediate();
}

async function describeLog(
  threadId: ThreadId,
  logFile: string,
  path: string,
): Promise<LogDescriptor> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Thread log must be a regular non-symlink file.");
  }
  return {
    threadId,
    logFile,
    path,
    sourceBytes: stats.size,
    sourceMtimeMs: stats.mtimeMs,
  };
}

function aggregateUsage(events: readonly AgentEvent[]): ThreadUsageSummary {
  const turns = new Map<TurnId, AgentEvent[]>();
  for (const event of events) {
    const group = turns.get(event.turnId);
    if (group === undefined) {
      turns.set(event.turnId, [event]);
    } else {
      group.push(event);
    }
  }
  const total = zeroUsage();
  for (const turnEvents of turns.values()) {
    const terminal = turnEvents.find(
      (event) =>
        event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.cancelled",
    );
    const terminalUsage =
      terminal?.type === "turn.completed" ||
      terminal?.type === "turn.failed" ||
      terminal?.type === "turn.cancelled"
        ? terminal.payload.usage
        : undefined;
    if (terminalUsage !== undefined) {
      addUsage(total, terminalUsage);
      continue;
    }
    for (const event of turnEvents) {
      if (event.type === "model.usage") {
        total.modelRequests += 1;
        total.reportedRequests += 1;
        addTokens(total.tokens, event.payload.usage);
      }
    }
  }
  return total;
}

function parseLocalThreadId(input: ThreadId | string): ThreadId {
  const value = String(input);
  if (!LOCAL_THREAD_ID_PATTERN.test(value)) {
    throw new RangeError(
      "Local thread ID must use 1-128 letters, digits, underscores, or hyphens.",
    );
  }
  return threadIdSchema.parse(value);
}

function zeroUsage(): ThreadUsageSummary {
  return {
    modelRequests: 0,
    reportedRequests: 0,
    tokens: {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    },
  };
}

function addUsage(target: ThreadUsageSummary, addition: TurnUsage): void {
  target.modelRequests += addition.modelRequests;
  target.reportedRequests += addition.reportedRequests;
  addTokens(target.tokens, addition.tokens);
}

function addTokens(target: TokenUsage, addition: TokenUsage): void {
  target.inputTokens += addition.inputTokens;
  target.cachedInputTokens += addition.cachedInputTokens;
  target.cacheWriteInputTokens += addition.cacheWriteInputTokens;
  target.outputTokens += addition.outputTokens;
  target.reasoningOutputTokens += addition.reasoningOutputTokens;
  target.totalTokens += addition.totalTokens;
}

function flatUsage(usage: ThreadUsageSummary) {
  return {
    model_requests: usage.modelRequests,
    reported_requests: usage.reportedRequests,
    input_tokens: usage.tokens.inputTokens,
    cached_input_tokens: usage.tokens.cachedInputTokens,
    cache_write_input_tokens: usage.tokens.cacheWriteInputTokens,
    output_tokens: usage.tokens.outputTokens,
    reasoning_output_tokens: usage.tokens.reasoningOutputTokens,
    total_tokens: usage.tokens.totalTokens,
  };
}

function toThreadMetadata(row: ThreadProjectionRow): ThreadMetadata {
  return {
    threadId: threadIdSchema.parse(row.thread_id),
    logFile: row.log_file,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_turn_id === null
      ? {}
      : { lastTurnId: turnIdSchema.parse(row.last_turn_id) }),
    ...(row.provider === null ? {} : { provider: row.provider }),
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.workspace_root === null
      ? {}
      : { workspaceRoot: row.workspace_root }),
    ...(row.approval_mode === null ? {} : { approvalMode: row.approval_mode }),
    turnCount: row.turn_count,
    eventCount: row.event_count,
    ...(row.last_sequence === null ? {} : { lastSequence: row.last_sequence }),
    usage: {
      modelRequests: row.model_requests,
      reportedRequests: row.reported_requests,
      tokens: {
        inputTokens: row.input_tokens,
        cachedInputTokens: row.cached_input_tokens,
        cacheWriteInputTokens: row.cache_write_input_tokens,
        outputTokens: row.output_tokens,
        reasoningOutputTokens: row.reasoning_output_tokens,
        totalTokens: row.total_tokens,
      },
    },
    sourceBytes: row.source_bytes,
    indexedBytes: row.indexed_bytes,
    sourceMtimeMs: row.source_mtime_ms,
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
  };
}

class ThreadMetadataCorruptionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ThreadMetadataCorruptionError";
  }
}

function isCorruptionError(error: unknown): boolean {
  return (
    error instanceof ThreadMetadataCorruptionError ||
    (error instanceof Error &&
      "code" in error &&
      ["SQLITE_CORRUPT", "SQLITE_NOTADB"].some((code) =>
        String((error as { code?: unknown }).code).startsWith(code),
      ))
  );
}

async function quarantineDatabase(
  databasePath: string,
  timestamp: string,
): Promise<string> {
  const safeTimestamp = timestamp.replace(/[^0-9A-Za-z_-]/gu, "-");
  const databaseBackup = `${databasePath}.corrupt-${safeTimestamp}-${randomUUID()}`;
  await rename(databasePath, databaseBackup);
  await renameIfExists(`${databasePath}-wal`, `${databaseBackup}-wal`);
  await renameIfExists(`${databasePath}-shm`, `${databaseBackup}-shm`);
  return databaseBackup;
}

async function renameIfExists(source: string, destination: string) {
  try {
    await rename(source, destination);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= MAX_DIAGNOSTIC_LENGTH
    ? message
    : `${message.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`;
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
