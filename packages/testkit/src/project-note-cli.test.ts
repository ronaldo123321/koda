import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProgram, type TextWriter } from "@koda/cli";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

class Writer implements TextWriter {
  public value = "";
  public write(text: string): void {
    this.value += text;
  }
}

describe("project note CLI", () => {
  it("lets a user add, inspect, edit, search, and delete a project note", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-note-cli-"));
    roots.push(root);
    const workspace = join(root, "repo");
    const other = join(root, "other");
    await Promise.all([mkdir(workspace), mkdir(other)]);
    const state = join(root, "state");
    const run = async (...args: string[]) => {
      const stdout = new Writer();
      const stderr = new Writer();
      let exitCode = 0;
      const program = createProgram({
        environment: { KODA_HOME: state },
        processDirectory: root,
        stdout,
        stderr,
        setExitCode: (code) => {
          exitCode = code;
        },
      });
      await program.parseAsync(["node", "koda", ...args]);
      return { stdout: stdout.value, stderr: stderr.value, exitCode };
    };
    const added = await run(
      "memory",
      "add",
      "Release workflow",
      "--body",
      "Run smoke tests before release.",
      "--workspace",
      workspace,
    );
    expect(added.exitCode).toBe(0);
    const id = added.stdout.match(/Created project note ([A-Za-z0-9-]+)/u)?.[1];
    expect(id).toBeDefined();
    expect((await run("memory", "list", "--workspace", other)).stdout).toBe(
      "No project notes found.\n",
    );
    expect(
      (await run("memory", "show", id!, "--workspace", workspace)).stdout,
    ).toContain("Run smoke tests before release.");

    const replacement = join(root, "replacement.txt");
    await writeFile(replacement, "Run signed smoke tests before release.\n");
    const edited = await run(
      "memory",
      "edit",
      id!,
      "--file",
      replacement,
      "--workspace",
      workspace,
    );
    expect(edited).toMatchObject({ exitCode: 0 });
    expect(edited.stdout).toContain("revision 2");
    expect(
      (await run("memory", "search", "signed smoke", "--workspace", workspace))
        .stdout,
    ).toContain(id);
    expect(
      (await run("memory", "delete", id!, "--workspace", workspace)).exitCode,
    ).toBe(0);
    expect((await run("memory", "list", "--workspace", workspace)).stdout).toBe(
      "No project notes found.\n",
    );
  });
});
