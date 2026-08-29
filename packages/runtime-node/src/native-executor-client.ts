import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_READ_BYTES = 65_536;

export type NativeExecutorErrorCode =
  | "NATIVE_EXECUTOR_UNAVAILABLE"
  | "NATIVE_EXECUTOR_PROTOCOL_ERROR"
  | "NATIVE_EXECUTOR_START_FAILED"
  | "INCOMPATIBLE_PROTOCOL"
  | "INVALID_REQUEST"
  | "IDEMPOTENCY_CONFLICT"
  | "JOB_NOT_FOUND"
  | "INVALID_OUTPUT_RANGE"
  | "OUTPUT_READ_FAILED"
  | "COMMAND_NOT_FOUND"
  | "COMMAND_START_FAILED"
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
  requestId?: string;
}

export type NativeJobState =
  | "starting"
  | "running"
  | "terminating"
  | "exited"
  | "start_failed"
  | "termination_uncertain";

export interface NativeTerminationAttempt {
  attempt: "graceful" | "force";
  mechanism: "posix_process_group_signal";
}

export interface NativeTerminationSnapshot {
  reason: "timeout" | "cancellation" | "output_failure" | "orphan_cleanup";
  outcome: "terminated" | "already_exited" | "uncertain";
  attempts: NativeTerminationAttempt[];
}

export interface NativeJobSnapshot {
  job_id: string;
  state: NativeJobState;
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

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveSafeInteger = safeInteger.refine((value) => value > 0);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);

const terminationAttemptSchema = z
  .object({
    attempt: z.enum(["graceful", "force"]),
    mechanism: z.literal("posix_process_group_signal"),
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

const jobSnapshotSchema = z
  .object({
    job_id: identifier,
    state: z.enum([
      "starting",
      "running",
      "terminating",
      "exited",
      "start_failed",
      "termination_uncertain",
    ]),
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
    ].includes(snapshot.state);
    if (
      terminal &&
      snapshot.state !== "start_failed" &&
      snapshot.pid === null
    ) {
      context.addIssue({
        code: "custom",
        message: "A started terminal job must include its process ID.",
      });
    }
  });

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

const helloResultSchema = z
  .object({
    protocol_version: z.literal(PROTOCOL_VERSION),
    supervisor_version: z.string().min(1).max(128),
    platform: z.string().min(1).max(64),
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
      })
      .strict(),
  })
  .strict();

const responseSchema = z
  .object({
    protocol_version: z.literal(PROTOCOL_VERSION),
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
    const socketPath = resolve(
      options.socketPath ?? join(stateDirectory, "koda-exec.sock"),
    );
    if (
      !isAbsolute(socketPath) ||
      Buffer.byteLength(socketPath, "utf8") > 100
    ) {
      throw new NativeExecutorError(
        "NATIVE_EXECUTOR_START_FAILED",
        "The executor socket path must be absolute and at most 100 UTF-8 bytes.",
      );
    }
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
    const environment = Object.fromEntries(
      Object.entries(input.environment).flatMap(([name, value]) =>
        value === undefined ? [] : [[name, value]],
      ),
    );
    const params = {
      argv: input.argv,
      cwd: input.cwd,
      environment,
      timeout_ms: input.timeoutMs,
      output_limit_bytes: input.outputLimitBytes,
      termination_grace_ms: input.terminationGraceMs,
      termination_confirmation_ms: input.terminationConfirmationMs,
    };
    try {
      return parseProtocolValue(
        jobSnapshotSchema,
        await this.call("job/start", params, requestId),
        "job/start result",
      );
    } catch (error) {
      if (!isUnavailable(error)) {
        throw error;
      }
      return parseProtocolValue(
        jobSnapshotSchema,
        await this.call("job/start", params, requestId),
        "retried job/start result",
      );
    }
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

  public async closeOwnedSupervisorForTests(): Promise<void> {
    const child = this.ownedSupervisor;
    this.ownedSupervisor = undefined;
    if (child?.pid === undefined || child.exitCode !== null) {
      return;
    }
    try {
      process.kill(child.pid, "SIGTERM");
    } catch (error) {
      if (!isNodeError(error, "ESRCH")) {
        throw error;
      }
    }
  }

  private async startSupervisor(startupTimeoutMs: number): Promise<void> {
    const child = spawn(
      this.binaryPath,
      [
        "serve",
        "--socket",
        this.socketPath,
        "--state-dir",
        this.stateDirectory,
      ],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
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
    throw protocolError(
      `Executor response is invalid: ${parsed.error.message}`,
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
    throw protocolError(
      `Executor ${description} is invalid: ${parsed.error.message}`,
    );
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
    case "INVALID_REQUEST":
    case "IDEMPOTENCY_CONFLICT":
    case "JOB_NOT_FOUND":
    case "INVALID_OUTPUT_RANGE":
    case "OUTPUT_READ_FAILED":
    case "COMMAND_NOT_FOUND":
    case "COMMAND_START_FAILED":
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
  await chmod(requested, 0o700);
  return realpath(requested);
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
