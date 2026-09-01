import {
  ConsoleEventSink,
  createProgram,
  resolveRunConfiguration,
  runCommand,
  type RunCommandDependencies,
  type TextWriter,
} from "@koda/cli";
import type {
  ModelProvider,
  PlanAcceptanceBrokerRequest,
} from "@koda/agent-core";
import {
  artifactReferenceSchema,
  agentEventSchema,
  itemIdSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type ArtifactId,
} from "@koda/protocol";
import { ScriptedModelProvider } from "@koda/providers";
import {
  JsonlEventStore,
  ReadOnlyWorkspace,
  ThreadMetadataIndex,
} from "@koda/runtime-node";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  linuxProtectedLaunchSecurity,
  macosProtectedLaunchSecurity,
  notRequestedResourceEvidence,
} from "./execution-security-fixtures.js";
import { destroyedSecretEvidence } from "./execution-secret-fixtures.js";

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
    expect(fromEnvironment.provider).toBe("openai");
    expect(fromEnvironment.approvalMode).toBe("on-request");
    expect(fromEnvironment.contextWindowTokens).toBe(128_000);
    expect(fromEnvironment.maxOutputTokens).toBe(16_384);

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
    expect(
      resolveRunConfiguration(
        {},
        {
          KODA_PROVIDER: "anthropic",
          ANTHROPIC_API_KEY: "anthropic-key",
        },
        "/workspace",
      ),
    ).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      apiKey: "anthropic-key",
    });
    expect(
      resolveRunConfiguration(
        { provider: "kimi" },
        {
          OPENAI_API_KEY: "must-not-be-selected",
          MOONSHOT_API_KEY: "moonshot-key",
        },
        "/workspace",
      ),
    ).toMatchObject({
      provider: "kimi",
      model: "kimi-k2.6",
      apiKey: "moonshot-key",
    });
    expect(() =>
      resolveRunConfiguration(
        { provider: "glm" },
        { OPENAI_API_KEY: "wrong-provider-key" },
        "/workspace",
      ),
    ).toThrow("ZAI_API_KEY is required for provider 'glm'");
    expect(() =>
      resolveRunConfiguration(
        { provider: "glm" },
        { OPENAI_API_KEY: "wrong-provider-key" },
        "/workspace",
      ),
    ).toThrow("koda setup --cwd . --provider glm");
    expect(() =>
      resolveRunConfiguration(
        { provider: "unknown" },
        { OPENAI_API_KEY: "test-key" },
        "/workspace",
      ),
    ).toThrow("Provider must be one of");
    expect(
      resolveRunConfiguration(
        {},
        {
          OPENAI_API_KEY: "test-key",
          KODA_CONTEXT_WINDOW_TOKENS: "200000",
          KODA_MAX_OUTPUT_TOKENS: "20000",
        },
        "/workspace",
      ),
    ).toMatchObject({
      contextWindowTokens: 200_000,
      maxOutputTokens: 20_000,
    });
    expect(() =>
      resolveRunConfiguration(
        {},
        {
          OPENAI_API_KEY: "test-key",
          KODA_CONTEXT_WINDOW_TOKENS: "not-a-number",
        },
        "/workspace",
      ),
    ).toThrow("KODA_CONTEXT_WINDOW_TOKENS must be a positive integer");
    expect(() =>
      resolveRunConfiguration(
        {},
        {
          OPENAI_API_KEY: "test-key",
          KODA_CONTEXT_WINDOW_TOKENS: "20000",
          KODA_MAX_OUTPUT_TOKENS: "16384",
        },
        "/workspace",
      ),
    ).toThrow("must exceed KODA_MAX_OUTPUT_TOKENS");
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
      type: "process.started",
      payload: {
        callId: toolCallIdSchema.parse("console-call"),
        name: "exec_terminal",
        pid: 42,
        ownership: "posix_process_group",
        security: macosProtectedLaunchSecurity(),
        resources: notRequestedResourceEvidence(),
        secrets: destroyedSecretEvidence(),
      },
    });
    await sink.append({
      ...metadata,
      type: "process.exited",
      payload: {
        callId: toolCallIdSchema.parse("console-call"),
        name: "exec_terminal",
        pid: 42,
        exitCode: 0,
        signal: null,
        resources: notRequestedResourceEvidence(),
        secrets: destroyedSecretEvidence(),
      },
    });
    await sink.append({
      ...metadata,
      sequence: 3,
      type: "process.started",
      payload: {
        callId: toolCallIdSchema.parse("linux-console-call"),
        name: "exec_command",
        pid: 43,
        ownership: "posix_process_group",
        security: linuxProtectedLaunchSecurity(),
        resources: notRequestedResourceEvidence(),
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
    expect(stderr.value).toContain("OS sandbox: macOS Seatbelt");
    expect(stderr.value).toContain("OS sandbox: Linux Bubblewrap + seccomp");
    expect(stderr.value).toContain("resources not requested");
    expect(stderr.value).toContain(
      "secrets api-token · destroyed · cleanup completed · redacted 1",
    );
    expect(stderr.value).not.toContain("0123456789abcdef");
    expect(stderr.value).not.toContain("APP_TOKEN_FILE");
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
    const metadataIndex = await ThreadMetadataIndex.open(kodaHome);
    expect(metadataIndex.get(threadIdSchema.parse("cli-thread"))).toMatchObject(
      {
        status: "completed",
        workspaceRoot: await realpath(workspaceRoot),
      },
    );
    metadataIndex.close();
  });

  it("accepts a gated Plan Stage through the CLI broker and persists its lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-plan-cli-"));
    temporaryDirectories.push(root);
    const workspaceRoot = join(root, "repo");
    const kodaHome = join(root, "state");
    await mkdir(workspaceRoot);
    const callId = toolCallIdSchema.parse("cli-plan-call");
    const provider = new ScriptedModelProvider([
      {
        assertRequest: (request) => {
          expect(request.tools.map((tool) => tool.name)).toContain(
            "update_plan",
          );
        },
        events: [
          {
            type: "tool_call",
            callId,
            name: "update_plan",
            arguments: {
              expected_revision: 0,
              objective: "Finish the gated CLI Stage",
              stages: [
                {
                  id: "stage-cli",
                  title: "Verify CLI planning",
                  requires_acceptance: true,
                  acceptance_criteria: ["The CLI Plan lifecycle is durable."],
                  summary: "CLI planning is ready for acceptance.",
                  evidence: [{ kind: "tool_call", callId }],
                  todos: [
                    {
                      id: "todo-cli",
                      title: "Implement CLI Plan acceptance",
                      status: "completed",
                      outcome: "Implemented with an interactive broker.",
                    },
                  ],
                },
              ],
            },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          expect(
            request.items.find(
              (item) => item.type === "tool_result" && item.callId === callId,
            ),
          ).toMatchObject({
            status: "success",
            output: {
              plan: {
                revision: 2,
                status: "completed",
                stages: [{ id: "stage-cli", status: "accepted" }],
              },
              acceptance: { status: "accepted" },
            },
          });
        },
        events: [
          { type: "assistant_delta", text: "The gated Stage was accepted." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const acceptanceRequests: PlanAcceptanceBrokerRequest[] = [];
    const dependencies: RunCommandDependencies = {
      openWorkspace: (path) => ReadOnlyWorkspace.open(path),
      createProvider: () => provider,
      createApprovalBroker: () => ({
        request: async () => ({ decision: "rejected" }),
      }),
      createPlanAcceptanceBroker: () => ({
        request: async (request) => {
          acceptanceRequests.push(request);
          return {
            callId: request.callId,
            planId: request.planId,
            planRevision: request.planRevision,
            stageId: request.stageId,
            decision: "accepted",
          };
        },
      }),
      createIds: () => ({
        threadId: threadIdSchema.parse("plan-cli-thread"),
        turnId: turnIdSchema.parse("plan-cli-turn"),
        itemIds: new DeterministicItemIdFactory("plan-cli-item"),
      }),
    };
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();

    await expect(
      runCommand(
        {
          prompt: "Finish the gated CLI Stage.",
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
      ),
    ).resolves.toBe(0);

    expect(acceptanceRequests).toEqual([
      expect.objectContaining({
        threadId: "plan-cli-thread",
        turnId: "plan-cli-turn",
        callId: "cli-plan-call",
        planRevision: 1,
        stageId: "stage-cli",
        criteria: ["The CLI Plan lifecycle is durable."],
        summary: "CLI planning is ready for acceptance.",
      }),
    ]);
    expect(stdout.value).toBe("The gated Stage was accepted.\n");
    expect(stderr.value).toContain("plan revision 1");
    expect(stderr.value).toContain("plan revision 2");
    const eventLog = await new JsonlEventStore(
      join(kodaHome, "threads", "plan-cli-thread.jsonl"),
    ).readAll();
    expect(
      eventLog.events
        .filter((event) =>
          [
            "plan.updated",
            "plan.checkpointed",
            "plan.acceptance_requested",
            "plan.acceptance_resolved",
          ].includes(event.type),
        )
        .map((event) => event.type),
    ).toEqual([
      "plan.updated",
      "plan.checkpointed",
      "plan.acceptance_requested",
      "plan.acceptance_resolved",
      "plan.updated",
      "plan.checkpointed",
      "plan.checkpointed",
    ]);
  });

  it("cancels an in-flight turn through the caller signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-cancel-"));
    temporaryDirectories.push(root);
    const workspaceRoot = join(root, "repo");
    const kodaHome = join(root, "state");
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
          KODA_HOME: kodaHome,
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
    const kodaHome = join(root, "state");
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
          KODA_HOME: kodaHome,
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

  it("applies one approved coordinated change set end to end", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-change-set-cli-"));
    temporaryDirectories.push(root);
    const workspaceRoot = join(root, "repo");
    const kodaHome = join(root, "state");
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, "first.txt"), "Before\n");
    await writeFile(join(workspaceRoot, "remove.txt"), "Remove me\n");
    let approvalCalls = 0;

    const provider = new ScriptedModelProvider([
      {
        assertRequest: (request) => {
          const definition = request.tools.find(
            (tool) => tool.name === "apply_changes",
          );
          expect(definition).toMatchObject({
            inputJsonSchema: {
              required: ["changes"],
              additionalProperties: false,
            },
          });
        },
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("cli-change-set-call"),
            name: "apply_changes",
            arguments: {
              changes: [
                {
                  operation: "update",
                  path: "first.txt",
                  edits: [{ old_text: "Before", new_text: "After" }],
                },
                {
                  operation: "create",
                  path: "created.txt",
                  content: "Created\n",
                },
                { operation: "delete", path: "remove.txt" },
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
            status: "success",
            output: { status: "committed" },
          });
        },
        events: [
          { type: "assistant_delta", text: "Applied the change set." },
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
          expect(request.details).toContain("*** Update File: first.txt");
          expect(request.details).toContain("*** Create File: created.txt");
          expect(request.details).toContain("*** Delete File: remove.txt");
          return { decision: "approved" };
        },
      }),
      createIds: () => ({
        threadId: threadIdSchema.parse("change-set-cli-thread"),
        turnId: turnIdSchema.parse("change-set-cli-turn"),
        itemIds: new DeterministicItemIdFactory("change-set-cli-item"),
      }),
    };

    const exitCode = await runCommand(
      {
        prompt: "Apply coordinated changes.",
        cwd: workspaceRoot,
        signal: new AbortController().signal,
      },
      {
        environment: {
          OPENAI_API_KEY: "offline-test-key",
          KODA_HOME: kodaHome,
        },
        processDirectory: root,
        stdout: new MemoryWriter(),
        stderr: new MemoryWriter(),
      },
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(approvalCalls).toBe(1);
    expect(await readFile(join(workspaceRoot, "first.txt"), "utf8")).toBe(
      "After\n",
    );
    expect(await readFile(join(workspaceRoot, "created.txt"), "utf8")).toBe(
      "Created\n",
    );
    await expect(
      readFile(join(workspaceRoot, "remove.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies one approved patch document end to end", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-patchset-cli-"));
    temporaryDirectories.push(root);
    const workspaceRoot = join(root, "repo");
    const kodaHome = join(root, "state");
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, "first.txt"), "Before\n");
    let approvalCalls = 0;

    const provider = new ScriptedModelProvider([
      {
        assertRequest: (request) => {
          const definition = request.tools.find(
            (tool) => tool.name === "apply_patchset",
          );
          expect(definition).toMatchObject({
            inputJsonSchema: {
              required: ["patch"],
              additionalProperties: false,
            },
          });
        },
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("cli-patchset-call"),
            name: "apply_patchset",
            arguments: {
              patch: `*** Begin Patch
*** Update File: first.txt
@@
-Before
+After
*** Add File: created.txt
+Created
*** End Patch`,
            },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          expect(request.items.at(-1)).toMatchObject({
            type: "tool_result",
            status: "success",
            output: { status: "committed" },
          });
        },
        events: [
          { type: "assistant_delta", text: "Applied the patch document." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const dependencies: RunCommandDependencies = {
      openWorkspace: (path) => ReadOnlyWorkspace.open(path),
      createProvider: (_configuration, instructions) => {
        expect(instructions).toContain("Koda Patch v1");
        return provider;
      },
      createApprovalBroker: () => ({
        request: async (request) => {
          approvalCalls += 1;
          expect(request.name).toBe("apply_patchset");
          expect(request.details).toContain("*** Update File: first.txt");
          expect(request.details).toContain("*** Create File: created.txt");
          return { decision: "approved" };
        },
      }),
      createIds: () => ({
        threadId: threadIdSchema.parse("patchset-cli-thread"),
        turnId: turnIdSchema.parse("patchset-cli-turn"),
        itemIds: new DeterministicItemIdFactory("patchset-cli-item"),
      }),
    };

    const patchsetStdout = new MemoryWriter();
    const patchsetStderr = new MemoryWriter();
    const exitCode = await runCommand(
      {
        prompt: "Apply the patch document.",
        cwd: workspaceRoot,
        signal: new AbortController().signal,
      },
      {
        environment: {
          OPENAI_API_KEY: "offline-test-key",
          KODA_HOME: kodaHome,
        },
        processDirectory: root,
        stdout: patchsetStdout,
        stderr: patchsetStderr,
      },
      dependencies,
    );

    expect(exitCode, patchsetStderr.value).toBe(0);
    expect(approvalCalls).toBe(1);
    expect(await readFile(join(workspaceRoot, "first.txt"), "utf8")).toBe(
      "After\n",
    );
    expect(await readFile(join(workspaceRoot, "created.txt"), "utf8")).toBe(
      "Created\n",
    );
  });

  it("runs an approved structured command end to end", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-exec-cli-"));
    temporaryDirectories.push(root);
    const workspaceRoot = join(root, "repo");
    const kodaHome = join(root, "state");
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
              security: {
                kind: "policy",
                stage: "launch_setup",
              },
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
          expect(request.details).toContain("OS sandbox: none");
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
    const stderr = new MemoryWriter();

    const exitCode = await runCommand(
      {
        prompt: "Run validation.",
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
    expect(approvalCalls).toBe(1);
    expect(stdout.value).toBe("Validation passed.\n");
    expect(stderr.value).toContain("OS sandbox: none");
    const events = await new JsonlEventStore(
      join(kodaHome, "threads", "exec-cli-thread.jsonl"),
    ).readAll();
    const lifecycle = events.events.map((event) => event.type);
    expect(lifecycle.indexOf("approval.resolved")).toBeLessThan(
      lifecycle.indexOf("tool.execution_started"),
    );
    expect(lifecycle.indexOf("tool.execution_started")).toBeLessThan(
      lifecycle.indexOf("process.started"),
    );
    expect(lifecycle.indexOf("process.started")).toBeLessThan(
      lifecycle.indexOf("process.exited"),
    );
    expect(lifecycle.indexOf("process.exited")).toBeLessThan(
      lifecycle.indexOf("tool.completed"),
    );
    expect(
      events.events.find((event) => event.type === "process.started"),
    ).toMatchObject({
      payload: {
        security: { kind: "policy", stage: "launch_setup" },
      },
    });
  });

  it("rejects a protected execution profile before approval or launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-protected-exec-cli-"));
    temporaryDirectories.push(root);
    const workspaceRoot = join(root, "repo");
    const marker = join(workspaceRoot, "must-not-run.txt");
    await mkdir(workspaceRoot);
    let approvalCalls = 0;
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("protected-exec-cli-call"),
            name: "exec_command",
            arguments: {
              argv: [
                process.execPath,
                "-e",
                "require('node:fs').writeFileSync('must-not-run.txt', 'bad')",
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
            error: { code: "EXECUTION_POLICY_UNAVAILABLE" },
          });
        },
        events: [
          { type: "assistant_delta", text: "Policy refused execution." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const dependencies: RunCommandDependencies = {
      openWorkspace: (path) => ReadOnlyWorkspace.open(path),
      createProvider: () => provider,
      createApprovalBroker: () => ({
        request: async () => {
          approvalCalls += 1;
          return { decision: "approved" };
        },
      }),
      createIds: () => ({
        threadId: threadIdSchema.parse("protected-exec-cli-thread"),
        turnId: turnIdSchema.parse("protected-exec-cli-turn"),
        itemIds: new DeterministicItemIdFactory(),
      }),
    };

    const exitCode = await runCommand(
      {
        prompt: "Try the protected command.",
        cwd: workspaceRoot,
        signal: new AbortController().signal,
      },
      {
        environment: {
          OPENAI_API_KEY: "offline-test-key",
          KODA_HOME: join(root, "state"),
          KODA_EXECUTION_PROFILE: "read-only",
        },
        processDirectory: root,
        stdout: new MemoryWriter(),
        stderr: new MemoryWriter(),
      },
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(approvalCalls).toBe(0);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
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
    await writeFile(join(workspaceRoot, "AGENTS.md"), "Original guidance.\n");

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
              instructionChanges: [
                { path: "AGENTS.md", scope: ".", change: "changed" },
              ],
              uncertainToolCalls: [],
            });
            if (request.items[2]?.type === "recovery") {
              expect(request.items[2].message).toContain(
                "Repository instructions changed",
              );
            }
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
    await writeFile(join(workspaceRoot, "AGENTS.md"), "Updated guidance.\n");
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
    expect(context.stderr.value).toContain(
      "repository instructions changed: changed AGENTS.md",
    );
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

  it("lists and shows indexed threads without provider credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-thread-cli-"));
    temporaryDirectories.push(root);
    const kodaHome = join(root, "state");
    const workspaceRoot = join(root, "repo");
    await mkdir(workspaceRoot);
    const canonicalWorkspaceRoot = await realpath(workspaceRoot);
    const threadId = threadIdSchema.parse("thread-query-cli");
    const turnId = turnIdSchema.parse("thread-query-turn");
    const store = new JsonlEventStore(
      join(kodaHome, "threads", `${threadId}.jsonl`),
    );
    await store.append(
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 0,
        timestamp: "2026-08-26T04:00:00.000Z",
        threadId,
        turnId,
        type: "turn.started",
        payload: {},
      }),
    );
    await store.append(
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 1,
        timestamp: "2026-08-26T04:00:01.000Z",
        threadId,
        turnId,
        type: "turn.context",
        payload: {
          provider: "openai",
          model: "offline-query-model",
          workspaceRoot: canonicalWorkspaceRoot,
          approvalMode: "never",
          instructionsSha256: "a".repeat(64),
          repositoryInstructions: [],
        },
      }),
    );
    await store.append(
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 2,
        timestamp: "2026-08-26T04:00:02.000Z",
        threadId,
        turnId,
        type: "turn.completed",
        payload: { steps: 1 },
      }),
    );

    const listStdout = new MemoryWriter();
    const listStderr = new MemoryWriter();
    let listExitCode = -1;
    const listProgram = createProgram({
      environment: { KODA_HOME: kodaHome },
      processDirectory: root,
      stdout: listStdout,
      stderr: listStderr,
      setExitCode: (code) => {
        listExitCode = code;
      },
    });
    await listProgram.parseAsync([
      "node",
      "koda",
      "thread",
      "list",
      "--workspace",
      workspaceRoot,
      "--limit",
      "1",
    ]);

    expect(listExitCode).toBe(0);
    expect(listStdout.value).toContain("THREAD ID\tSTATUS");
    expect(listStdout.value).toContain(
      `${threadId}\tcompleted\t2026-08-26T04:00:02.000Z\toffline-query-model`,
    );
    expect(listStderr.value).toBe("");

    const showStdout = new MemoryWriter();
    let showExitCode = -1;
    const showProgram = createProgram({
      environment: { KODA_HOME: kodaHome },
      processDirectory: root,
      stdout: showStdout,
      stderr: new MemoryWriter(),
      setExitCode: (code) => {
        showExitCode = code;
      },
    });
    await showProgram.parseAsync(["node", "koda", "thread", "show", threadId]);

    expect(showExitCode).toBe(0);
    expect(showStdout.value).toContain(`Thread: ${threadId}`);
    expect(showStdout.value).toContain("Status: completed");
    expect(showStdout.value).toContain("Model: offline-query-model");

    const missingStderr = new MemoryWriter();
    let missingExitCode = -1;
    const missingProgram = createProgram({
      environment: { KODA_HOME: kodaHome },
      processDirectory: root,
      stdout: new MemoryWriter(),
      stderr: missingStderr,
      setExitCode: (code) => {
        missingExitCode = code;
      },
    });
    await missingProgram.parseAsync([
      "node",
      "koda",
      "thread",
      "show",
      "missing-thread",
    ]);
    expect(missingExitCode).toBe(3);
    expect(missingStderr.value).toContain("was not found");
  });

  it("keeps a completed run successful when metadata refresh fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-index-warning-cli-"));
    temporaryDirectories.push(root);
    const workspaceRoot = join(root, "repo");
    const kodaHome = join(root, "state");
    await mkdir(workspaceRoot);
    await mkdir(join(kodaHome, "state.db"), { recursive: true });
    const provider = new ScriptedModelProvider([
      {
        events: [
          { type: "assistant_delta", text: "Durable answer." },
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
        threadId: threadIdSchema.parse("metadata-warning-thread"),
        turnId: turnIdSchema.parse("metadata-warning-turn"),
        itemIds: new DeterministicItemIdFactory("metadata-warning-item"),
      }),
    };
    const stderr = new MemoryWriter();

    await expect(
      runCommand(
        {
          prompt: "Complete despite derived-store failure.",
          cwd: workspaceRoot,
          signal: new AbortController().signal,
        },
        {
          environment: {
            OPENAI_API_KEY: "offline-test-key",
            KODA_HOME: kodaHome,
          },
          processDirectory: root,
          stdout: new MemoryWriter(),
          stderr,
        },
        dependencies,
      ),
    ).resolves.toBe(0);
    expect(stderr.value).toContain("thread metadata refresh failed");
    await expect(
      new JsonlEventStore(
        join(kodaHome, "threads", "metadata-warning-thread.jsonl"),
      ).readAll(),
    ).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ type: "turn.completed" }),
      ]),
    });
  });
});
