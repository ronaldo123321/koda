import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  threadIdSchema,
  turnIdSchema,
} from "@koda/protocol";
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
    const stateRoot = join(root, "state");
    const eventLogDirectory = join(stateRoot, "threads");
    await mkdir(eventLogDirectory, { recursive: true });
    await writeFile(
      join(eventLogDirectory, "client-history.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        sequence: 0,
        timestamp: "2026-08-27T00:00:00.000Z",
        threadId: "client-history",
        turnId: "client-history-turn",
        type: "turn.started",
        payload: {},
      })}\n`,
      "utf8",
    );
    const client = await NodeAppServerClient.connect({
      cwd: root,
      environment: {
        ...process.env,
        KODA_HOME: stateRoot,
        OPENAI_API_KEY: "",
      },
      clientName: "app-server-client-test",
    });

    expect(client.initialization).toMatchObject({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      capabilities: { interactiveApproval: true, threadEvents: true },
      providers: [
        { id: "openai" },
        { id: "anthropic" },
        { id: "deepseek" },
        { id: "kimi" },
        { id: "glm" },
      ],
    });
    await expect(client.listThreads()).resolves.toMatchObject({
      threads: [{ threadId: "client-history" }],
    });
    await expect(
      client.readThreadEvents({
        threadId: threadIdSchema.parse("client-history"),
      }),
    ).resolves.toMatchObject({
      events: [{ sequence: 0, type: "turn.started" }],
      hasEarlier: false,
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
    },
    providers: [
      {
        id: "openai",
        displayName: "OpenAI",
        credentialEnvironmentVariable: "OPENAI_API_KEY",
        defaultModel: "fixture-model",
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
