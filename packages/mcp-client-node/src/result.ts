import type { CallToolResult } from "@modelcontextprotocol/client";
import { jsonValueSchema, type JsonValue } from "@koda/protocol";
import {
  ArtifactError,
  ArtifactStore,
  type MaterializedTextOutput,
} from "@koda/runtime-node";

import { McpClientError } from "./errors.js";

export async function materializeMcpToolResult(
  result: CallToolResult,
  artifactStore: ArtifactStore,
): Promise<JsonValue> {
  if (result.isError === true) {
    throw new McpClientError(
      "MCP_TOOL_ERROR",
      toolErrorMessage(result.content),
    );
  }
  const normalized = jsonValueSchema.safeParse({
    content: result.content.map(normalizeContentBlock),
    ...(result.structuredContent === undefined
      ? {}
      : { structured_content: result.structuredContent }),
    is_error: false,
  });
  if (!normalized.success) {
    throw new McpClientError(
      "MCP_INVALID_RESULT",
      "The MCP server returned content that is not valid JSON data.",
    );
  }
  const serialized = stableJsonStringify(normalized.data);
  let materialized: MaterializedTextOutput;
  try {
    materialized = await artifactStore.materializeText(serialized, {
      mediaType: "application/json",
    });
  } catch (error) {
    if (
      error instanceof ArtifactError &&
      error.code === "ARTIFACT_OUTPUT_LIMIT_EXCEEDED"
    ) {
      throw new McpClientError("MCP_OUTPUT_LIMIT_EXCEEDED", error.message, {
        cause: error,
      });
    }
    throw error;
  }
  if (!materialized.truncated) {
    return jsonValueSchema.parse(JSON.parse(materialized.text));
  }
  return jsonValueSchema.parse({
    content_excerpt: materialized.text,
    content_bytes: materialized.totalBytes,
    content_truncated: true,
    ...(materialized.artifact === undefined
      ? {}
      : { content_artifact: materialized.artifact }),
  });
}

export function stableJsonStringify(value: JsonValue): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function normalizeContentBlock(block: unknown): JsonValue {
  if (!isObject(block) || typeof block.type !== "string") {
    throw new McpClientError(
      "MCP_INVALID_RESULT",
      "The MCP server returned an invalid content block.",
    );
  }
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }
  if (
    (block.type === "image" || block.type === "audio") &&
    typeof block.data === "string"
  ) {
    return {
      type: block.type,
      data_bytes: decodedBase64Bytes(block.data),
      data_omitted: true,
      ...(typeof block.mimeType === "string"
        ? { mime_type: block.mimeType }
        : {}),
    };
  }
  if (block.type === "resource" && isObject(block.resource)) {
    return {
      type: "resource",
      resource: normalizeEmbeddedResource(block.resource),
    };
  }
  if (block.type === "resource_link") {
    const parsed = jsonValueSchema.safeParse(block);
    if (parsed.success) {
      return parsed.data;
    }
  }
  const parsed = jsonValueSchema.safeParse(block);
  if (!parsed.success) {
    throw new McpClientError(
      "MCP_INVALID_RESULT",
      `The MCP server returned an unsupported '${block.type}' content block.`,
    );
  }
  return parsed.data;
}

function normalizeEmbeddedResource(
  resource: Record<string, unknown>,
): JsonValue {
  if (typeof resource.uri !== "string") {
    throw new McpClientError(
      "MCP_INVALID_RESULT",
      "The MCP server returned an embedded resource without a URI.",
    );
  }
  if (typeof resource.text === "string") {
    return {
      uri: resource.uri,
      text: resource.text,
      ...(typeof resource.mimeType === "string"
        ? { mime_type: resource.mimeType }
        : {}),
    };
  }
  if (typeof resource.blob === "string") {
    return {
      uri: resource.uri,
      blob_bytes: decodedBase64Bytes(resource.blob),
      blob_omitted: true,
      ...(typeof resource.mimeType === "string"
        ? { mime_type: resource.mimeType }
        : {}),
    };
  }
  throw new McpClientError(
    "MCP_INVALID_RESULT",
    `The MCP server returned unsupported content for resource '${resource.uri}'.`,
  );
}

function toolErrorMessage(content: readonly unknown[]): string {
  const text = content
    .filter(
      (block): block is { type: "text"; text: string } =>
        isObject(block) &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => block.text.trim())
    .filter((value) => value.length > 0)
    .join(" ");
  return text.length > 0 ? text : "The MCP tool reported an error.";
}

function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
