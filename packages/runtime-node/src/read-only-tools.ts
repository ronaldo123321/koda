import { type ToolRegistry } from "@koda/agent-core";
import { type JsonValue } from "@koda/protocol";
import { z } from "zod";

import { ArtifactStore } from "./artifact-store.js";
import { ReadOnlyWorkspace } from "./read-only-workspace.js";

const listFilesInput = z
  .object({
    path: z.string().min(1),
    max_depth: z.number().int().min(0).max(20),
    max_results: z.number().int().min(1).max(2_000),
  })
  .strict();

const readFileInput = z
  .object({
    path: z.string().min(1),
    start_line: z.number().int().min(1),
    line_count: z.number().int().min(1).max(1_000),
  })
  .strict();

const searchTextInput = z
  .object({
    query: z.string().min(1),
    path: z.string().min(1),
    max_results: z.number().int().min(1).max(2_000),
  })
  .strict();

export interface ReadOnlyWorkspaceToolOptions {
  artifactStore?: ArtifactStore;
  inlineOutputBytes?: number;
}

export function registerReadOnlyWorkspaceTools(
  registry: ToolRegistry,
  workspace: ReadOnlyWorkspace,
  options: ReadOnlyWorkspaceToolOptions = {},
): void {
  registry.register({
    spec: {
      name: "list_files",
      description:
        "List files under a workspace-relative directory. Use '.' for the workspace root.",
      inputJsonSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          max_depth: { type: "integer", minimum: 0, maximum: 20 },
          max_results: { type: "integer", minimum: 1, maximum: 2_000 },
        },
        required: ["path", "max_depth", "max_results"],
        additionalProperties: false,
      },
    },
    inputSchema: listFilesInput,
    concurrency: "parallel",
    effect: "read",
    execute: async (_context, input): Promise<JsonValue> => ({
      ...(await workspace.listFiles({
        path: input.path,
        maxDepth: input.max_depth,
        maxResults: input.max_results,
      })),
    }),
  });

  registry.register({
    spec: {
      name: "read_file",
      description:
        "Read numbered lines from a UTF-8 text file using a workspace-relative path. Oversized results include a retrievable content artifact.",
      inputJsonSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "integer", minimum: 1 },
          line_count: { type: "integer", minimum: 1, maximum: 1_000 },
        },
        required: ["path", "start_line", "line_count"],
        additionalProperties: false,
      },
    },
    inputSchema: readFileInput,
    concurrency: "parallel",
    effect: "read",
    execute: async (_context, input): Promise<JsonValue> => {
      const result = await workspace.readFile({
        path: input.path,
        startLine: input.start_line,
        lineCount: input.line_count,
      });
      if (options.artifactStore === undefined) {
        return { ...result };
      }
      const materialized = await options.artifactStore.materializeText(
        result.content,
        inlineOptions(options.inlineOutputBytes),
      );
      return {
        ...result,
        content: materialized.text,
        content_bytes: materialized.totalBytes,
        content_truncated: materialized.truncated,
        ...(materialized.artifact === undefined
          ? {}
          : { content_artifact: materialized.artifact }),
      };
    },
  });

  registry.register({
    spec: {
      name: "search_text",
      description:
        "Search for a literal text string with ripgrep inside a workspace-relative path. Oversized match output includes a retrievable artifact.",
      inputJsonSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          path: { type: "string" },
          max_results: { type: "integer", minimum: 1, maximum: 2_000 },
        },
        required: ["query", "path", "max_results"],
        additionalProperties: false,
      },
    },
    inputSchema: searchTextInput,
    concurrency: "parallel",
    effect: "read",
    execute: async (context, input): Promise<JsonValue> => {
      const result = await workspace.searchText({
        query: input.query,
        path: input.path,
        maxResults: input.max_results,
        signal: context.signal,
      });
      if (options.artifactStore === undefined) {
        return { ...result };
      }
      const materialized = await options.artifactStore.materializeText(
        result.matches.join("\n"),
        inlineOptions(options.inlineOutputBytes),
      );
      return {
        ...result,
        matches:
          materialized.text.length === 0 ? [] : materialized.text.split("\n"),
        matches_bytes: materialized.totalBytes,
        matches_truncated: materialized.truncated,
        ...(materialized.artifact === undefined
          ? {}
          : { matches_artifact: materialized.artifact }),
      };
    },
  });
}

function inlineOptions(inlineOutputBytes: number | undefined): {
  inlineBytes?: number;
} {
  return inlineOutputBytes === undefined
    ? {}
    : { inlineBytes: inlineOutputBytes };
}
