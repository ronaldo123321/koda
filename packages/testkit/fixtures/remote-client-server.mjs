import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

import { KodaApplication } from "@koda/app";
import {
  RemoteDeviceStore,
  RemoteThreadStore,
  RemoteTurnRequestStore,
  RemoteWorkspaceStore,
  startRemoteHttpsServer,
} from "@koda/app-server";
import { agentEventSchema } from "@koda/protocol";
import { ArtifactStore, JsonlEventStore } from "@koda/runtime-node";
import { join } from "node:path";

const [home, workspacePath, certificatePath, privateKeyPath] =
  process.argv.slice(2);
const workspaceRoot = await realpath(workspacePath);
const workspaces = await RemoteWorkspaceStore.open(home, "owner");
await workspaces.register("project", workspaceRoot);
const devices = await RemoteDeviceStore.open(home, "owner");
const full = await devices.issue("macbook", [
  {
    workspaceId: "project",
    permissions: [
      "workspace:read",
      "thread:read",
      "turn:start",
      "turn:control",
    ],
  },
]);
const workspaceOnly = await devices.issue("tablet", [
  {
    workspaceId: "project",
    permissions: ["workspace:read"],
  },
]);
const effectful = await devices.issue("mac-approver", [
  {
    workspaceId: "project",
    permissions: [
      "workspace:read",
      "thread:read",
      "turn:start",
      "workspace:mutate",
      "approval:resolve",
    ],
  },
]);
const mcpDevice = await devices.issue("mac-mcp", [
  {
    workspaceId: "project",
    permissions: [
      "workspace:read",
      "thread:read",
      "turn:start",
      "approval:resolve",
      "mcp:invoke",
    ],
    mcpServerIds: ["reviewed"],
  },
]);
const mcpReceiver = await devices.issue("mac-mcp-receiver", [
  {
    workspaceId: "project",
    permissions: [
      "workspace:read",
      "thread:read",
      "approval:resolve",
      "mcp:invoke",
    ],
    mcpServerIds: ["reviewed"],
  },
]);
const threads = await RemoteThreadStore.open(home, "owner");
await threads.bind({
  ownerId: "owner",
  workspaceId: "project",
  threadId: "thread-1",
});
const requests = await RemoteTurnRequestStore.open(home, "owner");
await requests.claim({
  requestId: "b".repeat(32),
  deviceId: full.deviceId,
  workspaceId: "project",
  bodySha256: createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: "project",
        prompt: "uncertain request",
        resumeThreadId: null,
      }),
    )
    .digest("hex"),
  threadId: "reserved-thread",
  turnId: "reserved-turn",
});
const artifactStore = await ArtifactStore.open(join(home, "artifacts"));
const artifactText = "A".repeat(16_383) + "中文 artifact";
const published = await artifactStore.materializeText(artifactText, {
  inlineBytes: 4,
});
if (published.artifact === undefined)
  throw new Error("Expected a stored artifact.");
const artifact = published.artifact;
const artifactLog = new JsonlEventStore(
  join(home, "threads", "thread-1.jsonl"),
);
await artifactLog.append(
  agentEventSchema.parse({
    schemaVersion: 1,
    sequence: 0,
    timestamp: "2026-09-27T00:00:00.000Z",
    threadId: "thread-1",
    turnId: "turn-1",
    type: "turn.context",
    payload: {
      provider: "openai",
      model: "gpt-test",
      workspaceRoot,
      approvalMode: "on-request",
      instructionsSha256: "0".repeat(64),
      repositoryInstructions: [],
    },
  }),
);
await artifactLog.append(
  agentEventSchema.parse({
    schemaVersion: 1,
    sequence: 1,
    timestamp: "2026-09-27T00:00:01.000Z",
    threadId: "thread-1",
    turnId: "turn-1",
    type: "artifact.recorded",
    payload: { callId: "artifact-call", name: "read_file", artifact },
  }),
);
const artifactApplication = new KodaApplication({
  environment: { KODA_HOME: home },
  processDirectory: workspaceRoot,
});

const metadata = {
  threadId: "thread-1",
  workspaceRoot,
  status: "completed",
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:01:00.000Z",
  turnCount: 1,
  eventCount: 4,
  usage: {
    modelRequests: 0,
    reportedRequests: 0,
    tokens: {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    },
  },
};
const events = [
  {
    sequence: 0,
    timestamp: metadata.createdAt,
    turnId: "turn-1",
    type: "turn.started",
    payload: {},
  },
  {
    sequence: 1,
    timestamp: metadata.createdAt,
    turnId: "turn-1",
    type: "assistant.delta",
    payload: { text: "first" },
  },
  {
    sequence: 2,
    timestamp: metadata.createdAt,
    turnId: "turn-1",
    type: "assistant.delta",
    payload: { text: "second" },
  },
  {
    sequence: 3,
    timestamp: metadata.updatedAt,
    turnId: "turn-1",
    type: "turn.completed",
    payload: {},
  },
];
const application = {
  isRemoteRestricted: true,
  getThread: async (threadId) => ({
    value: threadId === "thread-1" ? metadata : undefined,
    diagnostics: [],
  }),
  readThreadEvents: async ({ afterSequence = -1, limit = 100 }) => {
    const matching = events.filter((event) => event.sequence > afterSequence);
    return {
      events: matching.slice(0, limit),
      hasEarlier: false,
      hasLater: matching.length > limit,
    };
  },
  listThreadArtifacts:
    artifactApplication.listThreadArtifacts.bind(artifactApplication),
  readArtifact: artifactApplication.readArtifact.bind(artifactApplication),
  startTurnAfter: async (input, client, beforeStart) => {
    const isMcp = input.remoteEffects?.mcpServerIds !== undefined;
    const isEffectful =
      input.remoteEffects?.workspaceMutations === true || isMcp;
    const ids = {
      threadId: "thread-1",
      turnId: isEffectful ? `turn-effect-${++effectfulTurns}` : "turn-2",
    };
    await beforeStart(ids);
    if (isEffectful) {
      const controller = new AbortController();
      const completion = client.approvals
        .request(
          {
            callId: isMcp ? `mcp-${effectfulTurns}` : `patch-${effectfulTurns}`,
            name: isMcp ? "mcp__reviewed__effect" : "apply_patch",
            title: isMcp
              ? "Approve reviewed MCP call"
              : "Approve one file patch",
            summary: isMcp
              ? "Call a reviewed MCP tool."
              : "Update remote-note.txt.",
            details: isMcp
              ? "reviewed/effect arguments: {}"
              : "remote-note.txt: before -> after",
            reason: isMcp
              ? "Remote MCP effect needs approval."
              : "Remote write needs approval.",
          },
          controller.signal,
        )
        .then(() => undefined);
      return {
        ...ids,
        completion,
        cancel: () => {
          controller.abort();
          return true;
        },
      };
    }
    let finish;
    const completion = new Promise((resolve) => {
      finish = resolve;
    });
    return {
      ...ids,
      completion,
      cancel: () => {
        finish({ ...ids, status: "cancelled", exitCode: 130 });
        return true;
      },
    };
  },
};
let effectfulTurns = 0;
let server = await startRemoteHttpsServer({
  application,
  kodaHome: home,
  host: "127.0.0.1",
  port: 0,
  certificatePath,
  privateKeyPath,
});
const port = Number(server.address.split(":").at(-1));
process.stdout.write(
  JSON.stringify({
    origin: `https://${server.address}`,
    fingerprint: server.certificateSha256,
    token: full.token,
    effectfulToken: effectful.token,
    mcpToken: mcpDevice.token,
    mcpReceiverToken: mcpReceiver.token,
    mcpReceiverDeviceId: mcpReceiver.deviceId,
    workspaceOnlyToken: workspaceOnly.token,
    artifactId: artifact.id,
  }) + "\n",
);
process.stdin.on("data", (chunk) => {
  const command = chunk.toString("utf8").trim();
  if (command === "abandon") {
    void requests.abandon("b".repeat(32), threads).catch((error) => {
      process.stderr.write(String(error) + "\n");
      process.exitCode = 1;
    });
    return;
  }
  if (command !== "restart") return;
  void (async () => {
    await server.close();
    events.push(
      {
        sequence: 4,
        timestamp: metadata.updatedAt,
        turnId: "turn-3",
        type: "turn.started",
        payload: {},
      },
      {
        sequence: 5,
        timestamp: metadata.updatedAt,
        turnId: "turn-3",
        type: "assistant.delta",
        payload: { text: "after reconnect" },
      },
    );
    server = await startRemoteHttpsServer({
      application,
      kodaHome: home,
      host: "127.0.0.1",
      port,
      certificatePath,
      privateKeyPath,
    });
  })().catch((error) => {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
  });
});
process.on("SIGTERM", async () => {
  await server.close();
  process.exit(0);
});
