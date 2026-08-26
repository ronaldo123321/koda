import {
  diffRepositoryInstructionSnapshots,
  loadRepositoryInstructions,
} from "@koda/runtime-node";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

describe("loadRepositoryInstructions", () => {
  it("loads AGENTS.md before KODA.md with hashes and byte counts", async () => {
    const root = await createWorkspace();
    const agents = "Use pnpm for validation.\n";
    const koda = "Prefer focused tests.\n";
    await writeFile(join(root, "KODA.md"), koda);
    await writeFile(join(root, "AGENTS.md"), agents);

    const result = await loadRepositoryInstructions(root);

    expect(result.sources).toEqual([
      {
        path: "AGENTS.md",
        scope: ".",
        bytes: Buffer.byteLength(agents),
        sha256: sha256(agents),
        content: agents,
      },
      {
        path: "KODA.md",
        scope: ".",
        bytes: Buffer.byteLength(koda),
        sha256: sha256(koda),
        content: koda,
      },
    ]);
    expect(result.totalBytes).toBe(
      Buffer.byteLength(agents) + Buffer.byteLength(koda),
    );
  });

  it("returns an empty set when root instruction files are absent", async () => {
    const root = await createWorkspace();

    await expect(loadRepositoryInstructions(root)).resolves.toEqual({
      sources: [],
      totalBytes: 0,
    });
  });

  it("ignores parents and discovers nested instructions broad-to-deep", async () => {
    const parent = await createWorkspace();
    const root = join(parent, "workspace");
    await mkdir(root);
    await mkdir(join(root, "nested", "deeper"), { recursive: true });
    await writeFile(join(parent, "AGENTS.md"), "Parent instructions\n");
    await writeFile(join(root, "KODA.md"), "Root instructions\n");
    await writeFile(join(root, "nested", "AGENTS.md"), "Nested agents\n");
    await writeFile(join(root, "nested", "KODA.md"), "Nested instructions\n");
    await writeFile(
      join(root, "nested", "deeper", "KODA.md"),
      "Deep instructions\n",
    );

    const result = await loadRepositoryInstructions(root);

    expect(result.sources.map(({ path, scope }) => ({ path, scope }))).toEqual([
      { path: "KODA.md", scope: "." },
      { path: "nested/AGENTS.md", scope: "nested" },
      { path: "nested/KODA.md", scope: "nested" },
      { path: "nested/deeper/KODA.md", scope: "nested/deeper" },
    ]);
    expect(result.sources.map((source) => source.content)).not.toContain(
      "Parent instructions\n",
    );
  });

  it("does not discover instructions in runtime and dependency directories", async () => {
    const root = await createWorkspace();
    for (const directory of [".git", ".koda", "node_modules"]) {
      await mkdir(join(root, directory));
      await writeFile(join(root, directory, "AGENTS.md"), `${directory}\n`);
    }

    await expect(loadRepositoryInstructions(root)).resolves.toEqual({
      sources: [],
      totalBytes: 0,
    });
  });

  it("does not follow symlinked instruction directories", async () => {
    const root = await createWorkspace();
    const outside = await createWorkspace();
    await writeFile(join(outside, "AGENTS.md"), "Outside scope\n");
    await symlink(outside, join(root, "linked"));

    await expect(loadRepositoryInstructions(root)).resolves.toEqual({
      sources: [],
      totalBytes: 0,
    });
  });

  it("rejects symlinked and non-file instruction sources", async () => {
    const root = await createWorkspace();
    const outside = await createWorkspace();
    await writeFile(join(outside, "instructions.md"), "Outside\n");
    await symlink(join(outside, "instructions.md"), join(root, "AGENTS.md"));

    await expect(loadRepositoryInstructions(root)).rejects.toMatchObject({
      code: "INSTRUCTION_SYMLINK_FORBIDDEN",
    });

    await rm(join(root, "AGENTS.md"));
    await mkdir(join(root, "KODA.md"));
    await expect(loadRepositoryInstructions(root)).rejects.toMatchObject({
      code: "INSTRUCTION_INVALID_TYPE",
    });
  });

  it("rejects binary and invalid UTF-8 instruction sources", async () => {
    const binaryRoot = await createWorkspace();
    await writeFile(join(binaryRoot, "AGENTS.md"), Buffer.from([65, 0, 66]));
    await expect(loadRepositoryInstructions(binaryRoot)).rejects.toMatchObject({
      code: "INSTRUCTION_INVALID_ENCODING",
    });

    const invalidRoot = await createWorkspace();
    await writeFile(join(invalidRoot, "KODA.md"), Buffer.from([0xc3, 0x28]));
    await expect(loadRepositoryInstructions(invalidRoot)).rejects.toMatchObject(
      { code: "INSTRUCTION_INVALID_ENCODING" },
    );
  });

  it("rejects an instruction file above the byte limit", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "AGENTS.md"), Buffer.alloc(65_537, 65));

    await expect(loadRepositoryInstructions(root)).rejects.toMatchObject({
      code: "INSTRUCTION_TOO_LARGE",
    });
  });

  it("rejects more than 32 scoped instruction sources", async () => {
    const root = await createWorkspace();
    for (let index = 0; index < 33; index += 1) {
      const directory = join(
        root,
        `package-${index.toString().padStart(2, "0")}`,
      );
      await mkdir(directory);
      await writeFile(join(directory, "AGENTS.md"), "Scoped\n");
    }

    await expect(loadRepositoryInstructions(root)).rejects.toMatchObject({
      code: "INSTRUCTION_TOO_MANY",
    });
  });

  it("rejects instruction sources above the combined byte limit", async () => {
    const root = await createWorkspace();
    for (let index = 0; index < 5; index += 1) {
      const directory = join(root, `large-${index}`);
      await mkdir(directory);
      await writeFile(join(directory, "KODA.md"), Buffer.alloc(60_000, 65));
    }

    await expect(loadRepositoryInstructions(root)).rejects.toMatchObject({
      code: "INSTRUCTION_TOO_LARGE",
    });
  });

  it("diffs added, removed, and changed snapshots deterministically", () => {
    const unchanged = {
      path: "AGENTS.md",
      scope: ".",
      bytes: 10,
      sha256: "a".repeat(64),
    };

    expect(
      diffRepositoryInstructionSnapshots(
        [
          unchanged,
          {
            path: "removed/KODA.md",
            scope: "removed",
            bytes: 8,
            sha256: "b".repeat(64),
          },
          {
            path: "src/AGENTS.md",
            scope: "src",
            bytes: 5,
            sha256: "c".repeat(64),
          },
        ],
        [
          unchanged,
          {
            path: "added/KODA.md",
            scope: "added",
            bytes: 4,
            sha256: "d".repeat(64),
          },
          {
            path: "src/AGENTS.md",
            scope: "src",
            bytes: 6,
            sha256: "e".repeat(64),
          },
        ],
      ),
    ).toEqual([
      { path: "added/KODA.md", scope: "added", change: "added" },
      { path: "removed/KODA.md", scope: "removed", change: "removed" },
      { path: "src/AGENTS.md", scope: "src", change: "changed" },
    ]);
  });
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "koda-instructions-"));
  temporaryDirectories.push(root);
  return root;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
