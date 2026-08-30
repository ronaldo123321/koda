import {
  ArtifactStore,
  c1ExecutionCapabilities,
  type NativeExecutorClient,
  WorkspaceCommandRunner,
  resolveExecutionPolicy,
} from "@koda/runtime-node";
import type { ToolOperationalEvent } from "@koda/agent-core";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("WorkspaceCommandRunner", () => {
  it("prepares an exact preview and captures a nonzero command result", async () => {
    const root = await createWorkspace();
    await mkdir(join(root, "packages"));
    const runner = await WorkspaceCommandRunner.open(root, {
      environment: { HOME: "/safe-home", OPENAI_API_KEY: "must-not-leak" },
    });
    const command = await runner.prepare({
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 7",
      ],
      cwd: "packages",
      timeoutMs: 2_000,
    });

    expect(command.title).toBe(
      `Run ${JSON.stringify(basename(process.execPath))}`,
    );
    expect(command.preview).toContain('cwd: "packages"');
    expect(command.preview).toContain("timeout: 2000 ms");
    expect(command.preview).toContain(JSON.stringify(process.execPath));
    expect(command.preview).toContain("OS sandbox: none");
    expect(command.security).toMatchObject({
      kind: "policy",
      stage: "admission",
      backend:
        process.platform === "win32"
          ? "typescript_windows"
          : "typescript_posix",
    });

    const lifecycle: ToolOperationalEvent[] = [];
    const result = await command.execute(
      new AbortController().signal,
      async (event) => {
        lifecycle.push(event);
      },
    );

    expect(result).toMatchObject({
      argv: [process.execPath, "-e", expect.any(String)],
      cwd: "packages",
      exit_code: 7,
      signal: null,
      stdout: "out",
      stderr: "err",
      stdout_bytes: 3,
      stderr_bytes: 3,
      stdout_truncated: false,
      stderr_truncated: false,
      timed_out: false,
      security: {
        kind: "policy",
        stage: "launch_setup",
        environment: { status: "applied" },
        supervision: { status: "applied" },
      },
    });
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(lifecycle.map((event) => event.type)).toEqual([
      "process.started",
      "process.exited",
    ]);
    expect(lifecycle[0]).toMatchObject({
      type: "process.started",
      payload: {
        security: { kind: "policy", stage: "launch_setup" },
      },
    });
  });

  it.each(["read-only", "workspace-write"] as const)(
    "rejects the protected %s profile before approval or launch",
    async (profile) => {
      const root = await createWorkspace();
      const canonicalRoot = await realpath(root);
      const runner = await WorkspaceCommandRunner.open(root, {
        executionPolicy: resolveExecutionPolicy({
          workspaceRoot: canonicalRoot,
          environmentProfile: profile,
        }),
      });

      await expect(
        runner.prepare({ argv: [process.execPath, "--version"] }),
      ).rejects.toMatchObject({ code: "EXECUTION_POLICY_UNAVAILABLE" });
    },
  );

  it("invalidates a prepared command when the backend contract changes", async () => {
    const root = await createWorkspace();
    let helloCalls = 0;
    let startCalls = 0;
    const nativeExecutor = {
      hello: async () => ({
        execution_security: c1ExecutionCapabilities(
          helloCalls++ === 0 ? "native_posix" : "native_windows",
        ),
      }),
      start: async () => {
        startCalls += 1;
        throw new Error("must not start");
      },
    } as unknown as NativeExecutorClient;
    const runner = await WorkspaceCommandRunner.open(root, { nativeExecutor });
    const command = await runner.prepare({
      argv: [process.execPath, "--version"],
    });

    await expect(
      command.execute(new AbortController().signal),
    ).rejects.toMatchObject({ code: "EXECUTION_POLICY_CHANGED" });
    expect(startCalls).toBe(0);
  });

  it("passes only allowlisted environment variables", async () => {
    const root = await createWorkspace();
    const runner = await WorkspaceCommandRunner.open(root, {
      environment: {
        HOME: "/safe-home",
        LANG: "en_US.UTF-8",
        OPENAI_API_KEY: "must-not-leak",
        KODA_TEST_SECRET: "must-not-leak",
      },
    });
    const command = await runner.prepare({
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify({ home: process.env.HOME, lang: process.env.LANG, api: process.env.OPENAI_API_KEY, secret: process.env.KODA_TEST_SECRET }))",
      ],
    });

    const result = await command.execute(new AbortController().signal);

    expect(JSON.parse(result.stdout)).toEqual({
      home: "/safe-home",
      lang: "en_US.UTF-8",
    });
  });

  it("passes shell metacharacters as ordinary arguments without executing them", async () => {
    const root = await createWorkspace();
    const runner = await WorkspaceCommandRunner.open(root);
    const command = await runner.prepare({
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write(process.argv[1] ?? '')",
        "&& touch escaped.txt",
      ],
    });

    const result = await command.execute(new AbortController().signal);

    expect(result.stdout).toBe("&& touch escaped.txt");
    await expect(access(join(root, "escaped.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects direct shells and unsafe working directories", async () => {
    const root = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "koda-command-outside-"));
    temporaryDirectories.push(outside);
    await symlink(outside, join(root, "linked"));
    const runner = await WorkspaceCommandRunner.open(root);

    await expect(
      runner.prepare({ argv: ["sh", "-c", "echo unsafe"] }),
    ).rejects.toMatchObject({ code: "INVALID_COMMAND" });
    await expect(
      runner.prepare({ argv: [process.execPath, "--version"], cwd: "../" }),
    ).rejects.toMatchObject({ code: "INVALID_COMMAND_CWD" });
    await expect(
      runner.prepare({
        argv: [process.execPath, "--version"],
        cwd: outside,
      }),
    ).rejects.toMatchObject({ code: "INVALID_COMMAND_CWD" });
    await expect(
      runner.prepare({
        argv: [process.execPath, "--version"],
        cwd: "linked",
      }),
    ).rejects.toMatchObject({ code: "INVALID_COMMAND_CWD" });
  });

  it("detects a working directory replacement after preview", async () => {
    const root = await createWorkspace();
    await mkdir(join(root, "target"));
    const runner = await WorkspaceCommandRunner.open(root);
    const command = await runner.prepare({
      argv: [process.execPath, "--version"],
      cwd: "target",
    });
    await rename(join(root, "target"), join(root, "original-target"));
    await mkdir(join(root, "target"));

    await expect(
      command.execute(new AbortController().signal),
    ).rejects.toMatchObject({ code: "COMMAND_CWD_CHANGED" });
  });

  it("bounds captured stdout and stderr while retaining byte counts", async () => {
    const root = await createWorkspace();
    const runner = await WorkspaceCommandRunner.open(root, {
      maxOutputBytes: 8,
    });
    const command = await runner.prepare({
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write('123456789'); process.stderr.write('abcdefghi')",
      ],
    });

    const result = await command.execute(new AbortController().signal);

    expect(result).toMatchObject({
      stdout: "12345678",
      stderr: "abcdefgh",
      stdout_bytes: 9,
      stderr_bytes: 9,
      stdout_truncated: true,
      stderr_truncated: true,
    });
  });

  it("stores complete oversized command streams as artifacts", async () => {
    const root = await createWorkspace();
    const artifactStore = await ArtifactStore.open(join(root, ".artifacts"));
    const runner = await WorkspaceCommandRunner.open(root, {
      maxOutputBytes: 8,
      artifactStore,
    });
    const stdout = "123456789abcdef";
    const stderr = "ABCDEFGHIJKLMNO";
    const command = await runner.prepare({
      argv: [
        process.execPath,
        "-e",
        `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)})`,
      ],
    });

    const result = await command.execute(new AbortController().signal);

    expect(result).toMatchObject({
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
      stdout_truncated: true,
      stderr_truncated: true,
      stdout_artifact: { type: "artifact" },
      stderr_artifact: { type: "artifact" },
    });
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(8);
    await expect(
      artifactStore.readRange(result.stdout_artifact?.id ?? "", 0, 65_536),
    ).resolves.toMatchObject({ content: stdout, truncated: false });
    await expect(
      artifactStore.readRange(result.stderr_artifact?.id ?? "", 0, 65_536),
    ).resolves.toMatchObject({ content: stderr, truncated: false });
  });

  it("terminates a command after its timeout and returns an observation", async () => {
    const root = await createWorkspace();
    const runner = await WorkspaceCommandRunner.open(root, {
      terminationGraceMs: 10,
    });
    const command = await runner.prepare({
      argv: [
        process.execPath,
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ],
      timeoutMs: 100,
    });
    const lifecycle: ToolOperationalEvent[] = [];

    const result = await command.execute(
      new AbortController().signal,
      async (event) => {
        lifecycle.push(event);
      },
    );

    expect(result.timed_out).toBe(true);
    expect(result.exit_code).toBeNull();
    expect(result.signal).not.toBeNull();
    expect(result.duration_ms).toBeLessThan(5_000);
    expect(result.termination).toEqual({
      reason: "timeout",
      outcome: "terminated",
    });
    expect(
      lifecycle.flatMap((event) =>
        event.type === "process.termination_requested"
          ? [event.payload.attempt]
          : [],
      ),
    ).toEqual(["graceful", "force"]);
    expect(lifecycle.at(-1)).toMatchObject({
      type: "process.termination_completed",
      payload: { reason: "timeout", outcome: "terminated" },
    });
  });

  it("terminates on cancellation and propagates the abort", async () => {
    const root = await createWorkspace();
    const runner = await WorkspaceCommandRunner.open(root, {
      terminationGraceMs: 10,
    });
    const command = await runner.prepare({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    });
    const controller = new AbortController();
    const lifecycle: ToolOperationalEvent[] = [];
    const execution = command.execute(controller.signal, async (event) => {
      lifecycle.push(event);
    });
    setTimeout(() => controller.abort("Cancelled by test."), 50);

    await expect(execution).rejects.toMatchObject({
      name: "AbortError",
      message: "Cancelled by test.",
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

  it("terminates a started process when lifecycle persistence fails", async () => {
    const root = await createWorkspace();
    const runner = await WorkspaceCommandRunner.open(root, {
      terminationGraceMs: 10,
    });
    const command = await runner.prepare({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    });
    let startedPid: number | undefined;

    await expect(
      command.execute(new AbortController().signal, async (event) => {
        if (event.type === "process.started") {
          startedPid = event.payload.pid;
        }
        throw new Error("event store unavailable");
      }),
    ).rejects.toThrow("event store unavailable");

    expect(startedPid).toBeGreaterThan(0);
    await expectProcessGone(startedPid ?? 0);
  });

  it.runIf(process.platform !== "win32")(
    "cleans descendants when persisting the root exit fails",
    async () => {
      const root = await createWorkspace();
      const runner = await WorkspaceCommandRunner.open(root, {
        terminationGraceMs: 10,
      });
      const command = await runner.prepare({
        argv: [
          process.execPath,
          "-e",
          "const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); child.unref();",
        ],
      });
      let processGroupId: number | undefined;

      await expect(
        command.execute(new AbortController().signal, async (event) => {
          if (event.type === "process.started") {
            processGroupId = event.payload.pid;
          }
          if (event.type === "process.exited") {
            throw new Error("could not persist root exit");
          }
        }),
      ).rejects.toThrow("could not persist root exit");

      expect(processGroupId).toBeGreaterThan(0);
      await expectProcessGroupGone(processGroupId ?? 0);
    },
  );

  it.runIf(process.platform !== "win32")(
    "cleans up an unsupported background descendant after the root exits",
    async () => {
      const root = await createWorkspace();
      const runner = await WorkspaceCommandRunner.open(root, {
        terminationGraceMs: 25,
      });
      const command = await runner.prepare({
        argv: [
          process.execPath,
          "-e",
          "const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); child.unref(); process.stdout.write(String(child.pid));",
        ],
      });
      const lifecycle: ToolOperationalEvent[] = [];

      const result = await command.execute(
        new AbortController().signal,
        async (event) => {
          lifecycle.push(event);
        },
      );
      const descendantPid = Number(result.stdout);

      expect(descendantPid).toBeGreaterThan(0);
      expect(result.termination).toEqual({
        reason: "orphan_cleanup",
        outcome: "terminated",
      });
      expect(lifecycle).toContainEqual(
        expect.objectContaining({
          type: "process.termination_requested",
          payload: expect.objectContaining({ reason: "orphan_cleanup" }),
        }),
      );
      await expectProcessGone(descendantPid);
    },
  );

  it("returns a stable error when the executable does not exist", async () => {
    const root = await createWorkspace();
    const runner = await WorkspaceCommandRunner.open(root);
    const command = await runner.prepare({
      argv: ["koda-command-that-does-not-exist-9d3d5b"],
    });

    await expect(
      command.execute(new AbortController().signal),
    ).rejects.toMatchObject({ code: "COMMAND_NOT_FOUND" });
  });
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "koda-command-"));
  temporaryDirectories.push(root);
  return root;
}

async function expectProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ESRCH"
      ) {
        return;
      }
      throw error;
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process may have exited on the final polling boundary.
  }
  throw new Error(`Expected process ${pid} to be gone.`);
}

async function expectProcessGroupGone(processGroupId: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(-processGroupId, 0);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ESRCH"
      ) {
        return;
      }
      throw error;
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch {
    // The process group may have exited on the final polling boundary.
  }
  throw new Error(`Expected process group ${processGroupId} to be gone.`);
}
