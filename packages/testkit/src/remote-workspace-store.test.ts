import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RemoteWorkspaceStore } from "@koda/app-server";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")(
  "remote workspace registration",
  () => {
    it("registers only local canonical directories under opaque IDs", async () => {
      const home = await mkdtemp(join(tmpdir(), "koda-remote-workspaces-"));
      const workspace = await mkdtemp(join(tmpdir(), "koda-remote-project-"));
      directories.push(home, workspace);
      const store = await RemoteWorkspaceStore.open(home, "owner");
      const registered = await store.register("project", workspace);
      expect(registered).toEqual({
        id: "project",
        root: await realpath(workspace),
      });
      await expect(store.list()).resolves.toEqual([registered]);
      await expect(store.get("project")).resolves.toEqual(registered);
      await expect(store.register("another", workspace)).rejects.toThrow(
        "invalid",
      );
      await expect(store.register("../escape", workspace)).rejects.toThrow();
      await expect(store.register("other", "relative/path")).rejects.toThrow(
        "absolute",
      );
    });

    it("rejects a registered workspace whose path is replaced", async () => {
      const home = await mkdtemp(join(tmpdir(), "koda-remote-workspaces-"));
      const workspace = await mkdtemp(join(tmpdir(), "koda-remote-project-"));
      const elsewhere = await mkdtemp(join(tmpdir(), "koda-remote-other-"));
      directories.push(home, workspace, elsewhere);
      const store = await RemoteWorkspaceStore.open(home, "owner");
      await store.register("project", workspace);
      await rm(workspace, { recursive: true });
      await symlink(elsewhere, workspace);
      await expect(store.get("project")).rejects.toThrow("changed");
    });
  },
);
