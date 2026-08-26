import {
  AgentLoop,
  EffectToolPolicy,
  ToolRegistry,
  type ApprovalBroker,
} from "@koda/agent-core";
import {
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type ToolResultItem,
} from "@koda/protocol";
import { ScriptedModelProvider } from "@koda/providers";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DeterministicItemIdFactory,
  FixedClock,
  MemoryEventStore,
} from "./index.js";

const threadId = threadIdSchema.parse("approval-thread");
const turnId = turnIdSchema.parse("approval-turn");

describe("AgentLoop approvals", () => {
  it("persists approval around a prepared write and executes after approval", async () => {
    let executed = false;
    const events = new MemoryEventStore();
    const approvals: ApprovalBroker = {
      request: async (request) => {
        expect(executed).toBe(false);
        expect(request.details).toContain("*** Update File: README.md");
        return { decision: "approved", reason: "Test approved." };
      },
    };
    const result = await runWriteTurn({
      events,
      approvals,
      approvalMode: "on-request",
      onExecute: () => {
        executed = true;
      },
      assertToolResult: (toolResult) => {
        expect(toolResult.status).toBe("success");
      },
    });

    expect(result.status).toBe("completed");
    expect(executed).toBe(true);
    expect(events.events.map((event) => event.type)).toEqual([
      "turn.started",
      "item.recorded",
      "item.recorded",
      "tool.started",
      "approval.requested",
      "item.recorded",
      "approval.resolved",
      "item.recorded",
      "tool.completed",
      "assistant.delta",
      "item.recorded",
      "turn.completed",
    ]);
    const approvalItem = events.events.find(
      (event) =>
        event.type === "item.recorded" &&
        event.payload.item.type === "approval",
    );
    expect(approvalItem).toMatchObject({
      payload: { item: { decision: "approved" } },
    });
  });

  it("returns a rejected approval to the model without executing", async () => {
    let executed = false;
    const result = await runWriteTurn({
      events: new MemoryEventStore(),
      approvals: {
        request: async () => ({
          decision: "rejected",
          reason: "User said no.",
        }),
      },
      approvalMode: "on-request",
      onExecute: () => {
        executed = true;
      },
      assertToolResult: (toolResult) => {
        expect(toolResult).toMatchObject({
          status: "error",
          error: { code: "APPROVAL_REJECTED" },
        });
      },
    });

    expect(result.status).toBe("completed");
    expect(executed).toBe(false);
  });

  it("never mode denies writes without invoking the approval broker", async () => {
    let approvalCalls = 0;
    let executed = false;
    const result = await runWriteTurn({
      events: new MemoryEventStore(),
      approvals: {
        request: async () => {
          approvalCalls += 1;
          return { decision: "approved" };
        },
      },
      approvalMode: "never",
      onExecute: () => {
        executed = true;
      },
      assertToolResult: (toolResult) => {
        expect(toolResult).toMatchObject({
          status: "error",
          error: { code: "POLICY_DENIED" },
        });
      },
    });

    expect(result.status).toBe("completed");
    expect(approvalCalls).toBe(0);
    expect(executed).toBe(false);
  });
});

interface WriteTurnOptions {
  events: MemoryEventStore;
  approvals: ApprovalBroker;
  approvalMode: "on-request" | "never";
  onExecute(): void;
  assertToolResult(result: ToolResultItem): void;
}

async function runWriteTurn(options: WriteTurnOptions) {
  const tools = new ToolRegistry();
  tools.register({
    spec: {
      name: "apply_patch",
      description: "Test a prepared write.",
      inputJsonSchema: { type: "object" },
    },
    inputSchema: z.object({ path: z.string() }),
    concurrency: "exclusive",
    effect: "write",
    prepare: async () => ({
      approval: {
        title: "Update README.md",
        summary: "Update one exact match in README.md.",
        details: "*** Update File: README.md\n@@\n-old\n+new",
      },
      execute: async () => {
        options.onExecute();
        return { changed: true };
      },
    }),
  });
  const provider = new ScriptedModelProvider([
    {
      events: [
        {
          type: "tool_call",
          callId: toolCallIdSchema.parse("approval-call"),
          name: "apply_patch",
          arguments: { path: "README.md" },
        },
        { type: "completed", finishReason: "tool_calls" },
      ],
    },
    {
      assertRequest: (request) => {
        const result = request.items.at(-1);
        expect(result?.type).toBe("tool_result");
        options.assertToolResult(result as ToolResultItem);
      },
      events: [
        { type: "assistant_delta", text: "Handled the patch." },
        { type: "completed", finishReason: "stop" },
      ],
    },
  ]);
  return new AgentLoop({
    provider,
    tools,
    policy: new EffectToolPolicy(options.approvalMode),
    approvals: options.approvals,
    events: options.events,
    ids: new DeterministicItemIdFactory(),
    clock: new FixedClock(),
  }).runTurn({ threadId, turnId, userInput: "Update the README." });
}
