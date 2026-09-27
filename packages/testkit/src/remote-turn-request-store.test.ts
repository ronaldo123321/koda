import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RemoteTurnRequestStore } from "@koda/app-server";
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
  },
);
