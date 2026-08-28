import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolRegistry } from "@koda/agent-core";
import {
  McpClientError,
  McpTurnSession,
  loadMcpConfiguration,
  materializeMcpToolResult,
  type McpConnection,
  type McpConnectionFactory,
} from "@koda/mcp-client-node";
import { threadIdSchema, toolCallIdSchema, turnIdSchema } from "@koda/protocol";
import { ArtifactStore } from "@koda/runtime-node";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("MCP configuration", () => {
  it("keeps MCP disabled when the default config is absent", async () => {
    const fixture = await createFixture();

    await expect(
      loadMcpConfiguration({
        environment: {},
        kodaHome: fixture.kodaHome,
        processDirectory: fixture.root,
      }),
    ).resolves.toEqual({ servers: [] });
  });

  it("parses servers deterministically and rejects unsafe configuration", async () => {
    const fixture = await createFixture();
    await writeConfiguration(fixture, {
      version: 1,
      servers: {
        zeta: {
          command: "zeta-server",
          cwd: fixture.workspaceRoot,
          env: ["ZETA_TOKEN"],
          tools: { inspect: { effect: "read" } },
        },
        alpha: { command: "alpha-server" },
      },
    });

    const parsed = await loadMcpConfiguration({
      environment: {},
      kodaHome: fixture.kodaHome,
      processDirectory: fixture.root,
    });
    expect(parsed.servers.map((server) => server.id)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(parsed.servers[1]).toMatchObject({
      cwd: await realpath(fixture.workspaceRoot),
      environmentNames: ["ZETA_TOKEN"],
      tools: { inspect: { effect: "read" } },
      startupTimeoutMs: 15_000,
      callTimeoutMs: 60_000,
    });

    await writeConfiguration(fixture, {
      version: 1,
      servers: { unsafe: { command: "server", cwd: "relative/path" } },
    });
    await expect(
      loadMcpConfiguration({
        environment: {},
        kodaHome: fixture.kodaHome,
        processDirectory: fixture.root,
      }),
    ).rejects.toMatchObject({ code: "MCP_CONFIGURATION_INVALID" });
  });

  it("fails when an explicitly selected config is missing", async () => {
    const fixture = await createFixture();
    await expect(
      loadMcpConfiguration({
        environment: { KODA_MCP_CONFIG: "missing.json" },
        kodaHome: fixture.kodaHome,
        processDirectory: fixture.root,
      }),
    ).rejects.toMatchObject({ code: "MCP_CONFIGURATION_INVALID" });
  });

  it.each([
    [
      "unsafe server id",
      { version: 1, servers: { "BAD ID": { command: "x" } } },
    ],
    [
      "duplicate environment names",
      {
        version: 1,
        servers: { fixture: { command: "x", env: ["TOKEN", "TOKEN"] } },
      },
    ],
    [
      "unknown fields",
      { version: 1, servers: { fixture: { command: "x", shell: true } } },
    ],
  ])("rejects %s", async (_case, configuration) => {
    const fixture = await createFixture();
    await writeConfiguration(fixture, configuration);

    await expect(
      loadMcpConfiguration({
        environment: {},
        kodaHome: fixture.kodaHome,
        processDirectory: fixture.root,
      }),
    ).rejects.toMatchObject({ code: "MCP_CONFIGURATION_INVALID" });
  });
});

describe("McpTurnSession", () => {
  it("registers stable aliases with fail-closed effects and bounded results", async () => {
    const fixture = await createFixture();
    await writeConfiguration(fixture, {
      version: 1,
      servers: {
        fixture: {
          command: "fixture-server",
          tools: { read_value: { effect: "read" } },
        },
      },
    });
    const calls: Array<{ name: string; arguments: unknown }> = [];
    const connection = fakeConnection("fixture", {
      definitions: [
        tool("read_value"),
        tool("external_action"),
        tool("large_output"),
      ],
      call: async (definition, arguments_) => {
        const name = definition.name;
        calls.push({ name, arguments: arguments_ });
        return name === "large_output"
          ? {
              content: [{ type: "text", text: "x".repeat(70_000) }],
            }
          : {
              content: [{ type: "text", text: "ok" }],
              structuredContent: { name },
            };
      },
    });
    const session = await openSession(fixture, async () => connection);
    const registry = new ToolRegistry();
    session.registerTools(registry);

    expect(registry.definitions().map((definition) => definition.name)).toEqual(
      [
        "mcp__fixture__external_action",
        "mcp__fixture__large_output",
        "mcp__fixture__read_value",
      ],
    );
    const read = await prepare(registry, "mcp__fixture__read_value", {
      value: "read",
    });
    expect(read.effect).toBe("read");
    const external = await prepare(registry, "mcp__fixture__external_action", {
      value: "write",
    });
    expect(external.effect).toBe("execute");
    expect(external.approval).toMatchObject({
      title: "Call MCP tool fixture/external_action",
      summary: "Invoke external MCP tool 'mcp__fixture__external_action'.",
    });
    await expect(external.execute()).resolves.toMatchObject({
      status: "success",
      output: { structured_content: { name: "external_action" } },
    });

    const large = await prepare(registry, "mcp__fixture__large_output", {});
    await expect(large.execute()).resolves.toMatchObject({
      status: "success",
      output: {
        content_truncated: true,
        content_artifact: { type: "artifact", mediaType: "application/json" },
      },
    });
    expect(calls).toContainEqual({
      name: "external_action",
      arguments: { value: "write" },
    });
    await session.close();
    await session.close();
  });

  it("converts MCP tool errors and binary content safely", async () => {
    const fixture = await createFixture();
    const store = await ArtifactStore.open(join(fixture.kodaHome, "artifacts"));

    await expect(
      materializeMcpToolResult(
        {
          isError: true,
          content: [{ type: "text", text: "remote failure" }],
        },
        store,
      ),
    ).rejects.toMatchObject({ code: "MCP_TOOL_ERROR" });
    await expect(
      materializeMcpToolResult(
        {
          content: [
            {
              type: "image",
              data: Buffer.from("image-bytes").toString("base64"),
              mimeType: "image/png",
            },
          ],
        },
        store,
      ),
    ).resolves.toMatchObject({
      content: [
        {
          type: "image",
          data_bytes: 11,
          data_omitted: true,
          mime_type: "image/png",
        },
      ],
    });
  });

  it("rolls back connected servers and closes successful sessions in reverse order", async () => {
    const fixture = await createFixture();
    await writeConfiguration(fixture, {
      version: 1,
      servers: {
        alpha: { command: "alpha" },
        beta: { command: "beta" },
      },
    });
    const closed: string[] = [];
    const failingFactory: McpConnectionFactory = async (configuration) => {
      if (configuration.id === "beta") {
        throw new McpClientError("MCP_SERVER_START_FAILED", "beta failed");
      }
      return fakeConnection(configuration.id, { closed });
    };

    await expect(openSession(fixture, failingFactory)).rejects.toMatchObject({
      code: "MCP_SERVER_START_FAILED",
    });
    expect(closed).toEqual(["alpha"]);

    closed.length = 0;
    const session = await openSession(fixture, async (configuration) =>
      fakeConnection(configuration.id, { closed }),
    );
    await session.close();
    expect(closed).toEqual(["beta", "alpha"]);
  });

  it("rejects stale read classifications and alias collisions before model use", async () => {
    const fixture = await createFixture();
    await writeConfiguration(fixture, {
      version: 1,
      servers: {
        fixture: {
          command: "fixture",
          tools: { missing_tool: { effect: "read" } },
        },
      },
    });
    await expect(
      openSession(fixture, async () =>
        fakeConnection("fixture", { definitions: [tool("present")] }),
      ),
    ).rejects.toMatchObject({ code: "MCP_TOOL_CATALOG_INVALID" });
  });

  it("rejects duplicate, malformed, and oversized tool catalogs", async () => {
    const fixture = await createFixture();
    await writeConfiguration(fixture, {
      version: 1,
      servers: { fixture: { command: "fixture" } },
    });

    await expect(
      openSession(fixture, async () =>
        fakeConnection("fixture", {
          definitions: [tool("duplicate"), tool("duplicate")],
        }),
      ),
    ).rejects.toMatchObject({ code: "MCP_TOOL_CATALOG_INVALID" });
    await expect(
      openSession(fixture, async () =>
        fakeConnection("fixture", {
          definitions: [
            {
              name: "invalid_schema",
              inputSchema: { type: "string" as "object" },
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "MCP_TOOL_CATALOG_INVALID" });
    await expect(
      openSession(fixture, async () =>
        fakeConnection("fixture", {
          definitions: Array.from({ length: 257 }, (_, index) =>
            tool(`tool_${index}`),
          ),
        }),
      ),
    ).rejects.toMatchObject({ code: "MCP_TOOL_CATALOG_INVALID" });
  });

  it("refreshes complete catalogs atomically and preserves prepared generation bindings", async () => {
    const fixture = await createFixture();
    await writeConfiguration(fixture, {
      version: 1,
      servers: { fixture: { command: "fixture" } },
    });
    let definitions = [tool("value", "version one")];
    const calledDescriptions: string[] = [];
    const connection: McpConnection = {
      serverId: "fixture",
      listTools: async () => definitions,
      callTool: async (definition) => {
        calledDescriptions.push(definition.description ?? "");
        return { content: [{ type: "text", text: "ok" }] };
      },
      close: async () => undefined,
    };
    const session = await openSession(fixture, async () => connection);
    const registry = new ToolRegistry();
    session.registerTools(registry);
    const oldInvocation = await prepare(registry, "mcp__fixture__value", {});
    const before = registry.catalogGeneration();
    definitions[0]!.description = "mutated after discovery";

    definitions = [tool("added"), tool("value", "version two")];
    const replacement = await session.refreshTools(
      2,
      new AbortController().signal,
    );

    expect(replacement).toMatchObject({
      previous: before,
      current: registry.catalogGeneration(),
      changes: [
        expect.objectContaining({
          name: "mcp__fixture__added",
          change: "added",
        }),
        expect.objectContaining({
          name: "mcp__fixture__value",
          change: "changed",
        }),
      ],
    });
    expect(registry.definitions().map((definition) => definition.name)).toEqual(
      ["mcp__fixture__added", "mcp__fixture__value"],
    );
    const newInvocation = await prepare(registry, "mcp__fixture__value", {});
    await oldInvocation.execute();
    await newInvocation.execute();
    expect(calledDescriptions).toEqual(["version one", "version two"]);
    await session.close();
  });

  it("keeps the installed generation when refresh validation fails", async () => {
    const fixture = await createFixture();
    await writeConfiguration(fixture, {
      version: 1,
      servers: { fixture: { command: "fixture" } },
    });
    let definitions = [tool("stable")];
    const connection = fakeConnection("fixture", {
      definitions: () => definitions,
    });
    const session = await openSession(fixture, async () => connection);
    const registry = new ToolRegistry();
    session.registerTools(registry);
    const before = registry.catalogGeneration();

    definitions = [tool("duplicate"), tool("duplicate")];
    await expect(
      session.refreshTools(2, new AbortController().signal),
    ).rejects.toMatchObject({ code: "MCP_TOOL_CATALOG_INVALID" });
    expect(registry.catalogGeneration()).toEqual(before);
    expect(registry.definitions().map((definition) => definition.name)).toEqual(
      ["mcp__fixture__stable"],
    );
    await session.close();
  });
});

async function createFixture(): Promise<TestFixture> {
  const root = await mkdtemp(join(tmpdir(), "koda-mcp-client-"));
  temporaryDirectories.push(root);
  const workspaceRoot = join(root, "workspace");
  const kodaHome = join(root, "state");
  await mkdir(workspaceRoot);
  await mkdir(kodaHome);
  return { root, workspaceRoot, kodaHome };
}

interface TestFixture {
  root: string;
  workspaceRoot: string;
  kodaHome: string;
}

async function writeConfiguration(
  fixture: TestFixture,
  configuration: unknown,
): Promise<void> {
  await writeFile(
    join(fixture.kodaHome, "mcp.json"),
    JSON.stringify(configuration),
  );
}

async function openSession(
  fixture: TestFixture,
  connectionFactory: McpConnectionFactory,
): Promise<McpTurnSession> {
  return McpTurnSession.open({
    environment: {},
    kodaHome: fixture.kodaHome,
    processDirectory: fixture.root,
    artifactStore: await ArtifactStore.open(
      join(fixture.kodaHome, "artifacts"),
    ),
    signal: new AbortController().signal,
    connectionFactory,
  });
}

function fakeConnection(
  serverId: string,
  options: {
    definitions?:
      | Awaited<ReturnType<McpConnection["listTools"]>>
      | (() => Awaited<ReturnType<McpConnection["listTools"]>>);
    call?: McpConnection["callTool"];
    closed?: string[];
  } = {},
): McpConnection {
  return {
    serverId,
    listTools: async () =>
      typeof options.definitions === "function"
        ? options.definitions()
        : (options.definitions ?? []),
    callTool:
      options.call ??
      (async () => ({ content: [{ type: "text", text: "ok" }] })),
    close: async () => void options.closed?.push(serverId),
  };
}

function tool(name: string, description = `Fixture tool ${name}`) {
  return {
    name,
    description,
    inputSchema: {
      type: "object" as const,
      properties: { value: { type: "string" } },
      additionalProperties: false,
    },
  };
}

async function prepare(
  registry: ToolRegistry,
  name: string,
  arguments_: Record<string, string>,
) {
  const prepared = await registry.prepare(
    {
      callId: toolCallIdSchema.parse(`call-${name}`),
      name,
      arguments: arguments_,
    },
    {
      threadId: threadIdSchema.parse("mcp-thread"),
      turnId: turnIdSchema.parse("mcp-turn"),
      signal: new AbortController().signal,
    },
  );
  if (prepared.status !== "ready") {
    throw new Error(
      `MCP tool was not ready: ${JSON.stringify(prepared.result)}`,
    );
  }
  return prepared.invocation;
}
