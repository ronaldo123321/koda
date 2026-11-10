import { TurnEventRecorder, type EventSink } from "@koda/agent-core";
import { threadIdSchema, turnIdSchema, type AgentEvent } from "@koda/protocol";
import { describe, expect, it } from "vitest";

function recorder(sink: EventSink, initialSequence = 0) {
  return new TurnEventRecorder(
    sink,
    { now: () => "2026-11-10T00:00:00.000Z" },
    threadIdSchema.parse("recorder-thread"),
    turnIdSchema.parse("recorder-turn"),
    initialSequence,
  );
}

const started = { type: "turn.started" as const, payload: {} };
const completed = { type: "turn.completed" as const, payload: { steps: 1 } };

describe("TurnEventRecorder", () => {
  it("serializes concurrent appends and allocates sequences only after persistence", async () => {
    const entered: AgentEvent[] = [];
    const persisted: AgentEvent[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events = recorder({
      append: async (event) => {
        entered.push(event);
        if (entered.length === 1) await gate;
        persisted.push(event);
      },
    });
    const first = events.record(started);
    const second = events.record(completed);
    await Promise.resolve();
    expect(entered).toHaveLength(1);
    expect(events.lastRecordedSequence()).toBeUndefined();
    release();
    const results = await Promise.all([first, second]);
    expect(results.map((event) => event.sequence)).toEqual([0, 1]);
    expect(persisted).toEqual(results);
    expect(events.lastRecordedSequence()).toBe(1);
  });

  it("keeps resumed sequences contiguous under a burst of writes", async () => {
    const persisted: AgentEvent[] = [];
    const events = recorder(
      {
        append: async (event) => {
          await Promise.resolve();
          persisted.push(event);
        },
      },
      7,
    );
    await Promise.all(Array.from({ length: 20 }, () => events.record(started)));
    expect(persisted.map((event) => event.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 7),
    );
    expect(events.lastRecordedSequence()).toBe(26);
  });

  it("reports rejected writes without consuming a sequence or blocking later recording", async () => {
    const failure = new Error("append rejected before persistence");
    let attempts = 0;
    const persisted: AgentEvent[] = [];
    const events = recorder({
      append: async (event) => {
        if (attempts++ === 0) throw failure;
        persisted.push(event);
      },
    });
    const first = events.record(started);
    const second = events.record(completed);
    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toMatchObject({ sequence: 0 });
    expect(persisted).toHaveLength(1);
    expect(events.lastRecordedSequence()).toBe(0);
  });
});
