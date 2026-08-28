import { PassThrough, Writable } from "node:stream";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KodaApplication, type KodaApplicationDependencies } from "@koda/app";
import {
  KodaAppServer,
  JsonRpcMessageWriter,
  PendingApprovalRegistry,
  ProtocolLineTooLargeError,
  runStdioTransport,
  type ProtocolMessageWriter,
} from "@koda/app-server";
import type { ModelProvider } from "@koda/agent-core";
import {
  APP_SERVER_PROTOCOL_VERSION,
  agentEventSchema,
  itemIdSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type JsonValue,
} from "@koda/protocol";
import { ScriptedModelProvider } from "@koda/providers";
import {
  ArtifactStore,
  JsonlEventStore,
  ReadOnlyWorkspace,
} from "@koda/runtime-node";
import { afterEach, describe, expect, it } from "vitest";

import { DeterministicItemIdFactory } from "./deterministic.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class MemoryProtocolWriter implements ProtocolMessageWriter {
  public readonly messages: JsonValue[] = [];

  public async write(message: JsonValue): Promise<void> {
    this.messages.push(JSON.parse(JSON.stringify(message)) as JsonValue);
  }
}

describe("KodaAppServer", () => {
  it("enforces initialization and returns stable JSON-RPC errors", async () => {
    const fixture = await createFixture();
    const writer = new MemoryProtocolWriter();
    const server = createServer(fixture, writer);

    await server.handleLine("not-json");
    await request(server, 1, "thread/list", {});
    await request(server, 2, "initialize", {
      protocolVersion: 11,
      client: { name: "wrong-version" },
    });
    await initialize(server, 3);
    await request(server, 4, "initialize", {
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      client: { name: "duplicate" },
    });
    await request(server, 5, "missing/method", {});
    await request(server, 6, "thread/list", { limit: 0 });

    expect(errorCode(writer, null)).toBe(-32700);
    expect(errorDataCode(writer, 1)).toBe("SERVER_NOT_INITIALIZED");
    expect(errorDataCode(writer, 2)).toBe("PROTOCOL_VERSION_MISMATCH");
    expect(responseResult(writer, 3)).toMatchObject({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      capabilities: {
        durableEventNotifications: true,
        threadEvents: true,
        threadSearch: true,
        bidirectionalThreadEvents: true,
        runtimeSettings: true,
        artifactInspection: true,
        contextInspection: true,
        multiFileChanges: true,
        patchDocuments: true,
        approvalGrants: true,
        planning: true,
        planCheckpoints: true,
        stageAcceptance: true,
        extensionInspection: true,
        skills: true,
        commandTemplates: true,
        dynamicToolCatalog: true,
        plugins: true,
      },
      providers: [
        { id: "openai", defaultModel: "gpt-5.6-terra", configured: true },
        {
          id: "anthropic",
          defaultModel: "claude-sonnet-5",
          configured: false,
        },
        {
          id: "deepseek",
          defaultModel: "deepseek-v4-pro",
          configured: false,
        },
        { id: "kimi", defaultModel: "kimi-k2.6", configured: false },
        { id: "glm", defaultModel: "glm-5.2", configured: false },
      ],
    });
    expect(errorDataCode(writer, 4)).toBe("SERVER_ALREADY_INITIALIZED");
    expect(errorDataCode(writer, 5)).toBe("METHOD_NOT_FOUND");
    expect(errorDataCode(writer, 6)).toBe("INVALID_PARAMS");
  });

  it("serves revision-checked workspace runtime settings without credentials", async () => {
    const fixture = await createFixture();
    const writer = new MemoryProtocolWriter();
    const server = createServer(fixture, writer);
    const canonicalWorkspace = await realpath(fixture.workspaceRoot);
    await initialize(server, 1);

    await request(server, 2, "settings/get", {
      workspace: fixture.workspaceRoot,
    });
    expect(responseResult(writer, 2)).toMatchObject({
      workspace: canonicalWorkspace,
      revision: 0,
      diagnostics: [],
    });
    await request(server, 3, "settings/update", {
      workspace: fixture.workspaceRoot,
      provider: "openai",
      model: "gpt-settings-test",
      expectedRevision: 0,
    });
    expect(responseResult(writer, 3)).toMatchObject({
      revision: 1,
      preference: { provider: "openai", model: "gpt-settings-test" },
    });
    await request(server, 4, "settings/get", {
      workspace: fixture.workspaceRoot,
    });
    expect(responseResult(writer, 4)).toMatchObject({
      revision: 1,
      preference: { provider: "openai", model: "gpt-settings-test" },
    });
    await request(server, 5, "settings/update", {
      workspace: fixture.workspaceRoot,
      provider: "deepseek",
      model: "deepseek-chat",
      expectedRevision: 1,
    });
    expect(errorDataCode(writer, 5)).toBe("PROVIDER_CREDENTIAL_MISSING");
  });

  it("serves thread-authorized artifact lists and UTF-8 ranges", async () => {
    const fixture = await createFixture();
    const threadId = threadIdSchema.parse("server-artifact-thread");
    const canonicalWorkspace = await realpath(fixture.workspaceRoot);
    const store = await ArtifactStore.open(join(fixture.kodaHome, "artifacts"));
    const materialized = await store.materializeText(
      "server artifact 中文 content",
      { inlineBytes: 4 },
    );
    if (materialized.artifact === undefined) {
      throw new Error("Expected a published artifact.");
    }
    const log = new JsonlEventStore(
      join(fixture.kodaHome, "threads", `${threadId}.jsonl`),
    );
    await log.append(
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 0,
        timestamp: "2026-08-27T00:00:00.000Z",
        threadId,
        turnId: "server-artifact-turn",
        type: "turn.context",
        payload: {
          provider: "openai",
          model: "gpt-test",
          workspaceRoot: canonicalWorkspace,
          approvalMode: "on-request",
          instructionsSha256: "0".repeat(64),
          repositoryInstructions: [],
        },
      }),
    );
    await log.append(
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 1,
        timestamp: "2026-08-27T00:00:00.000Z",
        threadId,
        turnId: "server-artifact-turn",
        type: "artifact.recorded",
        payload: {
          callId: "server-artifact-call",
          name: "read_file",
          artifact: materialized.artifact,
        },
      }),
    );
    const writer = new MemoryProtocolWriter();
    const server = createServer(fixture, writer);
    await initialize(server, 1);
    await request(server, 2, "thread/artifacts", {
      workspace: fixture.workspaceRoot,
      threadId,
    });
    expect(responseResult(writer, 2)).toMatchObject({
      workspace: canonicalWorkspace,
      threadId,
      artifacts: [{ artifact: materialized.artifact }],
      hasEarlier: false,
    });
    await request(server, 3, "artifact/read", {
      workspace: fixture.workspaceRoot,
      threadId,
      artifactId: materialized.artifact.id,
      afterByte: 0,
      maxBytes: 8,
    });
    expect(responseResult(writer, 3)).toMatchObject({
      artifact: materialized.artifact,
      startByte: 0,
      hasEarlier: false,
      hasLater: true,
    });
    const escaped = await store.materializeText("\u0000".repeat(20_000), {
      inlineBytes: 4,
    });
    if (escaped.artifact === undefined) {
      throw new Error("Expected a response-budget artifact.");
    }
    await log.append(
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 2,
        timestamp: "2026-08-27T00:00:00.000Z",
        threadId,
        turnId: "server-artifact-turn",
        type: "artifact.recorded",
        payload: {
          callId: "server-budget-artifact-call",
          name: "exec_command",
          artifact: escaped.artifact,
        },
      }),
    );
    await request(server, 4, "artifact/read", {
      workspace: fixture.workspaceRoot,
      threadId,
      artifactId: escaped.artifact.id,
      maxBytes: 20_000,
    });
    expect(errorDataCode(writer, 4)).toBe("ARTIFACT_READ_RESULT_TOO_LARGE");
    await request(server, 5, "artifact/read", {
      workspace: fixture.workspaceRoot,
      threadId,
      artifactId: `sha256:${"f".repeat(64)}`,
      maxBytes: 8,
    });
    expect(errorDataCode(writer, 5)).toBe("ARTIFACT_NOT_REFERENCED");
  });

  it("maps synchronous application failures to structured server errors", async () => {
    const fixture = await createFixture();
    const writer = new MemoryProtocolWriter();
    const server = new KodaAppServer({
      application: new KodaApplication({
        environment: { KODA_HOME: fixture.kodaHome },
        processDirectory: fixture.root,
      }),
      writer,
      serverVersion: "test",
    });

    await initialize(server, 1);
    await request(server, 2, "turn/start", {
      prompt: "This cannot start without a provider credential.",
      cwd: fixture.workspaceRoot,
    });

    expect(errorCode(writer, 2)).toBe(-32050);
    expect(errorDataCode(writer, 2)).toBe("INVALID_CONFIGURATION");
  });

  it("rejects a Plan inspection response that exceeds its transport budget", async () => {
    const fixture = await createFixture();
    const canonicalWorkspace = await realpath(fixture.workspaceRoot);
    const threadId = threadIdSchema.parse("server-plan-budget-thread");
    const turnId = turnIdSchema.parse("server-plan-budget-turn");
    const events = [
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 0,
        timestamp: "2026-08-28T00:00:00.000Z",
        threadId,
        turnId,
        type: "turn.started",
        payload: {},
      }),
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 1,
        timestamp: "2026-08-28T00:00:00.000Z",
        threadId,
        turnId,
        type: "turn.context",
        payload: {
          provider: "openai",
          model: "fixture-model",
          workspaceRoot: canonicalWorkspace,
          approvalMode: "on-request",
          instructionsSha256: "a".repeat(64),
          repositoryInstructions: [],
        },
      }),
    ];
    for (let index = 0; index < 370; index += 1) {
      const callId = toolCallIdSchema.parse(`budget-call-${index}`);
      const name = `${index}-`.padEnd(1_024, "x");
      const sequence = 2 + index * 3;
      events.push(
        agentEventSchema.parse({
          schemaVersion: 1,
          sequence,
          timestamp: "2026-08-28T00:00:00.000Z",
          threadId,
          turnId,
          type: "item.recorded",
          payload: {
            item: {
              type: "tool_call",
              id: itemIdSchema.parse(`budget-item-${index}`),
              callId,
              name,
              arguments: {},
            },
          },
        }),
        agentEventSchema.parse({
          schemaVersion: 1,
          sequence: sequence + 1,
          timestamp: "2026-08-28T00:00:00.000Z",
          threadId,
          turnId,
          type: "tool.started",
          payload: { callId, name, executionBoundary: true },
        }),
        agentEventSchema.parse({
          schemaVersion: 1,
          sequence: sequence + 2,
          timestamp: "2026-08-28T00:00:00.000Z",
          threadId,
          turnId,
          type: "tool.execution_started",
          payload: { callId, name, effect: "write" },
        }),
      );
    }
    await mkdir(join(fixture.kodaHome, "threads"), { recursive: true });
    await writeFile(
      join(fixture.kodaHome, "threads", `${threadId}.jsonl`),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );
    const writer = new MemoryProtocolWriter();
    const server = createServer(fixture, writer);
    await initialize(server, 1);

    await request(server, 2, "plan/get", {
      workspace: fixture.workspaceRoot,
      threadId,
    });

    expect(errorDataCode(writer, 2)).toBe("PLAN_GET_RESULT_TOO_LARGE");
  });

  it("streams durable events, resolves approval, and exposes thread queries", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspaceRoot, "README.md"), "Before\n");
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("server-patch-call"),
            name: "apply_patch",
            arguments: {
              path: "README.md",
              operation: "update",
              old_text: "Before",
              new_text: "After",
            },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        events: [
          { type: "assistant_delta", text: "Patched through app-server." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const writer = new MemoryProtocolWriter();
    const server = createServer(fixture, writer, provider, "server-patch");
    await initialize(server, 1);
    await request(server, 2, "turn/start", {
      prompt: "Patch README.",
      cwd: fixture.workspaceRoot,
      approvalMode: "on-request",
    });
    const start = responseResult(writer, 2) as {
      threadId: string;
      turnId: string;
    };
    expect(start).toMatchObject({
      threadId: "server-patch-thread",
      turnId: "server-patch-turn",
    });
    await waitForMessage(
      writer,
      (message) =>
        notificationMethod(message) === "turn/event" &&
        eventType(message) === "approval.requested",
    );
    await request(server, 3, "approval/resolve", {
      turnId: start.turnId,
      callId: "server-patch-call",
      decision: "approved",
      reason: "Approved by test client.",
    });
    expect(responseResult(writer, 3)).toEqual({ accepted: true });
    await waitForMessage(
      writer,
      (message) => notificationMethod(message) === "turn/finished",
    );

    expect(
      await readFile(join(fixture.workspaceRoot, "README.md"), "utf8"),
    ).toBe("After\n");
    const eventTypes = writer.messages
      .filter((message) => notificationMethod(message) === "turn/event")
      .map(eventType);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "turn.started",
        "approval.requested",
        "approval.resolved",
        "tool.execution_started",
        "turn.completed",
      ]),
    );
    await request(server, 4, "thread/list", {});
    expect(responseResult(writer, 4)).toMatchObject({
      threads: [{ threadId: "server-patch-thread", status: "completed" }],
    });
    await request(server, 5, "thread/get", {
      threadId: "server-patch-thread",
    });
    expect(responseResult(writer, 5)).toMatchObject({
      thread: { threadId: "server-patch-thread", status: "completed" },
    });
    await request(server, 6, "thread/events", {
      threadId: "server-patch-thread",
      limit: 3,
    });
    expect(responseResult(writer, 6)).toMatchObject({
      events: [
        { sequence: expect.any(Number) },
        { sequence: expect.any(Number) },
        { sequence: expect.any(Number), type: "turn.completed" },
      ],
      hasEarlier: true,
      hasLater: false,
      nextBeforeSequence: expect.any(Number),
    });
    const latestPage = responseResult(writer, 6) as {
      nextBeforeSequence?: number;
    };
    if (latestPage.nextBeforeSequence === undefined) {
      throw new Error(
        "Latest app-server history page did not provide a cursor.",
      );
    }
    await request(server, 7, "thread/events", {
      threadId: "server-patch-thread",
      afterSequence: latestPage.nextBeforeSequence,
      limit: 2,
    });
    expect(responseResult(writer, 7)).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ sequence: expect.any(Number) }),
      ]),
      hasEarlier: true,
    });
    await request(server, 8, "thread/search", {
      workspace: fixture.workspaceRoot,
      query: "Patched app-server",
    });
    expect(responseResult(writer, 8)).toMatchObject({
      matches: [
        {
          threadId: "server-patch-thread",
          kind: "assistant_message",
          snippet: expect.stringContaining("Patched through app-server"),
        },
      ],
      hasMore: false,
      diagnostics: [],
    });
    await request(server, 9, "thread/context", {
      workspace: fixture.workspaceRoot,
      threadId: "server-patch-thread",
    });
    const contextPage = responseResult(writer, 9) as {
      requests?: Array<{ anchorSequence?: number; step?: number }>;
    };
    expect(contextPage).toMatchObject({
      requests: [
        { precise: true, step: 2 },
        { precise: true, step: 1 },
      ],
      hasEarlier: false,
    });
    const contextAnchor = contextPage.requests?.[0]?.anchorSequence;
    if (contextAnchor === undefined) {
      throw new Error("Context list did not provide an anchor.");
    }
    await request(server, 10, "context/read", {
      workspace: fixture.workspaceRoot,
      threadId: "server-patch-thread",
      anchorSequence: contextAnchor,
    });
    const contextDetail = responseResult(writer, 10) as {
      instructions?: {
        sources?: Array<{ kind?: string; sourceId?: string }>;
      };
    };
    expect(contextDetail).toMatchObject({
      request: { precise: true, step: 2 },
      reconstruction: { valid: true },
      instructions: { effectiveMatchesHistorical: true },
    });
    const effectiveSource = contextDetail.instructions?.sources?.find(
      (source) => source.kind === "effective",
    );
    if (effectiveSource?.sourceId === undefined) {
      throw new Error("Context detail did not expose the effective source.");
    }
    await request(server, 11, "context/instruction/read", {
      workspace: fixture.workspaceRoot,
      threadId: "server-patch-thread",
      anchorSequence: contextAnchor,
      sourceId: effectiveSource.sourceId,
      maxBytes: 128,
    });
    expect(responseResult(writer, 11)).toMatchObject({
      path: "effective",
      startByte: 0,
      hasEarlier: false,
      hasLater: true,
    });
    await request(server, 12, "shutdown", {});
    expect(responseResult(writer, 12)).toEqual({});
    expect(server.shouldClose).toBe(true);
  });

  it("resolves an exact Stage acceptance and serves the durable Plan", async () => {
    const fixture = await createFixture();
    const callId = toolCallIdSchema.parse("server-plan-call");
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId,
            name: "update_plan",
            arguments: gatedPlanInput(callId),
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        assertRequest: (request) => {
          expect(
            request.items.find(
              (item) => item.type === "tool_result" && item.callId === callId,
            ),
          ).toMatchObject({
            status: "success",
            output: {
              plan: { revision: 2, status: "completed" },
              acceptance: { status: "accepted" },
            },
          });
        },
        events: [{ type: "completed", finishReason: "stop" }],
      },
    ]);
    const writer = new MemoryProtocolWriter();
    const server = createServer(fixture, writer, provider, "server-plan");
    await initialize(server, 1);
    await request(server, 2, "turn/start", {
      prompt: "Finish and verify the gated Stage.",
      cwd: fixture.workspaceRoot,
    });
    const acceptanceRequest = await waitForMessage(
      writer,
      (message) =>
        notificationMethod(message) === "turn/event" &&
        eventType(message) === "plan.acceptance_requested",
    );
    const identity = planAcceptanceIdentity(acceptanceRequest);

    await request(server, 3, "plan/acceptance/resolve", {
      ...identity,
      planRevision: identity.planRevision + 1,
      decision: "accepted",
    });
    expect(errorDataCode(writer, 3)).toBe("PLAN_ACCEPTANCE_STALE");
    await request(server, 4, "plan/acceptance/resolve", {
      ...identity,
      decision: "accepted",
    });
    expect(responseResult(writer, 4)).toEqual({ accepted: true });
    await waitForMessage(
      writer,
      (message) => notificationMethod(message) === "turn/finished",
    );

    const durableEventTypes = writer.messages
      .filter((message) => notificationMethod(message) === "turn/event")
      .map(eventType);
    expect(durableEventTypes.indexOf("plan.updated")).toBeLessThan(
      durableEventTypes.indexOf("plan.acceptance_requested"),
    );
    expect(durableEventTypes.indexOf("plan.acceptance_requested")).toBeLessThan(
      durableEventTypes.indexOf("plan.acceptance_resolved"),
    );
    await request(server, 5, "plan/get", {
      workspace: fixture.workspaceRoot,
      threadId: identity.threadId,
    });
    expect(responseResult(writer, 5)).toMatchObject({
      threadId: identity.threadId,
      plan: {
        planId: identity.planId,
        revision: 2,
        status: "completed",
        stages: [{ id: identity.stageId, status: "accepted" }],
      },
      checkpoint: { planRevision: 2, reason: "turn_completion" },
      recovery: {
        previousTurnId: identity.turnId,
        previousStatus: "completed",
        needsRevalidation: false,
        uncertainToolCalls: [],
      },
    });
  });

  it("cancels a Turn that is waiting for Stage acceptance", async () => {
    const fixture = await createFixture();
    const callId = toolCallIdSchema.parse("server-plan-cancel-call");
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId,
            name: "update_plan",
            arguments: gatedPlanInput(callId),
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
    ]);
    const writer = new MemoryProtocolWriter();
    const server = createServer(
      fixture,
      writer,
      provider,
      "server-plan-cancel",
    );
    await initialize(server, 1);
    await request(server, 2, "turn/start", {
      prompt: "Wait for Stage acceptance.",
      cwd: fixture.workspaceRoot,
    });
    const start = responseResult(writer, 2) as { turnId: string };
    await waitForMessage(
      writer,
      (message) => eventType(message) === "plan.acceptance_requested",
    );

    await request(server, 3, "turn/cancel", {
      turnId: start.turnId,
      reason: "Acceptance client disconnected.",
    });
    expect(responseResult(writer, 3)).toEqual({ accepted: true });
    await expect(
      waitForMessage(
        writer,
        (message) =>
          notificationMethod(message) === "turn/finished" &&
          finishedTurnId(message) === start.turnId,
      ),
    ).resolves.toMatchObject({
      params: { status: "cancelled", exitCode: 130 },
    });
  });

  it("fails Stage acceptance closed when the client disconnects", async () => {
    const fixture = await createFixture();
    const callId = toolCallIdSchema.parse("server-plan-disconnect-call");
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId,
            name: "update_plan",
            arguments: gatedPlanInput(callId),
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
    ]);
    const writer = new MemoryProtocolWriter();
    const server = createServer(
      fixture,
      writer,
      provider,
      "server-plan-disconnect",
    );
    await initialize(server, 1);
    await request(server, 2, "turn/start", {
      prompt: "Wait for the client decision.",
      cwd: fixture.workspaceRoot,
    });
    const start = responseResult(writer, 2) as {
      threadId: string;
      turnId: string;
    };
    await waitForMessage(
      writer,
      (message) => eventType(message) === "plan.acceptance_requested",
    );

    await server.disconnect("Acceptance client disconnected.");

    expect(server.shouldClose).toBe(true);
    expect(
      writer.messages.some(
        (message) => eventType(message) === "plan.acceptance_resolved",
      ),
    ).toBe(false);
    await expect(
      waitForMessage(
        writer,
        (message) => finishedTurnId(message) === start.turnId,
      ),
    ).resolves.toMatchObject({
      params: { status: "cancelled", exitCode: 130 },
    });
    const durable = await new JsonlEventStore(
      join(fixture.kodaHome, "threads", `${start.threadId}.jsonl`),
    ).readAllRequired();
    expect(
      [...durable.events]
        .reverse()
        .find((event) => event.type === "plan.updated"),
    ).toMatchObject({
      payload: {
        plan: {
          revision: 1,
          stages: [{ status: "awaiting_acceptance" }],
        },
      },
    });
  });

  it("creates, lists, and revokes a session-scoped exact command grant", async () => {
    const fixture = await createFixture();
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("server-grant-call"),
            name: "exec_command",
            arguments: {
              argv: [process.execPath, "-e", "process.stdout.write('ok')"],
            },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      {
        events: [
          { type: "assistant_delta", text: "Command completed." },
          { type: "completed", finishReason: "stop" },
        ],
      },
    ]);
    const writer = new MemoryProtocolWriter();
    const server = createServer(fixture, writer, provider, "server-grant");
    await initialize(server, 1);
    await request(server, 2, "turn/start", {
      prompt: "Run a local command.",
      cwd: fixture.workspaceRoot,
      approvalMode: "on-request",
    });
    const start = responseResult(writer, 2) as { turnId: string };
    const requested = await waitForMessage(
      writer,
      (message) =>
        notificationMethod(message) === "turn/event" &&
        eventType(message) === "approval.requested",
    );
    expect(requested).toMatchObject({
      params: {
        event: {
          payload: {
            grantCandidate: {
              kind: "exact_command",
              defaultExpiresInSeconds: 900,
              maximumExpiresInSeconds: 3600,
            },
          },
        },
      },
    });
    await request(server, 3, "approval/resolve", {
      turnId: start.turnId,
      callId: "server-grant-call",
      decision: "approved",
      grant: { expiresInSeconds: 900 },
    });
    await waitForMessage(
      writer,
      (message) => notificationMethod(message) === "turn/finished",
    );
    expect(
      writer.messages.some(
        (message) =>
          notificationMethod(message) === "turn/event" &&
          eventType(message) === "approval.grant_created",
      ),
    ).toBe(true);

    await request(server, 4, "approval/grants/list", {
      workspace: fixture.workspaceRoot,
    });
    const listed = responseResult(writer, 4) as {
      grants: Array<{ id: string; uses: number }>;
    };
    expect(listed.grants).toHaveLength(1);
    expect(listed.grants[0]).toMatchObject({ uses: 0 });
    const grantId = listed.grants[0]?.id;
    if (grantId === undefined) {
      throw new Error("Grant fixture was not returned.");
    }
    await request(server, 5, "approval/grants/revoke", {
      workspace: fixture.workspaceRoot,
      grantId,
    });
    expect(responseResult(writer, 5)).toEqual({ revoked: true });
    await request(server, 6, "approval/grants/revokeAll", {
      workspace: fixture.workspaceRoot,
    });
    expect(responseResult(writer, 6)).toEqual({ revokedCount: 0 });
  });

  it("reuses an exact command grant across app-server turns", async () => {
    const fixture = await createFixture();
    const argv = [process.execPath, "-e", "process.stdout.write('reuse')"];
    const provider = new ScriptedModelProvider([
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("server-reuse-create-call"),
            name: "exec_command",
            arguments: { argv },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      { events: [{ type: "completed", finishReason: "stop" }] },
      {
        events: [
          {
            type: "tool_call",
            callId: toolCallIdSchema.parse("server-reuse-use-call"),
            name: "exec_command",
            arguments: { argv },
          },
          { type: "completed", finishReason: "tool_calls" },
        ],
      },
      { events: [{ type: "completed", finishReason: "stop" }] },
    ]);
    let idCursor = 0;
    const application = new KodaApplication({
      environment: {
        OPENAI_API_KEY: "offline-test-key",
        KODA_HOME: fixture.kodaHome,
      },
      processDirectory: fixture.root,
      dependencies: {
        openWorkspace: (root) => ReadOnlyWorkspace.open(root),
        createProvider: () => provider,
        createIds: () => {
          idCursor += 1;
          return {
            threadId: threadIdSchema.parse(`server-reuse-thread-${idCursor}`),
            turnId: turnIdSchema.parse(`server-reuse-turn-${idCursor}`),
            itemIds: new DeterministicItemIdFactory(
              `server-reuse-${idCursor}-item`,
            ),
          };
        },
      },
    });
    const writer = new MemoryProtocolWriter();
    const server = new KodaAppServer({
      application,
      writer,
      serverVersion: "test",
    });
    await initialize(server, 1);
    await request(server, 2, "turn/start", {
      prompt: "Run once and remember.",
      cwd: fixture.workspaceRoot,
      approvalMode: "on-request",
    });
    const first = responseResult(writer, 2) as { turnId: string };
    await waitForMessage(
      writer,
      (message) =>
        eventType(message) === "approval.requested" &&
        eventCallId(message) === "server-reuse-create-call",
    );
    await request(server, 3, "approval/resolve", {
      turnId: first.turnId,
      callId: "server-reuse-create-call",
      decision: "approved",
      grant: { expiresInSeconds: 900 },
    });
    await waitForMessage(
      writer,
      (message) => finishedTurnId(message) === first.turnId,
    );

    await request(server, 4, "turn/start", {
      prompt: "Run the same command again.",
      cwd: fixture.workspaceRoot,
      approvalMode: "on-request",
    });
    const second = responseResult(writer, 4) as { turnId: string };
    await waitForMessage(
      writer,
      (message) =>
        eventType(message) === "approval.grant_used" &&
        eventCallId(message) === "server-reuse-use-call",
    );
    await waitForMessage(
      writer,
      (message) => finishedTurnId(message) === second.turnId,
    );
    expect(
      writer.messages.some(
        (message) =>
          eventType(message) === "approval.requested" &&
          eventCallId(message) === "server-reuse-use-call",
      ),
    ).toBe(false);
    await request(server, 5, "approval/grants/list", {
      workspace: fixture.workspaceRoot,
    });
    expect(responseResult(writer, 5)).toMatchObject({
      grants: [{ uses: 1 }],
    });
  });

  it("cancels an active turn and emits a finished notification", async () => {
    const fixture = await createFixture();
    let started: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider: ModelProvider = {
      stream: async function* (_request, signal) {
        started?.();
        await waitForAbort(signal);
        signal.throwIfAborted();
      },
    };
    const writer = new MemoryProtocolWriter();
    const server = createServer(fixture, writer, provider, "server-cancel");
    await initialize(server, 1);
    await request(server, 2, "turn/start", {
      prompt: "Wait for cancellation.",
      cwd: fixture.workspaceRoot,
    });
    await providerStarted;
    const start = responseResult(writer, 2) as { turnId: string };
    await request(server, 3, "turn/cancel", {
      turnId: start.turnId,
      reason: "Cancelled by JSON-RPC test.",
    });
    expect(responseResult(writer, 3)).toEqual({ accepted: true });
    const finished = await waitForMessage(
      writer,
      (message) => notificationMethod(message) === "turn/finished",
    );
    expect(notificationParams(finished)).toMatchObject({
      status: "cancelled",
      exitCode: 130,
      error: { code: "TURN_CANCELLED" },
    });
  });

  it("cancels active turns before acknowledging shutdown", async () => {
    const fixture = await createFixture();
    let started: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider: ModelProvider = {
      stream: async function* (_request, signal) {
        started?.();
        await waitForAbort(signal);
        signal.throwIfAborted();
      },
    };
    const writer = new MemoryProtocolWriter();
    const server = createServer(fixture, writer, provider, "server-shutdown");
    await initialize(server, 1);
    await request(server, 2, "turn/start", {
      prompt: "Wait for shutdown.",
      cwd: fixture.workspaceRoot,
    });
    await providerStarted;

    await request(server, 3, "shutdown", {});

    const finished = writer.messages.find(
      (message) => notificationMethod(message) === "turn/finished",
    );
    if (finished === undefined) {
      throw new Error("Shutdown did not emit a turn/finished notification.");
    }
    const finishedIndex = writer.messages.indexOf(finished);
    const responseIndex = writer.messages.findIndex(
      (message) => isObject(message) && message.id === 3,
    );
    expect(finishedIndex).toBeGreaterThan(-1);
    expect(responseIndex).toBeGreaterThan(finishedIndex);
    expect(notificationParams(finished)).toMatchObject({
      status: "cancelled",
      exitCode: 130,
    });
    expect(responseResult(writer, 3)).toEqual({});
    expect(server.shouldClose).toBe(true);
  });

  it("uses the same active-turn cleanup path when stdio reaches EOF", async () => {
    const fixture = await createFixture();
    let started: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider: ModelProvider = {
      stream: async function* (_request, signal) {
        started?.();
        await waitForAbort(signal);
        signal.throwIfAborted();
      },
    };
    const writer = new MemoryProtocolWriter();
    const server = createServer(fixture, writer, provider, "server-eof");
    const input = new PassThrough();
    const transport = runStdioTransport(server, input);
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: APP_SERVER_PROTOCOL_VERSION,
          client: { name: "eof-test" },
        },
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "turn/start",
        params: { prompt: "Wait for EOF.", cwd: fixture.workspaceRoot },
      })}\n`,
    );
    await providerStarted;

    input.end();
    await transport;

    const finished = await waitForMessage(
      writer,
      (message) => notificationMethod(message) === "turn/finished",
    );
    expect(notificationParams(finished)).toMatchObject({
      status: "cancelled",
      exitCode: 130,
    });
    expect(server.shouldClose).toBe(true);
  });

  it("tracks one-shot approvals and bounds stdio input", async () => {
    const approvals = new PendingApprovalRegistry();
    const turnId = turnIdSchema.parse("registry-turn");
    const callId = toolCallIdSchema.parse("registry-call");
    approvals.preregister(turnId, callId);
    const broker = approvals.broker(() => turnId);
    const pending = broker.request(
      {
        callId,
        name: "apply_patch",
        title: "Patch",
        summary: "Patch a file",
        details: "details",
        reason: "write",
      },
      new AbortController().signal,
    );
    expect(approvals.resolve(turnId, callId, { decision: "approved" })).toBe(
      "accepted",
    );
    await expect(pending).resolves.toEqual({ decision: "approved" });
    expect(approvals.resolve(turnId, callId, { decision: "rejected" })).toBe(
      "already_resolved",
    );

    const earlyCallId = toolCallIdSchema.parse("registry-early-call");
    approvals.preregister(turnId, earlyCallId);
    expect(
      approvals.resolve(turnId, earlyCallId, {
        decision: "rejected",
        reason: "Resolved before the broker starts waiting.",
      }),
    ).toBe("accepted");
    await expect(
      broker.request(
        {
          callId: earlyCallId,
          name: "apply_patch",
          title: "Patch",
          summary: "Patch a file",
          details: "details",
          reason: "write",
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      decision: "rejected",
      reason: "Resolved before the broker starts waiting.",
    });
    expect(
      approvals.resolve(turnId, earlyCallId, { decision: "approved" }),
    ).toBe("already_resolved");

    const fixture = await createFixture();
    const writer = new MemoryProtocolWriter();
    const server = createServer(fixture, writer);
    const input = new PassThrough();
    const transport = runStdioTransport(server, input, {
      maximumLineBytes: 10,
    });
    input.end("12345678901");
    await expect(transport).rejects.toBeInstanceOf(ProtocolLineTooLargeError);
  });

  it("serializes concurrent protocol writes into complete NDJSON lines", async () => {
    const chunks: string[] = [];
    let writeCount = 0;
    const output = new Writable({
      write(chunk, _encoding, callback) {
        writeCount += 1;
        const delay = writeCount === 1 ? 10 : 0;
        setTimeout(() => {
          chunks.push(chunk.toString());
          callback();
        }, delay);
      },
    });
    const writer = new JsonRpcMessageWriter(output);

    await Promise.all([
      writer.write({ jsonrpc: "2.0", id: 1, result: { order: 1 } }),
      writer.write({ jsonrpc: "2.0", id: 2, result: { order: 2 } }),
    ]);

    expect(chunks).toEqual([
      '{"jsonrpc":"2.0","id":1,"result":{"order":1}}\n',
      '{"jsonrpc":"2.0","id":2,"result":{"order":2}}\n',
    ]);
  });
});

function createServer(
  fixture: TestFixture,
  writer: MemoryProtocolWriter,
  provider: ModelProvider = new ScriptedModelProvider([]),
  prefix = "server-default",
): KodaAppServer {
  return new KodaAppServer({
    application: new KodaApplication({
      environment: {
        OPENAI_API_KEY: "offline-test-key",
        KODA_HOME: fixture.kodaHome,
      },
      processDirectory: fixture.root,
      dependencies: dependencies(provider, prefix),
    }),
    writer,
    serverVersion: "test",
  });
}

interface TestFixture {
  root: string;
  workspaceRoot: string;
  kodaHome: string;
}

async function createFixture(): Promise<TestFixture> {
  const root = await mkdtemp(join(tmpdir(), "koda-app-server-"));
  temporaryDirectories.push(root);
  const workspaceRoot = join(root, "repo");
  await mkdir(workspaceRoot);
  return { root, workspaceRoot, kodaHome: join(root, "state") };
}

function dependencies(
  provider: ModelProvider,
  prefix: string,
): KodaApplicationDependencies {
  return {
    openWorkspace: (root) => ReadOnlyWorkspace.open(root),
    createProvider: () => provider,
    createIds: (resumeThreadId) => ({
      threadId: resumeThreadId ?? threadIdSchema.parse(`${prefix}-thread`),
      turnId: turnIdSchema.parse(`${prefix}-turn`),
      itemIds: new DeterministicItemIdFactory(`${prefix}-item`),
    }),
  };
}

async function initialize(server: KodaAppServer, id: number): Promise<void> {
  await request(server, id, "initialize", {
    protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    client: { name: "vitest", version: "1" },
  });
}

async function request(
  server: KodaAppServer,
  id: number,
  method: string,
  params: JsonValue,
): Promise<void> {
  await server.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  );
}

function responseResult(writer: MemoryProtocolWriter, id: number): JsonValue {
  const response = writer.messages.find(
    (message) => isObject(message) && message.id === id && "result" in message,
  );
  if (!isObject(response) || !("result" in response)) {
    throw new Error(`Response ${id} was not found.`);
  }
  return response.result ?? null;
}

function errorCode(
  writer: MemoryProtocolWriter,
  id: number | null,
): number | undefined {
  const error = responseError(writer, id);
  return isObject(error) && typeof error.code === "number"
    ? error.code
    : undefined;
}

function errorDataCode(
  writer: MemoryProtocolWriter,
  id: number,
): string | undefined {
  const error = responseError(writer, id);
  return isObject(error) &&
    isObject(error.data) &&
    typeof error.data.code === "string"
    ? error.data.code
    : undefined;
}

function responseError(
  writer: MemoryProtocolWriter,
  id: number | null,
): JsonValue | undefined {
  const response = writer.messages.find(
    (message) => isObject(message) && message.id === id && "error" in message,
  );
  return isObject(response) ? response.error : undefined;
}

async function waitForMessage(
  writer: MemoryProtocolWriter,
  predicate: (message: JsonValue) => boolean,
): Promise<JsonValue> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const message = writer.messages.find(predicate);
    if (message !== undefined) {
      return message;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for an app-server message.");
}

function notificationMethod(message: JsonValue): string | undefined {
  return isObject(message) && typeof message.method === "string"
    ? message.method
    : undefined;
}

function notificationParams(message: JsonValue): JsonValue | undefined {
  return isObject(message) ? message.params : undefined;
}

function eventType(message: JsonValue): string | undefined {
  const params = notificationParams(message);
  return isObject(params) &&
    isObject(params.event) &&
    typeof params.event.type === "string"
    ? params.event.type
    : undefined;
}

function eventCallId(message: JsonValue): string | undefined {
  const params = notificationParams(message);
  return isObject(params) &&
    isObject(params.event) &&
    isObject(params.event.payload) &&
    typeof params.event.payload.callId === "string"
    ? params.event.payload.callId
    : undefined;
}

function finishedTurnId(message: JsonValue): string | undefined {
  const params = notificationParams(message);
  return notificationMethod(message) === "turn/finished" &&
    isObject(params) &&
    typeof params.turnId === "string"
    ? params.turnId
    : undefined;
}

function planAcceptanceIdentity(message: JsonValue): {
  threadId: string;
  turnId: string;
  callId: string;
  planId: string;
  planRevision: number;
  stageId: string;
} {
  const params = notificationParams(message);
  const event = isObject(params) ? params.event : undefined;
  const payload = isObject(event) ? event.payload : undefined;
  if (
    !isObject(event) ||
    !isObject(payload) ||
    typeof event.threadId !== "string" ||
    typeof event.turnId !== "string" ||
    typeof payload.callId !== "string" ||
    typeof payload.planId !== "string" ||
    typeof payload.planRevision !== "number" ||
    typeof payload.stageId !== "string"
  ) {
    throw new Error("Plan acceptance notification has invalid identity.");
  }
  return {
    threadId: event.threadId,
    turnId: event.turnId,
    callId: payload.callId,
    planId: payload.planId,
    planRevision: payload.planRevision,
    stageId: payload.stageId,
  };
}

function gatedPlanInput(callId: ReturnType<typeof toolCallIdSchema.parse>) {
  return {
    expected_revision: 0,
    objective: "Finish the gated app-server work",
    stages: [
      {
        id: "stage-gated",
        title: "Gated Stage",
        requires_acceptance: true,
        acceptance_criteria: ["Regression tests pass"],
        summary: "Implementation and tests are complete.",
        evidence: [{ kind: "tool_call", callId }],
        todos: [
          {
            id: "todo-gated",
            title: "Implement and test",
            status: "completed",
            outcome: "Implemented with passing tests.",
          },
        ],
      },
    ],
  };
}

function isObject(
  value: JsonValue | undefined,
): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
