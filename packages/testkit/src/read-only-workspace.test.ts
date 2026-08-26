import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReadOnlyWorkspace } from "@koda/runtime-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let temporaryRoot: string;
let workspaceRoot: string;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "koda-workspace-"));
  workspaceRoot = join(temporaryRoot, "repo");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await mkdir(join(workspaceRoot, "node_modules", "ignored"), {
    recursive: true,
  });
  await writeFile(join(workspaceRoot, "README.md"), "one\ntwo\nthree\n");
  await writeFile(
    join(workspaceRoot, "src", "example.ts"),
    "const literal = 'a.b';\nconst other = 'axb';\n",
  );
  await writeFile(
    join(workspaceRoot, "node_modules", "ignored", "index.js"),
    "ignored",
  );
  await writeFile(join(temporaryRoot, "outside.txt"), "secret\n");
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("ReadOnlyWorkspace", () => {
  it("lists files deterministically and ignores dependency directories", async () => {
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);
    const result = await workspace.listFiles({
      path: ".",
      maxDepth: 5,
      maxResults: 10,
    });

    expect(result.files).toEqual(["README.md", "src/example.ts"]);
    expect(result.truncated).toBe(false);
  });

  it("reads bounded, numbered line ranges", async () => {
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);
    const result = await workspace.readFile({
      path: "README.md",
      startLine: 2,
      lineCount: 1,
    });

    expect(result).toMatchObject({
      path: "README.md",
      content: "2: two",
      startLine: 2,
      endLine: 2,
      totalLines: 3,
      truncated: true,
    });
  });

  it("searches literal text with ripgrep", async () => {
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);
    const result = await workspace.searchText({
      query: "a.b",
      path: ".",
      maxResults: 10,
      signal: new AbortController().signal,
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toContain("src/example.ts:1:");
    expect(result.matches[0]).toContain("a.b");
  });

  it("rejects lexical traversal outside the workspace", async () => {
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);

    await expect(
      workspace.readFile({
        path: "../outside.txt",
        startLine: 1,
        lineCount: 10,
      }),
    ).rejects.toMatchObject({
      code: "PATH_OUTSIDE_WORKSPACE",
    });
  });

  it("rejects symlinks that resolve outside the workspace", async () => {
    await symlink(
      join(temporaryRoot, "outside.txt"),
      join(workspaceRoot, "link"),
    );
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);

    await expect(
      workspace.readFile({ path: "link", startLine: 1, lineCount: 10 }),
    ).rejects.toMatchObject({
      code: "PATH_OUTSIDE_WORKSPACE",
    });
  });

  it("reports truncation when the file result limit is reached", async () => {
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);
    const result = await workspace.listFiles({
      path: ".",
      maxDepth: 5,
      maxResults: 1,
    });

    expect(result.files).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});
