import assert from "node:assert/strict";
import {
  loadMcpConfiguration,
  connectOfficialMcpClient,
  inspectMcpServerTools,
  McpTurnSession,
} from "@koda/mcp-client-node";
import { ToolRegistry } from "@koda/agent-core";
import { ArtifactStore } from "@koda/runtime-node";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [kodaHome] = process.argv.slice(2);
if (!kodaHome) throw new Error("Missing fixture directory.");

const configuration = await loadMcpConfiguration({
  environment: process.env,
  kodaHome,
  processDirectory: kodaHome,
});
const controller = new AbortController();
const connection = await connectOfficialMcpClient(
  configuration.servers[0],
  process.env,
  controller.signal,
);
try {
  const tools = await connection.listTools(controller.signal, 5_000);
  const result = await connection.callTool(
    tools[0],
    { value: "hello" },
    controller.signal,
    5_000,
  );
  const reviewed = await inspectMcpServerTools(
    {
      environment: process.env,
      kodaHome,
      processDirectory: kodaHome,
      signal: controller.signal,
    },
    "fixture",
  );
  const configPath = join(kodaHome, "mcp.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const remoteOptions = {
    environment: process.env,
    kodaHome,
    processDirectory: kodaHome,
    artifactStore: await ArtifactStore.open(join(kodaHome, "artifacts")),
    signal: controller.signal,
    serverIds: ["fixture"],
  };
  config.servers.fixture.remote_tool_digests = { echo: "0".repeat(64) };
  await writeFile(configPath, JSON.stringify(config));
  await assert.rejects(McpTurnSession.open(remoteOptions), {
    code: "MCP_TOOL_CATALOG_INVALID",
  });
  config.servers.fixture.remote_tool_digests = {
    echo: reviewed.find((tool) => tool.name === "echo")?.definitionSha256,
  };
  await writeFile(configPath, JSON.stringify(config));
  const session = await McpTurnSession.open(remoteOptions);
  const registry = new ToolRegistry();
  try {
    session.registerTools(registry);
  } finally {
    await session.close();
  }
  process.stdout.write(
    JSON.stringify({
      tools: tools.map((tool) => tool.name),
      remoteTools: registry.definitions().map((tool) => tool.name),
      result,
    }),
  );
} finally {
  await connection.close();
}
