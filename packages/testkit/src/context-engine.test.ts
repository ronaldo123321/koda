import { ContextEngine } from "@koda/agent-core";
import {
  assistantMessageItemSchema,
  itemIdSchema,
  providerStateItemSchema,
  toolCallIdSchema,
  toolCallItemSchema,
  toolResultItemSchema,
  userMessageItemSchema,
  type ConversationItem,
} from "@koda/protocol";
import { describe, expect, it } from "vitest";

import { DeterministicItemIdFactory } from "./deterministic.js";

describe("ContextEngine", () => {
  it("keeps a request unchanged when it fits", () => {
    const items = [user("small-user", "Explain this repository.")];
    const engine = createEngine({ contextWindowTokens: 10_000 });

    const prepared = engine.prepare(items, []);

    expect(prepared.items).toEqual(items);
    expect(prepared.compaction).toBeUndefined();
    expect(prepared.estimatedInputTokens).toBeLessThan(
      prepared.inputBudgetTokens,
    );
  });

  it("creates a deterministic compaction and reconstructs it from retained IDs", () => {
    const callId = toolCallIdSchema.parse("context-patch-call");
    const transcript: ConversationItem[] = [
      user("old-user", `Old objective ${"x".repeat(5_000)}`),
      assistant("old-assistant", `Decision ${"y".repeat(3_000)}`),
      toolCallItemSchema.parse({
        type: "tool_call",
        id: itemIdSchema.parse("old-call"),
        callId,
        name: "apply_patch",
        arguments: { path: "README.md" },
      }),
      toolResultItemSchema.parse({
        type: "tool_result",
        id: itemIdSchema.parse("old-result"),
        callId,
        name: "apply_patch",
        status: "success",
        output: { path: "README.md", details: "q".repeat(3_000) },
      }),
      user("current-user", "Continue with the next task."),
    ];
    const engine = createEngine({ contextWindowTokens: 1_000 });

    const prepared = engine.prepare(transcript, []);

    expect(prepared.compaction).toMatchObject({
      type: "compaction",
      reason: "context_budget",
      summary: {
        objective: "Continue with the next task.",
        modifiedFiles: ["README.md"],
      },
    });
    expect(prepared.items[0]).toEqual(prepared.compaction);
    expect(prepared.items.at(-1)).toMatchObject({ id: "current-user" });
    expect(prepared.estimatedInputTokens).toBeLessThanOrEqual(
      prepared.inputBudgetTokens,
    );

    const reconstructed = engine.prepare(
      [...transcript, prepared.compaction!],
      [],
    );
    expect(reconstructed.compaction).toBeUndefined();
    expect(reconstructed.items).toEqual(prepared.items);
  });

  it("retains a tool call and result as one group after the newest user", () => {
    const callId = toolCallIdSchema.parse("context-read-call");
    const transcript: ConversationItem[] = [
      user("large-history", "z".repeat(8_000)),
      user("latest-user", "Inspect the output."),
      toolCallItemSchema.parse({
        type: "tool_call",
        id: itemIdSchema.parse("retained-call"),
        callId,
        name: "read_file",
        arguments: { path: "README.md" },
      }),
      toolResultItemSchema.parse({
        type: "tool_result",
        id: itemIdSchema.parse("retained-result"),
        callId,
        name: "read_file",
        status: "success",
        output: { content: "bounded" },
      }),
    ];

    const prepared = createEngine({ contextWindowTokens: 1_500 }).prepare(
      transcript,
      [],
    );
    const retainedTypes = prepared.items.map((item) => item.type);

    expect(retainedTypes).toContain("tool_call");
    expect(retainedTypes).toContain("tool_result");
    expect(prepared.compaction?.retainedItemIds).toEqual(
      expect.arrayContaining([
        itemIdSchema.parse("retained-call"),
        itemIdSchema.parse("retained-result"),
      ]),
    );
  });

  it("retains provider state and all tool calls from its model step atomically", () => {
    const firstCallId = toolCallIdSchema.parse("state-first-call");
    const secondCallId = toolCallIdSchema.parse("state-second-call");
    const transcript: ConversationItem[] = [
      user("state-old-user", "z".repeat(8_000)),
      user("state-latest-user", "Continue the stateful tool step."),
      providerStateItemSchema.parse({
        type: "provider_state",
        id: itemIdSchema.parse("retained-provider-state"),
        provider: "deepseek",
        data: { reasoning_content: "inspect both files" },
      }),
      toolCallItemSchema.parse({
        type: "tool_call",
        id: itemIdSchema.parse("state-first-call-item"),
        callId: firstCallId,
        name: "read_file",
        arguments: { path: "README.md" },
      }),
      toolResultItemSchema.parse({
        type: "tool_result",
        id: itemIdSchema.parse("state-first-result-item"),
        callId: firstCallId,
        name: "read_file",
        status: "success",
        output: { content: "first" },
      }),
      toolCallItemSchema.parse({
        type: "tool_call",
        id: itemIdSchema.parse("state-second-call-item"),
        callId: secondCallId,
        name: "read_file",
        arguments: { path: "package.json" },
      }),
      toolResultItemSchema.parse({
        type: "tool_result",
        id: itemIdSchema.parse("state-second-result-item"),
        callId: secondCallId,
        name: "read_file",
        status: "success",
        output: { content: "second" },
      }),
    ];

    const prepared = createEngine({ contextWindowTokens: 1_500 }).prepare(
      transcript,
      [],
    );

    expect(prepared.compaction?.retainedItemIds).toEqual(
      expect.arrayContaining([
        itemIdSchema.parse("retained-provider-state"),
        itemIdSchema.parse("state-first-call-item"),
        itemIdSchema.parse("state-first-result-item"),
        itemIdSchema.parse("state-second-call-item"),
        itemIdSchema.parse("state-second-result-item"),
      ]),
    );
  });

  it("rejects provider state that is not followed by a complete tool step", () => {
    expect(() =>
      createEngine({ contextWindowTokens: 1_000 }).prepare(
        [
          user("orphan-state-user", "x".repeat(8_000)),
          providerStateItemSchema.parse({
            type: "provider_state",
            id: itemIdSchema.parse("orphan-provider-state"),
            provider: "anthropic",
            data: {
              blocks: [
                {
                  type: "thinking",
                  thinking: "unfinished",
                  signature: "signature",
                },
              ],
            },
          }),
          user("orphan-state-latest", "Continue."),
        ],
        [],
      ),
    ).toThrow("has no following tool call");
  });

  it("carries structured facts forward across repeated compactions", () => {
    const engine = createEngine({ contextWindowTokens: 1_000 });
    const callId = toolCallIdSchema.parse("repeated-compaction-call");
    const firstTranscript: ConversationItem[] = [
      user("repeated-old-user", "x".repeat(5_000)),
      toolCallItemSchema.parse({
        type: "tool_call",
        id: itemIdSchema.parse("repeated-call-item"),
        callId,
        name: "apply_patch",
        arguments: { path: "README.md" },
      }),
      toolResultItemSchema.parse({
        type: "tool_result",
        id: itemIdSchema.parse("repeated-result-item"),
        callId,
        name: "apply_patch",
        status: "success",
        output: { path: "README.md", details: "y".repeat(3_000) },
      }),
      user("repeated-current-user", "Continue."),
    ];
    const first = engine.prepare(firstTranscript, []);
    expect(first.compaction?.summary.modifiedFiles).toContain("README.md");

    const second = engine.prepare(
      [
        ...firstTranscript,
        first.compaction!,
        assistant("repeated-large-assistant", "z".repeat(5_000)),
        user("repeated-next-user", "Start the next task."),
      ],
      [],
    );

    expect(second.compaction?.summary.modifiedFiles).toContain("README.md");
    expect(second.compaction?.summary.objective).toBe("Start the next task.");
  });

  it("uses measured input usage to raise later estimates", () => {
    const engine = createEngine({ contextWindowTokens: 10_000 });
    const items = [user("calibration-user", "Measure this request.")];
    const first = engine.prepare(items, []);

    engine.observe(
      first.rawEstimatedInputTokens,
      first.rawEstimatedInputTokens * 2,
    );
    const second = engine.prepare(items, []);

    expect(engine.getCalibrationFactor()).toBeGreaterThanOrEqual(2);
    expect(second.estimatedInputTokens).toBeGreaterThan(
      first.estimatedInputTokens,
    );
  });

  it("fails before provider use when the newest user turn cannot fit", () => {
    const engine = createEngine({ contextWindowTokens: 600 });

    expect(() =>
      engine.prepare([user("oversized-user", "x".repeat(5_000))], []),
    ).toThrowError(
      expect.objectContaining({ code: "CONTEXT_BUDGET_EXCEEDED" }),
    );
  });
});

function createEngine(options: { contextWindowTokens: number }): ContextEngine {
  return new ContextEngine({
    contextWindowTokens: options.contextWindowTokens,
    maxOutputTokens: 100,
    safetyMarginTokens: 100,
    fixedInputTokens: 20,
    ids: new DeterministicItemIdFactory("compaction-item"),
  });
}

function user(id: string, content: string) {
  return userMessageItemSchema.parse({
    type: "user_message",
    id: itemIdSchema.parse(id),
    content,
  });
}

function assistant(id: string, content: string) {
  return assistantMessageItemSchema.parse({
    type: "assistant_message",
    id: itemIdSchema.parse(id),
    content,
  });
}
