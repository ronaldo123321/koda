import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import {
  threadIdSchema,
  turnIdSchema,
  type AgentEvent,
  type ThreadId,
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

const SCHEMA_VERSION = 1;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const MAX_DIAGNOSTIC_LENGTH = 1_000;
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
    const projections: ThreadProjectionRow[] = [];
    let skipped = 0;

    for (const descriptor of descriptors) {
      const existing = fingerprints.get(descriptor.threadId);
      if (
        existing !== undefined &&
        existing.source_bytes === descriptor.sourceBytes &&
        existing.source_mtime_ms === descriptor.sourceMtimeMs
      ) {
        await this.refreshLeaseStatus(descriptor, existing);
        skipped += 1;
        continue;
      }
      const projection = await this.project(descriptor);
      projections.push(projection);
      if (projection.status === "invalid") {
        diagnostics.push({
          logFile: descriptor.logFile,
          message: projection.error_message ?? "Thread log is invalid.",
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
          this.upsert(projection);
        }
        const remove = this.database.prepare(
          "DELETE FROM threads WHERE thread_id = ?",
        );
        for (const threadId of missingThreadIds) {
          remove.run(threadId);
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
    const projections: ThreadProjectionRow[] = [];
    for (const descriptor of descriptors) {
      const projection = await this.project(descriptor);
      projections.push(projection);
      if (projection.status === "invalid") {
        diagnostics.push({
          logFile: descriptor.logFile,
          message: projection.error_message ?? "Thread log is invalid.",
        });
      }
    }
    this.database
      .transaction(() => {
        this.database.exec("DELETE FROM threads");
        for (const projection of projections) {
          this.upsert(projection);
        }
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
        const removed = this.database
          .prepare("DELETE FROM threads WHERE thread_id = ?")
          .run(threadId).changes;
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
    this.database.transaction(() => this.upsert(projection)).immediate();
    return {
      indexed: 1,
      skipped: 0,
      removed: 0,
      diagnostics:
        projection.status === "invalid"
          ? [
              {
                logFile,
                message: projection.error_message ?? "Thread log is invalid.",
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
  ): Promise<void> {
    if (existing.status !== "running" && existing.status !== "interrupted") {
      return;
    }
    const active = await ThreadLease.isActive(descriptor.path);
    const status: ThreadMetadataStatus = active ? "running" : "interrupted";
    if (status !== existing.status) {
      this.database
        .prepare("UPDATE threads SET status = ? WHERE thread_id = ?")
        .run(status, descriptor.threadId);
    }
  }

  private async project(
    descriptor: LogDescriptor,
  ): Promise<ThreadProjectionRow> {
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
      };
    } catch (error) {
      if (
        active &&
        readResult !== undefined &&
        error instanceof ThreadRecoveryError &&
        error.code === "THREAD_CONTEXT_MISSING"
      ) {
        return projectActivePrefix(descriptor, readResult);
      }
      const timestamp = new Date(descriptor.sourceMtimeMs).toISOString();
      return {
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
      };
    }
  }

  private upsert(row: ThreadProjectionRow): void {
    this.database.prepare<ThreadProjectionRow>(UPSERT_THREAD_SQL).run(row);
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
