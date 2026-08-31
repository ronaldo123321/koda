import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  AppServerClientError,
  AppServerRpcConnection,
  AppServerRpcError,
  NodeAppServerClient,
  type AppServerNotification,
} from "@koda/app-server-client-node";
import {
  APP_SERVER_PROTOCOL_VERSION,
  planAcceptanceResolveParamsSchema,
  threadIdSchema,
  turnIdSchema,
} from "@koda/protocol";
import { ArtifactStore } from "@koda/runtime-node";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("AppServerRpcConnection", () => {
  it("correlates fragmented responses and dispatches typed notifications", async () => {
    const fixture = createConnection();
    const notifications: AppServerNotification[] = [];
    fixture.connection.onNotification((notification) => {
      notifications.push(notification);
    });
    const result = fixture.connection.request(
      "fixture/value",
      {},
      z.object({ value: z.string() }).strict(),
    );
    const request = await readMessage(fixture.requests);
    fixture.responses.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "turn/event", params: { event: event("assistant.delta", { text: "hello" }) } })}\n`,
    );
    const response = `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { value: "ok" } })}\n`;
    fixture.responses.write(response.slice(0, 11));
    fixture.responses.write(response.slice(11));

    await expect(result).resolves.toEqual({ value: "ok" });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      method: "turn/event",
      params: {
        event: { type: "assistant.delta", payload: { text: "hello" } },
      },
    });
    fixture.connection.close();
  });

  it("surfaces structured RPC errors without closing the connection", async () => {
    const fixture = createConnection();
    const failed = fixture.connection.request(
      "fixture/fail",
      {},
      z.object({}).strict(),
    );
    const first = await readMessage(fixture.requests);
    fixture.responses.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: first.id, error: { code: -32050, message: "Rejected.", data: { code: "FIXTURE_REJECTED" } } })}\n`,
    );
    await expect(failed).rejects.toMatchObject({
      name: "AppServerRpcError",
      rpcCode: -32050,
      dataCode: "FIXTURE_REJECTED",
    } satisfies Partial<AppServerRpcError>);

    const succeeded = fixture.connection.request(
      "fixture/next",
      {},
      z.object({ accepted: z.literal(true) }).strict(),
    );
    const second = await readMessage(fixture.requests);
    fixture.responses.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: second.id, result: { accepted: true } })}\n`,
    );
    await expect(succeeded).resolves.toEqual({ accepted: true });
    expect(fixture.connection.isClosed).toBe(false);
    fixture.connection.close();
  });

  it("fails closed on invalid messages, unknown notifications, and line limits", async () => {
    for (const payload of [
      "not-json\n",
      `${JSON.stringify({ jsonrpc: "2.0", method: "unknown/event", params: {} })}\n`,
      `${"x".repeat(33)}\n`,
    ]) {
      const fixture = createConnection({ maximumLineBytes: 32 });
      const pending = fixture.connection.request(
        "fixture/pending",
        {},
        z.object({}).strict(),
      );
      await readMessage(fixture.requests);
      fixture.responses.write(payload);
      await expect(pending).rejects.toMatchObject({
        code: "APP_SERVER_PROTOCOL_ERROR",
      } satisfies Partial<AppServerClientError>);
      expect(fixture.connection.isClosed).toBe(true);
    }
  });

  it("times out one request without fabricating a connection failure", async () => {
    const fixture = createConnection({ requestTimeoutMs: 10 });
    const pending = fixture.connection.request(
      "fixture/slow",
      {},
      z.object({}).strict(),
    );
    await readMessage(fixture.requests);
    await expect(pending).rejects.toMatchObject({
      code: "APP_SERVER_REQUEST_TIMEOUT",
    } satisfies Partial<AppServerClientError>);
    expect(fixture.connection.isClosed).toBe(false);
    fixture.connection.close();
  });
});

describe("NodeAppServerClient", () => {
  it("initializes the real app-server and performs credential-free queries", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-app-client-smoke-"));
    temporaryDirectories.push(root);
    const canonicalRoot = await realpath(root);
    const stateRoot = join(root, "state");
    const eventLogDirectory = join(stateRoot, "threads");
    await mkdir(eventLogDirectory, { recursive: true });
    const artifactStore = await ArtifactStore.open(
      join(stateRoot, "artifacts"),
    );
    const skillDirectory = join(root, ".koda", "skills", "client-review");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "---\nname: client-review\ndescription: Review through protocol v13.\n---\nReview the current client request.\n",
    );
    const materialized = await artifactStore.materializeText(
      "client artifact 中文 content",
      { inlineBytes: 4 },
    );
    if (materialized.artifact === undefined) {
      throw new Error("Expected a published artifact.");
    }
    await writeFile(
      join(eventLogDirectory, "client-history.jsonl"),
      [
        {
          schemaVersion: 1,
          sequence: 0,
          timestamp: "2026-08-27T00:00:00.000Z",
          threadId: "client-history",
          turnId: "client-history-turn",
          type: "turn.started",
          payload: {},
        },
        {
          schemaVersion: 1,
          sequence: 1,
          timestamp: "2026-08-27T00:00:01.000Z",
          threadId: "client-history",
          turnId: "client-history-turn",
          type: "turn.context",
          payload: {
            provider: "openai",
            model: "fixture-model",
            workspaceRoot: canonicalRoot,
            approvalMode: "on-request",
            instructionsSha256: "a".repeat(64),
            repositoryInstructions: [],
          },
        },
        {
          schemaVersion: 1,
          sequence: 2,
          timestamp: "2026-08-27T00:00:02.000Z",
          threadId: "client-history",
          turnId: "client-history-turn",
          type: "item.recorded",
          payload: {
            item: {
              type: "user_message",
              id: "client-search-message",
              content: "searchable client history",
            },
          },
        },
        {
          schemaVersion: 1,
          sequence: 3,
          timestamp: "2026-08-27T00:00:03.000Z",
          threadId: "client-history",
          turnId: "client-history-turn",
          type: "model.usage",
          payload: {
            step: 1,
            responseId: "legacy-client-response",
            usage: {
              inputTokens: 21,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              outputTokens: 4,
              reasoningOutputTokens: 0,
              totalTokens: 25,
            },
          },
        },
        {
          schemaVersion: 1,
          sequence: 4,
          timestamp: "2026-08-27T00:00:04.000Z",
          threadId: "client-history",
          turnId: "client-history-turn",
          type: "artifact.recorded",
          payload: {
            callId: "client-artifact-call",
            name: "read_file",
            artifact: materialized.artifact,
          },
        },
        {
          schemaVersion: 1,
          sequence: 5,
          timestamp: "2026-08-27T00:00:05.000Z",
          threadId: "client-history",
          turnId: "client-history-turn",
          type: "turn.completed",
          payload: { steps: 1 },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
      "utf8",
    );
    const client = await NodeAppServerClient.connect({
      cwd: root,
      environment: {
        ...process.env,
        KODA_HOME: stateRoot,
        OPENAI_API_KEY: "offline-settings-key",
      },
      clientName: "app-server-client-test",
    });

    expect(client.initialization).toMatchObject({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      capabilities: {
        interactiveApproval: true,
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
        workspaceMutationRecovery: true,
        interactiveProcesses: false,
        secretEvidence: true,
        resourceEvidence: true,
      },
      providers: [
        { id: "openai", configured: true },
        { id: "anthropic", configured: false },
        { id: "deepseek", configured: false },
        { id: "kimi", configured: false },
        { id: "glm", configured: false },
      ],
    });
    await expect(client.listThreads()).resolves.toMatchObject({
      threads: [{ threadId: "client-history" }],
    });
    await expect(
      client.listWorkspaceMutationConflicts({ workspace: canonicalRoot }),
    ).resolves.toEqual({ workspace: canonicalRoot, conflicts: [] });
    await expect(
      client.getRuntimeSettings({ workspace: canonicalRoot }),
    ).resolves.toMatchObject({ revision: 0, diagnostics: [] });
    await expect(
      client.listApprovalGrants({ workspace: canonicalRoot }),
    ).resolves.toEqual({ workspace: canonicalRoot, grants: [] });
    await expect(
      client.revokeApprovalGrant({
        workspace: canonicalRoot,
        grantId: "grant:not-present",
      }),
    ).resolves.toEqual({ revoked: false });
    await expect(
      client.revokeAllApprovalGrants({ workspace: canonicalRoot }),
    ).resolves.toEqual({ revokedCount: 0 });
    await expect(
      client.updateRuntimeSettings({
        workspace: canonicalRoot,
        provider: "openai",
        model: "gpt-client-settings",
        expectedRevision: 0,
      }),
    ).resolves.toMatchObject({
      revision: 1,
      preference: { provider: "openai", model: "gpt-client-settings" },
    });
    await expect(
      client.readThreadEvents({
        threadId: threadIdSchema.parse("client-history"),
      }),
    ).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          sequence: 0,
          type: "turn.started",
          payload: {},
        }),
      ]),
      hasEarlier: false,
      hasLater: false,
    });
    await expect(
      client.getPlan({
        workspace: canonicalRoot,
        threadId: threadIdSchema.parse("client-history"),
      }),
    ).resolves.toMatchObject({
      workspace: canonicalRoot,
      threadId: "client-history",
      recovery: {
        previousTurnId: "client-history-turn",
        previousStatus: "completed",
        needsRevalidation: false,
        uncertainToolCalls: [],
      },
    });
    const extensionCatalog = await client.inspectExtensionCatalog({
      workspace: canonicalRoot,
    });
    expect(extensionCatalog).toMatchObject({
      workspace: canonicalRoot,
      skills: [{ name: "client-review" }],
      commandTemplates: [],
      configuredPlugins: [],
    });
    await expect(
      client.readExtensionSource({
        workspace: canonicalRoot,
        kind: "skill",
        sourceId: extensionCatalog.skills[0]!.skillId,
      }),
    ).resolves.toMatchObject({
      path: ".koda/skills/client-review/SKILL.md",
      content: expect.stringContaining("Review the current client request."),
    });
    await expect(
      client.inspectThreadExtensions({
        workspace: canonicalRoot,
        threadId: threadIdSchema.parse("client-history"),
      }),
    ).resolves.toMatchObject({
      anchorSequence: 1,
      turnId: "client-history-turn",
      skills: [],
      commandTemplates: [],
      plugins: [],
    });
    await expect(
      client.searchThreads({
        workspace: canonicalRoot,
        query: "client history",
      }),
    ).resolves.toMatchObject({
      matches: [
        {
          threadId: "client-history",
          sequence: 2,
          kind: "user_message",
        },
      ],
      hasMore: false,
    });
    await expect(
      client.listThreadArtifacts({
        workspace: canonicalRoot,
        threadId: threadIdSchema.parse("client-history"),
      }),
    ).resolves.toMatchObject({
      artifacts: [{ artifact: materialized.artifact }],
      hasEarlier: false,
    });
    await expect(
      client.readArtifact({
        workspace: canonicalRoot,
        threadId: threadIdSchema.parse("client-history"),
        artifactId: materialized.artifact.id,
        maxBytes: 8,
      }),
    ).resolves.toMatchObject({
      artifact: materialized.artifact,
      startByte: 0,
      hasEarlier: false,
      hasLater: true,
    });
    const contexts = await client.listThreadContexts({
      workspace: canonicalRoot,
      threadId: threadIdSchema.parse("client-history"),
    });
    expect(contexts).toMatchObject({
      requests: [
        {
          anchorSequence: 3,
          precise: false,
          measuredInputTokens: 21,
        },
      ],
      hasEarlier: false,
    });
    const detail = await client.readContext({
      workspace: canonicalRoot,
      threadId: threadIdSchema.parse("client-history"),
      anchorSequence: 3,
    });
    expect(detail).toMatchObject({
      request: { precise: false },
      usage: { responseId: "legacy-client-response" },
      instructions: { effectiveMatchesHistorical: false },
    });
    const effective = detail.instructions.sources.find(
      (source) => source.kind === "effective",
    );
    if (effective?.sourceId === undefined) {
      throw new Error("Expected a readable effective instruction source.");
    }
    await expect(
      client.readContextInstruction({
        workspace: canonicalRoot,
        threadId: threadIdSchema.parse("client-history"),
        anchorSequence: 3,
        sourceId: effective.sourceId,
        maxBytes: 64,
      }),
    ).resolves.toMatchObject({
      path: "effective",
      startByte: 0,
      hasEarlier: false,
      hasLater: true,
    });
    await expect(
      client.readThreadEvents({
        threadId: threadIdSchema.parse("missing-history"),
      }),
    ).rejects.toMatchObject({
      name: "AppServerRpcError",
      dataCode: "THREAD_EVENT_LOG_NOT_FOUND",
    });
    expect(client.diagnostics()).toBe("");
    await expect(client.shutdown()).resolves.toBeUndefined();
    await expect(client.shutdown()).resolves.toBeUndefined();
  });

  it("bounds child diagnostics and waits for graceful fixture shutdown", async () => {
    const client = await NodeAppServerClient.connect({
      command: process.execPath,
      args: ["-e", fixtureServerScript({ stderrBytes: 128 })],
      maximumStderrBytes: 32,
      shutdownTimeoutMs: 500,
    });
    await waitUntil(() => client.diagnostics().length > 0);
    expect(Buffer.byteLength(client.diagnostics())).toBe(32);
    expect(client.diagnostics()).toBe("d".repeat(32));
    await expect(client.shutdown()).resolves.toBeUndefined();
  });

  it("sends and validates typed Plan inspection and acceptance RPCs", async () => {
    const client = await NodeAppServerClient.connect({
      command: process.execPath,
      args: ["-e", fixtureServerScript({})],
      shutdownTimeoutMs: 500,
    });

    await expect(
      client.getPlan({
        workspace: "/workspace",
        threadId: threadIdSchema.parse("fixture-plan-thread"),
      }),
    ).resolves.toMatchObject({
      workspace: "/workspace",
      threadId: "fixture-plan-thread",
      recovery: { previousStatus: "completed", uncertainToolCalls: [] },
    });
    await expect(
      client.resolvePlanAcceptance(
        planAcceptanceResolveParamsSchema.parse({
          threadId: "fixture-plan-thread",
          turnId: "fixture-plan-turn",
          callId: "fixture-plan-call",
          planId: "plan:fixture",
          planRevision: 1,
          stageId: "stage:fixture",
          decision: "accepted",
        }),
      ),
    ).resolves.toEqual({ accepted: true });
    await client.shutdown();
  });

  it("reports an unexpected child exit and closes future requests", async () => {
    const client = await NodeAppServerClient.connect({
      command: process.execPath,
      args: ["-e", fixtureServerScript({ exitAfterInitialize: true })],
      requestTimeoutMs: 1_000,
    });
    const disconnected = new Promise<Error | undefined>((resolve) => {
      client.onDisconnect(resolve);
    });
    await expect(disconnected).resolves.toMatchObject({
      code: "APP_SERVER_CONNECTION_CLOSED",
    });
    await expect(client.listThreads()).rejects.toMatchObject({
      code: "APP_SERVER_CONNECTION_CLOSED",
    });
  });
});

function createConnection(
  options: {
    maximumLineBytes?: number;
    requestTimeoutMs?: number;
  } = {},
) {
  const responses = new PassThrough();
  const requests = new PassThrough();
  const connection = new AppServerRpcConnection({
    input: responses,
    output: requests,
    ...options,
  });
  return { connection, requests, responses };
}

async function readMessage(
  stream: PassThrough,
): Promise<Record<string, unknown>> {
  const chunk = stream.read() as Buffer | null;
  const bytes =
    chunk ??
    (await new Promise<Buffer>((resolve) => stream.once("data", resolve)));
  return JSON.parse(bytes.toString("utf8").trim()) as Record<string, unknown>;
}

function event(type: "assistant.delta", payload: { text: string }) {
  return {
    schemaVersion: 1,
    sequence: 1,
    timestamp: "2026-08-26T00:00:00.000Z",
    threadId: threadIdSchema.parse("client-thread"),
    turnId: turnIdSchema.parse("client-turn"),
    type,
    payload,
  };
}

function fixtureServerScript(options: {
  stderrBytes?: number;
  exitAfterInitialize?: boolean;
}): string {
  const initialization = {
    protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    server: { name: "koda-app-server", version: "fixture" },
    capabilities: {
      threadQueries: true,
      turnStart: true,
      turnResume: true,
      turnCancellation: true,
      interactiveApproval: true,
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
      workspaceMutationRecovery: true,
      interactiveProcesses: false,
      secretEvidence: true,
      resourceEvidence: true,
    },
    providers: [
      {
        id: "openai",
        displayName: "OpenAI",
        credentialEnvironmentVariable: "OPENAI_API_KEY",
        defaultModel: "fixture-model",
        configured: true,
      },
    ],
  };
  return `
const initialization = ${JSON.stringify(initialization)};
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let newline = buffered.indexOf("\\n");
  while (newline >= 0) {
    const request = JSON.parse(buffered.slice(0, newline));
    buffered = buffered.slice(newline + 1);
    if (request.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: initialization }) + "\\n");
      process.stderr.write("d".repeat(${options.stderrBytes ?? 0}));
      if (${String(options.exitAfterInitialize ?? false)}) {
        setTimeout(() => process.exit(7), 100);
      }
    } else if (request.method === "shutdown") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
      setTimeout(() => process.exit(0), 10);
    } else if (request.method === "plan/get") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
        workspace: request.params.workspace,
        threadId: request.params.threadId,
        recovery: {
          previousTurnId: "fixture-plan-turn",
          previousStatus: "completed",
          needsRevalidation: false,
          uncertainToolCalls: []
        }
      } }) + "\\n");
    } else if (request.method === "plan/acceptance/resolve") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { accepted: true } }) + "\\n");
    }
    newline = buffered.indexOf("\\n");
  }
});
`;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for fixture state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
