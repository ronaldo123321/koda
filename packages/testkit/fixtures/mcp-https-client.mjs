import {
  loadMcpConfiguration,
  connectOfficialMcpClient,
} from "@koda/mcp-client-node";

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
  process.stdout.write(
    JSON.stringify({ tools: tools.map((tool) => tool.name), result }),
  );
} finally {
  await connection.close();
}
