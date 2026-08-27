import {
  APP_SERVER_PROTOCOL_VERSION,
  APP_SERVER_RPC_ERROR_CODE,
  agentEventSchema,
  approvalResolveParamsSchema,
  artifactReadParamsSchema,
  artifactReadResultSchema,
  contextInstructionReadParamsSchema,
  contextInstructionReadResultSchema,
  contextPreparedPayloadSchema,
  contextReadParamsSchema,
  contextReadResultSchema,
  initializeParamsSchema,
  jsonRpcErrorResponseSchema,
  jsonRpcRequestSchema,
  settingsGetResultSchema,
  settingsUpdateParamsSchema,
  settingsUpdateResultSchema,
  threadEventsParamsSchema,
  threadEventsResultSchema,
  threadArtifactsParamsSchema,
  threadArtifactsResultSchema,
  threadContextParamsSchema,
  threadContextResultSchema,
  threadGetParamsSchema,
  threadSearchParamsSchema,
  threadSearchResultSchema,
  turnStartParamsSchema,
} from "@koda/protocol";
import { describe, expect, it } from "vitest";

describe("app-server protocol", () => {
  it("accepts strict versioned requests and safe JSON-RPC IDs", () => {
    expect(APP_SERVER_PROTOCOL_VERSION).toBe(7);
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
      initializeParamsSchema.parse({
        protocolVersion: 6,
        client: { name: "legacy-client" },
      }),
    ).toThrow();
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

  it("validates strict revision-checked runtime settings without secrets", () => {
    expect(
      settingsUpdateParamsSchema.parse({
        workspace: "/workspace",
        provider: "deepseek",
        model: "deepseek-chat",
        expectedRevision: 2,
      }),
    ).toEqual({
      workspace: "/workspace",
      provider: "deepseek",
      model: "deepseek-chat",
      expectedRevision: 2,
    });
    expect(() =>
      settingsUpdateParamsSchema.parse({
        workspace: "/workspace",
        provider: "openai",
        model: "bad\nmodel",
        expectedRevision: 0,
      }),
    ).toThrow();
    expect(() =>
      settingsUpdateParamsSchema.parse({
        workspace: "/workspace",
        provider: "openai",
        model: "x".repeat(257),
        expectedRevision: 0,
      }),
    ).toThrow();
    expect(() =>
      settingsUpdateParamsSchema.parse({
        workspace: "/workspace",
        provider: "openai",
        model: "gpt-test",
        expectedRevision: 0,
        apiKey: "must-not-cross-protocol",
      }),
    ).toThrow();

    expect(
      settingsGetResultSchema.parse({
        workspace: "/workspace",
        revision: 0,
        diagnostics: [],
      }),
    ).toMatchObject({ revision: 0 });
    expect(() =>
      settingsGetResultSchema.parse({
        workspace: "/workspace",
        revision: 1,
        diagnostics: [],
      }),
    ).toThrow();
    expect(
      settingsUpdateResultSchema.parse({
        workspace: "/workspace",
        revision: 3,
        preference: {
          provider: "deepseek",
          model: "deepseek-chat",
          updatedAt: "2026-08-27T08:00:00.000Z",
        },
        diagnostics: [],
      }),
    ).toMatchObject({ revision: 3 });
  });

  it("validates thread-scoped artifact discovery and UTF-8 ranges", () => {
    const hash = "a".repeat(64);
    const artifact = {
      type: "artifact",
      id: `sha256:${hash}`,
      sha256: hash,
      bytes: 6,
      mediaType: "text/plain; charset=utf-8",
    } as const;
    expect(
      threadArtifactsParamsSchema.parse({
        workspace: "/workspace",
        threadId: "artifact-thread",
        beforeSequence: 20,
        limit: 10,
      }),
    ).toMatchObject({ beforeSequence: 20, limit: 10 });
    expect(() =>
      threadArtifactsParamsSchema.parse({
        workspace: "/workspace",
        threadId: "artifact-thread",
        limit: 0,
      }),
    ).toThrow();
    expect(() =>
      threadArtifactsParamsSchema.parse({
        workspace: "/workspace",
        threadId: "artifact-thread",
        limit: 101,
      }),
    ).toThrow();
    expect(
      threadArtifactsResultSchema.parse({
        workspace: "/workspace",
        threadId: "artifact-thread",
        artifacts: [
          {
            sequence: 12,
            callId: "artifact-call",
            name: "read_file",
            artifact,
          },
        ],
        hasEarlier: true,
        nextBeforeSequence: 12,
      }),
    ).toMatchObject({ hasEarlier: true, nextBeforeSequence: 12 });
    expect(() =>
      threadArtifactsResultSchema.parse({
        workspace: "/workspace",
        threadId: "artifact-thread",
        artifacts: [
          {
            sequence: 12,
            callId: "artifact-call",
            name: "read_file",
            artifact,
          },
        ],
        hasEarlier: false,
        nextBeforeSequence: 12,
      }),
    ).toThrow();

    expect(
      artifactReadParamsSchema.parse({
        workspace: "/workspace",
        threadId: "artifact-thread",
        artifactId: artifact.id,
        afterByte: 0,
        maxBytes: 16_384,
      }),
    ).toMatchObject({ artifactId: artifact.id, afterByte: 0 });
    expect(() =>
      artifactReadParamsSchema.parse({
        workspace: "/workspace",
        threadId: "artifact-thread",
        artifactId: artifact.id,
        maxBytes: 3,
      }),
    ).toThrow();
    expect(() =>
      artifactReadParamsSchema.parse({
        workspace: "/workspace",
        threadId: "artifact-thread",
        artifactId: artifact.id,
        beforeByte: 6,
        afterByte: 0,
      }),
    ).toThrow();
    expect(
      artifactReadResultSchema.parse({
        workspace: "/workspace",
        threadId: "artifact-thread",
        artifact,
        content: "你好",
        startByte: 0,
        endByte: 6,
        totalBytes: 6,
        hasEarlier: false,
        hasLater: false,
      }),
    ).toMatchObject({ content: "你好", endByte: 6 });
    expect(() =>
      artifactReadResultSchema.parse({
        workspace: "/workspace",
        threadId: "artifact-thread",
        artifact,
        content: "你",
        startByte: 0,
        endByte: 6,
        totalBytes: 6,
        hasEarlier: false,
        hasLater: false,
      }),
    ).toThrow();
  });

  it("validates precise context snapshots and opaque instruction ranges", () => {
    const hash = "a".repeat(64);
    const toolHash = "b".repeat(64);
    const sourceId = `ctxsrc:${"c".repeat(64)}`;
    const telemetry = {
      step: 1,
      contextWindowTokens: 10_000,
      maxOutputTokens: 1_000,
      safetyMarginTokens: 1_000,
      inputBudgetTokens: 8_000,
      fixedInputTokens: 100,
      rawEstimatedInputTokens: 200,
      estimatedInputTokens: 220,
      calibrationFactor: 1.1,
      activeItemCount: 1,
      activeItemTypes: [{ type: "user_message", count: 1 }],
      activeItemsSha256: hash,
      toolCount: 2,
      toolsSha256: toolHash,
    } as const;
    const request = {
      anchorSequence: 3,
      turnId: "context-turn",
      step: 1,
      timestamp: "2026-08-27T00:00:00.000Z",
      precise: true,
      provider: "openai",
      model: "gpt-test",
      estimatedInputTokens: 220,
      inputBudgetTokens: 8_000,
      activeItemCount: 1,
      toolCount: 2,
    } as const;

    expect(
      threadContextParamsSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        beforeSequence: 10,
        limit: 100,
      }),
    ).toMatchObject({ beforeSequence: 10, limit: 100 });
    expect(() =>
      threadContextParamsSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        limit: 101,
      }),
    ).toThrow();
    expect(
      threadContextResultSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        requests: [request],
        hasEarlier: true,
        nextBeforeSequence: 3,
      }),
    ).toMatchObject({ hasEarlier: true, nextBeforeSequence: 3 });
    expect(() =>
      threadContextResultSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        requests: [request],
        hasEarlier: false,
        nextBeforeSequence: 3,
      }),
    ).toThrow();

    expect(
      contextReadParamsSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        anchorSequence: 3,
      }),
    ).toMatchObject({ anchorSequence: 3 });
    expect(
      contextReadResultSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        request,
        turnContext: {
          provider: "openai",
          model: "gpt-test",
          workspaceRoot: "/workspace",
          approvalMode: "on-request",
          instructionsSha256: hash,
          repositoryInstructions: [],
        },
        telemetry,
        reconstruction: {
          activeItemCount: 1,
          activeItemTypes: [{ type: "user_message", count: 1 }],
          activeItemsSha256: hash,
          valid: true,
        },
        instructions: {
          historicalEffectiveSha256: hash,
          currentEffectiveSha256: hash,
          effectiveMatchesHistorical: true,
          sources: [
            {
              kind: "effective",
              sourceId,
              path: "effective",
              scope: ".",
              status: "unchanged",
              historical: { sha256: hash },
              current: { bytes: 10, sha256: hash },
            },
          ],
        },
      }),
    ).toMatchObject({ telemetry: { step: 1 } });
    expect(() =>
      contextReadResultSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        request,
        turnContext: {
          provider: "openai",
          model: "gpt-test",
          workspaceRoot: "/workspace",
          approvalMode: "on-request",
          instructionsSha256: hash,
          repositoryInstructions: [],
        },
        instructions: {
          historicalEffectiveSha256: hash,
          currentEffectiveSha256: hash,
          effectiveMatchesHistorical: true,
          sources: [],
        },
      }),
    ).toThrow();

    expect(
      contextInstructionReadParamsSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        anchorSequence: 3,
        sourceId,
        afterByte: 0,
        maxBytes: 16_384,
      }),
    ).toMatchObject({ sourceId, afterByte: 0 });
    expect(() =>
      contextInstructionReadParamsSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        anchorSequence: 3,
        sourceId: "AGENTS.md",
      }),
    ).toThrow();
    expect(() =>
      contextInstructionReadParamsSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        anchorSequence: 3,
        sourceId,
        beforeByte: 6,
        afterByte: 0,
      }),
    ).toThrow();
    expect(
      contextInstructionReadResultSchema.parse({
        workspace: "/workspace",
        threadId: "context-thread",
        anchorSequence: 3,
        sourceId,
        path: "AGENTS.md",
        content: "你好",
        startByte: 0,
        endByte: 6,
        totalBytes: 6,
        hasEarlier: false,
        hasLater: false,
      }),
    ).toMatchObject({ content: "你好" });

    expect(
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 3,
        timestamp: "2026-08-27T00:00:00.000Z",
        threadId: "context-thread",
        turnId: "context-turn",
        type: "context.prepared",
        payload: telemetry,
      }),
    ).toMatchObject({ type: "context.prepared" });
    expect(() =>
      contextPreparedPayloadSchema.parse({
        ...telemetry,
        activeItemCount: 2,
        activeItemTypes: [
          { type: "assistant_message", count: 1 },
          { type: "user_message", count: 1 },
        ],
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
