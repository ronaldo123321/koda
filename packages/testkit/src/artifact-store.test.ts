import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArtifactStore } from "@koda/runtime-node";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ArtifactStore", () => {
  it("keeps small output inline without publishing a blob", async () => {
    const { store, root } = await createStore();

    const result = await store.materializeText("small output", {
      inlineBytes: 64,
    });

    expect(result).toEqual({
      text: "small output",
      totalBytes: 12,
      truncated: false,
    });
    expect(await readdir(join(root, "tmp"))).toEqual([]);
    expect(await listPublishedHashes(root)).toEqual([]);
  });

  it("publishes oversized output by digest and deduplicates it", async () => {
    const { store, root } = await createStore();
    const content = "0123456789abcdefghijklmnopqrstuvwxyz".repeat(20);

    const first = await store.materializeText(content, { inlineBytes: 128 });
    const second = await store.materializeText(content, { inlineBytes: 128 });

    expect(first.artifact).toBeDefined();
    expect(second.artifact).toEqual(first.artifact);
    expect(first.artifact?.id).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.artifact?.bytes).toBe(Buffer.byteLength(content));
    expect(first.text).toContain("bytes omitted");
    expect(first.text).toContain(first.artifact?.id);
    expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(128);
    expect(await listPublishedHashes(root)).toEqual([first.artifact?.sha256]);
    const full = await store.readRange(first.artifact?.id ?? "", 0, 65_536);
    expect(full.content).toBe(content);
    expect(full.truncated).toBe(false);
  });

  it("renders UTF-8-safe excerpts and bounded ranges", async () => {
    const { store } = await createStore();
    const content = "开头-alpha-middle-omega-尾巴";
    const result = await store.materializeText(content, { inlineBytes: 16 });
    if (result.artifact === undefined) {
      throw new Error("Expected an oversized artifact.");
    }

    expect(result.text).not.toContain("�");
    const range = await store.readRange(result.artifact.id, 7, 8);
    expect(range.startByte).toBe(7);
    expect(range.endByte).toBe(15);
    expect(range.totalBytes).toBe(Buffer.byteLength(content));
    expect(range.truncated).toBe(true);
  });

  it("reports missing and corrupt artifact references", async () => {
    const { store, root } = await createStore();
    const missingResult = await store.materializeText("missing artifact data", {
      inlineBytes: 4,
    });
    const corruptResult = await store.materializeText("corrupt artifact data", {
      inlineBytes: 4,
    });
    if (
      missingResult.artifact === undefined ||
      corruptResult.artifact === undefined
    ) {
      throw new Error("Expected artifact references.");
    }
    await rm(artifactPath(root, missingResult.artifact.sha256));
    await writeFile(
      artifactPath(root, corruptResult.artifact.sha256),
      "same-size-corruption!",
    );

    await expect(
      store.findUnavailable([missingResult.artifact, corruptResult.artifact]),
    ).resolves.toEqual([
      { id: missingResult.artifact.id, reason: "missing" },
      { id: corruptResult.artifact.id, reason: "corrupt" },
    ]);
  });

  it("removes stale temporary captures when opening", async () => {
    const root = await createRoot();
    const temporaryRoot = join(root, "tmp");
    await mkdir(temporaryRoot, { recursive: true });
    const stale = join(temporaryRoot, "stale.part");
    const recent = join(temporaryRoot, "recent.part");
    await writeFile(stale, "stale");
    await writeFile(recent, "recent");
    await utimes(stale, new Date(0), new Date(0));
    await utimes(recent, new Date(9_500), new Date(9_500));

    await ArtifactStore.open(root, {
      staleTemporaryFileAgeMs: 1_000,
      now: () => 10_000,
    });

    await expect(access(stale)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(recent)).resolves.toBeUndefined();
  });

  it("fails closed and cleans up when a capture exceeds its hard limit", async () => {
    const { store, root } = await createStore();

    await expect(
      store.materializeText("x".repeat(17), {
        inlineBytes: 8,
        maxBytes: 16,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_OUTPUT_LIMIT_EXCEEDED" });
    expect(await readdir(join(root, "tmp"))).toEqual([]);
    expect(await listPublishedHashes(root)).toEqual([]);
  });
});

async function createStore(): Promise<{
  store: ArtifactStore;
  root: string;
}> {
  const root = await createRoot();
  return { store: await ArtifactStore.open(root), root };
}

async function createRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "koda-artifacts-"));
  temporaryDirectories.push(directory);
  return join(directory, "artifacts");
}

async function listPublishedHashes(root: string): Promise<string[]> {
  const prefixRoot = join(root, "sha256");
  const prefixes = await readdir(prefixRoot);
  const hashes = await Promise.all(
    prefixes.map((prefix) => readdir(join(prefixRoot, prefix))),
  );
  return hashes.flat().sort();
}

function artifactPath(root: string, sha256: string): string {
  return join(root, "sha256", sha256.slice(0, 2), sha256);
}
