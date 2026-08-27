import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ReadOnlyWorkspace,
  type WorkspaceChangeSetOperationalEvent,
} from "@koda/runtime-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let temporaryRoot: string;
let workspaceRoot: string;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "koda-change-set-"));
  workspaceRoot = join(temporaryRoot, "repo");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "a.txt"), "alpha one\nalpha two\n");
  await writeFile(join(workspaceRoot, "b.txt"), "bravo\n");
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("workspace change sets", () => {
  it("previews and commits coordinated creates and ordered exact updates", async () => {
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);
    const prepared = await workspace.prepareChangeSet({
      changes: [
        {
          operation: "update",
          path: "a.txt",
          edits: [
            { oldText: "alpha one", newText: "changed one" },
            { oldText: "alpha two", newText: "changed two" },
          ],
        },
        {
          operation: "create",
          path: "src/new.ts",
          content: "export const created = true;\n",
        },
      ],
    });
    expect(await readText("a.txt")).toContain("alpha one");
    await expect(readText("src/new.ts")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(prepared.preview).toContain("*** Update File: a.txt");
    expect(prepared.preview).toContain("@@ Edit 2");
    expect(prepared.preview).toContain("*** Create File: src/new.ts");

    const events: WorkspaceChangeSetOperationalEvent[] = [];
    const result = await prepared.apply(
      new AbortController().signal,
      async (event) => {
        events.push(event);
      },
    );

    expect(result).toMatchObject({
      status: "committed",
      changes: [
        { index: 0, operation: "update", path: "a.txt" },
        { index: 1, operation: "create", path: "src/new.ts" },
      ],
    });
    expect(result.planSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readText("a.txt")).toBe("changed one\nchanged two\n");
    expect(await readText("src/new.ts")).toContain("created = true");
    expect(events.map((event) => event.type)).toEqual([
      "workspace.change_set_prepared",
      "workspace.change_set_committed",
    ]);
    expect(await changeTemporaryFiles()).toEqual([]);
  });

  it("moves and deletes regular UTF-8 files", async () => {
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);
    const prepared = await workspace.prepareChangeSet({
      changes: [
        { operation: "move", fromPath: "a.txt", toPath: "src/moved.txt" },
        { operation: "delete", path: "b.txt" },
      ],
    });
    expect(prepared.preview).toContain("*** Move File: a.txt");
    expect(prepared.preview).toContain("*** Delete File: b.txt");

    await prepared.apply(new AbortController().signal, async () => undefined);

    await expect(readText("a.txt")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readText("b.txt")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readText("src/moved.txt")).toContain("alpha one");
  });

  it("rolls committed operations back in reverse order after a later failure", async () => {
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);
    const prepared = await workspace.prepareChangeSet({
      changes: [
        {
          operation: "update",
          path: "a.txt",
          edits: [{ oldText: "alpha one", newText: "changed" }],
        },
        {
          operation: "update",
          path: "b.txt",
          edits: [{ oldText: "bravo", newText: "changed" }],
        },
      ],
      faultHooks: {
        beforeCommit: (index) => {
          if (index === 1) {
            throw new Error("injected commit failure");
          }
        },
      },
    });
    const events: WorkspaceChangeSetOperationalEvent[] = [];

    await expect(
      prepared.apply(new AbortController().signal, async (event) => {
        events.push(event);
      }),
    ).rejects.toMatchObject({ code: "CHANGE_SET_APPLY_FAILED" });

    expect(await readText("a.txt")).toBe("alpha one\nalpha two\n");
    expect(await readText("b.txt")).toBe("bravo\n");
    expect(events.at(-1)).toMatchObject({
      type: "workspace.change_set_rolled_back",
      payload: { appliedCount: 1, restoredPaths: ["a.txt"] },
    });
    expect(await changeTemporaryFiles()).toEqual([]);
  });

  it("restores deleted and moved files when a later operation fails", async () => {
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);
    const prepared = await workspace.prepareChangeSet({
      changes: [
        { operation: "delete", path: "a.txt" },
        { operation: "move", fromPath: "b.txt", toPath: "src/moved.txt" },
        { operation: "create", path: "z.txt", content: "last\n" },
      ],
      faultHooks: {
        beforeCommit: (index) => {
          if (index === 2) {
            throw new Error("injected final failure");
          }
        },
      },
    });

    await expect(
      prepared.apply(new AbortController().signal, async () => undefined),
    ).rejects.toMatchObject({ code: "CHANGE_SET_APPLY_FAILED" });

    expect(await readText("a.txt")).toBe("alpha one\nalpha two\n");
    expect(await readText("b.txt")).toBe("bravo\n");
    await expect(readText("src/moved.txt")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readText("z.txt")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back after cancellation crosses the first mutation boundary", async () => {
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);
    const controller = new AbortController();
    const prepared = await workspace.prepareChangeSet({
      changes: [
        {
          operation: "update",
          path: "a.txt",
          edits: [{ oldText: "alpha one", newText: "changed" }],
        },
        {
          operation: "update",
          path: "b.txt",
          edits: [{ oldText: "bravo", newText: "changed" }],
        },
      ],
      faultHooks: {
        afterCommit: (index) => {
          if (index === 0) {
            controller.abort("cancel after first commit");
          }
        },
      },
    });
    const events: WorkspaceChangeSetOperationalEvent[] = [];

    await expect(
      prepared.apply(controller.signal, async (event) => {
        events.push(event);
      }),
    ).rejects.toBeDefined();

    expect(await readText("a.txt")).toBe("alpha one\nalpha two\n");
    expect(await readText("b.txt")).toBe("bravo\n");
    expect(events.at(-1)?.type).toBe("workspace.change_set_rolled_back");
  });

  it("refuses to overwrite an external edit during rollback", async () => {
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);
    const prepared = await workspace.prepareChangeSet({
      changes: [
        {
          operation: "update",
          path: "a.txt",
          edits: [{ oldText: "alpha one", newText: "changed" }],
        },
        {
          operation: "update",
          path: "b.txt",
          edits: [{ oldText: "bravo", newText: "changed" }],
        },
      ],
      faultHooks: {
        afterCommit: async (index) => {
          if (index === 0) {
            await writeFile(join(workspaceRoot, "a.txt"), "external edit\n");
          }
        },
        beforeCommit: (index) => {
          if (index === 1) {
            throw new Error("injected commit failure");
          }
        },
      },
    });
    const events: WorkspaceChangeSetOperationalEvent[] = [];

    await expect(
      prepared.apply(new AbortController().signal, async (event) => {
        events.push(event);
      }),
    ).rejects.toMatchObject({ code: "CHANGE_SET_OUTCOME_UNCERTAIN" });

    expect(await readText("a.txt")).toBe("external edit\n");
    expect(await readText("b.txt")).toBe("bravo\n");
    expect(events.at(-1)).toMatchObject({
      type: "workspace.change_set_uncertain",
      payload: { appliedCount: 1, uncertainPaths: ["a.txt"] },
    });
  });

  it("rejects stale and overlapping plans before any mutation", async () => {
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);
    await expect(
      workspace.prepareChangeSet({
        changes: [
          { operation: "delete", path: "a.txt" },
          {
            operation: "update",
            path: "a.txt",
            edits: [{ oldText: "alpha", newText: "changed" }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "CHANGE_PATH_CONFLICT" });

    const prepared = await workspace.prepareChangeSet({
      changes: [
        {
          operation: "update",
          path: "a.txt",
          edits: [{ oldText: "alpha one", newText: "changed" }],
        },
        { operation: "create", path: "src/new.txt", content: "new\n" },
      ],
    });
    await writeFile(join(workspaceRoot, "b.txt"), "unrelated\n");
    await writeFile(join(workspaceRoot, "a.txt"), "newer\n");
    const events: WorkspaceChangeSetOperationalEvent[] = [];

    await expect(
      prepared.apply(new AbortController().signal, async (event) => {
        events.push(event);
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
    await expect(readText("src/new.txt")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(events).toEqual([]);
  });

  it("applies path, UTF-8, delete-preview, and operation-count limits to the whole plan", async () => {
    const workspace = await ReadOnlyWorkspace.open(workspaceRoot);
    await mkdir(join(workspaceRoot, ".git"));
    await writeFile(join(temporaryRoot, "outside.txt"), "outside\n");
    await symlink(temporaryRoot, join(workspaceRoot, "linked"));
    await writeFile(join(workspaceRoot, "large.txt"), "x".repeat(65_537));

    await expect(
      workspace.prepareChangeSet({
        changes: [
          { operation: "create", path: ".git/config", content: "unsafe" },
        ],
      }),
    ).rejects.toMatchObject({ code: "WRITE_PATH_FORBIDDEN" });
    await expect(
      workspace.prepareChangeSet({
        changes: [
          {
            operation: "update",
            path: "linked/outside.txt",
            edits: [{ oldText: "outside", newText: "changed" }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
    await expect(
      workspace.prepareChangeSet({
        changes: [{ operation: "delete", path: "large.txt" }],
      }),
    ).rejects.toMatchObject({ code: "CHANGE_SET_LIMIT_EXCEEDED" });
    await expect(
      workspace.prepareChangeSet({
        changes: Array.from({ length: 17 }, (_, index) => ({
          operation: "create" as const,
          path: `src/${index}.txt`,
          content: "x",
        })),
      }),
    ).rejects.toMatchObject({ code: "CHANGE_SET_LIMIT_EXCEEDED" });
  });
});

async function readText(relativePath: string): Promise<string> {
  return readFile(join(workspaceRoot, relativePath), "utf8");
}

async function changeTemporaryFiles(): Promise<string[]> {
  const directories = [workspaceRoot, join(workspaceRoot, "src")];
  const entries = await Promise.all(directories.map((path) => readdir(path)));
  return entries.flat().filter((name) => name.includes(".koda-change-"));
}
