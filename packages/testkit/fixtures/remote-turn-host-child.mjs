import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

import {
  RemoteAccessCatalog,
  RemoteThreadStore,
  RemoteTurnHost,
  RemoteTurnRequestStore,
} from "@koda/app-server";

const [home, workspace, stage] = process.argv.slice(2);
const principal = { ownerId: "owner", deviceId: `device-${"1".repeat(32)}` };
const catalog = await RemoteAccessCatalog.create(
  "owner",
  [{ id: "project", root: await realpath(workspace) }],
  [
    {
      ...principal,
      workspaceId: "project",
      permissions:
        stage === "approval"
          ? [
              "workspace:read",
              "thread:read",
              "turn:start",
              "workspace:mutate",
              "approval:resolve",
            ]
          : ["workspace:read", "turn:start"],
    },
  ],
);
const bindings = await RemoteThreadStore.open(home, "owner");
const requests = await RemoteTurnRequestStore.open(home, "owner");
let result;
if (stage === "reserved") {
  await requests.acquireLease("2".repeat(32));
  const claim = await requests.claim({
    requestId: "2".repeat(32),
    deviceId: principal.deviceId,
    workspaceId: "project",
    bodySha256: createHash("sha256")
      .update(
        JSON.stringify({
          workspaceId: "project",
          prompt: "Explain the project.",
          resumeThreadId: null,
        }),
      )
      .digest("hex"),
    threadId: "crash-thread",
    turnId: "crash-turn",
  });
  result = claim.record;
} else {
  const host = new RemoteTurnHost(
    {
      isRemoteRestricted: true,
      startTurnAfter: async (_input, client, beforeStart) => {
        const ids = { threadId: "crash-thread", turnId: "crash-turn" };
        await beforeStart(ids);
        if (stage === "approval") {
          void client.approvals.request(
            {
              callId: "crash-approval",
              name: "apply_patch",
              title: "Review a patch",
              summary: "Update one file.",
              details: "Exact change.",
              reason: "Remote write needs approval.",
            },
            new AbortController().signal,
          );
        }
        return {
          ...ids,
          completion: new Promise(() => undefined),
          cancel: () => true,
        };
      },
      getThread: async () => ({
        value: { workspaceRoot: await realpath(workspace) },
      }),
    },
    bindings,
    requests,
  );
  result = await host.start(principal, catalog, {
    requestId: "2".repeat(32),
    workspaceId: "project",
    prompt: "Explain the project.",
    ...(stage === "approval" ? { effects: ["workspace:mutate"] } : {}),
  });
  if (stage === "approval") {
    const approvals = await host.listApprovals(
      principal,
      catalog,
      result.threadId,
    );
    result = { ...result, pendingApprovals: approvals.length };
  }
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.stdin.resume();
