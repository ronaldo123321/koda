import type { ToolOperationalEvent } from "@koda/agent-core";
import {
  ArtifactStore,
  NativeExecutorClient,
  WorkspaceCommandRunner,
  type NativeJobSnapshot,
} from "@koda/runtime-node";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const describeNative = describe.runIf(process.platform !== "win32");

describeNative("NativeExecutorClient", () => {
  let root: string;
  let client: NativeExecutorClient;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "koda-native-executor-"));
    client = await NativeExecutorClient.open({
      binaryPath: resolve("target/debug/koda-exec"),
      stateDirectory: join(root, "state"),
      socketPath: join(root, "exec.sock"),
    });
  });

  afterAll(async () => {
    await client.closeOwnedSupervisorForTests();
    await new Promise<void>((resolvePromise) =>
      setTimeout(resolvePromise, 100),
    );
    await rm(root, { recursive: true, force: true });
  });

  it("negotiates explicit POSIX capabilities", async () => {
    await expect(client.hello()).resolves.toMatchObject({
      protocol_version: 1,
      platform: process.platform === "darwin" ? "macos" : "linux",
      capabilities: {
        process_group: true,
        job_object: false,
        pty: false,
        reattach: true,
        durable_restart_recovery: false,
      },
    });
  });

  it("observes the same job after a Node client reconnect", async () => {
    const started = await client.start({
      argv: [
        process.execPath,
        "-e",
        "setTimeout(() => process.stdout.write('reconnected'), 75)",
      ],
      cwd: root,
      environment: { PATH: process.env.PATH },
      timeoutMs: 2_000,
      outputLimitBytes: 1_024,
      terminationGraceMs: 25,
      terminationConfirmationMs: 1_000,
    });
    const reconnected = await NativeExecutorClient.open({
      binaryPath: resolve("target/debug/koda-exec"),
      stateDirectory: join(root, "state"),
      socketPath: join(root, "exec.sock"),
    });
    const terminal = await waitTerminal(reconnected, started.job_id);
    const output = await reconnected.readOutput(terminal.job_id, "stdout", 0);

    expect(terminal).toMatchObject({
      state: "exited",
      exit_code: 0,
      stdout_bytes: 11,
      stdout_truncated: false,
    });
    expect(output.data.toString("utf8")).toBe("reconnected");
    expect(output.complete).toBe(true);
  });

  it("deduplicates exact starts and rejects conflicting request reuse", async () => {
    const requestId = `request-${randomUUID()}`;
    const input = {
      argv: [process.execPath, "-e", "process.stdout.write('once')"],
      cwd: root,
      environment: { PATH: process.env.PATH },
      timeoutMs: 2_000,
      outputLimitBytes: 1_024,
      terminationGraceMs: 25,
      terminationConfirmationMs: 1_000,
      requestId,
    };
    const first = await client.start(input);
    const duplicate = await client.start(input);

    expect(duplicate.job_id).toBe(first.job_id);
    await expect(
      client.start({
        ...input,
        argv: [process.execPath, "-e", "process.stdout.write('twice')"],
      }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    await waitTerminal(client, first.job_id);
  });

  it("owns timeout escalation and reports its evidence", async () => {
    const started = await client.start({
      argv: [
        process.execPath,
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ],
      cwd: root,
      environment: { PATH: process.env.PATH },
      timeoutMs: 100,
      outputLimitBytes: 1_024,
      terminationGraceMs: 25,
      terminationConfirmationMs: 1_000,
    });
    const terminal = await waitTerminal(client, started.job_id);

    expect(terminal).toMatchObject({
      state: "exited",
      timed_out: true,
      termination: {
        reason: "timeout",
        outcome: "terminated",
        attempts: [{ attempt: "graceful" }, { attempt: "force" }],
      },
    });
  });

  it("preserves the WorkspaceCommandRunner result and lifecycle contract", async () => {
    const artifactStore = await ArtifactStore.open(join(root, "artifacts"));
    const runner = await WorkspaceCommandRunner.open(root, {
      nativeExecutor: client,
      artifactStore,
      maxOutputBytes: 8,
      terminationGraceMs: 25,
    });
    const command = await runner.prepare({
      argv: [process.execPath, "-e", "process.stdout.write('123456789abcdef')"],
      timeoutMs: 2_000,
    });
    const lifecycle: ToolOperationalEvent[] = [];
    const result = await command.execute(
      new AbortController().signal,
      async (event) => {
        lifecycle.push(event);
      },
    );

    expect(result).toMatchObject({
      exit_code: 0,
      stdout_bytes: 15,
      stdout_truncated: true,
      timed_out: false,
      stdout_artifact: { type: "artifact", bytes: 15 },
    });
    expect(lifecycle.map((event) => event.type)).toEqual([
      "process.started",
      "process.exited",
    ]);
    await expect(
      artifactStore.readRange(result.stdout_artifact?.id ?? "", 0, 65_536),
    ).resolves.toMatchObject({ content: "123456789abcdef" });
  });

  it("terminates native work when the Node abort signal fires", async () => {
    const runner = await WorkspaceCommandRunner.open(root, {
      nativeExecutor: client,
      terminationGraceMs: 25,
    });
    const command = await runner.prepare({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 2_000,
    });
    const controller = new AbortController();
    const lifecycle: ToolOperationalEvent[] = [];
    const execution = command.execute(controller.signal, async (event) => {
      lifecycle.push(event);
    });
    setTimeout(() => controller.abort("native cancellation"), 75);

    await expect(execution).rejects.toMatchObject({
      name: "AbortError",
      message: "native cancellation",
    });
    expect(lifecycle).toContainEqual(
      expect.objectContaining({
        type: "process.termination_completed",
        payload: expect.objectContaining({
          reason: "cancellation",
          outcome: "terminated",
        }),
      }),
    );
  });
});

async function waitTerminal(
  client: NativeExecutorClient,
  jobId: string,
): Promise<NativeJobSnapshot> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const snapshot = await client.get(jobId);
    if (
      snapshot.state === "exited" ||
      snapshot.state === "start_failed" ||
      snapshot.state === "termination_uncertain"
    ) {
      return snapshot;
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Native job '${jobId}' did not reach a terminal state.`);
}
