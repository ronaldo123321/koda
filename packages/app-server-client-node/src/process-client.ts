import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";

import {
  APP_SERVER_PROTOCOL_VERSION,
  approvalResolveParamsSchema,
  approvalResolveResultSchema,
  approvalGrantsListParamsSchema,
  approvalGrantsListResultSchema,
  approvalGrantsRevokeAllParamsSchema,
  approvalGrantsRevokeAllResultSchema,
  approvalGrantsRevokeParamsSchema,
  approvalGrantsRevokeResultSchema,
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
  initializeResultSchema,
  jsonValueSchema,
  planAcceptanceResolveParamsSchema,
  planAcceptanceResolveResultSchema,
  planGetParamsSchema,
  planGetResultSchema,
  settingsGetParamsSchema,
  settingsGetResultSchema,
  settingsUpdateParamsSchema,
  settingsUpdateResultSchema,
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
  turnStartParamsSchema,
  turnStartResultSchema,
  type ApprovalResolveParams,
  type ApprovalResolveResult,
  type ApprovalGrantsListParams,
  type ApprovalGrantsListResult,
  type ApprovalGrantsRevokeAllParams,
  type ApprovalGrantsRevokeAllResult,
  type ApprovalGrantsRevokeParams,
  type ApprovalGrantsRevokeResult,
  type ArtifactReadParams,
  type ArtifactReadResult,
  type ContextInstructionReadParams,
  type ContextInstructionReadResult,
  type ContextReadParams,
  type ContextReadResult,
  type ExtensionCatalogParams,
  type ExtensionCatalogResult,
  type ExtensionReadParams,
  type ExtensionReadResult,
  type InitializeResult,
  type PlanAcceptanceResolveParams,
  type PlanAcceptanceResolveResult,
  type PlanGetParams,
  type PlanGetResult,
  type SettingsGetParams,
  type SettingsGetResult,
  type SettingsUpdateParams,
  type SettingsUpdateResult,
  type ThreadGetParams,
  type ThreadGetResult,
  type ThreadEventsParams,
  type ThreadEventsResult,
  type ThreadArtifactsParams,
  type ThreadArtifactsResult,
  type ThreadContextParams,
  type ThreadContextResult,
  type ThreadExtensionsParams,
  type ThreadExtensionsResult,
  type ThreadListParams,
  type ThreadListResult,
  type ThreadSearchParams,
  type ThreadSearchResult,
  type TurnCancelParams,
  type TurnCancelResult,
  type TurnStartParams,
  type TurnStartResult,
} from "@koda/protocol";

import {
  AppServerRpcConnection,
  type AppServerNotification,
} from "./connection.js";
import { AppServerClientError, clientErrorMessage } from "./errors.js";

const DEFAULT_MAXIMUM_STDERR_BYTES = 65_536;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;

export interface NodeAppServerClientOptions {
  command?: string;
  args?: readonly string[];
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  maximumLineBytes?: number;
  maximumStderrBytes?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
}

export interface AppServerClientApi {
  readonly initialization: InitializeResult;
  listThreads(params?: ThreadListParams): Promise<ThreadListResult>;
  getThread(params: ThreadGetParams): Promise<ThreadGetResult>;
  readThreadEvents(params: ThreadEventsParams): Promise<ThreadEventsResult>;
  listThreadArtifacts(
    params: ThreadArtifactsParams,
  ): Promise<ThreadArtifactsResult>;
  readArtifact(params: ArtifactReadParams): Promise<ArtifactReadResult>;
  listThreadContexts(params: ThreadContextParams): Promise<ThreadContextResult>;
  readContext(params: ContextReadParams): Promise<ContextReadResult>;
  readContextInstruction(
    params: ContextInstructionReadParams,
  ): Promise<ContextInstructionReadResult>;
  inspectExtensionCatalog(
    params: ExtensionCatalogParams,
  ): Promise<ExtensionCatalogResult>;
  readExtensionSource(
    params: ExtensionReadParams,
  ): Promise<ExtensionReadResult>;
  inspectThreadExtensions(
    params: ThreadExtensionsParams,
  ): Promise<ThreadExtensionsResult>;
  searchThreads(params: ThreadSearchParams): Promise<ThreadSearchResult>;
  getPlan(params: PlanGetParams): Promise<PlanGetResult>;
  getRuntimeSettings(params: SettingsGetParams): Promise<SettingsGetResult>;
  updateRuntimeSettings(
    params: SettingsUpdateParams,
  ): Promise<SettingsUpdateResult>;
  startTurn(params: TurnStartParams): Promise<TurnStartResult>;
  cancelTurn(params: TurnCancelParams): Promise<TurnCancelResult>;
  resolveApproval(
    params: ApprovalResolveParams,
  ): Promise<ApprovalResolveResult>;
  resolvePlanAcceptance(
    params: PlanAcceptanceResolveParams,
  ): Promise<PlanAcceptanceResolveResult>;
  listApprovalGrants(
    params: ApprovalGrantsListParams,
  ): Promise<ApprovalGrantsListResult>;
  revokeApprovalGrant(
    params: ApprovalGrantsRevokeParams,
  ): Promise<ApprovalGrantsRevokeResult>;
  revokeAllApprovalGrants(
    params: ApprovalGrantsRevokeAllParams,
  ): Promise<ApprovalGrantsRevokeAllResult>;
  onNotification(
    listener: (notification: AppServerNotification) => void,
  ): () => void;
  onDisconnect(listener: (error?: Error) => void): () => void;
  diagnostics(): string;
  shutdown(): Promise<void>;
}

export class NodeAppServerClient implements AppServerClientApi {
  public readonly initialization: InitializeResult;
  private readonly maximumStderrBytes: number;
  private readonly shutdownTimeoutMs: number;
  private stderrBuffer = Buffer.alloc(0);
  private shutdownPromise: Promise<void> | undefined;
  private closing = false;

  private constructor(
    private readonly child: ChildProcess,
    private readonly connection: AppServerRpcConnection,
    initialization: InitializeResult,
    maximumStderrBytes: number,
    shutdownTimeoutMs: number,
  ) {
    this.initialization = initialization;
    this.maximumStderrBytes = maximumStderrBytes;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.child.stderr?.on("data", this.captureStderr);
    this.child.once("error", this.handleChildError);
    this.child.once("close", this.handleChildClose);
  }

  public static async connect(
    options: NodeAppServerClientOptions = {},
  ): Promise<NodeAppServerClient> {
    const maximumStderrBytes =
      options.maximumStderrBytes ?? DEFAULT_MAXIMUM_STDERR_BYTES;
    const shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    assertPositiveSafeInteger(maximumStderrBytes, "maximumStderrBytes");
    assertPositiveSafeInteger(shutdownTimeoutMs, "shutdownTimeoutMs");
    const command = options.command ?? process.execPath;
    const args = options.args ?? [resolveDefaultAppServerEntry()];
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.environment ?? process.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      throw new AppServerClientError(
        "APP_SERVER_START_FAILED",
        `Could not start app-server: ${clientErrorMessage(error)}`,
        { cause: error },
      );
    }
    if (child.stdin === null || child.stdout === null) {
      child.kill();
      throw new AppServerClientError(
        "APP_SERVER_START_FAILED",
        "Could not create app-server protocol pipes.",
      );
    }
    const connection = new AppServerRpcConnection({
      input: child.stdout,
      output: child.stdin,
      ...(options.maximumLineBytes === undefined
        ? {}
        : { maximumLineBytes: options.maximumLineBytes }),
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
    });
    try {
      await waitForSpawn(child);
      const initialization = await connection.request(
        "initialize",
        jsonValueSchema.parse({
          protocolVersion: APP_SERVER_PROTOCOL_VERSION,
          client: {
            name: options.clientName ?? "koda-tui",
            ...(options.clientVersion === undefined
              ? {}
              : { version: options.clientVersion }),
          },
        }),
        initializeResultSchema,
      );
      return new NodeAppServerClient(
        child,
        connection,
        initialization,
        maximumStderrBytes,
        shutdownTimeoutMs,
      );
    } catch (error) {
      connection.close();
      await terminateChild(child, shutdownTimeoutMs);
      if (error instanceof AppServerClientError) {
        throw error;
      }
      throw new AppServerClientError(
        "APP_SERVER_START_FAILED",
        `Could not initialize app-server: ${clientErrorMessage(error)}`,
        { cause: error },
      );
    }
  }

  public listThreads(params: ThreadListParams = {}): Promise<ThreadListResult> {
    return this.connection.request(
      "thread/list",
      jsonValueSchema.parse(threadListParamsSchema.parse(params)),
      threadListResultSchema,
    );
  }

  public getThread(params: ThreadGetParams): Promise<ThreadGetResult> {
    return this.connection.request(
      "thread/get",
      jsonValueSchema.parse(threadGetParamsSchema.parse(params)),
      threadGetResultSchema,
    );
  }

  public readThreadEvents(
    params: ThreadEventsParams,
  ): Promise<ThreadEventsResult> {
    return this.connection.request(
      "thread/events",
      jsonValueSchema.parse(threadEventsParamsSchema.parse(params)),
      threadEventsResultSchema,
    );
  }

  public listThreadArtifacts(
    params: ThreadArtifactsParams,
  ): Promise<ThreadArtifactsResult> {
    return this.connection.request(
      "thread/artifacts",
      jsonValueSchema.parse(threadArtifactsParamsSchema.parse(params)),
      threadArtifactsResultSchema,
    );
  }

  public readArtifact(params: ArtifactReadParams): Promise<ArtifactReadResult> {
    return this.connection.request(
      "artifact/read",
      jsonValueSchema.parse(artifactReadParamsSchema.parse(params)),
      artifactReadResultSchema,
    );
  }

  public listThreadContexts(
    params: ThreadContextParams,
  ): Promise<ThreadContextResult> {
    return this.connection.request(
      "thread/context",
      jsonValueSchema.parse(threadContextParamsSchema.parse(params)),
      threadContextResultSchema,
    );
  }

  public readContext(params: ContextReadParams): Promise<ContextReadResult> {
    return this.connection.request(
      "context/read",
      jsonValueSchema.parse(contextReadParamsSchema.parse(params)),
      contextReadResultSchema,
    );
  }

  public readContextInstruction(
    params: ContextInstructionReadParams,
  ): Promise<ContextInstructionReadResult> {
    return this.connection.request(
      "context/instruction/read",
      jsonValueSchema.parse(contextInstructionReadParamsSchema.parse(params)),
      contextInstructionReadResultSchema,
    );
  }

  public inspectExtensionCatalog(
    params: ExtensionCatalogParams,
  ): Promise<ExtensionCatalogResult> {
    return this.connection.request(
      "extension/catalog",
      jsonValueSchema.parse(extensionCatalogParamsSchema.parse(params)),
      extensionCatalogResultSchema,
    );
  }

  public readExtensionSource(
    params: ExtensionReadParams,
  ): Promise<ExtensionReadResult> {
    return this.connection.request(
      "extension/read",
      jsonValueSchema.parse(extensionReadParamsSchema.parse(params)),
      extensionReadResultSchema,
    );
  }

  public inspectThreadExtensions(
    params: ThreadExtensionsParams,
  ): Promise<ThreadExtensionsResult> {
    return this.connection.request(
      "thread/extensions",
      jsonValueSchema.parse(threadExtensionsParamsSchema.parse(params)),
      threadExtensionsResultSchema,
    );
  }

  public searchThreads(
    params: ThreadSearchParams,
  ): Promise<ThreadSearchResult> {
    return this.connection.request(
      "thread/search",
      jsonValueSchema.parse(threadSearchParamsSchema.parse(params)),
      threadSearchResultSchema,
    );
  }

  public getPlan(params: PlanGetParams): Promise<PlanGetResult> {
    return this.connection.request(
      "plan/get",
      jsonValueSchema.parse(planGetParamsSchema.parse(params)),
      planGetResultSchema,
    );
  }

  public getRuntimeSettings(
    params: SettingsGetParams,
  ): Promise<SettingsGetResult> {
    return this.connection.request(
      "settings/get",
      jsonValueSchema.parse(settingsGetParamsSchema.parse(params)),
      settingsGetResultSchema,
    );
  }

  public updateRuntimeSettings(
    params: SettingsUpdateParams,
  ): Promise<SettingsUpdateResult> {
    return this.connection.request(
      "settings/update",
      jsonValueSchema.parse(settingsUpdateParamsSchema.parse(params)),
      settingsUpdateResultSchema,
    );
  }

  public startTurn(params: TurnStartParams): Promise<TurnStartResult> {
    return this.connection.request(
      "turn/start",
      jsonValueSchema.parse(turnStartParamsSchema.parse(params)),
      turnStartResultSchema,
    );
  }

  public cancelTurn(params: TurnCancelParams): Promise<TurnCancelResult> {
    return this.connection.request(
      "turn/cancel",
      jsonValueSchema.parse(turnCancelParamsSchema.parse(params)),
      turnCancelResultSchema,
    );
  }

  public resolveApproval(
    params: ApprovalResolveParams,
  ): Promise<ApprovalResolveResult> {
    return this.connection.request(
      "approval/resolve",
      jsonValueSchema.parse(approvalResolveParamsSchema.parse(params)),
      approvalResolveResultSchema,
    );
  }

  public resolvePlanAcceptance(
    params: PlanAcceptanceResolveParams,
  ): Promise<PlanAcceptanceResolveResult> {
    return this.connection.request(
      "plan/acceptance/resolve",
      jsonValueSchema.parse(planAcceptanceResolveParamsSchema.parse(params)),
      planAcceptanceResolveResultSchema,
    );
  }

  public listApprovalGrants(
    params: ApprovalGrantsListParams,
  ): Promise<ApprovalGrantsListResult> {
    return this.connection.request(
      "approval/grants/list",
      jsonValueSchema.parse(approvalGrantsListParamsSchema.parse(params)),
      approvalGrantsListResultSchema,
    );
  }

  public revokeApprovalGrant(
    params: ApprovalGrantsRevokeParams,
  ): Promise<ApprovalGrantsRevokeResult> {
    return this.connection.request(
      "approval/grants/revoke",
      jsonValueSchema.parse(approvalGrantsRevokeParamsSchema.parse(params)),
      approvalGrantsRevokeResultSchema,
    );
  }

  public revokeAllApprovalGrants(
    params: ApprovalGrantsRevokeAllParams,
  ): Promise<ApprovalGrantsRevokeAllResult> {
    return this.connection.request(
      "approval/grants/revokeAll",
      jsonValueSchema.parse(approvalGrantsRevokeAllParamsSchema.parse(params)),
      approvalGrantsRevokeAllResultSchema,
    );
  }

  public onNotification(
    listener: (notification: AppServerNotification) => void,
  ): () => void {
    return this.connection.onNotification(listener);
  }

  public onDisconnect(listener: (error?: Error) => void): () => void {
    return this.connection.onDisconnect(listener);
  }

  public diagnostics(): string {
    return this.stderrBuffer.toString("utf8");
  }

  public shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownOnce();
    return this.shutdownPromise;
  }

  private readonly captureStderr = (chunk: Buffer | string): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.stderrBuffer = Buffer.concat([this.stderrBuffer, bytes]);
    if (this.stderrBuffer.byteLength > this.maximumStderrBytes) {
      this.stderrBuffer = this.stderrBuffer.subarray(
        this.stderrBuffer.byteLength - this.maximumStderrBytes,
      );
    }
  };

  private readonly handleChildError = (error: Error): void => {
    if (!this.closing) {
      this.connection.fail(
        new AppServerClientError(
          "APP_SERVER_CONNECTION_CLOSED",
          `App-server process failed: ${error.message}`,
          { cause: error },
        ),
      );
    }
  };

  private readonly handleChildClose = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    if (!this.closing) {
      this.connection.fail(
        new AppServerClientError(
          "APP_SERVER_CONNECTION_CLOSED",
          `App-server exited unexpectedly (${formatExit(code, signal)}).`,
        ),
      );
    }
  };

  private async shutdownOnce(): Promise<void> {
    this.closing = true;
    try {
      if (!this.connection.isClosed) {
        await this.connection.request(
          "shutdown",
          jsonValueSchema.parse({}),
          shutdownResultSchema,
          this.shutdownTimeoutMs,
        );
      }
    } catch (error) {
      await terminateChild(this.child, this.shutdownTimeoutMs);
      this.connection.close();
      throw new AppServerClientError(
        "APP_SERVER_SHUTDOWN_FAILED",
        `Could not shut down app-server cleanly: ${clientErrorMessage(error)}`,
        { cause: error },
      );
    }
    this.connection.close();
    this.child.stdin?.end();
    if (!(await waitForExit(this.child, this.shutdownTimeoutMs))) {
      await terminateChild(this.child, this.shutdownTimeoutMs);
    }
    this.detachChildListeners();
  }

  private detachChildListeners(): void {
    this.child.stderr?.removeListener("data", this.captureStderr);
    this.child.removeListener("error", this.handleChildError);
    this.child.removeListener("close", this.handleChildClose);
  }
}

function resolveDefaultAppServerEntry(): string {
  return createRequire(import.meta.url).resolve("@koda/app-server/main");
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(
        new AppServerClientError(
          "APP_SERVER_START_FAILED",
          `Could not start app-server: ${error.message}`,
          { cause: error },
        ),
      );
    };
    const cleanup = () => {
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

async function terminateChild(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (hasExited(child)) {
    return;
  }
  child.kill("SIGTERM");
  if (await waitForExit(child, timeoutMs)) {
    return;
  }
  child.kill("SIGKILL");
  await waitForExit(child, timeoutMs);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onClose = () => {
      cleanup();
      resolve(true);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(hasExited(child));
    }, timeoutMs);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("close", onClose);
    };
    child.once("close", onClose);
  });
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function formatExit(
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  return signal === null ? `code ${String(code)}` : `signal ${signal}`;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}
