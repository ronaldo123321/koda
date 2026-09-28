import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RemoteApprovalLeaseStore,
  RemoteDeviceStore,
  RemoteThreadStore,
  RemoteTurnRequestStore,
} from "@koda/app-server";
import { createProgram, type TextWriter } from "@koda/cli";
import { agentEventSchema } from "@koda/protocol";
import { JsonlEventStore } from "@koda/runtime-node";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class MemoryWriter implements TextWriter {
  public value = "";

  public write(value: string): void {
    this.value += value;
  }
}

describe.skipIf(process.platform === "win32")("remote owner commands", () => {
  it("inspects and explicitly abandons an unbound reserved request", async () => {
    const home = await mkdtemp(join(tmpdir(), "koda-remote-request-cli-"));
    directories.push(home);
    const requests = await RemoteTurnRequestStore.open(home, "owner");
    const requestId = "8".repeat(32);
    await requests.claim({
      requestId,
      deviceId: `device-${"2".repeat(32)}`,
      workspaceId: "project",
      bodySha256: "3".repeat(64),
      threadId: "unbound-thread",
      turnId: "unbound-turn",
    });
    const inspected = await invoke(home, [
      "remote",
      "request",
      "inspect",
      requestId,
    ]);
    expect(inspected.exitCode).toBe(0);
    expect(JSON.parse(inspected.stdout.value)).toMatchObject({
      requestId,
      status: "reserved",
      threadBound: false,
      threadLogPresent: false,
    });
    expect(inspected.stdout.value).not.toContain("3".repeat(64));
    const lease = await requests.acquireLease(requestId);
    const busy = await invoke(home, [
      "remote",
      "request",
      "abandon",
      requestId,
    ]);
    expect(busy.exitCode).toBe(1);
    expect(busy.stderr.value).toContain("still being started");
    await lease.release();
    const abandoned = await invoke(home, [
      "remote",
      "request",
      "abandon",
      requestId,
    ]);
    expect(abandoned.exitCode).toBe(0);
    expect(abandoned.stdout.value).toContain(requestId);
    const after = await invoke(home, [
      "remote",
      "request",
      "inspect",
      requestId,
    ]);
    expect(JSON.parse(after.stdout.value)).toMatchObject({
      status: "abandoned",
    });
    const loggedRequestId = "9".repeat(32);
    await requests.claim({
      requestId: loggedRequestId,
      deviceId: `device-${"2".repeat(32)}`,
      workspaceId: "project",
      bodySha256: "3".repeat(64),
      threadId: "logged-thread",
      turnId: "logged-turn",
    });
    await mkdir(join(home, "threads"), { recursive: true });
    await writeFile(join(home, "threads", "logged-thread.jsonl"), "event\n");
    const logged = await invoke(home, [
      "remote",
      "request",
      "inspect",
      loggedRequestId,
    ]);
    expect(JSON.parse(logged.stdout.value)).toMatchObject({
      status: "reserved",
      threadBound: false,
      threadLogPresent: true,
    });
  });

  it("exposes only an existing Thread from its registered workspace", async () => {
    const home = await mkdtemp(join(tmpdir(), "koda-remote-cli-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "koda-remote-cli-project-"));
    const other = await mkdtemp(join(tmpdir(), "koda-remote-cli-other-"));
    directories.push(home, workspace, other);
    await invoke(home, [
      "remote",
      "workspace",
      "add",
      "project",
      "--path",
      workspace,
    ]);
    await invoke(home, [
      "remote",
      "workspace",
      "add",
      "other",
      "--path",
      other,
    ]);
    const threadId = "remote-expose-thread";
    const store = new JsonlEventStore(
      join(home, "threads", `${threadId}.jsonl`),
    );
    await store.append(
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 0,
        timestamp: "2026-09-27T00:00:00.000Z",
        threadId,
        turnId: "remote-expose-turn",
        type: "turn.started",
        payload: {},
      }),
    );
    await store.append(
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 1,
        timestamp: "2026-09-27T00:00:01.000Z",
        threadId,
        turnId: "remote-expose-turn",
        type: "turn.context",
        payload: {
          provider: "openai",
          model: "gpt-4o",
          workspaceRoot: await realpath(workspace),
          approvalMode: "on-request",
          instructionsSha256: "0".repeat(64),
          repositoryInstructions: [],
        },
      }),
    );

    const approvals = await RemoteApprovalLeaseStore.open(home);
    await approvals.begin({
      ownerId: "owner",
      workspaceId: "project",
      threadId,
      turnId: "remote-expose-turn",
      callId: "pending-call",
      deviceId: `device-${"1".repeat(32)}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const inspectedApproval = await invoke(home, [
      "remote",
      "approval",
      "inspect",
      threadId,
      "remote-expose-turn",
      "pending-call",
    ]);
    expect(inspectedApproval.exitCode).toBe(0);
    expect(JSON.parse(inspectedApproval.stdout.value)).toMatchObject({
      deviceId: `device-${"1".repeat(32)}`,
      status: "interrupted",
      recovery: "start_new_turn",
    });

    const wrong = await invoke(home, [
      "remote",
      "thread",
      "expose",
      threadId,
      "--workspace",
      "other",
    ]);
    expect(wrong.exitCode).toBe(1);
    const bindings = await RemoteThreadStore.open(home, "owner");
    await expect(bindings.get(threadId)).resolves.toBeUndefined();
    const exposed = await invoke(home, [
      "remote",
      "thread",
      "expose",
      threadId,
      "--workspace",
      "project",
    ]);
    expect(exposed.exitCode).toBe(0);
    await expect(bindings.get(threadId)).resolves.toEqual({
      ownerId: "owner",
      workspaceId: "project",
      threadId,
    });
  });

  it("refuses a public remote listener before reading certificate files", async () => {
    const home = await mkdtemp(join(tmpdir(), "koda-remote-cli-home-"));
    directories.push(home);
    const result = await invoke(home, [
      "remote",
      "serve",
      "--host",
      "0.0.0.0",
      "--cert",
      "missing-cert.pem",
      "--key",
      "missing-key.pem",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.value).toContain("private, VPN, or loopback");
    expect(result.stdout.value).toBe("");
  });

  it("registers a workspace and issues a revocable scoped token", async () => {
    const home = await mkdtemp(join(tmpdir(), "koda-remote-cli-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "koda-remote-cli-project-"));
    directories.push(home, workspace);

    const added = await invoke(home, [
      "remote",
      "workspace",
      "add",
      "project",
      "--path",
      workspace,
    ]);
    expect(added.exitCode).toBe(0);
    expect(added.stdout.value).toContain(await realpath(workspace));

    const issued = await invoke(home, [
      "remote",
      "device",
      "issue",
      "macbook",
      "--workspace",
      "project",
    ]);
    expect(issued.exitCode).toBe(0);
    const token = /Token \(shown once\): (\S+)/u.exec(issued.stdout.value)?.[1];
    const deviceId = /Device ID: (\S+)/u.exec(issued.stdout.value)?.[1];
    expect(token).toMatch(/^koda-r1\./u);
    expect(deviceId).toMatch(/^device-/u);
    if (token === undefined || deviceId === undefined) {
      throw new Error("Expected device credentials.");
    }
    const record = await readFile(
      join(home, "remote", "devices", `${deviceId}.json`),
      "utf8",
    );
    expect(record).not.toContain(token);
    const store = await RemoteDeviceStore.open(home, "owner");
    const verified = await store.verify(token);
    expect(verified.grants).toEqual([
      {
        ownerId: "owner",
        deviceId,
        workspaceId: "project",
        permissions: ["workspace:read", "thread:read"],
      },
    ]);

    const mcpIssued = await invoke(home, [
      "remote",
      "device",
      "issue",
      "mcpbook",
      "--workspace",
      "project",
      "--permissions",
      "workspace:read,thread:read,turn:start,approval:resolve,mcp:invoke",
      "--mcp-servers",
      "reviewed",
    ]);
    expect(mcpIssued.exitCode).toBe(0);
    const mcpToken = /Token \(shown once\): (\S+)/u.exec(
      mcpIssued.stdout.value,
    )?.[1];
    expect(mcpToken).toBeDefined();
    if (mcpToken !== undefined) {
      expect((await store.verify(mcpToken)).grants[0]?.mcpServerIds).toEqual([
        "reviewed",
      ]);
    }

    const revoked = await invoke(home, [
      "remote",
      "device",
      "revoke",
      deviceId,
    ]);
    expect(revoked.exitCode).toBe(0);
    await expect(store.verify(token)).rejects.toThrow();
  });

  it("rejects unknown workspaces and invalid permissions before issuing", async () => {
    const home = await mkdtemp(join(tmpdir(), "koda-remote-cli-home-"));
    directories.push(home);
    const missing = await invoke(home, [
      "remote",
      "device",
      "issue",
      "phone",
      "--workspace",
      "missing",
    ]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout.value).toBe("");
    const invalid = await invoke(home, [
      "remote",
      "device",
      "issue",
      "phone",
      "--workspace",
      "missing",
      "--permissions",
      "turn:start,turn:start",
    ]);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stdout.value).toBe("");
    const missingMcpServers = await invoke(home, [
      "remote",
      "device",
      "issue",
      "phone",
      "--workspace",
      "missing",
      "--permissions",
      "mcp:invoke",
    ]);
    expect(missingMcpServers.exitCode).toBe(1);
    expect(missingMcpServers.stdout.value).toBe("");
  });
});

async function invoke(
  home: string,
  args: string[],
): Promise<{ exitCode: number; stdout: MemoryWriter; stderr: MemoryWriter }> {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  let exitCode = -1;
  const program = createProgram({
    environment: { KODA_HOME: home },
    processDirectory: home,
    stdout,
    stderr,
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  await program.parseAsync(["node", "koda", ...args]);
  return { exitCode, stdout, stderr };
}
