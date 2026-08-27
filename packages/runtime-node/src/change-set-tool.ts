import { ToolOperationalEventError, type ToolRegistry } from "@koda/agent-core";
import { jsonValueSchema, type JsonValue } from "@koda/protocol";
import { z } from "zod";

import {
  ReadOnlyWorkspace,
  type WorkspaceChange,
} from "./read-only-workspace.js";
import { WorkspaceMutationCoordinator } from "./workspace-mutation-coordinator.js";

const MAX_CHANGE_TEXT_CHARACTERS = 65_536;
const MAX_CHANGES = 16;
const MAX_EDITS = 32;

const createChangeSchema = z
  .object({
    operation: z.literal("create"),
    path: z.string().min(1),
    content: z.string().max(MAX_CHANGE_TEXT_CHARACTERS),
  })
  .strict();

const updateChangeSchema = z
  .object({
    operation: z.literal("update"),
    path: z.string().min(1),
    edits: z
      .array(
        z
          .object({
            old_text: z.string().min(1).max(MAX_CHANGE_TEXT_CHARACTERS),
            new_text: z.string().max(MAX_CHANGE_TEXT_CHARACTERS),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_EDITS),
  })
  .strict();

const moveChangeSchema = z
  .object({
    operation: z.literal("move"),
    from_path: z.string().min(1),
    to_path: z.string().min(1),
  })
  .strict();

const deleteChangeSchema = z
  .object({
    operation: z.literal("delete"),
    path: z.string().min(1),
  })
  .strict();

const changeSetInputSchema = z
  .object({
    changes: z
      .array(
        z.discriminatedUnion("operation", [
          createChangeSchema,
          updateChangeSchema,
          moveChangeSchema,
          deleteChangeSchema,
        ]),
      )
      .min(1)
      .max(MAX_CHANGES),
  })
  .strict()
  .superRefine((input, context) => {
    const edits = input.changes.reduce(
      (total, change) =>
        total + (change.operation === "update" ? change.edits.length : 0),
      0,
    );
    if (edits > MAX_EDITS) {
      context.addIssue({
        code: "custom",
        message: `A change set cannot exceed ${MAX_EDITS} exact edits.`,
        path: ["changes"],
      });
    }
  });

export function registerChangeSetTool(
  registry: ToolRegistry,
  workspace: ReadOnlyWorkspace,
  coordinator: WorkspaceMutationCoordinator,
): void {
  registry.register({
    spec: {
      name: "apply_changes",
      description:
        "Apply one coordinated set of UTF-8 text-file creates, exact updates, same-filesystem moves, and deletions after one approval. Paths cannot overlap, parents must exist, and all preconditions are revalidated before mutation.",
      inputJsonSchema: {
        type: "object",
        properties: {
          changes: {
            type: "array",
            minItems: 1,
            maxItems: MAX_CHANGES,
            items: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    operation: { type: "string", enum: ["create"] },
                    path: { type: "string" },
                    content: {
                      type: "string",
                      maxLength: MAX_CHANGE_TEXT_CHARACTERS,
                    },
                  },
                  required: ["operation", "path", "content"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    operation: { type: "string", enum: ["update"] },
                    path: { type: "string" },
                    edits: {
                      type: "array",
                      minItems: 1,
                      maxItems: MAX_EDITS,
                      items: {
                        type: "object",
                        properties: {
                          old_text: {
                            type: "string",
                            minLength: 1,
                            maxLength: MAX_CHANGE_TEXT_CHARACTERS,
                          },
                          new_text: {
                            type: "string",
                            maxLength: MAX_CHANGE_TEXT_CHARACTERS,
                          },
                        },
                        required: ["old_text", "new_text"],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ["operation", "path", "edits"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    operation: { type: "string", enum: ["move"] },
                    from_path: { type: "string" },
                    to_path: { type: "string" },
                  },
                  required: ["operation", "from_path", "to_path"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    operation: { type: "string", enum: ["delete"] },
                    path: { type: "string" },
                  },
                  required: ["operation", "path"],
                  additionalProperties: false,
                },
              ],
            },
          },
        },
        required: ["changes"],
        additionalProperties: false,
      },
    },
    inputSchema: changeSetInputSchema,
    concurrency: "exclusive",
    effect: "write",
    prepare: async (context, input) => {
      context.signal.throwIfAborted();
      const prepared = await workspace.prepareChangeSet({
        changes: input.changes.map(toWorkspaceChange),
      });
      return {
        approval: {
          title: `Apply ${prepared.changes.length} coordinated workspace changes`,
          summary: prepared.summary,
          details: prepared.preview,
        },
        execute: async (): Promise<JsonValue> => {
          const report = context.report;
          if (report === undefined) {
            throw new ToolOperationalEventError(
              "apply_changes requires a durable operational event recorder.",
            );
          }
          return jsonValueSchema.parse(
            await coordinator.runExclusive(context.signal, () =>
              prepared.apply(context.signal, report),
            ),
          );
        },
      };
    },
  });
}

function toWorkspaceChange(
  change: z.infer<typeof changeSetInputSchema>["changes"][number],
): WorkspaceChange {
  if (change.operation === "create") {
    return {
      operation: "create",
      path: change.path,
      content: change.content,
    };
  }
  if (change.operation === "update") {
    return {
      operation: "update",
      path: change.path,
      edits: change.edits.map((edit) => ({
        oldText: edit.old_text,
        newText: edit.new_text,
      })),
    };
  }
  if (change.operation === "move") {
    return {
      operation: "move",
      fromPath: change.from_path,
      toPath: change.to_path,
    };
  }
  return { operation: "delete", path: change.path };
}
