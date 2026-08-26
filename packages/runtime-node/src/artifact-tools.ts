import type { ToolRegistry } from "@koda/agent-core";
import type { JsonValue } from "@koda/protocol";
import { z } from "zod";

import { ArtifactStore } from "./artifact-store.js";

const readArtifactInput = z
  .object({
    artifact_id: z.string().min(1),
    offset: z.number().int().nonnegative(),
    max_bytes: z.number().int().min(1).max(65_536),
  })
  .strict();

export function registerArtifactTools(
  registry: ToolRegistry,
  store: ArtifactStore,
): void {
  registry.register({
    spec: {
      name: "read_artifact",
      description:
        "Read a bounded byte range from a Koda output artifact by its sha256 artifact ID.",
      inputJsonSchema: {
        type: "object",
        properties: {
          artifact_id: {
            type: "string",
            pattern: "^sha256:[a-f0-9]{64}$",
          },
          offset: { type: "integer", minimum: 0 },
          max_bytes: { type: "integer", minimum: 1, maximum: 65_536 },
        },
        required: ["artifact_id", "offset", "max_bytes"],
        additionalProperties: false,
      },
    },
    inputSchema: readArtifactInput,
    concurrency: "parallel",
    effect: "read",
    execute: async (_context, input): Promise<JsonValue> => {
      const result = await store.readRange(
        input.artifact_id,
        input.offset,
        input.max_bytes,
      );
      return {
        artifact_id: result.id,
        content: result.content,
        start_byte: result.startByte,
        end_byte: result.endByte,
        total_bytes: result.totalBytes,
        truncated: result.truncated,
      };
    },
  });
}
