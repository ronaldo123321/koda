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

    const first = historyEvent(3);
    const second = historyEvent(4);
    expect(
      threadEventsResultSchema.parse({
        events: [first, second],
        hasEarlier: true,
        nextBeforeSequence: 3,
      }),
    ).toMatchObject({ hasEarlier: true, nextBeforeSequence: 3 });
    expect(() =>
      threadEventsResultSchema.parse({
        events: [second, first],
        hasEarlier: true,
        nextBeforeSequence: 4,
      }),
    ).toThrow();
    expect(() =>
      threadEventsResultSchema.parse({
        events: [first],
        hasEarlier: false,
        nextBeforeSequence: 3,
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
