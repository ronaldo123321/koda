import type {
  AppServerClientApi,
  AppServerNotification,
} from "@koda/app-server-client-node";
import { reducePlanAcceptance, reducePlanUpdate } from "@koda/agent-core";
import {
  APP_SERVER_PROTOCOL_VERSION,
  agentEventSchema,
  initializeResultSchema,
  planCheckpointSchema,
  planGetResultSchema,
  planIdSchema,
  settingsGetResultSchema,
  settingsUpdateResultSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnFinishedNotificationParamsSchema,
  turnIdSchema,
  type AgentEvent,
} from "@koda/protocol";
import { runTui } from "@koda/tui";

const threadId = threadIdSchema.parse("phase-3g-tty-thread");
const turnId = turnIdSchema.parse("phase-3g-tty-turn");
const callId = toolCallIdSchema.parse("phase-3g-tty-call");
const awaitingPlan = reducePlanUpdate({
  planId: planIdSchema.parse("plan:phase-3g-tty"),
  update: {
    expectedRevision: 0,
    objective: "Verify the Phase 3G real-TTY interaction.",
    stages: [
      {
        id: "stage:tty",
        title: "Review the real-TTY flow",
        requiresAcceptance: true,
        acceptanceCriteria: [
          "The acceptance card and durable Plan view render in a real TTY.",
        ],
        summary: "The Phase 3G TTY fixture is ready for acceptance.",
        evidence: [{ kind: "tool_call", callId }],
        todos: [
          {
            id: "todo:tty",
            title: "Exercise the Ink interaction",
            status: "completed",
            outcome: "The live acceptance card was rendered.",
          },
        ],
      },
    ],
  },
});
const acceptance = reducePlanAcceptance(awaitingPlan, {
  callId,
  planId: awaitingPlan.planId,
  planRevision: awaitingPlan.revision,
  stageId: awaitingPlan.stages[0]!.id,
  decision: "accepted",
});
if (acceptance.status !== "accepted") {
  throw new Error("The real-TTY fixture Plan did not reach accepted state.");
}
const acceptedPlan = acceptance.plan;
const awaitingCheckpoint = planCheckpointSchema.parse({
  checkpointId: "checkpoint:phase-3g-tty-awaiting",
  planId: awaitingPlan.planId,
  planRevision: awaitingPlan.revision,
  activeStageId: awaitingPlan.stages[0]!.id,
  lastSafeSequence: 2,
  reason: "plan_update",
  evidence: [{ kind: "event", sequence: 2 }],
});
const acceptedCheckpoint = planCheckpointSchema.parse({
  checkpointId: "checkpoint:phase-3g-tty-accepted",
  planId: acceptedPlan.planId,
  planRevision: acceptedPlan.revision,
  lastSafeSequence: 6,
  reason: "stage_acceptance",
  evidence: [{ kind: "event", sequence: 6 }],
});

const notificationListeners = new Set<
  (notification: AppServerNotification) => void
>();
const disconnectListeners = new Set<(error?: Error) => void>();
let currentPlan = awaitingPlan;
let currentCheckpoint = awaitingCheckpoint;

const initialization = initializeResultSchema.parse({
  protocolVersion: APP_SERVER_PROTOCOL_VERSION,
  server: { name: "koda-app-server", version: "test" },
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
  },
  providers: [
    {
      id: "openai",
      displayName: "OpenAI",
      credentialEnvironmentVariable: "OPENAI_API_KEY",
      defaultModel: "phase-3g-tty-model",
      configured: true,
    },
  ],
});

const client: AppServerClientApi = {
  initialization,
  listThreads: async () => ({ threads: [], diagnostics: [] }),
  getThread: async () => Promise.reject(new Error("Not used by TTY fixture.")),
  readThreadEvents: async () => ({
    events: [],
    hasEarlier: false,
    hasLater: false,
  }),
  listThreadArtifacts: async (params) => ({
    workspace: params.workspace,
    threadId: params.threadId,
    artifacts: [],
    hasEarlier: false,
  }),
  readArtifact: async () =>
    Promise.reject(new Error("Not used by TTY fixture.")),
  listThreadContexts: async (params) => ({
    workspace: params.workspace,
    threadId: params.threadId,
    requests: [],
    hasEarlier: false,
  }),
  readContext: async () =>
    Promise.reject(new Error("Not used by TTY fixture.")),
  readContextInstruction: async () =>
    Promise.reject(new Error("Not used by TTY fixture.")),
  searchThreads: async () => ({
    matches: [],
    revision: 0,
    hasMore: false,
    diagnostics: [],
  }),
  getPlan: async (params) =>
    planGetResultSchema.parse({
      workspace: params.workspace,
      threadId: params.threadId,
      plan: currentPlan,
      checkpoint: currentCheckpoint,
      recovery: {
        previousTurnId: turnId,
        previousStatus: "completed",
        needsRevalidation: false,
        uncertainToolCalls: [],
      },
    }),
  getRuntimeSettings: async (params) =>
    settingsGetResultSchema.parse({
      workspace: params.workspace,
      revision: 0,
      diagnostics: [],
    }),
  updateRuntimeSettings: async (params) =>
    settingsUpdateResultSchema.parse({
      workspace: params.workspace,
      revision: params.expectedRevision + 1,
      preference: {
        provider: params.provider,
        model: params.model,
        updatedAt: "2026-08-28T00:00:00.000Z",
      },
      diagnostics: [],
    }),
  startTurn: async () => {
    setTimeout(() => {
      emitEvent(0, "tool.started", {
        callId,
        name: "update_plan",
        executionBoundary: true,
      });
      emitEvent(1, "tool.execution_started", {
        callId,
        name: "update_plan",
        effect: "control",
      });
      emitEvent(2, "plan.updated", {
        callId,
        source: "model_update",
        plan: awaitingPlan,
      });
      emitEvent(3, "plan.checkpointed", {
        checkpoint: awaitingCheckpoint,
      });
      emitEvent(4, "plan.acceptance_requested", {
        callId,
        planId: awaitingPlan.planId,
        planRevision: awaitingPlan.revision,
        stageId: awaitingPlan.stages[0]!.id,
        criteria: awaitingPlan.stages[0]!.acceptanceCriteria,
        summary: awaitingPlan.stages[0]!.summary!,
        evidence: awaitingPlan.stages[0]!.evidence,
      });
    }, 80);
    return { threadId, turnId };
  },
  cancelTurn: async () => ({ accepted: true }),
  resolveApproval: async () => ({ accepted: true }),
  resolvePlanAcceptance: async (params) => {
    if (
      params.threadId !== threadId ||
      params.turnId !== turnId ||
      params.callId !== callId ||
      params.planId !== awaitingPlan.planId ||
      params.planRevision !== awaitingPlan.revision ||
      params.stageId !== awaitingPlan.stages[0]!.id ||
      params.decision !== "accepted"
    ) {
      throw new Error("The TTY acceptance decision did not preserve identity.");
    }
    emitEvent(5, "plan.acceptance_resolved", {
      callId,
      planId: awaitingPlan.planId,
      planRevision: awaitingPlan.revision,
      stageId: awaitingPlan.stages[0]!.id,
      decision: "accepted",
    });
    await delay(120);
    currentPlan = acceptedPlan;
    currentCheckpoint = acceptedCheckpoint;
    emitEvent(6, "plan.updated", {
      callId,
      source: "runtime_acceptance",
      plan: acceptedPlan,
    });
    emitEvent(7, "plan.checkpointed", {
      checkpoint: acceptedCheckpoint,
    });
    emitEvent(8, "tool.completed", {
      callId,
      name: "update_plan",
      status: "success",
    });
    emit({
      method: "turn/finished",
      params: turnFinishedNotificationParamsSchema.parse({
        threadId,
        turnId,
        status: "completed",
        exitCode: 0,
      }),
    });
    return { accepted: true };
  },
  listApprovalGrants: async (params) => ({
    workspace: params.workspace,
    grants: [],
  }),
  revokeApprovalGrant: async () => ({ revoked: false }),
  revokeAllApprovalGrants: async () => ({ revokedCount: 0 }),
  onNotification: (listener) => {
    notificationListeners.add(listener);
    return () => notificationListeners.delete(listener);
  },
  onDisconnect: (listener) => {
    disconnectListeners.add(listener);
    return () => disconnectListeners.delete(listener);
  },
  diagnostics: () => "phase-3g-tty-fixture",
  shutdown: async () => undefined,
};

const exitCode = await runTui(
  { cwd: process.cwd(), provider: "openai" },
  {
    environment: process.env,
    processDirectory: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    connectAppServer: async () => client,
  },
);
process.stdout.write(`\n[phase-3g-tty] exit ${exitCode}\n`);
process.exitCode = exitCode;

function emitEvent(
  sequence: number,
  type: AgentEvent["type"],
  payload: unknown,
): void {
  emit({
    method: "turn/event",
    params: {
      event: agentEventSchema.parse({
        schemaVersion: 1,
        sequence,
        timestamp: "2026-08-28T00:00:00.000Z",
        threadId,
        turnId,
        type,
        payload,
      }),
    },
  });
}

function emit(notification: AppServerNotification): void {
  for (const listener of notificationListeners) {
    listener(notification);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
