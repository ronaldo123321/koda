import { ThreadLease } from "@koda/runtime-node";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ThreadLease", () => {
  it("rejects a second writer while the owner is alive", async () => {
    const eventPath = await createEventPath();
    const first = await ThreadLease.acquire(eventPath, {
      pid: 101,
      token: () => "first-token",
      isProcessAlive: () => true,
    });

    await expect(
      ThreadLease.acquire(eventPath, {
        pid: 202,
        token: () => "second-token",
        isProcessAlive: () => true,
      }),
    ).rejects.toMatchObject({ code: "THREAD_BUSY" });

    await first.release();
    await expect(access(`${eventPath}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("replaces a stale dead-owner lease", async () => {
    const eventPath = await createEventPath();
    await ThreadLease.acquire(eventPath, {
      pid: 101,
      token: () => "stale-token",
      isProcessAlive: () => true,
    });

    const replacement = await ThreadLease.acquire(eventPath, {
      pid: 202,
      token: () => "replacement-token",
      isProcessAlive: () => false,
    });

    expect(await readFile(`${eventPath}.lock`, "utf8")).toContain(
      "replacement-token",
    );
    await replacement.release();
  });

  it("does not remove a lock whose ownership token changed", async () => {
    const eventPath = await createEventPath();
    const lease = await ThreadLease.acquire(eventPath, {
      pid: 101,
      token: () => "owned-token",
      isProcessAlive: () => true,
    });
    await writeFile(
      `${eventPath}.lock`,
      `${JSON.stringify({ pid: 202, createdAt: "later", token: "new-owner" })}\n`,
    );

    await lease.release();

    expect(await readFile(`${eventPath}.lock`, "utf8")).toContain("new-owner");
  });
});

async function createEventPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "koda-lease-"));
  temporaryDirectories.push(root);
  return join(root, "threads", "thread.jsonl");
}
