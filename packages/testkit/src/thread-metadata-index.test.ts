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

  it("searches bounded display-worthy history with stable revision cursors", async () => {
    const kodaHome = await createKodaHome();
    const firstId = threadIdSchema.parse("search-first");
    const firstTurn = turnIdSchema.parse("search-first-turn");
    await writeEvents(kodaHome, firstId, [
      event(firstId, firstTurn, 0, "turn.started", {}, "00:00:00"),
      contextEvent(firstId, firstTurn, 1, "/workspace/search", "model-a"),
      itemEvent(firstId, firstTurn, 2, {
        type: "user_message",
        id: "search-user",
        content: "你好 Parser one",
      }),
      itemEvent(firstId, firstTurn, 3, {
        type: "assistant_message",
        id: "search-assistant",
        content: "Fixed HELLO parser",
      }),
      itemEvent(firstId, firstTurn, 4, {
        type: "tool_call",
        id: "search-call-item",
        callId: "search-call",
        name: "exec_command",
        arguments: { secret: "do-not-index" },
      }),
      itemEvent(firstId, firstTurn, 5, {
        type: "tool_result",
        id: "search-result",
        callId: "search-call",
        name: "exec_command",
        status: "success",
        output: { summary: "compiled cleanly" },
      }),
      event(firstId, firstTurn, 6, "turn.completed", { steps: 1 }, "00:00:06"),
    ]);

    const secondId = threadIdSchema.parse("search-second");
    const secondTurn = turnIdSchema.parse("search-second-turn");
    await writeEvents(kodaHome, secondId, [
      event(secondId, secondTurn, 0, "turn.started", {}, "01:00:00"),
      contextEvent(secondId, secondTurn, 1, "/workspace/search", "model-b"),
      itemEvent(secondId, secondTurn, 2, {
        type: "user_message",
        id: "search-second-user",
        content: "parser from the newer thread",
      }),
      event(
        secondId,
        secondTurn,
        3,
        "turn.completed",
        { steps: 1 },
        "01:00:03",
      ),
    ]);

    const isolatedId = threadIdSchema.parse("search-isolated");
    const isolatedTurn = turnIdSchema.parse("search-isolated-turn");
    await writeEvents(kodaHome, isolatedId, [
      event(isolatedId, isolatedTurn, 0, "turn.started", {}, "02:00:00"),
      contextEvent(isolatedId, isolatedTurn, 1, "/workspace/other", "model-c"),
      itemEvent(isolatedId, isolatedTurn, 2, {
        type: "user_message",
        id: "search-isolated-user",
        content: "你好 parser isolated",
      }),
      event(
        isolatedId,
        isolatedTurn,
        3,
        "turn.completed",
        { steps: 1 },
        "02:00:03",
      ),
    ]);

    const index = await ThreadMetadataIndex.open(kodaHome);
    await index.refresh();
    expect(
      index.search({
        workspaceRoot: "/workspace/search",
        query: "你好",
      }).matches,
    ).toEqual([
      expect.objectContaining({
        threadId: firstId,
        sequence: 2,
        kind: "user_message",
      }),
    ]);
    expect(
      index.search({
        workspaceRoot: "/workspace/search",
        query: "HELLO parser",
      }).matches,
    ).toEqual([
      expect.objectContaining({
        threadId: firstId,
        sequence: 3,
        kind: "assistant_message",
      }),
    ]);
    expect(
      index.search({
        workspaceRoot: "/workspace/search",
        query: "do-not-index",
      }).matches,
    ).toEqual([]);

    const firstPage = index.search({
      workspaceRoot: "/workspace/search",
      query: "parser",
      limit: 1,
    });
    expect(firstPage).toMatchObject({
      matches: [{ threadId: secondId, sequence: 2 }],
      hasMore: true,
      nextCursor: { revision: firstPage.revision },
    });
    if (firstPage.nextCursor === undefined) {
      throw new Error("First search page did not provide a cursor.");
    }
    const firstCursor = firstPage.nextCursor;
    await index.refresh();
    const secondPage = index.search({
      workspaceRoot: "/workspace/search",
      query: "parser",
      limit: 1,
      cursor: firstCursor,
    });
    expect(secondPage.matches).toEqual([
      expect.objectContaining({ threadId: firstId, sequence: 3 }),
    ]);

    const firstStore = new JsonlEventStore(
      join(kodaHome, "threads", `${firstId}.jsonl`),
    );
    const nextTurn = turnIdSchema.parse("search-next-turn");
    await firstStore.append(
      event(firstId, nextTurn, 7, "turn.started", {}, "03:00:00"),
    );
    await firstStore.append(
      contextEvent(firstId, nextTurn, 8, "/workspace/search", "model-a"),
    );
    await firstStore.append(
      event(firstId, nextTurn, 9, "turn.completed", { steps: 1 }, "03:00:02"),
    );
    await index.refreshThread(firstId);
    expect(() =>
      index.search({
        workspaceRoot: "/workspace/search",
        query: "parser",
        cursor: firstCursor,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "THREAD_SEARCH_INDEX_CHANGED" }),
    );

    await appendFile(
      join(kodaHome, "threads", `${firstId}.jsonl`),
      '{"schemaVersion":1',
      "utf8",
    );
    await index.refreshThread(firstId);
    expect(
      index.search({
        workspaceRoot: "/workspace/search",
        query: "hello",
      }).matches,
    ).toEqual([]);
    index.close();
  });

  it("head-tail truncates large search items and sanitizes snippets", async () => {
    const kodaHome = await createKodaHome();
    const threadId = threadIdSchema.parse("search-large-item");
    const turnId = turnIdSchema.parse("search-large-turn");
    const content = `\u001b[31mHEADTERM ${"x".repeat(150_000)} MIDDLETERM ${"y".repeat(150_000)} TAILTERM`;
    await writeEvents(kodaHome, threadId, [
      event(threadId, turnId, 0, "turn.started", {}, "04:00:00"),
      contextEvent(threadId, turnId, 1, "/workspace/search", "model-large"),
      itemEvent(threadId, turnId, 2, {
        type: "assistant_message",
        id: "search-large-message",
        content,
      }),
      event(threadId, turnId, 3, "turn.completed", { steps: 1 }, "04:00:03"),
    ]);
    const index = await ThreadMetadataIndex.open(kodaHome);
    await index.refresh();

    const head = index.search({
      workspaceRoot: "/workspace/search",
      query: "headterm",
    });
    expect(head.matches).toHaveLength(1);
    expect(
      Buffer.byteLength(head.matches[0]?.snippet ?? "", "utf8"),
    ).toBeLessThanOrEqual(512);
    expect(head.matches[0]?.snippet).not.toContain("\u001b");
    expect(
      index.search({
        workspaceRoot: "/workspace/search",
        query: "tailterm",
      }).matches,
    ).toHaveLength(1);
    expect(
      index.search({
        workspaceRoot: "/workspace/search",
        query: "middleterm",
      }).matches,
    ).toEqual([]);
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

function itemEvent(
  threadId: ThreadId,
  turnId: TurnId,
  sequence: number,
  item: unknown,
): AgentEvent {
  return event(
    threadId,
    turnId,
    sequence,
    "item.recorded",
    { item },
    `00:00:${String(sequence).padStart(2, "0")}`,
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
