import { loadRepositoryInstructions } from "@koda/runtime-node";
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
        bytes: Buffer.byteLength(agents),
        sha256: sha256(agents),
        content: agents,
      },
      {
        path: "KODA.md",
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

  it("does not discover instruction files above or below the workspace root", async () => {
    const parent = await createWorkspace();
    const root = join(parent, "workspace");
    await mkdir(root);
    await mkdir(join(root, "nested"));
    await writeFile(join(parent, "AGENTS.md"), "Parent instructions\n");
    await writeFile(join(root, "nested", "KODA.md"), "Nested instructions\n");

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
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "koda-instructions-"));
  temporaryDirectories.push(root);
  return root;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
