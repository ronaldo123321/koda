import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlEventStore } from "@koda/runtime-node";
import { agentEventSchema, threadIdSchema, turnIdSchema } from "@koda/protocol";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createStore(): Promise<{
  store: JsonlEventStore;
  filePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "koda-event-store-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "thread.jsonl");
  return { store: new JsonlEventStore(filePath), filePath };
}

function turnStartedEvent() {
  return agentEventSchema.parse({
    schemaVersion: 1,
    sequence: 0,
    timestamp: "2026-08-26T00:00:00.000Z",
    threadId: threadIdSchema.parse("thread-store"),
    turnId: turnIdSchema.parse("turn-store"),
    type: "turn.started",
    payload: {},
  });
}

describe("JsonlEventStore", () => {
  it("appends and reads validated events", async () => {
    const { store } = await createStore();
    const event = turnStartedEvent();

    await store.append(event);
    const result = await store.readAll();

    expect(result.events).toEqual([event]);
    expect(result.diagnostics).toEqual([]);
  });

  it("ignores and reports a partial trailing line", async () => {
    const { store, filePath } = await createStore();
    const event = turnStartedEvent();
    await store.append(event);
    await appendFile(filePath, '{"schemaVersion":1', "utf8");

    const result = await store.readAll();

    expect(result.events).toEqual([event]);
    expect(result.diagnostics).toEqual([
      {
        code: "PARTIAL_TRAILING_LINE",
        message: "Ignored a partial trailing event at line 2.",
        line: 2,
      },
    ]);
  });
});
