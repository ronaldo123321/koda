import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  PROCESS_LIST_DEFAULT_LIMIT,
  PROCESS_LIST_MAXIMUM_LIMIT,
  type InteractiveProcessSummary,
  type ProcessAcquireInputResult,
  type ProcessAttachResult,
  type ProcessInputResult,
  type ProcessListResult,
  type ProcessReadResult,
  type ProcessResizeResult,
  type ProcessTerminateResult,
} from "@koda/protocol";

import {
  NativeExecutorClient,
  NativeExecutorError,
  type NativeExecutorPtyStartInput,
  type NativeJobListResult,
  type NativeJobSnapshot,
  type NativeJobSummary,
  type NativePtyAttachment,
} from "./native-executor-client.js";

const NATIVE_LIST_PAGE_SIZE = 100;
const MAX_NATIVE_LIST_PAGES = 10;
const DEFAULT_LEASE_RENEWAL_MS = 5_000;
const TERMINAL_START_READY_TIMEOUT_MS = 5_000;

export type InteractiveProcessErrorCode =
  | "INTERACTIVE_PROCESSES_UNAVAILABLE"
  | "INVALID_PROCESS_WORKSPACE"
  | "PROCESS_NOT_FOUND"
  | "PROCESS_SESSION_NOT_FOUND"
  | "PROCESS_INPUT_READ_ONLY";

export class InteractiveProcessError extends Error {
  public constructor(
    public readonly code: InteractiveProcessErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InteractiveProcessError";
  }
}

export interface InteractiveProcessServiceOpenOptions {
  binaryPath: string;
  stateDirectory: string;
  socketPath?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  leaseRenewalMs?: number;
}

export interface InteractiveTerminalStartInput extends NativeExecutorPtyStartInput {
  displayName: string;
}

export interface InteractiveTerminalStartResult {
  job_id: string;
  display_name: string;
  cwd: string;
  state: NativeJobSnapshot["state"];
  lifecycle: "foreground" | "background";
  pid: number | null;
}

interface InteractiveProcessNativeClient {
  hello(): Promise<{
    capabilities: { pty: boolean; reattach: boolean };
  }>;
  startPty(input: NativeExecutorPtyStartInput): Promise<NativeJobSnapshot>;
  get(jobId: string): Promise<NativeJobSnapshot>;
  list(input?: {
    limit?: number;
    cursor?: string;
  }): Promise<NativeJobListResult>;
  openAttachment(jobId: string, cursor?: number): Promise<NativePtyAttachment>;
  terminate(
    jobId: string,
    reason: "cancellation" | "output_failure",
  ): Promise<NativeJobSnapshot>;
}

interface ProcessSession {
  id: string;
  workspace: string;
  job: InteractiveProcessSummary;
  attachment: NativePtyAttachment;
  inputState: "owned" | "read_only";
  rows: number;
  cols: number;
}

export class InteractiveProcessService {
  public readonly nativeExecutor: NativeExecutorClient;
  private readonly nativeClient: InteractiveProcessNativeClient;
  private readonly sessions = new Map<string, ProcessSession>();
  private readonly renewalTimer: NodeJS.Timeout;
  private renewalRunning = false;
  private closed = false;

  private constructor(
    nativeExecutor: NativeExecutorClient,
    nativeClient: InteractiveProcessNativeClient,
    leaseRenewalMs: number,
  ) {
    this.nativeExecutor = nativeExecutor;
    this.nativeClient = nativeClient;
    this.renewalTimer = setInterval(() => {
      void this.renewOwnedSessions();
    }, leaseRenewalMs);
    this.renewalTimer.unref();
  }

  public static async open(
    options: InteractiveProcessServiceOpenOptions,
  ): Promise<InteractiveProcessService> {
    const nativeExecutor = await NativeExecutorClient.open({
      binaryPath: options.binaryPath,
      stateDirectory: options.stateDirectory,
      ...(options.socketPath === undefined
        ? {}
        : { socketPath: options.socketPath }),
      ...(options.startupTimeoutMs === undefined
        ? {}
        : { startupTimeoutMs: options.startupTimeoutMs }),
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
    });
    const hello = await nativeExecutor.hello();
    if (!hello.capabilities.pty || !hello.capabilities.reattach) {
      throw new InteractiveProcessError(
        "INTERACTIVE_PROCESSES_UNAVAILABLE",
        "The configured native executor does not support durable PTY attachments.",
      );
    }
    return new InteractiveProcessService(
      nativeExecutor,
      nativeExecutor,
      options.leaseRenewalMs ?? DEFAULT_LEASE_RENEWAL_MS,
    );
  }

  public async startTerminal(
    input: InteractiveTerminalStartInput,
  ): Promise<InteractiveTerminalStartResult> {
    this.assertOpen();
    let snapshot = await this.nativeClient.startPty({
      ...input,
      displayName: input.displayName,
    });
    const readyDeadline = Date.now() + TERMINAL_START_READY_TIMEOUT_MS;
    while (isPreRunningState(snapshot.state) && Date.now() < readyDeadline) {
      await delay(20);
      snapshot = await this.nativeClient.get(snapshot.job_id);
    }
    if (isPreRunningState(snapshot.state)) {
      throw new NativeExecutorError(
        "NATIVE_EXECUTOR_START_FAILED",
        `Interactive process '${snapshot.job_id}' did not reach running state within ${TERMINAL_START_READY_TIMEOUT_MS} ms.`,
      );
    }
    return {
      job_id: snapshot.job_id,
      display_name: input.displayName,
      cwd: input.cwd,
      state: snapshot.state,
      lifecycle: input.lifecycle ?? "foreground",
      pid: snapshot.pid,
    };
  }

  public async listProcesses(input: {
    workspace: string;
    cursor?: string;
    limit?: number;
  }): Promise<ProcessListResult> {
    this.assertOpen();
    const workspace = await canonicalWorkspace(input.workspace);
    const limit = input.limit ?? PROCESS_LIST_DEFAULT_LIMIT;
    const matches: NativeJobSummary[] = [];
    let nativeCursor = input.cursor;
    let exhausted = false;

    for (let pageIndex = 0; pageIndex < MAX_NATIVE_LIST_PAGES; pageIndex += 1) {
      const page = await this.nativeClient.list({
        limit: NATIVE_LIST_PAGE_SIZE,
        ...(nativeCursor === undefined ? {} : { cursor: nativeCursor }),
      });
      for (const job of page.jobs) {
        if (job.io_mode === "pty" && isWithinWorkspace(workspace, job.cwd)) {
          matches.push(job);
          if (matches.length > limit) break;
        }
      }
      if (matches.length > limit) break;
      if (page.next_cursor === null) {
        exhausted = true;
        break;
      }
      nativeCursor = page.next_cursor;
    }

    const selected = matches.slice(0, limit);
    const hasMore = matches.length > limit || !exhausted;
    return {
      workspace,
      processes: selected.map(toProcessSummary),
      nextCursor:
        hasMore && selected.length > 0
          ? (selected.at(-1)?.job_id ?? null)
          : null,
    };
  }

  public async attach(input: {
    workspace: string;
    jobId: string;
    cursor?: number;
    rows: number;
    cols: number;
  }): Promise<ProcessAttachResult> {
    this.assertOpen();
    const workspace = await canonicalWorkspace(input.workspace);
    const job = await this.findAuthorizedJob(workspace, input.jobId);
    const requestedCursor = input.cursor ?? 0;
    const attachment = await this.nativeClient.openAttachment(
      input.jobId,
      requestedCursor,
    );
    try {
      const probe = await attachment.read(1);
      if (probe.status === "ok") {
        attachment.cursor = probe.cursor;
      }
      let inputState: "owned" | "read_only" = "read_only";
      try {
        await attachment.acquireInput();
        await attachment.resize(input.rows, input.cols);
        inputState = "owned";
      } catch (error) {
        if (!isReadOnlyLeaseError(error)) throw error;
      }
      const processSessionId = randomUUID();
      this.sessions.set(processSessionId, {
        id: processSessionId,
        workspace,
        job,
        attachment,
        inputState,
        rows: input.rows,
        cols: input.cols,
      });
      return {
        processSessionId,
        process: job,
        inputState,
        rows: input.rows,
        cols: input.cols,
        cursor: attachment.cursor,
        earliestCursor: probe.earliest_cursor,
        latestCursor: probe.latest_cursor,
        complete: probe.complete,
      };
    } catch (error) {
      await attachment.close().catch(() => false);
      throw error;
    }
  }

  public async read(
    processSessionId: string,
    maxBytes?: number,
  ): Promise<ProcessReadResult> {
    const session = this.requireSession(processSessionId);
    const result = await session.attachment.read(maxBytes);
    if (result.status === "cursor_expired") {
      return {
        status: result.status,
        processSessionId,
        inputState: session.inputState,
        cursor: result.cursor,
        earliestCursor: result.earliest_cursor,
        latestCursor: result.latest_cursor,
        complete: result.complete,
      };
    }
    return {
      status: result.status,
      processSessionId,
      inputState: session.inputState,
      cursor: result.cursor,
      nextCursor: result.next_cursor,
      earliestCursor: result.earliest_cursor,
      latestCursor: result.latest_cursor,
      complete: result.complete,
      dataBase64: result.data.toString("base64"),
    };
  }

  public async acquireInput(
    processSessionId: string,
  ): Promise<ProcessAcquireInputResult> {
    const session = this.requireSession(processSessionId);
    if (session.inputState === "owned") {
      return { processSessionId, inputState: session.inputState };
    }
    try {
      await session.attachment.acquireInput();
      await session.attachment.resize(session.rows, session.cols);
      session.inputState = "owned";
    } catch (error) {
      if (!isReadOnlyLeaseError(error)) throw error;
    }
    return { processSessionId, inputState: session.inputState };
  }

  public async writeInput(
    processSessionId: string,
    input: Uint8Array,
  ): Promise<ProcessInputResult> {
    const session = this.requireOwnedSession(processSessionId);
    try {
      return {
        processSessionId,
        acceptedBytes: await session.attachment.write(input),
      };
    } catch (error) {
      this.downgradeExpiredLease(session, error);
      throw error;
    }
  }

  public async resize(
    processSessionId: string,
    rows: number,
    cols: number,
  ): Promise<ProcessResizeResult> {
    const session = this.requireOwnedSession(processSessionId);
    try {
      const resized = await session.attachment.resize(rows, cols);
      session.rows = resized.rows;
      session.cols = resized.cols;
      return { processSessionId, ...resized };
    } catch (error) {
      this.downgradeExpiredLease(session, error);
      throw error;
    }
  }

  public async detach(processSessionId: string): Promise<void> {
    const session = this.requireSession(processSessionId);
    this.sessions.delete(processSessionId);
    await session.attachment.close();
  }

  public async terminate(input: {
    workspace: string;
    jobId: string;
  }): Promise<ProcessTerminateResult> {
    this.assertOpen();
    const workspace = await canonicalWorkspace(input.workspace);
    const existing = await this.findAuthorizedJob(workspace, input.jobId);
    const snapshot = await this.nativeClient.terminate(
      input.jobId,
      "cancellation",
    );
    return {
      process: {
        ...existing,
        state: snapshot.state,
        updatedAtMs: Date.now(),
        pid: snapshot.pid,
      },
    };
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.renewalTimer);
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(
      sessions.map(async (session) => session.attachment.close()),
    );
  }

  private async findAuthorizedJob(
    workspace: string,
    jobId: string,
  ): Promise<InteractiveProcessSummary> {
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_NATIVE_LIST_PAGES; pageIndex += 1) {
      const page = await this.nativeClient.list({
        limit: NATIVE_LIST_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const job = page.jobs.find((candidate) => candidate.job_id === jobId);
      if (job !== undefined) {
        if (job.io_mode === "pty" && isWithinWorkspace(workspace, job.cwd)) {
          return toProcessSummary(job);
        }
        break;
      }
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    throw new InteractiveProcessError(
      "PROCESS_NOT_FOUND",
      `Interactive process '${jobId}' was not found in this workspace.`,
    );
  }

  private requireSession(processSessionId: string): ProcessSession {
    this.assertOpen();
    const session = this.sessions.get(processSessionId);
    if (session === undefined) {
      throw new InteractiveProcessError(
        "PROCESS_SESSION_NOT_FOUND",
        "The interactive process session is missing or no longer attached.",
      );
    }
    return session;
  }

  private requireOwnedSession(processSessionId: string): ProcessSession {
    const session = this.requireSession(processSessionId);
    if (session.inputState !== "owned") {
      throw new InteractiveProcessError(
        "PROCESS_INPUT_READ_ONLY",
        "This interactive process session does not own input.",
      );
    }
    return session;
  }

  private async renewOwnedSessions(): Promise<void> {
    if (this.closed || this.renewalRunning) return;
    this.renewalRunning = true;
    try {
      await Promise.all(
        [...this.sessions.values()].map(async (session) => {
          if (session.inputState !== "owned") return;
          try {
            await session.attachment.renewInput();
          } catch {
            session.inputState = "read_only";
          }
        }),
      );
    } finally {
      this.renewalRunning = false;
    }
  }

  private downgradeExpiredLease(session: ProcessSession, error: unknown): void {
    if (
      error instanceof NativeExecutorError &&
      ["INPUT_LEASE_EXPIRED", "STALE_INPUT_FENCE"].includes(error.code)
    ) {
      session.inputState = "read_only";
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new InteractiveProcessError(
        "INTERACTIVE_PROCESSES_UNAVAILABLE",
        "Interactive process service is closed.",
      );
    }
  }
}

function toProcessSummary(job: NativeJobSummary): InteractiveProcessSummary {
  return {
    jobId: job.job_id,
    displayName: job.display_name ?? `Terminal ${job.job_id.slice(0, 8)}`,
    cwd: job.cwd,
    state: job.state,
    lifecycle: job.lifecycle,
    createdAtMs: job.created_at_ms,
    updatedAtMs: job.updated_at_ms,
    pid: job.pid,
  };
}

async function canonicalWorkspace(input: string): Promise<string> {
  try {
    const canonical = await realpath(resolve(input));
    if (!(await stat(canonical)).isDirectory())
      throw new Error("not a directory");
    return canonical;
  } catch (error) {
    throw new InteractiveProcessError(
      "INVALID_PROCESS_WORKSPACE",
      `Interactive process workspace is invalid: ${input}`,
      { cause: error },
    );
  }
}

function isWithinWorkspace(workspace: string, candidate: string): boolean {
  if (!isAbsolute(candidate)) return false;
  const workspaceRelative = relative(workspace, candidate);
  return (
    workspaceRelative === "" ||
    (workspaceRelative !== ".." &&
      !workspaceRelative.startsWith(`..${sep}`) &&
      !isAbsolute(workspaceRelative))
  );
}

function isReadOnlyLeaseError(error: unknown): boolean {
  return (
    error instanceof NativeExecutorError &&
    [
      "INPUT_LEASE_HELD",
      "INPUT_LEASE_EXPIRED",
      "STALE_INPUT_FENCE",
      "JOB_TERMINAL",
    ].includes(error.code)
  );
}

function isPreRunningState(state: NativeJobSnapshot["state"]): boolean {
  return ["accepted", "worker_ready", "command_starting", "starting"].includes(
    state,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    timer.unref();
  });
}
