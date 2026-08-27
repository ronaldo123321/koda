import {
  APP_SERVER_PROTOCOL_VERSION,
  APP_SERVER_RPC_ERROR_CODE,
  agentEventSchema,
  approvalResolveParamsSchema,
  initializeParamsSchema,
  jsonRpcErrorResponseSchema,
  jsonRpcRequestSchema,
  threadEventsParamsSchema,
  threadEventsResultSchema,
  threadGetParamsSchema,
  threadSearchParamsSchema,
  threadSearchResultSchema,
  turnStartParamsSchema,
} from "@koda/protocol";
import { describe, expect, it } from "vitest";

describe("app-server protocol", () => {
  it("accepts strict versioned requests and safe JSON-RPC IDs", () => {
    expect(
      jsonRpcRequestSchema.parse({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: APP_SERVER_PROTOCOL_VERSION,
          client: { name: "test-client", version: "1.0.0" },
        },
      }),
    ).toMatchObject({ id: 1, method: "initialize" });
    expect(() =>
      jsonRpcRequestSchema.parse({
        jsonrpc: "2.0",
        id: Number.MAX_SAFE_INTEGER + 1,
        method: "initialize",
      }),
    ).toThrow();
    expect(() =>
      jsonRpcRequestSchema.parse({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        extra: true,
      }),
    ).toThrow();
  });

  it("validates method parameters without accepting transport secrets", () => {
    expect(
      initializeParamsSchema.parse({
        protocolVersion: APP_SERVER_PROTOCOL_VERSION,
        client: { name: "desktop" },
      }),
    ).toMatchObject({ protocolVersion: APP_SERVER_PROTOCOL_VERSION });
    expect(
      turnStartParamsSchema.parse({
        prompt: "Inspect the repository.",
        cwd: ".",
        provider: "deepseek",
        approvalMode: "on-request",
      }),
    ).not.toHaveProperty("apiKey");
    expect(() =>
      turnStartParamsSchema.parse({
        prompt: "Inspect.",
        apiKey: "must-not-cross-protocol",
      }),
    ).toThrow();
    expect(() =>
      turnStartParamsSchema.parse({
        prompt: "Inspect.",
        provider: "custom-provider",
      }),
    ).toThrow();
    expect(() =>
      threadGetParamsSchema.parse({ threadId: "../unsafe" }),
    ).toThrow();
    expect(() =>
      approvalResolveParamsSchema.parse({
        turnId: "turn",
        callId: "call",
        decision: "always",
      }),
    ).toThrow();
  });

  it("represents structured JSON-RPC errors", () => {
    expect(
      jsonRpcErrorResponseSchema.parse({
        jsonrpc: "2.0",
        id: "request-1",
        error: {
          code: APP_SERVER_RPC_ERROR_CODE.NOT_INITIALIZED,
          message: "Server is not initialized.",
          data: { code: "SERVER_NOT_INITIALIZED" },
        },
      }),
    ).toMatchObject({
      id: "request-1",
      error: { data: { code: "SERVER_NOT_INITIALIZED" } },
    });
  });

  it("validates strict chronological thread event pages", () => {
    expect(
      threadEventsParamsSchema.parse({
        threadId: "history-thread",
        beforeSequence: 10,
        limit: 25,
      }),
    ).toMatchObject({ beforeSequence: 10, limit: 25 });
    expect(() =>
      threadEventsParamsSchema.parse({
        threadId: "history-thread",
        limit: 201,
      }),
    ).toThrow();
    expect(() =>
      threadEventsParamsSchema.parse({
        threadId: "history-thread",
        beforeSequence: -1,
      }),
    ).toThrow();
    expect(() =>
      threadEventsParamsSchema.parse({
        threadId: "history-thread",
        beforeSequence: 4,
        afterSequence: 2,
      }),
    ).toThrow();

    const first = historyEvent(3);
    const second = historyEvent(4);
    expect(
      threadEventsResultSchema.parse({
        events: [first, second],
        hasEarlier: true,
        hasLater: true,
        nextBeforeSequence: 3,
        nextAfterSequence: 4,
      }),
    ).toMatchObject({
      hasEarlier: true,
      hasLater: true,
      nextBeforeSequence: 3,
      nextAfterSequence: 4,
    });
    expect(() =>
      threadEventsResultSchema.parse({
        events: [second, first],
        hasEarlier: true,
        hasLater: false,
        nextBeforeSequence: 4,
      }),
    ).toThrow();
    expect(() =>
      threadEventsResultSchema.parse({
        events: [first],
        hasEarlier: false,
        hasLater: false,
        nextBeforeSequence: 3,
      }),
    ).toThrow();
  });

  it("validates bounded revision-paginated thread search", () => {
    expect(
      threadSearchParamsSchema.parse({
        workspace: "/workspace",
        query: "修复 parser",
        limit: 25,
      }),
    ).toMatchObject({ query: "修复 parser", limit: 25 });
    expect(() =>
      threadSearchParamsSchema.parse({
        workspace: "/workspace",
        query: "one two three four five six seven eight nine",
      }),
    ).toThrow();
    expect(() =>
      threadSearchParamsSchema.parse({
        workspace: "/workspace",
        query: "x".repeat(257),
      }),
    ).toThrow();
    expect(() =>
      threadSearchParamsSchema.parse({
        workspace: "/workspace",
        query: "   ",
      }),
    ).toThrow();

    const match = {
      threadId: "history-thread",
      sequence: 4,
      kind: "assistant_message",
      timestamp: "2026-08-27T00:00:00.000Z",
      snippet: "parser repaired",
      threadUpdatedAt: "2026-08-27T00:00:01.000Z",
      status: "completed",
      provider: "openai",
      model: "gpt-test",
      turnCount: 1,
    } as const;
    expect(
      threadSearchResultSchema.parse({
        matches: [match],
        revision: 2,
        hasMore: true,
        nextCursor: {
          revision: 2,
          updatedAt: match.threadUpdatedAt,
          threadId: match.threadId,
          sequence: match.sequence,
        },
        diagnostics: [],
      }),
    ).toMatchObject({ revision: 2, hasMore: true });
    expect(() =>
      threadSearchResultSchema.parse({
        matches: [match],
        revision: 2,
        hasMore: true,
        nextCursor: {
          revision: 1,
          updatedAt: match.threadUpdatedAt,
          threadId: match.threadId,
          sequence: match.sequence,
        },
        diagnostics: [],
      }),
    ).toThrow();
  });
});

function historyEvent(sequence: number) {
  return agentEventSchema.parse({
    schemaVersion: 1,
    sequence,
    timestamp: "2026-08-27T00:00:00.000Z",
    threadId: "history-thread",
    turnId: "history-turn",
    type: "assistant.delta",
    payload: { text: `event ${sequence}` },
  });
}
