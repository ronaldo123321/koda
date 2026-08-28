import { randomUUID } from "node:crypto";

import { KodaApplication, type KodaApplicationDependencies } from "@koda/app";
import {
  type ApprovalBroker,
  type ItemIdFactory,
  type PlanAcceptanceBroker,
} from "@koda/agent-core";
import {
  itemIdSchema,
  threadIdSchema,
  turnIdSchema,
  type AgentEvent,
  type ItemId,
} from "@koda/protocol";
import { createRegisteredProvider } from "@koda/providers";
import { ReadOnlyWorkspace } from "@koda/runtime-node";

import { ConfigurationError } from "./config.js";
import { ConsoleEventSink, type TextWriter } from "./console-event-sink.js";
import { TerminalApprovalBroker } from "./terminal-approval-broker.js";
import { TerminalPlanAcceptanceBroker } from "./terminal-plan-acceptance-broker.js";

export interface RunCommandInput {
  approvalMode?: string;
  prompt: string;
  cwd?: string;
  model?: string;
  provider?: string;
  resume?: string;
  signal: AbortSignal;
}

export interface RunCommandContext {
  environment: NodeJS.ProcessEnv;
  processDirectory: string;
  stdout: TextWriter;
  stderr: TextWriter;
  stdin?: NodeJS.ReadableStream;
}

export interface RunCommandDependencies extends KodaApplicationDependencies {
  createApprovalBroker(context: RunCommandContext): ApprovalBroker;
  createPlanAcceptanceBroker?(context: RunCommandContext): PlanAcceptanceBroker;
}

const productionDependencies: RunCommandDependencies = {
  openWorkspace: (root) => ReadOnlyWorkspace.open(root),
  createProvider: (configuration, instructions) =>
    createRegisteredProvider({
      provider: configuration.provider,
      apiKey: configuration.apiKey,
      model: configuration.model,
      instructions,
      maxOutputTokens: configuration.maxOutputTokens,
    }),
  createApprovalBroker: (context) =>
    new TerminalApprovalBroker({
      input: context.stdin ?? process.stdin,
      output: context.stderr,
    }),
  createPlanAcceptanceBroker: (context) =>
    new TerminalPlanAcceptanceBroker({
      input: context.stdin ?? process.stdin,
      output: context.stderr,
    }),
  createIds: (resumeThreadId) => ({
    threadId: resumeThreadId ?? threadIdSchema.parse(randomUUID()),
    turnId: turnIdSchema.parse(randomUUID()),
    itemIds: new RandomItemIdFactory(),
  }),
};

export async function runCommand(
  input: RunCommandInput,
  context: RunCommandContext,
  dependencies: RunCommandDependencies = productionDependencies,
): Promise<number> {
  const consoleEvents = new ConsoleEventSink({
    stdout: context.stdout,
    stderr: context.stderr,
  });
  let terminalEventSeen = false;
  const application = new KodaApplication({
    environment: context.environment,
    processDirectory: context.processDirectory,
    dependencies,
  });
  let handle;
  try {
    handle = application.startTurn(
      {
        prompt: input.prompt,
        ...(input.approvalMode === undefined
          ? {}
          : { approvalMode: input.approvalMode }),
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        ...(input.resume === undefined ? {} : { resume: input.resume }),
      },
      {
        events: {
          append: async (event: AgentEvent) => {
            terminalEventSeen ||=
              event.type === "turn.completed" ||
              event.type === "turn.paused" ||
              event.type === "turn.cancelled" ||
              event.type === "turn.failed";
            await consoleEvents.append(event);
          },
        },
        approvals: dependencies.createApprovalBroker(context),
        planAcceptances:
          dependencies.createPlanAcceptanceBroker?.(context) ??
          new TerminalPlanAcceptanceBroker({
            input: context.stdin ?? process.stdin,
            output: context.stderr,
          }),
        diagnostic: (diagnostic) => {
          const label =
            diagnostic.code === "THREAD_LEASE_CLEANUP_FAILED"
              ? "thread lease cleanup failed"
              : diagnostic.code === "METADATA_REFRESH_FAILED"
                ? "thread metadata refresh failed"
                : diagnostic.code === "METADATA_INDEX_DIAGNOSTIC"
                  ? "metadata index"
                  : diagnostic.code === "METADATA_DATABASE_REBUILT"
                    ? "metadata database rebuilt"
                    : diagnostic.code;
          context.stderr.write(
            `[koda] warning: ${label}: ${diagnostic.message}\n`,
          );
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.stderr.write(`[koda] ${message}\n`);
    return error instanceof ConfigurationError ? 2 : 1;
  }

  const cancel = () => {
    handle.cancel(abortReason(input.signal.reason));
  };
  if (input.signal.aborted) {
    cancel();
  } else {
    input.signal.addEventListener("abort", cancel, { once: true });
  }
  try {
    const result = await handle.completion;
    if (!terminalEventSeen && result.error !== undefined) {
      context.stderr.write(
        `[koda] ${result.error.code}: ${result.error.message}\n`,
      );
    }
    return result.exitCode;
  } finally {
    input.signal.removeEventListener("abort", cancel);
  }
}

function abortReason(reason: unknown): string {
  return typeof reason === "string" && reason.length > 0
    ? reason
    : "Interrupted by user.";
}

class RandomItemIdFactory implements ItemIdFactory {
  public next(): ItemId {
    return itemIdSchema.parse(randomUUID());
  }
}
