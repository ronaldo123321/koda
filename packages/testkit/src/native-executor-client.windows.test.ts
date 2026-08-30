import { type ToolOperationalEvent } from "@koda/agent-core";
import { WorkspaceCommandRunner } from "@koda/runtime-node";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
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

  test("opens only the verified Windows Job Object capabilities", async () => {
    const hello = await client.hello();
    expect(hello.platform).toBe("windows");
    expect(hello.capabilities).toEqual({
      process_group: false,
      job_object: true,
      pty: true,
      reattach: true,
      durable_restart_recovery: true,
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

  test("reports Windows Job Object ownership and termination evidence upstream", async () => {
    const runner = await WorkspaceCommandRunner.open(root, {
      environment: windowsEnvironment,
      nativeExecutor: client,
      terminationGraceMs: 25,
      terminationConfirmationMs: 2_000,
    });
    const prepared = await runner.prepare({
      argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
      timeoutMs: 150,
    });
    const events: ToolOperationalEvent[] = [];
    const result = await prepared.execute(
      new AbortController().signal,
      async (event) => {
        events.push(event);
      },
    );

    expect(result.timed_out).toBe(true);
    expect(events).toContainEqual({
      type: "process.started",
      payload: expect.objectContaining({ ownership: "windows_job_object" }),
    });
    const requested = events.find(
      (event) => event.type === "process.termination_requested",
    );
    if (requested?.type !== "process.termination_requested") {
      throw new Error("Windows timeout did not report a termination attempt.");
    }
    expect(requested.payload.reason).toBe("timeout");
    expect([
      "windows_console_ctrl_break",
      "windows_job_object_terminate",
    ]).toContain(requested.payload.mechanism);
    expect(events).toContainEqual({
      type: "process.termination_completed",
      payload: expect.objectContaining({
        reason: "timeout",
        outcome: "terminated",
      }),
    });
  });

  test("reattaches to the same live Worker after Supervisor restart", async () => {
    const restartRoot = await mkdtemp(join(tmpdir(), "koda-windows-restart-"));
    let restartClient = await NativeExecutorClient.open({
      binaryPath: resolve("target/debug/koda-exec.exe"),
      stateDirectory: join(restartRoot, "state"),
    });
    const requestId = `windows-restart-${randomUUID()}`;
    const input = {
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write('before-restart');setInterval(()=>{},1000)",
      ],
      cwd: restartRoot,
      environment: windowsEnvironment,
      timeoutMs: 5_000,
      outputLimitBytes: 4_096,
      terminationGraceMs: 25,
      terminationConfirmationMs: 2_000,
      lifecycle: "background" as const,
      requestId,
    };
    try {
      const started = await restartClient.start(input);
      await restartClient.closeOwnedSupervisorForTests();
      restartClient = await NativeExecutorClient.open({
        binaryPath: resolve("target/debug/koda-exec.exe"),
        stateDirectory: join(restartRoot, "state"),
      });
      const duplicate = await restartClient.start(input);
      const output = await waitForOutput(
        restartClient,
        started.job_id,
        "before-restart",
      );
      await restartClient.terminate(started.job_id, "cancellation");
      const terminal = await waitTerminal(restartClient, started.job_id);

      expect(duplicate.job_id).toBe(started.job_id);
      expect(output).toContain("before-restart");
      expect(terminal).toMatchObject({
        state: "exited",
        termination: { reason: "cancellation", outcome: "terminated" },
      });
    } finally {
      await restartClient.closeOwnedSupervisorForTests();
      await rm(restartRoot, { force: true, recursive: true });
    }
  });

  test("reconciles Worker loss only after the persisted root disappears", async () => {
    const faultRoot = await mkdtemp(
      join(tmpdir(), "koda-windows-worker-loss-"),
    );
    const faultClient = await openFaultClient(faultRoot, "after_running");
    try {
      const started = await faultClient.start({
        argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
        cwd: faultRoot,
        environment: windowsEnvironment,
        timeoutMs: 5_000,
        outputLimitBytes: 4_096,
        terminationGraceMs: 25,
        terminationConfirmationMs: 2_000,
      });
      const terminal = await waitTerminal(faultClient, started.job_id);

      expect(terminal).toMatchObject({
        state: "termination_uncertain",
        termination: { reason: "orphan_cleanup", outcome: "uncertain" },
        failure: { code: "WORKER_LOST_AFTER_COMMAND_BOUNDARY" },
      });
      expect(
        terminal.termination?.attempts.some(
          (attempt) =>
            attempt.mechanism === "windows_job_object_recovery_pending",
        ),
      ).toBe(false);
      if (terminal.pid === null) {
        throw new Error("Windows Worker-loss job did not publish a root PID.");
      }
      const rootPid = terminal.pid;
      expect(() => process.kill(rootPid, 0)).toThrow();
    } finally {
      await faultClient.closeOwnedSupervisorForTests();
      await rm(faultRoot, { force: true, recursive: true });
    }
  });

  test("never resumes a command when the Worker dies after suspended creation", async () => {
    const faultRoot = await mkdtemp(join(tmpdir(), "koda-windows-start-gate-"));
    const marker = join(faultRoot, "command-executed");
    const faultClient = await openFaultClient(faultRoot, "after_command_spawn");
    try {
      const started = await faultClient.start({
        argv: [
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`,
        ],
        cwd: faultRoot,
        environment: windowsEnvironment,
        timeoutMs: 5_000,
        outputLimitBytes: 4_096,
        terminationGraceMs: 25,
        terminationConfirmationMs: 2_000,
      });
      const terminal = await waitTerminal(faultClient, started.job_id);

      expect(terminal).toMatchObject({
        state: "termination_uncertain",
        failure: { code: "WORKER_LOST_AFTER_COMMAND_BOUNDARY" },
      });
      await new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, 100),
      );
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await faultClient.closeOwnedSupervisorForTests();
      await rm(faultRoot, { force: true, recursive: true });
    }
  });

  test("runs a real ConPTY with fenced input, resize, and detach survival", async () => {
    const started = await client.startPty({
      argv: [
        process.execPath,
        "-e",
        [
          'const readline=require("node:readline");',
          "const dimensions=()=>`${process.stdout.columns}x${process.stdout.rows}`;",
          "process.stdout.write(`READY:${process.stdin.isTTY}:${process.stdout.isTTY}:${dimensions()}:${process.env.TERM}\\n`);",
          "const lines=readline.createInterface({input:process.stdin,terminal:false});",
          "lines.on('line',(line)=>{",
          "if(line==='size'){process.stdout.write(`SIZE:${dimensions()}\\n`);return;}",
          "if(line==='exit'){process.stdout.write('EXIT\\n');process.exit(0);return;}",
          "process.stdout.write(`ECHO:${line}\\n`);",
          "});",
          "setInterval(()=>{},1000);",
        ].join(""),
      ],
      cwd: root,
      environment: windowsEnvironment,
      timeoutMs: 10_000,
      outputLimitBytes: 64 * 1_024,
      terminationGraceMs: 250,
      terminationConfirmationMs: 3_000,
      rows: 24,
      cols: 80,
      lifecycle: "background",
      displayName: "Windows ConPTY acceptance",
    });
    const writer = await client.openAttachment(started.job_id);
    const reader = await client.openAttachment(started.job_id);
    await writer.acquireInput();
    await expect(reader.acquireInput()).rejects.toMatchObject({
      code: "INPUT_LEASE_HELD",
    });
    const ready = await waitForPtyText(
      writer,
      "READY:true:true:80x24:xterm-256color",
    );
    expect(ready).toContain("READY:true:true:80x24:xterm-256color");

    await writer.resize(30, 100);
    await writer.write("size\r");
    expect(await waitForPtyText(writer, "SIZE:100x30")).toContain(
      "SIZE:100x30",
    );

    await writer.close();
    await reader.acquireInput();
    await reader.write("reattached\r");
    expect(await waitForPtyText(reader, "ECHO:reattached")).toContain(
      "ECHO:reattached",
    );
    await reader.write("exit\r");
    const terminal = await waitTerminal(client, started.job_id);
    expect(terminal).toMatchObject({
      state: "exited",
      io_mode: "pty",
      exit_code: 0,
      timed_out: false,
    });
    const final = await waitForPtyText(reader, "EXIT");
    expect(final).toContain("EXIT");
    expect((await reader.read()).complete).toBe(true);
  });

  test("routes durable read operations through the shared Supervisor", async () => {
    const result = await client.list();
    expect(result.jobs.length).toBeGreaterThanOrEqual(3);
    expect(result.jobs.some((job) => job.io_mode === "pipe")).toBe(true);
    expect(result.jobs.some((job) => job.io_mode === "pty")).toBe(true);
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

async function waitForOutput(
  client: NativeExecutorClient,
  jobId: string,
  expected: string,
): Promise<string> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const output = await client.readOutput(jobId, "stdout", 0);
    const text = output.data.toString("utf8");
    if (text.includes(expected)) return text;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Native job '${jobId}' did not emit '${expected}'.`);
}

async function waitForPtyText(
  attachment: Awaited<ReturnType<NativeExecutorClient["openAttachment"]>>,
  expected: string,
): Promise<string> {
  let text = "";
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const output = await attachment.read();
    if (output.status === "ok") {
      text += output.data.toString("utf8");
      if (text.includes(expected)) return text;
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(
    `Native PTY job '${attachment.credentials.job_id}' did not emit '${expected}'.`,
  );
}

async function openFaultClient(
  faultRoot: string,
  faultPoint: string,
): Promise<NativeExecutorClient> {
  const previousFaultPoint = process.env.KODA_EXEC_TEST_FAULT_POINT;
  try {
    process.env.KODA_EXEC_TEST_FAULT_POINT = faultPoint;
    return await NativeExecutorClient.open({
      binaryPath: resolve("target/debug/koda-exec.exe"),
      stateDirectory: join(faultRoot, "state"),
    });
  } finally {
    if (previousFaultPoint === undefined) {
      delete process.env.KODA_EXEC_TEST_FAULT_POINT;
    } else {
      process.env.KODA_EXEC_TEST_FAULT_POINT = previousFaultPoint;
    }
  }
}
