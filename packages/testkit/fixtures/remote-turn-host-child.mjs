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
      permissions: ["workspace:read", "turn:start"],
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
      startTurnAfter: async (_input, _client, beforeStart) => {
        const ids = { threadId: "crash-thread", turnId: "crash-turn" };
        await beforeStart(ids);
        return {
          ...ids,
          completion: new Promise(() => undefined),
          cancel: () => true,
        };
      },
    },
    bindings,
    requests,
  );
  result = await host.start(principal, catalog, {
    requestId: "2".repeat(32),
    workspaceId: "project",
    prompt: "Explain the project.",
  });
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.stdin.resume();
