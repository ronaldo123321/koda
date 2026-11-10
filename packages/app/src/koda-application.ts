import { TurnExecutionService } from "./turn-execution-service.js";
import {
  buildInstructions,
  completion,
  emitDiagnostic,
  errorMessage,
} from "./application-helpers.js";

import {
  ThreadQueryService,
  type ThreadListInput,
  type ThreadSearchInput,
  type ThreadSearchPage,
  type ThreadQueryResult,
} from "./thread-query-service.js";
export {
  type ThreadListInput,
  type ThreadSearchInput,
  type ThreadSearchPage,
  type ThreadQueryResult,
} from "./thread-query-service.js";
import {
  ThreadHistoryService,
  type ThreadEventsInput,
  type ThreadEventsPage,
} from "./thread-history-service.js";
export {
  ThreadHistoryError,
  type ThreadEventsInput,
  type ThreadEventsPage,
} from "./thread-history-service.js";

import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  TurnMailbox,
  digestContextItems,
  projectActiveContext,
  summarizeContextItemTypes,
  sha256CanonicalJson,
  type ApprovalBroker,
  type EventSink,
  type ItemIdFactory,
  type ModelProvider,
  type PlanAcceptanceBroker,
  type TurnMailboxEnqueueResult,
} from "@koda/agent-core";

import { loadPluginConfiguration } from "@koda/plugin-host-node";
import {
  ARTIFACT_READ_DEFAULT_BYTES,
  CONTEXT_INSTRUCTION_READ_DEFAULT_BYTES,
  THREAD_CONTEXT_DEFAULT_LIMIT,
  THREAD_CONTEXT_MAXIMUM_LIMIT,
  THREAD_ARTIFACTS_DEFAULT_LIMIT,
  THREAD_ARTIFACTS_MAXIMUM_LIMIT,
  extensionCatalogParamsSchema,
  extensionReadParamsSchema,
  executionPolicyConfigSchema,
  executionProfileSchema,
  itemIdSchema,
  modelProviderIdSchema,
  planStateItemSchema,
  runtimeSettingsModelSchema,
  threadIdSchema,
  threadExtensionsParamsSchema,
  turnIdSchema,
  type ConversationItem,
  type ApprovalGrantId,
  type ApprovalGrantRecord,
  type ContextInstructionReadParams,
  type ContextInstructionReadResult,
  type ContextInstructionSource,
  type ContextInstructionSummary,
  type ContextReadParams,
  type ContextReadResult,
  type ContextRequestDescriptor,
  type ContextUsageRecord,
  type ExtensionCatalogParams,
  type ExtensionCatalogResult,
  type ExtensionReadParams,
  type ExtensionReadResult,
  type ExecutionPolicyConfig,
  type ExecutionProfile,
  type ArtifactReadParams,
  type ArtifactReadResult,
  type ItemId,
  type PlanGetParams,
  type PlanGetResult,
  type PlanStateItem,
  type RuntimeProviderMetadata,
  type SecretCatalog,
  type SettingsGetResult,
  type SettingsUpdateParams,
  type SettingsUpdateResult,
  type AgentEvent,
  type ThreadId,
  type ThreadArtifactDescriptor,
  type ThreadArtifactsParams,
  type ThreadArtifactsResult,
  type ThreadContextParams,
  type ThreadContextResult,
  type ThreadExtensionsParams,
  type ThreadExtensionsResult,
  type TurnContextSnapshot,
  type TurnId,
} from "@koda/protocol";
import {
  BUILT_IN_PROVIDER_METADATA,
  createRegisteredProvider,
} from "@koda/providers";
import {
  ArtifactStore,
  HostEnvironmentSecretResolver,
  type InteractiveProcessService,
  ReadOnlyWorkspace,
  RepositoryInstructionError,
  ThreadRecoveryError,
  WorkspaceMutationCoordinator,
  WorkspaceMutationJournalStore,
  WorkspacePreferenceStore,
  WorkspacePreferenceStoreError,
  loadProjectCommandTemplates,
  loadProjectSkills,
  loadRepositoryInstructions,
  reconcileWorkspaceMutationResolutionAudit,
  recoverThread,
  SecretLeaseManager,
  SecretPolicyError,
  type ThreadMetadata,
  type WorkspaceMutationConflictResolution,
  type WorkspaceMutationConflictSnapshot,
  type WorkspaceMutationResolutionReceipt,
} from "@koda/runtime-node";

import { ApprovalGrantRegistry } from "./approval-grant-registry.js";
import { ChildRegistry } from "./child-registry.js";
import { type GitSource } from "./git-worktree.js";

import {
  ConfigurationError,
  parseLocalThreadId,
  resolveKodaHome,
  resolveRunConfiguration,
  type RunConfiguration,
} from "./config.js";

export interface StartTurnInput {
  approvalMode?: string;
  prompt: string;
  cwd?: string;
  model?: string;
  parentThreadId?: string;
  provider?: string;
  resume?: string;
  remoteEffects?: {
    workspaceMutations?: true;
    processExecution?: true;
    mcpServerIds?: readonly string[];
  };
}

export interface TurnClient {
  events: EventSink;
  approvals: ApprovalBroker;
  planAcceptances?: PlanAcceptanceBroker;
  diagnostic?(diagnostic: ApplicationDiagnostic): unknown | Promise<unknown>;
}

export interface ApplicationDiagnostic {
  level: "warning";
  code: string;
  message: string;
}

export interface TurnCompletion {
  threadId: ThreadId;
  turnId: TurnId;
  status: "completed" | "paused" | "cancelled" | "failed";
  exitCode: 0 | 1 | 130;
  error?: {
    code: string;
    message: string;
  };
}

export interface TurnHandle {
  threadId: ThreadId;
  turnId: TurnId;
  completion: Promise<TurnCompletion>;
  cancel(reason?: string): boolean;
  steer(message: string): TurnMailboxEnqueueResult;
}

export interface WorkspaceMutationConflictListResult {
  workspace: string;
  conflicts: WorkspaceMutationConflictSnapshot[];
}

export interface WorkspaceMutationConflictResult {
  workspace: string;
  conflict: WorkspaceMutationConflictSnapshot;
}

export interface WorkspaceMutationBackupResult {
  workspace: string;
  conflictId: string;
  operationIndex: number;
  bytes: Buffer;
}

export interface WorkspaceMutationResolutionResult {
  workspace: string;
  receipt: WorkspaceMutationResolutionReceipt;
  audit: {
    status: "reconciled" | "already_reconciled" | "deferred";
    message?: string;
  };
  acknowledged: boolean;
}

export class RuntimeSettingsError extends Error {
  public constructor(
    public readonly code: "INVALID_RUNTIME_SETTINGS" | "SETTINGS_CORRUPT",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeSettingsError";
  }
}

export class ArtifactInspectionError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ArtifactInspectionError";
  }
}

export class ContextInspectionError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ContextInspectionError";
  }
}

export class ApprovalGrantError extends Error {
  public constructor(
    public readonly code: "INVALID_APPROVAL_GRANT_WORKSPACE",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApprovalGrantError";
  }
}

export class PlanInspectionError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PlanInspectionError";
  }
}

export class ExtensionInspectionError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExtensionInspectionError";
  }
}

export interface KodaApplicationOptions {
  environment: NodeJS.ProcessEnv;
  processDirectory: string;
  dependencies?: KodaApplicationDependencies;
  approvalGrantRegistry?: ApprovalGrantRegistry;
  interactiveProcessService?: InteractiveProcessService;
  executionPolicy?: ExecutionPolicyConfig;
  secretCatalog?: SecretCatalog;
  remoteRestricted?: boolean;
  readOnlyChild?: boolean;
  worktreeChild?: { source: GitSource; path: string; parentThreadId: ThreadId };
}

export interface KodaApplicationDependencies {
  openWorkspace(root: string): Promise<ReadOnlyWorkspace>;
  createProvider(
    configuration: RunConfiguration,
    instructions: string,
  ): ModelProvider;
  createIds(resumeThreadId?: ThreadId): {
    threadId: ThreadId;
    turnId: TurnId;
    itemIds: ItemIdFactory;
  };
}

const productionDependencies: KodaApplicationDependencies = {
  openWorkspace: (root) => ReadOnlyWorkspace.open(root),
  createProvider: (configuration, instructions) =>
    createRegisteredProvider({
      provider: configuration.provider,
      apiKey: configuration.apiKey,
      model: configuration.model,
      instructions,
      maxOutputTokens: configuration.maxOutputTokens,
      ...(configuration.resumableStreams === undefined
        ? {}
        : { resumableStreams: configuration.resumableStreams }),
    }),
  createIds: (resumeThreadId) => ({
    threadId: resumeThreadId ?? threadIdSchema.parse(randomUUID()),
    turnId: turnIdSchema.parse(randomUUID()),
    itemIds: new RandomItemIdFactory(),
  }),
};

export class KodaApplication {
  private readonly threadQueries: ThreadQueryService;
  private readonly threadHistory: ThreadHistoryService;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly processDirectory: string;
  private readonly dependencies: KodaApplicationDependencies;
  private readonly approvalGrantRegistry: ApprovalGrantRegistry;
  private readonly interactiveProcessService:
    InteractiveProcessService | undefined;
  private readonly executionPolicyConfig: ExecutionPolicyConfig | undefined;
  private readonly executionProfile: ExecutionProfile | undefined;
  private readonly secretLeaseManager: SecretLeaseManager;
  private readonly remoteRestricted: boolean;
  private readonly readOnlyChild: boolean;
  private readonly worktreeChild: KodaApplicationOptions["worktreeChild"];
  private readonly children = new ChildRegistry();

  public get isRemoteRestricted(): boolean {
    return this.remoteRestricted;
  }

  public constructor(options: KodaApplicationOptions) {
    this.environment = options.environment;
    this.threadHistory = new ThreadHistoryService(() =>
      resolveKodaHome(this.environment),
    );
    this.processDirectory = options.processDirectory;
    this.threadQueries = new ThreadQueryService(
      () => resolveKodaHome(this.environment),
      this.processDirectory,
    );
    this.dependencies = options.dependencies ?? productionDependencies;
    this.readOnlyChild = options.readOnlyChild === true;
    this.worktreeChild = options.worktreeChild;
    if (this.readOnlyChild && this.worktreeChild !== undefined) {
      throw new ConfigurationError(
        "A child cannot be both read-only and worktree-write capable.",
      );
    }
    this.remoteRestricted =
      options.remoteRestricted === true || this.readOnlyChild;
    this.approvalGrantRegistry =
      options.approvalGrantRegistry ?? new ApprovalGrantRegistry();
    this.interactiveProcessService = options.interactiveProcessService;
    try {
      this.secretLeaseManager = new SecretLeaseManager(
        options.secretCatalog ?? { schema_version: 1, declarations: [] },
        new HostEnvironmentSecretResolver(options.environment),
        { targetEnvironment: options.environment },
      );
    } catch (error) {
      if (error instanceof SecretPolicyError) {
        throw new ConfigurationError(
          "Secret declaration configuration is invalid.",
        );
      }
      throw error;
    }
    if (options.executionPolicy !== undefined) {
      const parsed = executionPolicyConfigSchema.safeParse(
        options.executionPolicy,
      );
      if (!parsed.success) {
        throw new ConfigurationError(
          "Execution policy configuration is invalid.",
        );
      }
      this.executionPolicyConfig = Object.freeze({
        ...parsed.data,
        ...(parsed.data.resources === undefined
          ? {}
          : { resources: Object.freeze({ ...parsed.data.resources }) }),
      });
      this.executionProfile = undefined;
    } else {
      const configuredProfile =
        options.environment.KODA_EXECUTION_PROFILE?.trim() || "unconfined";
      const parsed = executionProfileSchema.safeParse(configuredProfile);
      if (!parsed.success) {
        throw new ConfigurationError(
          "KODA_EXECUTION_PROFILE must be one of: unconfined, read-only, workspace-write.",
        );
      }
      this.executionPolicyConfig = undefined;
      this.executionProfile = parsed.data;
    }
  }

  public startTurn(input: StartTurnInput, client: TurnClient): TurnHandle {
    return this.launchTurn(this.prepareTurn(input), client);
  }

  public async startTurnAfter(
    input: StartTurnInput,
    client: TurnClient,
    beforeStart: (ids: { threadId: ThreadId; turnId: TurnId }) => Promise<void>,
  ): Promise<TurnHandle> {
    const prepared = this.prepareTurn(input);
    await beforeStart({
      threadId: prepared.ids.threadId,
      turnId: prepared.ids.turnId,
    });
    return this.launchTurn(prepared, client);
  }

  private prepareTurn(input: StartTurnInput): {
    configuration: RunConfiguration;
    prompt: string;
    ids: ReturnType<KodaApplicationDependencies["createIds"]>;
    parentThreadId?: ThreadId;
    remoteEffects?: StartTurnInput["remoteEffects"];
  } {
    if (input.parentThreadId !== undefined && input.resume !== undefined) {
      throw new ConfigurationError(
        "A new child thread cannot also resume an existing thread.",
      );
    }
    const configuration = resolveRunConfiguration(
      {
        ...(input.approvalMode === undefined
          ? {}
          : { approvalMode: input.approvalMode }),
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        ...(input.resume === undefined ? {} : { resume: input.resume }),
      },
      this.environment,
      this.processDirectory,
    );
    const prompt = input.prompt.trim();
    if (prompt.length === 0) {
      throw new ConfigurationError("Prompt must not be empty.");
    }
    const remoteEffects = input.remoteEffects;
    if (
      remoteEffects !== undefined &&
      (!this.remoteRestricted ||
        this.readOnlyChild ||
        this.worktreeChild !== undefined ||
        remoteEffects === null ||
        typeof remoteEffects !== "object" ||
        (remoteEffects.workspaceMutations !== true &&
          remoteEffects.processExecution !== true &&
          remoteEffects.mcpServerIds === undefined) ||
        Object.keys(remoteEffects).some(
          (key) =>
            key !== "workspaceMutations" &&
            key !== "processExecution" &&
            key !== "mcpServerIds",
        ) ||
        (remoteEffects.workspaceMutations !== undefined &&
          remoteEffects.workspaceMutations !== true) ||
        (remoteEffects.processExecution !== undefined &&
          remoteEffects.processExecution !== true) ||
        (remoteEffects.mcpServerIds !== undefined &&
          (!Array.isArray(remoteEffects.mcpServerIds) ||
            remoteEffects.mcpServerIds.length === 0 ||
            remoteEffects.mcpServerIds.length > 16 ||
            new Set(remoteEffects.mcpServerIds).size !==
              remoteEffects.mcpServerIds.length ||
            remoteEffects.mcpServerIds.some(
              (id) =>
                typeof id !== "string" || !/^[a-z][a-z0-9_-]{0,23}$/u.test(id),
            ))))
    ) {
      throw new ConfigurationError("Remote effect scope is invalid.");
    }
    if (
      this.remoteRestricted &&
      configuration.approvalMode !==
        (remoteEffects === undefined ? "never" : "on-request")
    ) {
      throw new ConfigurationError(
        remoteEffects === undefined
          ? "Remote restricted turns require approval mode 'never'."
          : "Remote effectful turns require approval mode 'on-request'.",
      );
    }
    const ids = this.dependencies.createIds(configuration.resumeThreadId);
    const parentThreadId =
      input.parentThreadId === undefined
        ? undefined
        : parseLocalThreadId(input.parentThreadId);
    if (parentThreadId === ids.threadId) {
      throw new ConfigurationError("A thread cannot be its own parent.");
    }
    return {
      configuration,
      prompt,
      ids,
      ...(parentThreadId === undefined ? {} : { parentThreadId }),
      ...(remoteEffects === undefined
        ? {}
        : {
            remoteEffects: {
              ...remoteEffects,
              ...(remoteEffects.mcpServerIds === undefined
                ? {}
                : { mcpServerIds: [...remoteEffects.mcpServerIds] }),
            },
          }),
    };
  }

  private launchTurn(
    prepared: ReturnType<KodaApplication["prepareTurn"]>,
    client: TurnClient,
  ): TurnHandle {
    const { configuration, prompt, ids, parentThreadId, remoteEffects } =
      prepared;
    const controller = new AbortController();
    const mailbox = new TurnMailbox();
    const completion = this.executeTurn(
      configuration,
      prompt,
      ids,
      parentThreadId,
      remoteEffects,
      controller,
      mailbox,
      client,
    );
    void completion.then(
      () => mailbox.close(),
      () => mailbox.close(),
    );
    return {
      threadId: ids.threadId,
      turnId: ids.turnId,
      completion,
      cancel: (reason = "The turn was cancelled.") => {
        if (controller.signal.aborted) {
          return false;
        }
        controller.abort(reason);
        mailbox.close();
        return true;
      },
      steer: (message) => mailbox.enqueue(message),
    };
  }

  public listProviders(): readonly RuntimeProviderMetadata[] {
    return BUILT_IN_PROVIDER_METADATA.map((provider) => ({
      ...provider,
      configured:
        (this.environment[provider.credentialEnvironmentVariable]?.trim()
          .length ?? 0) > 0,
    }));
  }

  public async inspectExtensionCatalog(
    input: ExtensionCatalogParams,
  ): Promise<ExtensionCatalogResult> {
    const request = extensionCatalogParamsSchema.parse(input);
    const discovered = await this.discoverCurrentExtensions(request.workspace);
    const skills = discovered.skills.snapshots();
    const commandTemplates = discovered.commandTemplates.snapshots();
    const configuredPlugins = discovered.plugins.plugins.map((plugin) => ({
      pluginId: plugin.id,
      required: plugin.required,
      capabilities: [...plugin.capabilities],
      manifestSha256: plugin.manifestSha256,
    }));
    return {
      workspace: discovered.workspace,
      catalogSha256: sha256CanonicalJson({
        workspace: discovered.workspace,
        skills,
        commandTemplates,
        configuredPlugins,
      }),
      skills,
      commandTemplates,
      configuredPlugins,
    };
  }

  public async readExtensionSource(
    input: ExtensionReadParams,
  ): Promise<ExtensionReadResult> {
    const request = extensionReadParamsSchema.parse(input);
    const discovered = await this.discoverCurrentExtensions(request.workspace);
    if (request.kind === "skill") {
      const source = discovered.skills.sources.find(
        (candidate) => candidate.skillId === request.sourceId,
      );
      if (source === undefined) {
        throw new ExtensionInspectionError(
          "EXTENSION_SOURCE_NOT_FOUND",
          `Current Skill '${request.sourceId}' was not found in workspace '${discovered.workspace}'.`,
        );
      }
      return {
        workspace: discovered.workspace,
        kind: request.kind,
        sourceId: source.skillId,
        path: source.path,
        scope: source.scope,
        sha256: source.sha256,
        totalBytes: source.bytes,
        content: source.content,
      };
    }
    const source = discovered.commandTemplates.sources.find(
      (candidate) => candidate.templateId === request.sourceId,
    );
    if (source === undefined) {
      throw new ExtensionInspectionError(
        "EXTENSION_SOURCE_NOT_FOUND",
        `Current command template '${request.sourceId}' was not found in workspace '${discovered.workspace}'.`,
      );
    }
    return {
      workspace: discovered.workspace,
      kind: request.kind,
      sourceId: source.templateId,
      path: source.path,
      scope: source.scope,
      sha256: source.sha256,
      totalBytes: source.bytes,
      content: source.content,
    };
  }

  public async inspectThreadExtensions(
    input: ThreadExtensionsParams,
  ): Promise<ThreadExtensionsResult> {
    const request = threadExtensionsParamsSchema.parse(input);
    const authorized = await this.authorizedThreadContext(
      request.workspace,
      request.threadId,
    );
    try {
      recoverThread(
        { events: authorized.events, diagnostics: [] },
        authorized.threadId,
      );
    } catch (error) {
      throw new ExtensionInspectionError(
        error instanceof ThreadRecoveryError
          ? error.code
          : "THREAD_EXTENSION_RECOVERY_INVALID",
        errorMessage(error),
        { cause: error },
      );
    }
    const contexts = authorized.events.filter(
      (event) => event.type === "turn.context",
    );
    const selected =
      request.anchorSequence === undefined
        ? contexts.at(-1)
        : contexts.find((event) => event.sequence === request.anchorSequence);
    if (selected === undefined) {
      throw new ExtensionInspectionError(
        "THREAD_EXTENSION_SNAPSHOT_NOT_FOUND",
        request.anchorSequence === undefined
          ? `Thread '${authorized.threadId}' does not contain an extension snapshot.`
          : `Thread '${authorized.threadId}' does not contain a turn context at sequence ${request.anchorSequence}.`,
      );
    }
    return {
      workspace: authorized.workspace,
      threadId: authorized.threadId,
      turnId: selected.turnId,
      anchorSequence: selected.sequence,
      skills: [...selected.payload.skills],
      commandTemplates: [...selected.payload.commandTemplates],
      ...(selected.payload.toolCatalogGeneration === undefined
        ? {}
        : {
            toolCatalogGeneration: {
              ...selected.payload.toolCatalogGeneration,
            },
          }),
      plugins: [...selected.payload.plugins],
    };
  }

  public async listApprovalGrants(workspaceInput: string): Promise<{
    workspace: string;
    grants: ApprovalGrantRecord[];
  }> {
    const workspace =
      await this.canonicalApprovalGrantWorkspace(workspaceInput);
    return {
      workspace,
      grants: this.approvalGrantRegistry.list(workspace),
    };
  }

  public async revokeApprovalGrant(
    workspaceInput: string,
    grantId: ApprovalGrantId,
  ): Promise<boolean> {
    const workspace =
      await this.canonicalApprovalGrantWorkspace(workspaceInput);
    return this.approvalGrantRegistry.revoke(workspace, grantId);
  }

  public async revokeAllApprovalGrants(
    workspaceInput: string,
  ): Promise<number> {
    const workspace =
      await this.canonicalApprovalGrantWorkspace(workspaceInput);
    return this.approvalGrantRegistry.revokeAll(workspace);
  }

  public async getRuntimeSettings(
    workspaceInput: string,
  ): Promise<SettingsGetResult> {
    const workspace = await this.canonicalSettingsWorkspace(workspaceInput);
    try {
      const store = await WorkspacePreferenceStore.open(
        resolveKodaHome(this.environment),
      );
      return await store.get(workspace);
    } catch (error) {
      if (error instanceof WorkspacePreferenceStoreError) {
        throw error;
      }
      throw new RuntimeSettingsError(
        "SETTINGS_CORRUPT",
        "Could not read workspace runtime settings.",
        { cause: error },
      );
    }
  }

  public async updateRuntimeSettings(
    input: SettingsUpdateParams,
  ): Promise<SettingsUpdateResult> {
    const parsedProvider = modelProviderIdSchema.safeParse(input.provider);
    const parsedModel = runtimeSettingsModelSchema.safeParse(input.model);
    if (!parsedProvider.success || !parsedModel.success) {
      throw new RuntimeSettingsError(
        "INVALID_RUNTIME_SETTINGS",
        "Runtime provider or model settings are invalid.",
      );
    }
    const metadata = this.listProviders().find(
      (provider) => provider.id === parsedProvider.data,
    );
    if (metadata === undefined) {
      throw new RuntimeSettingsError(
        "INVALID_RUNTIME_SETTINGS",
        `Provider '${parsedProvider.data}' is not supported.`,
      );
    }
    const workspace = await this.canonicalSettingsWorkspace(input.workspace);
    try {
      const store = await WorkspacePreferenceStore.open(
        resolveKodaHome(this.environment),
      );
      return await store.update({
        workspace,
        provider: parsedProvider.data,
        model: parsedModel.data,
        expectedRevision: input.expectedRevision,
      });
    } catch (error) {
      if (error instanceof WorkspacePreferenceStoreError) {
        throw error;
      }
      throw new RuntimeSettingsError(
        "SETTINGS_CORRUPT",
        "Could not update workspace runtime settings.",
        { cause: error },
      );
    }
  }

  public async listWorkspaceMutationConflicts(
    workspaceInput: string,
  ): Promise<WorkspaceMutationConflictListResult> {
    const { workspace, journal, coordinator } =
      await this.openWorkspaceMutationJournal(workspaceInput);
    const conflicts = await coordinator.runExclusive(
      new AbortController().signal,
      () => journal.listConflicts(),
    );
    return { workspace: workspace.root, conflicts };
  }

  public async inspectWorkspaceMutationConflict(input: {
    workspace: string;
    conflictId: string;
  }): Promise<WorkspaceMutationConflictResult> {
    const { workspace, journal, coordinator } =
      await this.openWorkspaceMutationJournal(input.workspace);
    const conflict = await coordinator.runExclusive(
      new AbortController().signal,
      () => journal.inspectConflict(input.conflictId),
    );
    return { workspace: workspace.root, conflict };
  }

  public async exportWorkspaceMutationBackup(input: {
    workspace: string;
    conflictId: string;
    stateToken: string;
    operationIndex: number;
  }): Promise<WorkspaceMutationBackupResult> {
    const { workspace, journal, coordinator } =
      await this.openWorkspaceMutationJournal(input.workspace);
    const bytes = await coordinator.runExclusive(
      new AbortController().signal,
      () =>
        journal.exportConflictBackup(
          input.conflictId,
          input.stateToken,
          input.operationIndex,
        ),
    );
    return {
      workspace: workspace.root,
      conflictId: input.conflictId,
      operationIndex: input.operationIndex,
      bytes,
    };
  }

  public async resolveWorkspaceMutationConflict(input: {
    workspace: string;
    conflictId: string;
    stateToken: string;
    resolution: WorkspaceMutationConflictResolution;
  }): Promise<WorkspaceMutationResolutionResult> {
    const { workspace, journal, coordinator } =
      await this.openWorkspaceMutationJournal(input.workspace);
    const receipt = await coordinator.runExclusive(
      new AbortController().signal,
      () =>
        journal.resolveConflict({
          conflictId: input.conflictId,
          stateToken: input.stateToken,
          resolution: input.resolution,
        }),
    );
    const audit = await reconcileWorkspaceMutationResolutionAudit(
      resolveKodaHome(this.environment),
      receipt,
    );
    const acknowledged = audit.status !== "deferred";
    if (acknowledged) {
      await coordinator.runExclusive(new AbortController().signal, () =>
        journal.acknowledgeResolution(receipt),
      );
    }
    return {
      workspace: workspace.root,
      receipt,
      audit,
      acknowledged,
    };
  }

  public listThreads(
    input: ThreadListInput = {},
  ): Promise<ThreadQueryResult<ThreadMetadata[]>> {
    return this.threadQueries.listThreads(input);
  }

  public getThread(
    threadId: string,
  ): Promise<ThreadQueryResult<ThreadMetadata | undefined>> {
    return this.threadQueries.getThread(threadId);
  }

  public searchThreads(
    input: ThreadSearchInput,
  ): Promise<ThreadQueryResult<ThreadSearchPage>> {
    return this.threadQueries.searchThreads(input);
  }

  public readThreadEvents(input: ThreadEventsInput): Promise<ThreadEventsPage> {
    return this.threadHistory.readThreadEvents(input);
  }

  public async listThreadArtifacts(
    input: ThreadArtifactsParams,
  ): Promise<ThreadArtifactsResult> {
    const authorized = await this.authorizedThreadArtifacts(
      input.workspace,
      input.threadId,
    );
    const limit = input.limit ?? THREAD_ARTIFACTS_DEFAULT_LIMIT;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > THREAD_ARTIFACTS_MAXIMUM_LIMIT
    ) {
      throw new ArtifactInspectionError(
        "INVALID_ARTIFACT_LIMIT",
        `Artifact list limit must be between 1 and ${THREAD_ARTIFACTS_MAXIMUM_LIMIT}.`,
      );
    }
    if (
      input.beforeSequence !== undefined &&
      (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence < 0)
    ) {
      throw new ArtifactInspectionError(
        "INVALID_ARTIFACT_CURSOR",
        "Artifact list cursor must be a non-negative safe integer.",
      );
    }
    const available = authorized.artifacts.filter(
      (descriptor) =>
        input.beforeSequence === undefined ||
        descriptor.sequence < input.beforeSequence,
    );
    const artifacts = available.slice(0, limit);
    const hasEarlier = available.length > artifacts.length;
    return {
      workspace: authorized.workspace,
      threadId: authorized.threadId,
      artifacts,
      hasEarlier,
      ...(hasEarlier && artifacts.length > 0
        ? { nextBeforeSequence: artifacts.at(-1)?.sequence }
        : {}),
    };
  }

  public async readArtifact(
    input: ArtifactReadParams,
  ): Promise<ArtifactReadResult> {
    const authorized = await this.authorizedThreadArtifacts(
      input.workspace,
      input.threadId,
    );
    const descriptor = authorized.artifacts.find(
      (candidate) => candidate.artifact.id === input.artifactId,
    );
    if (descriptor === undefined) {
      throw new ArtifactInspectionError(
        "ARTIFACT_NOT_REFERENCED",
        `Artifact '${input.artifactId}' is not referenced by thread '${authorized.threadId}'.`,
      );
    }
    const store = await ArtifactStore.openReadOnly(
      join(resolveKodaHome(this.environment), "artifacts"),
    );
    const range = await store.readVerifiedTextRange(descriptor.artifact, {
      ...(input.beforeByte === undefined
        ? {}
        : { beforeByte: input.beforeByte }),
      ...(input.afterByte === undefined ? {} : { afterByte: input.afterByte }),
      maxBytes: input.maxBytes ?? ARTIFACT_READ_DEFAULT_BYTES,
    });
    return {
      workspace: authorized.workspace,
      threadId: authorized.threadId,
      artifact: range.artifact,
      content: range.content,
      startByte: range.startByte,
      endByte: range.endByte,
      totalBytes: range.totalBytes,
      hasEarlier: range.hasEarlier,
      hasLater: range.hasLater,
    };
  }

  public async listThreadContexts(
    input: ThreadContextParams,
  ): Promise<ThreadContextResult> {
    const authorized = await this.authorizedThreadContext(
      input.workspace,
      input.threadId,
    );
    const limit = input.limit ?? THREAD_CONTEXT_DEFAULT_LIMIT;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > THREAD_CONTEXT_MAXIMUM_LIMIT
    ) {
      throw new ContextInspectionError(
        "INVALID_CONTEXT_LIMIT",
        `Context request limit must be between 1 and ${THREAD_CONTEXT_MAXIMUM_LIMIT}.`,
      );
    }
    if (
      input.beforeSequence !== undefined &&
      (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence < 0)
    ) {
      throw new ContextInspectionError(
        "INVALID_CONTEXT_CURSOR",
        "Context request cursor must be a non-negative safe integer.",
      );
    }
    const available = buildContextRequestDescriptors(authorized.events).filter(
      (descriptor) =>
        input.beforeSequence === undefined ||
        descriptor.anchorSequence < input.beforeSequence,
    );
    const requests = available.slice(0, limit);
    const hasEarlier = available.length > requests.length;
    return {
      workspace: authorized.workspace,
      threadId: authorized.threadId,
      requests,
      hasEarlier,
      ...(hasEarlier && requests.length > 0
        ? { nextBeforeSequence: requests.at(-1)?.anchorSequence }
        : {}),
    };
  }

  public async getPlan(input: PlanGetParams): Promise<PlanGetResult> {
    const workspace = await this.canonicalPlanWorkspace(input.workspace);
    const threadId = parseLocalThreadId(input.threadId);
    const events = await this.threadHistory.readValidatedThreadLog(threadId);
    const contexts = events.filter((event) => event.type === "turn.context");
    if (contexts.length === 0) {
      throw new PlanInspectionError(
        "THREAD_EVENT_LOG_CORRUPT",
        `Thread '${threadId}' does not contain a durable workspace context.`,
      );
    }
    if (contexts.some((event) => event.payload.workspaceRoot !== workspace)) {
      throw new PlanInspectionError(
        "THREAD_WORKSPACE_MISMATCH",
        `Thread '${threadId}' does not belong to workspace '${workspace}'.`,
      );
    }
    let recovered;
    try {
      recovered = recoverThread({ events, diagnostics: [] }, threadId);
    } catch (error) {
      throw new PlanInspectionError(
        error instanceof ThreadRecoveryError
          ? error.code
          : "PLAN_RECOVERY_INVALID",
        errorMessage(error),
        { cause: error },
      );
    }
    return {
      workspace,
      threadId,
      ...(recovered.plan === undefined ? {} : { plan: recovered.plan }),
      ...(recovered.checkpoint === undefined
        ? {}
        : { checkpoint: recovered.checkpoint }),
      recovery: {
        previousTurnId: recovered.previousTurnId,
        previousStatus: recovered.previousStatus,
        needsRevalidation: recovered.planNeedsRevalidation,
        uncertainToolCalls: recovered.uncertainToolCalls.map((call) => ({
          callId: call.callId,
          name: call.name,
          ...(call.effect === undefined ? {} : { effect: call.effect }),
        })),
      },
    };
  }

  public async readContext(
    input: ContextReadParams,
  ): Promise<ContextReadResult> {
    const authorized = await this.authorizedThreadContext(
      input.workspace,
      input.threadId,
    );
    const descriptors = buildContextRequestDescriptors(authorized.events);
    const request = descriptors.find(
      (descriptor) => descriptor.anchorSequence === input.anchorSequence,
    );
    if (request === undefined) {
      throw new ContextInspectionError(
        "CONTEXT_SNAPSHOT_NOT_FOUND",
        `Context request ${input.anchorSequence} was not found in thread '${authorized.threadId}'.`,
      );
    }
    const turnContext = governingTurnContext(
      authorized.events,
      request.anchorSequence,
      request.turnId,
    );
    const usage = matchingUsage(authorized.events, request);
    const instructionInspection = await inspectCurrentInstructions({
      workspace: authorized.workspace,
      threadId: authorized.threadId,
      anchorSequence: request.anchorSequence,
      turnContext,
    });

    if (!request.precise) {
      const legacyItems = recordedItemsBefore(
        authorized.events,
        request.anchorSequence,
      );
      const active = projectActiveContext(legacyItems);
      const compaction = active.find((item) => item.type === "compaction");
      return {
        workspace: authorized.workspace,
        threadId: authorized.threadId,
        request,
        turnContext,
        ...(usage === undefined ? {} : { usage }),
        ...(compaction === undefined ? {} : { compaction }),
        instructions: instructionInspection.summary,
      };
    }

    const prepared = authorized.events.find(
      (event) =>
        event.sequence === request.anchorSequence &&
        event.type === "context.prepared",
    );
    if (prepared?.type !== "context.prepared") {
      throw new ContextInspectionError(
        "CONTEXT_SNAPSHOT_CORRUPT",
        `Precise context request ${request.anchorSequence} has no prepared event.`,
      );
    }
    const recordedItems = recordedItemsBefore(
      authorized.events,
      request.anchorSequence,
    );
    const planState = reconstructPreparedPlanState(authorized.events, prepared);
    const active = projectActiveContext(
      planState === undefined ? recordedItems : [...recordedItems, planState],
    );
    const reconstructedTypes = summarizeContextItemTypes(active);
    const reconstructedSha256 = digestContextItems(active);
    if (
      active.length !== prepared.payload.activeItemCount ||
      JSON.stringify(reconstructedTypes) !==
        JSON.stringify(prepared.payload.activeItemTypes) ||
      reconstructedSha256 !== prepared.payload.activeItemsSha256
    ) {
      throw new ContextInspectionError(
        "CONTEXT_SNAPSHOT_CORRUPT",
        `Context request ${request.anchorSequence} does not match its durable Item history.`,
      );
    }
    const compaction =
      prepared.payload.compactionItemId === undefined
        ? undefined
        : active.find(
            (item) =>
              item.type === "compaction" &&
              item.id === prepared.payload.compactionItemId,
          );
    if (
      prepared.payload.compactionItemId !== undefined &&
      compaction?.type !== "compaction"
    ) {
      throw new ContextInspectionError(
        "CONTEXT_SNAPSHOT_CORRUPT",
        `Context request ${request.anchorSequence} references a missing Compaction Item.`,
      );
    }
    return {
      workspace: authorized.workspace,
      threadId: authorized.threadId,
      request,
      turnContext,
      telemetry: prepared.payload,
      ...(usage === undefined ? {} : { usage }),
      reconstruction: {
        activeItemCount: active.length,
        activeItemTypes: reconstructedTypes,
        activeItemsSha256: reconstructedSha256,
        valid: true,
      },
      ...(compaction?.type === "compaction" ? { compaction } : {}),
      instructions: instructionInspection.summary,
    };
  }

  public async readContextInstruction(
    input: ContextInstructionReadParams,
  ): Promise<ContextInstructionReadResult> {
    const authorized = await this.authorizedThreadContext(
      input.workspace,
      input.threadId,
    );
    const request = buildContextRequestDescriptors(authorized.events).find(
      (descriptor) => descriptor.anchorSequence === input.anchorSequence,
    );
    if (request === undefined) {
      throw new ContextInspectionError(
        "CONTEXT_SNAPSHOT_NOT_FOUND",
        `Context request ${input.anchorSequence} was not found in thread '${authorized.threadId}'.`,
      );
    }
    const turnContext = governingTurnContext(
      authorized.events,
      request.anchorSequence,
      request.turnId,
    );
    let instructionInspection: CurrentInstructionInspection;
    try {
      instructionInspection = await inspectCurrentInstructions({
        workspace: authorized.workspace,
        threadId: authorized.threadId,
        anchorSequence: request.anchorSequence,
        turnContext,
      });
    } catch (error) {
      if (
        error instanceof RepositoryInstructionError &&
        error.code === "INSTRUCTION_READ_FAILED"
      ) {
        throw new ContextInspectionError(
          "CONTEXT_INSTRUCTION_CHANGED_DURING_READ",
          "Repository instructions changed while the requested source was being read.",
          { cause: error },
        );
      }
      throw error;
    }
    const source = instructionInspection.readable.get(input.sourceId);
    if (source === undefined) {
      throw new ContextInspectionError(
        "CONTEXT_INSTRUCTION_NOT_FOUND",
        "The instruction source is unavailable for this context request.",
      );
    }
    const range = readUtf8Range(source.content, {
      ...(input.beforeByte === undefined
        ? {}
        : { beforeByte: input.beforeByte }),
      ...(input.afterByte === undefined ? {} : { afterByte: input.afterByte }),
      maxBytes: input.maxBytes ?? CONTEXT_INSTRUCTION_READ_DEFAULT_BYTES,
    });
    return {
      workspace: authorized.workspace,
      threadId: authorized.threadId,
      anchorSequence: request.anchorSequence,
      sourceId: input.sourceId,
      path: source.path,
      ...range,
    };
  }

  private async executeTurn(
    configuration: RunConfiguration,
    prompt: string,
    ids: {
      threadId: ThreadId;
      turnId: TurnId;
      itemIds: ItemIdFactory;
    },
    parentThreadId: ThreadId | undefined,
    remoteEffects: StartTurnInput["remoteEffects"],
    controller: AbortController,
    mailbox: TurnMailbox,
    client: TurnClient,
  ): Promise<TurnCompletion> {
    return new TurnExecutionService({
      threadHistory: this.threadHistory,
      environment: this.environment,
      processDirectory: this.processDirectory,
      dependencies: this.dependencies,
      approvalGrantRegistry: this.approvalGrantRegistry,
      interactiveProcessService: this.interactiveProcessService,
      executionPolicyConfig: this.executionPolicyConfig,
      executionProfile: this.executionProfile,
      secretLeaseManager: this.secretLeaseManager,
      remoteRestricted: this.remoteRestricted,
      readOnlyChild: this.readOnlyChild,
      worktreeChild: this.worktreeChild,
      children: this.children,
      refreshThreadMetadata: this.refreshThreadMetadata.bind(this),
      createApplication: (options) => new KodaApplication(options),
    }).execute(
      configuration,
      prompt,
      ids,
      parentThreadId,
      remoteEffects,
      controller,
      mailbox,
      client,
    );
  }

  private async refreshThreadMetadata(
    configuration: RunConfiguration,
    threadId: ThreadId,
    client: TurnClient,
  ): Promise<void> {
    try {
      const refresh = await this.threadQueries.refreshThread(
        configuration.kodaHome,
        threadId,
        async (recovery) => {
          await emitDiagnostic(client, {
            level: "warning",
            code: "METADATA_DATABASE_REBUILT",
            message: `Rebuilt a corrupt metadata database; preserved it at ${recovery.databaseBackup}.`,
          });
        },
      );
      for (const diagnostic of refresh.diagnostics) {
        await emitDiagnostic(client, {
          level: "warning",
          code: "METADATA_INDEX_DIAGNOSTIC",
          message: `${diagnostic.logFile}: ${diagnostic.message}`,
        });
      }
    } catch (error) {
      await emitDiagnostic(client, {
        level: "warning",
        code: "METADATA_REFRESH_FAILED",
        message: errorMessage(error),
      });
    }
  }

  private async openWorkspaceMutationJournal(workspaceInput: string) {
    const workspace = await this.dependencies.openWorkspace(
      resolve(this.processDirectory, workspaceInput),
    );
    const kodaHome = resolveKodaHome(this.environment);
    const journal = await WorkspaceMutationJournalStore.open(
      kodaHome,
      workspace.root,
    );
    const coordinator = await WorkspaceMutationCoordinator.open(
      kodaHome,
      workspace.root,
    );
    return { workspace, journal, coordinator };
  }

  private async discoverCurrentExtensions(workspaceInput: string) {
    const workspace = await this.canonicalExtensionWorkspace(workspaceInput);
    const skills = await loadProjectSkills(workspace);
    const commandTemplates = await loadProjectCommandTemplates(workspace);
    const plugins = await loadPluginConfiguration({
      environment: this.environment,
      kodaHome: resolveKodaHome(this.environment),
      processDirectory: this.processDirectory,
    });
    return { workspace, skills, commandTemplates, plugins };
  }

  private async authorizedThreadArtifacts(
    workspaceInput: string,
    threadIdInput: string,
  ): Promise<{
    workspace: string;
    threadId: ThreadId;
    artifacts: ThreadArtifactDescriptor[];
  }> {
    const workspace = await this.canonicalArtifactWorkspace(workspaceInput);
    const threadId = parseLocalThreadId(threadIdInput);
    const events = await this.threadHistory.readValidatedThreadLog(threadId);
    const contexts = events.filter((event) => event.type === "turn.context");
    if (contexts.length === 0) {
      throw new ArtifactInspectionError(
        "THREAD_EVENT_LOG_CORRUPT",
        `Thread '${threadId}' does not contain a durable workspace context.`,
      );
    }
    if (contexts.some((event) => event.payload.workspaceRoot !== workspace)) {
      throw new ArtifactInspectionError(
        "THREAD_WORKSPACE_MISMATCH",
        `Thread '${threadId}' does not belong to workspace '${workspace}'.`,
      );
    }

    const references = new Map<string, ThreadArtifactDescriptor>();
    const artifacts: ThreadArtifactDescriptor[] = [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== "artifact.recorded") {
        continue;
      }
      const existing = references.get(event.payload.artifact.id);
      if (existing !== undefined) {
        if (
          existing.artifact.sha256 !== event.payload.artifact.sha256 ||
          existing.artifact.bytes !== event.payload.artifact.bytes ||
          existing.artifact.mediaType !== event.payload.artifact.mediaType
        ) {
          throw new ArtifactInspectionError(
            "THREAD_EVENT_LOG_CORRUPT",
            `Thread '${threadId}' contains inconsistent references for artifact '${event.payload.artifact.id}'.`,
          );
        }
        continue;
      }
      const descriptor = {
        sequence: event.sequence,
        callId: event.payload.callId,
        name: event.payload.name,
        artifact: event.payload.artifact,
      } satisfies ThreadArtifactDescriptor;
      references.set(descriptor.artifact.id, descriptor);
      artifacts.push(descriptor);
    }
    return { workspace, threadId, artifacts };
  }

  private async authorizedThreadContext(
    workspaceInput: string,
    threadIdInput: string,
  ): Promise<{
    workspace: string;
    threadId: ThreadId;
    events: AgentEvent[];
  }> {
    const workspace = await this.canonicalContextWorkspace(workspaceInput);
    const threadId = parseLocalThreadId(threadIdInput);
    const events = await this.threadHistory.readValidatedThreadLog(threadId);
    const contexts = events.filter((event) => event.type === "turn.context");
    if (contexts.length === 0) {
      throw new ContextInspectionError(
        "THREAD_EVENT_LOG_CORRUPT",
        `Thread '${threadId}' does not contain a durable workspace context.`,
      );
    }
    if (contexts.some((event) => event.payload.workspaceRoot !== workspace)) {
      throw new ContextInspectionError(
        "THREAD_WORKSPACE_MISMATCH",
        `Thread '${threadId}' does not belong to workspace '${workspace}'.`,
      );
    }
    return { workspace, threadId, events };
  }

  private async canonicalArtifactWorkspace(
    workspaceInput: string,
  ): Promise<string> {
    try {
      const workspace = await realpath(
        resolve(this.processDirectory, workspaceInput),
      );
      if (!(await stat(workspace)).isDirectory()) {
        throw new Error("Workspace is not a directory.");
      }
      return workspace;
    } catch (error) {
      throw new ArtifactInspectionError(
        "INVALID_ARTIFACT_WORKSPACE",
        `Workspace '${workspaceInput}' could not be resolved to an existing directory.`,
        { cause: error },
      );
    }
  }

  private async canonicalExtensionWorkspace(
    workspaceInput: string,
  ): Promise<string> {
    try {
      const workspace = await realpath(
        resolve(this.processDirectory, workspaceInput),
      );
      if (!(await stat(workspace)).isDirectory()) {
        throw new Error("Workspace is not a directory.");
      }
      return workspace;
    } catch (error) {
      throw new ExtensionInspectionError(
        "INVALID_EXTENSION_WORKSPACE",
        `Workspace '${workspaceInput}' could not be resolved to an existing directory.`,
        { cause: error },
      );
    }
  }

  private async canonicalContextWorkspace(
    workspaceInput: string,
  ): Promise<string> {
    try {
      const workspace = await realpath(
        resolve(this.processDirectory, workspaceInput),
      );
      if (!(await stat(workspace)).isDirectory()) {
        throw new Error("Workspace is not a directory.");
      }
      return workspace;
    } catch (error) {
      throw new ContextInspectionError(
        "INVALID_CONTEXT_WORKSPACE",
        `Workspace '${workspaceInput}' could not be resolved to an existing directory.`,
        { cause: error },
      );
    }
  }

  private async canonicalPlanWorkspace(
    workspaceInput: string,
  ): Promise<string> {
    try {
      const workspace = await realpath(
        resolve(this.processDirectory, workspaceInput),
      );
      if (!(await stat(workspace)).isDirectory()) {
        throw new Error("Workspace is not a directory.");
      }
      return workspace;
    } catch (error) {
      throw new PlanInspectionError(
        "INVALID_PLAN_WORKSPACE",
        `Workspace '${workspaceInput}' could not be resolved to an existing directory.`,
        { cause: error },
      );
    }
  }

  private async canonicalSettingsWorkspace(
    workspaceInput: string,
  ): Promise<string> {
    try {
      const workspace = await realpath(
        resolve(this.processDirectory, workspaceInput),
      );
      if (!(await stat(workspace)).isDirectory()) {
        throw new Error("Workspace is not a directory.");
      }
      return workspace;
    } catch (error) {
      throw new RuntimeSettingsError(
        "INVALID_RUNTIME_SETTINGS",
        `Workspace '${workspaceInput}' could not be resolved to an existing path.`,
        { cause: error },
      );
    }
  }

  private async canonicalApprovalGrantWorkspace(
    workspaceInput: string,
  ): Promise<string> {
    try {
      const workspace = await realpath(
        resolve(this.processDirectory, workspaceInput),
      );
      if (!(await stat(workspace)).isDirectory()) {
        throw new Error("Workspace is not a directory.");
      }
      return workspace;
    } catch (error) {
      throw new ApprovalGrantError(
        "INVALID_APPROVAL_GRANT_WORKSPACE",
        `Workspace '${workspaceInput}' could not be resolved to an existing directory.`,
        { cause: error },
      );
    }
  }
}

function buildContextRequestDescriptors(
  events: readonly AgentEvent[],
): ContextRequestDescriptor[] {
  const preciseKeys = new Set<string>();
  const descriptors: ContextRequestDescriptor[] = [];
  for (const event of events) {
    if (event.type !== "context.prepared") {
      continue;
    }
    const key = `${event.turnId}\0${event.payload.step}`;
    if (preciseKeys.has(key)) {
      throw new ContextInspectionError(
        "CONTEXT_SNAPSHOT_CORRUPT",
        `Thread contains duplicate prepared context for Turn '${event.turnId}' step ${event.payload.step}.`,
      );
    }
    preciseKeys.add(key);
    const turnContext = governingTurnContext(
      events,
      event.sequence,
      event.turnId,
    );
    const usage = findUsageEvent(events, event.turnId, event.payload.step);
    if (usage !== undefined && usage.sequence <= event.sequence) {
      throw new ContextInspectionError(
        "CONTEXT_SNAPSHOT_CORRUPT",
        `Usage for Turn '${event.turnId}' step ${event.payload.step} precedes its prepared context.`,
      );
    }
    descriptors.push({
      anchorSequence: event.sequence,
      turnId: event.turnId,
      step: event.payload.step,
      timestamp: event.timestamp,
      precise: true,
      provider: turnContext.provider,
      model: turnContext.model,
      estimatedInputTokens: event.payload.estimatedInputTokens,
      inputBudgetTokens: event.payload.inputBudgetTokens,
      ...(usage === undefined
        ? {}
        : { measuredInputTokens: usage.payload.usage.inputTokens }),
      activeItemCount: event.payload.activeItemCount,
      toolCount: event.payload.toolCount,
      ...(event.payload.compactionItemId === undefined
        ? {}
        : { compactionItemId: event.payload.compactionItemId }),
    });
  }
  for (const event of events) {
    if (
      event.type !== "model.usage" ||
      event.payload.purpose === "context_summary"
    ) {
      continue;
    }
    const key = `${event.turnId}\0${event.payload.step}`;
    if (preciseKeys.has(key)) {
      continue;
    }
    const turnContext = governingTurnContext(
      events,
      event.sequence,
      event.turnId,
    );
    descriptors.push({
      anchorSequence: event.sequence,
      turnId: event.turnId,
      step: event.payload.step,
      timestamp: event.timestamp,
      precise: false,
      provider: turnContext.provider,
      model: turnContext.model,
      measuredInputTokens: event.payload.usage.inputTokens,
    });
  }
  return descriptors.sort(
    (left, right) => right.anchorSequence - left.anchorSequence,
  );
}

function governingTurnContext(
  events: readonly AgentEvent[],
  anchorSequence: number,
  turnId: TurnId,
): TurnContextSnapshot {
  const contexts = events.filter(
    (event) =>
      event.sequence < anchorSequence &&
      event.turnId === turnId &&
      event.type === "turn.context",
  );
  if (contexts.length !== 1 || contexts[0]?.type !== "turn.context") {
    throw new ContextInspectionError(
      "CONTEXT_SNAPSHOT_CORRUPT",
      `Context request ${anchorSequence} requires exactly one preceding Turn context.`,
    );
  }
  return contexts[0].payload;
}

function findUsageEvent(
  events: readonly AgentEvent[],
  turnId: TurnId,
  step: number,
): Extract<AgentEvent, { type: "model.usage" }> | undefined {
  const matches = events.filter(
    (event): event is Extract<AgentEvent, { type: "model.usage" }> =>
      event.type === "model.usage" &&
      event.payload.purpose !== "context_summary" &&
      event.turnId === turnId &&
      event.payload.step === step,
  );
  if (matches.length > 1) {
    throw new ContextInspectionError(
      "CONTEXT_SNAPSHOT_CORRUPT",
      `Turn '${turnId}' step ${step} contains duplicate Usage records.`,
    );
  }
  return matches[0];
}

function matchingUsage(
  events: readonly AgentEvent[],
  request: ContextRequestDescriptor,
): ContextUsageRecord | undefined {
  const usage = findUsageEvent(events, request.turnId, request.step);
  if (usage === undefined) {
    return undefined;
  }
  return {
    sequence: usage.sequence,
    ...(usage.payload.responseId === undefined
      ? {}
      : { responseId: usage.payload.responseId }),
    usage: usage.payload.usage,
  };
}

function recordedItemsBefore(
  events: readonly AgentEvent[],
  anchorSequence: number,
): ConversationItem[] {
  return events.flatMap((event) =>
    event.sequence < anchorSequence && event.type === "item.recorded"
      ? [event.payload.item]
      : [],
  );
}

function reconstructPreparedPlanState(
  events: readonly AgentEvent[],
  prepared: Extract<AgentEvent, { type: "context.prepared" }>,
): PlanStateItem | undefined {
  const reference = prepared.payload.planState;
  if (reference === undefined) {
    return undefined;
  }
  const planEvent = [...events]
    .reverse()
    .find(
      (event) =>
        event.sequence < prepared.sequence &&
        event.type === "plan.updated" &&
        event.payload.plan.planId === reference.planId &&
        event.payload.plan.revision === reference.planRevision,
    );
  if (planEvent?.type !== "plan.updated") {
    throw new ContextInspectionError(
      "CONTEXT_SNAPSHOT_CORRUPT",
      `Context request ${prepared.sequence} references an unavailable Plan revision.`,
    );
  }
  const checkpointEvent =
    reference.checkpointId === undefined
      ? undefined
      : [...events]
          .reverse()
          .find(
            (event) =>
              event.sequence < prepared.sequence &&
              event.type === "plan.checkpointed" &&
              event.payload.checkpoint.checkpointId === reference.checkpointId,
          );
  if (
    reference.checkpointId !== undefined &&
    checkpointEvent?.type !== "plan.checkpointed"
  ) {
    throw new ContextInspectionError(
      "CONTEXT_SNAPSHOT_CORRUPT",
      `Context request ${prepared.sequence} references an unavailable Plan checkpoint.`,
    );
  }
  return planStateItemSchema.parse({
    type: "plan_state",
    id: reference.itemId,
    plan: planEvent.payload.plan,
    ...(checkpointEvent?.type !== "plan.checkpointed"
      ? {}
      : { checkpoint: checkpointEvent.payload.checkpoint }),
    needsRevalidation: reference.needsRevalidation,
    checkpointRecommended: reference.checkpointRecommended,
  });
}

interface CurrentInstructionInspection {
  summary: ContextInstructionSummary;
  readable: Map<string, { path: string; content: string }>;
}

async function inspectCurrentInstructions(input: {
  workspace: string;
  threadId: ThreadId;
  anchorSequence: number;
  turnContext: TurnContextSnapshot;
}): Promise<CurrentInstructionInspection> {
  const current = await loadRepositoryInstructions(input.workspace);
  const currentSkills = await loadProjectSkills(input.workspace);
  const currentCommandTemplates = await loadProjectCommandTemplates(
    input.workspace,
  );
  const effectiveContent = buildInstructions(
    input.workspace,
    current,
    currentSkills,
  );
  const effectiveBytes = Buffer.byteLength(effectiveContent, "utf8");
  const effectiveSha256 = createHash("sha256")
    .update(effectiveContent, "utf8")
    .digest("hex");
  const readable = new Map<string, { path: string; content: string }>();
  const effectiveSourceId = contextInstructionSourceId({
    threadId: input.threadId,
    anchorSequence: input.anchorSequence,
    kind: "effective",
    path: "effective",
  });
  readable.set(effectiveSourceId, {
    path: "effective",
    content: effectiveContent,
  });
  const sources: ContextInstructionSource[] = [
    {
      kind: "effective",
      sourceId: effectiveSourceId,
      path: "effective",
      scope: ".",
      status:
        effectiveSha256 === input.turnContext.instructionsSha256
          ? "unchanged"
          : "modified",
      historical: { sha256: input.turnContext.instructionsSha256 },
      current: { bytes: effectiveBytes, sha256: effectiveSha256 },
    },
  ];
  const historicalByPath = new Map(
    input.turnContext.repositoryInstructions.map((source) => [
      source.path,
      source,
    ]),
  );
  const currentByPath = new Map(
    current.sources.map((source) => [source.path, source]),
  );
  const paths = [
    ...new Set([...historicalByPath.keys(), ...currentByPath.keys()]),
  ].sort();
  for (const path of paths) {
    const historical = historicalByPath.get(path);
    const currentSource = currentByPath.get(path);
    if (currentSource === undefined && historical !== undefined) {
      sources.push({
        kind: "repository",
        path,
        scope: historical.scope,
        status: "missing",
        historical: {
          bytes: historical.bytes,
          sha256: historical.sha256,
        },
      });
      continue;
    }
    if (currentSource === undefined) {
      continue;
    }
    const sourceId = contextInstructionSourceId({
      threadId: input.threadId,
      anchorSequence: input.anchorSequence,
      kind: "repository",
      path,
    });
    readable.set(sourceId, { path, content: currentSource.content });
    const status =
      historical === undefined
        ? "added"
        : historical.scope === currentSource.scope &&
            historical.bytes === currentSource.bytes &&
            historical.sha256 === currentSource.sha256
          ? "unchanged"
          : "modified";
    sources.push({
      kind: "repository",
      sourceId,
      path,
      scope: currentSource.scope,
      status,
      ...(historical === undefined
        ? {}
        : {
            historical: {
              bytes: historical.bytes,
              sha256: historical.sha256,
            },
          }),
      current: {
        bytes: currentSource.bytes,
        sha256: currentSource.sha256,
      },
    });
  }

  const historicalSkillsById = new Map(
    input.turnContext.skills.map((source) => [source.skillId, source]),
  );
  const currentSkillsById = new Map(
    currentSkills.sources.map((source) => [source.skillId, source]),
  );
  const skillIds = [
    ...new Set([...historicalSkillsById.keys(), ...currentSkillsById.keys()]),
  ].sort();
  for (const skillId of skillIds) {
    const historical = historicalSkillsById.get(skillId);
    const currentSource = currentSkillsById.get(skillId);
    if (currentSource === undefined && historical !== undefined) {
      sources.push({
        kind: "skill",
        path: historical.path,
        scope: historical.scope,
        status: "missing",
        historical: {
          bytes: historical.bytes,
          sha256: historical.sha256,
        },
      });
      continue;
    }
    if (currentSource === undefined) {
      continue;
    }
    const sourceId = contextInstructionSourceId({
      threadId: input.threadId,
      anchorSequence: input.anchorSequence,
      kind: "skill",
      path: currentSource.path,
    });
    readable.set(sourceId, {
      path: currentSource.path,
      content: currentSource.content,
    });
    const status =
      historical === undefined
        ? "added"
        : historical.path === currentSource.path &&
            historical.scope === currentSource.scope &&
            historical.name === currentSource.name &&
            historical.description === currentSource.description &&
            historical.bytes === currentSource.bytes &&
            historical.sha256 === currentSource.sha256
          ? "unchanged"
          : "modified";
    sources.push({
      kind: "skill",
      sourceId,
      path: currentSource.path,
      scope: currentSource.scope,
      status,
      ...(historical === undefined
        ? {}
        : {
            historical: {
              bytes: historical.bytes,
              sha256: historical.sha256,
            },
          }),
      current: {
        bytes: currentSource.bytes,
        sha256: currentSource.sha256,
      },
    });
  }
  const historicalCommandTemplatesById = new Map(
    input.turnContext.commandTemplates.map((source) => [
      source.templateId,
      source,
    ]),
  );
  const currentCommandTemplatesById = new Map(
    currentCommandTemplates.sources.map((source) => [
      source.templateId,
      source,
    ]),
  );
  const commandTemplateIds = [
    ...new Set([
      ...historicalCommandTemplatesById.keys(),
      ...currentCommandTemplatesById.keys(),
    ]),
  ].sort();
  for (const templateId of commandTemplateIds) {
    const historical = historicalCommandTemplatesById.get(templateId);
    const currentSource = currentCommandTemplatesById.get(templateId);
    if (currentSource === undefined && historical !== undefined) {
      sources.push({
        kind: "command_template",
        path: historical.path,
        scope: historical.scope,
        status: "missing",
        historical: {
          bytes: historical.bytes,
          sha256: historical.sha256,
        },
      });
      continue;
    }
    if (currentSource === undefined) {
      continue;
    }
    const sourceId = contextInstructionSourceId({
      threadId: input.threadId,
      anchorSequence: input.anchorSequence,
      kind: "command_template",
      path: currentSource.path,
    });
    readable.set(sourceId, {
      path: currentSource.path,
      content: currentSource.content,
    });
    const status =
      historical === undefined
        ? "added"
        : historical.path === currentSource.path &&
            historical.scope === currentSource.scope &&
            historical.name === currentSource.name &&
            historical.description === currentSource.description &&
            historical.selector === currentSource.selector &&
            historical.bytes === currentSource.bytes &&
            historical.sha256 === currentSource.sha256 &&
            JSON.stringify(historical.parameters) ===
              JSON.stringify(currentSource.parameters)
          ? "unchanged"
          : "modified";
    sources.push({
      kind: "command_template",
      sourceId,
      path: currentSource.path,
      scope: currentSource.scope,
      status,
      ...(historical === undefined
        ? {}
        : {
            historical: {
              bytes: historical.bytes,
              sha256: historical.sha256,
            },
          }),
      current: {
        bytes: currentSource.bytes,
        sha256: currentSource.sha256,
      },
    });
  }
  return {
    summary: {
      historicalEffectiveSha256: input.turnContext.instructionsSha256,
      currentEffectiveSha256: effectiveSha256,
      effectiveMatchesHistorical:
        effectiveSha256 === input.turnContext.instructionsSha256,
      sources,
    },
    readable,
  };
}

function contextInstructionSourceId(input: {
  threadId: ThreadId;
  anchorSequence: number;
  kind: "effective" | "repository" | "skill" | "command_template";
  path: string;
}): string {
  const digest = createHash("sha256")
    .update(
      `${input.threadId}\0${input.anchorSequence}\0${input.kind}\0${input.path}`,
      "utf8",
    )
    .digest("hex");
  return `ctxsrc:${digest}`;
}

function readUtf8Range(
  content: string,
  options: { beforeByte?: number; afterByte?: number; maxBytes: number },
): {
  content: string;
  startByte: number;
  endByte: number;
  totalBytes: number;
  hasEarlier: boolean;
  hasLater: boolean;
} {
  if (options.beforeByte !== undefined && options.afterByte !== undefined) {
    throw new ContextInspectionError(
      "INVALID_CONTEXT_CURSOR",
      "Instruction byte cursors are mutually exclusive.",
    );
  }
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 4 ||
    options.maxBytes > 65_536
  ) {
    throw new ContextInspectionError(
      "INVALID_CONTEXT_CURSOR",
      "Instruction maxBytes must be a safe integer between 4 and 65536.",
    );
  }
  const bytes = Buffer.from(content, "utf8");
  const cursor = options.beforeByte ?? options.afterByte ?? 0;
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    cursor > bytes.byteLength ||
    !isUtf8Boundary(bytes, cursor)
  ) {
    throw new ContextInspectionError(
      "INVALID_CONTEXT_CURSOR",
      "Instruction byte cursor is outside the source or not a UTF-8 boundary.",
    );
  }
  let startByte: number;
  let endByte: number;
  if (options.beforeByte !== undefined) {
    endByte = cursor;
    startByte = Math.max(0, endByte - options.maxBytes);
    while (startByte < endByte && !isUtf8Boundary(bytes, startByte)) {
      startByte += 1;
    }
  } else {
    startByte = cursor;
    endByte = Math.min(bytes.byteLength, startByte + options.maxBytes);
    while (endByte > startByte && !isUtf8Boundary(bytes, endByte)) {
      endByte -= 1;
    }
  }
  return {
    content: new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(startByte, endByte),
    ),
    startByte,
    endByte,
    totalBytes: bytes.byteLength,
    hasEarlier: startByte > 0,
    hasLater: endByte < bytes.byteLength,
  };
}

function isUtf8Boundary(bytes: Buffer, offset: number): boolean {
  return (
    offset === 0 ||
    offset === bytes.byteLength ||
    ((bytes[offset] ?? 0) & 0xc0) !== 0x80
  );
}

class RandomItemIdFactory implements ItemIdFactory {
  public next(): ItemId {
    return itemIdSchema.parse(randomUUID());
  }
}
