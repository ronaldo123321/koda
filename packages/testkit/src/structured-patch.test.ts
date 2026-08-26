import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReadOnlyWorkspace } from "@koda/runtime-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let temporaryRoot: string;
let workspaceRoot: string;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "koda-patch-"));
  workspaceRoot = join(temporaryRoot, "repo");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await mkdir(join(workspaceRoot, ".git"));
  await writeFile(
    join(workspaceRoot, "README.md"),
    "# Koda\n\nA local agent.\n",
  );
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("structured workspace patches", () => {
  it("previews a unique update without mutating, then applies it", async () => {
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);
    await chmod(join(workspaceRoot, "README.md"), 0o755);
    const prepared = await workspace.prepareStructuredPatch({
      path: "README.md",
      operation: "update",
      oldText: "A local agent.",
      newText: "A safe local coding agent.",
    });

    expect(await readText("README.md")).toContain("A local agent.");
    expect(prepared.summary).toBe("Update one exact match in README.md.");
    expect(prepared.preview).toContain("*** Update File: README.md");
    expect(prepared.preview).toContain("-A local agent.");
    expect(prepared.preview).toContain("+A safe local coding agent.");

    const result = await prepared.apply(new AbortController().signal);

    expect(result).toMatchObject({
      path: "README.md",
      operation: "update",
    });
    expect(result.beforeHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.afterHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readText("README.md")).toContain("A safe local coding agent.");
    expect((await stat(join(workspaceRoot, "README.md"))).mode & 0o777).toBe(
      0o755,
    );
  });

  it("creates a new file only after the prepared patch executes", async () => {
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);
    const prepared = await workspace.prepareStructuredPatch({
      path: "src/new.ts",
      operation: "create",
      oldText: "",
      newText: "export const created = true;\n",
    });

    await expect(readText("src/new.ts")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const result = await prepared.apply(new AbortController().signal);

    expect(result.beforeHash).toBeNull();
    expect(await readText("src/new.ts")).toBe("export const created = true;\n");
  });

  it("rejects missing and ambiguous update matches", async () => {
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);
    await writeFile(join(workspaceRoot, "duplicates.txt"), "same\nsame\n");

    await expect(
      workspace.prepareStructuredPatch({
        path: "README.md",
        operation: "update",
        oldText: "not present",
        newText: "replacement",
      }),
    ).rejects.toMatchObject({ code: "PATCH_MATCH_NOT_FOUND" });
    await expect(
      workspace.prepareStructuredPatch({
        path: "duplicates.txt",
        operation: "update",
        oldText: "same",
        newText: "different",
      }),
    ).rejects.toMatchObject({ code: "PATCH_MATCH_AMBIGUOUS" });
  });

  it("rejects traversal, internal state directories, and symlink writes", async () => {
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);
    await writeFile(join(temporaryRoot, "outside.txt"), "outside\n");
    await symlink(temporaryRoot, join(workspaceRoot, "linked"));

    await expect(
      workspace.prepareStructuredPatch({
        path: "../outside.txt",
        operation: "update",
        oldText: "outside",
        newText: "changed",
      }),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
    await expect(
      workspace.prepareStructuredPatch({
        path: ".git/config",
        operation: "create",
        oldText: "",
        newText: "unsafe",
      }),
    ).rejects.toMatchObject({ code: "WRITE_PATH_FORBIDDEN" });
    await expect(
      workspace.prepareStructuredPatch({
        path: "linked/outside.txt",
        operation: "update",
        oldText: "outside",
        newText: "changed",
      }),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });

  it("detects an update changed after its approval preview", async () => {
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);
    const prepared = await workspace.prepareStructuredPatch({
      path: "README.md",
      operation: "update",
      oldText: "A local agent.",
      newText: "A changed agent.",
    });
    await writeFile(join(workspaceRoot, "README.md"), "newer contents\n");

    await expect(
      prepared.apply(new AbortController().signal),
    ).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
    expect(await readText("README.md")).toBe("newer contents\n");
  });

  it("detects a create target that appears after its approval preview", async () => {
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);
    const prepared = await workspace.prepareStructuredPatch({
      path: "src/race.ts",
      operation: "create",
      oldText: "",
      newText: "generated\n",
    });
    await writeFile(join(workspaceRoot, "src", "race.ts"), "user content\n");

    await expect(
      prepared.apply(new AbortController().signal),
    ).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
    expect(await readText("src/race.ts")).toBe("user content\n");
  });

  it("rejects binary update targets", async () => {
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);
    await writeFile(join(workspaceRoot, "binary.dat"), Buffer.from([1, 0, 2]));

    await expect(
      workspace.prepareStructuredPatch({
        path: "binary.dat",
        operation: "update",
        oldText: "one",
        newText: "two",
      }),
    ).rejects.toMatchObject({ code: "BINARY_FILE" });
  });
});

async function readText(relativePath: string): Promise<string> {
  return readFile(join(workspaceRoot, relativePath), "utf8");
}
