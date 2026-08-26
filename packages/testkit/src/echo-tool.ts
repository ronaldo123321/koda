import { type ToolRegistry } from "@koda/agent-core";
import { type JsonValue } from "@koda/protocol";
import { z } from "zod";

const echoInputSchema = z.object({ text: z.string() });

export function registerEchoTool(registry: ToolRegistry): void {
  registry.register({
    spec: {
      name: "echo",
      description: "Return the supplied text as structured JSON.",
      inputJsonSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    inputSchema: echoInputSchema,
    concurrency: "parallel",
    effect: "read",
    execute: async (_context, input): Promise<JsonValue> => ({
      echoed: input.text,
    }),
  });
}
