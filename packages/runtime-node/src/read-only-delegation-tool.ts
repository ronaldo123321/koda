import type { ToolContext, ToolRegistry } from "@koda/agent-core";
import type { JsonValue } from "@koda/protocol";
import { z } from "zod";

const inputSchema = z
  .object({ task: z.string().trim().min(1).max(4_000) })
  .strict();

export function registerReadOnlyDelegationTool(
  registry: ToolRegistry,
  delegate: (context: ToolContext, task: string) => Promise<JsonValue>,
): void {
  registry.register({
    spec: {
      name: "delegate_readonly",
      description:
        "Run one independent, read-only child agent in this workspace and return its answer. The child cannot write files, execute commands, load MCP or plugins, or spawn another child. At most two child runs are allowed per parent turn; each can make model requests.",
      inputJsonSchema: {
        type: "object",
        properties: {
          task: { type: "string", minLength: 1, maxLength: 4_000 },
        },
        required: ["task"],
        additionalProperties: false,
      },
    },
    inputSchema,
    concurrency: "exclusive",
    effect: "control",
    execute: (context, input) => delegate(context, input.task),
  });
}
