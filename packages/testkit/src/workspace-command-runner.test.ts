import { WorkspaceCommandRunner } from "@koda/runtime-node";
import { access, mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
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

    const result = await command.execute(new AbortController().signal);

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
    });
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
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

  it("terminates a command after its timeout and returns an observation", async () => {
    const root = await createWorkspace();
    const runner = await WorkspaceCommandRunner.open(root, {
      terminationGraceMs: 10,
    });
    const command = await runner.prepare({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 100,
    });

    const result = await command.execute(new AbortController().signal);

    expect(result.timed_out).toBe(true);
    expect(result.exit_code).toBeNull();
    expect(result.signal).not.toBeNull();
    expect(result.duration_ms).toBeLessThan(5_000);
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
    const execution = command.execute(controller.signal);
    setTimeout(() => controller.abort("Cancelled by test."), 50);

    await expect(execution).rejects.toMatchObject({
      name: "AbortError",
      message: "Cancelled by test.",
    });
  });

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
