import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectNoteStore } from "@koda/runtime-node";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ProjectNoteStore", () => {
  it("persists editable workspace-scoped notes and rejects stale writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-project-notes-"));
    roots.push(root);
    const workspace = join(root, "first");
    const other = join(root, "other");
    await Promise.all([mkdir(workspace), mkdir(other)]);
    let idCount = 0;
    const store = await ProjectNoteStore.open(join(root, "state"), {
      id: () => `note-${++idCount}`,
      now: () => "2026-09-27T12:00:00.000Z",
    });
    const created = store.create({
      workspaceRoot: workspace,
      title: "Release workflow",
      body: "Run the release smoke test before publishing.",
    });
    expect(created).toMatchObject({ id: "note-1", revision: 1 });
    expect(store.get(other, created.id)).toBeUndefined();
    expect(store.list(workspace)).toHaveLength(1);
    expect(store.search(workspace, "release smoke")).toMatchObject([
      { id: created.id },
    ]);
    const edited = store.update({
      workspaceRoot: workspace,
      id: created.id,
      expectedRevision: 1,
      body: "Run the signed release smoke test before publishing.",
    });
    expect(edited.revision).toBe(2);
    expect(() =>
      store.update({
        workspaceRoot: workspace,
        id: created.id,
        expectedRevision: 1,
        title: "Stale title",
      }),
    ).toThrowError(/changed/u);
    store.close();

    const reopened = await ProjectNoteStore.open(join(root, "state"));
    expect(reopened.get(workspace, created.id)?.body).toBe(edited.body);
    expect(() =>
      reopened.delete({
        workspaceRoot: workspace,
        id: created.id,
        expectedRevision: 1,
      }),
    ).toThrowError(/changed/u);
    reopened.delete({
      workspaceRoot: workspace,
      id: created.id,
      expectedRevision: 2,
    });
    expect(reopened.list(workspace)).toEqual([]);
    reopened.close();
  });

  it("keeps corrupted notes and rejects an unsafe note directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-project-notes-"));
    roots.push(root);
    const state = join(root, "state");
    await mkdir(join(state, "memory"), { recursive: true });
    const databasePath = join(state, "memory", "project-notes.db");
    await writeFile(databasePath, "not a SQLite database");
    await expect(ProjectNoteStore.open(state)).rejects.toThrow();
    expect(await readFile(databasePath, "utf8")).toBe("not a SQLite database");

    const linkedState = join(root, "linked-state");
    await mkdir(linkedState);
    await symlink(join(state, "memory"), join(linkedState, "memory"));
    await expect(ProjectNoteStore.open(linkedState)).rejects.toMatchObject({
      code: "NOTE_STORE_UNSAFE",
    });
  });

  it("measures exact lexical retrieval on a fixed project-note fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-project-notes-"));
    roots.push(root);
    const workspace = join(root, "repo");
    await mkdir(workspace);
    let nextId = 0;
    const store = await ProjectNoteStore.open(join(root, "state"), {
      id: () => `fixture-${++nextId}`,
    });
    const notes = [
      [
        "Release signing",
        "Use Developer ID signing and notarization for the package.",
      ],
      ["Remote devices", "Pair a device certificate before remote VPN access."],
      [
        "Child worktrees",
        "Give each write-capable child an isolated Git worktree.",
      ],
      ["Project memory", "Curate explicit notes; edit or delete stale facts."],
      ["Local preview", "Install an unsigned local preview for UX checks."],
    ] as const;
    const ids = notes.map(
      ([title, body]) =>
        store.create({ workspaceRoot: workspace, title, body }).id,
    );
    const cases = [
      ["notarization package", ids[0]],
      ["Developer ID", ids[0]],
      ["device certificate", ids[1]],
      ["remote VPN", ids[1]],
      ["isolated Git worktree", ids[2]],
      ["write-capable child", ids[2]],
      ["curate explicit notes", ids[3]],
      ["unsigned local preview", ids[4]],
    ] as const;
    const ranks = cases.map(([query, expected]) =>
      store.search(workspace, query, 3).findIndex((hit) => hit.id === expected),
    );
    const recallAt3 = ranks.filter((rank) => rank >= 0).length / cases.length;
    const meanReciprocalRank =
      ranks.reduce((sum, rank) => sum + (rank < 0 ? 0 : 1 / (rank + 1)), 0) /
      cases.length;
    expect({ recallAt3, meanReciprocalRank }).toEqual({
      recallAt3: 1,
      meanReciprocalRank: 1,
    });
    expect(store.search(workspace, "unrelated pineapple")).toEqual([]);
    store.close();
  });
});
