import type { Readable, Writable } from "node:stream";

import {
  jsonRpcNotificationSchema,
  jsonRpcRequestSchema,
  jsonRpcResponseSchema,
  jsonValueSchema,
  turnEventNotificationParamsSchema,
  turnFinishedNotificationParamsSchema,
  type JsonRpcId,
  type JsonValue,
  type TurnEventNotificationParams,
  type TurnFinishedNotificationParams,
} from "@koda/protocol";
import type { ZodType } from "zod";

import {
  AppServerClientError,
  AppServerRpcError,
  clientErrorMessage,
} from "./errors.js";

export const DEFAULT_MAXIMUM_LINE_BYTES = 1_048_576;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export type AppServerNotification =
  | { method: "turn/event"; params: TurnEventNotificationParams }
  | { method: "turn/finished"; params: TurnFinishedNotificationParams };

export interface AppServerRpcConnectionOptions {
  input: Readable;
  output: Writable;
  maximumLineBytes?: number;
  requestTimeoutMs?: number;
}

interface PendingRequest<T = unknown> {
  method: string;
  resultSchema: ZodType<T>;
  resolve(value: T): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class AppServerRpcConnection {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly maximumLineBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationListeners = new Set<
    (notification: AppServerNotification) => void
  >();
  private readonly disconnectListeners = new Set<(error?: Error) => void>();
  private buffered = Buffer.alloc(0);
  private nextRequestId = 1;
  private writeChain = Promise.resolve();
  private closed = false;

  public constructor(options: AppServerRpcConnectionOptions) {
    this.input = options.input;
    this.output = options.output;
    this.maximumLineBytes =
      options.maximumLineBytes ?? DEFAULT_MAXIMUM_LINE_BYTES;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    assertPositiveSafeInteger(this.maximumLineBytes, "maximumLineBytes");
    assertPositiveSafeInteger(this.requestTimeoutMs, "requestTimeoutMs");
    this.input.on("data", this.handleData);
    this.input.once("end", this.handleEnd);
    this.input.once("error", this.handleInputError);
    this.output.once("error", this.handleOutputError);
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public onNotification(
    listener: (notification: AppServerNotification) => void,
  ): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  public onDisconnect(listener: (error?: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  public async request<T>(
    method: string,
    params: JsonValue,
    resultSchema: ZodType<T>,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    if (this.closed) {
      throw new AppServerClientError(
        "APP_SERVER_CONNECTION_CLOSED",
        "The app-server connection is closed.",
      );
    }
    assertPositiveSafeInteger(timeoutMs, "timeoutMs");
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    if (!Number.isSafeInteger(this.nextRequestId)) {
      this.nextRequestId = 1;
    }
    const request = jsonRpcRequestSchema.parse({
      jsonrpc: "2.0",
      id,
      method,
      params: jsonValueSchema.parse(params),
    });
    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AppServerClientError(
            "APP_SERVER_REQUEST_TIMEOUT",
            `App-server request '${method}' timed out after ${timeoutMs} ms.`,
          ),
        );
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        method,
        resultSchema,
        resolve,
        reject,
        timer,
      });
    });
    const line = `${JSON.stringify(request)}\n`;
    this.writeChain = this.writeChain.then(() => writeLine(this.output, line));
    void this.writeChain.catch((error: unknown) => {
      this.fail(
        new AppServerClientError(
          "APP_SERVER_CONNECTION_CLOSED",
          `Could not write to app-server: ${clientErrorMessage(error)}`,
          { cause: error },
        ),
      );
    });
    return result;
  }

  public close(): void {
    this.finish(undefined);
  }

  public fail(error: Error): void {
    this.finish(error);
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    if (this.closed) {
      return;
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffered = Buffer.concat([this.buffered, bytes]);
    let newline = this.buffered.indexOf(10);
    while (newline >= 0) {
      if (newline > this.maximumLineBytes) {
        this.protocolFailure(
          `JSON-RPC output line exceeds ${this.maximumLineBytes} bytes.`,
        );
        return;
      }
      let line = this.buffered.subarray(0, newline);
      if (line.at(-1) === 13) {
        line = line.subarray(0, -1);
      }
      this.buffered = this.buffered.subarray(newline + 1);
      if (!this.handleLine(line.toString("utf8"))) {
        return;
      }
      newline = this.buffered.indexOf(10);
    }
    if (this.buffered.byteLength > this.maximumLineBytes) {
      this.protocolFailure(
        `JSON-RPC output line exceeds ${this.maximumLineBytes} bytes.`,
      );
    }
  };

  private readonly handleEnd = (): void => {
    if (this.closed) {
      return;
    }
    if (this.buffered.byteLength > 0) {
      if (this.buffered.byteLength > this.maximumLineBytes) {
        this.protocolFailure(
          `JSON-RPC output line exceeds ${this.maximumLineBytes} bytes.`,
        );
        return;
      }
      let line = this.buffered;
      if (line.at(-1) === 13) {
        line = line.subarray(0, -1);
      }
      this.buffered = Buffer.alloc(0);
      if (!this.handleLine(line.toString("utf8"))) {
        return;
      }
    }
    this.fail(
      new AppServerClientError(
        "APP_SERVER_CONNECTION_CLOSED",
        "The app-server closed its protocol output.",
      ),
    );
  };

  private readonly handleInputError = (error: Error): void => {
    this.fail(
      new AppServerClientError(
        "APP_SERVER_CONNECTION_CLOSED",
        `App-server output failed: ${error.message}`,
        { cause: error },
      ),
    );
  };

  private readonly handleOutputError = (error: Error): void => {
    this.fail(
      new AppServerClientError(
        "APP_SERVER_CONNECTION_CLOSED",
        `App-server input failed: ${error.message}`,
        { cause: error },
      ),
    );
  };

  private handleLine(line: string): boolean {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.protocolFailure("App-server emitted invalid JSON.");
      return false;
    }
    const notification = jsonRpcNotificationSchema.safeParse(value);
    if (notification.success) {
      return this.handleNotification(
        notification.data.method,
        notification.data.params,
      );
    }
    const response = jsonRpcResponseSchema.safeParse(value);
    if (!response.success) {
      this.protocolFailure("App-server emitted an invalid JSON-RPC message.");
      return false;
    }
    if (response.data.id === null) {
      this.protocolFailure(
        "App-server emitted a response without a request ID.",
      );
      return false;
    }
    const pending = this.pending.get(response.data.id);
    if (pending === undefined) {
      this.protocolFailure(
        `App-server responded to unknown request '${String(response.data.id)}'.`,
      );
      return false;
    }
    this.pending.delete(response.data.id);
    clearTimeout(pending.timer);
    if ("error" in response.data) {
      const dataCode =
        response.data.error.data !== undefined &&
        response.data.error.data !== null &&
        typeof response.data.error.data === "object" &&
        !Array.isArray(response.data.error.data) &&
        typeof response.data.error.data.code === "string"
          ? response.data.error.data.code
          : undefined;
      pending.reject(
        new AppServerRpcError(
          response.data.error.code,
          response.data.error.message,
          dataCode,
        ),
      );
      return true;
    }
    const result = pending.resultSchema.safeParse(response.data.result);
    if (!result.success) {
      this.protocolFailure(
        `App-server returned an invalid result for '${pending.method}'.`,
      );
      return false;
    }
    pending.resolve(result.data);
    return true;
  }

  private handleNotification(
    method: string,
    params: JsonValue | undefined,
  ): boolean {
    let notification: AppServerNotification;
    if (method === "turn/event") {
      const parsed = turnEventNotificationParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.protocolFailure(
          "App-server emitted invalid turn/event parameters.",
        );
        return false;
      }
      notification = { method, params: parsed.data };
    } else if (method === "turn/finished") {
      const parsed = turnFinishedNotificationParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.protocolFailure(
          "App-server emitted invalid turn/finished parameters.",
        );
        return false;
      }
      notification = { method, params: parsed.data };
    } else {
      this.protocolFailure(
        `App-server emitted unknown notification '${method}'.`,
      );
      return false;
    }
    for (const listener of this.notificationListeners) {
      try {
        listener(notification);
      } catch {
        // Presentation callbacks cannot corrupt protocol state.
      }
    }
    return true;
  }

  private protocolFailure(message: string): void {
    this.fail(new AppServerClientError("APP_SERVER_PROTOCOL_ERROR", message));
  }

  private finish(error: Error | undefined): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.input.removeListener("data", this.handleData);
    this.input.removeListener("end", this.handleEnd);
    this.input.removeListener("error", this.handleInputError);
    this.output.removeListener("error", this.handleOutputError);
    const rejection =
      error ??
      new AppServerClientError(
        "APP_SERVER_CONNECTION_CLOSED",
        "The app-server connection was closed.",
      );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(rejection);
    }
    this.pending.clear();
    for (const listener of this.disconnectListeners) {
      try {
        listener(error);
      } catch {
        // Disconnect observers cannot alter connection cleanup.
      }
    }
  }
}

function writeLine(output: Writable, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(line, "utf8", (error) => {
      if (error === null || error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}
