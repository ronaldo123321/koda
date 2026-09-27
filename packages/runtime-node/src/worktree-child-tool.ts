import type {
  PreparedToolHandler,
  ToolContext,
  ToolRegistry,
} from "@koda/agent-core";
import { z } from "zod";

const inputSchema = z
  .object({ task: z.string().trim().min(1).max(4_000) })
  .strict();

export function registerWorktreeChildTool(
  registry: ToolRegistry,
  prepare: (context: ToolContext, task: string) => Promise<PreparedToolHandler>,
): void {
  registry.register({
    spec: {
      name: "spawn_worktree",
      description:
        "After explicit approval, start a write-capable child in a detached Git worktree at the current HEAD. The child can edit files only in its isolated worktree; it cannot execute commands, use plugins or MCP, or spawn children. The source checkout is not changed. Use wait_children to inspect its result. Uncommitted source changes are not copied.",
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
    effect: "write",
    prepare: (context, input) => prepare(context, input.task),
  });
}
