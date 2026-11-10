import {
  AgentLoop,
  ContextEngine,
  createModelContextSummarizer,
  digestContextItems,
  projectActiveContext,
  ToolRegistry,
  type ContextSummarizer,
} from "@koda/agent-core";
import {
  threadIdSchema,
  turnIdSchema,
  toolCallIdSchema,
  userMessageItemSchema,
  assistantMessageItemSchema,
} from "@koda/protocol";
import { ScriptedModelProvider } from "@koda/providers";
import { describe, expect, it, vi } from "vitest";
import { DeterministicItemIdFactory, MemoryEventStore } from "./index.js";

const old = [
  userMessageItemSchema.parse({
    id: "old-user",
    type: "user_message",
    content: "Keep public APIs compatible. " + "x".repeat(30_000),
  }),
  assistantMessageItemSchema.parse({
    id: "old-answer",
    type: "assistant_message",
    content: "Implemented parsing; tests remain. " + "y".repeat(20_000),
  }),
];
const latest = userMessageItemSchema.parse({
  id: "latest",
  type: "user_message",
  content: "Now finish validation.",
});
const summary = {
  objective: "wrong objective",
  decisions: ["Preserve public APIs."],
  modifiedFiles: [],
  completedWork: ["Parsing implemented."],
  pendingWork: ["Run regression tests."],
  failedAttempts: [],
  criticalFacts: [],
};
const tokens = {
  inputTokens: 10,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 5,
  reasoningOutputTokens: 0,
  totalTokens: 15,
};
const observer = () => ({
  requested: vi.fn(),
  reported: vi.fn(async () => {}),
});
function engine(summarizer: ContextSummarizer, timeout = 2000) {
  return new ContextEngine({
    contextWindowTokens: 6000,
    maxOutputTokens: 512,
    safetyMarginTokens: 100,
    ids: new DeterministicItemIdFactory(),
    summarizer,
    summaryTimeoutMs: timeout,
  });
}

describe("semantic context summaries", () => {
  it("retains the latest objective, historical requirements and replayable context", async () => {
    const summarize = vi.fn(async (source: string) => {
      expect(Buffer.byteLength(source)).toBeLessThan(12_000);
      return summary;
    });
    const context = engine(summarize);
    const prepared = await context.prepareAsync(
      [...old, latest],
      [],
      new AbortController().signal,
      observer(),
    );
    expect(summarize).toHaveBeenCalledOnce();
    expect(prepared.compaction?.summary).toMatchObject({
      objective: latest.content,
      pendingWork: summary.pendingWork,
    });
    expect(prepared.compaction?.summary.criticalFacts.join(" ")).toContain(
      "Keep public APIs compatible.",
    );
    expect(prepared.estimatedInputTokens).toBeLessThan(
      prepared.inputBudgetTokens,
    );
    expect(
      digestContextItems(
        projectActiveContext([...old, latest, prepared.compaction!]),
      ),
    ).toBe(digestContextItems(prepared.items));
    const second = await context.prepareAsync(
      [...old, latest, prepared.compaction!],
      [],
      new AbortController().signal,
      observer(),
    );
    expect(second.compaction).toBeUndefined();
    expect(summarize).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    { objective: "bad" },
    { ...summary, pendingWork: ["x".repeat(301)] },
  ])("falls back on invalid summary %j", async (invalid) => {
    const prepared = await engine(async () => invalid).prepareAsync(
      [...old, latest],
      [],
      new AbortController().signal,
      observer(),
    );
    expect(prepared.compaction?.summary.pendingWork).not.toEqual(
      summary.pendingWork,
    );
    expect(prepared.compaction?.summary.objective).toBe(latest.content);
  });

  it("bounds timeout even when the summarizer ignores cancellation", async () => {
    let signal: AbortSignal | undefined;
    const prepared = await engine(async (_, s) => {
      signal = s;
      return new Promise(() => {});
    }, 10).prepareAsync(
      [...old, latest],
      [],
      new AbortController().signal,
      observer(),
    );
    expect(signal?.aborted).toBe(true);
    expect(prepared.compaction).toBeDefined();
  });

  it("propagates parent cancellation and skips summaries for short context", async () => {
    const controller = new AbortController();
    const summarize = vi.fn(async () => {
      controller.abort(new Error("cancelled"));
      return summary;
    });
    const context = engine(summarize);
    await context.prepareAsync([latest], [], controller.signal, observer());
    expect(summarize).not.toHaveBeenCalled();
    await expect(
      context.prepareAsync([...old, latest], [], controller.signal, observer()),
    ).rejects.toThrow("cancelled");
  });

  it("accounts for isolated summary requests and persists usage before compaction", async () => {
    const summaryProvider = new ScriptedModelProvider([
      {
        assertRequest: (request) => expect(request.tools).toEqual([]),
        events: [
          { type: "assistant_delta", text: JSON.stringify(summary) },
          {
            type: "completed",
            finishReason: "stop",
            usage: tokens,
            responseId: "summary-response",
          },
        ],
      },
    ]);
    const events = new MemoryEventStore();
    const result = await new AgentLoop({
      provider: new ScriptedModelProvider([
        {
          events: [
            { type: "assistant_delta", text: "Done" },
            { type: "completed", finishReason: "stop", usage: tokens },
          ],
        },
      ]),
      contextEngine: engine(
        createModelContextSummarizer(() => summaryProvider),
      ),
      tools: new ToolRegistry(),
      events,
      ids: new DeterministicItemIdFactory("turn-item"),
    }).runTurn({
      threadId: threadIdSchema.parse("summary-thread"),
      turnId: turnIdSchema.parse("summary-turn"),
      userInput: latest.content,
      history: old,
    });
    expect(result.status).toBe("completed");
    expect(result.usage).toMatchObject({
      modelRequests: 2,
      reportedRequests: 2,
      tokens: { totalTokens: 30 },
    });
    const usage = events.events.filter((e) => e.type === "model.usage");
    expect(usage).toHaveLength(2);
    expect(usage[0]?.payload).toMatchObject({
      purpose: "context_summary",
      responseId: "summary-response",
    });
  });

  it("bounds the serialized prompt including escaped excerpt bytes", async () => {
    let bytes = 0;
    const context = new ContextEngine({
      contextWindowTokens: 5000,
      maxOutputTokens: 512,
      safetyMarginTokens: 100,
      ids: new DeterministicItemIdFactory(),
      summarizer: async (source) => {
        bytes = Buffer.byteLength(source);
        return summary;
      },
    });
    const escaped = assistantMessageItemSchema.parse({
      id: "escaped",
      type: "assistant_message",
      content: '\\"'.repeat(20_000),
    });
    await context.prepareAsync(
      [...old, escaped, latest],
      [],
      new AbortController().signal,
      observer(),
    );
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(context.inputBudgetTokens * 2 - 4000);
  });

  it("does not hide a failed durable usage write behind summary fallback", async () => {
    const context = engine(async (_source, _signal, observe) => {
      await observe.reported(tokens);
      return summary;
    });
    await expect(
      context.prepareAsync([...old, latest], [], new AbortController().signal, {
        requested: () => {},
        reported: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");
  });

  it("rejects summary tool calls without executing them", async () => {
    const summarize = createModelContextSummarizer(() => ({
      async *stream() {
        yield {
          type: "tool_call" as const,
          callId: toolCallIdSchema.parse("summary-call"),
          name: "write_file",
          arguments: { path: "x" },
        };
      },
    }));
    await expect(
      summarize("source", new AbortController().signal, observer()),
    ).rejects.toThrow("tool call");
  });

  it("counts reported usage even for malformed JSON", async () => {
    const observe = observer();
    const summarize = createModelContextSummarizer(
      () =>
        new ScriptedModelProvider([
          {
            events: [
              { type: "assistant_delta", text: "not JSON" },
              { type: "completed", finishReason: "stop", usage: tokens },
            ],
          },
        ]),
    );
    await expect(
      summarize("source", new AbortController().signal, observe),
    ).rejects.toThrow();
    expect(observe.requested).toHaveBeenCalledOnce();
    expect(observe.reported).toHaveBeenCalledWith(tokens, undefined);
  });
});
