import { writeFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const exitFile = process.env.KODA_MCP_FIXTURE_EXIT_FILE;
if (exitFile) {
  process.once("exit", () => {
    writeFileSync(exitFile, "closed\n");
  });
}

serveStdio(() => {
  const server = new McpServer({
    name: "koda-test-mcp-server",
    version: "1.0.0",
  });

  server.registerTool(
    "echo",
    {
      description: "Echo a value from the test MCP server.",
      inputSchema: z.object({ value: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ value }) => ({
      content: [{ type: "text", text: value }],
      structuredContent: { echoed: value },
    }),
  );

  server.registerTool(
    "environment",
    {
      description: "Report fixture environment isolation.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            secret: process.env.KODA_MCP_FIXTURE_SECRET ?? null,
            forbiddenPresent:
              process.env.KODA_MCP_FIXTURE_FORBIDDEN !== undefined,
          }),
        },
      ],
    }),
  );

  server.registerTool(
    "fail",
    {
      description: "Return an MCP tool-level error.",
      inputSchema: z.object({}),
    },
    async () => ({
      isError: true,
      content: [{ type: "text", text: "fixture tool failed" }],
    }),
  );

  server.registerTool(
    "large",
    {
      description: "Return a large text result.",
      inputSchema: z.object({ bytes: z.number().int().min(1).max(200_000) }),
    },
    async ({ bytes }) => ({
      content: [{ type: "text", text: "x".repeat(bytes) }],
    }),
  );

  server.registerTool(
    "hang",
    {
      description: "Wait until the client cancels the call.",
      inputSchema: z.object({}),
    },
    async () => {
      const startedFile = process.env.KODA_MCP_FIXTURE_STARTED_FILE;
      if (startedFile) {
        writeFileSync(startedFile, "started\n");
      }
      await new Promise(() => undefined);
    },
  );

  return server;
});
