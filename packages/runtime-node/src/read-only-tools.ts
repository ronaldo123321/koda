import { type ToolRegistry } from "@koda/agent-core";
import { type JsonValue } from "@koda/protocol";
import { z } from "zod";

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

export function registerReadOnlyWorkspaceTools(
  registry: ToolRegistry,
  workspace: ReadOnlyWorkspace,
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
        "Read numbered lines from a UTF-8 text file using a workspace-relative path.",
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
    execute: async (_context, input): Promise<JsonValue> => ({
      ...(await workspace.readFile({
        path: input.path,
        startLine: input.start_line,
        lineCount: input.line_count,
      })),
    }),
  });

  registry.register({
    spec: {
      name: "search_text",
      description:
        "Search for a literal text string with ripgrep inside a workspace-relative path.",
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
    execute: async (context, input): Promise<JsonValue> => ({
      ...(await workspace.searchText({
        query: input.query,
        path: input.path,
        maxResults: input.max_results,
        signal: context.signal,
      })),
    }),
  });
}
