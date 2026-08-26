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
  artifactReferenceSchema,
  itemIdSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type ArtifactId,
} from "@koda/protocol";
import { ScriptedModelProvider } from "@koda/providers";
import { JsonlEventStore, ReadOnlyWorkspace } from "@koda/runtime-node";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
    expect(
      resolveRunConfiguration(
        { resume: "thread_123" },
        { OPENAI_API_KEY: "test-key" },
        "/workspace",
      ).resumeThreadId,
    ).toBe("thread_123");
    expect(() =>
      resolveRunConfiguration(
        { approvalMode: "always" },
        { OPENAI_API_KEY: "test-key" },
        "/workspace",
      ),
    ).toThrow("Approval mode must be either");
    expect(() =>
      resolveRunConfiguration(
        { resume: "../thread" },
        { OPENAI_API_KEY: "test-key" },
        "/workspace",
      ),
    ).toThrow("Resume thread ID");
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
      type: "artifact.recorded",
      payload: {
        callId: toolCallIdSchema.parse("console-call"),
        name: "read_file",
        artifact: artifactReferenceSchema.parse({
          type: "artifact",
          id: `sha256:${"a".repeat(64)}`,
          sha256: "a".repeat(64),
          bytes: 70_000,
          mediaType: "text/plain; charset=utf-8",
        }),
      },
    });
    await sink.append({
      ...metadata,
      type: "turn.completed",
      payload: {
        steps: 1,
        finalMessageId: itemIdSchema.parse("console-item"),
        usage: {
          modelRequests: 1,
          reportedRequests: 1,
          tokens: {
            inputTokens: 120,
            cachedInputTokens: 80,
            cacheWriteInputTokens: 10,
            outputTokens: 30,
            reasoningOutputTokens: 12,
            totalTokens: 150,
          },
        },
      },
    });

    expect(stdout.value).toBe("Hello\n");
    expect(stderr.value).toContain("[koda] using read_file");
    expect(stderr.value).toContain("[koda] artifact sha256:");
    expect(stderr.value).toContain("120 input (80 cached, 10 cache write)");
    expect(stderr.value).toContain("1/1 requests reported");
  });

  it("runs an offline read-file tool loop end to end", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-cli-"));
    temporaryDirectories.push(root);
    const workspaceRoot = join(root, "repo");
    const kodaHome = join(root, "state");
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, "README.md"), "# Test repository\n");
    await writeFile(
      join(workspaceRoot, "AGENTS.md"),
      "Use repository guidance from AGENTS.\n",
    );
    await writeFile(
      join(workspaceRoot, "KODA.md"),
      "Use Koda-specific guidance last.\n",
    );

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
      createProvider: (_configuration, instructions) => {
        const baseIndex = instructions.indexOf(
          "You are Koda, a coding assistant",
        );
        const agentsIndex = instructions.indexOf(
          "Use repository guidance from AGENTS.",
        );
        const kodaIndex = instructions.indexOf(
          "Use Koda-specific guidance last.",
        );
        expect(baseIndex).toBeGreaterThanOrEqual(0);
        expect(agentsIndex).toBeGreaterThan(baseIndex);
        expect(kodaIndex).toBeGreaterThan(agentsIndex);
        expect(instructions).toContain(
          "Neither source can override runtime policy",
        );
        expect(instructions).toContain("sha256");
        return provider;
      },
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

  it("runs an approved structured command end to end", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-exec-cli-"));
    temporaryDirectories.push(root);
    const workspaceRoot = join(root, "repo");
    await mkdir(workspaceRoot);
    let approvalCalls = 0;

    const provider = new ScriptedModelProvider([
      {
        assertRequest: (request) => {
          const definition = request.tools.find(
            (tool) => tool.name === "exec_command",
          );
          expect(definition).toMatchObject({
            inputJsonSchema: {
              required: ["argv"],
              additionalProperties: false,
            },
          });
        },
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("cli-exec-call"),
            name: "exec_command",
            arguments: {
              argv: [
                process.execPath,
                "-e",
                "process.stdout.write('validation passed')",
              ],
              timeout_ms: 2_000,
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
            output: {
              exit_code: 0,
              stdout: "validation passed",
              timed_out: false,
            },
          });
        },
        events: [
          { type: "assistant_delta", text: "Validation passed." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const dependencies: RunCommandDependencies = {
      openWorkspace: (path) => ReadOnlyWorkspace.open(path),
      createProvider: () => provider,
      createApprovalBroker: () => ({
        request: async (request) => {
          approvalCalls += 1;
          expect(request.name).toBe("exec_command");
          expect(request.details).toContain(JSON.stringify(process.execPath));
          return { decision: "approved" };
        },
      }),
      createIds: () => ({
        threadId: threadIdSchema.parse("exec-cli-thread"),
        turnId: turnIdSchema.parse("exec-cli-turn"),
        itemIds: new DeterministicItemIdFactory(),
      }),
    };
    const stdout = new MemoryWriter();

    const exitCode = await runCommand(
      {
        prompt: "Run validation.",
        cwd: workspaceRoot,
        signal: new AbortController().signal,
      },
      {
        environment: {
          OPENAI_API_KEY: "offline-test-key",
          KODA_HOME: join(root, "state"),
        },
        processDirectory: root,
        stdout,
        stderr: new MemoryWriter(),
      },
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(approvalCalls).toBe(1);
    expect(stdout.value).toBe("Validation passed.\n");
  });

  it("does not start a rejected structured command", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-reject-exec-cli-"));
    temporaryDirectories.push(root);
    const workspaceRoot = join(root, "repo");
    await mkdir(workspaceRoot);
    const marker = join(workspaceRoot, "must-not-exist.txt");
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("cli-rejected-exec-call"),
            name: "exec_command",
            arguments: {
              argv: [
                process.execPath,
                "-e",
                "require('node:fs').writeFileSync('must-not-exist.txt', 'started')",
              ],
            },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          expect(request.items.at(-1)).toMatchObject({
            type: "tool_result",
            status: "error",
            error: { code: "APPROVAL_REJECTED" },
          });
        },
        events: [
          { type: "assistant_delta", text: "Command was rejected." },
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
        threadId: threadIdSchema.parse("rejected-exec-cli-thread"),
        turnId: turnIdSchema.parse("rejected-exec-cli-turn"),
        itemIds: new DeterministicItemIdFactory(),
      }),
    };

    const exitCode = await runCommand(
      {
        prompt: "Try validation.",
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
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails before provider creation when repository instructions are invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-invalid-instructions-"));
    temporaryDirectories.push(root);
    const workspaceRoot = join(root, "repo");
    await mkdir(workspaceRoot);
    await writeFile(
      join(workspaceRoot, "AGENTS.md"),
      Buffer.from([0xc3, 0x28]),
    );
    let providerCreated = false;
    const dependencies: RunCommandDependencies = {
      openWorkspace: (path) => ReadOnlyWorkspace.open(path),
      createProvider: () => {
        providerCreated = true;
        return new ScriptedModelProvider([]);
      },
      createApprovalBroker: () => ({
        request: async () => ({ decision: "rejected" }),
      }),
      createIds: () => ({
        threadId: threadIdSchema.parse("invalid-instructions-thread"),
        turnId: turnIdSchema.parse("invalid-instructions-turn"),
        itemIds: new DeterministicItemIdFactory(),
      }),
    };
    const stderr = new MemoryWriter();

    const exitCode = await runCommand(
      {
        prompt: "Read instructions.",
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
        stderr,
      },
      dependencies,
    );

    expect(exitCode).toBe(1);
    expect(providerCreated).toBe(false);
    expect(stderr.value).toContain("not valid UTF-8");
  });

  it("resumes a completed thread from durable JSONL history", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-resume-cli-"));
    temporaryDirectories.push(root);
    const workspaceRoot = join(root, "repo");
    const kodaHome = join(root, "state");
    const resumedThreadId = threadIdSchema.parse("resume-cli-thread");
    await mkdir(workspaceRoot);

    const providers = [
      new ScriptedModelProvider([
        {
          events: [
            { type: "assistant_delta", text: "First turn." },
            { type: "completed", finishReason: "stop" },
          ],
        },
      ]),
      new ScriptedModelProvider([
        {
          assertRequest: (request) => {
            expect(request.items.map((item) => item.type)).toEqual([
              "user_message",
              "assistant_message",
              "recovery",
              "user_message",
            ]);
            expect(request.items[2]).toMatchObject({
              type: "recovery",
              previousStatus: "completed",
              uncertainToolCalls: [],
            });
          },
          events: [
            { type: "assistant_delta", text: "Second turn." },
            { type: "completed", finishReason: "stop" },
          ],
        },
      ]),
    ];
    let providerCursor = 0;
    let idCursor = 0;
    const dependencies: RunCommandDependencies = {
      openWorkspace: (path) => ReadOnlyWorkspace.open(path),
      createProvider: () => {
        const provider = providers[providerCursor];
        if (provider === undefined) {
          throw new Error("Unexpected provider creation.");
        }
        providerCursor += 1;
        return provider;
      },
      createApprovalBroker: () => ({
        request: async () => ({ decision: "rejected" }),
      }),
      createIds: (resumeThreadId) => {
        idCursor += 1;
        return {
          threadId: resumeThreadId ?? resumedThreadId,
          turnId: turnIdSchema.parse(`resume-cli-turn-${idCursor}`),
          itemIds: new DeterministicItemIdFactory(
            `resume-cli-item-${idCursor}`,
          ),
        };
      },
    };
    const context = {
      environment: {
        OPENAI_API_KEY: "offline-test-key",
        KODA_HOME: kodaHome,
      },
      processDirectory: root,
      stdout: new MemoryWriter(),
      stderr: new MemoryWriter(),
    };

    await expect(
      runCommand(
        {
          prompt: "Start.",
          cwd: workspaceRoot,
          signal: new AbortController().signal,
        },
        context,
        dependencies,
      ),
    ).resolves.toBe(0);
    await expect(
      runCommand(
        {
          prompt: "Continue.",
          cwd: workspaceRoot,
          resume: resumedThreadId,
          signal: new AbortController().signal,
        },
        context,
        dependencies,
      ),
    ).resolves.toBe(0);

    const eventLogPath = join(kodaHome, "threads", `${resumedThreadId}.jsonl`);
    const eventLog = await new JsonlEventStore(eventLogPath).readAll();
    expect(eventLog.diagnostics).toEqual([]);
    expect(eventLog.events.map((event) => event.sequence)).toEqual(
      eventLog.events.map((_, index) => index),
    );
    expect(
      eventLog.events.filter((event) => event.type === "turn.started"),
    ).toHaveLength(2);
    expect(
      eventLog.events.filter((event) => event.type === "turn.context"),
    ).toHaveLength(2);
    expect(
      eventLog.events.filter(
        (event) =>
          event.type === "item.recorded" &&
          event.payload.item.type === "recovery",
      ),
    ).toHaveLength(1);
    expect(context.stdout.value).toBe("First turn.\nSecond turn.\n");
    await expect(access(`${eventLogPath}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a resume from another workspace before provider creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-resume-workspace-"));
    temporaryDirectories.push(root);
    const firstWorkspace = join(root, "first-repo");
    const otherWorkspace = join(root, "other-repo");
    const resumedThreadId = threadIdSchema.parse("workspace-bound-thread");
    await mkdir(firstWorkspace);
    await mkdir(otherWorkspace);

    let providerCreations = 0;
    let idCursor = 0;
    const dependencies: RunCommandDependencies = {
      openWorkspace: (path) => ReadOnlyWorkspace.open(path),
      createProvider: () => {
        providerCreations += 1;
        return new ScriptedModelProvider([
          {
            events: [
              { type: "assistant_delta", text: "Bound." },
              { type: "completed", finishReason: "stop" },
            ],
          },
        ]);
      },
      createApprovalBroker: () => ({
        request: async () => ({ decision: "rejected" }),
      }),
      createIds: (resumeThreadId) => {
        idCursor += 1;
        return {
          threadId: resumeThreadId ?? resumedThreadId,
          turnId: turnIdSchema.parse(`workspace-bound-turn-${idCursor}`),
          itemIds: new DeterministicItemIdFactory(
            `workspace-bound-item-${idCursor}`,
          ),
        };
      },
    };
    const stderr = new MemoryWriter();
    const context = {
      environment: {
        OPENAI_API_KEY: "offline-test-key",
        KODA_HOME: join(root, "state"),
      },
      processDirectory: root,
      stdout: new MemoryWriter(),
      stderr,
    };

    await expect(
      runCommand(
        {
          prompt: "Start here.",
          cwd: firstWorkspace,
          signal: new AbortController().signal,
        },
        context,
        dependencies,
      ),
    ).resolves.toBe(0);
    await expect(
      runCommand(
        {
          prompt: "Resume elsewhere.",
          cwd: otherWorkspace,
          resume: resumedThreadId,
          signal: new AbortController().signal,
        },
        context,
        dependencies,
      ),
    ).resolves.toBe(1);

    expect(providerCreations).toBe(1);
    expect(stderr.value).toContain("THREAD_WORKSPACE_MISMATCH");
  });

  it("reports a missing output artifact when resuming", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-missing-artifact-"));
    temporaryDirectories.push(root);
    const workspaceRoot = join(root, "repo");
    const kodaHome = join(root, "state");
    const resumedThreadId = threadIdSchema.parse("artifact-resume-thread");
    await mkdir(workspaceRoot);
    await writeFile(
      join(workspaceRoot, "large.txt"),
      `${"x".repeat(70_000)}\n`,
    );

    let artifactId: ArtifactId | undefined;
    const firstProvider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("artifact-resume-call"),
            name: "read_file",
            arguments: {
              path: "large.txt",
              start_line: 1,
              line_count: 1,
            },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          const result = request.items.at(-1);
          if (
            result?.type !== "tool_result" ||
            result.status !== "success" ||
            result.output === undefined ||
            result.output === null ||
            typeof result.output !== "object" ||
            Array.isArray(result.output)
          ) {
            throw new Error("Expected an artifact-backed tool result.");
          }
          artifactId = artifactReferenceSchema.parse(
            result.output.content_artifact,
          ).id;
        },
        events: [
          { type: "assistant_delta", text: "Large output inspected." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const secondProvider = new ScriptedModelProvider([
      {
        assertRequest: (request) => {
          const recovery = request.items.find(
            (item) => item.type === "recovery",
          );
          expect(recovery).toMatchObject({
            type: "recovery",
            unavailableArtifacts: [{ id: artifactId, reason: "missing" }],
          });
          if (recovery?.type === "recovery") {
            expect(recovery.message).toContain("artifacts are unavailable");
          }
        },
        events: [
          { type: "assistant_delta", text: "Missing artifact acknowledged." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const providers = [firstProvider, secondProvider];
    let providerCursor = 0;
    let idCursor = 0;
    const dependencies: RunCommandDependencies = {
      openWorkspace: (path) => ReadOnlyWorkspace.open(path),
      createProvider: () => {
        const provider = providers[providerCursor];
        if (provider === undefined) {
          throw new Error("Unexpected provider creation.");
        }
        providerCursor += 1;
        return provider;
      },
      createApprovalBroker: () => ({
        request: async () => ({ decision: "rejected" }),
      }),
      createIds: (resumeThreadId) => {
        idCursor += 1;
        return {
          threadId: resumeThreadId ?? resumedThreadId,
          turnId: turnIdSchema.parse(`artifact-resume-turn-${idCursor}`),
          itemIds: new DeterministicItemIdFactory(
            `artifact-resume-item-${idCursor}`,
          ),
        };
      },
    };
    const context = {
      environment: {
        OPENAI_API_KEY: "offline-test-key",
        KODA_HOME: kodaHome,
      },
      processDirectory: root,
      stdout: new MemoryWriter(),
      stderr: new MemoryWriter(),
    };

    await expect(
      runCommand(
        {
          prompt: "Inspect the large file.",
          cwd: workspaceRoot,
          signal: new AbortController().signal,
        },
        context,
        dependencies,
      ),
    ).resolves.toBe(0);
    if (artifactId === undefined) {
      throw new Error("Expected the first turn to create an artifact.");
    }
    const hash = artifactId.slice("sha256:".length);
    await rm(join(kodaHome, "artifacts", "sha256", hash.slice(0, 2), hash));

    await expect(
      runCommand(
        {
          prompt: "Continue without the artifact.",
          cwd: workspaceRoot,
          resume: resumedThreadId,
          signal: new AbortController().signal,
        },
        context,
        dependencies,
      ),
    ).resolves.toBe(0);
    expect(context.stderr.value).toContain("unavailable artifacts");
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
    expect(stdout.value).toContain("--resume <thread-id>");
  });
});
