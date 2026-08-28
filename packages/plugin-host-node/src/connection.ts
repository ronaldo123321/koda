import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { TextDecoder } from "node:util";

import type { JsonObject, JsonValue } from "@koda/protocol";
import { OwnedProcessTree } from "@koda/runtime-node";

import type { PluginConfiguration } from "./config.js";
import { PluginHostError, errorMessage } from "./errors.js";
import {
  MAX_PLUGIN_INITIALIZE_BYTES,
  MAX_PLUGIN_MESSAGE_BYTES,
  initializeParams,
  jsonRpcResponseSchema,
  parsePluginOutput,
  pluginInitializeResultSchema,
  toolCallParams,
  type PluginInitializeResult,
} from "./protocol.js";

export interface PluginConnection {
  readonly pluginId: string;
  initialize(signal: AbortSignal): Promise<PluginInitializeResult>;
  callTool(
    name: string,
    arguments_: JsonObject,
    definitionSha256: string,
    signal: AbortSignal,
  ): Promise<JsonValue>;
  close(): Promise<void>;
}

export type PluginConnectionFactory = (
  configuration: PluginConfiguration,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
) => Promise<PluginConnection>;

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

class StdioPluginConnection implements PluginConnection {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly exitPromise: Promise<void>;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private closed = false;
  private exited = false;
  private protocolFailure: PluginHostError | undefined;
  private stderrBytes = 0;

  public constructor(
    public readonly pluginId: string,
    private readonly configuration: PluginConfiguration,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly processTree: OwnedProcessTree,
  ) {
    this.exitPromise = new Promise((resolvePromise) => {
      const exited = () => {
        this.exited = true;
        const error = new PluginHostError(
          "PLUGIN_SERVER_EXITED",
          `Plugin '${this.pluginId}' exited while the session was active.`,
        );
        this.rejectPending(error);
        resolvePromise();
      };
      child.once("exit", exited);
      if (child.exitCode !== null || child.signalCode !== null) {
        child.removeListener("exit", exited);
        exited();
      }
    });
    child.once("error", (error) => {
      void this.fail(
        new PluginHostError(
          "PLUGIN_CONNECTION_CLOSED",
          `Plugin '${this.pluginId}' process failed: ${error.message}`,
          { cause: error },
        ),
        "output_failure",
      );
    });
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stdout.once("error", (error) => {
      void this.fail(
        new PluginHostError(
          "PLUGIN_CONNECTION_CLOSED",
          `Plugin '${this.pluginId}' stdout failed: ${error.message}`,
          { cause: error },
        ),
        "output_failure",
      );
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.stderrBytes + chunk.byteLength,
      );
    });
  }

  public async initialize(
    signal: AbortSignal,
  ): Promise<PluginInitializeResult> {
    const value = await this.request(
      "initialize",
      initializeParams(this.configuration.id, this.configuration.capabilities),
      signal,
      this.configuration.startupTimeoutMs,
      "PLUGIN_PROTOCOL_INVALID",
    );
    if (
      Buffer.byteLength(JSON.stringify(value), "utf8") >
      MAX_PLUGIN_INITIALIZE_BYTES
    ) {
      throw await this.fail(
        new PluginHostError(
          "PLUGIN_OUTPUT_LIMIT_EXCEEDED",
          `Plugin '${this.pluginId}' initialize result exceeds ${MAX_PLUGIN_INITIALIZE_BYTES} bytes.`,
        ),
        "output_failure",
      );
    }
    if (
      isRecord(value) &&
      typeof value.protocolVersion === "number" &&
      value.protocolVersion !== 1
    ) {
      throw await this.fail(
        new PluginHostError(
          "PLUGIN_VERSION_UNSUPPORTED",
          `Plugin '${this.pluginId}' uses unsupported protocol version ${value.protocolVersion}.`,
        ),
        "output_failure",
      );
    }
    const parsed = pluginInitializeResultSchema.safeParse(value);
    if (!parsed.success) {
      throw await this.fail(
        new PluginHostError(
          "PLUGIN_PROTOCOL_INVALID",
          `Plugin '${this.pluginId}' returned an invalid initialize result: ${formatIssues(parsed.error.issues)}`,
        ),
        "output_failure",
      );
    }
    return parsed.data;
  }

  public async callTool(
    name: string,
    arguments_: JsonObject,
    definitionSha256: string,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const value = await this.request(
      "tool/call",
      toolCallParams(name, arguments_, definitionSha256),
      signal,
      this.configuration.callTimeoutMs,
      "PLUGIN_TOOL_ERROR",
    );
    try {
      return parsePluginOutput(value);
    } catch (error) {
      throw await this.fail(
        new PluginHostError(
          "PLUGIN_PROTOCOL_INVALID",
          `Plugin '${this.pluginId}' returned a non-JSON tool result.`,
          { cause: error },
        ),
        "output_failure",
      );
    }
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.exited) {
      return;
    }
    const signal = new AbortController().signal;
    try {
      await this.request(
        "shutdown",
        {},
        signal,
        this.configuration.shutdownTimeoutMs,
        "PLUGIN_PROTOCOL_INVALID",
        true,
      );
    } catch {
      // A hostile or silent child is terminated below.
    }
    this.child.stdin.end();
    if (
      await settledWithin(
        this.exitPromise,
        this.configuration.shutdownTimeoutMs,
      )
    ) {
      return;
    }
    const report = await this.processTree.terminate("orphan_cleanup");
    if (report.outcome === "uncertain") {
      throw new PluginHostError(
        "PLUGIN_SESSION_CLEANUP_FAILED",
        `Plugin '${this.pluginId}' process-tree cleanup is uncertain.`,
      );
    }
  }

  private request(
    method: string,
    params: JsonObject,
    signal: AbortSignal,
    timeoutMs: number,
    remoteErrorCode: "PLUGIN_PROTOCOL_INVALID" | "PLUGIN_TOOL_ERROR",
    allowClosed = false,
  ): Promise<unknown> {
    if ((!allowClosed && this.closed) || this.exited) {
      return Promise.reject(
        new PluginHostError(
          "PLUGIN_CONNECTION_CLOSED",
          `Plugin '${this.pluginId}' connection is closed.`,
        ),
      );
    }
    if (this.protocolFailure !== undefined) {
      return Promise.reject(this.protocolFailure);
    }
    signal.throwIfAborted();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const settle = (operation: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        this.pending.delete(id);
        operation();
      };
      const aborted = () => {
        const error = new PluginHostError(
          "PLUGIN_CONNECTION_CLOSED",
          `Plugin '${this.pluginId}' request was cancelled.`,
        );
        void this.fail(error, "cancellation");
        settle(() => rejectPromise(error));
      };
      const timer = setTimeout(() => {
        const error = new PluginHostError(
          "PLUGIN_TIMEOUT",
          `Plugin '${this.pluginId}' ${method} request timed out after ${timeoutMs} ms.`,
        );
        void this.fail(error, "timeout");
        settle(() => rejectPromise(error));
      }, timeoutMs);
      timer.unref();
      signal.addEventListener("abort", aborted, { once: true });
      this.pending.set(id, {
        method,
        resolve: (value) => settle(() => resolvePromise(value)),
        reject: (error) =>
          settle(() => {
            if (isJsonRpcRemoteError(error)) {
              rejectPromise(
                new PluginHostError(
                  remoteErrorCode,
                  `Plugin '${this.pluginId}' rejected ${method}.`,
                ),
              );
              return;
            }
            rejectPromise(error);
          }),
      });
      const request = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
      this.child.stdin.write(request, "utf8", (error) => {
        if (error !== null && error !== undefined) {
          const failure = new PluginHostError(
            "PLUGIN_CONNECTION_CLOSED",
            `Could not write to plugin '${this.pluginId}': ${error.message}`,
            { cause: error },
          );
          void this.fail(failure, "output_failure");
          this.pending.get(id)?.reject(failure);
        }
      });
    });
  }

  private receive(chunk: Buffer): void {
    if (this.protocolFailure !== undefined || this.exited) {
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.byteLength > MAX_PLUGIN_MESSAGE_BYTES) {
      void this.fail(
        new PluginHostError(
          "PLUGIN_OUTPUT_LIMIT_EXCEEDED",
          `Plugin '${this.pluginId}' stdout message exceeds ${MAX_PLUGIN_MESSAGE_BYTES} bytes.`,
        ),
        "output_failure",
      );
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        return;
      }
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      this.receiveLine(
        line.byteLength > 0 && line[line.byteLength - 1] === 0x0d
          ? line.subarray(0, -1)
          : line,
      );
      if (this.protocolFailure !== undefined) {
        return;
      }
    }
  }

  private receiveLine(line: Buffer): void {
    if (line.byteLength === 0) {
      void this.fail(
        new PluginHostError(
          "PLUGIN_PROTOCOL_INVALID",
          `Plugin '${this.pluginId}' emitted a blank stdout frame.`,
        ),
        "output_failure",
      );
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(line),
      );
    } catch (error) {
      void this.fail(
        new PluginHostError(
          "PLUGIN_PROTOCOL_INVALID",
          `Plugin '${this.pluginId}' emitted invalid UTF-8 JSON.`,
          { cause: error },
        ),
        "output_failure",
      );
      return;
    }
    const response = jsonRpcResponseSchema.safeParse(value);
    if (!response.success) {
      void this.fail(
        new PluginHostError(
          "PLUGIN_PROTOCOL_INVALID",
          `Plugin '${this.pluginId}' emitted an invalid JSON-RPC response.`,
        ),
        "output_failure",
      );
      return;
    }
    const pending = this.pending.get(response.data.id);
    if (pending === undefined) {
      void this.fail(
        new PluginHostError(
          "PLUGIN_PROTOCOL_INVALID",
          `Plugin '${this.pluginId}' emitted an unexpected response ID.`,
        ),
        "output_failure",
      );
      return;
    }
    if (response.data.error !== undefined) {
      pending.reject(response.data.error);
    } else {
      pending.resolve(response.data.result);
    }
  }

  private async fail(
    error: PluginHostError,
    reason: "timeout" | "cancellation" | "output_failure",
  ): Promise<PluginHostError> {
    this.protocolFailure ??= error;
    this.rejectPending(error);
    await this.processTree.terminate(reason).catch(() => undefined);
    return error;
  }

  private rejectPending(error: unknown): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export const connectPluginStdio: PluginConnectionFactory = async (
  configuration,
  environment,
  signal,
) => {
  signal.throwIfAborted();
  const childEnvironment = defaultEnvironment(environment);
  for (const name of configuration.environmentNames) {
    const value = environment[name];
    if (value === undefined) {
      throw new PluginHostError(
        "PLUGIN_CONFIGURATION_INVALID",
        `Plugin '${configuration.id}' requires environment variable '${name}'.`,
      );
    }
    if (value.includes("\0")) {
      throw new PluginHostError(
        "PLUGIN_CONFIGURATION_INVALID",
        `Plugin '${configuration.id}' environment variable '${name}' contains a null byte.`,
      );
    }
    childEnvironment[name] = value;
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(configuration.command, configuration.args, {
      ...(configuration.cwd === undefined ? {} : { cwd: configuration.cwd }),
      detached: process.platform !== "win32",
      env: childEnvironment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    throw new PluginHostError(
      "PLUGIN_SERVER_START_FAILED",
      `Could not start plugin '${configuration.id}': ${errorMessage(error)}`,
      { cause: error },
    );
  }
  try {
    await waitForSpawn(child, signal, configuration.startupTimeoutMs);
  } catch (error) {
    child.kill();
    if (signal.aborted) {
      signal.throwIfAborted();
    }
    throw new PluginHostError(
      "PLUGIN_SERVER_START_FAILED",
      `Could not start plugin '${configuration.id}': ${errorMessage(error)}`,
      { cause: error },
    );
  }
  const pid = child.pid;
  if (pid === undefined || pid < 1) {
    child.kill();
    throw new PluginHostError(
      "PLUGIN_SERVER_START_FAILED",
      `Plugin '${configuration.id}' started without a valid process ID.`,
    );
  }
  const processTree = new OwnedProcessTree({
    child,
    pid,
    terminationGraceMs: Math.min(2_000, configuration.shutdownTimeoutMs),
    terminationConfirmationMs: Math.min(2_000, configuration.shutdownTimeoutMs),
  });
  return new StdioPluginConnection(
    configuration.id,
    configuration,
    child,
    processTree,
  );
};

function defaultEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    "COMSPEC",
    "HOME",
    "LANG",
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WINDIR",
  ]);
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (
      value !== undefined &&
      !value.includes("\0") &&
      (allowed.has(name.toUpperCase()) || name.toUpperCase().startsWith("LC_"))
    ) {
      result[name] = value;
    }
  }
  return result;
}

function waitForSpawn(
  child: ChildProcessWithoutNullStreams,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (operation: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      child.removeListener("spawn", spawned);
      child.removeListener("error", failed);
      operation();
    };
    const spawned = () => settle(resolvePromise);
    const failed = (error: Error) => settle(() => rejectPromise(error));
    const aborted = () =>
      settle(() => rejectPromise(new Error("Plugin startup was cancelled.")));
    const timer = setTimeout(
      () => settle(() => rejectPromise(new Error("Plugin spawn timed out."))),
      timeoutMs,
    );
    timer.unref();
    child.once("spawn", spawned);
    child.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function settledWithin(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), timeoutMs);
    timer.unref();
    promise.then(
      () => {
        clearTimeout(timer);
        resolvePromise(true);
      },
      () => {
        clearTimeout(timer);
        resolvePromise(true);
      },
    );
  });
}

function isJsonRpcRemoteError(
  value: unknown,
): value is { code: number; message: string; data?: JsonValue } {
  return (
    value !== null &&
    typeof value === "object" &&
    "code" in value &&
    typeof (value as { code?: unknown }).code === "number" &&
    "message" in value &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatIssues(
  issues: readonly { path: PropertyKey[]; message: string }[],
): string {
  return issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join(".") || "result"}: ${issue.message}`)
    .join("; ");
}
