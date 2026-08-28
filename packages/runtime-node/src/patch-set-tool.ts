import { ToolOperationalEventError, type ToolRegistry } from "@koda/agent-core";
import { jsonValueSchema, type JsonValue } from "@koda/protocol";
import { z } from "zod";

import {
  MAX_PATCH_DOCUMENT_BYTES,
  parsePatchDocument,
} from "./patch-document.js";
import { ReadOnlyWorkspace } from "./read-only-workspace.js";
import { WorkspaceMutationCoordinator } from "./workspace-mutation-coordinator.js";
import type { WorkspaceMutationJournalStore } from "./workspace-mutation-journal.js";

const patchSetInputSchema = z
  .object({
    patch: z.string().min(1).max(MAX_PATCH_DOCUMENT_BYTES),
  })
  .strict();

export function registerPatchSetTool(
  registry: ToolRegistry,
  workspace: ReadOnlyWorkspace,
  coordinator: WorkspaceMutationCoordinator,
  journal?: WorkspaceMutationJournalStore,
): void {
  registry.register({
    spec: {
      name: "apply_patchset",
      description:
        "Apply one strict Koda Patch v1 document after one approval. Use exactly one '*** Begin Patch'/'*** End Patch' envelope. Sections are '*** Add File: path' with + lines, '*** Update File: path' with @@ hunks whose lines start with space/-/+, '*** Move File: path' followed by '*** To: path', or '*** Delete File: path'. This is not Git unified diff and matching is exact without fuzz.",
      inputJsonSchema: {
        type: "object",
        properties: {
          patch: {
            type: "string",
            minLength: 1,
            maxLength: MAX_PATCH_DOCUMENT_BYTES,
            description:
              "A complete strict Koda Patch v1 document. Add lines begin '+'. Update hunks begin '@@' and use one leading space for context, '-' for removal, and '+' for addition.",
          },
        },
        required: ["patch"],
        additionalProperties: false,
      },
    },
    inputSchema: patchSetInputSchema,
    concurrency: "exclusive",
    effect: "write",
    prepare: async (context, input) => {
      context.signal.throwIfAborted();
      const changes = parsePatchDocument(input.patch);
      const prepared = await workspace.prepareChangeSet({ changes });
      return {
        approval: {
          title: `Apply patch document with ${prepared.changes.length} workspace changes`,
          summary: prepared.summary,
          details: prepared.preview,
        },
        execute: async (): Promise<JsonValue> => {
          const report = context.report;
          if (report === undefined) {
            throw new ToolOperationalEventError(
              "apply_patchset requires a durable operational event recorder.",
            );
          }
          return jsonValueSchema.parse(
            await coordinator.runExclusive(context.signal, () =>
              prepared.apply(
                context.signal,
                report,
                journal === undefined
                  ? undefined
                  : {
                      store: journal,
                      identity: {
                        threadId: context.threadId,
                        turnId: context.turnId,
                        callId: context.callId,
                        toolName: "apply_patchset",
                      },
                    },
              ),
            ),
          );
        },
      };
    },
  });
}
