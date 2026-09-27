import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RemoteThreadStore } from "@koda/app-server";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")("remote Thread binding", () => {
  it("persists an exact owner/workspace binding and refuses replacement", async () => {
    const home = await mkdtemp(join(tmpdir(), "koda-remote-thread-"));
    directories.push(home);
    const store = await RemoteThreadStore.open(home, "owner");
    const binding = {
      ownerId: "owner",
      workspaceId: "project",
      threadId: "thread-1",
    };
    await expect(store.get(binding.threadId)).resolves.toBeUndefined();
    await store.bind(binding);
    await expect(store.get(binding.threadId)).resolves.toEqual(binding);
    await expect(
      store.bind({ ...binding, workspaceId: "other-project" }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(store.get(binding.threadId)).resolves.toEqual(binding);
  });

  it("rejects untrusted owner and a symlinked binding", async () => {
    const home = await mkdtemp(join(tmpdir(), "koda-remote-thread-"));
    directories.push(home);
    const store = await RemoteThreadStore.open(home, "owner");
    await expect(
      store.bind({
        ownerId: "other",
        workspaceId: "project",
        threadId: "thread-1",
      }),
    ).rejects.toThrow("owner");
    const binding = join(home, "remote", "threads", "thread-1.json");
    const target = join(home, "elsewhere.json");
    await writeFile(target, "{}");
    await symlink(target, binding);
    await expect(store.get("thread-1")).rejects.toMatchObject({
      code: "ELOOP",
    });
  });
});
