import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runExtensionListCommand,
  runExtensionReadCommand,
  type TextWriter,
} from "@koda/cli";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class MemoryWriter implements TextWriter {
  public value = "";

  public write(text: string): void {
    this.value += text;
  }
}

describe("CLI extension inspection", () => {
  it("lists and reads validated sources without provider credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-cli-extensions-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const skillDirectory = join(workspace, ".koda", "skills", "cli-review");
    await mkdir(skillDirectory, { recursive: true });
    const source =
      "---\nname: cli-review\ndescription: Review from the CLI.\n---\nReview this source through the credential-free CLI.\n";
    await writeFile(join(skillDirectory, "SKILL.md"), source);
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const context = {
      environment: { KODA_HOME: join(root, "state") },
      processDirectory: root,
      stdout,
      stderr,
    };

    await expect(runExtensionListCommand({ workspace }, context)).resolves.toBe(
      0,
    );
    expect(stdout.value).toContain("Skills (1)");
    expect(stdout.value).toContain("cli-review");
    expect(stderr.value).toBe("");
    const skillId = stdout.value.match(/skill:[a-f0-9]{64}/u)?.[0];
    if (skillId === undefined) {
      throw new Error("CLI extension list did not expose the Skill ID.");
    }

    stdout.value = "";
    await expect(
      runExtensionReadCommand("skill", skillId, { workspace }, context),
    ).resolves.toBe(0);
    expect(stdout.value).toBe(source);
    expect(stderr.value).toBe("");
  });

  it("rejects a source ID from the wrong extension kind before discovery", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    await expect(
      runExtensionReadCommand(
        "command-template",
        `skill:${"a".repeat(64)}`,
        {},
        {
          environment: {},
          processDirectory: process.cwd(),
          stdout,
          stderr,
        },
      ),
    ).resolves.toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("does not match extension kind");
  });
});
