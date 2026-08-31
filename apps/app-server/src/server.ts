import { createHash } from "node:crypto";

import {
  type ApplicationDiagnostic,
  type KodaApplication,
  type TurnHandle,
} from "@koda/app";
import {
  APP_SERVER_PROTOCOL_VERSION,
  APP_SERVER_RPC_ERROR_CODE,
  APPROVAL_GRANTS_RESULT_BUDGET_BYTES,
  PLAN_GET_RESULT_BUDGET_BYTES,
  ARTIFACT_READ_RESULT_BUDGET_BYTES,
  CONTEXT_DETAIL_RESULT_BUDGET_BYTES,
  CONTEXT_INSTRUCTION_READ_RESULT_BUDGET_BYTES,
  EXTENSION_CATALOG_RESULT_BUDGET_BYTES,
  EXTENSION_READ_RESULT_BUDGET_BYTES,
  RUNTIME_SETTINGS_RESULT_BUDGET_BYTES,
  THREAD_ARTIFACTS_RESULT_BUDGET_BYTES,
  THREAD_CONTEXT_RESULT_BUDGET_BYTES,
  THREAD_EXTENSIONS_RESULT_BUDGET_BYTES,
  THREAD_SEARCH_RESULT_BUDGET_BYTES,
  WORKSPACE_MUTATION_BACKUP_RESULT_BUDGET_BYTES,
  WORKSPACE_MUTATION_CONFLICTS_RESULT_BUDGET_BYTES,
  approvalResolveParamsSchema,
  approvalResolveResultSchema,
  approvalGrantsListParamsSchema,
  approvalGrantsListResultSchema,
  approvalGrantsRevokeAllParamsSchema,
  approvalGrantsRevokeAllResultSchema,
  approvalGrantsRevokeParamsSchema,
  approvalGrantsRevokeResultSchema,
  planAcceptanceResolveParamsSchema,
  planAcceptanceResolveResultSchema,
  planGetParamsSchema,
  planGetResultSchema,
  processAcquireInputParamsSchema,
  processAcquireInputResultSchema,
  processAttachParamsSchema,
  processAttachResultSchema,
  processDetachParamsSchema,
  processDetachResultSchema,
  processInputParamsSchema,
  processInputResultSchema,
  processListParamsSchema,
  processListResultSchema,
  processReadParamsSchema,
  processReadResultSchema,
  processResizeParamsSchema,
  processResizeResultSchema,
  processTerminateParamsSchema,
  processTerminateResultSchema,
  artifactReadParamsSchema,
  artifactReadResultSchema,
  contextInstructionReadParamsSchema,
  contextInstructionReadResultSchema,
  contextReadParamsSchema,
  contextReadResultSchema,
  extensionCatalogParamsSchema,
  extensionCatalogResultSchema,
  extensionReadParamsSchema,
  extensionReadResultSchema,
  initializeParamsSchema,
  initializeResultSchema,
  jsonRpcRequestSchema,
  jsonValueSchema,
  settingsGetParamsSchema,
  settingsGetResultSchema,
  settingsUpdateParamsSchema,
  settingsUpdateResultSchema,
  workspaceMutationBackupExportParamsSchema,
  workspaceMutationBackupExportResultSchema,
  workspaceMutationConflictGetParamsSchema,
  workspaceMutationConflictGetResultSchema,
  workspaceMutationConflictResolveParamsSchema,
  workspaceMutationConflictResolveResultSchema,
  workspaceMutationConflictsListParamsSchema,
  workspaceMutationConflictsListResultSchema,
  shutdownParamsSchema,
  shutdownResultSchema,
  threadEventsParamsSchema,
  threadEventsResultSchema,
  threadArtifactsParamsSchema,
  threadArtifactsResultSchema,
  threadContextParamsSchema,
  threadContextResultSchema,
  threadExtensionsParamsSchema,
  threadExtensionsResultSchema,
  threadGetParamsSchema,
  threadGetResultSchema,
  threadListParamsSchema,
  threadListResultSchema,
  threadSearchParamsSchema,
  threadSearchResultSchema,
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
import {
  InteractiveProcessError,
  NativeExecutorError,
  type InteractiveProcessService,
} from "@koda/runtime-node";
import { ZodError, type ZodType } from "zod";

import { PendingApprovalRegistry } from "./approval-registry.js";
import { PendingPlanAcceptanceRegistry } from "./plan-acceptance-registry.js";
import type { ProtocolMessageWriter } from "./message-writer.js";

export interface KodaAppServerOptions {
  application: KodaApplication;
  writer: ProtocolMessageWriter;
  serverVersion?: string;
  diagnostic?(message: string): unknown | Promise<unknown>;
  fatal?(error: Error): unknown;
  planAcceptanceTimeoutMs?: number;
  interactiveProcessService?: InteractiveProcessService;
}

export class KodaAppServer {
  private readonly application: KodaApplication;
  private readonly writer: ProtocolMessageWriter;
  private readonly serverVersion: string;
  private readonly diagnostic: (message: string) => unknown | Promise<unknown>;
  private readonly fatal: (error: Error) => unknown;
  private readonly approvals = new PendingApprovalRegistry();
  private readonly planAcceptances: PendingPlanAcceptanceRegistry;
  private readonly interactiveProcessService:
    InteractiveProcessService | undefined;
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
    this.planAcceptances = new PendingPlanAcceptanceRegistry(
      options.planAcceptanceTimeoutMs,
    );
    this.interactiveProcessService = options.interactiveProcessService;
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
      case "thread/events":
        return this.readThreadEvents(request.params);
      case "thread/search":
        return this.searchThreads(request.params);
      case "thread/artifacts":
        return this.listThreadArtifacts(request.params);
      case "artifact/read":
        return this.readArtifact(request.params);
      case "thread/context":
        return this.listThreadContexts(request.params);
      case "plan/get":
        return this.getPlan(request.params);
      case "context/read":
        return this.readContext(request.params);
      case "context/instruction/read":
        return this.readContextInstruction(request.params);
      case "extension/catalog":
        return this.inspectExtensionCatalog(request.params);
      case "extension/read":
        return this.readExtensionSource(request.params);
      case "thread/extensions":
        return this.inspectThreadExtensions(request.params);
      case "settings/get":
        return this.getRuntimeSettings(request.params);
      case "settings/update":
        return this.updateRuntimeSettings(request.params);
      case "workspace/mutation/conflicts":
        return this.listWorkspaceMutationConflicts(request.params);
      case "workspace/mutation/conflict/get":
        return this.inspectWorkspaceMutationConflict(request.params);
      case "workspace/mutation/backup/export":
        return this.exportWorkspaceMutationBackup(request.params);
      case "workspace/mutation/conflict/resolve":
        return this.resolveWorkspaceMutationConflict(request.params);
      case "turn/start":
        return this.startTurn(request.params);
      case "turn/cancel":
        return this.cancelTurn(request.params);
      case "approval/resolve":
        return this.resolveApproval(request.params);
      case "plan/acceptance/resolve":
        return this.resolvePlanAcceptance(request.params);
      case "approval/grants/list":
        return this.listApprovalGrants(request.params);
      case "approval/grants/revoke":
        return this.revokeApprovalGrant(request.params);
      case "approval/grants/revokeAll":
        return this.revokeAllApprovalGrants(request.params);
      case "process/list":
        return this.listProcesses(request.params);
      case "process/attach":
        return this.attachProcess(request.params);
      case "process/read":
        return this.readProcess(request.params);
      case "process/acquire-input":
        return this.acquireProcessInput(request.params);
      case "process/input":
        return this.writeProcessInput(request.params);
      case "process/resize":
        return this.resizeProcess(request.params);
      case "process/detach":
        return this.detachProcess(request.params);
      case "process/terminate":
        return this.terminateProcess(request.params);
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
          threadEvents: true,
          threadSearch: true,
          bidirectionalThreadEvents: true,
          runtimeSettings: true,
          artifactInspection: true,
          contextInspection: true,
          multiFileChanges: true,
          patchDocuments: true,
          approvalGrants: true,
          planning: true,
          planCheckpoints: true,
          stageAcceptance: true,
          extensionInspection: true,
          skills: true,
          commandTemplates: true,
          dynamicToolCatalog: true,
          plugins: true,
          workspaceMutationRecovery: true,
          interactiveProcesses: this.interactiveProcessService !== undefined,
          secretEvidence: true,
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

  private async listProcesses(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(processListParamsSchema, params);
    return this.processResult(
      processListResultSchema,
      this.requireInteractiveProcesses().listProcesses({
        workspace: input.workspace,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
    );
  }

  private async attachProcess(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(processAttachParamsSchema, params);
    return this.processResult(
      processAttachResultSchema,
      this.requireInteractiveProcesses().attach({
        workspace: input.workspace,
        jobId: input.jobId,
        rows: input.rows,
        cols: input.cols,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      }),
    );
  }

  private async readProcess(params: JsonValue | undefined): Promise<JsonValue> {
    const input = parseParams(processReadParamsSchema, params);
    return this.processResult(
      processReadResultSchema,
      this.requireInteractiveProcesses().read(
        input.processSessionId,
        input.maxBytes,
      ),
    );
  }

  private async acquireProcessInput(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(processAcquireInputParamsSchema, params);
    return this.processResult(
      processAcquireInputResultSchema,
      this.requireInteractiveProcesses().acquireInput(input.processSessionId),
    );
  }

  private async writeProcessInput(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(processInputParamsSchema, params);
    return this.processResult(
      processInputResultSchema,
      this.requireInteractiveProcesses().writeInput(
        input.processSessionId,
        Buffer.from(input.dataBase64, "base64"),
      ),
    );
  }

  private async resizeProcess(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(processResizeParamsSchema, params);
    return this.processResult(
      processResizeResultSchema,
      this.requireInteractiveProcesses().resize(
        input.processSessionId,
        input.rows,
        input.cols,
      ),
    );
  }

  private async detachProcess(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(processDetachParamsSchema, params);
    await this.processOperation(() =>
      this.requireInteractiveProcesses().detach(input.processSessionId),
    );
    return jsonValueSchema.parse(
      processDetachResultSchema.parse({ detached: true }),
    );
  }

  private async terminateProcess(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(processTerminateParamsSchema, params);
    return this.processResult(
      processTerminateResultSchema,
      this.requireInteractiveProcesses().terminate(input),
    );
  }

  private requireInteractiveProcesses(): InteractiveProcessService {
    if (this.interactiveProcessService === undefined) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        "Interactive processes are unavailable because the native executor is not configured.",
        "INTERACTIVE_PROCESSES_UNAVAILABLE",
      );
    }
    return this.interactiveProcessService;
  }

  private async processResult<T>(
    schema: ZodType<T>,
    operation: Promise<T>,
  ): Promise<JsonValue> {
    return jsonValueSchema.parse(
      schema.parse(await this.processOperation(() => operation)),
    );
  }

  private async processOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof InteractiveProcessError) {
        throw rpcError(
          APP_SERVER_RPC_ERROR_CODE.APPLICATION,
          error.message,
          error.code,
        );
      }
      if (error instanceof NativeExecutorError) {
        throw rpcError(
          APP_SERVER_RPC_ERROR_CODE.APPLICATION,
          error.message,
          error.code,
        );
      }
      throw error;
    }
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

  private async readThreadEvents(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(threadEventsParamsSchema, params);
    try {
      const result = await this.application.readThreadEvents({
        threadId: input.threadId,
        ...(input.beforeSequence === undefined
          ? {}
          : { beforeSequence: input.beforeSequence }),
        ...(input.afterSequence === undefined
          ? {}
          : { afterSequence: input.afterSequence }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return jsonValueSchema.parse(threadEventsResultSchema.parse(result));
    } catch (error) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        errorMessage(error),
        applicationErrorCode(error),
      );
    }
  }

  private async listThreadArtifacts(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(threadArtifactsParamsSchema, params);
    try {
      const response = jsonValueSchema.parse(
        threadArtifactsResultSchema.parse(
          await this.application.listThreadArtifacts(input),
        ),
      );
      assertResultBudget(
        response,
        THREAD_ARTIFACTS_RESULT_BUDGET_BYTES,
        "THREAD_ARTIFACTS_RESULT_TOO_LARGE",
        "Thread artifact list",
      );
      return response;
    } catch (error) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        errorMessage(error),
        applicationErrorCode(error),
      );
    }
  }

  private async readArtifact(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(artifactReadParamsSchema, params);
    try {
      const response = jsonValueSchema.parse(
        artifactReadResultSchema.parse(
          await this.application.readArtifact(input),
        ),
      );
      assertResultBudget(
        response,
        ARTIFACT_READ_RESULT_BUDGET_BYTES,
        "ARTIFACT_READ_RESULT_TOO_LARGE",
        "Artifact read",
      );
      return response;
    } catch (error) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        errorMessage(error),
        applicationErrorCode(error),
      );
    }
  }

  private async listThreadContexts(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(threadContextParamsSchema, params);
    try {
      const response = jsonValueSchema.parse(
        threadContextResultSchema.parse(
          await this.application.listThreadContexts(input),
        ),
      );
      assertResultBudget(
        response,
        THREAD_CONTEXT_RESULT_BUDGET_BYTES,
        "CONTEXT_RESULT_TOO_LARGE",
        "Thread context list",
      );
      return response;
    } catch (error) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        errorMessage(error),
        applicationErrorCode(error),
      );
    }
  }

  private async readContext(params: JsonValue | undefined): Promise<JsonValue> {
    const input = parseParams(contextReadParamsSchema, params);
    try {
      const response = jsonValueSchema.parse(
        contextReadResultSchema.parse(
          await this.application.readContext(input),
        ),
      );
      assertResultBudget(
        response,
        CONTEXT_DETAIL_RESULT_BUDGET_BYTES,
        "CONTEXT_RESULT_TOO_LARGE",
        "Context detail",
      );
      return response;
    } catch (error) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        errorMessage(error),
        applicationErrorCode(error),
      );
    }
  }

  private async readContextInstruction(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(contextInstructionReadParamsSchema, params);
    try {
      const response = jsonValueSchema.parse(
        contextInstructionReadResultSchema.parse(
          await this.application.readContextInstruction(input),
        ),
      );
      assertResultBudget(
        response,
        CONTEXT_INSTRUCTION_READ_RESULT_BUDGET_BYTES,
        "CONTEXT_RESULT_TOO_LARGE",
        "Context instruction read",
      );
      return response;
    } catch (error) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        errorMessage(error),
        applicationErrorCode(error),
      );
    }
  }

  private async inspectExtensionCatalog(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(extensionCatalogParamsSchema, params);
    try {
      const response = jsonValueSchema.parse(
        extensionCatalogResultSchema.parse(
          await this.application.inspectExtensionCatalog(input),
        ),
      );
      assertResultBudget(
        response,
        EXTENSION_CATALOG_RESULT_BUDGET_BYTES,
        "EXTENSION_CATALOG_RESULT_TOO_LARGE",
        "Extension catalog",
      );
      return response;
    } catch (error) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        errorMessage(error),
        applicationErrorCode(error),
      );
    }
  }

  private async readExtensionSource(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(extensionReadParamsSchema, params);
    try {
      const response = jsonValueSchema.parse(
        extensionReadResultSchema.parse(
          await this.application.readExtensionSource(input),
        ),
      );
      assertResultBudget(
        response,
        EXTENSION_READ_RESULT_BUDGET_BYTES,
        "EXTENSION_READ_RESULT_TOO_LARGE",
        "Extension source read",
      );
      return response;
    } catch (error) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        errorMessage(error),
        applicationErrorCode(error),
      );
    }
  }

  private async inspectThreadExtensions(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(threadExtensionsParamsSchema, params);
    try {
      const response = jsonValueSchema.parse(
        threadExtensionsResultSchema.parse(
          await this.application.inspectThreadExtensions(input),
        ),
      );
      assertResultBudget(
        response,
        THREAD_EXTENSIONS_RESULT_BUDGET_BYTES,
        "THREAD_EXTENSIONS_RESULT_TOO_LARGE",
        "Thread extension snapshot",
      );
      return response;
    } catch (error) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        errorMessage(error),
        applicationErrorCode(error),
      );
    }
  }

  private async searchThreads(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(threadSearchParamsSchema, params);
    try {
      const result = await this.application.searchThreads({
        workspace: input.workspace,
        query: input.query,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      const response = jsonValueSchema.parse(
        threadSearchResultSchema.parse({
          ...result.value,
          diagnostics: result.diagnostics,
          ...(result.recovery === undefined
            ? {}
            : { recovery: result.recovery }),
        }),
      );
      if (
        Buffer.byteLength(JSON.stringify(response), "utf8") >
        THREAD_SEARCH_RESULT_BUDGET_BYTES
      ) {
        throw new AppServerResultError(
          "THREAD_SEARCH_RESULT_TOO_LARGE",
          `Thread search result exceeds the ${THREAD_SEARCH_RESULT_BUDGET_BYTES}-byte response budget.`,
        );
      }
      return response;
    } catch (error) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        errorMessage(error),
        applicationErrorCode(error),
      );
    }
  }

  private async getRuntimeSettings(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(settingsGetParamsSchema, params);
    try {
      const response = jsonValueSchema.parse(
        settingsGetResultSchema.parse(
          await this.application.getRuntimeSettings(input.workspace),
        ),
      );
      assertSettingsResultBudget(response);
      return response;
    } catch (error) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        errorMessage(error),
        applicationErrorCode(error),
      );
    }
  }

  private async getPlan(params: JsonValue | undefined): Promise<JsonValue> {
    const input = parseParams(planGetParamsSchema, params);
    try {
      const response = jsonValueSchema.parse(
        planGetResultSchema.parse(await this.application.getPlan(input)),
      );
      assertResultBudget(
        response,
        PLAN_GET_RESULT_BUDGET_BYTES,
        "PLAN_GET_RESULT_TOO_LARGE",
        "Plan inspection",
      );
      return response;
    } catch (error) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        errorMessage(error),
        applicationErrorCode(error),
      );
    }
  }

  private async updateRuntimeSettings(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(settingsUpdateParamsSchema, params);
    try {
      const response = jsonValueSchema.parse(
        settingsUpdateResultSchema.parse(
          await this.application.updateRuntimeSettings(input),
        ),
      );
      assertSettingsResultBudget(response);
      return response;
    } catch (error) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        errorMessage(error),
        applicationErrorCode(error),
      );
    }
  }

  private async listWorkspaceMutationConflicts(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(
      workspaceMutationConflictsListParamsSchema,
      params,
    );
    try {
      const response = jsonValueSchema.parse(
        workspaceMutationConflictsListResultSchema.parse(
          await this.application.listWorkspaceMutationConflicts(
            input.workspace,
          ),
        ),
      );
      assertResultBudget(
        response,
        WORKSPACE_MUTATION_CONFLICTS_RESULT_BUDGET_BYTES,
        "WORKSPACE_MUTATION_CONFLICTS_RESULT_TOO_LARGE",
        "Workspace mutation conflict list",
      );
      return response;
    } catch (error) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        errorMessage(error),
        applicationErrorCode(error),
      );
    }
  }

  private async inspectWorkspaceMutationConflict(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(workspaceMutationConflictGetParamsSchema, params);
    try {
      const response = jsonValueSchema.parse(
        workspaceMutationConflictGetResultSchema.parse(
          await this.application.inspectWorkspaceMutationConflict(input),
        ),
      );
      assertResultBudget(
        response,
        WORKSPACE_MUTATION_CONFLICTS_RESULT_BUDGET_BYTES,
        "WORKSPACE_MUTATION_CONFLICT_RESULT_TOO_LARGE",
        "Workspace mutation conflict",
      );
      return response;
    } catch (error) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        errorMessage(error),
        applicationErrorCode(error),
      );
    }
  }

  private async exportWorkspaceMutationBackup(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(
      workspaceMutationBackupExportParamsSchema,
      params,
    );
    try {
      const result =
        await this.application.exportWorkspaceMutationBackup(input);
      const response = jsonValueSchema.parse(
        workspaceMutationBackupExportResultSchema.parse({
          workspace: result.workspace,
          conflictId: result.conflictId,
          operationIndex: result.operationIndex,
          sha256: createHash("sha256").update(result.bytes).digest("hex"),
          bytes: result.bytes.byteLength,
          contentBase64: result.bytes.toString("base64"),
        }),
      );
      assertResultBudget(
        response,
        WORKSPACE_MUTATION_BACKUP_RESULT_BUDGET_BYTES,
        "WORKSPACE_MUTATION_BACKUP_RESULT_TOO_LARGE",
        "Workspace mutation backup",
      );
      return response;
    } catch (error) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        errorMessage(error),
        applicationErrorCode(error),
      );
    }
  }

  private async resolveWorkspaceMutationConflict(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(
      workspaceMutationConflictResolveParamsSchema,
      params,
    );
    try {
      const result =
        await this.application.resolveWorkspaceMutationConflict(input);
      return jsonValueSchema.parse(
        workspaceMutationConflictResolveResultSchema.parse({
          workspace: result.workspace,
          conflictId: result.receipt.conflictId,
          resolution: result.receipt.resolution,
          stateToken: result.receipt.stateToken,
          resolvedAt: result.receipt.resolvedAt,
          audit: result.audit,
          acknowledged: result.acknowledged,
        }),
      );
    } catch (error) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        errorMessage(error),
        applicationErrorCode(error),
      );
    }
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
              if (event.type === "plan.acceptance_requested") {
                this.planAcceptances.preregister({
                  threadId: event.threadId,
                  turnId: event.turnId,
                  ...event.payload,
                });
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
          planAcceptances: this.planAcceptances.broker(),
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
    this.planAcceptances.rejectTurn(input.turnId, reason);
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
      ...(input.grant === undefined ? {} : { grant: input.grant }),
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

  private resolvePlanAcceptance(params: JsonValue | undefined): JsonValue {
    const input = parseParams(planAcceptanceResolveParamsSchema, params);
    const handle = this.activeTurns.get(input.turnId);
    if (handle === undefined || handle.threadId !== input.threadId) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.TURN_NOT_FOUND,
        `Turn '${input.turnId}' is not active for Thread '${input.threadId}'.`,
        "TURN_NOT_FOUND",
      );
    }
    const resolution = this.planAcceptances.resolve(input);
    if (resolution === "not_found") {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.PLAN_ACCEPTANCE_NOT_FOUND,
        `Plan acceptance '${input.callId}' is not pending.`,
        "PLAN_ACCEPTANCE_NOT_PENDING",
      );
    }
    if (resolution === "already_resolved") {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.PLAN_ACCEPTANCE_ALREADY_RESOLVED,
        `Plan acceptance '${input.callId}' was already resolved.`,
        "PLAN_ACCEPTANCE_NOT_PENDING",
      );
    }
    if (resolution === "stale") {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.PLAN_ACCEPTANCE_STALE,
        `Plan acceptance '${input.callId}' targets stale Plan identity.`,
        "PLAN_ACCEPTANCE_STALE",
      );
    }
    return jsonValueSchema.parse(
      planAcceptanceResolveResultSchema.parse({ accepted: true }),
    );
  }

  private async listApprovalGrants(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(approvalGrantsListParamsSchema, params);
    try {
      const response = jsonValueSchema.parse(
        approvalGrantsListResultSchema.parse(
          await this.application.listApprovalGrants(input.workspace),
        ),
      );
      assertResultBudget(
        response,
        APPROVAL_GRANTS_RESULT_BUDGET_BYTES,
        "APPROVAL_GRANTS_RESULT_TOO_LARGE",
        "Approval grant list",
      );
      return response;
    } catch (error) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        errorMessage(error),
        applicationErrorCode(error),
      );
    }
  }

  private async revokeApprovalGrant(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(approvalGrantsRevokeParamsSchema, params);
    try {
      return jsonValueSchema.parse(
        approvalGrantsRevokeResultSchema.parse({
          revoked: await this.application.revokeApprovalGrant(
            input.workspace,
            input.grantId,
          ),
        }),
      );
    } catch (error) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        errorMessage(error),
        applicationErrorCode(error),
      );
    }
  }

  private async revokeAllApprovalGrants(
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    const input = parseParams(approvalGrantsRevokeAllParamsSchema, params);
    try {
      return jsonValueSchema.parse(
        approvalGrantsRevokeAllResultSchema.parse({
          revokedCount: await this.application.revokeAllApprovalGrants(
            input.workspace,
          ),
        }),
      );
    } catch (error) {
      throw rpcError(
        APP_SERVER_RPC_ERROR_CODE.APPLICATION,
        errorMessage(error),
        applicationErrorCode(error),
      );
    }
  }

  private async monitorTurn(handle: TurnHandle): Promise<void> {
    try {
      const completion = await handle.completion;
      this.approvals.rejectTurn(
        handle.turnId,
        "The turn finished before approval resolved.",
      );
      this.planAcceptances.rejectTurn(
        handle.turnId,
        "The turn finished before Plan acceptance resolved.",
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
      this.planAcceptances.clearTurn(handle.turnId);
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
        this.planAcceptances.rejectTurn(handle.turnId, reason);
        completions.push(handle.completion);
      }
      await Promise.allSettled(completions);
      await Promise.allSettled([...this.turnMonitors.values()]);
      await this.interactiveProcessService?.close();
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
      this.planAcceptances.rejectTurn(handle.turnId, reason);
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

class AppServerResultError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppServerResultError";
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

function assertSettingsResultBudget(response: JsonValue): void {
  if (
    Buffer.byteLength(JSON.stringify(response), "utf8") >
    RUNTIME_SETTINGS_RESULT_BUDGET_BYTES
  ) {
    throw new AppServerResultError(
      "RUNTIME_SETTINGS_RESULT_TOO_LARGE",
      `Runtime settings result exceeds the ${RUNTIME_SETTINGS_RESULT_BUDGET_BYTES}-byte response budget.`,
    );
  }
}

function assertResultBudget(
  response: JsonValue,
  maximumBytes: number,
  code: string,
  label: string,
): void {
  if (Buffer.byteLength(JSON.stringify(response), "utf8") > maximumBytes) {
    throw new AppServerResultError(
      code,
      `${label} exceeds the ${maximumBytes}-byte response budget.`,
    );
  }
}
