import { lstat } from "node:fs/promises";
import { join } from "node:path";

import {
  RemoteApprovalLeaseStore,
  RemoteDeviceStore,
  RemoteThreadStore,
  RemoteTurnRequestStore,
  RemoteWorkspaceStore,
  remotePermissionSchema,
  startRemoteHttpsServer,
  type RemotePermission,
} from "@koda/app-server";
import { KodaApplication } from "@koda/app";

import { resolveKodaHome } from "./config.js";
import type { TextWriter } from "./console-event-sink.js";

export interface RemoteCommandContext {
  environment: NodeJS.ProcessEnv;
  stdout: TextWriter;
  stderr: TextWriter;
}

const OWNER_ID = "owner";
const DEFAULT_PERMISSIONS: readonly RemotePermission[] = [
  "workspace:read",
  "thread:read",
];

export async function runRemoteWorkspaceAddCommand(
  id: string,
  path: string,
  context: RemoteCommandContext,
): Promise<number> {
  try {
    const store = await RemoteWorkspaceStore.open(
      resolveKodaHome(context.environment),
      OWNER_ID,
    );
    const workspace = await store.register(id, path);
    context.stdout.write(
      `Registered workspace ${workspace.id}: ${workspace.root}\n`,
    );
    return 0;
  } catch (error) {
    return fail(context, error);
  }
}

export async function runRemoteWorkspaceListCommand(
  context: RemoteCommandContext,
): Promise<number> {
  try {
    const store = await RemoteWorkspaceStore.open(
      resolveKodaHome(context.environment),
      OWNER_ID,
    );
    for (const workspace of await store.list()) {
      context.stdout.write(`${workspace.id}\t${workspace.root}\n`);
    }
    return 0;
  } catch (error) {
    return fail(context, error);
  }
}

export async function runRemoteDeviceIssueCommand(
  label: string,
  workspaceId: string,
  permissionInput: string | undefined,
  context: RemoteCommandContext,
  mcpServerInput?: string,
): Promise<number> {
  try {
    const permissions = parsePermissions(permissionInput);
    const mcpServerIds = mcpServerInput
      ?.split(",")
      .map((value) => value.trim());
    if (
      permissions.includes("mcp:invoke") !== (mcpServerIds !== undefined) ||
      (mcpServerIds !== undefined &&
        (mcpServerIds.length === 0 ||
          new Set(mcpServerIds).size !== mcpServerIds.length ||
          mcpServerIds.some((id) => !/^[a-z][a-z0-9_-]{0,23}$/u.test(id))))
    ) {
      throw new Error("Remote MCP server grants are invalid.");
    }
    const home = resolveKodaHome(context.environment);
    const workspaces = await RemoteWorkspaceStore.open(home, OWNER_ID);
    if ((await workspaces.get(workspaceId)) === undefined) {
      throw new Error("Remote workspace is unavailable.");
    }
    const devices = await RemoteDeviceStore.open(home, OWNER_ID);
    const issued = await devices.issue(label, [
      {
        workspaceId,
        permissions,
        ...(mcpServerIds === undefined ? {} : { mcpServerIds }),
      },
    ]);
    context.stdout.write(`Device ID: ${issued.deviceId}\n`);
    context.stdout.write(`Expires: ${issued.expiresAt}\n`);
    context.stdout.write(`Token (shown once): ${issued.token}\n`);
    return 0;
  } catch (error) {
    return fail(context, error);
  }
}

export async function runRemoteDeviceRevokeCommand(
  deviceId: string,
  context: RemoteCommandContext,
): Promise<number> {
  try {
    const devices = await RemoteDeviceStore.open(
      resolveKodaHome(context.environment),
      OWNER_ID,
    );
    await devices.revoke(deviceId);
    context.stdout.write(`Revoked device ${deviceId}\n`);
    return 0;
  } catch (error) {
    return fail(context, error);
  }
}

export async function runRemoteThreadExposeCommand(
  threadId: string,
  workspaceId: string,
  context: RemoteCommandContext & { processDirectory: string },
): Promise<number> {
  try {
    const home = resolveKodaHome(context.environment);
    const workspaces = await RemoteWorkspaceStore.open(home, OWNER_ID);
    const workspace = await workspaces.get(workspaceId);
    if (workspace === undefined) {
      throw new Error("Remote workspace is unavailable.");
    }
    const application = new KodaApplication({
      environment: context.environment,
      processDirectory: context.processDirectory,
    });
    const metadata = (await application.getThread(threadId)).value;
    if (metadata === undefined || metadata.workspaceRoot !== workspace.root) {
      throw new Error("Thread is unavailable in the selected workspace.");
    }
    const threads = await RemoteThreadStore.open(home, OWNER_ID);
    await threads.bind({ ownerId: OWNER_ID, workspaceId, threadId });
    context.stdout.write(
      `Exposed Thread ${threadId} in workspace ${workspaceId}\n`,
    );
    return 0;
  } catch (error) {
    return fail(context, error);
  }
}

export async function runRemoteRequestInspectCommand(
  requestId: string,
  context: RemoteCommandContext,
): Promise<number> {
  try {
    const home = resolveKodaHome(context.environment);
    const requests = await RemoteTurnRequestStore.open(home, OWNER_ID);
    const record = await requests.get(requestId);
    if (record === undefined)
      throw new Error("Remote Turn request is unavailable.");
    const threads = await RemoteThreadStore.open(home, OWNER_ID);
    const binding = await threads.get(record.threadId);
    let threadLogPresent = false;
    try {
      await lstat(join(home, "threads", `${record.threadId}.jsonl`));
      threadLogPresent = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    context.stdout.write(
      `${JSON.stringify({
        requestId: record.requestId,
        status: record.status,
        deviceId: record.deviceId,
        workspaceId: record.workspaceId,
        threadId: record.threadId,
        turnId: record.turnId,
        threadBound: binding !== undefined,
        threadLogPresent,
      })}\n`,
    );
    return 0;
  } catch (error) {
    return fail(context, error);
  }
}

export async function runRemoteRequestAbandonCommand(
  requestId: string,
  context: RemoteCommandContext,
): Promise<number> {
  try {
    const home = resolveKodaHome(context.environment);
    const requests = await RemoteTurnRequestStore.open(home, OWNER_ID);
    const threads = await RemoteThreadStore.open(home, OWNER_ID);
    const record = await requests.abandon(requestId, threads);
    context.stdout.write(`Abandoned remote request ${record.requestId}\n`);
    return 0;
  } catch (error) {
    return fail(context, error);
  }
}

export async function runRemoteApprovalInspectCommand(
  threadId: string,
  turnId: string,
  callId: string,
  context: RemoteCommandContext & { processDirectory: string },
): Promise<number> {
  try {
    const leases = await RemoteApprovalLeaseStore.open(
      resolveKodaHome(context.environment),
    );
    const record = await leases.get(threadId, turnId, callId);
    if (record === undefined)
      throw new Error("Remote approval is unavailable.");
    const application = new KodaApplication({
      environment: context.environment,
      processDirectory: context.processDirectory,
    });
    const thread = (await application.getThread(threadId)).value;
    const interrupted =
      record.status === "pending" &&
      thread?.lastTurnId === turnId &&
      thread.status === "interrupted";
    context.stdout.write(
      `${JSON.stringify({
        threadId,
        turnId,
        callId,
        workspaceId: record.workspaceId,
        deviceId: record.deviceId,
        expiresAt: record.expiresAt,
        status: interrupted ? "interrupted" : record.status,
        ...(interrupted ? { recovery: "start_new_turn" } : {}),
      })}\n`,
    );
    return 0;
  } catch (error) {
    return fail(context, error);
  }
}

export async function runRemoteServeCommand(
  options: {
    host: string;
    port: string;
    certificatePath: string;
    privateKeyPath: string;
  },
  context: RemoteCommandContext & { processDirectory: string },
  signal: AbortSignal,
): Promise<number> {
  try {
    if (!/^\d+$/u.test(options.port)) {
      throw new Error("Remote port must be a whole number.");
    }
    const application = new KodaApplication({
      environment: context.environment,
      processDirectory: context.processDirectory,
      remoteRestricted: true,
    });
    const server = await startRemoteHttpsServer({
      application,
      kodaHome: resolveKodaHome(context.environment),
      host: options.host,
      port: Number(options.port),
      certificatePath: options.certificatePath,
      privateKeyPath: options.privateKeyPath,
    });
    try {
      context.stdout.write(`Remote HTTPS listening at ${server.address}\n`);
      context.stdout.write(
        `Certificate SHA-256: ${server.certificateSha256}\n`,
      );
      if (!signal.aborted) {
        await new Promise<void>((resolveAbort) =>
          signal.addEventListener("abort", () => resolveAbort(), {
            once: true,
          }),
        );
      }
    } finally {
      await server.close();
    }
    return 0;
  } catch (error) {
    return fail(context, error);
  }
}

function parsePermissions(input: string | undefined): RemotePermission[] {
  if (input === undefined) {
    return [...DEFAULT_PERMISSIONS];
  }
  const permissions = input
    .split(",")
    .map((value) => remotePermissionSchema.parse(value.trim()));
  if (
    permissions.length === 0 ||
    new Set(permissions).size !== permissions.length
  ) {
    throw new Error("Remote device permissions are invalid.");
  }
  return permissions;
}

function fail(context: RemoteCommandContext, error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  context.stderr.write(`[koda] ${message}\n`);
  return 1;
}
