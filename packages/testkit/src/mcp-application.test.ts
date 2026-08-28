import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KodaApplication,
  type KodaApplicationDependencies,
  type TurnClient,
} from "@koda/app";
import type { ModelProvider } from "@koda/agent-core";
import {
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type AgentEvent,
  type ToolResultItem,
} from "@koda/protocol";
import { ScriptedModelProvider } from "@koda/providers";
import { ReadOnlyWorkspace } from "@koda/runtime-node";
import { afterEach, describe, expect, it } from "vitest";

import { DeterministicItemIdFactory } from "./deterministic.js";

const fixtureServer = fileURLToPath(
  new URL("../fixtures/mcp-server.mjs", import.meta.url),
);
const paginatedFixtureServer = fileURLToPath(
  new URL("../fixtures/mcp-paginated-server.mjs", import.meta.url),
);
const dynamicFixtureServer = fileURLToPath(
  new URL("../fixtures/mcp-dynamic-server.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("KodaApplication MCP integration", () => {
  it("runs real stdio tools under Koda policy and closes the child", async () => {
    const fixture = await createFixture("success");
    const exitFile = join(fixture.root, "server-exited.txt");
    await writeMcpConfiguration(fixture, {
      command: process.execPath,
      args: [fixtureServer],
      cwd: fixture.workspaceRoot,
      env: ["KODA_MCP_FIXTURE_SECRET", "KODA_MCP_FIXTURE_EXIT_FILE"],
      tools: { echo: { effect: "read" } },
    });
    const provider = new ScriptedModelProvider([
      {
        assertRequest: (request) => {
          expect(
            request.tools
              .filter((tool) => tool.name.startsWith("mcp__fixture__"))
              .map((tool) => tool.name),
          ).toEqual([
            "mcp__fixture__echo",
            "mcp__fixture__environment",
            "mcp__fixture__fail",
            "mcp__fixture__hang",
            "mcp__fixture__large",
          ]);
          expect(
            request.tools.find((tool) => tool.name === "mcp__fixture__echo")
              ?.inputJsonSchema,
          ).toMatchObject({ type: "object", required: ["value"] });
        },
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("mcp-echo-call"),
            name: "mcp__fixture__echo",
            arguments: { value: "hello from Koda" },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          expect(latestToolResult(request.items)).toMatchObject({
            name: "mcp__fixture__echo",
            status: "success",
            output: {
              structured_content: { echoed: "hello from Koda" },
            },
          });
        },
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("mcp-environment-call"),
            name: "mcp__fixture__environment",
            arguments: {},
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          expect(latestToolResult(request.items)).toMatchObject({
            name: "mcp__fixture__environment",
            status: "success",
            output: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    secret: "allowed-secret",
                    forbiddenPresent: false,
                  }),
                },
              ],
            },
          });
        },
        events: [
          { type: "assistant_delta", text: "MCP tools completed." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    let approvalCalls = 0;
    const events: AgentEvent[] = [];
    const application = new KodaApplication({
      environment: {
        OPENAI_API_KEY: "offline-test-key",
        KODA_HOME: fixture.kodaHome,
        KODA_MCP_FIXTURE_SECRET: "allowed-secret",
        KODA_MCP_FIXTURE_FORBIDDEN: "must-not-leak",
        KODA_MCP_FIXTURE_EXIT_FILE: exitFile,
      },
      processDirectory: fixture.root,
      dependencies: dependencies(provider, "mcp-success"),
    });
    const client: TurnClient = {
      events: { append: async (event) => void events.push(event) },
      approvals: {
        request: async (request) => {
          approvalCalls += 1;
          expect(request.name).toBe("mcp__fixture__environment");
          expect(request.title).toBe("Call MCP tool fixture/environment");
          return { decision: "approved" };
        },
      },
    };

    await expect(
      application.startTurn(
        { prompt: "Use the MCP tools.", cwd: fixture.workspaceRoot },
        client,
      ).completion,
    ).resolves.toMatchObject({ status: "completed", exitCode: 0 });

    expect(approvalCalls).toBe(1);
    expect(events.map((event) => event.type)).toContain("approval.resolved");
    await expectFile(exitFile);
  });

  it("aggregates every page of a real MCP tool catalog", async () => {
    const fixture = await createFixture("pagination");
    const exitFile = join(fixture.root, "server-exited.txt");
    await writeMcpConfiguration(fixture, {
      command: process.execPath,
      args: [paginatedFixtureServer],
      env: ["KODA_MCP_FIXTURE_EXIT_FILE"],
    });
    const provider = new ScriptedModelProvider([
      {
        assertRequest: (request) => {
          expect(
            request.tools
              .filter((tool) => tool.name.startsWith("mcp__fixture__page_"))
              .map((tool) => tool.name),
          ).toEqual(["mcp__fixture__page_one", "mcp__fixture__page_two"]);
        },
        events: [
          { type: "assistant_delta", text: "Both pages were discovered." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const application = new KodaApplication({
      environment: {
        OPENAI_API_KEY: "offline-test-key",
        KODA_HOME: fixture.kodaHome,
        KODA_MCP_FIXTURE_EXIT_FILE: exitFile,
      },
      processDirectory: fixture.root,
      dependencies: dependencies(provider, "mcp-pagination"),
    });

    await expect(
      application.startTurn(
        { prompt: "Inspect the full MCP catalog.", cwd: fixture.workspaceRoot },
        {
          events: { append: async () => undefined },
          approvals: rejectApprovals(),
        },
      ).completion,
    ).resolves.toMatchObject({ status: "completed", exitCode: 0 });
    await expectFile(exitFile);
  });

  it("installs a changed real MCP catalog only between model steps", async () => {
    const fixture = await createFixture("dynamic-catalog");
    const exitFile = join(fixture.root, "server-exited.txt");
    await writeMcpConfiguration(fixture, {
      command: process.execPath,
      args: [dynamicFixtureServer],
      env: ["KODA_MCP_FIXTURE_EXIT_FILE"],
      tools: { advance: { effect: "read" } },
    });
    let initialGeneration = "";
    let refreshedGeneration = "";
    const dynamicThreadId = threadIdSchema.parse("mcp-dynamic-thread");
    let turnCursor = 0;
    const provider = new ScriptedModelProvider([
      {
        assertRequest: (request) => {
          expect(
            request.tools
              .filter((tool) => tool.name.startsWith("mcp__fixture__"))
              .map((tool) => tool.name),
          ).toEqual(["mcp__fixture__advance", "mcp__fixture__old"]);
        },
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("mcp-dynamic-advance"),
            name: "mcp__fixture__advance",
            arguments: {},
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          expect(
            request.tools
              .filter((tool) => tool.name.startsWith("mcp__fixture__"))
              .map((tool) => tool.name),
          ).toEqual(["mcp__fixture__advance", "mcp__fixture__next"]);
          expect(latestToolResult(request.items)).toMatchObject({
            name: "mcp__fixture__advance",
            status: "success",
          });
        },
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("mcp-dynamic-next"),
            name: "mcp__fixture__next",
            arguments: {},
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          expect(latestToolResult(request.items)).toMatchObject({
            name: "mcp__fixture__next",
            status: "success",
            output: {
              structured_content: { tool: "next", generation: 2 },
            },
          });
        },
        events: [
          { type: "assistant_delta", text: "Dynamic catalog completed." },
          { type: "completed", finishReason: "stop" },
        ],
      },
      {
        assertRequest: (request) => {
          expect(request.items).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "recovery",
                toolCatalogGenerationChange: {
                  previous: expect.objectContaining({
                    generationId: refreshedGeneration,
                  }),
                  current: expect.objectContaining({
                    generationId: initialGeneration,
                  }),
                },
              }),
            ]),
          );
        },
        events: [
          { type: "assistant_delta", text: "Resume catalog audited." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const observed: AgentEvent[] = [];
    let approvals = 0;
    const application = new KodaApplication({
      environment: {
        OPENAI_API_KEY: "offline-test-key",
        KODA_HOME: fixture.kodaHome,
        KODA_MCP_FIXTURE_EXIT_FILE: exitFile,
      },
      processDirectory: fixture.root,
      dependencies: {
        openWorkspace: (root) => ReadOnlyWorkspace.open(root),
        createProvider: () => provider,
        createIds: (resumeThreadId) => {
          turnCursor += 1;
          return {
            threadId: resumeThreadId ?? dynamicThreadId,
            turnId: turnIdSchema.parse(`mcp-dynamic-turn-${turnCursor}`),
            itemIds: new DeterministicItemIdFactory(
              `mcp-dynamic-item-${turnCursor}`,
            ),
          };
        },
      },
    });

    await expect(
      application.startTurn(
        { prompt: "Use the changing MCP catalog.", cwd: fixture.workspaceRoot },
        {
          events: {
            append: async (event) => {
              observed.push(event);
              if (event.type === "turn.context") {
                initialGeneration =
                  event.payload.toolCatalogGeneration?.generationId ?? "";
              }
              if (event.type === "tool.catalog_changed") {
                refreshedGeneration = event.payload.current.generationId;
              }
            },
          },
          approvals: {
            request: async (request) => {
              approvals += 1;
              expect(request.name).toBe("mcp__fixture__next");
              return { decision: "approved" };
            },
          },
        },
      ).completion,
    ).resolves.toMatchObject({ status: "completed", exitCode: 0 });

    expect(initialGeneration).toMatch(/^tool-catalog:[a-f0-9]{64}$/u);
    expect(refreshedGeneration).toMatch(/^tool-catalog:[a-f0-9]{64}$/u);
    expect(refreshedGeneration).not.toBe(initialGeneration);
    expect(approvals).toBe(1);
    expect(
      observed.filter((event) => event.type === "tool.catalog_changed"),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          step: 2,
          changes: [
            expect.objectContaining({
              name: "mcp__fixture__advance",
              change: "changed",
            }),
            expect.objectContaining({
              name: "mcp__fixture__next",
              change: "added",
            }),
            expect.objectContaining({
              name: "mcp__fixture__old",
              change: "removed",
            }),
          ],
        }),
      }),
    ]);
    const preparedGenerations = observed.flatMap((event) =>
      event.type === "context.prepared"
        ? [event.payload.toolCatalogGenerationId]
        : [],
    );
    expect(preparedGenerations).toEqual([
      initialGeneration,
      refreshedGeneration,
      refreshedGeneration,
    ]);
    const callGenerations = observed.flatMap((event) =>
      event.type === "item.recorded" && event.payload.item.type === "tool_call"
        ? [event.payload.item.catalogGenerationId]
        : [],
    );
    expect(callGenerations).toEqual([initialGeneration, refreshedGeneration]);
    await expect(
      application.startTurn(
        {
          prompt: "Resume the changing MCP catalog.",
          cwd: fixture.workspaceRoot,
          resume: dynamicThreadId,
        },
        {
          events: { append: async () => undefined },
          approvals: rejectApprovals(),
        },
      ).completion,
    ).resolves.toMatchObject({ status: "completed", exitCode: 0 });
    await expectFile(exitFile);
  });

  it("cancels an in-flight MCP call and closes its stdio server", async () => {
    const fixture = await createFixture("cancel");
    const exitFile = join(fixture.root, "server-exited.txt");
    const startedFile = join(fixture.root, "call-started.txt");
    await writeMcpConfiguration(fixture, {
      command: process.execPath,
      args: [fixtureServer],
      env: ["KODA_MCP_FIXTURE_EXIT_FILE", "KODA_MCP_FIXTURE_STARTED_FILE"],
      tools: { hang: { effect: "read" } },
      call_timeout_ms: 10_000,
    });
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("mcp-hang-call"),
            name: "mcp__fixture__hang",
            arguments: {},
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
    ]);
    const application = new KodaApplication({
      environment: {
        OPENAI_API_KEY: "offline-test-key",
        KODA_HOME: fixture.kodaHome,
        KODA_MCP_FIXTURE_EXIT_FILE: exitFile,
        KODA_MCP_FIXTURE_STARTED_FILE: startedFile,
      },
      processDirectory: fixture.root,
      dependencies: dependencies(provider, "mcp-cancel"),
    });
    const handle = application.startTurn(
      { prompt: "Wait in the MCP tool.", cwd: fixture.workspaceRoot },
      {
        events: { append: async () => undefined },
        approvals: rejectApprovals(),
      },
    );

    await expectFile(startedFile);
    expect(handle.cancel("Cancel the MCP call.")).toBe(true);
    await expect(handle.completion).resolves.toMatchObject({
      status: "cancelled",
      exitCode: 130,
      error: { code: "TURN_CANCELLED", message: "Cancel the MCP call." },
    });
    await expectFile(exitFile);
  });

  it("denies default-execute MCP tools in never mode without asking", async () => {
    const fixture = await createFixture("denied");
    const exitFile = join(fixture.root, "server-exited.txt");
    await writeMcpConfiguration(fixture, {
      command: process.execPath,
      args: [fixtureServer],
      env: ["KODA_MCP_FIXTURE_EXIT_FILE"],
    });
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("mcp-denied-call"),
            name: "mcp__fixture__environment",
            arguments: {},
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          expect(latestToolResult(request.items)).toMatchObject({
            name: "mcp__fixture__environment",
            status: "error",
            error: { code: "POLICY_DENIED" },
          });
        },
        events: [
          { type: "assistant_delta", text: "The external call was denied." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    let approvalCalls = 0;
    const application = new KodaApplication({
      environment: {
        OPENAI_API_KEY: "offline-test-key",
        KODA_HOME: fixture.kodaHome,
        KODA_MCP_FIXTURE_EXIT_FILE: exitFile,
      },
      processDirectory: fixture.root,
      dependencies: dependencies(provider, "mcp-denied"),
    });

    await expect(
      application.startTurn(
        {
          prompt: "Try the external tool.",
          cwd: fixture.workspaceRoot,
          approvalMode: "never",
        },
        {
          events: { append: async () => undefined },
          approvals: {
            request: async () => {
              approvalCalls += 1;
              return { decision: "approved" };
            },
          },
        },
      ).completion,
    ).resolves.toMatchObject({ status: "completed", exitCode: 0 });
    expect(approvalCalls).toBe(0);
    await expectFile(exitFile);
  });

  it("returns a bounded MCP timeout error to the model", async () => {
    const fixture = await createFixture("timeout");
    const exitFile = join(fixture.root, "server-exited.txt");
    await writeMcpConfiguration(fixture, {
      command: process.execPath,
      args: [fixtureServer],
      env: ["KODA_MCP_FIXTURE_EXIT_FILE"],
      tools: { hang: { effect: "read" } },
      call_timeout_ms: 100,
    });
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("mcp-timeout-call"),
            name: "mcp__fixture__hang",
            arguments: {},
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          expect(latestToolResult(request.items)).toMatchObject({
            name: "mcp__fixture__hang",
            status: "error",
            error: { code: "MCP_TOOL_TIMEOUT" },
          });
        },
        events: [
          { type: "assistant_delta", text: "The external call timed out." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const application = new KodaApplication({
      environment: {
        OPENAI_API_KEY: "offline-test-key",
        KODA_HOME: fixture.kodaHome,
        KODA_MCP_FIXTURE_EXIT_FILE: exitFile,
      },
      processDirectory: fixture.root,
      dependencies: dependencies(provider, "mcp-timeout"),
    });

    await expect(
      application.startTurn(
        { prompt: "Wait for the timeout.", cwd: fixture.workspaceRoot },
        {
          events: { append: async () => undefined },
          approvals: rejectApprovals(),
        },
      ).completion,
    ).resolves.toMatchObject({ status: "completed", exitCode: 0 });
    await expectFile(exitFile);
  });

  it("reports a stable startup failure before creating a provider", async () => {
    const fixture = await createFixture("startup-failure");
    await writeMcpConfiguration(fixture, {
      command: join(fixture.root, "missing-mcp-server"),
      startup_timeout_ms: 500,
    });
    let providerCreated = false;
    const provider = new ScriptedModelProvider([]);
    const baseDependencies = dependencies(provider, "mcp-startup-failure");
    const application = new KodaApplication({
      environment: {
        OPENAI_API_KEY: "offline-test-key",
        KODA_HOME: fixture.kodaHome,
      },
      processDirectory: fixture.root,
      dependencies: {
        ...baseDependencies,
        createProvider: () => {
          providerCreated = true;
          return provider;
        },
      },
    });

    await expect(
      application.startTurn(
        { prompt: "Start the missing server.", cwd: fixture.workspaceRoot },
        {
          events: { append: async () => undefined },
          approvals: rejectApprovals(),
        },
      ).completion,
    ).resolves.toMatchObject({
      status: "failed",
      exitCode: 1,
      error: { code: "MCP_SERVER_START_FAILED" },
    });
    expect(providerCreated).toBe(false);
  });
});

interface TestFixture {
  root: string;
  workspaceRoot: string;
  kodaHome: string;
}

async function createFixture(name: string): Promise<TestFixture> {
  const root = await mkdtemp(join(tmpdir(), `koda-mcp-${name}-`));
  temporaryDirectories.push(root);
  const workspaceRoot = join(root, "repo");
  const kodaHome = join(root, "state");
  await mkdir(workspaceRoot);
  await mkdir(kodaHome);
  return { root, workspaceRoot, kodaHome };
}

async function writeMcpConfiguration(
  fixture: TestFixture,
  server: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    join(fixture.kodaHome, "mcp.json"),
    JSON.stringify({ version: 1, servers: { fixture: server } }),
  );
}

function dependencies(
  provider: ModelProvider,
  prefix: string,
): KodaApplicationDependencies {
  return {
    openWorkspace: (root) => ReadOnlyWorkspace.open(root),
    createProvider: () => provider,
    createIds: () => ({
      threadId: threadIdSchema.parse(`${prefix}-thread`),
      turnId: turnIdSchema.parse(`${prefix}-turn`),
      itemIds: new DeterministicItemIdFactory(`${prefix}-item`),
    }),
  };
}

function latestToolResult(
  items: readonly { type: string }[],
): ToolResultItem | undefined {
  return [...items]
    .reverse()
    .find((item): item is ToolResultItem => item.type === "tool_result");
}

function rejectApprovals() {
  return {
    request: async () => ({ decision: "rejected" as const }),
  };
}

async function expectFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for fixture file '${path}'.`);
}
