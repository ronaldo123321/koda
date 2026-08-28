import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolRegistry } from "@koda/agent-core";
import {
  PluginHostError,
  PluginTurnSession,
  diffPluginSnapshots,
  loadPluginConfiguration,
  type PluginConfiguration,
  type PluginConnection,
  type PluginInitializeResult,
} from "@koda/plugin-host-node";
import { threadIdSchema, toolCallIdSchema, turnIdSchema } from "@koda/protocol";
import {
  ArtifactStore,
  ProjectCommandTemplateCatalog,
  ProjectSkillCatalog,
} from "@koda/runtime-node";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("plugin configuration", () => {
  it("keeps plugins disabled when the default config is absent", async () => {
    const fixture = await createFixture();
    await expect(
      loadPluginConfiguration({
        environment: {},
        kodaHome: fixture.kodaHome,
        processDirectory: fixture.root,
      }),
    ).resolves.toEqual({ plugins: [] });
  });

  it("parses manifests deterministically and rejects authority mismatches", async () => {
    const fixture = await createFixture();
    await writeConfiguration(fixture, {
      version: 1,
      plugins: {
        zeta: {
          command: "zeta",
          capabilities: ["tools", "skills"],
          tools: { inspect: { effect: "read" } },
        },
        alpha: {
          command: "alpha",
          required: false,
          capabilities: ["command_templates"],
        },
      },
    });
    const configuration = await loadPluginConfiguration({
      environment: {},
      kodaHome: fixture.kodaHome,
      processDirectory: fixture.root,
    });
    expect(configuration.plugins.map((plugin) => plugin.id)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(configuration.plugins[1]).toMatchObject({
      required: true,
      capabilities: ["skills", "tools"],
      tools: { inspect: { effect: "read" } },
    });

    await writeConfiguration(fixture, {
      version: 1,
      plugins: {
        invalid: {
          command: "invalid",
          capabilities: ["skills"],
          tools: { inspect: { effect: "read" } },
        },
      },
    });
    await expect(
      loadPluginConfiguration({
        environment: {},
        kodaHome: fixture.kodaHome,
        processDirectory: fixture.root,
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_CONFIGURATION_INVALID" });
  });
});

describe("PluginTurnSession", () => {
  it("freezes validated contributions and routes tools through Koda policy metadata", async () => {
    const fixture = await createFixture();
    await writeConfiguration(fixture, {
      version: 1,
      plugins: {
        fixture: {
          command: "fixture",
          capabilities: ["tools", "skills", "command_templates"],
          tools: { inspect: { effect: "read" } },
        },
      },
    });
    const calls: Array<{
      name: string;
      definitionSha256: string;
    }> = [];
    const connection = fakeConnection("fixture", {
      initialized: initializeResult({
        tools: [tool("inspect"), tool("act")],
        skills: [{ name: "helper", content: skill("helper") }],
        command_templates: [{ name: "greet", content: template("greet") }],
      }),
      call: async (name, _arguments, definitionSha256) => {
        calls.push({ name, definitionSha256 });
        return { name };
      },
    });
    const session = await openSession(fixture, async () => connection);

    expect(session.snapshots).toEqual([
      expect.objectContaining({
        pluginId: "fixture",
        status: "active",
        toolCount: 2,
        skillCount: 1,
        commandTemplateCount: 1,
      }),
    ]);
    expect(session.skills.sources.at(-1)).toMatchObject({
      name: "helper",
      scope: "@plugin/fixture",
      path: "@plugin/fixture/skills/helper/SKILL.md",
    });
    expect(session.commandTemplates.sources.at(-1)).toMatchObject({
      selector: "@plugin/fixture/greet",
    });

    const registry = new ToolRegistry();
    session.registerTools(registry);
    const inspect = await prepare(registry, "plugin__fixture__inspect");
    const act = await prepare(registry, "plugin__fixture__act");
    expect(inspect.effect).toBe("read");
    expect(act.effect).toBe("execute");
    await expect(inspect.execute()).resolves.toMatchObject({
      status: "success",
      output: { name: "inspect" },
    });
    expect(calls[0]?.definitionSha256).toMatch(/^[a-f0-9]{64}$/u);
    await session.close();
  });

  it("isolates optional failures but rolls back every active child for a required failure", async () => {
    const fixture = await createFixture();
    await writeConfiguration(fixture, {
      version: 1,
      plugins: {
        alpha: {
          command: "alpha",
          capabilities: ["tools"],
        },
        beta: {
          command: "beta",
          required: false,
          capabilities: ["tools"],
          tools: { missing: { effect: "read" } },
        },
        charlie: {
          command: "charlie",
          capabilities: ["tools"],
        },
      },
    });
    const closed: string[] = [];
    const connections = new Map<string, PluginConnection>([
      [
        "alpha",
        fakeConnection("alpha", {
          initialized: initializeResult({ tools: [tool("value")] }),
          closed,
        }),
      ],
      [
        "beta",
        fakeConnection("beta", {
          initialized: initializeResult({ tools: [tool("other")] }),
          closed,
        }),
      ],
      [
        "charlie",
        fakeConnection("charlie", {
          initializeError: new PluginHostError(
            "PLUGIN_PROTOCOL_INVALID",
            "invalid handshake",
          ),
          closed,
        }),
      ],
    ]);

    await expect(
      openSession(fixture, async (configuration) =>
        requiredConnection(connections, configuration),
      ),
    ).rejects.toMatchObject({ code: "PLUGIN_PROTOCOL_INVALID" });
    expect(closed).toEqual(["beta", "charlie", "alpha"]);

    await writeConfiguration(fixture, {
      version: 1,
      plugins: {
        optional: {
          command: "optional",
          required: false,
          capabilities: ["tools"],
          tools: { missing: { effect: "read" } },
        },
      },
    });
    const optional = await openSession(fixture, async () =>
      fakeConnection("optional", {
        initialized: initializeResult({ tools: [tool("other")] }),
      }),
    );
    expect(optional.snapshots).toEqual([
      expect.objectContaining({
        pluginId: "optional",
        status: "disabled",
        errorCode: "PLUGIN_CONTRIBUTION_INVALID",
      }),
    ]);
    expect(optional.diagnostics[0]?.message).not.toContain("stderr");
    await optional.close();
  });

  it("reports deterministic plugin snapshot changes", async () => {
    const active = {
      pluginId: "fixture",
      status: "active" as const,
      required: true,
      manifestSha256: "1".repeat(64),
      name: "Fixture",
      version: "1.0.0",
      capabilities: ["tools" as const],
      toolCount: 1,
      skillCount: 0,
      commandTemplateCount: 0,
      contributionsSha256: "2".repeat(64),
    };
    expect(
      diffPluginSnapshots(
        [active],
        [
          { ...active, version: "2.0.0" },
          {
            pluginId: "optional",
            status: "disabled",
            required: false,
            manifestSha256: "3".repeat(64),
            errorCode: "PLUGIN_SERVER_START_FAILED",
          },
        ],
      ),
    ).toEqual([
      { pluginId: "fixture", change: "changed" },
      { pluginId: "optional", change: "added" },
    ]);
  });
});

interface Fixture {
  root: string;
  kodaHome: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "koda-plugin-test-"));
  temporaryDirectories.push(root);
  const kodaHome = join(root, "home");
  await mkdir(kodaHome, { recursive: true });
  return { root, kodaHome };
}

async function writeConfiguration(
  fixture: Fixture,
  configuration: unknown,
): Promise<void> {
  await writeFile(
    join(fixture.kodaHome, "plugins.json"),
    JSON.stringify(configuration),
  );
}

async function openSession(
  fixture: Fixture,
  connectionFactory: (
    configuration: PluginConfiguration,
  ) => Promise<PluginConnection>,
): Promise<PluginTurnSession> {
  return PluginTurnSession.open({
    environment: {},
    kodaHome: fixture.kodaHome,
    processDirectory: fixture.root,
    artifactStore: await ArtifactStore.open(join(fixture.root, "artifacts")),
    projectSkills: new ProjectSkillCatalog([]),
    projectCommandTemplates: new ProjectCommandTemplateCatalog([]),
    signal: new AbortController().signal,
    connectionFactory,
  });
}

function fakeConnection(
  pluginId: string,
  options: {
    initialized?: PluginInitializeResult;
    initializeError?: unknown;
    call?: PluginConnection["callTool"];
    closed?: string[];
  },
): PluginConnection {
  return {
    pluginId,
    initialize: async () => {
      if (options.initializeError !== undefined) {
        throw options.initializeError;
      }
      return options.initialized ?? initializeResult({});
    },
    callTool: options.call ?? (async () => ({ ok: true })),
    close: async () => void options.closed?.push(pluginId),
  };
}

function requiredConnection(
  connections: ReadonlyMap<string, PluginConnection>,
  configuration: PluginConfiguration,
): PluginConnection {
  const connection = connections.get(configuration.id);
  if (connection === undefined) {
    throw new Error(`Missing connection for ${configuration.id}`);
  }
  return connection;
}

function initializeResult(
  contributions: PluginInitializeResult["contributions"],
): PluginInitializeResult {
  return {
    protocolVersion: 1,
    plugin: { name: "Fixture plugin", version: "1.0.0" },
    contributions,
  };
}

function tool(name: string) {
  return {
    name,
    description: `Fixture tool ${name}`,
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  };
}

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: Fixture plugin Skill.\n---\nUse the fixture plugin carefully.\n`;
}

function template(name: string): string {
  return `---\nname: ${name}\ndescription: Greet one target.\nparameters: [{"name":"target","description":"Target name.","type":"string","required":true,"max_bytes":128}]\n---\nHello {{target}}.\n`;
}

async function prepare(registry: ToolRegistry, name: string) {
  const result = await registry.prepare(
    {
      callId: toolCallIdSchema.parse(`call-${name}`),
      name,
      arguments: {},
    },
    {
      threadId: threadIdSchema.parse("plugin-thread"),
      turnId: turnIdSchema.parse("plugin-turn"),
      signal: new AbortController().signal,
    },
  );
  if (result.status !== "ready") {
    throw new Error(JSON.stringify(result.result));
  }
  return result.invocation;
}
