import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, chmod, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { isAbsolute, join, resolve } from "node:path";

import { z } from "zod";
import {
  executionCapabilitiesSchema,
  type ExecutionPolicy,
  type ExecutionSecuritySnapshot,
} from "@koda/protocol";
import {
  executionPolicyDigest,
  normalizeExecutionPolicy,
  validateExecutionSecuritySnapshot,
} from "./execution-policy.js";

const PROTOCOL_VERSION = 3;
const MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_READ_BYTES = 65_536;
const MAX_PTY_INPUT_BYTES = 16_384;

export type NativeExecutorErrorCode =
  | "NATIVE_EXECUTOR_UNAVAILABLE"
  | "NATIVE_EXECUTOR_PROTOCOL_ERROR"
  | "NATIVE_EXECUTOR_START_FAILED"
  | "PLATFORM_CAPABILITY_UNAVAILABLE"
  | "INCOMPATIBLE_PROTOCOL"
  | "INCOMPATIBLE_STATE_VERSION"
  | "INVALID_EXECUTION_POLICY"
  | "EXECUTION_POLICY_UNAVAILABLE"
  | "EXECUTION_POLICY_CHANGED"
  | "EXECUTION_SECURITY_CORRUPT"
  | "INVALID_REQUEST"
  | "IDEMPOTENCY_CONFLICT"
  | "JOB_NOT_FOUND"
  | "INVALID_OUTPUT_RANGE"
  | "OUTPUT_READ_FAILED"
  | "COMMAND_NOT_FOUND"
  | "COMMAND_START_FAILED"
  | "ATTACHMENT_NOT_FOUND"
  | "ATTACHMENT_LIMIT_EXCEEDED"
  | "INPUT_LEASE_HELD"
  | "INPUT_LEASE_EXPIRED"
  | "STALE_INPUT_FENCE"
  | "PTY_INPUT_BACKPRESSURE"
  | "PTY_NOT_SUPPORTED_FOR_JOB"
  | "JOB_TERMINAL"
  | "CURSOR_INVALID"
  | "PTY_OUTPUT_FAILED"
  | "PTY_OUTPUT_CORRUPT"
  | "INTERNAL_ERROR";

export class NativeExecutorError extends Error {
  public constructor(
    public readonly code: NativeExecutorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NativeExecutorError";
  }
}

export interface NativeExecutorClientOptions {
  binaryPath: string;
  stateDirectory: string;
  socketPath?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface NativeExecutorStartInput {
  argv: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  outputLimitBytes: number;
  terminationGraceMs: number;
  terminationConfirmationMs: number;
  lifecycle?: "foreground" | "background";
  displayName?: string;
  requestId?: string;
  /** Frozen policy selected by the trusted application before approval. */
  policy: ExecutionPolicy;
}

export interface NativeExecutorPtyStartInput extends NativeExecutorStartInput {
  rows: number;
  cols: number;
  term?: string;
  lifecycle?: "foreground" | "background";
  displayName?: string;
}

export type NativeIoMode = "pipe" | "pty";
export type NativeJobLifecycle = "foreground" | "background";

export type NativeJobState =
  | "accepted"
  | "worker_ready"
  | "command_starting"
  | "starting"
  | "running"
  | "terminating"
  | "exited"
  | "start_failed"
  | "termination_uncertain"
  | "quarantined";

export interface NativeTerminationAttempt {
  attempt: "graceful" | "force" | "identity_check";
  mechanism:
    | "posix_process_group_signal"
    | "windows_console_ctrl_break"
    | "windows_conpty_ctrl_c"
    | "windows_job_object_terminate"
    | "windows_job_object_close_observation"
    | "windows_job_object_recovery_pending"
    | "process_start_identity_mismatch"
    | "command_identity_not_persisted";
}

export interface NativeTerminationSnapshot {
  reason: "timeout" | "cancellation" | "output_failure" | "orphan_cleanup";
  outcome: "terminated" | "already_exited" | "uncertain";
  attempts: NativeTerminationAttempt[];
}

export interface NativeJobSnapshot {
  job_id: string;
  state: NativeJobState;
  io_mode: NativeIoMode;
  lifecycle: NativeJobLifecycle;
  pid: number | null;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  duration_ms: number;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_retained_bytes: number;
  stderr_retained_bytes: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  termination: NativeTerminationSnapshot | null;
  failure: { code: string; message: string } | null;
  security: ExecutionSecuritySnapshot;
}

export interface NativeOutputReadResult {
  job_id: string;
  stream: "stdout" | "stderr";
  offset: number;
  next_offset: number;
  total_bytes: number;
  retained_bytes: number;
  complete: boolean;
  truncated: boolean;
  data: Buffer;
}

export interface NativeJobSummary {
  job_id: string;
  display_name: string | null;
  cwd: string;
  state: NativeJobState;
  io_mode: NativeIoMode;
  lifecycle: NativeJobLifecycle;
  created_at_ms: number;
  updated_at_ms: number;
  pid: number | null;
  security: ExecutionSecuritySnapshot;
}

export interface NativeJobListResult {
  jobs: NativeJobSummary[];
  next_cursor: string | null;
}

export interface NativeAttachmentCredentials {
  job_id: string;
  attachment_id: string;
  capability_token: string;
}

export interface NativeInputLease {
  job_id: string;
  attachment_id: string;
  lease_token: string;
  fence: number;
  expires_at_ms: number;
}

export type NativeAttachmentReadResult =
  | {
      status: "ok";
      job_id: string;
      cursor: number;
      next_cursor: number;
      earliest_cursor: number;
      latest_cursor: number;
      complete: boolean;
      data: Buffer;
    }
  | {
      status: "cursor_expired";
      job_id: string;
      cursor: number;
      earliest_cursor: number;
      latest_cursor: number;
      complete: boolean;
    };

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveSafeInteger = safeInteger.refine((value) => value > 0);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);
const jobStateSchema = z.enum([
  "accepted",
  "worker_ready",
  "command_starting",
  "starting",
  "running",
  "terminating",
  "exited",
  "start_failed",
  "termination_uncertain",
  "quarantined",
]);
const ioModeSchema = z.enum(["pipe", "pty"]);
const jobLifecycleSchema = z.enum(["foreground", "background"]);
const canonicalBase64Schema = z
  .string()
  .max(100_000)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);
const opaqueBase64Schema = canonicalBase64Schema.refine(
  (value) => value.length > 0,
  "Capability and lease tokens must not be empty.",
);

const terminationAttemptSchema = z
  .object({
    attempt: z.enum(["graceful", "force", "identity_check"]),
    mechanism: z.enum([
      "posix_process_group_signal",
      "windows_console_ctrl_break",
      "windows_conpty_ctrl_c",
      "windows_job_object_terminate",
      "windows_job_object_close_observation",
      "windows_job_object_recovery_pending",
      "process_start_identity_mismatch",
      "command_identity_not_persisted",
    ]),
  })
  .strict();

const terminationSchema = z
  .object({
    reason: z.enum([
      "timeout",
      "cancellation",
      "output_failure",
      "orphan_cleanup",
    ]),
    outcome: z.enum(["terminated", "already_exited", "uncertain"]),
    attempts: z.array(terminationAttemptSchema).max(2),
  })
  .strict();

const nativeSecuritySchema = z.unknown().transform((value) => {
  try {
    return validateExecutionSecuritySnapshot(value);
  } catch {
    throw new NativeExecutorError(
      "EXECUTION_SECURITY_CORRUPT",
      "Executor security evidence is invalid or inconsistent.",
    );
  }
});

const jobSnapshotSchema = z
  .object({
    job_id: identifier,
    state: jobStateSchema,
    io_mode: ioModeSchema,
    lifecycle: jobLifecycleSchema,
    security: nativeSecuritySchema,
    pid: positiveSafeInteger.nullable(),
    exit_code: z.number().int().nullable(),
    signal: z.string().min(1).max(64).nullable(),
    timed_out: z.boolean(),
    duration_ms: safeInteger,
    stdout_bytes: safeInteger,
    stderr_bytes: safeInteger,
    stdout_retained_bytes: safeInteger,
    stderr_retained_bytes: safeInteger,
    stdout_truncated: z.boolean(),
    stderr_truncated: z.boolean(),
    termination: terminationSchema.nullable(),
    failure: z
      .object({
        code: z.string().min(1).max(128),
        message: z.string().max(8_192),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.stdout_retained_bytes > snapshot.stdout_bytes) {
      context.addIssue({
        code: "custom",
        message: "stdout retained bytes exceed total bytes.",
      });
    }
    if (snapshot.stderr_retained_bytes > snapshot.stderr_bytes) {
      context.addIssue({
        code: "custom",
        message: "stderr retained bytes exceed total bytes.",
      });
    }
    const terminal = [
      "exited",
      "start_failed",
      "termination_uncertain",
      "quarantined",
    ].includes(snapshot.state);
    if (terminal && snapshot.state === "exited" && snapshot.pid === null) {
      context.addIssue({
        code: "custom",
        message: "A started terminal job must include its process ID.",
      });
    }
  });

const jobSummarySchema = z
  .object({
    job_id: identifier,
    display_name: z.string().min(1).max(128).nullable(),
    cwd: z.string().min(1).max(4_096),
    state: jobStateSchema,
    io_mode: ioModeSchema,
    lifecycle: jobLifecycleSchema,
    security: nativeSecuritySchema,
    created_at_ms: safeInteger,
    updated_at_ms: safeInteger,
    pid: positiveSafeInteger.nullable(),
  })
  .strict();

const jobListSchema = z
  .object({
    jobs: z.array(jobSummarySchema).max(100),
    next_cursor: identifier.nullable(),
  })
  .strict();

const outputReadSchema = z
  .object({
    job_id: identifier,
    stream: z.enum(["stdout", "stderr"]),
    offset: safeInteger,
    next_offset: safeInteger,
    total_bytes: safeInteger,
    retained_bytes: safeInteger,
    complete: z.boolean(),
    truncated: z.boolean(),
    data_base64: z.string().max(100_000),
  })
  .strict()
  .superRefine((output, context) => {
    if (
      output.next_offset < output.offset ||
      output.next_offset > output.retained_bytes ||
      output.retained_bytes > output.total_bytes
    ) {
      context.addIssue({
        code: "custom",
        message: "Output cursors are inconsistent.",
      });
    }
  });

const attachmentCredentialsSchema = z
  .object({
    job_id: identifier,
    attachment_id: identifier,
    capability_token: opaqueBase64Schema,
  })
  .strict();

const inputLeaseSchema = z
  .object({
    job_id: identifier,
    attachment_id: identifier,
    lease_token: opaqueBase64Schema,
    fence: positiveSafeInteger,
    expires_at_ms: positiveSafeInteger,
  })
  .strict();

const attachmentReadSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      job_id: identifier,
      cursor: safeInteger,
      next_cursor: safeInteger,
      earliest_cursor: safeInteger,
      latest_cursor: safeInteger,
      complete: z.boolean(),
      data_base64: canonicalBase64Schema,
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.earliest_cursor > value.cursor ||
        value.cursor > value.next_cursor ||
        value.next_cursor > value.latest_cursor
      ) {
        context.addIssue({
          code: "custom",
          message: "PTY output cursors are inconsistent.",
        });
      }
    }),
  z
    .object({
      status: z.literal("cursor_expired"),
      job_id: identifier,
      cursor: safeInteger,
      earliest_cursor: safeInteger,
      latest_cursor: safeInteger,
      complete: z.boolean(),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.cursor >= value.earliest_cursor ||
        value.earliest_cursor > value.latest_cursor
      ) {
        context.addIssue({
          code: "custom",
          message: "Expired PTY cursor bounds are inconsistent.",
        });
      }
    }),
]);

const inputWriteResultSchema = z
  .object({ job_id: identifier, accepted_bytes: positiveSafeInteger })
  .strict();

const terminalResizeResultSchema = z
  .object({
    job_id: identifier,
    rows: z.number().int().min(1).max(500),
    cols: z.number().int().min(1).max(500),
  })
  .strict();

const attachmentDetachResultSchema = z
  .object({ job_id: identifier, detached: z.boolean() })
  .strict();

const helloResultSchema = z
  .object({
    protocol_version: z.literal(PROTOCOL_VERSION),
    supervisor_version: z.string().min(1).max(128),
    platform: z.enum(["linux", "macos", "windows"]),
    execution_security: executionCapabilitiesSchema.refine(
      (value) =>
        value.backend === "native_posix" || value.backend === "native_windows",
      "Expected native execution capabilities.",
    ),
    capabilities: z
      .object({
        process_group: z.boolean(),
        job_object: z.boolean(),
        pty: z.boolean(),
        reattach: z.boolean(),
        durable_restart_recovery: z.boolean(),
      })
      .strict(),
    limits: z
      .object({
        max_frame_bytes: positiveSafeInteger,
        max_output_read_bytes: positiveSafeInteger,
        max_output_limit_bytes: positiveSafeInteger,
        max_background_timeout_ms: positiveSafeInteger,
        max_pty_input_bytes: positiveSafeInteger,
        max_pending_pty_input_bytes: positiveSafeInteger,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const expected =
      value.platform === "windows" ? "native_windows" : "native_posix";
    if (value.execution_security.backend !== expected) {
      context.addIssue({
        code: "custom",
        path: ["execution_security", "backend"],
        message: "Execution-security backend does not match the platform.",
      });
    }
  });

const responseSchema = z
  .object({
    protocol_version: positiveSafeInteger,
    request_id: identifier,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.string().min(1).max(128),
        message: z.string().max(8_192),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((response, context) => {
    if (response.ok === (response.result === undefined)) {
      context.addIssue({
        code: "custom",
        message:
          "A response must contain exactly one successful result or error.",
      });
    }
    if (response.ok === (response.error !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "A response error is inconsistent with its ok flag.",
      });
    }
  });

type ExecutorResponse = z.infer<typeof responseSchema>;

export class NativeExecutorClient {
  public readonly binaryPath: string;
  public readonly socketPath: string;
  public readonly stateDirectory: string;
  private readonly requestTimeoutMs: number;
  private ownedSupervisor: ChildProcess | undefined;

  private constructor(options: {
    binaryPath: string;
    socketPath: string;
    stateDirectory: string;
    requestTimeoutMs: number;
  }) {
    this.binaryPath = options.binaryPath;
    this.socketPath = options.socketPath;
    this.stateDirectory = options.stateDirectory;
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  public static async open(
    options: NativeExecutorClientOptions,
  ): Promise<NativeExecutorClient> {
    const binaryPath = await validateBinary(options.binaryPath);
    const stateDirectory = await preparePrivateDirectory(
      options.stateDirectory,
    );
    const socketPath = await resolveLocalEndpoint(
      binaryPath,
      stateDirectory,
      options.socketPath,
    );
    const startupTimeoutMs = validateTimeout(
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      "startupTimeoutMs",
    );
    const requestTimeoutMs = validateTimeout(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    const client = new NativeExecutorClient({
      binaryPath,
      socketPath,
      stateDirectory,
      requestTimeoutMs,
    });
    try {
      await client.hello();
      return client;
    } catch (error) {
      if (!isUnavailable(error)) {
        throw error;
      }
    }
    await client.startSupervisor(startupTimeoutMs);
    return client;
  }

  public async hello(): Promise<z.infer<typeof helloResultSchema>> {
    return parseProtocolValue(
      helloResultSchema,
      await this.callOnce(
        "system/hello",
        {
          client_name: "@koda/runtime-node",
          client_version: "0.0.0",
          supported_versions: [PROTOCOL_VERSION],
        },
        randomUUID(),
        false,
      ),
      "handshake result",
    );
  }

  public async start(
    input: NativeExecutorStartInput,
  ): Promise<NativeJobSnapshot> {
    const requestId = input.requestId ?? randomUUID();
    const policy = normalizeExecutionPolicy(input.policy);
    const cwd = await realpath(input.cwd);
    const params = {
      argv: [...input.argv],
      cwd,
      policy,
      environment: definedEnvironment(input.environment),
      timeout_ms: input.timeoutMs,
      output_limit_bytes: input.outputLimitBytes,
      termination_grace_ms: input.terminationGraceMs,
      termination_confirmation_ms: input.terminationConfirmationMs,
      io_mode: "pipe",
      lifecycle: input.lifecycle ?? "foreground",
      ...(input.displayName === undefined
        ? {}
        : { display_name: input.displayName }),
    };
    return this.startRequest(params, requestId);
  }

  public async startPty(
    input: NativeExecutorPtyStartInput,
  ): Promise<NativeJobSnapshot> {
    const requestId = input.requestId ?? randomUUID();
    const policy = normalizeExecutionPolicy(input.policy);
    const cwd = await realpath(input.cwd);
    const params = {
      argv: [...input.argv],
      cwd,
      policy,
      environment: definedEnvironment(input.environment),
      timeout_ms: input.timeoutMs,
      output_limit_bytes: input.outputLimitBytes,
      termination_grace_ms: input.terminationGraceMs,
      termination_confirmation_ms: input.terminationConfirmationMs,
      io_mode: "pty",
      lifecycle: input.lifecycle ?? "foreground",
      ...(input.displayName === undefined
        ? {}
        : { display_name: input.displayName }),
      pty: {
        rows: input.rows,
        cols: input.cols,
        term: input.term ?? "xterm-256color",
        output_limit_bytes: input.outputLimitBytes,
      },
    };
    return this.startRequest(params, requestId);
  }

  private async startRequest(
    params: { policy: ExecutionPolicy },
    requestId: string,
  ): Promise<NativeJobSnapshot> {
    try {
      return this.validateStartedJob(
        parseProtocolValue(
          jobSnapshotSchema,
          await this.call("job/start", params, requestId),
          "job/start result",
        ),
        params.policy,
      );
    } catch (error) {
      if (!isUnavailable(error)) {
        throw error;
      }
      return this.validateStartedJob(
        parseProtocolValue(
          jobSnapshotSchema,
          await this.call("job/start", params, requestId),
          "retried job/start result",
        ),
        params.policy,
      );
    }
  }

  private validateStartedJob(
    snapshot: NativeJobSnapshot,
    policy: ExecutionPolicy,
  ): NativeJobSnapshot {
    if (
      snapshot.security.kind !== "policy" ||
      snapshot.security.policy_digest !== executionPolicyDigest(policy) ||
      snapshot.security.backend !== expectedNativeBackend()
    ) {
      throw new NativeExecutorError(
        "EXECUTION_SECURITY_CORRUPT",
        "Started job does not match its requested execution policy.",
      );
    }
    return snapshot;
  }

  public async get(jobId: string): Promise<NativeJobSnapshot> {
    return parseProtocolValue(
      jobSnapshotSchema,
      await this.call("job/get", { job_id: jobId }, randomUUID()),
      "job/get result",
    );
  }

  public async terminate(
    jobId: string,
    reason: "cancellation" | "output_failure",
  ): Promise<NativeJobSnapshot> {
    return parseProtocolValue(
      jobSnapshotSchema,
      await this.call("job/terminate", { job_id: jobId, reason }, randomUUID()),
      "job/terminate result",
    );
  }

  public async readOutput(
    jobId: string,
    stream: "stdout" | "stderr",
    offset: number,
    maxBytes = MAX_OUTPUT_READ_BYTES,
  ): Promise<NativeOutputReadResult> {
    const parsed = parseProtocolValue(
      outputReadSchema,
      await this.call(
        "job/output/read",
        { job_id: jobId, stream, offset, max_bytes: maxBytes },
        randomUUID(),
      ),
      "job/output/read result",
    );
    const data = decodeCanonicalBase64(parsed.data_base64);
    if (parsed.next_offset - parsed.offset !== data.byteLength) {
      throw new NativeExecutorError(
        "NATIVE_EXECUTOR_PROTOCOL_ERROR",
        "Executor output cursors do not match the decoded payload length.",
      );
    }
    return {
      job_id: parsed.job_id,
      stream: parsed.stream,
      offset: parsed.offset,
      next_offset: parsed.next_offset,
      total_bytes: parsed.total_bytes,
      retained_bytes: parsed.retained_bytes,
      complete: parsed.complete,
      truncated: parsed.truncated,
      data,
    };
  }

  public async list(
    input: {
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<NativeJobListResult> {
    return parseProtocolValue(
      jobListSchema,
      await this.call(
        "job/list",
        {
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        },
        randomUUID(),
      ),
      "job/list result",
    );
  }

  public async openAttachment(
    jobId: string,
    cursor = 0,
  ): Promise<NativePtyAttachment> {
    const credentials = parseProtocolValue(
      attachmentCredentialsSchema,
      await this.call("attach/open", { job_id: jobId }, randomUUID()),
      "attach/open result",
    );
    return new NativePtyAttachment(this, credentials, cursor);
  }

  public async readAttachment(
    attachment: NativeAttachmentCredentials,
    cursor: number,
    maxBytes = MAX_OUTPUT_READ_BYTES,
  ): Promise<NativeAttachmentReadResult> {
    const parsed = parseProtocolValue(
      attachmentReadSchema,
      await this.call(
        "attach/read",
        {
          ...attachment,
          cursor,
          max_bytes: maxBytes,
        },
        randomUUID(),
      ),
      "attach/read result",
    );
    if (parsed.status === "cursor_expired") {
      return parsed;
    }
    const data = decodeCanonicalBase64(parsed.data_base64);
    if (parsed.next_cursor - parsed.cursor !== data.byteLength) {
      throw protocolError(
        "Executor PTY cursors do not match the decoded payload length.",
      );
    }
    return {
      status: parsed.status,
      job_id: parsed.job_id,
      cursor: parsed.cursor,
      next_cursor: parsed.next_cursor,
      earliest_cursor: parsed.earliest_cursor,
      latest_cursor: parsed.latest_cursor,
      complete: parsed.complete,
      data,
    };
  }

  public async acquireInput(
    attachment: NativeAttachmentCredentials,
  ): Promise<NativeInputLease> {
    return parseProtocolValue(
      inputLeaseSchema,
      await this.call("attach/acquire-input", attachment, randomUUID()),
      "attach/acquire-input result",
    );
  }

  public async renewInput(
    attachment: NativeAttachmentCredentials,
    lease: NativeInputLease,
  ): Promise<NativeInputLease> {
    return parseProtocolValue(
      inputLeaseSchema,
      await this.call(
        "attach/renew",
        leaseParams(attachment, lease),
        randomUUID(),
      ),
      "attach/renew result",
    );
  }

  public async writeInput(
    attachment: NativeAttachmentCredentials,
    lease: NativeInputLease,
    input: Uint8Array,
  ): Promise<number> {
    const data = Buffer.from(input);
    if (data.byteLength < 1 || data.byteLength > MAX_PTY_INPUT_BYTES) {
      throw new NativeExecutorError(
        "INVALID_REQUEST",
        `PTY input must contain 1-${MAX_PTY_INPUT_BYTES} bytes.`,
      );
    }
    const result = parseProtocolValue(
      inputWriteResultSchema,
      await this.call(
        "input/write",
        {
          ...leaseParams(attachment, lease),
          data_base64: data.toString("base64"),
        },
        randomUUID(),
      ),
      "input/write result",
    );
    if (result.accepted_bytes !== data.byteLength) {
      throw protocolError("Executor accepted an ambiguous PTY input length.");
    }
    return result.accepted_bytes;
  }

  public async resizeTerminal(
    attachment: NativeAttachmentCredentials,
    lease: NativeInputLease,
    rows: number,
    cols: number,
  ): Promise<{ rows: number; cols: number }> {
    const result = parseProtocolValue(
      terminalResizeResultSchema,
      await this.call(
        "terminal/resize",
        { ...leaseParams(attachment, lease), rows, cols },
        randomUUID(),
      ),
      "terminal/resize result",
    );
    return { rows: result.rows, cols: result.cols };
  }

  public async detach(
    attachment: NativeAttachmentCredentials,
  ): Promise<boolean> {
    return parseProtocolValue(
      attachmentDetachResultSchema,
      await this.call("attach/detach", attachment, randomUUID()),
      "attach/detach result",
    ).detached;
  }

  public async closeOwnedSupervisorForTests(): Promise<void> {
    const child = this.ownedSupervisor;
    this.ownedSupervisor = undefined;
    if (child?.pid === undefined || child.exitCode !== null) {
      return;
    }
    const exited = new Promise<void>((resolvePromise) => {
      child.once("exit", () => resolvePromise());
    });
    try {
      process.kill(child.pid, "SIGTERM");
    } catch (error) {
      if (!isNodeError(error, "ESRCH")) {
        throw error;
      }
    }
    await Promise.race([exited, delay(1_000)]);
  }

  private async startSupervisor(startupTimeoutMs: number): Promise<void> {
    const child = spawn(
      this.binaryPath,
      [
        "serve",
        "--endpoint",
        this.socketPath,
        "--state-dir",
        this.stateDirectory,
      ],
      {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    // Recognize only bounded startup error codes, never forward raw stderr.
    let startupDiagnostics = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      startupDiagnostics = (startupDiagnostics + chunk.toString("utf8")).slice(
        -8192,
      );
    });
    (child.stderr as { unref?: () => void } | null)?.unref?.();
    this.ownedSupervisor = child;
    child.unref();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      child.once("spawn", resolvePromise);
      child.once("error", (error) =>
        rejectPromise(
          new NativeExecutorError(
            "NATIVE_EXECUTOR_START_FAILED",
            `Could not start koda-exec: ${error.message}`,
            { cause: error },
          ),
        ),
      );
    });

    const deadline = Date.now() + startupTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await this.hello();
        return;
      } catch (error) {
        if (!isUnavailable(error)) {
          throw error;
        }
        lastError = error;
      }
      if (child.exitCode !== null) {
        if (startupDiagnostics.includes("INCOMPATIBLE_STATE_VERSION:")) {
          throw new NativeExecutorError(
            "INCOMPATIBLE_STATE_VERSION",
            "The job store contains a newer format. Use a compatible executor; existing records were not adopted.",
          );
        }
        if (startupDiagnostics.includes("INCOMPATIBLE_PROTOCOL:")) {
          throw new NativeExecutorError(
            "INCOMPATIBLE_PROTOCOL",
            "A legacy Worker is still starting. Finish or cancel it with the old executor before upgrading.",
          );
        }
        throw new NativeExecutorError(
          "NATIVE_EXECUTOR_START_FAILED",
          `koda-exec exited with code ${child.exitCode} before accepting connections.`,
          { cause: lastError },
        );
      }
      await delay(25);
    }
    throw new NativeExecutorError(
      "NATIVE_EXECUTOR_START_FAILED",
      `koda-exec did not become ready within ${startupTimeoutMs} ms.`,
      { cause: lastError },
    );
  }

  private async call(
    method: string,
    params: object,
    requestId: string,
  ): Promise<unknown> {
    return this.callOnce(method, params, requestId, true);
  }

  private async callOnce(
    method: string,
    params: object,
    requestId: string,
    includeHandshake: boolean,
  ): Promise<unknown> {
    const helloRequestId = randomUUID();
    const requests = includeHandshake
      ? [
          requestEnvelope(helloRequestId, "system/hello", {
            client_name: "@koda/runtime-node",
            client_version: "0.0.0",
            supported_versions: [PROTOCOL_VERSION],
          }),
          requestEnvelope(requestId, method, params),
        ]
      : [requestEnvelope(requestId, method, params)];
    const responses = await exchange(
      this.socketPath,
      requests,
      this.requestTimeoutMs,
    );
    const parsed = responses.map((response) => parseResponse(response));
    if (includeHandshake) {
      const hello = parsed[0];
      if (hello === undefined || hello.request_id !== helloRequestId) {
        throw protocolError(
          "Executor returned a mismatched handshake response.",
        );
      }
      parseProtocolValue(
        helloResultSchema,
        successResult(hello),
        "handshake result",
      );
    }
    const response = parsed.at(-1);
    if (response === undefined || response.request_id !== requestId) {
      throw protocolError(
        "Executor returned a mismatched response request ID.",
      );
    }
    return successResult(response);
  }
}

export class NativePtyAttachment {
  private lease: NativeInputLease | undefined;

  public constructor(
    private readonly client: NativeExecutorClient,
    public readonly credentials: NativeAttachmentCredentials,
    public cursor: number,
  ) {}

  public async read(
    maxBytes = MAX_OUTPUT_READ_BYTES,
  ): Promise<NativeAttachmentReadResult> {
    const result = await this.client.readAttachment(
      this.credentials,
      this.cursor,
      maxBytes,
    );
    this.cursor =
      result.status === "ok" ? result.next_cursor : result.earliest_cursor;
    return result;
  }

  public async acquireInput(): Promise<NativeInputLease> {
    this.lease = await this.client.acquireInput(this.credentials);
    return this.lease;
  }

  public async renewInput(): Promise<NativeInputLease> {
    this.lease = await this.client.renewInput(
      this.credentials,
      this.requireLease(),
    );
    return this.lease;
  }

  public async write(input: Uint8Array | string): Promise<number> {
    return this.client.writeInput(
      this.credentials,
      this.requireLease(),
      typeof input === "string" ? Buffer.from(input, "utf8") : input,
    );
  }

  public async resize(
    rows: number,
    cols: number,
  ): Promise<{ rows: number; cols: number }> {
    return this.client.resizeTerminal(
      this.credentials,
      this.requireLease(),
      rows,
      cols,
    );
  }

  public async close(): Promise<boolean> {
    const detached = await this.client.detach(this.credentials);
    this.lease = undefined;
    return detached;
  }

  private requireLease(): NativeInputLease {
    if (this.lease === undefined) {
      throw new NativeExecutorError(
        "INPUT_LEASE_EXPIRED",
        "This PTY attachment does not hold an input lease.",
      );
    }
    return this.lease;
  }
}

function requestEnvelope(
  requestId: string,
  method: string,
  params: object,
): object {
  return {
    protocol_version: PROTOCOL_VERSION,
    request_id: requestId,
    method,
    params,
  };
}

function definedEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, value]],
    ),
  );
}

function expectedNativeBackend(): "native_posix" | "native_windows" {
  return process.platform === "win32" ? "native_windows" : "native_posix";
}

function leaseParams(
  attachment: NativeAttachmentCredentials,
  lease: NativeInputLease,
): object {
  if (
    lease.job_id !== attachment.job_id ||
    lease.attachment_id !== attachment.attachment_id
  ) {
    throw new NativeExecutorError(
      "INPUT_LEASE_EXPIRED",
      "The PTY input lease belongs to a different attachment.",
    );
  }
  return {
    ...attachment,
    lease_token: lease.lease_token,
    fence: lease.fence,
  };
}

async function exchange(
  socketPath: string,
  requests: object[],
  timeoutMs: number,
): Promise<unknown[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection({ path: socketPath });
    const expectedResponses = requests.length;
    const responses: unknown[] = [];
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      fail(
        new NativeExecutorError(
          "NATIVE_EXECUTOR_UNAVAILABLE",
          `Executor request timed out after ${timeoutMs} ms.`,
        ),
      );
    }, timeoutMs);
    timer.unref();

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(responses);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      rejectPromise(asTransportError(error));
    };

    socket.once("connect", () => {
      try {
        socket.write(Buffer.concat(requests.map(encodeFrame)));
      } catch (error) {
        fail(error);
      }
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length < 1 || length > MAX_FRAME_BYTES) {
          fail(
            protocolError(
              `Executor response frame length ${length} is invalid.`,
            ),
          );
          return;
        }
        if (buffer.byteLength < 4 + length) return;
        const payload = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        try {
          responses.push(JSON.parse(payload.toString("utf8")));
        } catch (error) {
          fail(
            protocolError("Executor returned invalid response JSON.", error),
          );
          return;
        }
        if (responses.length === expectedResponses) {
          finish();
          return;
        }
      }
      if (buffer.byteLength > MAX_FRAME_BYTES + 4) {
        fail(
          protocolError("Executor buffered response exceeded the frame limit."),
        );
      }
    });
    socket.once("error", fail);
    socket.once("end", () => {
      if (!settled) {
        fail(
          new NativeExecutorError(
            "NATIVE_EXECUTOR_UNAVAILABLE",
            "Executor closed the connection before returning every response.",
          ),
        );
      }
    });
  });
}

function encodeFrame(value: object): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength < 1 || payload.byteLength > MAX_FRAME_BYTES) {
    throw protocolError("Executor request exceeded the frame limit.");
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

function parseResponse(value: unknown): ExecutorResponse {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) {
    throw protocolError("Executor response is invalid.");
  }
  if (parsed.data.protocol_version !== PROTOCOL_VERSION) {
    throw new NativeExecutorError(
      "INCOMPATIBLE_PROTOCOL",
      "Executor protocol v3 is required. Finish or stop the older Supervisor explicitly before upgrading; no fallback was attempted.",
    );
  }
  return parsed.data;
}

function parseProtocolValue<T>(
  schema: z.ZodType<T>,
  value: unknown,
  description: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw protocolError(`Executor ${description} is invalid.`);
  }
  return parsed.data;
}

function successResult(response: ExecutorResponse): unknown {
  if (!response.ok) {
    const error = response.error;
    throw new NativeExecutorError(
      normalizeRemoteCode(error?.code),
      error?.message ?? "Executor returned an unspecified error.",
    );
  }
  return response.result;
}

function normalizeRemoteCode(
  code: string | undefined,
): NativeExecutorErrorCode {
  switch (code) {
    case "INCOMPATIBLE_PROTOCOL":
    case "INCOMPATIBLE_STATE_VERSION":
    case "INVALID_EXECUTION_POLICY":
    case "EXECUTION_POLICY_UNAVAILABLE":
    case "EXECUTION_POLICY_CHANGED":
    case "EXECUTION_SECURITY_CORRUPT":
    case "PLATFORM_CAPABILITY_UNAVAILABLE":
    case "INVALID_REQUEST":
    case "IDEMPOTENCY_CONFLICT":
    case "JOB_NOT_FOUND":
    case "INVALID_OUTPUT_RANGE":
    case "OUTPUT_READ_FAILED":
    case "COMMAND_NOT_FOUND":
    case "COMMAND_START_FAILED":
    case "ATTACHMENT_NOT_FOUND":
    case "ATTACHMENT_LIMIT_EXCEEDED":
    case "INPUT_LEASE_HELD":
    case "INPUT_LEASE_EXPIRED":
    case "STALE_INPUT_FENCE":
    case "PTY_INPUT_BACKPRESSURE":
    case "PTY_NOT_SUPPORTED_FOR_JOB":
    case "JOB_TERMINAL":
    case "CURSOR_INVALID":
    case "PTY_OUTPUT_FAILED":
    case "PTY_OUTPUT_CORRUPT":
    case "INTERNAL_ERROR":
      return code;
    default:
      return "NATIVE_EXECUTOR_PROTOCOL_ERROR";
  }
}

function decodeCanonicalBase64(value: string): Buffer {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    throw protocolError("Executor output contains invalid Base64.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw protocolError("Executor output Base64 is not canonical.");
  }
  return decoded;
}

async function validateBinary(input: string): Promise<string> {
  const requested = resolve(input);
  try {
    const canonical = await realpath(requested);
    const metadata = await stat(canonical);
    if (!metadata.isFile()) {
      throw new Error("not a regular file");
    }
    await access(canonical, constants.X_OK);
    return canonical;
  } catch (error) {
    throw new NativeExecutorError(
      "NATIVE_EXECUTOR_START_FAILED",
      `koda-exec is missing or not executable: ${requested}`,
      { cause: error },
    );
  }
}

async function preparePrivateDirectory(input: string): Promise<string> {
  const requested = resolve(input);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const metadata = await lstat(requested);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new NativeExecutorError(
      "NATIVE_EXECUTOR_START_FAILED",
      `Executor state path must be a real directory: ${requested}`,
    );
  }
  if (process.platform !== "win32") {
    await chmod(requested, 0o700);
  }
  return realpath(requested);
}

async function resolveLocalEndpoint(
  binaryPath: string,
  stateDirectory: string,
  configured: string | undefined,
): Promise<string> {
  if (process.platform === "win32") {
    const endpoint =
      configured ??
      (await queryDefaultWindowsEndpoint(binaryPath, stateDirectory));
    if (
      !/^\\\\\.\\pipe\\koda-exec-[a-z0-9-]+$/u.test(endpoint) ||
      endpoint.length > 240
    ) {
      throw new NativeExecutorError(
        "NATIVE_EXECUTOR_START_FAILED",
        "The Windows executor endpoint must be a bounded local Koda Named Pipe name.",
      );
    }
    return endpoint;
  }

  const endpoint = resolve(
    configured ?? join(stateDirectory, "koda-exec.sock"),
  );
  if (!isAbsolute(endpoint) || Buffer.byteLength(endpoint, "utf8") > 100) {
    throw new NativeExecutorError(
      "NATIVE_EXECUTOR_START_FAILED",
      "The executor socket path must be absolute and at most 100 UTF-8 bytes.",
    );
  }
  return endpoint;
}

async function queryDefaultWindowsEndpoint(
  binaryPath: string,
  stateDirectory: string,
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      binaryPath,
      ["endpoint", "--state-dir", stateDirectory],
      { encoding: "utf8", windowsHide: true, timeout: 5_000 },
      (error, stdout) => {
        if (error !== null) {
          rejectPromise(
            new NativeExecutorError(
              "NATIVE_EXECUTOR_START_FAILED",
              `Could not derive the Windows executor endpoint: ${error.message}`,
              { cause: error },
            ),
          );
          return;
        }
        const endpoint = stdout.trim();
        if (endpoint.length === 0 || endpoint.includes("\n")) {
          rejectPromise(
            new NativeExecutorError(
              "NATIVE_EXECUTOR_START_FAILED",
              "koda-exec returned an invalid Windows endpoint.",
            ),
          );
          return;
        }
        resolvePromise(endpoint);
      },
    );
  });
}

function validateTimeout(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 60_000) {
    throw new NativeExecutorError(
      "NATIVE_EXECUTOR_START_FAILED",
      `${name} must be an integer between 100 and 60000.`,
    );
  }
  return value;
}

function protocolError(message: string, cause?: unknown): NativeExecutorError {
  return new NativeExecutorError(
    "NATIVE_EXECUTOR_PROTOCOL_ERROR",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function asTransportError(error: unknown): NativeExecutorError {
  if (error instanceof NativeExecutorError) return error;
  return new NativeExecutorError(
    "NATIVE_EXECUTOR_UNAVAILABLE",
    `Could not communicate with koda-exec: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

function isUnavailable(error: unknown): boolean {
  return (
    error instanceof NativeExecutorError &&
    error.code === "NATIVE_EXECUTOR_UNAVAILABLE"
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}
