import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProgram, type TextWriter } from "@koda/cli";
import { WorkspaceMutationJournalStore } from "@koda/runtime-node";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("workspace mutation recovery CLI", () => {
  it("lists inspected evidence and exports a token-bound backup to a new file", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-recovery-cli-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "repo");
    const kodaHome = join(root, "state");
    await mkdir(workspace);
    await mkdir(kodaHome);
    const before = Buffer.from("before\n");
    const after = Buffer.from("after\n");
    await writeFile(join(workspace, "tracked.txt"), before);
    const journal = await WorkspaceMutationJournalStore.open(
      kodaHome,
      workspace,
    );
    await journal.begin({
      identity: {
        threadId: "cli-recovery-thread",
        turnId: "cli-recovery-turn",
        callId: "cli-recovery-call",
        toolName: "apply_changes",
      },
      planSha256: hash("cli-recovery-plan"),
      changes: [
        {
          index: 0,
          operation: "update",
          path: "tracked.txt",
          beforeSha256: hash(before),
          afterSha256: hash(after),
          bytes: after.byteLength,
          beforeMode: 0o644,
          afterMode: 0o644,
          beforeBytes: before,
          stagedPath:
            ".tracked.txt.koda-change-00000000-0000-4000-8000-000000000000.tmp",
        },
      ],
    });
    await writeFile(join(workspace, "tracked.txt"), "external\n");
    await journal.recoverPending();
    const [conflict] = await journal.listConflicts();

    const listed = await runCli(
      ["recovery", "list", "--workspace", workspace],
      root,
      kodaHome,
    );
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain(conflict!.conflictId);
    expect(listed.stdout).toContain(conflict!.stateToken);
    expect(listed.stdout).not.toContain("before\\n");

    const output = join(root, "original.txt");
    const exported = await runCli(
      [
        "recovery",
        "export",
        conflict!.conflictId,
        "0",
        "--workspace",
        workspace,
        "--state-token",
        conflict!.stateToken,
        "--output",
        output,
      ],
      root,
      kodaHome,
    );
    expect(exported.exitCode).toBe(0);
    expect(exported.stderr).toBe("");
    await expect(readFile(output)).resolves.toEqual(before);

    const repeated = await runCli(
      [
        "recovery",
        "export",
        conflict!.conflictId,
        "0",
        "--workspace",
        workspace,
        "--state-token",
        conflict!.stateToken,
        "--output",
        output,
      ],
      root,
      kodaHome,
    );
    expect(repeated.exitCode).toBe(1);
    expect(repeated.stderr).toContain("EEXIST");
    await expect(readFile(output)).resolves.toEqual(before);
  });
});

async function runCli(
  args: string[],
  processDirectory: string,
  kodaHome: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  let exitCode = -1;
  const program = createProgram({
    environment: { KODA_HOME: kodaHome },
    processDirectory,
    stdout,
    stderr,
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  await program.parseAsync(["node", "koda", ...args]);
  return { exitCode, stdout: stdout.value, stderr: stderr.value };
}

class MemoryWriter implements TextWriter {
  public value = "";

  public write(chunk: string): void {
    this.value += chunk;
  }
}

function hash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}
