import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { KodaApplication, type TurnClient } from "@koda/app";
import {
  RemoteAccessCatalog,
  RemoteApprovalLeaseStore,
  RemoteApprovalTransferStore,
  RemoteThreadStore,
  RemoteTurnHost,
  RemoteTurnRequestStore,
} from "@koda/app-server";
import { threadIdSchema, toolCallIdSchema, turnIdSchema } from "@koda/protocol";
import { ScriptedModelProvider } from "@koda/providers";
import { ReadOnlyWorkspace } from "@koda/runtime-node";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeterministicItemIdFactory } from "./deterministic.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")("remote Turn host", () => {
  it("passes only the initiating device's reviewed MCP servers to a remote Turn", async () => {
    const home = await mkdtemp(join(tmpdir(), "koda-remote-mcp-home-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "koda-remote-mcp-workspace-"),
    );
    directories.push(home, workspace);
    const root = await realpath(workspace);
    const owner = { ownerId: "owner", deviceId: `device-${"1".repeat(32)}` };
    const other = { ownerId: "owner", deviceId: `device-${"2".repeat(32)}` };
    const catalog = await RemoteAccessCatalog.create(
      "owner",
      [{ id: "project", root }],
      [
        {
          ...owner,
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
        {
          ...other,
          workspaceId: "project",
          permissions: ["workspace:read", "thread:read", "turn:start"],
        },
      ],
    );
    let seenEffects: unknown;
    let finish: () => void = () => undefined;
    const application = {
      isRemoteRestricted: true,
      startTurnAfter: async (
        input: { remoteEffects?: unknown },
        _client: TurnClient,
        beforeStart: (ids: {
          threadId: string;
          turnId: string;
        }) => Promise<void>,
      ) => {
        seenEffects = input.remoteEffects;
        const ids = { threadId: "mcp-thread", turnId: "mcp-turn" };
        await beforeStart(ids);
        return {
          ...ids,
          completion: new Promise<void>((resolve) => {
            finish = resolve;
          }),
          cancel: () => {
            finish();
            return true;
          },
        };
      },
      getThread: async () => ({ value: { workspaceRoot: root } }),
    } as unknown as KodaApplication;
    const host = new RemoteTurnHost(
      application,
      await RemoteThreadStore.open(home, "owner"),
      await RemoteTurnRequestStore.open(home, "owner"),
    );
    try {
      await expect(
        host.start(other, catalog, {
          requestId: "a".repeat(32),
          workspaceId: "project",
          prompt: "Use MCP.",
          effects: ["mcp:invoke"],
        }),
      ).rejects.toThrow("Remote resource is unavailable");
      await host.start(owner, catalog, {
        requestId: "b".repeat(32),
        workspaceId: "project",
        prompt: "Use MCP.",
        effects: ["mcp:invoke"],
      });
      expect(seenEffects).toEqual({ mcpServerIds: ["reviewed"] });
    } finally {
      await host.close();
    }
  });

  it("runs a real remote patch only after approval and leaves a rejected patch unchanged", async () => {
    for (const decision of ["approved", "rejected"] as const) {
      const home = await mkdtemp(join(tmpdir(), "koda-remote-real-home-"));
      const workspace = await mkdtemp(
        join(tmpdir(), "koda-remote-real-workspace-"),
      );
      directories.push(home, workspace);
      const target = join(workspace, "note.txt");
      await writeFile(target, "before\n");
      const provider = new ScriptedModelProvider([
        {
          events: [
            {
              type: "tool_call",
              callId: toolCallIdSchema.parse("remote-real-patch"),
              name: "apply_patch",
              arguments: {
                path: "note.txt",
                operation: "update",
                old_text: "before\n",
                new_text: "after\n",
              },
            },
            { type: "completed", finishReason: "tool_calls" },
          ],
        },
        { events: [{ type: "completed", finishReason: "stop" }] },
      ]);
      const application = new KodaApplication({
        environment: { KODA_HOME: home, OPENAI_API_KEY: "offline-test-key" },
        processDirectory: workspace,
        remoteRestricted: true,
        dependencies: {
          openWorkspace: (root) => ReadOnlyWorkspace.open(root),
          createProvider: () => provider,
          createIds: () => ({
            threadId: threadIdSchema.parse("remote-real-thread"),
            turnId: turnIdSchema.parse("remote-real-turn"),
            itemIds: new DeterministicItemIdFactory("remote-real-item"),
          }),
        },
      });
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
            permissions: [
              "workspace:read",
              "thread:read",
              "turn:start",
              "workspace:mutate",
              "approval:resolve",
            ],
          },
        ],
      );
      const host = new RemoteTurnHost(
        application,
        await RemoteThreadStore.open(home, "owner"),
        await RemoteTurnRequestStore.open(home, "owner"),
      );
      try {
        const started = await host.start(principal, catalog, {
          requestId: decision === "approved" ? "a".repeat(32) : "b".repeat(32),
          workspaceId: "project",
          prompt: "Update note.txt.",
          effects: ["workspace:mutate"],
        });
        let approvals = await host.listApprovals(
          principal,
          catalog,
          started.threadId,
        );
        for (
          let attempt = 0;
          approvals.length === 0 && attempt < 50;
          attempt++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          approvals = await host.listApprovals(
            principal,
            catalog,
            started.threadId,
          );
        }
        expect(approvals).toHaveLength(1);
        expect(approvals[0]).toMatchObject({
          turnId: started.turnId,
          callId: "remote-real-patch",
          name: "apply_patch",
        });
        expect(await readFile(target, "utf8")).toBe("before\n");
        expect(
          await host.resolveApproval(
            principal,
            catalog,
            started.threadId,
            started.turnId,
            "remote-real-patch",
            decision,
          ),
        ).toBe(true);
        expect(
          await host.resolveApproval(
            principal,
            catalog,
            started.threadId,
            started.turnId,
            "remote-real-patch",
            decision,
          ),
        ).toBe(false);
        let status = (await application.getThread(started.threadId)).value
          ?.status;
        for (
          let attempt = 0;
          status !== "completed" && attempt < 50;
          attempt++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          status = (await application.getThread(started.threadId)).value
            ?.status;
        }
        expect(status).toBe("completed");
        expect(await readFile(target, "utf8")).toBe(
          decision === "approved" ? "after\n" : "before\n",
        );
      } finally {
        await host.close();
      }
    }
  });

  it("does not repeat a remote Turn or revive an approval after SIGKILL", async () => {
    for (const stage of [
      "reserved",
      "started",
      "approval",
      "approval-transfer",
    ] as const) {
      const hasApproval = stage === "approval" || stage === "approval-transfer";
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
          status: hasApproval ? "started" : stage,
          ...(hasApproval ? { pendingApprovals: 1 } : {}),
        });
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
      const principal = {
        ownerId: "owner",
        deviceId: `device-${"1".repeat(32)}`,
      };
      const target = {
        ownerId: "owner",
        deviceId: `device-${"2".repeat(32)}`,
      };
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
      if (stage !== "reserved") {
        expect(await bindings.get("crash-thread")).toMatchObject({
          workspaceId: "project",
        });
      } else {
        expect(await bindings.get("crash-thread")).toBeUndefined();
      }
      expect(await requests.get("2".repeat(32))).toMatchObject({
        status: stage === "reserved" ? "reserved" : "started",
      });
      let starts = 0;
      const host = new RemoteTurnHost(
        {
          isRemoteRestricted: true,
          startTurnAfter: async () => {
            starts += 1;
            throw new Error("Turn must not restart.");
          },
          getThread: async () => ({
            value:
              stage !== "reserved"
                ? {
                    status: "interrupted",
                    lastTurnId: "crash-turn",
                    workspaceRoot: await realpath(workspace),
                  }
                : undefined,
          }),
        } as unknown as KodaApplication,
        bindings,
        requests,
      );
      const result = await host.start(principal, catalog, {
        requestId: "2".repeat(32),
        workspaceId: "project",
        prompt: "Explain the project.",
        ...(hasApproval ? { effects: ["workspace:mutate"] as const } : {}),
      });
      expect(result).toMatchObject({
        threadId: "crash-thread",
        turnId: "crash-turn",
        status: stage === "reserved" ? "reserved" : "interrupted",
        replayed: true,
      });
      expect(starts).toBe(0);
      if (hasApproval) {
        expect(
          await approvalLeases.get(
            "crash-thread",
            "crash-turn",
            "crash-approval",
          ),
        ).toMatchObject({
          deviceId:
            stage === "approval-transfer"
              ? target.deviceId
              : principal.deviceId,
          status: "pending",
        });
        expect(
          await host.listApprovals(principal, catalog, "crash-thread"),
        ).toEqual([]);
        expect(
          await host.resolveApproval(
            principal,
            catalog,
            "crash-thread",
            "crash-turn",
            "crash-approval",
            "approved",
          ),
        ).toBe(false);
        expect(
          await host.resolveApproval(
            target,
            catalog,
            "crash-thread",
            "crash-turn",
            "crash-approval",
            "approved",
          ),
        ).toBe(false);
      }
      if (stage === "reserved") {
        expect(await requests.abandon("2".repeat(32), bindings)).toMatchObject({
          status: "abandoned",
        });
        expect(
          await host.start(principal, catalog, {
            requestId: "2".repeat(32),
            workspaceId: "project",
            prompt: "Explain the project.",
          }),
        ).toMatchObject({ status: "abandoned", replayed: true });
        expect(starts).toBe(0);
      }
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

  it("binds a remote approval to its initiating device, exact call, and live Turn", async () => {
    const home = await mkdtemp(join(tmpdir(), "koda-remote-approval-home-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "koda-remote-approval-workspace-"),
    );
    directories.push(home, workspace);
    const root = await realpath(workspace);
    const owner = { ownerId: "owner", deviceId: `device-${"1".repeat(32)}` };
    const other = { ownerId: "owner", deviceId: `device-${"2".repeat(32)}` };
    const limited = { ownerId: "owner", deviceId: `device-${"3".repeat(32)}` };
    const allowed = await RemoteAccessCatalog.create(
      "owner",
      [{ id: "project", root }],
      [
        {
          ...owner,
          workspaceId: "project",
          permissions: [
            "workspace:read",
            "thread:read",
            "turn:start",
            "workspace:mutate",
            "approval:resolve",
          ],
        },
        {
          ...other,
          workspaceId: "project",
          permissions: [
            "workspace:read",
            "thread:read",
            "workspace:mutate",
            "approval:resolve",
          ],
        },
        {
          ...limited,
          workspaceId: "project",
          permissions: ["workspace:read", "thread:read", "approval:resolve"],
        },
      ],
    );
    const readOnly = await RemoteAccessCatalog.create(
      "owner",
      [{ id: "project", root }],
      [
        {
          ...owner,
          workspaceId: "project",
          permissions: ["workspace:read", "thread:read", "turn:start"],
        },
      ],
    );
    const bindings = await RemoteThreadStore.open(home, "owner");
    const requests = await RemoteTurnRequestStore.open(home, "owner");
    let decision: Promise<{ decision: string }> | undefined;
    let finish: () => void = () => undefined;
    const application = {
      isRemoteRestricted: true,
      startTurnAfter: async (
        input: { approvalMode: string; remoteEffects?: object },
        client: TurnClient,
        beforeStart: (ids: {
          threadId: string;
          turnId: string;
        }) => Promise<void>,
      ) => {
        expect(input).toMatchObject({
          approvalMode: "on-request",
          remoteEffects: { workspaceMutations: true },
        });
        const ids = { threadId: "approved-thread", turnId: "approved-turn" };
        await beforeStart(ids);
        decision = client.approvals.request(
          {
            callId: toolCallIdSchema.parse("approved-call"),
            name: "apply_patch",
            title: "Review one patch",
            summary: "Update one file.",
            details: "Exact patch preview.",
            reason: "A write requires approval.",
          },
          new AbortController().signal,
        );
        const completion = new Promise<void>((resolve) => {
          finish = resolve;
        });
        return {
          ...ids,
          completion,
          cancel: () => {
            finish();
            return true;
          },
        };
      },
      getThread: async () => ({ value: { workspaceRoot: root } }),
    } as unknown as KodaApplication;
    const audit = await RemoteApprovalTransferStore.open(home);
    const approvalLeases = await RemoteApprovalLeaseStore.open(home);
    const host = new RemoteTurnHost(
      application,
      bindings,
      requests,
      audit,
      approvalLeases,
    );
    await expect(
      host.start(owner, readOnly, {
        requestId: "1".repeat(32),
        workspaceId: "project",
        prompt: "Change one file.",
        effects: ["workspace:mutate"],
      }),
    ).rejects.toThrow("Remote resource is unavailable");
    await host.start(owner, allowed, {
      requestId: "2".repeat(32),
      workspaceId: "project",
      prompt: "Change one file.",
      effects: ["workspace:mutate"],
    });
    await vi.waitFor(async () => {
      expect(
        await host.listApprovals(owner, allowed, "approved-thread"),
      ).toEqual([
        expect.objectContaining({
          turnId: "approved-turn",
          callId: "approved-call",
          details: "Exact patch preview.",
        }),
      ]);
    });
    expect(
      await approvalLeases.get(
        "approved-thread",
        "approved-turn",
        "approved-call",
      ),
    ).toMatchObject({ deviceId: owner.deviceId, status: "pending" });
    expect(await host.listApprovals(other, allowed, "approved-thread")).toEqual(
      [],
    );
    expect(
      await host.resolveApproval(
        other,
        allowed,
        "approved-thread",
        "approved-turn",
        "approved-call",
        "approved",
      ),
    ).toBe(false);
    expect(
      await host.resolveApproval(
        owner,
        allowed,
        "approved-thread",
        "wrong-turn",
        "approved-call",
        "approved",
      ),
    ).toBe(false);
    await expect(
      host.transferApproval(
        owner,
        allowed,
        limited,
        allowed,
        "approved-thread",
        "approved-turn",
        "approved-call",
      ),
    ).rejects.toThrow("Remote resource is unavailable");
    const auditWrite = vi
      .spyOn(audit, "append")
      .mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(
      host.transferApproval(
        owner,
        allowed,
        other,
        allowed,
        "approved-thread",
        "approved-turn",
        "approved-call",
      ),
    ).rejects.toThrow("audit unavailable");
    auditWrite.mockRestore();
    expect(
      await host.listApprovals(owner, allowed, "approved-thread"),
    ).toHaveLength(1);
    expect(
      await host.transferApproval(
        owner,
        allowed,
        other,
        allowed,
        "approved-thread",
        "approved-turn",
        "approved-call",
      ),
    ).toBe(true);
    const auditFiles = await readdir(
      join(home, "remote", "approval-transfers"),
    );
    expect(auditFiles).toHaveLength(1);
    expect(
      JSON.parse(
        await readFile(
          join(home, "remote", "approval-transfers", auditFiles[0]!),
          "utf8",
        ),
      ),
    ).toMatchObject({
      fromDeviceId: owner.deviceId,
      toDeviceId: other.deviceId,
      callId: "approved-call",
    });
    expect(await host.listApprovals(owner, allowed, "approved-thread")).toEqual(
      [],
    );
    expect(
      await host.listApprovals(other, allowed, "approved-thread"),
    ).toHaveLength(1);
    expect(
      await approvalLeases.get(
        "approved-thread",
        "approved-turn",
        "approved-call",
      ),
    ).toMatchObject({ deviceId: other.deviceId, status: "pending" });
    expect(
      await host.resolveApproval(
        owner,
        allowed,
        "approved-thread",
        "approved-turn",
        "approved-call",
        "approved",
      ),
    ).toBe(false);
    const simultaneous = await Promise.all([
      host.resolveApproval(
        other,
        allowed,
        "approved-thread",
        "approved-turn",
        "approved-call",
        "approved",
      ),
      host.resolveApproval(
        other,
        allowed,
        "approved-thread",
        "approved-turn",
        "approved-call",
        "approved",
      ),
    ]);
    expect(simultaneous.sort()).toEqual([false, true]);
    await expect(decision).resolves.toMatchObject({ decision: "approved" });
    expect(
      await approvalLeases.get(
        "approved-thread",
        "approved-turn",
        "approved-call",
      ),
    ).toMatchObject({ deviceId: other.deviceId, status: "approved" });
    expect(await host.listApprovals(owner, allowed, "approved-thread")).toEqual(
      [],
    );
    expect(
      await host.resolveApproval(
        owner,
        allowed,
        "approved-thread",
        "approved-turn",
        "approved-call",
        "approved",
      ),
    ).toBe(false);
    await host.close();
  });

  it("rejects an approval when its durable decision cannot be recorded", async () => {
    const home = await mkdtemp(join(tmpdir(), "koda-approval-fail-home-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "koda-approval-fail-workspace-"),
    );
    directories.push(home, workspace);
    const root = await realpath(workspace);
    const owner = { ownerId: "owner", deviceId: `device-${"1".repeat(32)}` };
    const catalog = await RemoteAccessCatalog.create(
      "owner",
      [{ id: "project", root }],
      [
        {
          ...owner,
          workspaceId: "project",
          permissions: [
            "workspace:read",
            "thread:read",
            "turn:start",
            "workspace:mutate",
            "approval:resolve",
          ],
        },
      ],
    );
    let decision: Promise<{ decision: string }> | undefined;
    let finish: () => void = () => undefined;
    const application = {
      isRemoteRestricted: true,
      startTurnAfter: async (
        _input: unknown,
        client: TurnClient,
        beforeStart: (ids: {
          threadId: string;
          turnId: string;
        }) => Promise<void>,
      ) => {
        const ids = { threadId: "failed-thread", turnId: "failed-turn" };
        await beforeStart(ids);
        decision = client.approvals.request(
          {
            callId: toolCallIdSchema.parse("failed-call"),
            name: "apply_patch",
            title: "Review one patch",
            summary: "Update one file.",
            details: "Exact patch preview.",
            reason: "A write requires approval.",
          },
          new AbortController().signal,
        );
        return {
          ...ids,
          completion: new Promise<void>((resolve) => {
            finish = resolve;
          }),
          cancel: () => {
            finish();
            return true;
          },
        };
      },
      getThread: async () => ({ value: { workspaceRoot: root } }),
    } as unknown as KodaApplication;
    const leases = await RemoteApprovalLeaseStore.open(home);
    const host = new RemoteTurnHost(
      application,
      await RemoteThreadStore.open(home, "owner"),
      await RemoteTurnRequestStore.open(home, "owner"),
      await RemoteApprovalTransferStore.open(home),
      leases,
    );
    await host.start(owner, catalog, {
      requestId: "7".repeat(32),
      workspaceId: "project",
      prompt: "Change one file.",
      effects: ["workspace:mutate"],
    });
    await vi.waitFor(async () => {
      expect(
        await host.listApprovals(owner, catalog, "failed-thread"),
      ).toHaveLength(1);
    });
    vi.spyOn(leases, "finish").mockRejectedValueOnce(
      new Error("disk unavailable"),
    );
    expect(
      await host.resolveApproval(
        owner,
        catalog,
        "failed-thread",
        "failed-turn",
        "failed-call",
        "approved",
      ),
    ).toBe(false);
    await expect(decision).resolves.toMatchObject({ decision: "rejected" });
    expect(
      await leases.get("failed-thread", "failed-turn", "failed-call"),
    ).toMatchObject({ status: "pending" });
    await host.close();
  });
});
