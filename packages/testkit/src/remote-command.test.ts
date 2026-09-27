import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RemoteDeviceStore, RemoteThreadStore } from "@koda/app-server";
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
