import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  NativeExecutorClient,
  type NativeJobSnapshot,
} from "@koda/runtime-node/native-executor-client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const windowsDescribe = process.platform === "win32" ? describe : describe.skip;
const windowsEnvironment: NodeJS.ProcessEnv = {
  ComSpec: process.env.ComSpec,
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
};

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

  test("keeps B2 capabilities closed until restart recovery is accepted", async () => {
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

  test("runs a background Pipe tree until descendants exit and drains both streams", async () => {
    const started = await client.start({
      argv: [
        process.execPath,
        "-e",
        [
          'const {spawn}=require("node:child_process");',
          'process.stdout.write("root-out;");',
          'process.stderr.write("root-err;");',
          "const child=spawn(process.execPath,[\"-e\",\"setTimeout(()=>{process.stdout.write('child-out');process.stderr.write('child-err')},200)\"],{detached:true,stdio:'inherit',windowsHide:true});",
          "child.unref();",
        ].join(""),
      ],
      cwd: root,
      environment: windowsEnvironment,
      timeoutMs: 5_000,
      outputLimitBytes: 4_096,
      terminationGraceMs: 50,
      terminationConfirmationMs: 2_000,
      lifecycle: "background",
      displayName: "Windows descendant output",
    });
    const terminal = await waitTerminal(client, started.job_id);
    const [stdout, stderr] = await Promise.all([
      client.readOutput(started.job_id, "stdout", 0),
      client.readOutput(started.job_id, "stderr", 0),
    ]);

    expect(started).toMatchObject({
      io_mode: "pipe",
      lifecycle: "background",
    });
    expect(terminal).toMatchObject({
      state: "exited",
      exit_code: 0,
      timed_out: false,
    });
    expect(stdout.data.toString("utf8")).toBe("root-out;child-out");
    expect(stderr.data.toString("utf8")).toBe("root-err;child-err");
    expect(stdout.complete).toBe(true);
    expect(stderr.complete).toBe(true);
  });

  test("terminates every descendant through the Job Object", async () => {
    const started = await client.start({
      argv: [
        process.execPath,
        "-e",
        [
          'const {spawn}=require("node:child_process");',
          'const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:\'inherit\',windowsHide:true});',
          'process.stdout.write("child-pid:"+child.pid);',
          "child.unref();",
          "setInterval(()=>{},1000);",
        ].join(""),
      ],
      cwd: root,
      environment: windowsEnvironment,
      timeoutMs: 5_000,
      outputLimitBytes: 4_096,
      terminationGraceMs: 50,
      terminationConfirmationMs: 2_000,
      lifecycle: "background",
    });
    const childPid = await waitForChildPid(client, started.job_id);
    await client.terminate(started.job_id, "cancellation");
    const terminal = await waitTerminal(client, started.job_id);

    expect(terminal).toMatchObject({
      state: "exited",
      timed_out: false,
      termination: {
        reason: "cancellation",
        outcome: "terminated",
      },
    });
    expect(terminal.termination?.attempts).toContainEqual({
      attempt: "force",
      mechanism: "windows_job_object_terminate",
    });
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  test("enforces timeout through the same process-tree owner", async () => {
    const started = await client.start({
      argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
      cwd: root,
      environment: windowsEnvironment,
      timeoutMs: 150,
      outputLimitBytes: 4_096,
      terminationGraceMs: 25,
      terminationConfirmationMs: 2_000,
    });
    const terminal = await waitTerminal(client, started.job_id);

    expect(terminal).toMatchObject({
      state: "exited",
      timed_out: true,
      termination: { reason: "timeout", outcome: "terminated" },
    });
  });

  test("continues to reject PTY execution with the stable capability error", async () => {
    await expect(
      client.startPty({
        argv: [process.execPath, "-e", "process.exit(0)"],
        cwd: root,
        environment: windowsEnvironment,
        timeoutMs: 1_000,
        outputLimitBytes: 4_096,
        terminationGraceMs: 100,
        terminationConfirmationMs: 100,
        rows: 24,
        cols: 80,
      }),
    ).rejects.toMatchObject({ code: "PLATFORM_CAPABILITY_UNAVAILABLE" });
  });

  test("routes durable read operations through the shared Supervisor", async () => {
    const result = await client.list();
    expect(result.jobs.length).toBeGreaterThanOrEqual(3);
    expect(result.jobs.every((job) => job.io_mode === "pipe")).toBe(true);
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

async function waitTerminal(
  client: NativeExecutorClient,
  jobId: string,
): Promise<NativeJobSnapshot> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const snapshot = await client.get(jobId);
    if (
      snapshot.state === "exited" ||
      snapshot.state === "start_failed" ||
      snapshot.state === "termination_uncertain" ||
      snapshot.state === "quarantined"
    ) {
      return snapshot;
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Native job '${jobId}' did not reach a terminal state.`);
}

async function waitForChildPid(
  client: NativeExecutorClient,
  jobId: string,
): Promise<number> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const output = await client.readOutput(jobId, "stdout", 0);
    const match = /^child-pid:(\d+)$/u.exec(output.data.toString("utf8"));
    if (match?.[1] !== undefined) {
      return Number.parseInt(match[1], 10);
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Native job '${jobId}' did not publish its child PID.`);
}
