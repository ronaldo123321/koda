import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

import {
  RemoteAccessCatalog,
  RemoteApprovalLeaseStore,
  RemoteApprovalTransferStore,
  RemoteThreadStore,
  RemoteTurnHost,
  RemoteTurnRequestStore,
} from "@koda/app-server";

const [home, workspace, stage] = process.argv.slice(2);
const principal = { ownerId: "owner", deviceId: `device-${"1".repeat(32)}` };
const target = { ownerId: "owner", deviceId: `device-${"2".repeat(32)}` };
const hasApproval = stage === "approval" || stage === "approval-transfer";
const catalog = await RemoteAccessCatalog.create(
  "owner",
  [{ id: "project", root: await realpath(workspace) }],
  [
    {
      ...principal,
      workspaceId: "project",
      permissions: hasApproval
        ? [
            "workspace:read",
            "thread:read",
            "turn:start",
            "workspace:mutate",
            "approval:resolve",
          ]
        : ["workspace:read", "turn:start"],
    },
    {
      ...target,
      workspaceId: "project",
      permissions: [
        "workspace:read",
        "thread:read",
        "workspace:mutate",
        "approval:resolve",
      ],
    },
  ],
);
const bindings = await RemoteThreadStore.open(home, "owner");
const requests = await RemoteTurnRequestStore.open(home, "owner");
const approvalLeases = await RemoteApprovalLeaseStore.open(home);
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
        if (hasApproval) {
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
    await RemoteApprovalTransferStore.open(home),
    approvalLeases,
  );
  result = await host.start(principal, catalog, {
    requestId: "2".repeat(32),
    workspaceId: "project",
    prompt: "Explain the project.",
    ...(hasApproval ? { effects: ["workspace:mutate"] } : {}),
  });
  if (hasApproval) {
    let approvals = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      approvals = await host.listApprovals(principal, catalog, result.threadId);
      if (approvals.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (stage === "approval-transfer") {
      if (approvals.length !== 1)
        throw new Error("Approval did not become pending.");
      if (
        !(await host.transferApproval(
          principal,
          catalog,
          target,
          catalog,
          result.threadId,
          result.turnId,
          "crash-approval",
        ))
      ) {
        throw new Error("Approval transfer failed.");
      }
      approvals = await host.listApprovals(target, catalog, result.threadId);
    }
    result = { ...result, pendingApprovals: approvals.length };
  }
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.stdin.resume();
