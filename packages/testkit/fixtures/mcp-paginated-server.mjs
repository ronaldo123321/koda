import { writeFileSync } from "node:fs";

import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const exitFile = process.env.KODA_MCP_FIXTURE_EXIT_FILE;
if (exitFile) {
  process.once("exit", () => {
    writeFileSync(exitFile, "closed\n");
  });
}

const server = new Server(
  { name: "koda-test-paginated-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler("tools/list", (request) => {
  if (request.params?.cursor === "second-page") {
    return {
      tools: [definition("page_two")],
    };
  }
  return {
    tools: [definition("page_one")],
    nextCursor: "second-page",
  };
});

server.setRequestHandler("tools/call", (request) => ({
  content: [{ type: "text", text: request.params.name }],
}));

await server.connect(new StdioServerTransport());

function definition(name) {
  return {
    name,
    description: `Paginated fixture tool ${name}.`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
}
