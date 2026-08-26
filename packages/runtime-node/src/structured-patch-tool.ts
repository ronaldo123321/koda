import type { ToolRegistry } from "@koda/agent-core";
import type { JsonValue } from "@koda/protocol";
import { z } from "zod";

import { ReadOnlyWorkspace } from "./read-only-workspace.js";

const MAX_PATCH_FIELD_CHARACTERS = 65_536;

const structuredPatchInput = z
  .object({
    path: z.string().min(1),
    operation: z.enum(["create", "update"]),
    old_text: z.string().max(MAX_PATCH_FIELD_CHARACTERS),
    new_text: z.string().max(MAX_PATCH_FIELD_CHARACTERS),
  })
  .strict();

export function registerStructuredPatchTool(
  registry: ToolRegistry,
  workspace: ReadOnlyWorkspace,
): void {
  registry.register({
    spec: {
      name: "apply_patch",
      description:
        "Create or update one UTF-8 text file. For update, old_text must be a unique exact match. For create, old_text must be empty and the parent directory must exist. Deletion is not supported.",
      inputJsonSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path.",
          },
          operation: { type: "string", enum: ["create", "update"] },
          old_text: {
            type: "string",
            description:
              "Unique exact text to replace, or an empty string for create.",
            maxLength: MAX_PATCH_FIELD_CHARACTERS,
          },
          new_text: {
            type: "string",
            description: "Replacement text or complete new file contents.",
            maxLength: MAX_PATCH_FIELD_CHARACTERS,
          },
        },
        required: ["path", "operation", "old_text", "new_text"],
        additionalProperties: false,
      },
    },
    inputSchema: structuredPatchInput,
    concurrency: "exclusive",
    effect: "write",
    prepare: async (context, input) => {
      context.signal.throwIfAborted();
      const patch = await workspace.prepareStructuredPatch({
        path: input.path,
        operation: input.operation,
        oldText: input.old_text,
        newText: input.new_text,
      });
      return {
        approval: {
          title: `${input.operation === "create" ? "Create" : "Update"} ${patch.path}`,
          summary: patch.summary,
          details: patch.preview,
        },
        execute: async (): Promise<JsonValue> => ({
          ...(await patch.apply(context.signal)),
        }),
      };
    },
  });
}
