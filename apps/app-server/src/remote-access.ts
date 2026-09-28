import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  modelProviderIdSchema,
  type ThreadMetadataMessage,
} from "@koda/protocol";
import { z } from "zod";

const idSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);

export const remotePermissionSchema = z.enum([
  "workspace:read",
  "thread:read",
  "turn:start",
  "turn:control",
  "approval:resolve",
  "process:control",
  "workspace:mutate",
  "mcp:invoke",
]);

export type RemotePermission = z.infer<typeof remotePermissionSchema>;

export interface RemotePrincipal {
  ownerId: string;
  deviceId: string;
}

export interface RemoteWorkspaceDefinition {
  id: string;
  root: string;
}

export interface RemoteWorkspaceGrant {
  ownerId: string;
  deviceId: string;
  workspaceId: string;
  permissions: readonly RemotePermission[];
  mcpServerIds?: readonly string[];
}

export interface RemoteThreadBinding {
  ownerId: string;
  workspaceId: string;
  threadId: string;
}

export interface RemoteThreadSummary {
  threadId: string;
  workspaceId: string;
  status: ThreadMetadataMessage["status"];
  createdAt: string;
  updatedAt: string;
  provider?: ThreadMetadataMessage["provider"];
  model?: string;
  turnCount: number;
  eventCount: number;
  lastSequence?: number;
  usage: ThreadMetadataMessage["usage"];
}

type RemoteThreadMetadataInput = Omit<ThreadMetadataMessage, "provider"> & {
  provider?: string | undefined;
};

export class RemoteAccessDeniedError extends Error {
  public constructor() {
    super("Remote resource is unavailable.");
    this.name = "RemoteAccessDeniedError";
  }
}

export class RemoteAccessCatalog {
  private readonly ownerId: string;
  private readonly workspaces: ReadonlyMap<string, string>;
  private readonly grants: ReadonlyMap<string, ReadonlySet<RemotePermission>>;
  private readonly mcpServers: ReadonlyMap<string, ReadonlySet<string>>;

  private constructor(
    ownerId: string,
    workspaces: ReadonlyMap<string, string>,
    grants: ReadonlyMap<string, ReadonlySet<RemotePermission>>,
    mcpServers: ReadonlyMap<string, ReadonlySet<string>>,
  ) {
    this.ownerId = ownerId;
    this.workspaces = workspaces;
    this.grants = grants;
    this.mcpServers = mcpServers;
  }

  public static async create(
    ownerId: string,
    workspaces: readonly RemoteWorkspaceDefinition[],
    grants: readonly RemoteWorkspaceGrant[],
  ): Promise<RemoteAccessCatalog> {
    idSchema.parse(ownerId);
    const roots = new Map<string, string>();
    const usedRoots = new Set<string>();
    for (const workspace of workspaces) {
      idSchema.parse(workspace.id);
      if (!isAbsolute(workspace.root) || roots.has(workspace.id)) {
        throw new Error("Remote workspace configuration is invalid.");
      }
      const root = await realpath(workspace.root);
      if (!(await stat(root)).isDirectory() || usedRoots.has(root)) {
        throw new Error("Remote workspace configuration is invalid.");
      }
      roots.set(workspace.id, root);
      usedRoots.add(root);
    }
    const allowed = new Map<string, ReadonlySet<RemotePermission>>();
    const mcpServers = new Map<string, ReadonlySet<string>>();
    for (const grant of grants) {
      idSchema.parse(grant.ownerId);
      idSchema.parse(grant.deviceId);
      if (
        grant.ownerId !== ownerId ||
        !roots.has(grant.workspaceId) ||
        grant.permissions.length === 0
      ) {
        throw new Error("Remote grant configuration is invalid.");
      }
      const key = grantKey(grant, grant.workspaceId);
      if (allowed.has(key)) {
        throw new Error("Remote grant configuration is invalid.");
      }
      const permissions = new Set(
        grant.permissions.map((permission) =>
          remotePermissionSchema.parse(permission),
        ),
      );
      if (permissions.size !== grant.permissions.length) {
        throw new Error("Remote grant configuration is invalid.");
      }
      const serverIds = grant.mcpServerIds ?? [];
      if (
        serverIds.length > 16 ||
        serverIds.some((id) => !/^[a-z][a-z0-9_-]{0,23}$/u.test(id)) ||
        new Set(serverIds).size !== serverIds.length ||
        permissions.has("mcp:invoke") !== serverIds.length > 0
      ) {
        throw new Error("Remote MCP grant configuration is invalid.");
      }
      allowed.set(key, permissions);
      mcpServers.set(key, new Set(serverIds));
    }
    return new RemoteAccessCatalog(ownerId, roots, allowed, mcpServers);
  }

  public async authorizedMcpServers(
    principal: RemotePrincipal,
    workspaceId: string,
  ): Promise<readonly string[]> {
    await this.authorizeWorkspace(principal, workspaceId, "mcp:invoke");
    return [...(this.mcpServers.get(grantKey(principal, workspaceId)) ?? [])];
  }

  public async authorizeWorkspace(
    principal: RemotePrincipal,
    workspaceId: string,
    permission: RemotePermission,
  ): Promise<string> {
    const root = this.workspaces.get(workspaceId);
    if (
      principal.ownerId !== this.ownerId ||
      root === undefined ||
      !this.grants.get(grantKey(principal, workspaceId))?.has(permission)
    ) {
      throw new RemoteAccessDeniedError();
    }
    try {
      if (
        (await realpath(root)) !== root ||
        !(await stat(root)).isDirectory()
      ) {
        throw new RemoteAccessDeniedError();
      }
    } catch {
      throw new RemoteAccessDeniedError();
    }
    return root;
  }

  public async authorizeThread(
    principal: RemotePrincipal,
    binding: RemoteThreadBinding | undefined,
    permission: RemotePermission,
  ): Promise<string> {
    if (binding === undefined || binding.ownerId !== principal.ownerId) {
      throw new RemoteAccessDeniedError();
    }
    return this.authorizeWorkspace(principal, binding.workspaceId, permission);
  }

  public async projectThread(
    principal: RemotePrincipal,
    binding: RemoteThreadBinding | undefined,
    metadata: RemoteThreadMetadataInput,
  ): Promise<RemoteThreadSummary> {
    const root = await this.authorizeThread(principal, binding, "thread:read");
    if (
      binding === undefined ||
      binding.threadId !== metadata.threadId ||
      metadata.workspaceRoot !== root
    ) {
      throw new RemoteAccessDeniedError();
    }
    const provider = modelProviderIdSchema.safeParse(metadata.provider);
    return {
      threadId: metadata.threadId,
      workspaceId: binding.workspaceId,
      status: metadata.status,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      ...(provider.success ? { provider: provider.data } : {}),
      ...(metadata.model === undefined ? {} : { model: metadata.model }),
      turnCount: metadata.turnCount,
      eventCount: metadata.eventCount,
      ...(metadata.lastSequence === undefined
        ? {}
        : { lastSequence: metadata.lastSequence }),
      usage: metadata.usage,
    };
  }
}

function grantKey(principal: RemotePrincipal, workspaceId: string): string {
  return `${principal.ownerId}\0${principal.deviceId}\0${workspaceId}`;
}
