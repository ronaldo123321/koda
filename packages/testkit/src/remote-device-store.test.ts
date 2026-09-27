import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RemoteAccessDeniedError, RemoteDeviceStore } from "@koda/app-server";
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
  "remote device credentials",
  () => {
    it("issues one device token, stores only its digest, and revokes it", async () => {
      const home = await mkdtemp(join(tmpdir(), "koda-remote-device-"));
      directories.push(home);
      const store = await RemoteDeviceStore.open(home, "owner");
      const issued = await store.issue("MacBook", [
        {
          workspaceId: "project",
          permissions: ["workspace:read", "thread:read"],
        },
      ]);
      const record = await readFile(
        join(home, "remote", "devices", `${issued.deviceId}.json`),
        "utf8",
      );
      expect(record).not.toContain(issued.token);
      expect(record).not.toContain(issued.token.split(".")[2]);
      await expect(store.verify(issued.token)).resolves.toMatchObject({
        principal: { ownerId: "owner", deviceId: issued.deviceId },
        grants: [{ workspaceId: "project" }],
      });
      await expect(store.verify(`${issued.token}x`)).rejects.toBeInstanceOf(
        RemoteAccessDeniedError,
      );
      await store.revoke(issued.deviceId);
      await store.revoke(issued.deviceId);
      await expect(store.verify(issued.token)).rejects.toBeInstanceOf(
        RemoteAccessDeniedError,
      );
    });

    it("rejects an expired device and a symlinked credential file", async () => {
      const home = await mkdtemp(join(tmpdir(), "koda-remote-device-"));
      directories.push(home);
      let now = Date.UTC(2026, 8, 27);
      const store = await RemoteDeviceStore.open(home, "owner", () => now);
      const issued = await store.issue(
        "iPhone",
        [{ workspaceId: "project", permissions: ["workspace:read"] }],
        60_000,
      );
      now += 60_000;
      await expect(store.verify(issued.token)).rejects.toBeInstanceOf(
        RemoteAccessDeniedError,
      );

      const otherHome = await mkdtemp(join(tmpdir(), "koda-remote-link-"));
      directories.push(otherHome);
      const file = join(home, "remote", "devices", `${issued.deviceId}.json`);
      const copy = join(otherHome, "device.json");
      await writeFile(copy, await readFile(file));
      await rm(file);
      await symlink(copy, file);
      now -= 60_000;
      await expect(store.verify(issued.token)).rejects.toBeInstanceOf(
        RemoteAccessDeniedError,
      );
    });
  },
);
