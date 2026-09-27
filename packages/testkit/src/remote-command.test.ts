import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RemoteDeviceStore } from "@koda/app-server";
import { createProgram, type TextWriter } from "@koda/cli";
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
