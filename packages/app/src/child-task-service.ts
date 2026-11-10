import { rejectApprovalsBroker, type ToolRegistry } from "@koda/agent-core";
import {
  jsonValueSchema,
  type AgentEvent,
  type JsonValue,
  type ThreadId,
} from "@koda/protocol";
import {
  recoverThread,
  registerReadOnlyChildTools,
  registerReadOnlyDelegationTool,
  registerWorktreeChildTool,
} from "@koda/runtime-node";
import { ChildRegistry, type ChildSnapshot } from "./child-registry.js";
import {
  ThreadHistoryService,
  ThreadHistoryError,
} from "./thread-history-service.js";
import {
  createGitWorktree,
  inspectGitSource,
  type GitSource,
} from "./git-worktree.js";
import type { RunConfiguration } from "./config.js";
import type { KodaApplication, TurnHandle } from "./koda-application.js";

type ChildApplicationFactory = (
  worktree: { source: GitSource; path: string } | undefined,
  parentThreadId: ThreadId,
) => Pick<KodaApplication, "startTurn">;

/** Registers one parent turn's child tools while sharing the application registry.
 * Child application construction stays with the facade; leases stay with each turn.
 */
export class ChildTaskService {
  public constructor(
    private readonly children: ChildRegistry,
    private readonly threadHistory: ThreadHistoryService,
    private readonly createApplication: ChildApplicationFactory,
  ) {}

  public registerTools(
    tools: ToolRegistry,
    parentThreadId: ThreadId,
    workspaceRoot: string,
    configuration: Pick<RunConfiguration, "provider" | "model" | "kodaHome">,
  ): void {
    let childCount = 0;
    const launchChild = async (
      context: { signal: AbortSignal },
      task: string,
      worktree?: { source: GitSource; path: string },
    ): Promise<{ handle: TurnHandle } | { error: JsonValue }> => {
      context.signal.throwIfAborted();
      if (childCount >= 2) {
        return { error: { status: "limit_reached", maxChildren: 2 } };
      }
      if (!this.children.canStart()) {
        return { error: { status: "busy", maxActiveChildren: 8 } };
      }
      const childApplication = this.createApplication(worktree, parentThreadId);
      let answer = "";
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const child = childApplication.startTurn(
        {
          prompt: task,
          cwd: worktree?.path ?? workspaceRoot,
          provider: configuration.provider,
          model: configuration.model,
          approvalMode: "never",
          parentThreadId,
        },
        {
          events: {
            append: async (event) => {
              if (event.type === "turn.started") markStarted?.();
              if (
                event.type === "item.recorded" &&
                event.payload.item.type === "assistant_message"
              ) {
                answer = event.payload.item.content;
              }
            },
          },
          approvals: rejectApprovalsBroker,
        },
      );
      try {
        this.children.register({
          parentThreadId,
          workspaceRoot: workspaceRoot,
          handle: child,
          answer: () => answer,
          parentSignal: context.signal,
          ...(worktree === undefined ? {} : { worktreePath: worktree.path }),
        });
      } catch (error) {
        child.cancel("Child registration failed.");
        throw error;
      }
      childCount += 1;
      const durableStart = await Promise.race([
        started.then(() => true),
        child.completion.then(() => false),
      ]);
      if (!durableStart) {
        return {
          error: { status: "failed", errorCode: "CHILD_NOT_STARTED" },
        };
      }
      context.signal.throwIfAborted();
      return { handle: child };
    };
    registerReadOnlyDelegationTool(tools, async (context, task) => {
      const launched = await launchChild(context, task);
      if ("error" in launched) return launched.error;
      await launched.handle.completion;
      return jsonValueSchema.parse(
        this.children.get(
          parentThreadId,
          workspaceRoot,
          launched.handle.threadId,
        ) ?? { status: "unavailable" },
      );
    });
    registerReadOnlyChildTools(tools, {
      spawn: async (context, task) => {
        const launched = await launchChild(context, task);
        return "error" in launched
          ? launched.error
          : { threadId: launched.handle.threadId, status: "running" };
      },
      wait: async (context, childThreadIds, timeoutMs) => {
        const initial = await Promise.all(
          childThreadIds.map(
            async (childThreadId) =>
              this.children.get(parentThreadId, workspaceRoot, childThreadId) ??
              this.durableChildSnapshot(
                parentThreadId,
                workspaceRoot,
                childThreadId,
              ),
          ),
        );
        if (initial.some((child) => child === undefined)) {
          return { status: "not_found" };
        }
        const children = initial as ChildSnapshot[];
        if (
          timeoutMs > 0 &&
          children.every((child) => child.status === "running")
        ) {
          const waited = await this.children.wait(
            parentThreadId,
            workspaceRoot,
            childThreadIds,
            timeoutMs,
            context.signal,
          );
          if (waited !== undefined) {
            return jsonValueSchema.parse({ children: waited });
          }
        }
        return jsonValueSchema.parse({ children });
      },
      send: async (_context, childThreadId, message) => ({
        status: this.children.send(
          parentThreadId,
          workspaceRoot,
          childThreadId,
          message,
        ),
      }),
      interrupt: async (_context, childThreadId) => ({
        status: this.children.interrupt(
          parentThreadId,
          workspaceRoot,
          childThreadId,
        ),
      }),
    });
    registerWorktreeChildTool(tools, async (context, task) => {
      context.signal.throwIfAborted();
      if (childCount >= 2 || !this.children.canStart()) {
        throw new Error("The parent turn has no available child slot.");
      }
      const source = await inspectGitSource(
        workspaceRoot,
        configuration.kodaHome,
        context.signal,
      );
      return {
        approval: {
          title: "Start write-capable child in Git worktree",
          summary: `Create a detached worktree from ${source.commit.slice(0, 12)} and delegate one task.`,
          details: `Task: ${task}\nSource: ${source.root}\nCommit: ${source.commit}\nWorktree base: ${configuration.kodaHome}/worktrees\nThe child may modify text files inside its isolated worktree without separate patch approvals. It cannot run commands, use plugins or MCP, or edit the source checkout. Uncommitted source changes are not copied. The worktree is retained for review and is not merged automatically. Git checkout may invoke configured filters.`,
        },
        freshApprovalRequired: true,
        execute: async (): Promise<JsonValue> => {
          context.signal.throwIfAborted();
          if (childCount >= 2 || !this.children.canStart()) {
            return { status: "limit_reached", maxChildren: 2 };
          }
          const path = await createGitWorktree(
            source,
            configuration.kodaHome,
            context.signal,
          );
          const launched = await launchChild(context, task, {
            source,
            path,
          });
          return "error" in launched
            ? {
                status: "failed",
                error: launched.error,
                worktreePath: path,
              }
            : {
                threadId: launched.handle.threadId,
                status: "running",
                worktreePath: path,
              };
        },
      };
    });
  }

  private async durableChildSnapshot(
    parentThreadId: ThreadId,
    workspaceRoot: string,
    childThreadId: ThreadId,
  ): Promise<ChildSnapshot | undefined> {
    let events: AgentEvent[];
    try {
      events = await this.threadHistory.readValidatedThreadLog(childThreadId);
    } catch (error) {
      if (
        error instanceof ThreadHistoryError &&
        error.code === "THREAD_EVENT_LOG_NOT_FOUND"
      ) {
        return undefined;
      }
      throw error;
    }
    if (
      events[0]?.type !== "turn.started" ||
      events[0].payload.parentThreadId !== parentThreadId
    ) {
      return undefined;
    }
    const recovered = recoverThread({ events, diagnostics: [] }, childThreadId);
    const worktree =
      events[0].type === "turn.started"
        ? events[0].payload.worktree
        : undefined;
    if (
      worktree === undefined &&
      recovered.context.workspaceRoot !== workspaceRoot
    )
      return undefined;
    if (
      worktree !== undefined &&
      (worktree.sourceRoot !== workspaceRoot ||
        worktree.path !== recovered.context.workspaceRoot)
    )
      return undefined;
    const answer = [...recovered.history]
      .reverse()
      .find((item) => item.type === "assistant_message");
    return {
      threadId: childThreadId,
      status: recovered.previousStatus,
      ...(worktree === undefined ? {} : { worktreePath: worktree.path }),
      ...(answer?.type === "assistant_message" &&
      recovered.previousStatus !== "interrupted"
        ? { answer: answer.content.slice(0, 4_000) }
        : {}),
    };
  }
}
