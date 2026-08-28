import { AgentLoop, ContextEngine, ToolRegistry } from "@koda/agent-core";
import {
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type AgentEvent,
} from "@koda/protocol";
import { ScriptedModelProvider } from "@koda/providers";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { DeterministicItemIdFactory } from "./deterministic.js";

describe("AgentLoop tool catalog generations", () => {
  it("refreshes only between model steps and binds calls to the advertised generation", async () => {
    const tools = new ToolRegistry();
    tools.replaceNamespace("mcp", (register) => {
      register(tool("mcp__fixture__old", "old"));
    });
    const initialGeneration = tools.catalogGeneration();
    const events: AgentEvent[] = [];
    const provider = new ScriptedModelProvider([
      {
        assertRequest: (request) => {
          expect(request.tools.map((definition) => definition.name)).toEqual([
            "mcp__fixture__old",
          ]);
        },
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("catalog-old-call"),
            name: "mcp__fixture__old",
            arguments: {},
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          expect(request.tools.map((definition) => definition.name)).toEqual([
            "mcp__fixture__new",
          ]);
          expect(request.items).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "tool_call",
                name: "mcp__fixture__old",
                catalogGenerationId: initialGeneration.generationId,
              }),
            ]),
          );
        },
        events: [
          { type: "assistant_delta", text: "Catalog refreshed." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const ids = new DeterministicItemIdFactory("catalog-loop-item");
    const loop = new AgentLoop({
      provider,
      tools,
      events: { append: async (event) => void events.push(event) },
      ids,
      contextEngine: new ContextEngine({
        contextWindowTokens: 32_000,
        maxOutputTokens: 2_000,
        safetyMarginTokens: 2_000,
        ids,
      }),
      toolCatalogRefresher: {
        refreshBeforeModelStep: async (step) =>
          step === 1
            ? undefined
            : tools.replaceNamespace("mcp", (register) => {
                register(tool("mcp__fixture__new", "new"));
              }),
      },
    });

    await expect(
      loop.runTurn({
        threadId: threadIdSchema.parse("catalog-loop-thread"),
        turnId: turnIdSchema.parse("catalog-loop-turn"),
        userInput: "Refresh tools.",
      }),
    ).resolves.toMatchObject({ status: "completed", steps: 2 });

    const changed = events.find(
      (event) => event.type === "tool.catalog_changed",
    );
    expect(changed).toMatchObject({
      type: "tool.catalog_changed",
      payload: {
        step: 2,
        previous: initialGeneration,
        current: tools.catalogGeneration(),
        changes: [
          expect.objectContaining({
            name: "mcp__fixture__new",
            change: "added",
          }),
          expect.objectContaining({
            name: "mcp__fixture__old",
            change: "removed",
          }),
        ],
      },
    });
    const changedIndex = events.indexOf(changed!);
    const preparedIndex = events.findIndex(
      (event) => event.type === "context.prepared" && event.payload.step === 2,
    );
    expect(changedIndex).toBeGreaterThan(-1);
    expect(changedIndex).toBeLessThan(preparedIndex);
    expect(events[preparedIndex]).toMatchObject({
      type: "context.prepared",
      payload: {
        toolCatalogGenerationId: tools.catalogGeneration().generationId,
      },
    });
  });

  it("fails before another Provider request when refresh fails", async () => {
    const tools = new ToolRegistry();
    tools.replaceNamespace("mcp", (register) => {
      register(tool("mcp__fixture__old", "old"));
    });
    const before = tools.catalogGeneration();
    const events: AgentEvent[] = [];
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("catalog-failure-call"),
            name: "mcp__fixture__old",
            arguments: {},
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
    ]);
    const error = Object.assign(new Error("refresh rejected"), {
      code: "MCP_TOOL_CATALOG_INVALID",
    });
    const loop = new AgentLoop({
      provider,
      tools,
      events: { append: async (event) => void events.push(event) },
      ids: new DeterministicItemIdFactory("catalog-failure-item"),
      toolCatalogRefresher: {
        refreshBeforeModelStep: async (step) => {
          if (step > 1) {
            throw error;
          }
          return undefined;
        },
      },
    });

    await expect(
      loop.runTurn({
        threadId: threadIdSchema.parse("catalog-failure-thread"),
        turnId: turnIdSchema.parse("catalog-failure-turn"),
        userInput: "Fail refresh.",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      steps: 1,
      error: { code: "MCP_TOOL_CATALOG_INVALID" },
    });
    expect(tools.catalogGeneration()).toEqual(before);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "turn.failed",
          payload: expect.objectContaining({
            code: "MCP_TOOL_CATALOG_INVALID",
            message: "refresh rejected",
          }),
        }),
      ]),
    );
  });
});

function tool(name: string, value: string) {
  return {
    spec: {
      name,
      description: `Return ${value}.`,
      inputJsonSchema: { type: "object" },
    },
    inputSchema: z.object({}).strict(),
    concurrency: "exclusive" as const,
    effect: "read" as const,
    catalogIdentity: { version: value },
    execute: async () => ({ value }),
  };
}
