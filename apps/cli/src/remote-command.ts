import {
  RemoteDeviceStore,
  RemoteWorkspaceStore,
  remotePermissionSchema,
  type RemotePermission,
} from "@koda/app-server";

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
): Promise<number> {
  try {
    const permissions = parsePermissions(permissionInput);
    const home = resolveKodaHome(context.environment);
    const workspaces = await RemoteWorkspaceStore.open(home, OWNER_ID);
    if ((await workspaces.get(workspaceId)) === undefined) {
      throw new Error("Remote workspace is unavailable.");
    }
    const devices = await RemoteDeviceStore.open(home, OWNER_ID);
    const issued = await devices.issue(label, [{ workspaceId, permissions }]);
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
