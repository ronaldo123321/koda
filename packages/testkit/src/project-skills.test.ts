import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolRegistry } from "@koda/agent-core";
import {
  skillIdSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
} from "@koda/protocol";
import {
  MAX_SKILL_FILE_BYTES,
  buildSkillCatalogInstructions,
  diffProjectSkillSnapshots,
  loadProjectSkills,
  registerProjectSkillTool,
} from "@koda/runtime-node";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("project Skills", () => {
  it("discovers scoped Skills broad-to-deep with stable frozen metadata", async () => {
    const root = await createWorkspace();
    const rootSkill = skillDocument(
      "review",
      "Review correctness and tests.",
      "Check the implementation carefully.",
    );
    const nestedSkill = skillDocument(
      "review",
      "Review the UI package.",
      "Check rendering and keyboard behavior.",
    );
    const testSkill = skillDocument(
      "testing",
      "Run focused validation.",
      "Prefer the narrowest relevant test.",
    );
    await writeSkill(root, ".", "review", rootSkill);
    await writeSkill(root, ".", "testing", testSkill);
    await writeSkill(root, "packages/ui", "review", nestedSkill);

    const catalog = await loadProjectSkills(root);

    expect(
      catalog.sources.map((source) => ({
        name: source.name,
        path: source.path,
        scope: source.scope,
      })),
    ).toEqual([
      {
        name: "review",
        path: ".koda/skills/review/SKILL.md",
        scope: ".",
      },
      {
        name: "testing",
        path: ".koda/skills/testing/SKILL.md",
        scope: ".",
      },
      {
        name: "review",
        path: "packages/ui/.koda/skills/review/SKILL.md",
        scope: "packages/ui",
      },
    ]);
    expect(catalog.sources[0]).toMatchObject({
      bytes: Buffer.byteLength(rootSkill),
      sha256: sha256(rootSkill),
      content: rootSkill,
    });
    expect(catalog.sources[0]?.skillId).toMatch(/^skill:[a-f0-9]{64}$/u);
    expect(catalog.totalBytes).toBe(
      Buffer.byteLength(rootSkill) +
        Buffer.byteLength(testSkill) +
        Buffer.byteLength(nestedSkill),
    );
    expect(buildSkillCatalogInstructions(catalog)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("read_skill"),
        expect.stringContaining("review: Review correctness and tests."),
        expect.stringContaining("scope packages/ui"),
      ]),
    );
  });

  it("reads immutable Skill content through one built-in read tool", async () => {
    const root = await createWorkspace();
    const original = skillDocument(
      "testing",
      "Run focused validation.",
      "Run the original test instructions.",
    );
    const path = await writeSkill(root, ".", "testing", original);
    const catalog = await loadProjectSkills(root);
    const source = catalog.sources[0]!;
    const registry = new ToolRegistry();
    registerProjectSkillTool(registry, catalog);
    await writeFile(
      path,
      skillDocument(
        "testing",
        "Changed after discovery.",
        "These bytes must not enter the current Turn.",
      ),
    );

    expect(registry.definitions()).toEqual([
      expect.objectContaining({
        name: "read_skill",
        inputJsonSchema: expect.objectContaining({
          properties: {
            skill_id: { type: "string", enum: [source.skillId] },
          },
        }),
      }),
    ]);
    const prepared = await registry.prepare(
      {
        callId: toolCallIdSchema.parse("skill-call"),
        name: "read_skill",
        arguments: { skill_id: source.skillId },
      },
      {
        threadId: threadIdSchema.parse("skill-thread"),
        turnId: turnIdSchema.parse("skill-turn"),
        signal: new AbortController().signal,
      },
    );
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") {
      return;
    }
    expect(prepared.invocation.effect).toBe("read");
    await expect(prepared.invocation.execute()).resolves.toEqual({
      status: "success",
      output: {
        skill_id: source.skillId,
        name: "testing",
        description: "Run focused validation.",
        path: ".koda/skills/testing/SKILL.md",
        scope: ".",
        bytes: Buffer.byteLength(original),
        sha256: sha256(original),
        content: original,
      },
    });

    const invalid = await registry.prepare(
      {
        callId: toolCallIdSchema.parse("unknown-skill-call"),
        name: "read_skill",
        arguments: { skill_id: skillIdSchema.parse(`skill:${"f".repeat(64)}`) },
      },
      {
        threadId: threadIdSchema.parse("skill-thread"),
        turnId: turnIdSchema.parse("skill-turn"),
        signal: new AbortController().signal,
      },
    );
    expect(invalid).toMatchObject({
      status: "error",
      result: { error: { code: "INVALID_TOOL_ARGUMENTS" } },
    });
  });

  it("does not register read_skill for an empty catalog", async () => {
    const root = await createWorkspace();
    const catalog = await loadProjectSkills(root);
    const registry = new ToolRegistry();

    registerProjectSkillTool(registry, catalog);

    expect(catalog.sources).toEqual([]);
    expect(catalog.totalBytes).toBe(0);
    expect(catalog.snapshots()).toEqual([]);
    expect(registry.definitions()).toEqual([]);
  });

  it.each([
    {
      label: "missing delimiters",
      content: "name: invalid\ndescription: invalid\nBody\n",
    },
    {
      label: "unknown fields",
      content:
        "---\nname: invalid\ndescription: Invalid.\nscripts: true\n---\nBody\n",
    },
    {
      label: "multiline fields",
      content: "---\nname: invalid\ndescription: |\n  Invalid.\n---\nBody\n",
    },
    {
      label: "empty body",
      content: "---\nname: invalid\ndescription: Invalid.\n---\n   \n",
    },
    {
      label: "name mismatch",
      content: "---\nname: another\ndescription: Invalid.\n---\nBody\n",
    },
  ])("rejects $label", async ({ content }) => {
    const root = await createWorkspace();
    await writeSkill(root, ".", "invalid", content);

    await expect(loadProjectSkills(root)).rejects.toMatchObject({
      code: "SKILL_INVALID_FRONTMATTER",
    });
  });

  it("rejects invalid UTF-8, NUL bytes, oversized files, and too many Skills", async () => {
    const invalidUtf8Root = await createWorkspace();
    const invalidUtf8Path = await writeSkill(
      invalidUtf8Root,
      ".",
      "invalid",
      skillDocument("invalid", "Invalid bytes.", "Body."),
    );
    await writeFile(invalidUtf8Path, Buffer.from([0xc3, 0x28]));
    await expect(loadProjectSkills(invalidUtf8Root)).rejects.toMatchObject({
      code: "SKILL_INVALID_ENCODING",
    });

    const binaryRoot = await createWorkspace();
    const binaryPath = await writeSkill(
      binaryRoot,
      ".",
      "binary",
      skillDocument("binary", "Binary bytes.", "Body."),
    );
    await writeFile(binaryPath, Buffer.from([65, 0, 66]));
    await expect(loadProjectSkills(binaryRoot)).rejects.toMatchObject({
      code: "SKILL_INVALID_ENCODING",
    });

    const largeRoot = await createWorkspace();
    const largePath = await writeSkill(
      largeRoot,
      ".",
      "large",
      skillDocument("large", "Large Skill.", "Body."),
    );
    await writeFile(largePath, Buffer.alloc(MAX_SKILL_FILE_BYTES + 1, 65));
    await expect(loadProjectSkills(largeRoot)).rejects.toMatchObject({
      code: "SKILL_TOO_LARGE",
    });

    const combinedRoot = await createWorkspace();
    for (let index = 0; index < 5; index += 1) {
      const name = `large-${index}`;
      await writeSkill(
        combinedRoot,
        ".",
        name,
        skillDocument(name, `Combined Skill ${index}.`, "x".repeat(40_000)),
      );
    }
    await expect(loadProjectSkills(combinedRoot)).rejects.toMatchObject({
      code: "SKILL_TOO_LARGE",
    });

    const manyRoot = await createWorkspace();
    for (let index = 0; index < 33; index += 1) {
      const name = `skill-${index.toString().padStart(2, "0")}`;
      await writeSkill(
        manyRoot,
        ".",
        name,
        skillDocument(name, `Skill ${index}.`, "Body."),
      );
    }
    await expect(loadProjectSkills(manyRoot)).rejects.toMatchObject({
      code: "SKILL_TOO_MANY",
    });
  });

  it("rejects symlinked Skill containers and sources", async () => {
    if (process.platform === "win32") {
      return;
    }
    const containerRoot = await createWorkspace();
    const outside = await createWorkspace();
    await mkdir(join(containerRoot, ".koda"));
    await symlink(outside, join(containerRoot, ".koda", "skills"));
    await expect(loadProjectSkills(containerRoot)).rejects.toMatchObject({
      code: "SKILL_SYMLINK_FORBIDDEN",
    });

    const sourceRoot = await createWorkspace();
    const sourceDirectory = join(sourceRoot, ".koda", "skills", "linked");
    await mkdir(sourceDirectory, { recursive: true });
    const outsideFile = join(outside, "SKILL.md");
    await writeFile(
      outsideFile,
      skillDocument("linked", "Outside Skill.", "Body."),
    );
    await symlink(outsideFile, join(sourceDirectory, "SKILL.md"));
    await expect(loadProjectSkills(sourceRoot)).rejects.toMatchObject({
      code: "SKILL_SYMLINK_FORBIDDEN",
    });
  });

  it("diffs added, removed, and changed Skill snapshots deterministically", () => {
    const unchanged = snapshot("unchanged", "a", 10);
    const removed = snapshot("removed", "b", 11);
    const changed = snapshot("changed", "c", 12);
    const added = snapshot("added", "d", 13);

    expect(
      diffProjectSkillSnapshots(
        [unchanged, removed, changed],
        [unchanged, { ...changed, bytes: 14, sha256: "e".repeat(64) }, added],
      ),
    ).toEqual([
      expect.objectContaining({ name: "added", change: "added" }),
      expect.objectContaining({ name: "changed", change: "changed" }),
      expect.objectContaining({ name: "removed", change: "removed" }),
    ]);
  });
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "koda-project-skills-"));
  temporaryDirectories.push(root);
  return root;
}

async function writeSkill(
  root: string,
  scope: string,
  name: string,
  content: string,
): Promise<string> {
  const directory = join(
    root,
    ...(scope === "." ? [] : scope.split("/")),
    ".koda",
    "skills",
    name,
  );
  await mkdir(directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  await writeFile(path, content);
  return path;
}

function skillDocument(
  name: string,
  description: string,
  body: string,
): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function snapshot(name: string, digestCharacter: string, bytes: number) {
  const path = `.koda/skills/${name}/SKILL.md`;
  return {
    skillId: skillIdSchema.parse(
      `skill:${createHash("sha256").update(path).digest("hex")}`,
    ),
    name,
    description: `Description for ${name}.`,
    path,
    scope: ".",
    bytes,
    sha256: digestCharacter.repeat(64),
  };
}
