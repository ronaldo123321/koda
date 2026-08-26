import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolRegistry, type ToolExecutionResult } from "@koda/agent-core";
import {
  artifactReferenceSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type JsonObject,
} from "@koda/protocol";
import {
  ArtifactStore,
  ReadOnlyWorkspace,
  registerArtifactTools,
  registerReadOnlyWorkspaceTools,
} from "@koda/runtime-node";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("artifact-backed workspace tools", () => {
  it("materializes oversized read and search output and retrieves it", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-artifact-tools-"));
    temporaryDirectories.push(root);
    const workspaceRoot = join(root, "repo");
    await mkdir(workspaceRoot);
    const source = `needle ${"x".repeat(160)}\nneedle ${"y".repeat(160)}\n`;
    await writeFile(join(workspaceRoot, "large.txt"), source);
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);
    const artifacts = await ArtifactStore.open(join(root, "artifacts"));
    const tools = new ToolRegistry();
    registerArtifactTools(tools, artifacts);
    registerReadOnlyWorkspaceTools(tools, workspace, {
      artifactStore: artifacts,
      inlineOutputBytes: 32,
    });

    const readResult = await execute(tools, "read_file", {
      path: "large.txt",
      start_line: 1,
      line_count: 10,
    });
    expect(readResult).toMatchObject({
      status: "success",
      output: {
        content_truncated: true,
        content_artifact: { type: "artifact" },
      },
    });
    if (readResult.status !== "success") {
      throw new Error("Expected read_file to succeed.");
    }
    const readOutput = readResult.output as JsonObject;
    const reference = artifactReferenceSchema.parse(
      readOutput.content_artifact,
    );

    const artifactResult = await execute(tools, "read_artifact", {
      artifact_id: reference.id,
      offset: 0,
      max_bytes: 65_536,
    });
    expect(artifactResult).toMatchObject({
      status: "success",
      output: {
        artifact_id: reference.id,
        content: expect.stringContaining("1: needle"),
        truncated: false,
      },
    });

    const searchResult = await execute(tools, "search_text", {
      query: "needle",
      path: ".",
      max_results: 10,
    });
    expect(searchResult).toMatchObject({
      status: "success",
      output: {
        matches_truncated: true,
        matches_artifact: { type: "artifact" },
      },
    });
  });

  it("rejects malformed artifact IDs before filesystem access", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-artifact-id-"));
    temporaryDirectories.push(root);
    const tools = new ToolRegistry();
    registerArtifactTools(
      tools,
      await ArtifactStore.open(join(root, "artifacts")),
    );

    await expect(
      execute(tools, "read_artifact", {
        artifact_id: "../../secret",
        offset: 0,
        max_bytes: 100,
      }),
    ).resolves.toMatchObject({
      status: "error",
      error: { code: "INVALID_ARTIFACT_ID" },
    });
  });
});

async function execute(
  tools: ToolRegistry,
  name: string,
  argumentsValue: JsonObject,
): Promise<ToolExecutionResult> {
  const preparation = await tools.prepare(
    {
      callId: toolCallIdSchema.parse(`artifact-${name}`),
      name,
      arguments: argumentsValue,
    },
    {
      threadId: threadIdSchema.parse("artifact-tools-thread"),
      turnId: turnIdSchema.parse("artifact-tools-turn"),
      signal: new AbortController().signal,
    },
  );
  return preparation.status === "error"
    ? preparation.result
    : preparation.invocation.execute();
}
