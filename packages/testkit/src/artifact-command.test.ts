import { access, mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createProgram,
  runCommand,
  type RunCommandDependencies,
  type TextWriter,
} from "@koda/cli";
import { threadIdSchema, turnIdSchema } from "@koda/protocol";
import {
  ArtifactMaintenanceLease,
  ArtifactStore,
  ReadOnlyWorkspace,
} from "@koda/runtime-node";
import { afterEach, describe, expect, it } from "vitest";

import { DeterministicItemIdFactory } from "./deterministic.js";

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

describe("artifact gc CLI", () => {
  it("previews and explicitly deletes artifacts without provider credentials", async () => {
    const root = await createRoot();
    const kodaHome = join(root, "state");
    const store = await ArtifactStore.open(join(kodaHome, "artifacts"));
    const output = await store.materializeText("orphan".repeat(20), {
      inlineBytes: 8,
    });
    if (output.artifact === undefined) {
      throw new Error("Expected an artifact-backed output.");
    }
    const path = artifactPath(kodaHome, output.artifact.sha256);
    await utimes(path, new Date(0), new Date(0));

    const dryRun = await invoke(kodaHome, root, [
      "artifact",
      "gc",
      "--min-age-hours",
      "0",
    ]);
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout.value).toContain("Artifact GC dry run");
    expect(dryRun.stdout.value).toContain("Deletion candidates: 1");
    expect(dryRun.stdout.value).toContain("Deleted artifacts: 0");
    await expect(access(path)).resolves.toBeUndefined();

    const deleted = await invoke(kodaHome, root, [
      "artifact",
      "gc",
      "--delete",
      "--min-age-hours",
      "0",
    ]);
    expect(deleted.exitCode).toBe(0);
    expect(deleted.stdout.value).toContain("Artifact GC delete");
    expect(deleted.stdout.value).toContain("Deleted artifacts: 1");
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns a usage error for an invalid minimum age", async () => {
    const root = await createRoot();
    const result = await invoke(join(root, "state"), root, [
      "artifact",
      "gc",
      "--min-age-hours",
      "forever",
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr.value).toContain(
      "Artifact minimum age must be a non-negative number of hours",
    );
  });

  it("prevents a new run from publishing while maintenance owns the global lease", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "repo");
    const kodaHome = join(root, "state");
    await mkdir(workspaceRoot);
    const maintenance = await ArtifactMaintenanceLease.acquire(
      join(kodaHome, "artifacts"),
    );
    let providerCreations = 0;
    const dependencies: RunCommandDependencies = {
      openWorkspace: (path) => ReadOnlyWorkspace.open(path),
      createProvider: () => {
        providerCreations += 1;
        throw new Error("Provider must not be created during maintenance.");
      },
      createApprovalBroker: () => ({
        request: async () => ({ decision: "rejected" }),
      }),
      createIds: () => ({
        threadId: threadIdSchema.parse("gc-blocked-thread"),
        turnId: turnIdSchema.parse("gc-blocked-turn"),
        itemIds: new DeterministicItemIdFactory("gc-blocked-item"),
      }),
    };
    const stderr = new MemoryWriter();

    const exitCode = await runCommand(
      {
        prompt: "Do not start.",
        cwd: workspaceRoot,
        signal: new AbortController().signal,
      },
      {
        environment: {
          OPENAI_API_KEY: "offline-test-key",
          KODA_HOME: kodaHome,
        },
        processDirectory: root,
        stdout: new MemoryWriter(),
        stderr,
      },
      dependencies,
    );

    expect(exitCode).toBe(1);
    expect(providerCreations).toBe(0);
    expect(stderr.value).toContain("ARTIFACT_GC_LOCKED");
    await expect(
      access(join(kodaHome, "threads", "gc-blocked-thread.jsonl.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await maintenance.release();
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "koda-artifact-command-"));
  temporaryDirectories.push(root);
  return root;
}

async function invoke(
  kodaHome: string,
  processDirectory: string,
  args: string[],
): Promise<{
  exitCode: number;
  stdout: MemoryWriter;
  stderr: MemoryWriter;
}> {
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
  return { exitCode, stdout, stderr };
}

function artifactPath(kodaHome: string, sha256: string): string {
  return join(kodaHome, "artifacts", "sha256", sha256.slice(0, 2), sha256);
}
