import {
  type ApplicationDiagnostic,
  type KodaApplication,
  type TurnHandle,
} from "@koda/app";
import {
  APP_SERVER_PROTOCOL_VERSION,
  APP_SERVER_RPC_ERROR_CODE,
  approvalResolveParamsSchema,
  approvalResolveResultSchema,
  initializeParamsSchema,
  initializeResultSchema,
  jsonRpcRequestSchema,
  jsonValueSchema,
  shutdownParamsSchema,
  shutdownResultSchema,
  threadGetParamsSchema,
  threadGetResultSchema,
  threadListParamsSchema,
  threadListResultSchema,
  turnCancelParamsSchema,
  turnCancelResultSchema,
  turnEventNotificationParamsSchema,
  turnFinishedNotificationParamsSchema,
  turnStartParamsSchema,
  turnStartResultSchema,
  type AgentEvent,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonValue,
  type TurnId,
} from "@koda/protocol";
import { ZodError, type ZodType } from "zod";

import { PendingApprovalRegistry } from "./approval-registry.js";
import type { ProtocolMessageWriter } from "./message-writer.js";

export interface KodaAppServerOptions {
  application: KodaApplication;
  writer: ProtocolMessageWriter;
  serverVersion?: string;
  diagnostic?(message: string): unknown | Promise<unknown>;
  fatal?(error: Error): unknown;
}

export class KodaAppServer {
  private readonly application: KodaApplication;
  private readonly writer: ProtocolMessageWriter;
  private readonly serverVersion: string;
  private readonly diagnostic: (message: string) => unknown | Promise<unknown>;
  private readonly fatal: (error: Error) => unknown;
  private readonly approvals = new PendingApprovalRegistry();
  private readonly activeTurns = new Map<TurnId, TurnHandle>();
  private readonly turnMonitors = new Map<TurnId, Promise<void>>();
  private initialized = false;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;

  public constructor(options: KodaAppServerOptions) {
    this.application = options.application;
    this.writer = options.writer;
    this.serverVersion = options.serverVersion ?? "0.1.0";
    this.diagnostic = options.diagnostic ?? (() => undefined);
    this.fatal = options.fatal ?? (() => undefined);
  }

  public get shouldClose(): boolean {
    return this.shuttingDown && this.activeTurns.size === 0;
  }

  public async handleLine(line: string): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      await this.writeError(
        null,
        APP_SERVER_RPC_ERROR_CODE.PARSE,
        "Parse error.",
      );
      return;
    }
    const parsed = jsonRpcRequestSchema.safeParse(value);
    if (!parsed.success) {
      await this.writeError(
        extractId(value),
        APP_SERVER_RPC_ERROR_CODE.INVALID_REQUEST,
        "Invalid Request.",
      );
      return;
    }
    await this.handleRequest(parsed.data);
  }

  public async disconnect(
    reason = "The app-server client disconnected.",
  ): Promise<void> {
    await this.shutdown(reason);
  }

  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    try {
      const result = await this.dispatch(request);
      await this.writer.write({
        jsonrpc: "2.0",
        id: request.id,
        result,
      });
    } catch (error) {
      if (error instanceof RpcRequestError) {
        await this.writeError(
          request.id,
          error.rpcCode,
          error.message,
          error.dataCode,
        );
        return;
      }
      if (error instanceof ZodError) {
        await this.writeError(
          request.id,
          APP_SERVER_RPC_ERROR_CODE.INVALID_PARAMS,
          "Invalid method parameters.",
          "INVALID_PARAMS",
        );
        return;
      }
      await this.reportDiagnostic(
        `request ${request.method} failed: ${errorMessage(error)}`,
      );
      await this.writeError(
        request.id,
        APP_SERVER_RPC_ERROR_CODE.INTERNAL,
        "Internal error.",
        "INTERNAL_ERROR",
      );
    }
  }

  private async dispatch(request: JsonRpcRequest): Promise<JsonValue> {
    if (request.method === "initialize") {
      return this.initialize(request.params);
    }
    if (!this.initialized) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.NOT_INITIALIZED,
        "Server is not initialized.",
        "SERVER_NOT_INITIALIZED",
      );
    }
    if (request.method === "shutdown") {
      parseParams(shutdownParamsSchema, request.params);
      await this.shutdown("The app-server is shutting down.");
      return jsonValueSchema.parse(shutdownResultSchema.parse({}));
    }
    if (this.shuttingDown) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.SHUTTING_DOWN,
        "Server is shutting down.",
        "SERVER_SHUTTING_DOWN",
      );
    }

    switch (request.method) {
      case "thread/list":
        return this.listThreads(request.params);
      case "thread/get":
        return this.getThread(request.params);
      case "turn/start":
        return this.startTurn(request.params);
      case "turn/cancel":
        return this.cancelTurn(request.params);
      case "approval/resolve":
        return this.resolveApproval(request.params);
      default:
        throw rpcError(
          APP_SERVER_RPC_ERROR_CODE.METHOD_NOT_FOUND,
          `Method '${request.method}' was not found.`,
          "METHOD_NOT_FOUND",
        );
    }
  }

  private initialize(params: JsonValue | undefined): JsonValue {
    if (this.initialized) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.ALREADY_INITIALIZED,
        "Server is already initialized.",
        "SERVER_ALREADY_INITIALIZED",
      );
    }
    const version =
      params !== null &&
      typeof params === "object" &&
      !Array.isArray(params) &&
      "protocolVersion" in params
        ? params.protocolVersion
        : undefined;
    if (version !== APP_SERVER_PROTOCOL_VERSION) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.VERSION_MISMATCH,
        `Unsupported protocol version '${String(version)}'.`,
        "PROTOCOL_VERSION_MISMATCH",
      );
    }
    parseParams(initializeParamsSchema, params);
    this.initialized = true;
    return jsonValueSchema.parse(
      initializeResultSchema.parse({
        protocolVersion: APP_SERVER_PROTOCOL_VERSION,
        server: { name: "koda-app-server", version: this.serverVersion },
        capabilities: {
          threadQueries: true,
          turnStart: true,
          turnResume: true,
          turnCancellation: true,
          interactiveApproval: true,
          durableEventNotifications: true,
        },
        providers: this.application.listProviders(),
      }),
    );
  }

  private async listThreads(params: JsonValue | undefined): Promise<JsonValue> {
    const input = parseParams(threadListParamsSchema, params);
    const result = await this.application.listThreads({
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    });
    return jsonValueSchema.parse(
      threadListResultSchema.parse({
        threads: result.value,
        diagnostics: result.diagnostics,
        ...(result.recovery === undefined ? {} : { recovery: result.recovery }),
      }),
    );
  }

  private async getThread(params: JsonValue | undefined): Promise<JsonValue> {
    const input = parseParams(threadGetParamsSchema, params);
    const result = await this.application.getThread(input.threadId);
    if (result.value === undefined) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.THREAD_NOT_FOUND,
        `Thread '${input.threadId}' was not found.`,
        "THREAD_NOT_FOUND",
      );
    }
    return jsonValueSchema.parse(
      threadGetResultSchema.parse({
        thread: result.value,
        diagnostics: result.diagnostics,
        ...(result.recovery === undefined ? {} : { recovery: result.recovery }),
      }),
    );
  }

  private startTurn(params: JsonValue | undefined): JsonValue {
    const input = parseParams(turnStartParamsSchema, params);
    let turnId: TurnId | undefined;
    let handle: TurnHandle;
    try {
      handle = this.application.startTurn(
        {
          prompt: input.prompt,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.provider === undefined ? {} : { provider: input.provider }),
          ...(input.resumeThreadId === undefined
            ? {}
            : { resume: input.resumeThreadId }),
          ...(input.approvalMode === undefined
            ? {}
            : { approvalMode: input.approvalMode }),
        },
        {
          events: {
            append: async (event: AgentEvent) => {
              if (event.type === "approval.requested") {
                this.approvals.preregister(event.turnId, event.payload.callId);
              }
              await this.notify(
                "turn/event",
                jsonValueSchema.parse(
                  turnEventNotificationParamsSchema.parse({ event }),
                ),
              );
            },
          },
          approvals: this.approvals.broker(() => turnId),
          diagnostic: (diagnostic) =>
            this.reportApplicationDiagnostic(diagnostic),
        },
      );
    } catch (error) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        errorMessage(error),
        applicationErrorCode(error),
      );
    }
    turnId = handle.turnId;
    this.activeTurns.set(handle.turnId, handle);
    const monitor = this.monitorTurn(handle);
    this.turnMonitors.set(handle.turnId, monitor);
    void monitor.finally(() => {
      this.turnMonitors.delete(handle.turnId);
    });
    return jsonValueSchema.parse(
      turnStartResultSchema.parse({
        threadId: handle.threadId,
        turnId: handle.turnId,
      }),
    );
  }

  private cancelTurn(params: JsonValue | undefined): JsonValue {
    const input = parseParams(turnCancelParamsSchema, params);
    const handle = this.activeTurns.get(input.turnId);
    if (handle === undefined) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.TURN_NOT_FOUND,
        `Turn '${input.turnId}' is not active.`,
        "TURN_NOT_FOUND",
      );
    }
    const reason = input.reason ?? "Cancelled by the app-server client.";
    const accepted = handle.cancel(reason);
    this.approvals.rejectTurn(input.turnId, reason);
    return jsonValueSchema.parse(turnCancelResultSchema.parse({ accepted }));
  }

  private resolveApproval(params: JsonValue | undefined): JsonValue {
    const input = parseParams(approvalResolveParamsSchema, params);
    if (!this.activeTurns.has(input.turnId)) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.TURN_NOT_FOUND,
        `Turn '${input.turnId}' is not active.`,
        "TURN_NOT_FOUND",
      );
    }
    const resolution = this.approvals.resolve(input.turnId, input.callId, {
      decision: input.decision,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    if (resolution === "not_found") {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPROVAL_NOT_FOUND,
        `Approval '${input.callId}' is not pending.`,
        "APPROVAL_NOT_FOUND",
      );
    }
    if (resolution === "already_resolved") {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPROVAL_ALREADY_RESOLVED,
        `Approval '${input.callId}' was already resolved.`,
        "APPROVAL_ALREADY_RESOLVED",
      );
    }
    return jsonValueSchema.parse(
      approvalResolveResultSchema.parse({ accepted: true }),
    );
  }

  private async monitorTurn(handle: TurnHandle): Promise<void> {
    try {
      const completion = await handle.completion;
      this.approvals.rejectTurn(
        handle.turnId,
        "The turn finished before approval resolved.",
      );
      await this.notify(
        "turn/finished",
        jsonValueSchema.parse(
          turnFinishedNotificationParamsSchema.parse(completion),
        ),
      );
    } catch (error) {
      await this.reportDiagnostic(
        `turn ${handle.turnId} completion notification failed: ${errorMessage(error)}`,
      );
      this.beginFatalShutdown(error);
    } finally {
      this.activeTurns.delete(handle.turnId);
      this.approvals.clearTurn(handle.turnId);
    }
  }

  private async shutdown(reason: string): Promise<void> {
    if (this.shutdownPromise !== undefined) {
      return this.shutdownPromise;
    }
    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      const completions: Promise<unknown>[] = [];
      for (const handle of this.activeTurns.values()) {
        handle.cancel(reason);
        this.approvals.rejectTurn(handle.turnId, reason);
        completions.push(handle.completion);
      }
      await Promise.allSettled(completions);
      await Promise.allSettled([...this.turnMonitors.values()]);
    })();
    return this.shutdownPromise;
  }

  private async notify(method: string, params: JsonValue): Promise<void> {
    await this.writer.write({ jsonrpc: "2.0", method, params });
  }

  private async writeError(
    id: JsonRpcId | null,
    code: number,
    message: string,
    dataCode?: string,
  ): Promise<void> {
    await this.writer.write({
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message: boundMessage(message),
        ...(dataCode === undefined ? {} : { data: { code: dataCode } }),
      },
    });
  }

  private async reportApplicationDiagnostic(
    diagnostic: ApplicationDiagnostic,
  ): Promise<void> {
    await this.reportDiagnostic(`${diagnostic.code}: ${diagnostic.message}`);
  }

  private async reportDiagnostic(message: string): Promise<void> {
    try {
      await this.diagnostic(boundMessage(message));
    } catch {
      // A diagnostic writer cannot alter protocol or durable turn state.
    }
  }

  private beginFatalShutdown(error: unknown): void {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    const reason = "Protocol output failed; the app-server is shutting down.";
    for (const handle of this.activeTurns.values()) {
      handle.cancel(reason);
      this.approvals.rejectTurn(handle.turnId, reason);
    }
    try {
      this.fatal(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // The transport will also observe the failed writer when possible.
    }
  }
}

class RpcRequestError extends Error {
  public constructor(
    public readonly rpcCode: number,
    message: string,
    public readonly dataCode: string,
  ) {
    super(message);
    this.name = "RpcRequestError";
  }
}

function rpcError(
  code: number,
  message: string,
  dataCode: string,
): RpcRequestError {
  return new RpcRequestError(code, message, dataCode);
}

function parseParams<T>(schema: ZodType<T>, params: JsonValue | undefined): T {
  return schema.parse(params ?? {});
}

function extractId(value: unknown): JsonRpcId | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ||
    (typeof id === "number" && Number.isSafeInteger(id))
    ? id
    : null;
}

function boundMessage(message: string): string {
  const normalized = message.replace(/[\r\n]+/gu, " ");
  return normalized.length <= 1_000
    ? normalized
    : `${normalized.slice(0, 997)}...`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function applicationErrorCode(error: unknown): string {
  return error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "APPLICATION_ERROR";
}
