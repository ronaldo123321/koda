import { writeFileSync } from "node:fs";

import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const exitFile = process.env.KODA_MCP_FIXTURE_EXIT_FILE;
if (exitFile) {
  process.once("exit", () => {
    writeFileSync(exitFile, "closed\n");
  });
}

let generation = 1;
const server = new Server(
  { name: "koda-test-dynamic-mcp-server", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } },
);

server.setRequestHandler("tools/list", () => ({
  tools:
    generation === 1
      ? [
          definition("advance", "Advance the fixture catalog."),
          definition("old", "Old fixture tool."),
        ]
      : [
          definition("advance", "Catalog already advanced."),
          definition("next", "New fixture tool."),
        ],
}));

server.setRequestHandler("tools/call", (request) => {
  if (request.params.name === "advance") {
    generation = 2;
    return {
      content: [{ type: "text", text: "advanced" }],
      structuredContent: { generation },
    };
  }
  if (request.params.name === "next" && generation === 2) {
    return {
      content: [{ type: "text", text: "next" }],
      structuredContent: { tool: "next", generation },
    };
  }
  if (request.params.name === "old" && generation === 1) {
    return { content: [{ type: "text", text: "old" }] };
  }
  throw new Error(`Tool '${request.params.name}' is unavailable.`);
});

await server.connect(new StdioServerTransport());

function definition(name, description) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
}
