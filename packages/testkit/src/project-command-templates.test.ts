import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commandTemplateIdSchema } from "@koda/protocol";
import {
  MAX_COMMAND_TEMPLATE_FILE_BYTES,
  diffProjectCommandTemplateSnapshots,
  expandProjectCommandTemplatePrompt,
  loadProjectCommandTemplates,
  parseCommandTemplateInvocation,
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

describe("project command templates", () => {
  it("discovers scoped templates broad-to-deep with stable frozen metadata", async () => {
    const root = await createWorkspace();
    const rootTemplate = templateDocument(
      "review",
      "Review one target.",
      [parameter("target", true, 1_024)],
      "Review {{target}} carefully.",
    );
    const nestedTemplate = templateDocument(
      "review",
      "Review the UI target.",
      [parameter("target", true, 512)],
      "Review UI target {{target}}.",
    );
    await writeTemplate(root, ".", "review", rootTemplate);
    await writeTemplate(root, "packages/ui", "review", nestedTemplate);

    const catalog = await loadProjectCommandTemplates(root);

    expect(
      catalog.sources.map((source) => ({
        name: source.name,
        selector: source.selector,
        path: source.path,
        scope: source.scope,
      })),
    ).toEqual([
      {
        name: "review",
        selector: "review",
        path: ".koda/commands/review.md",
        scope: ".",
      },
      {
        name: "review",
        selector: "packages/ui/review",
        path: "packages/ui/.koda/commands/review.md",
        scope: "packages/ui",
      },
    ]);
    expect(catalog.sources[0]).toMatchObject({
      bytes: Buffer.byteLength(rootTemplate),
      sha256: sha256(rootTemplate),
      content: rootTemplate,
      body: "Review {{target}} carefully.\n",
    });
    expect(catalog.sources[0]?.templateId).toMatch(
      /^command-template:[a-f0-9]{64}$/u,
    );
    expect(catalog.snapshots()[0]).not.toHaveProperty("body");
    expect(catalog.snapshots()[0]).not.toHaveProperty("content");
    expect(Object.isFrozen(catalog.sources)).toBe(true);
    expect(Object.isFrozen(catalog.sources[0]?.parameters)).toBe(true);
  });

  it("parses explicit JSON invocations and renders one auditable literal pass", async () => {
    const root = await createWorkspace();
    await writeTemplate(
      root,
      ".",
      "review",
      templateDocument(
        "review",
        "Review one target.",
        [parameter("target", true, 1_024), parameter("focus", false, 512)],
        "Review {{target}}. Focus: {{focus}}.",
      ),
    );
    const catalog = await loadProjectCommandTemplates(root);
    const invocation =
      '/template review {"target":"src/a file.ts","focus":"{{target}} and $HOME"}';

    expect(parseCommandTemplateInvocation(invocation)).toEqual({
      selector: "review",
      arguments: {
        target: "src/a file.ts",
        focus: "{{target}} and $HOME",
      },
    });
    const expanded = expandProjectCommandTemplatePrompt(invocation, catalog);

    expect(expanded?.prompt).toContain("[Koda command template: review;");
    expect(expanded?.prompt).toContain(
      "Review src/a file.ts. Focus: {{target}} and $HOME.",
    );
    expect(expanded?.prompt).not.toContain("Focus: src/a file.ts");
    expect(expanded?.activation).toMatchObject({
      templateId: catalog.sources[0]?.templateId,
      selector: "review",
      templateSha256: catalog.sources[0]?.sha256,
      renderedSha256: sha256(expanded?.prompt ?? ""),
      renderedBytes: Buffer.byteLength(expanded?.prompt ?? ""),
    });
    expect(
      expandProjectCommandTemplatePrompt("Review src/a.ts", catalog),
    ).toBeUndefined();
  });

  it("rejects malformed invocations and invalid argument sets", async () => {
    const root = await createWorkspace();
    await writeTemplate(
      root,
      ".",
      "review",
      templateDocument(
        "review",
        "Review one target.",
        [parameter("target", true, 4)],
        "Review {{target}}.",
      ),
    );
    const catalog = await loadProjectCommandTemplates(root);

    for (const invocation of [
      "/template",
      "/template review []",
      '/template review {"target":1}',
      '/template review {"target":"a","target":"b"}',
      "/template review {invalid}",
    ]) {
      expect(() =>
        expandProjectCommandTemplatePrompt(invocation, catalog),
      ).toThrow(
        expect.objectContaining({
          code: "COMMAND_TEMPLATE_INVALID_INVOCATION",
        }),
      );
    }
    expect(() =>
      expandProjectCommandTemplatePrompt("/template review", catalog),
    ).toThrow(
      expect.objectContaining({
        code: "COMMAND_TEMPLATE_INVALID_ARGUMENT",
      }),
    );
    expect(() =>
      expandProjectCommandTemplatePrompt(
        '/template review {"target":"abcd","extra":"x"}',
        catalog,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "COMMAND_TEMPLATE_INVALID_ARGUMENT",
      }),
    );
    expect(() =>
      expandProjectCommandTemplatePrompt(
        '/template review {"target":"abcde"}',
        catalog,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "COMMAND_TEMPLATE_INVALID_ARGUMENT",
      }),
    );
    expect(() =>
      expandProjectCommandTemplatePrompt("/template absent {}", catalog),
    ).toThrow(
      expect.objectContaining({
        code: "COMMAND_TEMPLATE_INVALID_INVOCATION",
      }),
    );
  });

  it.each([
    {
      label: "unknown frontmatter fields",
      content:
        "---\nname: invalid\ndescription: Invalid.\nargv: [sh]\n---\nBody.\n",
    },
    {
      label: "unknown placeholders",
      content: templateDocument("invalid", "Invalid.", [], "Run {{unknown}}."),
    },
    {
      label: "unused parameters",
      content: templateDocument(
        "invalid",
        "Invalid.",
        [parameter("target", true, 10)],
        "No placeholder.",
      ),
    },
    {
      label: "duplicate parameters",
      content: templateDocument(
        "invalid",
        "Invalid.",
        [parameter("target", true, 10), parameter("target", false, 10)],
        "{{target}}",
      ),
    },
    {
      label: "unsupported parameter types",
      content: templateDocument(
        "invalid",
        "Invalid.",
        [
          {
            name: "target",
            description: "Template argument target.",
            type: "number",
            required: true,
            max_bytes: 10,
          },
        ],
        "{{target}}",
      ),
    },
  ])("rejects $label", async ({ content }) => {
    const root = await createWorkspace();
    await writeTemplate(root, ".", "invalid", content);

    await expect(loadProjectCommandTemplates(root)).rejects.toMatchObject({
      code: "COMMAND_TEMPLATE_INVALID_FRONTMATTER",
    });
  });

  it("rejects invalid encoding, oversized sources, layouts, and symlinks", async () => {
    const invalidUtf8Root = await createWorkspace();
    const invalidUtf8Path = await writeTemplate(
      invalidUtf8Root,
      ".",
      "invalid",
      templateDocument("invalid", "Invalid.", [], "Body."),
    );
    await writeFile(invalidUtf8Path, Buffer.from([0xc3, 0x28]));
    await expect(
      loadProjectCommandTemplates(invalidUtf8Root),
    ).rejects.toMatchObject({ code: "COMMAND_TEMPLATE_INVALID_ENCODING" });

    const largeRoot = await createWorkspace();
    const largePath = await writeTemplate(
      largeRoot,
      ".",
      "large",
      templateDocument("large", "Large.", [], "Body."),
    );
    await writeFile(
      largePath,
      Buffer.alloc(MAX_COMMAND_TEMPLATE_FILE_BYTES + 1, 65),
    );
    await expect(loadProjectCommandTemplates(largeRoot)).rejects.toMatchObject({
      code: "COMMAND_TEMPLATE_TOO_LARGE",
    });

    const layoutRoot = await createWorkspace();
    await mkdir(join(layoutRoot, ".koda", "commands", "nested"), {
      recursive: true,
    });
    await expect(loadProjectCommandTemplates(layoutRoot)).rejects.toMatchObject(
      { code: "COMMAND_TEMPLATE_INVALID_LAYOUT" },
    );

    if (process.platform !== "win32") {
      const linkedRoot = await createWorkspace();
      const outside = await createWorkspace();
      await mkdir(join(linkedRoot, ".koda"), { recursive: true });
      await symlink(outside, join(linkedRoot, ".koda", "commands"));
      await expect(
        loadProjectCommandTemplates(linkedRoot),
      ).rejects.toMatchObject({ code: "COMMAND_TEMPLATE_SYMLINK_FORBIDDEN" });
    }
  });

  it("diffs added, removed, and changed snapshots deterministically", () => {
    const unchanged = snapshot("unchanged", "a", 10);
    const removed = snapshot("removed", "b", 11);
    const changed = snapshot("changed", "c", 12);
    const added = snapshot("added", "d", 13);

    expect(
      diffProjectCommandTemplateSnapshots(
        [unchanged, removed, changed],
        [unchanged, { ...changed, bytes: 14, sha256: "e".repeat(64) }, added],
      ),
    ).toEqual([
      expect.objectContaining({ selector: "added", change: "added" }),
      expect.objectContaining({ selector: "changed", change: "changed" }),
      expect.objectContaining({ selector: "removed", change: "removed" }),
    ]);
  });
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "koda-command-templates-"));
  temporaryDirectories.push(root);
  return root;
}

async function writeTemplate(
  root: string,
  scope: string,
  name: string,
  content: string,
): Promise<string> {
  const directory = join(
    root,
    ...(scope === "." ? [] : scope.split("/")),
    ".koda",
    "commands",
  );
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${name}.md`);
  await writeFile(path, content);
  return path;
}

function parameter(name: string, required: boolean, maximumBytes: number) {
  return {
    name,
    description: `Template argument ${name}.`,
    type: "string",
    required,
    max_bytes: maximumBytes,
  };
}

function templateDocument(
  name: string,
  description: string,
  parameters: readonly unknown[],
  body: string,
): string {
  return `---\nname: ${name}\ndescription: ${description}\nparameters: ${JSON.stringify(parameters)}\n---\n${body}\n`;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function snapshot(name: string, digestCharacter: string, bytes: number) {
  const path = `.koda/commands/${name}.md`;
  return {
    templateId: commandTemplateIdSchema.parse(
      `command-template:${createHash("sha256").update(path).digest("hex")}`,
    ),
    name,
    description: `Description for ${name}.`,
    selector: name,
    path,
    scope: ".",
    bytes,
    sha256: digestCharacter.repeat(64),
    parameters: [],
  };
}
