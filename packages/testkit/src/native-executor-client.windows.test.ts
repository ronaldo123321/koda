import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { NativeExecutorClient } from "@koda/runtime-node/native-executor-client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const windowsDescribe = process.platform === "win32" ? describe : describe.skip;

windowsDescribe("NativeExecutorClient Windows control plane", () => {
  let root: string;
  let client: NativeExecutorClient;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "koda-windows-control-plane-"));
    client = await NativeExecutorClient.open({
      binaryPath: resolve("target/debug/koda-exec.exe"),
      stateDirectory: join(root, "state"),
    });
  });

  afterAll(async () => {
    await client.closeOwnedSupervisorForTests();
    await rm(root, { force: true, recursive: true });
  });

  test("negotiates the fail-closed Phase 4B4A capability set", async () => {
    const hello = await client.hello();
    expect(hello.platform).toBe("windows");
    expect(hello.capabilities).toEqual({
      process_group: false,
      job_object: false,
      pty: false,
      reattach: false,
      durable_restart_recovery: false,
    });
  });

  test("keeps the stable capability error instead of executing", async () => {
    await expect(
      client.start({
        argv: ["cmd.exe", "/d", "/c", "exit", "0"],
        cwd: root,
        environment: process.env,
        timeoutMs: 1_000,
        outputLimitBytes: 4_096,
        terminationGraceMs: 100,
        terminationConfirmationMs: 100,
      }),
    ).rejects.toMatchObject({
      code: "PLATFORM_CAPABILITY_UNAVAILABLE",
    });
  });

  test("routes durable read operations through the shared Supervisor", async () => {
    await expect(client.list()).resolves.toEqual({
      jobs: [],
      next_cursor: null,
    });
  });

  test("serves concurrent authenticated Named Pipe handshakes", async () => {
    const clients = await Promise.all(
      Array.from({ length: 12 }, () =>
        NativeExecutorClient.open({
          binaryPath: resolve("target/debug/koda-exec.exe"),
          stateDirectory: join(root, "state"),
        }),
      ),
    );
    const hellos = await Promise.all(clients.map((entry) => entry.hello()));
    expect(hellos.every((hello) => hello.platform === "windows")).toBe(true);
  });

  test("refuses a second server for an occupied endpoint", async () => {
    const exitCode = await new Promise<number | null>(
      (resolvePromise, rejectPromise) => {
        const child = spawn(
          resolve("target/debug/koda-exec.exe"),
          [
            "serve",
            "--endpoint",
            client.socketPath,
            "--state-dir",
            join(root, "state"),
          ],
          { stdio: "ignore", windowsHide: true },
        );
        child.once("error", rejectPromise);
        child.once("exit", resolvePromise);
      },
    );
    expect(exitCode).not.toBe(0);
  });
});
