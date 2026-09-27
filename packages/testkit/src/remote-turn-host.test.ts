import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type { KodaApplication } from "@koda/app";
import {
  RemoteAccessCatalog,
  RemoteThreadStore,
  RemoteTurnHost,
  RemoteTurnRequestStore,
} from "@koda/app-server";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")("remote Turn host", () => {
  it("does not repeat a remote Turn after SIGKILL at reservation or commit", async () => {
    for (const stage of ["reserved", "started"] as const) {
      const home = await mkdtemp(join(tmpdir(), "koda-remote-kill-home-"));
      const workspace = await mkdtemp(
        join(tmpdir(), "koda-remote-kill-workspace-"),
      );
      directories.push(home, workspace);
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("../fixtures/remote-turn-host-child.mjs", import.meta.url),
          ),
          home,
          workspace,
          stage,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const exited = once(child, "exit");
      try {
        const lines = createInterface({ input: child.stdout });
        const [line] = await once(lines, "line", {
          signal: AbortSignal.timeout(10_000),
        });
        expect(JSON.parse(String(line))).toMatchObject({
          threadId: "crash-thread",
          turnId: "crash-turn",
          status: stage,
        });
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
      const principal = {
        ownerId: "owner",
        deviceId: `device-${"1".repeat(32)}`,
      };
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
      if (stage === "started") {
        expect(await bindings.get("crash-thread")).toMatchObject({
          workspaceId: "project",
        });
      } else {
        expect(await bindings.get("crash-thread")).toBeUndefined();
      }
      expect(await requests.get("2".repeat(32))).toMatchObject({
        status: stage,
      });
      let starts = 0;
      const host = new RemoteTurnHost(
        {
          isRemoteRestricted: true,
          startTurnAfter: async () => {
            starts += 1;
            throw new Error("Turn must not restart.");
          },
        } as unknown as KodaApplication,
        bindings,
        requests,
      );
      const result = await host.start(principal, catalog, {
        requestId: "2".repeat(32),
        workspaceId: "project",
        prompt: "Explain the project.",
      });
      expect(result).toMatchObject({
        threadId: "crash-thread",
        turnId: "crash-turn",
        status: stage,
        replayed: true,
      });
      expect(starts).toBe(0);
      await host.close();
    }
  });

  it("binds before execution, keeps a Turn after the initiating request, and deduplicates retries", async () => {
    const home = await mkdtemp(join(tmpdir(), "koda-remote-turn-host-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "koda-remote-turn-workspace-"),
    );
    directories.push(home, workspace);
    const principal = {
      ownerId: "owner",
      deviceId: `device-${"1".repeat(32)}`,
    };
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
    let starts = 0;
    let cancelled = false;
    let finish: () => void = () => undefined;
    const application = {
      isRemoteRestricted: true,
      startTurnAfter: async (
        _input: unknown,
        _client: unknown,
        beforeStart: (ids: {
          threadId: string;
          turnId: string;
        }) => Promise<void>,
      ) => {
        starts += 1;
        const ids = { threadId: `thread-${starts}`, turnId: `turn-${starts}` };
        await beforeStart(ids);
        expect(await bindings.get(ids.threadId)).toMatchObject({
          workspaceId: "project",
        });
        const completion = new Promise<void>((resolve) => {
          finish = resolve;
        });
        return {
          ...ids,
          completion,
          cancel: () => {
            cancelled = true;
            finish();
            return true;
          },
        };
      },
      getThread: async () => ({
        value: { workspaceRoot: await realpath(workspace) },
      }),
    } as unknown as KodaApplication;
    const host = new RemoteTurnHost(application, bindings, requests);
    const input = {
      requestId: "2".repeat(32),
      workspaceId: "project",
      prompt: "Explain the project.",
    };
    const first = await host.start(principal, catalog, input);
    expect(first).toMatchObject({
      threadId: "thread-1",
      status: "started",
      replayed: false,
    });
    expect(cancelled).toBe(false);
    const replayed = await host.start(principal, catalog, input);
    expect(replayed).toMatchObject({
      threadId: "thread-1",
      status: "started",
      replayed: true,
    });
    await expect(
      host.start(principal, catalog, {
        requestId: "4".repeat(32),
        workspaceId: "project",
        prompt: "Resume history.",
        resumeThreadId: "thread-1",
      }),
    ).rejects.toThrow("Remote resource is unavailable");
    expect(starts).toBe(1);
    await expect(
      host.start(principal, catalog, {
        ...input,
        prompt: "Different request.",
      }),
    ).rejects.toThrow("already used");
    const reservedPrompt = "Never started.";
    await requests.claim({
      requestId: "3".repeat(32),
      deviceId: principal.deviceId,
      workspaceId: "project",
      bodySha256: createHash("sha256")
        .update(
          JSON.stringify({
            workspaceId: "project",
            prompt: reservedPrompt,
            resumeThreadId: null,
          }),
        )
        .digest("hex"),
      threadId: "reserved-thread",
      turnId: "reserved-turn",
    });
    const reserved = await host.start(principal, catalog, {
      requestId: "3".repeat(32),
      workspaceId: "project",
      prompt: reservedPrompt,
    });
    expect(reserved).toMatchObject({ status: "reserved", replayed: true });
    expect(starts).toBe(1);
    await expect(
      host.cancel(principal, catalog, "thread-1", "turn-1"),
    ).rejects.toThrow("Remote resource is unavailable");
    const controller = await RemoteAccessCatalog.create(
      "owner",
      [{ id: "project", root: await realpath(workspace) }],
      [
        {
          ...principal,
          workspaceId: "project",
          permissions: ["turn:control"],
        },
      ],
    );
    expect(
      await host.cancel(principal, controller, "thread-1", "wrong-turn"),
    ).toBe(false);
    expect(await host.cancel(principal, controller, "thread-1", "turn-1")).toBe(
      true,
    );
    expect(cancelled).toBe(true);
    await host.close();
    const reopened = new RemoteTurnHost(
      application,
      bindings,
      await RemoteTurnRequestStore.open(home, "owner"),
    );
    const afterRestart = await reopened.start(principal, catalog, input);
    expect(afterRestart).toMatchObject({
      threadId: "thread-1",
      replayed: true,
    });
    expect(starts).toBe(1);
    await reopened.close();
  });
});
