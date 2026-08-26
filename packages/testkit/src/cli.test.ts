import {
  ConsoleEventSink,
  createProgram,
  resolveRunConfiguration,
  runCommand,
  type RunCommandDependencies,
  type TextWriter,
} from "@koda/cli";
import type { ModelProvider } from "@koda/agent-core";
import {
  itemIdSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
} from "@koda/protocol";
import { ScriptedModelProvider } from "@koda/providers";
import { ReadOnlyWorkspace } from "@koda/runtime-node";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DeterministicItemIdFactory } from "./deterministic.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class MemoryWriter implements TextWriter {
  public value = "";

  public write(text: string): void {
    this.value += text;
  }
}

describe("Phase 1A CLI", () => {
  it("applies CLI, environment, and default configuration precedence", () => {
    const fromEnvironment = resolveRunConfiguration(
      {},
      {
        OPENAI_API_KEY: "test-key",
        KODA_MODEL: "environment-model",
        KODA_HOME: "/tmp/koda-config-test",
      },
      "/workspace",
    );
    expect(fromEnvironment.model).toBe("environment-model");
    expect(fromEnvironment.approvalMode).toBe("on-request");

    const fromCli = resolveRunConfiguration(
      { model: "cli-model", cwd: "project" },
      { OPENAI_API_KEY: "test-key", KODA_MODEL: "environment-model" },
      "/workspace",
    );
    expect(fromCli.model).toBe("cli-model");
    expect(fromCli.cwd).toBe("/workspace/project");

    const approvalFromCli = resolveRunConfiguration(
      { approvalMode: "never" },
      { OPENAI_API_KEY: "test-key", KODA_APPROVAL_MODE: "on-request" },
      "/workspace",
    );
    expect(approvalFromCli.approvalMode).toBe("never");
    expect(() =>
      resolveRunConfiguration(
        { approvalMode: "always" },
        { OPENAI_API_KEY: "test-key" },
        "/workspace",
      ),
    ).toThrow("Approval mode must be either");
  });

  it("streams answer deltas to stdout and tool status to stderr", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const sink = new ConsoleEventSink({ stdout, stderr });
    const metadata = {
      schemaVersion: 1 as const,
      sequence: 0,
      timestamp: "2026-08-26T00:00:00.000Z",
      threadId: threadIdSchema.parse("console-thread"),
      turnId: turnIdSchema.parse("console-turn"),
    };

    await sink.append({
      ...metadata,
      type: "assistant.delta",
      payload: { text: "Hello" },
    });
    await sink.append({
      ...metadata,
      type: "tool.started",
      payload: {
        callId: toolCallIdSchema.parse("console-call"),
        name: "read_file",
      },
    });
    await sink.append({
      ...metadata,
      type: "turn.completed",
      payload: { steps: 1, finalMessageId: itemIdSchema.parse("console-item") },
    });

    expect(stdout.value).toBe("Hello\n");
    expect(stderr.value).toContain("[koda] using read_file");
  });

  it("runs an offline read-file tool loop end to end", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-cli-"));
    temporaryDirectories.push(root);
    const workspaceRoot = join(root, "repo");
    const kodaHome = join(root, "state");
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, "README.md"), "# Test repository\n");

    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("cli-call"),
            name: "read_file",
            arguments: {
              path: "README.md",
              start_line: 1,
              line_count: 20,
            },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          const result = request.items.at(-1);
          expect(result).toMatchObject({
            type: "tool_result",
            status: "success",
          });
          if (result?.type === "tool_result" && result.status === "success") {
            expect(JSON.stringify(result.output)).toContain("Test repository");
          }
        },
        events: [
          { type: "assistant_delta", text: "This is a test repository." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const dependencies: RunCommandDependencies = {
      openWorkspace: (path) => ReadOnlyWorkspace.open(path),
      createProvider: () => provider,
      createApprovalBroker: () => ({
        request: async () => ({ decision: "rejected" }),
      }),
      createIds: () => ({
        threadId: threadIdSchema.parse("cli-thread"),
        turnId: turnIdSchema.parse("cli-turn"),
        itemIds: new DeterministicItemIdFactory(),
      }),
    };
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();

    const exitCode = await runCommand(
      {
        prompt: "Describe the README.",
        cwd: workspaceRoot,
        signal: new AbortController().signal,
      },
      {
        environment: {
          OPENAI_API_KEY: "offline-test-key",
          KODA_HOME: kodaHome,
        },
        processDirectory: root,
        stdout,
        stderr,
      },
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(stdout.value).toBe("This is a test repository.\n");
    expect(stderr.value).toContain("using read_file");
    expect(stderr.value).toContain("read_file completed");
  });

  it("cancels an in-flight turn through the caller signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-cancel-"));
    temporaryDirectories.push(root);
    const workspaceRoot = join(root, "repo");
    await mkdir(workspaceRoot);

    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const provider: ModelProvider = {
      stream: async function* (_request, signal) {
        markStarted?.();
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        signal.throwIfAborted();
      },
    };
    const dependencies: RunCommandDependencies = {
      openWorkspace: (path) => ReadOnlyWorkspace.open(path),
      createProvider: () => provider,
      createApprovalBroker: () => ({
        request: async () => ({ decision: "rejected" }),
      }),
      createIds: () => ({
        threadId: threadIdSchema.parse("cancel-thread"),
        turnId: turnIdSchema.parse("cancel-turn"),
        itemIds: new DeterministicItemIdFactory(),
      }),
    };
    const controller = new AbortController();
    const stderr = new MemoryWriter();
    const run = runCommand(
      {
        prompt: "Wait for cancellation.",
        cwd: workspaceRoot,
        signal: controller.signal,
      },
      {
        environment: {
          OPENAI_API_KEY: "offline-test-key",
          KODA_HOME: join(root, "state"),
        },
        processDirectory: root,
        stdout: new MemoryWriter(),
        stderr,
      },
      dependencies,
    );

    await started;
    controller.abort("Test cancellation.");

    await expect(run).resolves.toBe(130);
    expect(stderr.value).toContain("Test cancellation.");
  });

  it("applies an approved structured patch end to end", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-write-cli-"));
    temporaryDirectories.push(root);
    const workspaceRoot = join(root, "repo");
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, "README.md"), "Before\n");

    const provider = new ScriptedModelProvider([
      {
        assertRequest: (request) => {
          expect(request.tools.map((tool) => tool.name)).toContain(
            "apply_patch",
          );
        },
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("cli-patch-call"),
            name: "apply_patch",
            arguments: {
              path: "README.md",
              operation: "update",
              old_text: "Before",
              new_text: "After",
            },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          expect(request.items.map((item) => item.type)).toContain("approval");
          expect(request.items.at(-1)).toMatchObject({
            type: "tool_result",
            status: "success",
          });
        },
        events: [
          { type: "assistant_delta", text: "Updated README.md." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const dependencies: RunCommandDependencies = {
      openWorkspace: (path) => ReadOnlyWorkspace.open(path),
      createProvider: () => provider,
      createApprovalBroker: () => ({
        request: async () => ({
          decision: "approved",
          reason: "Offline test approval.",
        }),
      }),
      createIds: () => ({
        threadId: threadIdSchema.parse("write-cli-thread"),
        turnId: turnIdSchema.parse("write-cli-turn"),
        itemIds: new DeterministicItemIdFactory(),
      }),
    };

    const exitCode = await runCommand(
      {
        prompt: "Update the README.",
        cwd: workspaceRoot,
        signal: new AbortController().signal,
      },
      {
        environment: {
          OPENAI_API_KEY: "offline-test-key",
          KODA_HOME: join(root, "state"),
        },
        processDirectory: root,
        stdout: new MemoryWriter(),
        stderr: new MemoryWriter(),
      },
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(await readFile(join(workspaceRoot, "README.md"), "utf8")).toBe(
      "After\n",
    );
  });

  it("renders run help without requiring credentials", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const program = createProgram({
      environment: {},
      processDirectory: "/workspace",
      stdout,
      stderr,
      setExitCode: () => undefined,
    });
    program.exitOverride();

    await expect(
      program.parseAsync(["node", "koda", "run", "--help"]),
    ).rejects.toMatchObject({ code: "commander.helpDisplayed" });
    expect(stdout.value).toContain("Run one coding-agent turn");
    expect(stdout.value).toContain("--model <model>");
    expect(stdout.value).toContain("--approval-mode <mode>");
  });
});
