import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { KodaApplication, type TurnClient } from "@koda/app";
import {
  threadIdSchema,
  skillIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type AgentEvent,
  type ToolResultItem,
} from "@koda/protocol";
import { ScriptedModelProvider } from "@koda/providers";
import { ReadOnlyWorkspace } from "@koda/runtime-node";
import { afterEach, describe, expect, it } from "vitest";

import { DeterministicItemIdFactory } from "./deterministic.js";

const pluginServer = fileURLToPath(
  new URL("../fixtures/plugin-server.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("KodaApplication plugin integration", () => {
  it("uses isolated tools, Skills, templates, durable snapshots, and resume changes", async () => {
    const fixture = await createFixture();
    const exitFile = join(fixture.root, "plugin-exited.txt");
    await writePluginConfiguration(fixture, exitFile, "1.0.0");
    const threadId = threadIdSchema.parse("plugin-application-thread");
    let turnCursor = 0;
    const pluginSkillId = skillIdSchema.parse(
      `skill:${createHash("sha256")
        .update(
          "@plugin/fixture/skills/plugin-helper/SKILL.md\0@plugin/fixture\0plugin-helper",
        )
        .digest("hex")}`,
    );
    const provider = new ScriptedModelProvider([
      {
        assertRequest: (request) => {
          expect(request.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining([
              "plugin__fixture__echo",
              "plugin__fixture__environment",
              "read_skill",
            ]),
          );
          expect(
            request.items.find((item) => item.type === "user_message"),
          ).toMatchObject({
            content: expect.stringContaining(
              "[Koda command template: @plugin/fixture/plugin-greet; source sha256",
            ),
          });
          expect(JSON.stringify(request.items)).toContain(
            "Hello Koda from the plugin.",
          );
        },
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("plugin-application-echo"),
            name: "plugin__fixture__echo",
            arguments: { value: "hello" },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          expect(latestToolResult(request.items)).toMatchObject({
            name: "plugin__fixture__echo",
            status: "success",
            output: {
              echoed: "hello",
              allowed_secret: "allowed-secret",
              forbidden_present: false,
              definition_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            },
          });
          expect(pluginSkillId).toMatch(/^skill:/u);
        },
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("plugin-application-skill"),
            name: "read_skill",
            arguments: { skill_id: pluginSkillId },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          expect(latestToolResult(request.items)).toMatchObject({
            name: "read_skill",
            status: "success",
            output: {
              name: "plugin-helper",
              content: expect.stringContaining(
                "Use plugin tools through normal Koda policy.",
              ),
            },
          });
        },
        events: [
          { type: "assistant_delta", text: "Plugin contributions completed." },
          { type: "completed", finishReason: "stop" },
        ],
      },
      {
        assertRequest: (request) => {
          expect(request.items).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "recovery",
                pluginChanges: [{ pluginId: "fixture", change: "changed" }],
              }),
            ]),
          );
        },
        events: [
          { type: "assistant_delta", text: "Plugin change audited." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const observed: AgentEvent[] = [];
    const diagnostics: string[] = [];
    let approvals = 0;
    const providerInstructions: string[] = [];
    const application = new KodaApplication({
      environment: {
        OPENAI_API_KEY: "offline-test-key",
        KODA_HOME: fixture.kodaHome,
        KODA_PLUGIN_ALLOWED: "allowed-secret",
        KODA_PLUGIN_FORBIDDEN: "must-not-leak",
        KODA_PLUGIN_EXIT_FILE: exitFile,
      },
      processDirectory: fixture.root,
      dependencies: {
        openWorkspace: (root) => ReadOnlyWorkspace.open(root),
        createProvider: (_configuration, instructions) => {
          providerInstructions.push(instructions);
          return provider;
        },
        createIds: (resumeThreadId) => {
          turnCursor += 1;
          return {
            threadId: resumeThreadId ?? threadId,
            turnId: turnIdSchema.parse(`plugin-application-turn-${turnCursor}`),
            itemIds: new DeterministicItemIdFactory(
              `plugin-application-item-${turnCursor}`,
            ),
          };
        },
      },
    });
    const client: TurnClient = {
      events: {
        append: async (event) => {
          observed.push(event);
        },
      },
      approvals: {
        request: async (request) => {
          approvals += 1;
          expect(request.name).toBe("plugin__fixture__echo");
          expect(request.title).toBe("Call plugin tool fixture/echo");
          return { decision: "approved" };
        },
      },
      diagnostic: (diagnostic) => void diagnostics.push(diagnostic.message),
    };

    await expect(
      application.startTurn(
        {
          prompt: '/template @plugin/fixture/plugin-greet {"target":"Koda"}',
          cwd: fixture.workspaceRoot,
        },
        client,
      ).completion,
    ).resolves.toMatchObject({ status: "completed", exitCode: 0 });

    expect(approvals).toBe(1);
    expect(diagnostics).toEqual([]);
    expect(providerInstructions[0]).toContain("plugin-helper");
    expect(providerInstructions[0]).not.toContain(
      "Use plugin tools through normal Koda policy.",
    );
    expect(observed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "turn.context",
          payload: expect.objectContaining({
            plugins: [
              expect.objectContaining({
                pluginId: "fixture",
                status: "active",
                version: "1.0.0",
              }),
            ],
            skills: expect.arrayContaining([
              expect.objectContaining({
                path: "@plugin/fixture/skills/plugin-helper/SKILL.md",
              }),
            ]),
            commandTemplates: expect.arrayContaining([
              expect.objectContaining({
                selector: "@plugin/fixture/plugin-greet",
              }),
            ]),
          }),
        }),
      ]),
    );

    await writePluginConfiguration(fixture, exitFile, "2.0.0");
    await expect(
      application.startTurn(
        {
          prompt: "Inspect the changed plugin snapshot.",
          cwd: fixture.workspaceRoot,
          resume: threadId,
        },
        client,
      ).completion,
    ).resolves.toMatchObject({ status: "completed", exitCode: 0 });

    await expectFile(exitFile);
    expect((await readFile(exitFile, "utf8")).trim().split("\n")).toHaveLength(
      2,
    );
  });

  it("isolates an optional hostile plugin without exposing stderr content", async () => {
    const fixture = await createFixture();
    const exitFile = join(fixture.root, "optional-plugin-exited.txt");
    await writePluginConfiguration(fixture, exitFile, "1.0.0", {
      required: false,
      mode: "hostile-init",
    });
    const provider = new ScriptedModelProvider([
      {
        assertRequest: (request) => {
          expect(
            request.tools.some((tool) => tool.name.startsWith("plugin__")),
          ).toBe(false);
        },
        events: [
          { type: "assistant_delta", text: "Optional plugin isolated." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const observed: AgentEvent[] = [];
    const diagnostics: string[] = [];
    const application = simpleApplication(fixture, provider, exitFile);

    await expect(
      application.startTurn(
        {
          prompt: "Continue without the optional plugin.",
          cwd: fixture.workspaceRoot,
        },
        {
          events: { append: async (event) => void observed.push(event) },
          approvals: rejectApprovals(),
          diagnostic: (diagnostic) => void diagnostics.push(diagnostic.message),
        },
      ).completion,
    ).resolves.toMatchObject({ status: "completed", exitCode: 0 });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("Optional plugin 'fixture' was disabled");
    expect(diagnostics[0]).not.toContain("allowed-secret");
    expect(observed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "turn.context",
          payload: expect.objectContaining({
            plugins: [
              expect.objectContaining({
                pluginId: "fixture",
                status: "disabled",
                errorCode: "PLUGIN_PROTOCOL_INVALID",
              }),
            ],
          }),
        }),
      ]),
    );
    await expectFile(exitFile);
  });

  it("fails before Provider construction when a required plugin is hostile", async () => {
    const fixture = await createFixture();
    const exitFile = join(fixture.root, "required-plugin-exited.txt");
    await writePluginConfiguration(fixture, exitFile, "1.0.0", {
      mode: "hostile-init",
    });
    let providerCreated = false;
    const application = new KodaApplication({
      environment: pluginEnvironment(fixture, exitFile),
      processDirectory: fixture.root,
      dependencies: {
        openWorkspace: (root) => ReadOnlyWorkspace.open(root),
        createProvider: () => {
          providerCreated = true;
          return new ScriptedModelProvider([]);
        },
        createIds: () => ({
          threadId: threadIdSchema.parse("required-plugin-thread"),
          turnId: turnIdSchema.parse("required-plugin-turn"),
          itemIds: new DeterministicItemIdFactory("required-plugin-item"),
        }),
      },
    });

    await expect(
      application.startTurn(
        { prompt: "Do not start the Provider.", cwd: fixture.workspaceRoot },
        {
          events: { append: async () => undefined },
          approvals: rejectApprovals(),
        },
      ).completion,
    ).resolves.toMatchObject({
      status: "failed",
      exitCode: 1,
      error: { code: "PLUGIN_PROTOCOL_INVALID" },
    });
    expect(providerCreated).toBe(false);
    await expectFile(exitFile);
  });

  it("validates resume history before starting any configured plugin", async () => {
    const fixture = await createFixture();
    const exitFile = join(fixture.root, "resume-preflight-plugin-exited.txt");
    await writePluginConfiguration(fixture, exitFile, "1.0.0");
    let providerCreated = false;
    const application = new KodaApplication({
      environment: pluginEnvironment(fixture, exitFile),
      processDirectory: fixture.root,
      dependencies: {
        openWorkspace: (root) => ReadOnlyWorkspace.open(root),
        createProvider: () => {
          providerCreated = true;
          return new ScriptedModelProvider([]);
        },
        createIds: (resumeThreadId) => ({
          threadId:
            resumeThreadId ?? threadIdSchema.parse("resume-preflight-thread"),
          turnId: turnIdSchema.parse("resume-preflight-turn"),
          itemIds: new DeterministicItemIdFactory("resume-preflight-item"),
        }),
      },
    });

    await expect(
      application.startTurn(
        {
          prompt: "Reject the missing history.",
          cwd: fixture.workspaceRoot,
          resume: threadIdSchema.parse("missing-plugin-thread"),
        },
        {
          events: { append: async () => undefined },
          approvals: rejectApprovals(),
        },
      ).completion,
    ).resolves.toMatchObject({
      status: "failed",
      exitCode: 1,
      error: { code: "THREAD_NOT_FOUND" },
    });
    expect(providerCreated).toBe(false);
    await expect(access(exitFile)).rejects.toBeDefined();
  });
});

interface Fixture {
  root: string;
  workspaceRoot: string;
  kodaHome: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "koda-plugin-application-"));
  temporaryDirectories.push(root);
  const workspaceRoot = join(root, "repo");
  const kodaHome = join(root, "state");
  await mkdir(workspaceRoot);
  await mkdir(kodaHome);
  return { root, workspaceRoot, kodaHome };
}

async function writePluginConfiguration(
  fixture: Fixture,
  exitFile: string,
  version: string,
  options: { required?: boolean; mode?: string } = {},
): Promise<void> {
  await writeFile(
    join(fixture.kodaHome, "plugins.json"),
    JSON.stringify({
      version: 1,
      plugins: {
        fixture: {
          command: process.execPath,
          args: [
            pluginServer,
            `--version=${version}`,
            ...(options.mode === undefined ? [] : [`--mode=${options.mode}`]),
          ],
          env: ["KODA_PLUGIN_ALLOWED", "KODA_PLUGIN_EXIT_FILE"],
          ...(options.required === undefined
            ? {}
            : { required: options.required }),
          capabilities: ["tools", "skills", "command_templates"],
          tools: { environment: { effect: "read" } },
        },
      },
    }),
  );
}

function simpleApplication(
  fixture: Fixture,
  provider: ScriptedModelProvider,
  exitFile: string,
): KodaApplication {
  return new KodaApplication({
    environment: pluginEnvironment(fixture, exitFile),
    processDirectory: fixture.root,
    dependencies: {
      openWorkspace: (root) => ReadOnlyWorkspace.open(root),
      createProvider: () => provider,
      createIds: () => ({
        threadId: threadIdSchema.parse("optional-plugin-thread"),
        turnId: turnIdSchema.parse("optional-plugin-turn"),
        itemIds: new DeterministicItemIdFactory("optional-plugin-item"),
      }),
    },
  });
}

function pluginEnvironment(
  fixture: Fixture,
  exitFile: string,
): NodeJS.ProcessEnv {
  return {
    OPENAI_API_KEY: "offline-test-key",
    KODA_HOME: fixture.kodaHome,
    KODA_PLUGIN_ALLOWED: "allowed-secret",
    KODA_PLUGIN_FORBIDDEN: "must-not-leak",
    KODA_PLUGIN_EXIT_FILE: exitFile,
  };
}

function rejectApprovals() {
  return { request: async () => ({ decision: "rejected" as const }) };
}

function latestToolResult(
  items: readonly { type: string }[],
): ToolResultItem | undefined {
  return [...items]
    .reverse()
    .find((item): item is ToolResultItem => item.type === "tool_result");
}

async function expectFile(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (true) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${path}`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
  }
}
