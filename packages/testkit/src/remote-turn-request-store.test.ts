import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RemoteThreadStore, RemoteTurnRequestStore } from "@koda/app-server";
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
  "remote Turn request idempotency",
  () => {
    it("retains a durable request identity without storing its prompt", async () => {
      const home = await mkdtemp(join(tmpdir(), "koda-remote-turn-request-"));
      directories.push(home);
      const store = await RemoteTurnRequestStore.open(home, "owner");
      const input = {
        requestId: "1".repeat(32),
        deviceId: `device-${"2".repeat(32)}`,
        workspaceId: "project",
        bodySha256: "3".repeat(64),
        threadId: "thread-one",
        turnId: "turn-one",
      };
      const claimed = await store.claim(input);
      expect(claimed.created).toBe(true);
      expect(claimed.record.status).toBe("reserved");
      const duplicate = await store.claim({
        ...input,
        threadId: "thread-two",
        turnId: "turn-two",
      });
      expect(duplicate.created).toBe(false);
      expect(duplicate.record.threadId).toBe("thread-one");
      await store.markStarted(input.requestId, input.threadId, input.turnId);
      const reopened = await RemoteTurnRequestStore.open(home, "owner");
      await expect(reopened.get(input.requestId)).resolves.toMatchObject({
        status: "started",
        threadId: "thread-one",
        turnId: "turn-one",
      });
      const persisted = await readFile(
        join(home, "remote", "turn-requests", `${input.requestId}.json`),
        "utf8",
      );
      expect(persisted).not.toContain("prompt");
      await expect(
        store.claim({ ...input, bodySha256: "4".repeat(64) }),
      ).rejects.toThrow("already used");
      await expect(
        store.claim({ ...input, deviceId: `device-${"5".repeat(32)}` }),
      ).rejects.toThrow("already used");
    });

    it("abandons only an unbound reservation after the startup lease ends", async () => {
      const home = await mkdtemp(join(tmpdir(), "koda-remote-abandon-"));
      directories.push(home);
      const store = await RemoteTurnRequestStore.open(home, "owner");
      const threads = await RemoteThreadStore.open(home, "owner");
      const input = {
        requestId: "6".repeat(32),
        deviceId: `device-${"2".repeat(32)}`,
        workspaceId: "project",
        bodySha256: "3".repeat(64),
        threadId: "reserved-thread",
        turnId: "reserved-turn",
      };
      const lease = await store.acquireLease(input.requestId);
      await store.claim(input);
      await expect(store.abandon(input.requestId, threads)).rejects.toThrow(
        "still being started",
      );
      await lease.release();
      expect(await store.abandon(input.requestId, threads)).toMatchObject({
        status: "abandoned",
      });
      expect(await store.abandon(input.requestId, threads)).toMatchObject({
        status: "abandoned",
      });
      await expect(
        store.markStarted(input.requestId, input.threadId, input.turnId),
      ).rejects.toThrow("no longer reserved");
      const reopened = await RemoteTurnRequestStore.open(home, "owner");
      expect(await reopened.get(input.requestId)).toMatchObject({
        status: "abandoned",
      });

      const bound = {
        ...input,
        requestId: "7".repeat(32),
        threadId: "bound-thread",
      };
      await store.claim(bound);
      await threads.bind({
        ownerId: "owner",
        workspaceId: "project",
        threadId: bound.threadId,
      });
      await expect(store.abandon(bound.requestId, threads)).rejects.toThrow(
        "already has a Thread binding",
      );
      await store.markStarted(bound.requestId, bound.threadId, bound.turnId);
      await expect(store.abandon(bound.requestId, threads)).rejects.toThrow(
        "Only a reserved",
      );
      const logged = {
        ...input,
        requestId: "9".repeat(32),
        threadId: "logged-thread",
      };
      await store.claim(logged);
      await mkdir(join(home, "threads"), { recursive: true });
      await writeFile(
        join(home, "threads", "logged-thread.jsonl"),
        "durable event\n",
      );
      await expect(store.abandon(logged.requestId, threads)).rejects.toThrow(
        "already has a Thread log",
      );
    });
  },
);
