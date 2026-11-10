import { ChildTaskService } from "./child-task-service.js";

import { ThreadHistoryService } from "./thread-history-service.js";
import { createHash } from "node:crypto";

import { join } from "node:path";
import {
  AgentLoop,
  ContextEngine,
  createModelContextSummarizer,
  CONTEXT_SUMMARY_INSTRUCTIONS,
  EffectToolPolicy,
  FanoutEventSink,
  PlanRuntimeState,
  ToolRegistry,
  TurnMailbox,
  estimateTextTokens,
  type ItemIdFactory,
  type ToolPolicy,
} from "@koda/agent-core";
import { McpTurnSession } from "@koda/mcp-client-node";
import { PluginTurnSession, diffPluginSnapshots } from "@koda/plugin-host-node";
import {
  collectArtifactReferences,
  recoveryItemSchema,
  turnContextSnapshotSchema,
  type ConversationItem,
  type ExecutionPolicyConfig,
  type ExecutionProfile,
  type ThreadId,
  type TurnContextSnapshot,
  type TurnId,
} from "@koda/protocol";

import {
  ArtifactMaintenanceLease,
  ArtifactStore,
  JsonlEventStore,
  type InteractiveProcessService,
  NativeExecutorClient,
  ProjectNoteStore,
  ThreadLease,
  WorkspaceCommandRunner,
  WorkspaceMutationCoordinator,
  WorkspaceMutationJournalStore,
  assertResumeWorkspace,
  diffProjectCommandTemplateSnapshots,
  diffRepositoryInstructionSnapshots,
  diffProjectSkillSnapshots,
  expandProjectCommandTemplatePrompt,
  loadProjectCommandTemplates,
  loadProjectSkills,
  loadRepositoryInstructions,
  reconcileWorkspaceMutationAudit,
  reconcileWorkspaceMutationResolutionAudit,
  recoverThread,
  registerArtifactTools,
  registerChangeSetTool,
  registerExecCommandTool,
  registerExecTerminalTool,
  registerPatchSetTool,
  registerProjectSkillTool,
  registerProjectNoteTools,
  registerReadOnlyWorkspaceTools,
  registerStructuredPatchTool,
  registerUpdatePlanTool,
  resolveExecutionPolicy,
  SecretLeaseManager,
  type WorkspaceMutationResolutionReceipt,
} from "@koda/runtime-node";
import { ApprovalGrantRegistry } from "./approval-grant-registry.js";
import { ChildRegistry } from "./child-registry.js";
import { verifyGitWorktree } from "./git-worktree.js";
import { ConfigurationError, type RunConfiguration } from "./config.js";
import type {
  KodaApplication,
  KodaApplicationDependencies,
  KodaApplicationOptions,
  StartTurnInput,
  TurnClient,
  TurnCompletion,
} from "./koda-application.js";
import {
  buildInstructions,
  completion,
  applicationError,
  assertResumeProvider,
  emitDiagnostic,
  abortReason,
  errorMessage,
} from "./application-helpers.js";
interface TurnExecutionHost {
  threadHistory: ThreadHistoryService;
  environment: NodeJS.ProcessEnv;
  processDirectory: string;
  dependencies: KodaApplicationDependencies;
  approvalGrantRegistry: ApprovalGrantRegistry;
  interactiveProcessService: InteractiveProcessService | undefined;
  executionPolicyConfig: ExecutionPolicyConfig | undefined;
  executionProfile: ExecutionProfile | undefined;
  secretLeaseManager: SecretLeaseManager;
  remoteRestricted: boolean;
  readOnlyChild: boolean;
  worktreeChild: KodaApplicationOptions["worktreeChild"];
  children: ChildRegistry;
  refreshThreadMetadata(
    configuration: RunConfiguration,
    threadId: ThreadId,
    client: TurnClient,
  ): Promise<void>;
  createApplication(
    options: KodaApplicationOptions,
  ): Pick<KodaApplication, "startTurn">;
}
export class TurnExecutionService {
  constructor(private readonly host: TurnExecutionHost) {}
  public async execute(
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
    let lease: ThreadLease | undefined;
    let mcpSession: McpTurnSession | undefined;
    let pluginSession: PluginTurnSession | undefined;
    let projectNotes: ProjectNoteStore | undefined;
    let refreshMetadata = false;
    try {
      controller.signal.throwIfAborted();
      const workspace = await this.host.dependencies.openWorkspace(
        configuration.cwd,
      );
      if (parentThreadId !== undefined) {
        const parentEvents =
          await this.host.threadHistory.readValidatedThreadLog(parentThreadId);
        const parent = recoverThread(
          { events: parentEvents, diagnostics: [] },
          parentThreadId,
        );
        if (this.host.worktreeChild === undefined) {
          assertResumeWorkspace(parent, workspace.root);
        } else {
          if (
            parentThreadId !== this.host.worktreeChild.parentThreadId ||
            parent.context.workspaceRoot !==
              this.host.worktreeChild.source.root ||
            workspace.root !== this.host.worktreeChild.path
          ) {
            throw new ConfigurationError(
              "Worktree child parent or workspace does not match its approved source.",
            );
          }
          await verifyGitWorktree(
            workspace.root,
            this.host.worktreeChild.source,
            configuration.kodaHome,
            controller.signal,
          );
        }
      } else if (this.host.worktreeChild !== undefined) {
        throw new ConfigurationError(
          "A worktree child requires a parent thread.",
        );
      }
      const executionPolicy = resolveExecutionPolicy({
        workspaceRoot: workspace.root,
        ...(this.host.executionPolicyConfig === undefined
          ? {}
          : { policy: this.host.executionPolicyConfig }),
        ...(this.host.executionProfile === undefined
          ? {}
          : { environmentProfile: this.host.executionProfile }),
      });
      controller.signal.throwIfAborted();
      const mutationJournal = this.host.readOnlyChild
        ? undefined
        : await WorkspaceMutationJournalStore.open(
            configuration.kodaHome,
            workspace.root,
          );
      if (mutationJournal !== undefined) {
        try {
          const recoveryCoordinator = await WorkspaceMutationCoordinator.open(
            configuration.kodaHome,
            workspace.root,
          );
          const pendingResolutions = await recoveryCoordinator.runExclusive(
            controller.signal,
            () => mutationJournal.listPendingResolutionReceipts(),
          );
          const deferredResolutionReceipts: WorkspaceMutationResolutionReceipt[] =
            [];
          for (const receipt of pendingResolutions) {
            const reconciliation =
              await reconcileWorkspaceMutationResolutionAudit(
                configuration.kodaHome,
                receipt,
              );
            if (reconciliation.status === "deferred") {
              deferredResolutionReceipts.push(receipt);
              continue;
            }
            await recoveryCoordinator.runExclusive(controller.signal, () =>
              mutationJournal.acknowledgeResolution(receipt),
            );
            await emitDiagnostic(client, {
              level: "warning",
              code: "WORKSPACE_MUTATION_CONFLICT_RESOLVED",
              message: `Reconciled the completed '${receipt.resolution}' workspace conflict resolution with its originating thread audit.`,
            });
          }
          const recoveries = await recoveryCoordinator.runExclusive(
            controller.signal,
            () => mutationJournal.recoverPending({ retainRecovered: true }),
          );
          for (const recovery of recoveries) {
            const reconciliation = await reconcileWorkspaceMutationAudit(
              configuration.kodaHome,
              recovery,
            );
            if (
              recovery.status !== "conflicted" &&
              reconciliation.status !== "deferred"
            ) {
              await mutationJournal.acknowledgeRecovery(recovery);
            }
            await emitDiagnostic(client, {
              level: "warning",
              code:
                recovery.status === "conflicted"
                  ? "WORKSPACE_MUTATION_RECOVERY_CONFLICT"
                  : reconciliation.status === "deferred"
                    ? "WORKSPACE_MUTATION_AUDIT_DEFERRED"
                    : "WORKSPACE_MUTATION_RECOVERED",
              message:
                recovery.status === "conflicted"
                  ? `Interrupted workspace changes conflict with current files: ${recovery.paths.join(", ")}. Writes remain blocked until the retained recovery journal is explicitly resolved.`
                  : reconciliation.status === "deferred"
                    ? `Recovered interrupted workspace changes as '${recovery.status}', but audit reconciliation was deferred: ${reconciliation.message ?? "unknown audit state"}`
                    : `Recovered interrupted workspace changes as '${recovery.status}' and reconciled their originating thread audit.`,
            });
          }
          for (const receipt of deferredResolutionReceipts) {
            const reconciliation =
              await reconcileWorkspaceMutationResolutionAudit(
                configuration.kodaHome,
                receipt,
              );
            if (reconciliation.status !== "deferred") {
              await recoveryCoordinator.runExclusive(controller.signal, () =>
                mutationJournal.acknowledgeResolution(receipt),
              );
            }
            await emitDiagnostic(client, {
              level: "warning",
              code:
                reconciliation.status === "deferred"
                  ? "WORKSPACE_MUTATION_RESOLUTION_AUDIT_DEFERRED"
                  : "WORKSPACE_MUTATION_CONFLICT_RESOLVED",
              message:
                reconciliation.status === "deferred"
                  ? `A completed '${receipt.resolution}' workspace conflict resolution remains write-blocking because audit reconciliation was deferred: ${reconciliation.message ?? "unknown audit state"}`
                  : `Reconciled the completed '${receipt.resolution}' workspace conflict resolution with its originating thread audit after repairing its uncertain boundary.`,
            });
          }
        } catch (error) {
          await emitDiagnostic(client, {
            level: "warning",
            code: "WORKSPACE_MUTATION_RECOVERY_FAILED",
            message: `Workspace mutation recovery could not complete; reads remain available and later writes will fail closed: ${errorMessage(error)}`,
          });
        }
      }
      const repositoryInstructions = await loadRepositoryInstructions(
        workspace.root,
      );
      let projectSkills = await loadProjectSkills(workspace.root);
      let projectCommandTemplates = await loadProjectCommandTemplates(
        workspace.root,
      );
      const eventLogPath = join(
        configuration.kodaHome,
        "threads",
        `${ids.threadId}.jsonl`,
      );
      lease = await ThreadLease.acquire(eventLogPath);
      refreshMetadata = true;
      await ArtifactMaintenanceLease.assertInactive(
        join(configuration.kodaHome, "artifacts"),
      );
      controller.signal.throwIfAborted();
      const eventStore = new JsonlEventStore(eventLogPath);
      const artifactStore = await ArtifactStore.open(
        join(configuration.kodaHome, "artifacts"),
      );
      let recoveredTurn: ReturnType<typeof recoverThread> | undefined;
      if (configuration.resumeThreadId !== undefined) {
        recoveredTurn = recoverThread(await eventStore.readAll(), ids.threadId);
        assertResumeWorkspace(recoveredTurn, workspace.root);
        assertResumeProvider(
          recoveredTurn.context.provider,
          configuration.provider,
        );
      }
      if (
        !this.host.remoteRestricted &&
        this.host.worktreeChild === undefined
      ) {
        pluginSession = await PluginTurnSession.open({
          environment: this.host.environment,
          kodaHome: configuration.kodaHome,
          processDirectory: this.host.processDirectory,
          artifactStore,
          projectSkills,
          projectCommandTemplates,
          signal: controller.signal,
        });
        for (const diagnostic of pluginSession.diagnostics) {
          await emitDiagnostic(client, diagnostic);
        }
        projectSkills = pluginSession.skills;
        projectCommandTemplates = pluginSession.commandTemplates;
      }
      const expandedCommandTemplate = expandProjectCommandTemplatePrompt(
        prompt,
        projectCommandTemplates,
      );
      const effectivePrompt = expandedCommandTemplate?.prompt ?? prompt;
      const instructions =
        buildInstructions(
          workspace.root,
          repositoryInstructions,
          projectSkills,
        ) +
        (this.host.worktreeChild === undefined
          ? ""
          : "\nThis is an approved isolated Git worktree child. You may edit only this worktree using apply_patch, apply_changes, or apply_patchset. Process execution, plugins, MCP, further delegation, and edits to the source checkout are unavailable. Leave changes in this worktree for parent review; do not claim they were merged.");
      const instructionSnapshots = repositoryInstructions.sources.map(
        (source) => ({
          path: source.path,
          scope: source.scope,
          bytes: source.bytes,
          sha256: source.sha256,
        }),
      );
      const skillSnapshots = projectSkills.snapshots();
      const commandTemplateSnapshots = projectCommandTemplates.snapshots();
      const pluginSnapshots = [...(pluginSession?.snapshots ?? [])];
      let history: ConversationItem[] = [];
      let prefaceItems: ConversationItem[] = [];
      let initialSequence = 0;
      let recoveredPlan: ReturnType<typeof recoverThread>["plan"];
      let recoveredCheckpoint: ReturnType<typeof recoverThread>["checkpoint"];
      let previousToolCatalogGeneration: TurnContextSnapshot["toolCatalogGeneration"];
      let planNeedsRevalidation = false;

      if (recoveredTurn !== undefined) {
        const recovered = recoveredTurn;
        history = recovered.history;
        recoveredPlan = recovered.plan;
        recoveredCheckpoint = recovered.checkpoint;
        previousToolCatalogGeneration = recovered.context.toolCatalogGeneration;
        planNeedsRevalidation = recovered.planNeedsRevalidation;
        const unavailableArtifacts = await artifactStore.findUnavailable(
          history.flatMap((item) =>
            item.type === "tool_result" && item.output !== undefined
              ? collectArtifactReferences(item.output)
              : [],
          ),
        );
        const unavailableArtifactIds = unavailableArtifacts.map(
          (artifact) => artifact.id,
        );
        const instructionChanges = diffRepositoryInstructionSnapshots(
          recovered.context.repositoryInstructions,
          instructionSnapshots,
        );
        const skillChanges = diffProjectSkillSnapshots(
          recovered.context.skills,
          skillSnapshots,
        );
        const commandTemplateChanges = diffProjectCommandTemplateSnapshots(
          recovered.context.commandTemplates,
          commandTemplateSnapshots,
        );
        const pluginChanges = diffPluginSnapshots(
          recovered.context.plugins,
          pluginSnapshots,
        );
        const recoveryParts = [recovered.message];
        if (unavailableArtifactIds.length > 0) {
          recoveryParts.push(
            `The following output artifacts are unavailable and must not be assumed readable: ${unavailableArtifactIds.join(", ")}.`,
          );
        }
        if (instructionChanges.length > 0) {
          recoveryParts.push(
            `Repository instructions changed since the previous turn: ${instructionChanges.map((change) => `${change.change} ${change.path} (scope ${change.scope})`).join(", ")}. The current scoped instructions apply to this resumed turn.`,
          );
        }
        if (skillChanges.length > 0) {
          recoveryParts.push(
            `Project Skills changed since the previous turn: ${skillChanges.map((change) => `${change.change} ${change.name} at ${change.path} (scope ${change.scope})`).join(", ")}. The current frozen Skill catalog applies to this resumed turn.`,
          );
        }
        if (commandTemplateChanges.length > 0) {
          recoveryParts.push(
            `Project command templates changed since the previous turn: ${commandTemplateChanges.map((change) => `${change.change} ${change.selector} at ${change.path} (scope ${change.scope})`).join(", ")}. The current frozen command-template catalog applies to this resumed turn.`,
          );
        }
        if (pluginChanges.length > 0) {
          recoveryParts.push(
            `Plugins changed since the previous turn: ${pluginChanges.map((change) => `${change.change} ${change.pluginId}`).join(", ")}. The current isolated plugin snapshot applies to this resumed turn.`,
          );
        }
        prefaceItems = [
          recoveryItemSchema.parse({
            type: "recovery",
            id: ids.itemIds.next(),
            previousTurnId: recovered.previousTurnId,
            previousStatus: recovered.previousStatus,
            message: recoveryParts.join(" "),
            partialTrailingEventDiscarded:
              recovered.partialTrailingEventDiscarded,
            unavailableArtifacts,
            instructionChanges,
            skillChanges,
            commandTemplateChanges,
            pluginChanges,
            uncertainToolCalls: recovered.uncertainToolCalls,
            workspaceChangeSets: recovered.workspaceChangeSets,
          }),
        ];
        initialSequence = recovered.nextSequence;
        await eventStore.prepareForAppend({
          discardPartialTrailingLine: recovered.partialTrailingEventDiscarded,
        });
      }

      const planState = new PlanRuntimeState({
        nextOpaqueId: () => ids.itemIds.next(),
        ...(recoveredPlan === undefined ? {} : { initialPlan: recoveredPlan }),
        ...(recoveredCheckpoint === undefined
          ? {}
          : { initialCheckpoint: recoveredCheckpoint }),
        needsRevalidation: planNeedsRevalidation,
      });
      const tools = new ToolRegistry();
      if (
        !this.host.remoteRestricted &&
        this.host.worktreeChild === undefined
      ) {
        registerUpdatePlanTool(tools, planState, {
          ...(client.planAcceptances === undefined
            ? {}
            : { acceptances: client.planAcceptances }),
        });
      }
      registerProjectSkillTool(tools, projectSkills);
      if (!this.host.remoteRestricted) {
        registerArtifactTools(tools, artifactStore);
      }
      registerReadOnlyWorkspaceTools(tools, workspace, { artifactStore });
      if (!this.host.remoteRestricted || this.host.readOnlyChild) {
        try {
          projectNotes = await ProjectNoteStore.open(configuration.kodaHome);
          registerProjectNoteTools(
            tools,
            projectNotes,
            this.host.worktreeChild?.source.root ?? workspace.root,
          );
        } catch (error) {
          projectNotes?.close();
          projectNotes = undefined;
          await emitDiagnostic(client, {
            level: "warning",
            code: "PROJECT_NOTES_UNAVAILABLE",
            message: `Project notes are unavailable: ${errorMessage(error)}`,
          });
        }
      }
      if (
        !this.host.remoteRestricted &&
        this.host.worktreeChild === undefined
      ) {
        const childTasks = new ChildTaskService(
          this.host.children,
          this.host.threadHistory,
          (worktree, parentThreadId) =>
            this.host.createApplication({
              environment: this.host.environment,
              processDirectory: this.host.processDirectory,
              dependencies: this.host.dependencies,
              ...(worktree === undefined
                ? { readOnlyChild: true }
                : { worktreeChild: { ...worktree, parentThreadId } }),
            }),
        );
        childTasks.registerTools(
          tools,
          ids.threadId,
          workspace.root,
          configuration,
        );
      }
      if (
        (!this.host.remoteRestricted || remoteEffects?.workspaceMutations) &&
        mutationJournal !== undefined
      ) {
        const mutationCoordinator = await WorkspaceMutationCoordinator.open(
          configuration.kodaHome,
          workspace.root,
          {
            beforeAction: async () => {
              await mutationJournal.recoverBeforeWrite({
                retainRecovered: true,
              });
            },
          },
        );
        registerStructuredPatchTool(tools, workspace, mutationCoordinator);
        registerChangeSetTool(
          tools,
          workspace,
          mutationCoordinator,
          mutationJournal,
        );
        registerPatchSetTool(
          tools,
          workspace,
          mutationCoordinator,
          mutationJournal,
        );
      }
      if (
        (!this.host.remoteRestricted || remoteEffects?.processExecution) &&
        mutationJournal !== undefined &&
        this.host.worktreeChild === undefined
      ) {
        const nativeExecutorPath = this.host.environment.KODA_EXEC_PATH?.trim();
        const nativeExecutor =
          this.host.interactiveProcessService?.nativeExecutor ??
          (nativeExecutorPath === undefined || nativeExecutorPath.length === 0
            ? undefined
            : await NativeExecutorClient.open({
                binaryPath: nativeExecutorPath,
                stateDirectory: join(configuration.kodaHome, "executor"),
              }));
        const commandRunner = await WorkspaceCommandRunner.open(
          workspace.root,
          {
            environment: this.host.environment,
            artifactStore,
            executionPolicy,
            ...(nativeExecutor === undefined ? {} : { nativeExecutor }),
            ...(this.host.interactiveProcessService === undefined
              ? {}
              : {
                  interactiveProcessService:
                    this.host.interactiveProcessService,
                }),
          },
        );
        registerExecCommandTool(tools, commandRunner, {
          ...(this.host.remoteRestricted
            ? {}
            : { secretLeaseManager: this.host.secretLeaseManager }),
        });
        registerExecTerminalTool(tools, commandRunner, {
          ...(this.host.remoteRestricted
            ? {}
            : { secretLeaseManager: this.host.secretLeaseManager }),
        });
      }
      if (
        !this.host.remoteRestricted &&
        mutationJournal !== undefined &&
        this.host.worktreeChild === undefined
      ) {
        pluginSession?.registerTools(tools);
      }
      if (
        this.host.worktreeChild === undefined &&
        ((!this.host.remoteRestricted && mutationJournal !== undefined) ||
          (this.host.remoteRestricted &&
            remoteEffects?.mcpServerIds !== undefined))
      ) {
        mcpSession = await McpTurnSession.open({
          environment: this.host.environment,
          kodaHome: configuration.kodaHome,
          processDirectory: this.host.processDirectory,
          artifactStore,
          signal: controller.signal,
          ...(remoteEffects?.mcpServerIds === undefined
            ? {}
            : { serverIds: remoteEffects.mcpServerIds }),
        });
        mcpSession.registerTools(tools);
      }
      const toolCatalogGeneration = tools.catalogGeneration();
      if (
        previousToolCatalogGeneration !== undefined &&
        previousToolCatalogGeneration.generationId !==
          toolCatalogGeneration.generationId
      ) {
        prefaceItems = prefaceItems.map((item) =>
          item.type !== "recovery"
            ? item
            : recoveryItemSchema.parse({
                ...item,
                message: `${item.message} Tool catalog generation changed since the previous turn; the current generation applies to this resumed turn.`,
                toolCatalogGenerationChange: {
                  previous: previousToolCatalogGeneration,
                  current: toolCatalogGeneration,
                },
              }),
        );
      }
      const contextEngine = new ContextEngine({
        contextWindowTokens: configuration.contextWindowTokens,
        maxOutputTokens: configuration.maxOutputTokens,
        fixedInputTokens: estimateTextTokens(instructions),
        ids: ids.itemIds,
        summarizer: createModelContextSummarizer(() =>
          this.host.dependencies.createProvider(
            {
              ...configuration,
              maxOutputTokens: Math.min(configuration.maxOutputTokens, 2048),
            },
            CONTEXT_SUMMARY_INSTRUCTIONS,
          ),
        ),
      });
      const provider = this.host.dependencies.createProvider(
        configuration,
        instructions,
      );
      const worktreePolicy: ToolPolicy = {
        evaluate: (input) =>
          input.effect === "read" ||
          (input.effect === "write" &&
            ["apply_patch", "apply_changes", "apply_patchset"].includes(
              input.name,
            ))
            ? { decision: "allow" }
            : {
                decision: "deny",
                reason:
                  "Only read tools and isolated text-file patches are available to worktree children.",
              },
      };
      const remotePolicy: ToolPolicy = {
        evaluate: (input) => {
          if (input.effect === "read") return { decision: "allow" };
          if (
            (input.effect === "write" && remoteEffects?.workspaceMutations) ||
            (input.effect === "execute" &&
              (remoteEffects?.processExecution ||
                (remoteEffects?.mcpServerIds !== undefined &&
                  input.name.startsWith("mcp__"))))
          ) {
            return {
              decision: "ask",
              reason:
                "This remote tool call requires approval on the authorized device.",
            };
          }
          return {
            decision: "deny",
            reason: "This remote device is not authorized for this effect.",
          };
        },
      };
      const loop = new AgentLoop({
        provider,
        tools,
        events: new FanoutEventSink([eventStore, client.events]),
        ids: ids.itemIds,
        policy:
          this.host.worktreeChild !== undefined
            ? worktreePolicy
            : this.host.remoteRestricted
              ? remotePolicy
              : new EffectToolPolicy(configuration.approvalMode),
        approvals: client.approvals,
        ...(this.host.remoteRestricted
          ? {}
          : {
              approvalGrants: this.host.approvalGrantRegistry.forWorkspace(
                workspace.root,
              ),
            }),
        contextEngine,
        planState,
        mailbox,
        ...(mcpSession === undefined
          ? {}
          : {
              toolCatalogRefresher: {
                refreshBeforeModelStep: (step: number, signal: AbortSignal) =>
                  mcpSession!.refreshTools(step, signal),
              },
            }),
      });

      const result = await loop.runTurn({
        threadId: ids.threadId,
        turnId: ids.turnId,
        ...(parentThreadId === undefined ? {} : { parentThreadId }),
        ...(this.host.worktreeChild === undefined
          ? {}
          : {
              worktree: {
                sourceRoot: this.host.worktreeChild.source.root,
                path: this.host.worktreeChild.path,
                commit: this.host.worktreeChild.source.commit,
              },
            }),
        userInput: effectivePrompt,
        signal: controller.signal,
        history,
        prefaceItems,
        initialSequence,
        context: turnContextSnapshotSchema.parse({
          provider: configuration.provider,
          model: configuration.model,
          workspaceRoot: workspace.root,
          approvalMode: configuration.approvalMode,
          instructionsSha256: createHash("sha256")
            .update(instructions)
            .digest("hex"),
          repositoryInstructions: instructionSnapshots,
          skills: skillSnapshots,
          commandTemplates: commandTemplateSnapshots,
          plugins: pluginSnapshots,
          ...(expandedCommandTemplate === undefined
            ? {}
            : {
                commandTemplateActivation: expandedCommandTemplate.activation,
              }),
          toolCatalogGeneration,
        }),
      });
      if (result.status === "completed") {
        return completion(ids, "completed", 0);
      }
      if (result.status === "paused") {
        return completion(ids, "paused", 0);
      }
      if (result.status === "cancelled") {
        return completion(ids, "cancelled", 130, {
          code: "TURN_CANCELLED",
          message: result.reason,
        });
      }
      return completion(ids, "failed", 1, result.error);
    } catch (error) {
      if (controller.signal.aborted) {
        return completion(ids, "cancelled", 130, {
          code: "TURN_CANCELLED",
          message: abortReason(controller.signal.reason),
        });
      }
      return completion(ids, "failed", 1, applicationError(error));
    } finally {
      projectNotes?.close();
      if (mcpSession !== undefined) {
        try {
          await mcpSession.close();
        } catch (error) {
          await emitDiagnostic(client, {
            level: "warning",
            code: "MCP_SESSION_CLEANUP_FAILED",
            message: errorMessage(error),
          });
        }
      }
      if (pluginSession !== undefined) {
        try {
          await pluginSession.close();
        } catch (error) {
          await emitDiagnostic(client, {
            level: "warning",
            code: "PLUGIN_SESSION_CLEANUP_FAILED",
            message: errorMessage(error),
          });
        }
      }
      if (lease !== undefined) {
        try {
          await lease.release();
        } catch (error) {
          await emitDiagnostic(client, {
            level: "warning",
            code: "THREAD_LEASE_CLEANUP_FAILED",
            message: errorMessage(error),
          });
        }
      }
      if (refreshMetadata) {
        await this.host.refreshThreadMetadata(
          configuration,
          ids.threadId,
          client,
        );
      }
    }
  }
}
