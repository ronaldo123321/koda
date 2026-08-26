import {
  JsonlEventStore,
  ThreadLease,
  ThreadMetadataIndex,
} from "@koda/runtime-node";
import {
  agentEventSchema,
  threadIdSchema,
  turnIdSchema,
  type AgentEvent,
  type ThreadId,
  type TurnId,
} from "@koda/protocol";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
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

describe("ThreadMetadataIndex", () => {
  it("projects multi-turn metadata and aggregate usage without double counting", async () => {
    const kodaHome = await createKodaHome();
    const threadId = threadIdSchema.parse("metadata-multi-turn");
    const firstTurn = turnIdSchema.parse("metadata-turn-1");
    const secondTurn = turnIdSchema.parse("metadata-turn-2");
    await writeEvents(kodaHome, threadId, [
      event(threadId, firstTurn, 0, "turn.started", {}, "00:00:00"),
      contextEvent(threadId, firstTurn, 1, "/workspace/one", "model-a"),
      event(
        threadId,
        firstTurn,
        2,
        "model.usage",
        { step: 1, usage: usage(100, 20) },
        "00:00:02",
      ),
      event(
        threadId,
        firstTurn,
        3,
        "turn.completed",
        { steps: 1, usage: turnUsage(100, 20) },
        "00:00:03",
      ),
      event(threadId, secondTurn, 4, "turn.started", {}, "00:00:04"),
      contextEvent(threadId, secondTurn, 5, "/workspace/one", "model-b"),
      event(
        threadId,
        secondTurn,
        6,
        "model.usage",
        { step: 1, usage: usage(50, 10) },
        "00:00:06",
      ),
      event(
        threadId,
        secondTurn,
        7,
        "turn.cancelled",
        { reason: "test", usage: turnUsage(50, 10) },
        "00:00:07",
      ),
    ]);
    const index = await ThreadMetadataIndex.open(kodaHome);

    await expect(index.refresh()).resolves.toMatchObject({
      indexed: 1,
      skipped: 0,
      removed: 0,
      diagnostics: [],
    });
    expect(index.get(threadId)).toMatchObject({
      threadId,
      status: "cancelled",
      lastTurnId: secondTurn,
      provider: "openai",
      model: "model-b",
      workspaceRoot: "/workspace/one",
      turnCount: 2,
      eventCount: 8,
      lastSequence: 7,
      usage: {
        modelRequests: 2,
        reportedRequests: 2,
        tokens: {
          inputTokens: 150,
          outputTokens: 30,
          totalTokens: 180,
        },
      },
    });
    await expect(index.refresh()).resolves.toMatchObject({
      indexed: 0,
      skipped: 1,
    });
    expect(
      index.list({ workspaceRoot: "/workspace/one", limit: 1 }),
    ).toHaveLength(1);
    index.close();
  });

  it("tracks live, interrupted, changed, and removed thread logs", async () => {
    const kodaHome = await createKodaHome();
    const threadId = threadIdSchema.parse("metadata-lifecycle");
    const turnId = turnIdSchema.parse("metadata-lifecycle-turn");
    const eventLogPath = await writeEvents(kodaHome, threadId, [
      event(threadId, turnId, 0, "turn.started", {}, "01:00:00"),
    ]);
    const lease = await ThreadLease.acquire(eventLogPath);
    const index = await ThreadMetadataIndex.open(kodaHome);

    await index.refresh();
    expect(index.get(threadId)?.status).toBe("running");
    await lease.release();
    await expect(index.refresh()).resolves.toMatchObject({ skipped: 1 });
    expect(index.get(threadId)?.status).toBe("interrupted");

    const eventStore = new JsonlEventStore(eventLogPath);
    await eventStore.append(
      contextEvent(threadId, turnId, 1, "/workspace/live", "model-live"),
    );
    await eventStore.append(
      event(
        threadId,
        turnId,
        2,
        "turn.failed",
        { code: "TEST", message: "failed" },
        "01:00:02",
      ),
    );
    await index.refreshThread(threadId);
    expect(index.get(threadId)?.status).toBe("failed");

    await rm(eventLogPath);
    await expect(index.refresh()).resolves.toMatchObject({ removed: 1 });
    expect(index.get(threadId)).toBeUndefined();
    index.close();
  });

  it("keeps partial and invalid logs inspectable while rebuilding valid rows", async () => {
    const kodaHome = await createKodaHome();
    const partialId = threadIdSchema.parse("metadata-partial");
    const partialTurn = turnIdSchema.parse("metadata-partial-turn");
    const partialPath = await writeEvents(kodaHome, partialId, [
      event(partialId, partialTurn, 0, "turn.started", {}, "02:00:00"),
      contextEvent(
        partialId,
        partialTurn,
        1,
        "/workspace/partial",
        "model-partial",
      ),
      event(
        partialId,
        partialTurn,
        2,
        "turn.completed",
        { steps: 1 },
        "02:00:02",
      ),
    ]);
    await appendFile(partialPath, '{"schemaVersion":1', "utf8");

    const invalidId = threadIdSchema.parse("metadata-invalid");
    await writeFile(
      join(kodaHome, "threads", `${invalidId}.jsonl`),
      '{"not":"an event"}\n',
      "utf8",
    );
    await writeFile(
      join(kodaHome, "threads", "bad id.jsonl"),
      "ignored",
      "utf8",
    );

    const index = await ThreadMetadataIndex.open(kodaHome);
    const refresh = await index.rebuild();

    expect(refresh.indexed).toBe(2);
    expect(refresh.diagnostics).toContainEqual(
      expect.objectContaining({ logFile: `${invalidId}.jsonl` }),
    );
    expect(refresh.diagnostics).toContainEqual(
      expect.objectContaining({ logFile: "bad id.jsonl" }),
    );
    expect(index.get(partialId)).toMatchObject({ status: "interrupted" });
    const partial = index.get(partialId);
    expect(partial?.indexedBytes).toBeLessThan(partial?.sourceBytes ?? 0);
    expect(index.get(invalidId)).toMatchObject({
      status: "invalid",
      errorMessage: expect.any(String),
    });
    index.close();
  });

  it("quarantines a corrupt database and safely supports two writers", async () => {
    const kodaHome = await createKodaHome();
    const firstId = threadIdSchema.parse("metadata-writer-one");
    const secondId = threadIdSchema.parse("metadata-writer-two");
    await writeCompletedThread(kodaHome, firstId, "writer-one-turn", 4);
    await writeFile(join(kodaHome, "state.db"), "not a sqlite database");

    const recovered = await ThreadMetadataIndex.open(kodaHome, {
      now: () => "2026-08-26T03:00:00.000Z",
    });
    expect(recovered.recovery?.databaseBackup).toContain(".corrupt-");
    await expect(
      access(recovered.recovery?.databaseBackup ?? "missing"),
    ).resolves.toBeUndefined();
    await recovered.refresh();
    expect(recovered.get(firstId)).toMatchObject({ status: "completed" });
    recovered.close();

    await writeCompletedThread(kodaHome, secondId, "writer-two-turn", 5);
    const first = await ThreadMetadataIndex.open(kodaHome);
    const second = await ThreadMetadataIndex.open(kodaHome);

    await Promise.all([
      first.refreshThread(firstId),
      second.refreshThread(secondId),
    ]);
    expect(first.get(firstId)).toBeDefined();
    expect(first.get(secondId)).toBeDefined();
    first.close();
    second.close();
  });
});

async function createKodaHome(): Promise<string> {
  const kodaHome = await mkdtemp(join(tmpdir(), "koda-metadata-"));
  temporaryDirectories.push(kodaHome);
  await mkdir(join(kodaHome, "threads"));
  return kodaHome;
}

async function writeEvents(
  kodaHome: string,
  threadId: ThreadId,
  events: readonly AgentEvent[],
): Promise<string> {
  const path = join(kodaHome, "threads", `${threadId}.jsonl`);
  const store = new JsonlEventStore(path);
  for (const value of events) {
    await store.append(value);
  }
  return path;
}

async function writeCompletedThread(
  kodaHome: string,
  threadId: ThreadId,
  turnIdInput: string,
  hour: number,
): Promise<void> {
  const turnId = turnIdSchema.parse(turnIdInput);
  await writeEvents(kodaHome, threadId, [
    event(threadId, turnId, 0, "turn.started", {}, `0${hour}:00:00`),
    contextEvent(threadId, turnId, 1, `/workspace/${threadId}`, "model-writer"),
    event(
      threadId,
      turnId,
      2,
      "turn.completed",
      { steps: 1 },
      `0${hour}:00:02`,
    ),
  ]);
}

function contextEvent(
  threadId: ThreadId,
  turnId: TurnId,
  sequence: number,
  workspaceRoot: string,
  model: string,
): AgentEvent {
  return event(
    threadId,
    turnId,
    sequence,
    "turn.context",
    {
      provider: "openai",
      model,
      workspaceRoot,
      approvalMode: "on-request",
      instructionsSha256: "a".repeat(64),
      repositoryInstructions: [],
    },
    `00:00:0${sequence}`,
  );
}

function event(
  threadId: ThreadId,
  turnId: TurnId,
  sequence: number,
  type: AgentEvent["type"],
  payload: unknown,
  time: string,
): AgentEvent {
  return agentEventSchema.parse({
    schemaVersion: 1,
    sequence,
    timestamp: `2026-08-26T${time}.000Z`,
    threadId,
    turnId,
    type,
    payload,
  });
}

function turnUsage(inputTokens: number, outputTokens: number) {
  return {
    modelRequests: 1,
    reportedRequests: 1,
    tokens: usage(inputTokens, outputTokens),
  };
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    cachedInputTokens: Math.floor(inputTokens / 2),
    cacheWriteInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: Math.floor(outputTokens / 2),
    totalTokens: inputTokens + outputTokens,
  };
}
