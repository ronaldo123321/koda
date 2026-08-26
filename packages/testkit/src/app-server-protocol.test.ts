import {
  APP_SERVER_PROTOCOL_VERSION,
  APP_SERVER_RPC_ERROR_CODE,
  approvalResolveParamsSchema,
  initializeParamsSchema,
  jsonRpcErrorResponseSchema,
  jsonRpcRequestSchema,
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
});
