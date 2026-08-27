import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  artifactReferenceSchema,
  type ArtifactReference,
} from "@koda/protocol";
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

  it("reads contiguous verified UTF-8 ranges in both directions", async () => {
    const { store } = await createStore();
    const content = "开头🙂alpha中间omega尾巴".repeat(20);
    const result = await store.materializeText(content, { inlineBytes: 8 });
    if (result.artifact === undefined) {
      throw new Error("Expected an oversized artifact.");
    }

    const forward: string[] = [];
    let afterByte = 0;
    do {
      const page = await store.readVerifiedTextRange(result.artifact, {
        afterByte,
        maxBytes: 13,
      });
      expect(page.content).not.toContain("�");
      expect(page.startByte).toBe(afterByte);
      forward.push(page.content);
      afterByte = page.endByte;
      if (!page.hasLater) {
        break;
      }
    } while (true);
    expect(forward.join("")).toBe(content);

    const backward: string[] = [];
    let beforeByte = Buffer.byteLength(content);
    do {
      const page = await store.readVerifiedTextRange(result.artifact, {
        beforeByte,
        maxBytes: 13,
      });
      expect(page.content).not.toContain("�");
      expect(page.endByte).toBe(beforeByte);
      backward.unshift(page.content);
      beforeByte = page.startByte;
      if (!page.hasEarlier) {
        break;
      }
    } while (true);
    expect(backward.join("")).toBe(content);
  });

  it("rejects invalid boundaries, media types, and invalid UTF-8", async () => {
    const { store, root } = await createStore();
    const text = await store.materializeText("中文 artifact text", {
      inlineBytes: 4,
    });
    const binary = await store.materializeText("binary-like output", {
      inlineBytes: 4,
      mediaType: "application/octet-stream",
    });
    if (text.artifact === undefined || binary.artifact === undefined) {
      throw new Error("Expected published artifacts.");
    }
    await expect(
      store.readVerifiedTextRange(text.artifact, {
        afterByte: 1,
        maxBytes: 8,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARTIFACT_RANGE" });
    await expect(
      store.readVerifiedTextRange(binary.artifact, {
        afterByte: 0,
        maxBytes: 8,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_MEDIA_TYPE_UNSUPPORTED" });

    const invalid = await writeRawArtifact(
      root,
      Buffer.from([0xc3, 0x28]),
      "text/plain; charset=utf-8",
    );
    await expect(
      store.readVerifiedTextRange(invalid, { afterByte: 0, maxBytes: 8 }),
    ).rejects.toMatchObject({ code: "ARTIFACT_CORRUPT" });
  });

  it("reads empty and long JSON artifacts without breaking byte continuity", async () => {
    const { store, root } = await createStore();
    const empty = await writeRawArtifact(
      root,
      Buffer.alloc(0),
      "text/plain; charset=utf-8",
    );
    await expect(
      store.readVerifiedTextRange(empty, { afterByte: 0, maxBytes: 4 }),
    ).resolves.toMatchObject({
      content: "",
      startByte: 0,
      endByte: 0,
      totalBytes: 0,
      hasEarlier: false,
      hasLater: false,
    });

    const content = JSON.stringify({ value: "中文🙂".repeat(100) });
    const json = await writeRawArtifact(
      root,
      Buffer.from(content),
      "application/json",
    );
    const pages: string[] = [];
    let afterByte = 0;
    do {
      const page = await store.readVerifiedTextRange(json, {
        afterByte,
        maxBytes: 11,
      });
      pages.push(page.content);
      afterByte = page.endByte;
      if (!page.hasLater) {
        break;
      }
    } while (true);
    expect(pages.join("")).toBe(content);
  });

  it("rejects symlinks, size changes, and same-size digest corruption", async () => {
    const { store, root } = await createStore();
    const symlinkContent = Buffer.from("symlink target");
    const symlinkHash = createHash("sha256")
      .update(symlinkContent)
      .digest("hex");
    const symlinkTarget = join(root, "symlink-target");
    await writeFile(symlinkTarget, symlinkContent);
    await mkdir(join(root, "sha256", symlinkHash.slice(0, 2)), {
      recursive: true,
    });
    await symlink(symlinkTarget, artifactPath(root, symlinkHash));
    const symlinkReference = artifactReferenceSchema.parse({
      type: "artifact",
      id: `sha256:${symlinkHash}`,
      sha256: symlinkHash,
      bytes: symlinkContent.byteLength,
      mediaType: "text/plain; charset=utf-8",
    });
    await expect(
      store.readVerifiedTextRange(symlinkReference, {
        afterByte: 0,
        maxBytes: 8,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_CORRUPT" });

    const digestReference = await writeRawArtifact(
      root,
      Buffer.from("digest-original"),
      "text/plain; charset=utf-8",
    );
    await writeFile(
      artifactPath(root, digestReference.sha256),
      "digest-modified",
    );
    await expect(
      store.readVerifiedTextRange(digestReference, {
        afterByte: 0,
        maxBytes: 8,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_CORRUPT" });

    const sizeReference = await writeRawArtifact(
      root,
      Buffer.from("size-original"),
      "text/plain; charset=utf-8",
    );
    await writeFile(
      artifactPath(root, sizeReference.sha256),
      "size-original-expanded",
    );
    await expect(
      store.readVerifiedTextRange(sizeReference, {
        afterByte: 0,
        maxBytes: 8,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_CORRUPT" });
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

async function writeRawArtifact(
  root: string,
  content: Buffer,
  mediaType: string,
): Promise<ArtifactReference> {
  const sha256 = createHash("sha256").update(content).digest("hex");
  const path = artifactPath(root, sha256);
  await mkdir(join(root, "sha256", sha256.slice(0, 2)), { recursive: true });
  await writeFile(path, content);
  return artifactReferenceSchema.parse({
    type: "artifact",
    id: `sha256:${sha256}`,
    sha256,
    bytes: content.byteLength,
    mediaType,
  });
}
