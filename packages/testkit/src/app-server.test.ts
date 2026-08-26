import { PassThrough, Writable } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  type JsonValue,
} from "@koda/protocol";
import { ScriptedModelProvider } from "@koda/providers";
import { ReadOnlyWorkspace } from "@koda/runtime-node";
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
      protocolVersion: 99,
      client: { name: "wrong-version" },
    });
    await initialize(server, 3);
    await request(server, 4, "initialize", {
      protocolVersion: 1,
      client: { name: "duplicate" },
    });
    await request(server, 5, "missing/method", {});
    await request(server, 6, "thread/list", { limit: 0 });

    expect(errorCode(writer, null)).toBe(-32700);
    expect(errorDataCode(writer, 1)).toBe("SERVER_NOT_INITIALIZED");
    expect(errorDataCode(writer, 2)).toBe("PROTOCOL_VERSION_MISMATCH");
    expect(responseResult(writer, 3)).toMatchObject({
      protocolVersion: 1,
      capabilities: { durableEventNotifications: true },
    });
    expect(errorDataCode(writer, 4)).toBe("SERVER_ALREADY_INITIALIZED");
    expect(errorDataCode(writer, 5)).toBe("METHOD_NOT_FOUND");
    expect(errorDataCode(writer, 6)).toBe("INVALID_PARAMS");
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
    await request(server, 6, "shutdown", {});
    expect(responseResult(writer, 6)).toEqual({});
    expect(server.shouldClose).toBe(true);
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
        params: { protocolVersion: 1, client: { name: "eof-test" } },
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
    protocolVersion: 1,
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
