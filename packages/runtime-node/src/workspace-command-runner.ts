import { spawn } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";

import type { ToolOperationalEvent } from "@koda/agent-core";
import type {
  ArtifactReference,
  ExecutionCapabilities,
  ExecutionPolicy,
  ExecutionSecuritySnapshot,
  SecretExecutionEvidence,
} from "@koda/protocol";

import {
  ArtifactStore,
  type MaterializedTextOutput,
  type TextArtifactCapture,
} from "./artifact-store.js";
import {
  OwnedProcessTree,
  type ProcessTerminationReport,
} from "./process-tree-controller.js";
import {
  NativeExecutorClient,
  NativeExecutorError,
  type NativeJobSnapshot,
} from "./native-executor-client.js";
import type {
  InteractiveProcessService,
  InteractiveTerminalStartResult,
} from "./interactive-process-service.js";
import {
  c1ExecutionCapabilities,
  createExecutionAdmissionSnapshot,
  createExecutionLaunchSetupSnapshot,
  executionCapabilitiesDigest,
  executionPolicyDigest,
  executionPolicyPreview,
  normalizeExecutionPolicy,
  resolveExecutionPolicy,
  resourceContractExecutionCapabilities,
  type ExecutionPolicyErrorCode,
} from "./execution-policy.js";
import {
  SecretPolicyError,
  type NativeSecretLeaseInput,
  type SecretCommandBinding,
  type SecretLease,
} from "./secret-policy.js";

export type CommandErrorCode =
  | "INVALID_COMMAND"
  | "INVALID_COMMAND_CWD"
  | "COMMAND_CWD_CHANGED"
  | "COMMAND_NOT_FOUND"
  | "COMMAND_START_FAILED"
  | "NATIVE_EXECUTOR_UNAVAILABLE"
  | "NATIVE_EXECUTOR_PROTOCOL_ERROR"
  | "PROCESS_TERMINATION_UNCERTAIN"
  | ExecutionPolicyErrorCode;

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

export interface WorkspaceTerminalOptions {
  argv: string[];
  cwd?: string;
  timeoutMs: number;
  lifecycle: "foreground" | "background";
  displayName?: string;
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
  security: ExecutionSecuritySnapshot;
  secrets?: SecretExecutionEvidence;
}

export interface PreparedWorkspaceCommand {
  argv: string[];
  cwd: string;
  timeoutMs: number;
  title: string;
  summary: string;
  preview: string;
  security: ExecutionSecuritySnapshot;
  execute(
    signal: AbortSignal,
    report?: (event: ToolOperationalEvent) => Promise<void>,
    secretLease?: SecretLease,
    secretBinding?: SecretCommandBinding,
  ): Promise<ExecCommandResult>;
}

export interface PreparedWorkspaceTerminal {
  argv: string[];
  cwd: string;
  timeoutMs: number;
  lifecycle: "foreground" | "background";
  displayName: string;
  title: string;
  summary: string;
  preview: string;
  security: ExecutionSecuritySnapshot;
  execute(
    signal: AbortSignal,
    secretLease?: SecretLease,
    secretBinding?: SecretCommandBinding,
  ): Promise<InteractiveTerminalStartResult>;
}

export interface WorkspaceCommandRunnerOptions {
  environment?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  artifactStore?: ArtifactStore;
  terminationGraceMs?: number;
  terminationConfirmationMs?: number;
  nativeExecutor?: NativeExecutorClient;
  interactiveProcessService?: InteractiveProcessService;
  executionPolicy?: ExecutionPolicy;
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
const MAX_TERMINAL_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_PTY_OUTPUT_BYTES = 4 * 1_048_576;
const MAX_DISPLAY_NAME_BYTES = 128;
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
    private readonly executionPolicy: ExecutionPolicy,
    private readonly executionCapabilities: ExecutionCapabilities,
    private readonly artifactStore?: ArtifactStore,
    private readonly nativeExecutor?: NativeExecutorClient,
    private readonly interactiveProcessService?: InteractiveProcessService,
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
    const executionPolicy = normalizeExecutionPolicy(
      options.executionPolicy ??
        resolveExecutionPolicy({ workspaceRoot: canonicalRoot }),
    );
    if (executionPolicy.workspace_root !== canonicalRoot) {
      throw new CommandError(
        "INVALID_EXECUTION_POLICY",
        "Execution policy workspace does not match the command workspace.",
      );
    }
    if (
      options.nativeExecutor !== undefined &&
      options.interactiveProcessService !== undefined &&
      options.nativeExecutor !==
        options.interactiveProcessService.nativeExecutor
    ) {
      throw new CommandError(
        "INVALID_EXECUTION_POLICY",
        "Foreground and interactive execution must use the same native security backend.",
      );
    }
    const nativeExecutor =
      options.nativeExecutor ??
      options.interactiveProcessService?.nativeExecutor;
    const executionCapabilities =
      nativeExecutor === undefined
        ? resourceContractExecutionCapabilities(
            c1ExecutionCapabilities(
              process.platform === "win32"
                ? "typescript_windows"
                : "typescript_posix",
            ),
          )
        : (await nativeExecutor.hello()).execution_security;
    return new WorkspaceCommandRunner(
      canonicalRoot,
      filterEnvironment(options.environment ?? process.env),
      maxOutputBytes,
      terminationGraceMs,
      terminationConfirmationMs,
      executionPolicy,
      executionCapabilities,
      options.artifactStore,
      nativeExecutor,
      options.interactiveProcessService,
    );
  }

  public get supportsInteractiveProcesses(): boolean {
    return this.interactiveProcessService !== undefined;
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
    const security = createExecutionAdmissionSnapshot(
      this.executionPolicy,
      this.executionCapabilities,
    );
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
        executionPolicyPreview(security),
      ].join("\n"),
      security,
      execute: async (signal, report, secretLease, secretBinding) => {
        if (executed) {
          throw new CommandError(
            "INVALID_COMMAND",
            "A prepared command can execute only once.",
          );
        }
        executed = true;
        signal.throwIfAborted();
        await this.revalidateWorkingDirectory(requestedCwd, cwd);
        await this.revalidateExecutionSecurity(security);
        const nativeSecretLease = consumeNativeSecretLease(
          secretLease,
          secretBinding,
          this.nativeExecutor !== undefined,
        );
        const executionOptions: RunForegroundCommandOptions = {
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
          policy: this.executionPolicy,
          capabilities: this.executionCapabilities,
          ...(report === undefined ? {} : { report }),
          ...(nativeSecretLease === undefined
            ? {}
            : { secretLease: nativeSecretLease }),
        };
        return this.nativeExecutor === undefined
          ? runForegroundCommand(executionOptions)
          : runNativeForegroundCommand(this.nativeExecutor, executionOptions);
      },
    };
  }

  public async prepareTerminal(
    options: WorkspaceTerminalOptions,
  ): Promise<PreparedWorkspaceTerminal> {
    const service = this.interactiveProcessService;
    if (service === undefined) {
      throw new CommandError(
        "NATIVE_EXECUTOR_UNAVAILABLE",
        "Interactive terminal execution requires the native executor service.",
      );
    }
    const argv = validateArguments(options.argv);
    const requestedCwd = options.cwd ?? ".";
    assertIntegerInRange(
      options.timeoutMs,
      MIN_TIMEOUT_MS,
      MAX_TERMINAL_TIMEOUT_MS,
      "timeout_ms",
    );
    const cwd = await this.resolveWorkingDirectory(requestedCwd);
    const security = createExecutionAdmissionSnapshot(
      this.executionPolicy,
      this.executionCapabilities,
    );
    const executable = argv[0] ?? "terminal";
    const defaultDisplayName = basename(executable) || executable;
    const displayName = options.displayName ?? defaultDisplayName;
    if (
      displayName.trim().length === 0 ||
      Buffer.byteLength(displayName, "utf8") > MAX_DISPLAY_NAME_BYTES ||
      /[\u0000-\u001F\u007F]/u.test(displayName)
    ) {
      throw new CommandError(
        "INVALID_COMMAND",
        `Terminal display name must contain 1-${MAX_DISPLAY_NAME_BYTES} UTF-8 bytes without control characters.`,
      );
    }
    let executed = false;
    return {
      argv: [...argv],
      cwd: cwd.workspacePath,
      timeoutMs: options.timeoutMs,
      lifecycle: options.lifecycle,
      displayName,
      title: `Start terminal ${JSON.stringify(displayName)}`,
      summary: `Start an interactive ${options.lifecycle} process in ${JSON.stringify(cwd.workspacePath)}.`,
      preview: [
        `name: ${JSON.stringify(displayName)}`,
        `cwd: ${JSON.stringify(cwd.workspacePath)}`,
        `lifecycle: ${options.lifecycle}`,
        `timeout: ${options.timeoutMs} ms`,
        `argv: ${JSON.stringify(argv)}`,
        executionPolicyPreview(security),
      ].join("\n"),
      security,
      execute: async (signal, secretLease, secretBinding) => {
        if (executed) {
          throw new CommandError(
            "INVALID_COMMAND",
            "A prepared terminal command can execute only once.",
          );
        }
        executed = true;
        signal.throwIfAborted();
        await this.revalidateWorkingDirectory(requestedCwd, cwd);
        await this.revalidateExecutionSecurity(security);
        const nativeSecretLease = consumeNativeSecretLease(
          secretLease,
          secretBinding,
          true,
        );
        return service.startTerminal({
          argv,
          cwd: cwd.absolutePath,
          environment: this.environment,
          timeoutMs: options.timeoutMs,
          outputLimitBytes: DEFAULT_PTY_OUTPUT_BYTES,
          terminationGraceMs: this.terminationGraceMs,
          terminationConfirmationMs: this.terminationConfirmationMs,
          rows: 24,
          cols: 80,
          term: "xterm-256color",
          lifecycle: options.lifecycle,
          displayName,
          policy: this.executionPolicy,
          ...(nativeSecretLease === undefined
            ? {}
            : { secretLease: nativeSecretLease }),
        });
      },
    };
  }

  private async revalidateExecutionSecurity(
    prepared: ExecutionSecuritySnapshot,
  ): Promise<void> {
    if (prepared.kind !== "policy") {
      throw new CommandError(
        "EXECUTION_SECURITY_CORRUPT",
        "Prepared execution security evidence is invalid.",
      );
    }
    const current =
      this.nativeExecutor === undefined
        ? resourceContractExecutionCapabilities(
            c1ExecutionCapabilities(
              process.platform === "win32"
                ? "typescript_windows"
                : "typescript_posix",
            ),
          )
        : (await this.nativeExecutor.hello()).execution_security;
    if (
      prepared.policy_digest !== executionPolicyDigest(this.executionPolicy) ||
      prepared.backend !== current.backend ||
      prepared.capabilities_digest !== executionCapabilitiesDigest(current)
    ) {
      throw new CommandError(
        "EXECUTION_POLICY_CHANGED",
        "The prepared execution security contract changed after approval.",
      );
    }
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
  policy: ExecutionPolicy;
  capabilities: ExecutionCapabilities;
  report?: (event: ToolOperationalEvent) => Promise<void>;
  secretLease?: NativeSecretLeaseInput;
}

const MAX_NATIVE_ARTIFACT_OUTPUT_BYTES = 67_108_864;
const NATIVE_JOB_POLL_INTERVAL_MS = 20;

async function runNativeForegroundCommand(
  executor: NativeExecutorClient,
  options: RunForegroundCommandOptions,
): Promise<ExecCommandResult> {
  options.signal.throwIfAborted();
  let snapshot: NativeJobSnapshot;
  try {
    snapshot = await executor.start({
      argv: [...options.argv],
      cwd: options.cwd,
      environment: options.environment,
      timeoutMs: options.timeoutMs,
      outputLimitBytes:
        options.artifactStore === undefined
          ? options.maxOutputBytes
          : MAX_NATIVE_ARTIFACT_OUTPUT_BYTES,
      terminationGraceMs: options.terminationGraceMs,
      terminationConfirmationMs: options.terminationConfirmationMs,
      policy: options.policy,
      ...(options.secretLease === undefined
        ? {}
        : { secretLease: options.secretLease }),
    });
  } catch (error) {
    throw mapNativeExecutorError(error, options.argv[0] ?? "command");
  }

  let reportedPid: number | undefined;
  const reportStarted = async (current: NativeJobSnapshot): Promise<void> => {
    if (reportedPid !== undefined || current.pid === null) return;
    try {
      await options.report?.({
        type: "process.started",
        payload: {
          pid: current.pid,
          ownership:
            process.platform === "win32"
              ? "windows_job_object"
              : "posix_process_group",
          security: current.security,
          ...(current.secrets === undefined
            ? {}
            : { secrets: current.secrets }),
        },
      });
      reportedPid = current.pid;
    } catch (error) {
      await terminateAndObserve(
        executor,
        current.job_id,
        "output_failure",
      ).catch(() => undefined);
      throw error;
    }
  };

  await reportStarted(snapshot);
  let cancelled = false;
  while (!isNativeTerminal(snapshot.state)) {
    if (options.signal.aborted) {
      cancelled = true;
      try {
        snapshot = await terminateAndObserve(
          executor,
          snapshot.job_id,
          "cancellation",
        );
      } catch (error) {
        throw mapNativeExecutorError(error, options.argv[0] ?? "command");
      }
      break;
    }
    await waitMilliseconds(NATIVE_JOB_POLL_INTERVAL_MS);
    try {
      snapshot = await executor.get(snapshot.job_id);
    } catch (error) {
      throw mapNativeExecutorError(error, options.argv[0] ?? "command");
    }
    await reportStarted(snapshot);
  }
  await reportStarted(snapshot);

  const secretFailure = secretFailureFromSnapshot(snapshot);
  if (secretFailure !== undefined) {
    if (snapshot.pid !== null && reportedPid !== undefined) {
      await reportNativeCompletion(options.report, snapshot, snapshot.pid);
    }
    throw secretFailure;
  }
  if (snapshot.state === "start_failed") {
    throw commandStartFailure(snapshot, options.argv[0] ?? "command");
  }
  const pid = snapshot.pid;
  if (pid === null || reportedPid === undefined) {
    throw new CommandError(
      "NATIVE_EXECUTOR_PROTOCOL_ERROR",
      "The native executor reached a terminal state without a reported process ID.",
    );
  }
  await reportNativeCompletion(options.report, snapshot, pid);
  if (snapshot.state === "termination_uncertain") {
    throw new CommandError(
      "PROCESS_TERMINATION_UNCERTAIN",
      `Koda could not confirm that native process tree ${pid} terminated.`,
    );
  }
  if (snapshot.state === "quarantined") {
    throw new CommandError(
      "NATIVE_EXECUTOR_PROTOCOL_ERROR",
      `Native job ${snapshot.job_id} was quarantined because its durable state could not be trusted.`,
    );
  }
  if (cancelled) {
    throw abortError(options.signal.reason);
  }
  if (snapshot.failure !== null) {
    throw new CommandError(
      "COMMAND_START_FAILED",
      `Native command execution failed: ${snapshot.failure.message}`,
    );
  }

  const [stdout, stderr] = await Promise.all([
    materializeNativeOutput(executor, snapshot, "stdout", options),
    materializeNativeOutput(executor, snapshot, "stderr", options),
  ]);
  return {
    argv: [...options.argv],
    cwd: options.workspacePath,
    exit_code: snapshot.exit_code,
    signal: snapshot.signal,
    stdout: stdout.text,
    stderr: stderr.text,
    stdout_bytes: snapshot.stdout_bytes,
    stderr_bytes: snapshot.stderr_bytes,
    stdout_truncated: snapshot.stdout_truncated || stdout.truncated,
    stderr_truncated: snapshot.stderr_truncated || stderr.truncated,
    ...(stdout.artifact === undefined
      ? {}
      : { stdout_artifact: stdout.artifact }),
    ...(stderr.artifact === undefined
      ? {}
      : { stderr_artifact: stderr.artifact }),
    timed_out: snapshot.timed_out,
    duration_ms: snapshot.duration_ms,
    ...(snapshot.termination === null
      ? {}
      : {
          termination: {
            reason: snapshot.termination.reason,
            outcome: snapshot.termination.outcome,
          },
        }),
    security: snapshot.security,
    ...(snapshot.secrets === undefined ? {} : { secrets: snapshot.secrets }),
  };
}

function secretFailureFromSnapshot(
  snapshot: NativeJobSnapshot,
): SecretPolicyError | undefined {
  const code = snapshot.failure?.code;
  if (code === undefined) return undefined;
  if (code.startsWith("SECRET_") || code === "INVALID_SECRET_DECLARATION") {
    return new SecretPolicyError(
      code as ConstructorParameters<typeof SecretPolicyError>[0],
    );
  }
  return undefined;
}

async function terminateAndObserve(
  executor: NativeExecutorClient,
  jobId: string,
  reason: "cancellation" | "output_failure",
): Promise<NativeJobSnapshot> {
  let snapshot = await executor.terminate(jobId, reason);
  while (!isNativeTerminal(snapshot.state)) {
    await waitMilliseconds(NATIVE_JOB_POLL_INTERVAL_MS);
    snapshot = await executor.get(jobId);
  }
  return snapshot;
}

async function reportNativeCompletion(
  report: ((event: ToolOperationalEvent) => Promise<void>) | undefined,
  snapshot: NativeJobSnapshot,
  pid: number,
): Promise<void> {
  for (const attempt of snapshot.termination?.attempts ?? []) {
    if (attempt.attempt === "identity_check") {
      continue;
    }
    if (
      attempt.mechanism !== "posix_process_group_signal" &&
      attempt.mechanism !== "windows_console_ctrl_break" &&
      attempt.mechanism !== "windows_conpty_ctrl_c" &&
      attempt.mechanism !== "windows_job_object_terminate"
    ) {
      continue;
    }
    await report?.({
      type: "process.termination_requested",
      payload: {
        pid,
        reason: snapshot.termination?.reason ?? "output_failure",
        attempt: attempt.attempt,
        mechanism: attempt.mechanism,
      },
    });
  }
  if (snapshot.state !== "termination_uncertain") {
    await report?.({
      type: "process.exited",
      payload: {
        pid,
        exitCode: snapshot.exit_code,
        signal: snapshot.signal,
        ...(snapshot.secrets === undefined
          ? {}
          : { secrets: snapshot.secrets }),
      },
    });
  }
  if (snapshot.termination !== null) {
    await report?.({
      type: "process.termination_completed",
      payload: {
        pid,
        reason: snapshot.termination.reason,
        outcome: snapshot.termination.outcome,
      },
    });
  }
}

async function materializeNativeOutput(
  executor: NativeExecutorClient,
  snapshot: NativeJobSnapshot,
  stream: "stdout" | "stderr",
  options: RunForegroundCommandOptions,
): Promise<MaterializedTextOutput> {
  const retainedBytes =
    stream === "stdout"
      ? snapshot.stdout_retained_bytes
      : snapshot.stderr_retained_bytes;
  const totalBytes =
    stream === "stdout" ? snapshot.stdout_bytes : snapshot.stderr_bytes;
  const supervisorTruncated =
    stream === "stdout" ? snapshot.stdout_truncated : snapshot.stderr_truncated;
  const targetBytes = supervisorTruncated
    ? Math.min(retainedBytes, options.maxOutputBytes)
    : retainedBytes;
  const capture = await createOutputCapture(
    supervisorTruncated ? undefined : options.artifactStore,
    options.maxOutputBytes,
  );
  try {
    let offset = 0;
    while (offset < targetBytes) {
      const output = await executor.readOutput(
        snapshot.job_id,
        stream,
        offset,
        Math.min(65_536, targetBytes - offset),
      );
      if (
        output.job_id !== snapshot.job_id ||
        output.stream !== stream ||
        output.offset !== offset ||
        output.total_bytes !== totalBytes ||
        output.retained_bytes !== retainedBytes ||
        output.next_offset <= offset
      ) {
        throw new CommandError(
          "NATIVE_EXECUTOR_PROTOCOL_ERROR",
          `Native executor returned inconsistent ${stream} output metadata.`,
        );
      }
      await capture.append(output.data);
      offset = output.next_offset;
    }
    const materialized = await capture.finish();
    return {
      ...materialized,
      totalBytes,
      truncated: supervisorTruncated || materialized.truncated,
    };
  } catch (error) {
    await capture.abort();
    throw error instanceof NativeExecutorError
      ? mapNativeExecutorError(error, options.argv[0] ?? "command")
      : error;
  }
}

function isNativeTerminal(state: NativeJobSnapshot["state"]): boolean {
  return (
    state === "exited" ||
    state === "start_failed" ||
    state === "termination_uncertain" ||
    state === "quarantined"
  );
}

function commandStartFailure(
  snapshot: NativeJobSnapshot,
  executable: string,
): CommandError {
  const code =
    snapshot.failure?.code === "COMMAND_NOT_FOUND"
      ? "COMMAND_NOT_FOUND"
      : "COMMAND_START_FAILED";
  return new CommandError(
    code,
    code === "COMMAND_NOT_FOUND"
      ? `Command executable was not found: ${executable}`
      : (snapshot.failure?.message ?? "Native command could not start."),
  );
}

function mapNativeExecutorError(
  error: unknown,
  executable: string,
): CommandError | Error {
  if (!(error instanceof NativeExecutorError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  if (
    error.code.startsWith("SECRET_") ||
    error.code === "INVALID_SECRET_DECLARATION"
  ) {
    return new SecretPolicyError(
      error.code as ConstructorParameters<typeof SecretPolicyError>[0],
    );
  }
  if (error.code === "COMMAND_NOT_FOUND") {
    return new CommandError(
      "COMMAND_NOT_FOUND",
      `Command executable was not found: ${executable}`,
      { cause: error },
    );
  }
  if (error.code === "COMMAND_START_FAILED") {
    return new CommandError("COMMAND_START_FAILED", error.message, {
      cause: error,
    });
  }
  if (
    [
      "INVALID_EXECUTION_POLICY",
      "EXECUTION_POLICY_UNAVAILABLE",
      "EXECUTION_POLICY_CHANGED",
      "INCOMPATIBLE_PROTOCOL",
      "EXECUTION_SECURITY_CORRUPT",
    ].includes(error.code)
  ) {
    return new CommandError(
      error.code as ExecutionPolicyErrorCode,
      error.message,
      { cause: error },
    );
  }
  return new CommandError(
    error.code === "NATIVE_EXECUTOR_UNAVAILABLE"
      ? "NATIVE_EXECUTOR_UNAVAILABLE"
      : "NATIVE_EXECUTOR_PROTOCOL_ERROR",
    error.message,
    { cause: error },
  );
}

function consumeNativeSecretLease(
  lease: SecretLease | undefined,
  binding: SecretCommandBinding | undefined,
  nativeAvailable: boolean,
): NativeSecretLeaseInput | undefined {
  if (lease === undefined) return undefined;
  if (
    binding === undefined ||
    !nativeAvailable ||
    process.platform === "win32"
  ) {
    lease.destroy();
    throw new SecretPolicyError("SECRET_POLICY_UNAVAILABLE");
  }
  return lease.consumeForNative(binding);
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
  let security: ExecutionSecuritySnapshot;
  try {
    security = createExecutionLaunchSetupSnapshot(
      options.policy,
      options.capabilities,
    );
    await options.report?.({
      type: "process.started",
      payload: { pid, ownership: ownedProcess.ownership, security },
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
      security,
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

function waitMilliseconds(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
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
