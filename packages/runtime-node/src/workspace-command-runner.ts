import { spawn } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";

import type { ArtifactReference } from "@koda/protocol";

import {
  ArtifactStore,
  type MaterializedTextOutput,
  type TextArtifactCapture,
} from "./artifact-store.js";

export type CommandErrorCode =
  | "INVALID_COMMAND"
  | "INVALID_COMMAND_CWD"
  | "COMMAND_CWD_CHANGED"
  | "COMMAND_NOT_FOUND"
  | "COMMAND_START_FAILED";

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
}

export interface PreparedWorkspaceCommand {
  argv: string[];
  cwd: string;
  timeoutMs: number;
  title: string;
  summary: string;
  preview: string;
  execute(signal: AbortSignal): Promise<ExecCommandResult>;
}

export interface WorkspaceCommandRunnerOptions {
  environment?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  artifactStore?: ArtifactStore;
  terminationGraceMs?: number;
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
    assertIntegerInRange(maxOutputBytes, 1, 1_000_000, "maxOutputBytes");
    assertIntegerInRange(terminationGraceMs, 0, 10_000, "terminationGraceMs");
    return new WorkspaceCommandRunner(
      canonicalRoot,
      filterEnvironment(options.environment ?? process.env),
      maxOutputBytes,
      terminationGraceMs,
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
      execute: async (signal) => {
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
          timeoutMs,
          signal,
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
  timeoutMs: number;
  signal: AbortSignal;
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
  const stdoutFinished = pipeToCapture(stdoutStream, stdout);
  const stderrFinished = pipeToCapture(stderrStream, stderr);

  return new Promise<ExecCommandResult>((resolvePromise, rejectPromise) => {
    let aborted = false;
    let settled = false;
    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const signalChild = (signal: NodeJS.Signals): void => {
      try {
        if (useProcessGroup && child.pid !== undefined) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch (error) {
        if (!isNodeError(error, "ESRCH")) {
          try {
            child.kill(signal);
          } catch {
            // The child may have exited between the close check and signal.
          }
        }
      }
    };

    const requestTermination = (): void => {
      signalChild("SIGTERM");
      killTimer ??= setTimeout(() => {
        signalChild("SIGKILL");
      }, options.terminationGraceMs);
      killTimer.unref();
    };

    void stdoutFinished.catch(() => requestTermination());
    void stderrFinished.catch(() => requestTermination());

    const onAbort = (): void => {
      aborted = true;
      requestTermination();
    };

    const cleanup = (): void => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      options.signal.removeEventListener("abort", onAbort);
    };

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      void Promise.allSettled([stdoutFinished, stderrFinished]).then(
        async () => {
          await Promise.all([stdout.abort(), stderr.abort()]);
          if (aborted || options.signal.aborted) {
            rejectPromise(abortError(options.signal.reason));
            return;
          }
          rejectPromise(
            new CommandError(
              isNodeError(error, "ENOENT")
                ? "COMMAND_NOT_FOUND"
                : "COMMAND_START_FAILED",
              isNodeError(error, "ENOENT")
                ? `Command executable was not found: ${executable}`
                : `Command could not start: ${error.message}`,
              { cause: error },
            ),
          );
        },
      );
    });
    child.once("close", (exitCode, exitSignal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (aborted || options.signal.aborted) {
        void Promise.all([stdout.abort(), stderr.abort()]).finally(() => {
          rejectPromise(abortError(options.signal.reason));
        });
        return;
      }
      void (async () => {
        await Promise.all([stdoutFinished, stderrFinished]);
        const [stdoutResult, stderrResult] = await Promise.all([
          stdout.finish(),
          stderr.finish(),
        ]);
        resolvePromise({
          argv: [...options.argv],
          cwd: options.workspacePath,
          exit_code: exitCode,
          signal: exitSignal,
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
        });
      })().catch(async (error: unknown) => {
        await Promise.all([stdout.abort(), stderr.abort()]);
        rejectPromise(error);
      });
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, options.timeoutMs);
    timeoutTimer.unref();
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) {
      onAbort();
    }
  });
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

function pipeToCapture(
  stream: NodeJS.ReadableStream,
  capture: OutputCapture | TextArtifactCapture,
): Promise<void> {
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      void capture.append(chunk).then(
        () => callback(),
        (error: unknown) => callback(error as Error),
      );
    },
  });
  stream.pipe(sink);
  return finished(sink);
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
