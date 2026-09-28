import { mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RemoteAccessCatalog,
  RemoteAccessDeniedError,
  type RemoteThreadBinding,
} from "@koda/app-server";
import {
  threadMetadataSchema,
  type ThreadMetadataMessage,
} from "@koda/protocol";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "koda-remote-access-"));
  directories.push(root);
  const workspaceRoot = await realpath(root);
  const owner = { ownerId: "owner", deviceId: "macbook" };
  const otherDevice = { ownerId: "owner", deviceId: "iphone" };
  const catalog = await RemoteAccessCatalog.create(
    "owner",
    [{ id: "project", root: workspaceRoot }],
    [
      {
        ...owner,
        workspaceId: "project",
        permissions: ["workspace:read", "thread:read", "turn:start"],
      },
      {
        ...otherDevice,
        workspaceId: "project",
        permissions: ["workspace:read"],
      },
    ],
  );
  const binding: RemoteThreadBinding = {
    ownerId: "owner",
    workspaceId: "project",
    threadId: "thread-1",
  };
  return { root, workspaceRoot, owner, otherDevice, catalog, binding };
}

function metadata(workspaceRoot: string): ThreadMetadataMessage {
  return threadMetadataSchema.parse({
    threadId: "thread-1",
    logFile: "/private/owner/threads/thread-1.jsonl",
    status: "completed",
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:01:00.000Z",
    workspaceRoot,
    turnCount: 1,
    eventCount: 3,
    usage: {
      modelRequests: 1,
      reportedRequests: 1,
      tokens: {
        inputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
        totalTokens: 2,
      },
    },
    sourceBytes: 128,
    indexedBytes: 128,
    sourceMtimeMs: 1,
    errorMessage: "private diagnostic",
  });
}

describe("remote access catalog", () => {
  it("binds actions to a device and exact workspace grant", async () => {
    const { catalog, owner, otherDevice, workspaceRoot } = await fixture();
    await expect(
      catalog.authorizeWorkspace(owner, "project", "turn:start"),
    ).resolves.toBe(workspaceRoot);
    await expect(
      catalog.authorizeWorkspace(otherDevice, "project", "turn:start"),
    ).rejects.toBeInstanceOf(RemoteAccessDeniedError);
    await expect(
      catalog.authorizeWorkspace(owner, "unknown", "workspace:read"),
    ).rejects.toBeInstanceOf(RemoteAccessDeniedError);
    await expect(
      catalog.authorizeWorkspace(
        { ownerId: "other", deviceId: "macbook" },
        "project",
        "workspace:read",
      ),
    ).rejects.toBeInstanceOf(RemoteAccessDeniedError);
  });

  it("reveals only the MCP servers granted to the exact device", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-remote-mcp-access-"));
    directories.push(root);
    const owner = { ownerId: "owner", deviceId: "macbook" };
    const other = { ownerId: "owner", deviceId: "iphone" };
    const catalog = await RemoteAccessCatalog.create(
      "owner",
      [{ id: "project", root: await realpath(root) }],
      [
        {
          ...owner,
          workspaceId: "project",
          permissions: ["mcp:invoke"],
          mcpServerIds: ["reviewed"],
        },
        { ...other, workspaceId: "project", permissions: ["workspace:read"] },
      ],
    );
    await expect(
      catalog.authorizedMcpServers(owner, "project"),
    ).resolves.toEqual(["reviewed"]);
    await expect(
      catalog.authorizedMcpServers(other, "project"),
    ).rejects.toBeInstanceOf(RemoteAccessDeniedError);
    await expect(
      RemoteAccessCatalog.create(
        "owner",
        [{ id: "project", root: await realpath(root) }],
        [
          {
            ...owner,
            workspaceId: "project",
            permissions: ["mcp:invoke"],
          },
        ],
      ),
    ).rejects.toThrow("Remote MCP grant configuration is invalid");
  });

  it("requires an owner/workspace/thread binding and removes host details", async () => {
    const { catalog, owner, otherDevice, binding, workspaceRoot } =
      await fixture();
    const thread = metadata(workspaceRoot);
    const projected = await catalog.projectThread(owner, binding, thread);
    expect(projected).toMatchObject({
      threadId: "thread-1",
      workspaceId: "project",
      status: "completed",
    });
    expect(JSON.stringify(projected)).not.toContain(workspaceRoot);
    expect(JSON.stringify(projected)).not.toContain(thread.logFile);
    expect(JSON.stringify(projected)).not.toContain("private diagnostic");
    await expect(
      catalog.projectThread(otherDevice, binding, thread),
    ).rejects.toBeInstanceOf(RemoteAccessDeniedError);
    await expect(
      catalog.projectThread(owner, undefined, thread),
    ).rejects.toBeInstanceOf(RemoteAccessDeniedError);
    await expect(
      catalog.projectThread(owner, { ...binding, ownerId: "other" }, thread),
    ).rejects.toBeInstanceOf(RemoteAccessDeniedError);
    await expect(
      catalog.projectThread(owner, binding, {
        ...thread,
        workspaceRoot: "/other/workspace",
      }),
    ).rejects.toBeInstanceOf(RemoteAccessDeniedError);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a workspace root that is replaced after configuration",
    async () => {
      const { catalog, owner, root } = await fixture();
      const replacement = await mkdtemp(
        join(tmpdir(), "koda-remote-replaced-"),
      );
      directories.push(replacement);
      await rename(root, join(replacement, "old-root"));
      await symlink(replacement, root);
      await expect(
        catalog.authorizeWorkspace(owner, "project", "workspace:read"),
      ).rejects.toBeInstanceOf(RemoteAccessDeniedError);
    },
  );
});
