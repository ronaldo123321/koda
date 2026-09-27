import { realpath } from "node:fs/promises";

import {
  RemoteDeviceStore,
  RemoteThreadStore,
  RemoteWorkspaceStore,
  startRemoteHttpsServer,
} from "@koda/app-server";

const [home, workspacePath, certificatePath, privateKeyPath] = process.argv.slice(2);
const workspaceRoot = await realpath(workspacePath);
const workspaces = await RemoteWorkspaceStore.open(home, "owner");
await workspaces.register("project", workspaceRoot);
const devices = await RemoteDeviceStore.open(home, "owner");
const full = await devices.issue("macbook", [{
  workspaceId: "project",
  permissions: ["workspace:read", "thread:read", "turn:start", "turn:control"],
}]);
const workspaceOnly = await devices.issue("tablet", [{
  workspaceId: "project",
  permissions: ["workspace:read"],
}]);
const threads = await RemoteThreadStore.open(home, "owner");
await threads.bind({ ownerId: "owner", workspaceId: "project", threadId: "thread-1" });

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
  { sequence: 0, timestamp: metadata.createdAt, turnId: "turn-1", type: "turn.started", payload: {} },
  { sequence: 1, timestamp: metadata.createdAt, turnId: "turn-1", type: "assistant.delta", payload: { text: "first" } },
  { sequence: 2, timestamp: metadata.createdAt, turnId: "turn-1", type: "assistant.delta", payload: { text: "second" } },
  { sequence: 3, timestamp: metadata.updatedAt, turnId: "turn-1", type: "turn.completed", payload: {} },
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
  startTurnAfter: async (_input, _client, beforeStart) => {
    const ids = { threadId: "thread-1", turnId: "turn-2" };
    await beforeStart(ids);
    let finish;
    const completion = new Promise((resolve) => { finish = resolve; });
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
const server = await startRemoteHttpsServer({
  application, kodaHome: home, host: "127.0.0.1", port: 0,
  certificatePath, privateKeyPath,
});
process.stdout.write(JSON.stringify({
  origin: `https://${server.address}`,
  fingerprint: server.certificateSha256,
  token: full.token,
  workspaceOnlyToken: workspaceOnly.token,
}) + "\n");
process.on("SIGTERM", async () => {
  await server.close();
  process.exit(0);
});
