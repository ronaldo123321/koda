import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  itemIdSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type AgentEvent,
  type ArtifactReference,
} from "@koda/protocol";
import {
  ArtifactGarbageCollector,
  ArtifactMaintenanceLease,
  ArtifactStore,
  JsonlEventStore,
  ThreadLease,
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

describe("ArtifactGarbageCollector", () => {
  it("derives reachability from JSONL and deletes only old unreferenced blobs", async () => {
    const { kodaHome, artifactStore } = await createState();
    const direct = await createArtifact(artifactStore, "direct-reference");
    const nested = await createArtifact(artifactStore, "nested-reference");
    const orphan = await createArtifact(artifactStore, "old-orphan");
    const young = await createArtifact(artifactStore, "young-orphan");
    const now = 2_000_000_000;
    await setModifiedAt(kodaHome, direct, 0);
    await setModifiedAt(kodaHome, nested, 0);
    await setModifiedAt(kodaHome, orphan, 0);
    await setModifiedAt(kodaHome, young, now - 1_000);
    await writeReferences(kodaHome, direct, nested);

    const collector = new ArtifactGarbageCollector(kodaHome);
    const dryRun = await collector.collect({
      minimumAgeMs: 10_000,
      now: () => now,
    });

    expect(dryRun).toMatchObject({
      mode: "dry-run",
      logsScanned: 1,
      artifactsScanned: 4,
      reachableArtifacts: 2,
      deletedArtifacts: 0,
      reclaimedBytes: 0,
    });
    expect(dryRun.candidates.map((candidate) => candidate.id)).toEqual([
      orphan.id,
    ]);
    const repeatedDryRun = await collector.collect({
      minimumAgeMs: 10_000,
      now: () => now,
    });
    expect(repeatedDryRun.candidates).toEqual(dryRun.candidates);
    await expect(
      access(artifactPath(kodaHome, orphan)),
    ).resolves.toBeUndefined();

    const deleted = await collector.collect({
      delete: true,
      minimumAgeMs: 10_000,
      now: () => now,
    });
    expect(deleted.deletedArtifacts).toBe(1);
    expect(deleted.reclaimedBytes).toBe(orphan.bytes);
    await expect(access(artifactPath(kodaHome, orphan))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      access(artifactPath(kodaHome, direct)),
    ).resolves.toBeUndefined();
    await expect(
      access(artifactPath(kodaHome, nested)),
    ).resolves.toBeUndefined();
    await expect(
      access(artifactPath(kodaHome, young)),
    ).resolves.toBeUndefined();
  });

  it("fails closed for active threads and incomplete logs", async () => {
    const { kodaHome, artifactStore } = await createState();
    const orphan = await createArtifact(artifactStore, "must-survive");
    await setModifiedAt(kodaHome, orphan, 0);
    const threadPath = join(kodaHome, "threads", "busy-thread.jsonl");
    const threadLease = await ThreadLease.acquire(threadPath);
    const collector = new ArtifactGarbageCollector(kodaHome);

    await expect(
      collector.collect({ delete: true, minimumAgeMs: 0 }),
    ).rejects.toMatchObject({ code: "ARTIFACT_GC_ACTIVE_THREADS" });
    await expect(
      access(artifactPath(kodaHome, orphan)),
    ).resolves.toBeUndefined();
    await threadLease.release();

    await mkdir(join(kodaHome, "threads"), { recursive: true });
    await writeFile(threadPath, '{"schemaVersion":1');
    await expect(
      collector.collect({ delete: true, minimumAgeMs: 0 }),
    ).rejects.toMatchObject({ code: "ARTIFACT_GC_UNSAFE_SCAN" });
    await expect(
      access(artifactPath(kodaHome, orphan)),
    ).resolves.toBeUndefined();
  });

  it("treats malformed maintenance leases as active and replaces dead owners", async () => {
    const { kodaHome } = await createState();
    const artifactRoot = join(kodaHome, "artifacts");
    await writeFile(join(artifactRoot, "gc.lock"), "not-json\n");

    await expect(
      ArtifactMaintenanceLease.assertInactive(artifactRoot),
    ).rejects.toMatchObject({ code: "ARTIFACT_GC_LOCKED" });
    await expect(
      new ArtifactGarbageCollector(kodaHome).collect(),
    ).rejects.toMatchObject({ code: "ARTIFACT_GC_LOCKED" });

    await writeFile(
      join(artifactRoot, "gc.lock"),
      `${JSON.stringify({ pid: 101, createdAt: "old", token: "stale" })}\n`,
    );
    const report = await new ArtifactGarbageCollector(kodaHome).collect({
      lease: { isProcessAlive: () => false },
    });
    expect(report.mode).toBe("dry-run");
    await expect(access(join(artifactRoot, "gc.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("retains and diagnoses unexpected artifact-store entries", async () => {
    const { kodaHome } = await createState();
    const digestRoot = join(kodaHome, "artifacts", "sha256");
    const unexpected = join(digestRoot, "unexpected");
    const symlinkPath = join(digestRoot, "aa");
    await writeFile(unexpected, "leave me");
    await symlink(unexpected, symlinkPath);

    const report = await new ArtifactGarbageCollector(kodaHome).collect({
      delete: true,
      minimumAgeMs: 0,
    });

    expect(report.artifactsScanned).toBe(0);
    expect(report.diagnostics).toHaveLength(2);
    await expect(readFile(unexpected, "utf8")).resolves.toBe("leave me");
    await expect(readFile(symlinkPath, "utf8")).resolves.toBe("leave me");
  });

  it("rejects unsafe thread log names and invalid age options", async () => {
    const { kodaHome } = await createState();
    await mkdir(join(kodaHome, "threads"), { recursive: true });
    await writeFile(join(kodaHome, "threads", "unsafe name.jsonl"), "");
    const collector = new ArtifactGarbageCollector(kodaHome);

    await expect(collector.collect()).rejects.toMatchObject({
      code: "ARTIFACT_GC_UNSAFE_SCAN",
    });
    await expect(collector.collect({ minimumAgeMs: -1 })).rejects.toMatchObject(
      { code: "ARTIFACT_GC_INVALID_OPTIONS" },
    );
  });

  it("fails closed for corrupt, discontinuous, and non-regular logs", async () => {
    const corruptState = await createState();
    await mkdir(join(corruptState.kodaHome, "threads"), { recursive: true });
    await writeFile(
      join(corruptState.kodaHome, "threads", "corrupt.jsonl"),
      "not-json\n",
    );
    await expect(
      new ArtifactGarbageCollector(corruptState.kodaHome).collect(),
    ).rejects.toMatchObject({ code: "ARTIFACT_GC_UNSAFE_SCAN" });

    const discontinuousState = await createState();
    const threadId = threadIdSchema.parse("discontinuous");
    const turnId = turnIdSchema.parse("discontinuous-turn");
    const metadata = {
      schemaVersion: 1 as const,
      timestamp: "2026-08-26T00:00:00.000Z",
      threadId,
      turnId,
    };
    await mkdir(join(discontinuousState.kodaHome, "threads"), {
      recursive: true,
    });
    await writeFile(
      join(discontinuousState.kodaHome, "threads", "discontinuous.jsonl"),
      `${JSON.stringify({ ...metadata, sequence: 0, type: "turn.started", payload: {} })}\n${JSON.stringify({ ...metadata, sequence: 2, type: "turn.completed", payload: { steps: 1 } })}\n`,
    );
    await expect(
      new ArtifactGarbageCollector(discontinuousState.kodaHome).collect(),
    ).rejects.toMatchObject({ code: "ARTIFACT_GC_UNSAFE_SCAN" });

    const nonRegularState = await createState();
    await mkdir(join(nonRegularState.kodaHome, "threads", "directory.jsonl"), {
      recursive: true,
    });
    await expect(
      new ArtifactGarbageCollector(nonRegularState.kodaHome).collect(),
    ).rejects.toMatchObject({ code: "ARTIFACT_GC_UNSAFE_SCAN" });
  });
});

async function createState(): Promise<{
  kodaHome: string;
  artifactStore: ArtifactStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "koda-artifact-gc-"));
  temporaryDirectories.push(root);
  const kodaHome = join(root, "state");
  const artifactStore = await ArtifactStore.open(join(kodaHome, "artifacts"));
  return { kodaHome, artifactStore };
}

async function createArtifact(
  store: ArtifactStore,
  label: string,
): Promise<ArtifactReference> {
  const output = await store.materializeText(label.repeat(20), {
    inlineBytes: 8,
  });
  if (output.artifact === undefined) {
    throw new Error("Expected an artifact-backed output.");
  }
  return output.artifact;
}

async function writeReferences(
  kodaHome: string,
  direct: ArtifactReference,
  nested: ArtifactReference,
): Promise<void> {
  const threadId = threadIdSchema.parse("gc-thread");
  const turnId = turnIdSchema.parse("gc-turn");
  const store = new JsonlEventStore(
    join(kodaHome, "threads", `${threadId}.jsonl`),
  );
  const metadata = {
    schemaVersion: 1 as const,
    timestamp: "2026-08-26T00:00:00.000Z",
    threadId,
    turnId,
  };
  await store.append({
    ...metadata,
    sequence: 0,
    type: "artifact.recorded",
    payload: {
      callId: toolCallIdSchema.parse("direct-call"),
      name: "read_file",
      artifact: direct,
    },
  } satisfies AgentEvent);
  await store.append({
    ...metadata,
    sequence: 1,
    type: "item.recorded",
    payload: {
      item: {
        type: "tool_result",
        id: itemIdSchema.parse("nested-result"),
        callId: toolCallIdSchema.parse("nested-call"),
        name: "read_file",
        status: "success",
        output: { nested: [{ artifact: nested }] },
      },
    },
  } satisfies AgentEvent);
}

async function setModifiedAt(
  kodaHome: string,
  reference: ArtifactReference,
  milliseconds: number,
): Promise<void> {
  const date = new Date(milliseconds);
  await utimes(artifactPath(kodaHome, reference), date, date);
}

function artifactPath(kodaHome: string, reference: ArtifactReference): string {
  return join(
    kodaHome,
    "artifacts",
    "sha256",
    reference.sha256.slice(0, 2),
    reference.sha256,
  );
}
