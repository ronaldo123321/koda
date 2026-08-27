import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkspacePreferenceStore } from "@koda/runtime-node";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("WorkspacePreferenceStore", () => {
  it("isolates canonical workspaces and advances revision atomically", async () => {
    const fixture = await createFixture();
    const store = await WorkspacePreferenceStore.open(fixture.kodaHome, {
      now: () => "2026-08-27T08:00:00.000Z",
    });

    await expect(store.get(fixture.firstWorkspace)).resolves.toEqual({
      workspace: fixture.firstWorkspace,
      revision: 0,
      diagnostics: [],
    });
    const first = await store.update({
      workspace: fixture.firstWorkspace,
      provider: "deepseek",
      model: "deepseek-chat",
      expectedRevision: 0,
    });
    expect(first).toMatchObject({
      workspace: fixture.firstWorkspace,
      revision: 1,
      preference: {
        provider: "deepseek",
        model: "deepseek-chat",
        updatedAt: "2026-08-27T08:00:00.000Z",
      },
    });
    await expect(store.get(fixture.secondWorkspace)).resolves.toMatchObject({
      revision: 0,
    });
    const second = await store.update({
      workspace: fixture.firstWorkspace,
      provider: "openai",
      model: "gpt-test",
      expectedRevision: 1,
    });
    expect(second.revision).toBe(2);

    const path = store.pathForWorkspace(fixture.firstWorkspace);
    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      workspace: string;
      revision: number;
      provider: string;
      model: string;
    };
    expect(persisted).toMatchObject({
      workspace: fixture.firstWorkspace,
      revision: 2,
      provider: "openai",
      model: "gpt-test",
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(
      (await readdir(store.root)).some((name) => name.endsWith(".tmp")),
    ).toBe(false);
  });

  it("rejects stale revisions without changing the committed preference", async () => {
    const fixture = await createFixture();
    const store = await WorkspacePreferenceStore.open(fixture.kodaHome);
    await store.update({
      workspace: fixture.firstWorkspace,
      provider: "openai",
      model: "gpt-first",
      expectedRevision: 0,
    });

    await expect(
      store.update({
        workspace: fixture.firstWorkspace,
        provider: "anthropic",
        model: "claude-test",
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "SETTINGS_CHANGED" });
    await expect(store.get(fixture.firstWorkspace)).resolves.toMatchObject({
      revision: 1,
      preference: { provider: "openai", model: "gpt-first" },
    });
  });

  it("fails busy for a live owner and recovers a stale owner", async () => {
    const fixture = await createFixture();
    const liveStore = await WorkspacePreferenceStore.open(fixture.kodaHome, {
      isProcessAlive: () => true,
    });
    const preferencePath = liveStore.pathForWorkspace(fixture.firstWorkspace);
    await writeFile(
      `${preferencePath}.lock`,
      `${JSON.stringify({
        pid: 777,
        createdAt: "2026-08-27T08:00:00.000Z",
        token: "live-owner",
      })}\n`,
      { mode: 0o600 },
    );
    await expect(
      liveStore.update({
        workspace: fixture.firstWorkspace,
        provider: "openai",
        model: "gpt-test",
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "SETTINGS_BUSY" });

    const staleStore = await WorkspacePreferenceStore.open(fixture.kodaHome, {
      isProcessAlive: () => false,
    });
    await expect(
      staleStore.update({
        workspace: fixture.firstWorkspace,
        provider: "openai",
        model: "gpt-test",
        expectedRevision: 0,
      }),
    ).resolves.toMatchObject({ revision: 1 });
    await expect(access(`${preferencePath}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("quarantines corrupt and inconsistent preferences without touching peers", async () => {
    const fixture = await createFixture();
    const store = await WorkspacePreferenceStore.open(fixture.kodaHome, {
      now: () => "2026-08-27T08:00:00.000Z",
      token: () => "recovery-token",
    });
    await store.update({
      workspace: fixture.secondWorkspace,
      provider: "kimi",
      model: "kimi-test",
      expectedRevision: 0,
    });
    const corruptPath = store.pathForWorkspace(fixture.firstWorkspace);
    await writeFile(corruptPath, "{not-json}\n", { mode: 0o600 });

    const recovered = await store.get(fixture.firstWorkspace);
    expect(recovered).toMatchObject({
      revision: 0,
      diagnostics: [{ code: "SETTINGS_CORRUPT" }],
      recovery: {
        preferenceBackup: expect.stringContaining(".corrupt-"),
      },
    });
    if (recovered.recovery === undefined) {
      throw new Error("Corrupt preference was not quarantined.");
    }
    await expect(
      access(recovered.recovery.preferenceBackup),
    ).resolves.toBeUndefined();
    await expect(store.get(fixture.secondWorkspace)).resolves.toMatchObject({
      revision: 1,
      preference: { provider: "kimi", model: "kimi-test" },
    });
  });

  it("rejects unsafe model identifiers before any file is written", async () => {
    const fixture = await createFixture();
    const store = await WorkspacePreferenceStore.open(fixture.kodaHome);

    await expect(
      store.update({
        workspace: fixture.firstWorkspace,
        provider: "openai",
        model: "bad\nmodel",
        expectedRevision: 0,
      }),
    ).rejects.toThrow();
    await expect(
      access(store.pathForWorkspace(fixture.firstWorkspace)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not follow a non-regular preference target", async () => {
    const fixture = await createFixture();
    const store = await WorkspacePreferenceStore.open(fixture.kodaHome, {
      token: () => "directory-backup",
    });
    const path = store.pathForWorkspace(fixture.firstWorkspace);
    await mkdir(path);
    await chmod(path, 0o700);

    const recovered = await store.get(fixture.firstWorkspace);
    expect(recovered.recovery?.preferenceBackup).toContain(".corrupt-");
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createFixture(): Promise<{
  root: string;
  kodaHome: string;
  firstWorkspace: string;
  secondWorkspace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "koda-runtime-settings-"));
  temporaryDirectories.push(root);
  const firstWorkspace = join(root, "first");
  const secondWorkspace = join(root, "second");
  await mkdir(firstWorkspace);
  await mkdir(secondWorkspace);
  return {
    root,
    kodaHome: join(root, "state"),
    firstWorkspace,
    secondWorkspace,
  };
}
