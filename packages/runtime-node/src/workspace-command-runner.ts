import { spawn } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";

import type { ToolOperationalEvent } from "@koda/agent-core";
import type { ArtifactReference } from "@koda/protocol";

import {
  ArtifactStore,
  type MaterializedTextOutput,
  type TextArtifactCapture,
} from "./artifact-store.js";
import {
  OwnedProcessTree,
  type ProcessTerminationReport,
} from "./process-tree-controller.js";

export type CommandErrorCode =
  | "INVALID_COMMAND"
  | "INVALID_COMMAND_CWD"
  | "COMMAND_CWD_CHANGED"
  | "COMMAND_NOT_FOUND"
  | "COMMAND_START_FAILED"
  | "PROCESS_TERMINATION_UNCERTAIN";

export class CommandError extends Error {
  public constructor(
    public readonly code: CommandErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CommandError";
  }
}

export interface WorkspaceCommandOptions {
  argv: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface ExecCommandResult {
  argv: string[];
  cwd: string;
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  stdout_artifact?: ArtifactReference;
  stderr_artifact?: ArtifactReference;
  timed_out: boolean;
  duration_ms: number;
  termination?: ProcessTerminationReport;
}

export interface PreparedWorkspaceCommand {
  argv: string[];
  cwd: string;
  timeoutMs: number;
  title: string;
  summary: string;
  preview: string;
  execute(
    signal: AbortSignal,
    report?: (event: ToolOperationalEvent) => Promise<void>,
  ): Promise<ExecCommandResult>;
}

export interface WorkspaceCommandRunnerOptions {
  environment?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  artifactStore?: ArtifactStore;
  terminationGraceMs?: number;
  terminationConfirmationMs?: number;
}

interface WorkingDirectorySnapshot {
  absolutePath: string;
  workspacePath: string;
  device: number;
  inode: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 65_536;
const DEFAULT_TERMINATION_GRACE_MS = 500;
const DEFAULT_TERMINATION_CONFIRMATION_MS = 2_000;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 4_096;
const MAX_TOTAL_ARGUMENT_BYTES = 32_768;
const MAX_CWD_BYTES = 4_096;

const ALLOWED_ENVIRONMENT_NAMES = new Set([
  "COLORTERM",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LANGUAGE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
]);

const FORBIDDEN_DIRECT_EXECUTABLES = new Set([
  "bash",
  "cmd",
  "cmd.exe",
  "csh",
  "dash",
  "fish",
  "ksh",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "tcsh",
  "zsh",
]);

export class WorkspaceCommandRunner {
  private constructor(
    public readonly root: string,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly maxOutputBytes: number,
    private readonly terminationGraceMs: number,
    private readonly terminationConfirmationMs: number,
    private readonly artifactStore?: ArtifactStore,
  ) {}

  public static async open(
    root: string,
    options: WorkspaceCommandRunnerOptions = {},
  ): Promise<WorkspaceCommandRunner> {
    const canonicalRoot = await realpath(resolve(root));
    const rootStats = await stat(canonicalRoot);
    if (!rootStats.isDirectory()) {
      throw new CommandError(
        "INVALID_COMMAND_CWD",
        `Command workspace root is not a directory: ${root}`,
      );
    }
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const terminationGraceMs =
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    const terminationConfirmationMs =
      options.terminationConfirmationMs ?? DEFAULT_TERMINATION_CONFIRMATION_MS;
    assertIntegerInRange(maxOutputBytes, 1, 1_000_000, "maxOutputBytes");
    assertIntegerInRange(terminationGraceMs, 0, 10_000, "terminationGraceMs");
    assertIntegerInRange(
      terminationConfirmationMs,
      100,
      30_000,
      "terminationConfirmationMs",
    );
    return new WorkspaceCommandRunner(
      canonicalRoot,
      filterEnvironment(options.environment ?? process.env),
      maxOutputBytes,
      terminationGraceMs,
      terminationConfirmationMs,
      options.artifactStore,
    );
  }

  public async prepare(
    options: WorkspaceCommandOptions,
  ): Promise<PreparedWorkspaceCommand> {
    const argv = validateArguments(options.argv);
    const requestedCwd = options.cwd ?? ".";
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    assertIntegerInRange(
      timeoutMs,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      "timeout_ms",
    );
    const cwd = await this.resolveWorkingDirectory(requestedCwd);
    const displayName = basename(argv[0] ?? "command") || argv[0];
    let executed = false;

    return {
      argv: [...argv],
      cwd: cwd.workspacePath,
      timeoutMs,
      title: `Run ${JSON.stringify(displayName)}`,
      summary: `Run a foreground command in ${JSON.stringify(cwd.workspacePath)}.`,
      preview: [
        `cwd: ${JSON.stringify(cwd.workspacePath)}`,
        `timeout: ${timeoutMs} ms`,
        `argv: ${JSON.stringify(argv)}`,
      ].join("\n"),
      execute: async (signal, report) => {
        if (executed) {
          throw new CommandError(
            "INVALID_COMMAND",
            "A prepared command can execute only once.",
          );
        }
        executed = true;
        signal.throwIfAborted();
        await this.revalidateWorkingDirectory(requestedCwd, cwd);
        return runForegroundCommand({
          argv,
          cwd: cwd.absolutePath,
          workspacePath: cwd.workspacePath,
          environment: this.environment,
          maxOutputBytes: this.maxOutputBytes,
          ...(this.artifactStore === undefined
            ? {}
            : { artifactStore: this.artifactStore }),
          terminationGraceMs: this.terminationGraceMs,
          terminationConfirmationMs: this.terminationConfirmationMs,
          timeoutMs,
          signal,
          ...(report === undefined ? {} : { report }),
        });
      },
    };
  }

  private async resolveWorkingDirectory(
    requestedPath: string,
  ): Promise<WorkingDirectorySnapshot> {
    if (
      requestedPath.length === 0 ||
      requestedPath.includes("\0") ||
      Buffer.byteLength(requestedPath, "utf8") > MAX_CWD_BYTES
    ) {
      throw new CommandError(
        "INVALID_COMMAND_CWD",
        "Command cwd must be a non-empty workspace-relative path of at most 4096 bytes without null bytes.",
      );
    }
    if (isAbsolute(requestedPath)) {
      throw new CommandError(
        "INVALID_COMMAND_CWD",
        `Absolute command working directories are not allowed: ${requestedPath}`,
      );
    }

    const lexicalTarget = resolve(this.root, requestedPath);
    const workspaceRelative = relative(this.root, lexicalTarget);
    if (
      workspaceRelative === ".." ||
      workspaceRelative.startsWith(`..${sep}`) ||
      isAbsolute(workspaceRelative)
    ) {
      throw new CommandError(
        "INVALID_COMMAND_CWD",
        `Command working directory escapes the workspace: ${requestedPath}`,
      );
    }

    try {
      let current = this.root;
      for (const segment of workspaceRelative.split(sep).filter(Boolean)) {
        current = join(current, segment);
        const entry = await lstat(current);
        if (entry.isSymbolicLink()) {
          throw new CommandError(
            "INVALID_COMMAND_CWD",
            `Command working directories cannot traverse symlinks: ${requestedPath}`,
          );
        }
      }
      const canonicalTarget = await realpath(lexicalTarget);
      const canonicalRelative = relative(this.root, canonicalTarget);
      if (
        canonicalRelative === ".." ||
        canonicalRelative.startsWith(`..${sep}`) ||
        isAbsolute(canonicalRelative)
      ) {
        throw new CommandError(
          "INVALID_COMMAND_CWD",
          `Command working directory escapes the workspace: ${requestedPath}`,
        );
      }
      const targetStats = await stat(canonicalTarget);
      if (!targetStats.isDirectory()) {
        throw new CommandError(
          "INVALID_COMMAND_CWD",
          `Command working directory is not a directory: ${requestedPath}`,
        );
      }
      return {
        absolutePath: canonicalTarget,
        workspacePath: toPortablePath(canonicalRelative) || ".",
        device: targetStats.dev,
        inode: targetStats.ino,
      };
    } catch (error) {
      if (error instanceof CommandError) {
        throw error;
      }
      throw new CommandError(
        "INVALID_COMMAND_CWD",
        `Command working directory does not exist or cannot be accessed: ${requestedPath}`,
        { cause: error },
      );
    }
  }

  private async revalidateWorkingDirectory(
    requestedPath: string,
    prepared: WorkingDirectorySnapshot,
  ): Promise<void> {
    let current: WorkingDirectorySnapshot;
    try {
      current = await this.resolveWorkingDirectory(requestedPath);
    } catch (error) {
      throw new CommandError(
        "COMMAND_CWD_CHANGED",
        `Command working directory changed after approval: ${requestedPath}`,
        { cause: error },
      );
    }
    if (
      current.absolutePath !== prepared.absolutePath ||
      current.device !== prepared.device ||
      current.inode !== prepared.inode
    ) {
      throw new CommandError(
        "COMMAND_CWD_CHANGED",
        `Command working directory changed after approval: ${requestedPath}`,
      );
    }
  }
}

interface RunForegroundCommandOptions {
  argv: string[];
  cwd: string;
  workspacePath: string;
  environment: NodeJS.ProcessEnv;
  maxOutputBytes: number;
  artifactStore?: ArtifactStore;
  terminationGraceMs: number;
  terminationConfirmationMs: number;
  timeoutMs: number;
  signal: AbortSignal;
  report?: (event: ToolOperationalEvent) => Promise<void>;
}

async function runForegroundCommand(
  options: RunForegroundCommandOptions,
): Promise<ExecCommandResult> {
  options.signal.throwIfAborted();
  const executable = options.argv[0];
  if (executable === undefined) {
    throw new CommandError("INVALID_COMMAND", "Command argv is empty.");
  }
  const startedAt = Date.now();
  const stdout = await createOutputCapture(
    options.artifactStore,
    options.maxOutputBytes,
  );
  const stderr = await createOutputCapture(
    options.artifactStore,
    options.maxOutputBytes,
  );
  const useProcessGroup = process.platform !== "win32";
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(executable, options.argv.slice(1), {
      cwd: options.cwd,
      detached: useProcessGroup,
      env: options.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    await Promise.all([stdout.abort(), stderr.abort()]);
    throw new CommandError(
      "COMMAND_START_FAILED",
      `Command could not start: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  if (stdoutStream === null || stderrStream === null) {
    child.kill();
    await Promise.all([stdout.abort(), stderr.abort()]);
    throw new CommandError(
      "COMMAND_START_FAILED",
      "Command output streams were not created.",
    );
  }
  const rawExit = new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolvePromise) => {
    child.once("exit", (exitCode, signal) =>
      resolvePromise({ exitCode, signal }),
    );
  });
  const closed = new Promise<void>((resolvePromise) => {
    child.once("close", () => resolvePromise());
  });
  let spawnError: Error | undefined;
  const spawned = new Promise<void>((resolvePromise, rejectPromise) => {
    child.once("spawn", resolvePromise);
    child.once("error", (error) => {
      spawnError = error;
      rejectPromise(error);
    });
  });
  try {
    await spawned;
  } catch (error) {
    await Promise.all([stdout.abort(), stderr.abort()]);
    throw new CommandError(
      isNodeError(error, "ENOENT")
        ? "COMMAND_NOT_FOUND"
        : "COMMAND_START_FAILED",
      isNodeError(error, "ENOENT")
        ? `Command executable was not found: ${executable}`
        : `Command could not start: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const pid = child.pid;
  if (pid === undefined || pid < 1) {
    child.kill();
    await Promise.all([stdout.abort(), stderr.abort()]);
    throw new CommandError(
      "COMMAND_START_FAILED",
      "Command started without a valid process ID.",
    );
  }
  const ownedProcess = new OwnedProcessTree({
    child,
    pid,
    terminationGraceMs: options.terminationGraceMs,
    terminationConfirmationMs: options.terminationConfirmationMs,
    ...(options.report === undefined ? {} : { report: options.report }),
  });
  try {
    await options.report?.({
      type: "process.started",
      payload: { pid, ownership: ownedProcess.ownership },
    });
  } catch (error) {
    await ownedProcess.terminate("output_failure").catch(() => undefined);
    stdoutStream.destroy();
    stderrStream.destroy();
    await Promise.all([stdout.abort(), stderr.abort()]);
    throw error;
  }

  const exited = rawExit.then(async (outcome) => {
    await options.report?.({
      type: "process.exited",
      payload: {
        pid,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
      },
    });
    return outcome;
  });
  const stdoutPipe = pipeToCapture(stdoutStream, stdout);
  const stderrPipe = pipeToCapture(stderrStream, stderr);
  const stdoutFinished = stdoutPipe.finished;
  const stderrFinished = stderrPipe.finished;
  let triggerTermination:
    ((interruption: CommandInterruption) => void) | undefined;
  const interrupted = new Promise<CommandInterruption>((resolvePromise) => {
    triggerTermination = resolvePromise;
  });
  void stdoutFinished.catch((error: unknown) =>
    triggerTermination?.({ reason: "output_failure", error }),
  );
  void stderrFinished.catch((error: unknown) =>
    triggerTermination?.({ reason: "output_failure", error }),
  );
  const timeoutTimer = setTimeout(
    () => triggerTermination?.({ reason: "timeout" }),
    options.timeoutMs,
  );
  timeoutTimer.unref();
  const onAbort = () =>
    triggerTermination?.({
      reason: "cancellation",
      error: options.signal.reason,
    });
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) {
    onAbort();
  }

  let termination: ProcessTerminationReport | undefined;
  let timedOut = false;
  try {
    const first = await Promise.race([
      exited.then((outcome) => ({ type: "exit" as const, outcome })),
      interrupted.then((interruption) => ({
        type: "interruption" as const,
        interruption,
      })),
    ]);
    let outcome: Awaited<typeof exited>;
    if (first.type === "exit") {
      outcome = first.outcome;
      if (spawnError !== undefined) {
        throw new CommandError(
          "COMMAND_START_FAILED",
          `Command failed after spawn: ${spawnError.message}`,
          { cause: spawnError },
        );
      }
      if (ownedProcess.isAlive()) {
        termination = await ownedProcess.terminate("orphan_cleanup");
        assertTerminationConfirmed(termination, pid);
      }
    } else {
      timedOut = first.interruption.reason === "timeout";
      termination = await ownedProcess.terminate(first.interruption.reason);
      assertTerminationConfirmed(termination, pid);
      outcome = await exited;

      if (first.interruption.reason === "cancellation") {
        await Promise.allSettled([stdoutFinished, stderrFinished]);
        await Promise.all([stdout.abort(), stderr.abort()]);
        throw abortError(first.interruption.error);
      }
      if (first.interruption.reason === "output_failure") {
        await Promise.allSettled([stdoutFinished, stderrFinished]);
        await Promise.all([stdout.abort(), stderr.abort()]);
        throw first.interruption.error instanceof Error
          ? first.interruption.error
          : new Error(String(first.interruption.error));
      }
    }

    await closed;
    await Promise.all([stdoutFinished, stderrFinished]);
    const [stdoutResult, stderrResult] = await Promise.all([
      stdout.finish(),
      stderr.finish(),
    ]);
    return {
      argv: [...options.argv],
      cwd: options.workspacePath,
      exit_code: outcome.exitCode,
      signal: outcome.signal,
      stdout: stdoutResult.text,
      stderr: stderrResult.text,
      stdout_bytes: stdoutResult.totalBytes,
      stderr_bytes: stderrResult.totalBytes,
      stdout_truncated: stdoutResult.truncated,
      stderr_truncated: stderrResult.truncated,
      ...(stdoutResult.artifact === undefined
        ? {}
        : { stdout_artifact: stdoutResult.artifact }),
      ...(stderrResult.artifact === undefined
        ? {}
        : { stderr_artifact: stderrResult.artifact }),
      timed_out: timedOut,
      duration_ms: Math.max(0, Date.now() - startedAt),
      ...(termination === undefined ? {} : { termination }),
    };
  } catch (error) {
    let failure = error;
    if (ownedProcess.isAlive()) {
      try {
        const cleanup = await ownedProcess.terminate("output_failure");
        assertTerminationConfirmed(cleanup, pid);
      } catch (cleanupError) {
        if (ownedProcess.isAlive()) {
          failure =
            cleanupError instanceof CommandError &&
            cleanupError.code === "PROCESS_TERMINATION_UNCERTAIN"
              ? cleanupError
              : new CommandError(
                  "PROCESS_TERMINATION_UNCERTAIN",
                  `Koda could not confirm that process tree ${pid} terminated after a command failure.`,
                  { cause: cleanupError },
                );
        }
      }
    }
    if (
      failure instanceof CommandError &&
      failure.code === "PROCESS_TERMINATION_UNCERTAIN"
    ) {
      stdoutPipe.stop();
      stderrPipe.stop();
      stdoutStream.destroy();
      stderrStream.destroy();
    }
    await Promise.allSettled([stdoutFinished, stderrFinished]);
    await Promise.all([stdout.abort(), stderr.abort()]);
    throw failure;
  } finally {
    clearTimeout(timeoutTimer);
    options.signal.removeEventListener("abort", onAbort);
  }
}

interface CommandInterruption {
  reason: "timeout" | "cancellation" | "output_failure";
  error?: unknown;
}

function assertTerminationConfirmed(
  report: ProcessTerminationReport,
  pid: number,
): void {
  if (report.outcome === "uncertain") {
    throw new CommandError(
      "PROCESS_TERMINATION_UNCERTAIN",
      `Koda could not confirm that process tree ${pid} terminated.`,
    );
  }
}

interface OutputCapture {
  append(chunk: Buffer | string): Promise<void>;
  finish(): Promise<MaterializedTextOutput>;
  abort(): Promise<void>;
}

class BoundedOutput implements OutputCapture {
  private readonly chunks: Buffer[] = [];
  private retainedBytes = 0;
  private totalBytes = 0;

  public constructor(private readonly maxBytes: number) {}

  public async append(chunk: Buffer | string): Promise<void> {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.totalBytes += bytes.byteLength;
    const available = this.maxBytes - this.retainedBytes;
    if (available <= 0) {
      return;
    }
    const retained = bytes.subarray(0, available);
    this.chunks.push(retained);
    this.retainedBytes += retained.byteLength;
  }

  public async finish(): Promise<MaterializedTextOutput> {
    return {
      text: Buffer.concat(this.chunks, this.retainedBytes).toString("utf8"),
      totalBytes: this.totalBytes,
      truncated: this.totalBytes > this.retainedBytes,
    };
  }

  public async abort(): Promise<void> {}
}

async function createOutputCapture(
  artifactStore: ArtifactStore | undefined,
  maxOutputBytes: number,
): Promise<OutputCapture> {
  return artifactStore === undefined
    ? new BoundedOutput(maxOutputBytes)
    : artifactStore.createTextCapture({ inlineBytes: maxOutputBytes });
}

interface OutputPipe {
  finished: Promise<void>;
  stop(): void;
}

function pipeToCapture(
  stream: NodeJS.ReadableStream,
  capture: OutputCapture | TextArtifactCapture,
): OutputPipe {
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      void capture.append(chunk).then(
        () => callback(),
        (error: unknown) => callback(error as Error),
      );
    },
  });
  stream.pipe(sink);
  return {
    finished: finished(sink),
    stop: () => {
      stream.unpipe(sink);
      if (!sink.destroyed && !sink.writableEnded) {
        sink.end();
      }
    },
  };
}

function validateArguments(input: readonly string[]): string[] {
  if (
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > MAX_ARGUMENTS
  ) {
    throw new CommandError(
      "INVALID_COMMAND",
      `Command argv must contain between 1 and ${MAX_ARGUMENTS} entries.`,
    );
  }
  let totalBytes = 0;
  const argv = input.map((argument, index) => {
    if (typeof argument !== "string" || argument.includes("\0")) {
      throw new CommandError(
        "INVALID_COMMAND",
        `Command argv[${index}] must be a string without null bytes.`,
      );
    }
    const bytes = Buffer.byteLength(argument, "utf8");
    if (bytes > MAX_ARGUMENT_BYTES) {
      throw new CommandError(
        "INVALID_COMMAND",
        `Command argv[${index}] exceeds the ${MAX_ARGUMENT_BYTES}-byte limit.`,
      );
    }
    totalBytes += bytes;
    return argument;
  });
  if ((argv[0] ?? "").trim().length === 0) {
    throw new CommandError(
      "INVALID_COMMAND",
      "Command executable must not be empty.",
    );
  }
  const executableName = basename(argv[0] ?? "").toLowerCase();
  if (FORBIDDEN_DIRECT_EXECUTABLES.has(executableName)) {
    throw new CommandError(
      "INVALID_COMMAND",
      `Direct shell execution is not supported in this phase: ${argv[0]}`,
    );
  }
  if (totalBytes > MAX_TOTAL_ARGUMENT_BYTES) {
    throw new CommandError(
      "INVALID_COMMAND",
      `Command argv exceeds the ${MAX_TOTAL_ARGUMENT_BYTES}-byte total limit.`,
    );
  }
  return argv;
}

function filterEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || value.includes("\0")) {
      continue;
    }
    const normalizedName = name.toUpperCase();
    if (
      ALLOWED_ENVIRONMENT_NAMES.has(normalizedName) ||
      normalizedName.startsWith("LC_")
    ) {
      filtered[name] = value;
    }
  }
  return filtered;
}

function assertIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new CommandError(
      "INVALID_COMMAND",
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
}

function toPortablePath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function abortError(reason: unknown): Error {
  const error = new Error(
    typeof reason === "string" && reason.length > 0
      ? reason
      : "Command execution was cancelled.",
  );
  error.name = "AbortError";
  return error;
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
