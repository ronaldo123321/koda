import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RemoteApprovalLeaseStore } from "@koda/app-server";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform === "win32")(
  "durable remote approval assignment",
  () => {
    it("records ownership and decision without persisting approval details", async () => {
      const home = await mkdtemp(join(tmpdir(), "koda-approval-lease-"));
      try {
        const store = await RemoteApprovalLeaseStore.open(home);
        const initial = {
          ownerId: "owner",
          workspaceId: "project",
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          deviceId: `device-${"1".repeat(32)}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
        await store.begin(initial);
        await expect(store.begin(initial)).rejects.toThrow();
        const directory = join(home, "remote", "approval-leases");
        const files = (await readdir(directory)).filter((name) =>
          name.endsWith(".json"),
        );
        expect(files).toHaveLength(1);
        const file = join(directory, files[0]!);
        expect((await stat(file)).mode & 0o077).toBe(0);
        expect(await readFile(file, "utf8")).not.toContain("Exact patch");
        const reopened = await RemoteApprovalLeaseStore.open(home);
        expect(
          await reopened.get("thread-1", "turn-1", "call-1"),
        ).toMatchObject({
          deviceId: initial.deviceId,
          status: "pending",
        });
        const other = `device-${"2".repeat(32)}`;
        await reopened.transfer(
          "thread-1",
          "turn-1",
          "call-1",
          initial.deviceId,
          other,
        );
        await expect(
          reopened.finish(
            "thread-1",
            "turn-1",
            "call-1",
            initial.deviceId,
            "approved",
          ),
        ).rejects.toThrow("no longer pending");
        await reopened.finish(
          "thread-1",
          "turn-1",
          "call-1",
          other,
          "approved",
        );
        expect(
          await reopened.get("thread-1", "turn-1", "call-1"),
        ).toMatchObject({
          deviceId: other,
          status: "approved",
        });
        await expect(
          reopened.transfer(
            "thread-1",
            "turn-1",
            "call-1",
            other,
            initial.deviceId,
          ),
        ).rejects.toThrow("no longer transferable");
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });

    it("rejects a linked approval record", async () => {
      const home = await mkdtemp(join(tmpdir(), "koda-approval-link-"));
      try {
        const store = await RemoteApprovalLeaseStore.open(home);
        const ids = ["thread-1", "turn-1", "call-1"];
        const digest = createHash("sha256")
          .update(JSON.stringify(ids))
          .digest("hex");
        await symlink(
          join(home, "outside.json"),
          join(home, "remote", "approval-leases", `${digest}.json`),
        );
        await expect(
          store.get(...(ids as [string, string, string])),
        ).rejects.toThrow();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  },
);
