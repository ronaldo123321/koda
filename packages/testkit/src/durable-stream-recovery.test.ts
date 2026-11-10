import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenAIResponsesProvider,
  ResponseJournal,
  type OpenAIResponsesClient,
} from "@koda/providers";
import {
  agentEventSchema,
  threadIdSchema,
  turnIdSchema,
  toolCallIdSchema,
} from "@koda/protocol";
import { JsonlEventStore, recoverThread } from "@koda/runtime-node";
import type { ModelEvent, ModelProvider } from "@koda/agent-core";
import { reconcileResponseJournal } from "../../app/src/response-recovery-service.js";

type Event =
  Awaited<
    ReturnType<OpenAIResponsesClient["responses"]["create"]>
  > extends AsyncIterable<infer T>
    ? T
    : never;
const event = (value: unknown) => value as Event;
const created = event({
  type: "response.created",
  sequence_number: 0,
  response: { id: "response-1", background: true },
});
const delta = (sequence_number: number, text: string) =>
  event({ type: "response.output_text.delta", sequence_number, delta: text });
const done = (sequence_number: number) =>
  event({
    type: "response.completed",
    sequence_number,
    response: { id: "response-1" },
  });
const threadId = threadIdSchema.parse("thread");
const turnId = turnIdSchema.parse("turn");
const header = {
  version: 1 as const,
  threadId,
  turnId,
  step: 1,
  binding: createHash("sha256")
    .update(
      JSON.stringify({
        model: "test",
        instructions: "test",
        reasoningEffort: "medium",
      }),
    )
    .digest("hex"),
};
const paths: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "koda-stream-"));
  paths.push(path);
  return path;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function collect(stream: AsyncIterable<ModelEvent>) {
  const out = [];
  for await (const value of stream) out.push(value);
  return out;
}
async function seeded() {
  const path = join(await directory(), "response");
  const journal = new ResponseJournal(path);
  await journal.begin(header);
  await journal.append(created);
  await journal.append(delta(1, "Hello "));
  const client: OpenAIResponsesClient = {
    responses: {
      create: vi.fn(async () => {
        throw new Error("Must not POST");
      }),
      retrieve: vi.fn(async () =>
        (async function* () {
          yield delta(1, "Hello ");
          yield delta(2, "world");
          yield done(3);
        })(),
      ),
      cancel: vi.fn(async () => {}),
    },
  };
  const provider = new OpenAIResponsesProvider({
    client,
    model: "test",
    instructions: "test",
    resumableStreams: true,
    responseJournal: new ResponseJournal(path),
  });
  return { path, journal, client, provider };
}

describe("durable response journal", () => {
  it("rebuilds the prefix and retrieves the same response after its durable cursor", async () => {
    const f = await seeded();
    expect(
      await collect(
        f.provider.recoverPendingStream(new AbortController().signal),
      ),
    ).toMatchObject([
      { type: "assistant_delta", text: "Hello " },
      { type: "assistant_delta", text: "world" },
      { type: "completed" },
    ]);
    expect(f.client.responses.create).not.toHaveBeenCalled();
    expect(f.client.responses.retrieve).toHaveBeenCalledWith(
      "response-1",
      { stream: true, starting_after: 1 },
      expect.anything(),
    );
    expect((await new ResponseJournal(f.path).load())?.events).toHaveLength(4);
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    // A second process after remote completion reconstructs locally, without GET or POST.
    expect(
      await collect(
        f.provider.recoverPendingStream(new AbortController().signal),
      ),
    ).toHaveLength(3);
    expect(f.client.responses.retrieve).toHaveBeenCalledTimes(1);
  });
  it("cancels a recovered response with a separate signal when the user aborts", async () => {
    const f = await seeded();
    const controller = new AbortController();
    f.client.responses.retrieve = vi.fn(async (_id, _query, options) =>
      (async function* () {
        controller.abort(new Error("user cancelled"));
        options?.signal?.throwIfAborted();
      })(),
    );
    await expect(
      collect(f.provider.recoverPendingStream(controller.signal)),
    ).rejects.toThrow();
    expect(f.client.responses.create).not.toHaveBeenCalled();
    expect(f.client.responses.cancel).toHaveBeenCalledWith(
      "response-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
  it("bounds journal growth before writing an oversized event", async () => {
    const f = await seeded();
    const size = (await stat(f.path)).size;
    await expect(
      f.journal.append(delta(2, "x".repeat(16 * 1024 * 1024))),
    ).rejects.toThrow(/limit/);
    expect((await stat(f.path)).size).toBe(size);
  });
  it("advances the journal only after a completed live step", async () => {
    const path = join(await directory(), "response");
    let creates = 0;
    const client: OpenAIResponsesClient = {
      responses: {
        create: async () =>
          (async function* () {
            creates++;
            yield created;
            if (creates === 1)
              yield event({
                type: "response.output_item.done",
                sequence_number: 1,
                item: {
                  type: "function_call",
                  name: "read",
                  call_id: "call",
                  arguments: "{}",
                },
              });
            else yield delta(1, "done");
            yield done(2);
          })(),
        retrieve: vi.fn(async () => {
          throw new Error("Unexpected retrieval");
        }),
        cancel: vi.fn(async () => {}),
      },
    };
    const provider = new OpenAIResponsesProvider({
      client,
      model: "test",
      instructions: "test",
      resumableStreams: true,
      responseJournal: new ResponseJournal(path),
    });
    const request = {
      threadId,
      turnId,
      step: 1,
      items: [
        {
          type: "user_message" as const,
          id: "user" as import("@koda/protocol").ItemId,
          content: "read",
        },
      ],
      tools: [],
    };
    await collect(provider.stream(request, new AbortController().signal));
    const other = new OpenAIResponsesProvider({
      client,
      model: "test",
      instructions: "test",
      resumableStreams: true,
      responseJournal: new ResponseJournal(path),
    });
    await expect(
      collect(other.stream(request, new AbortController().signal)),
    ).rejects.toThrow(/pending response journal/);
    expect(creates).toBe(1);
    await collect(
      provider.stream(
        {
          ...request,
          step: 2,
          items: [
            ...request.items,
            {
              type: "tool_result",
              id: "result" as import("@koda/protocol").ItemId,
              callId: toolCallIdSchema.parse("call"),
              name: "read",
              status: "success",
              output: "ok",
            },
          ],
        },
        new AbortController().signal,
      ),
    );
    expect(creates).toBe(2);
    expect((await new ResponseJournal(path).load())?.header.step).toBe(2);
  });
  it("discards only a torn tail and rejects complete corruption", async () => {
    const f = await seeded();
    await appendFile(f.path, '{"value":');
    expect((await new ResponseJournal(f.path).load())?.events).toHaveLength(2);
    expect((await readFile(f.path, "utf8")).endsWith("\n")).toBe(true);
    await appendFile(f.path, '{"value":{},"digest":"wrong"}\n');
    await expect(new ResponseJournal(f.path).load()).rejects.toThrow();
  });
  it("refuses symlink and hard-link journals", async () => {
    const f = await seeded();
    await symlink(f.path, `${f.path}.link`);
    await expect(
      new ResponseJournal(`${f.path}.link`).load(),
    ).rejects.toThrow();
    await link(f.path, `${f.path}.hard`);
    await expect(new ResponseJournal(f.path).load()).rejects.toThrow();
  });
  it("never recreates an ambiguous request that crashed before recording an ID", async () => {
    const f = await seeded();
    await f.journal.begin(header);
    await expect(
      collect(f.provider.recoverPendingStream(new AbortController().signal)),
    ).rejects.toThrow(/no durable response ID/);
    expect(f.client.responses.create).not.toHaveBeenCalled();
    expect(f.client.responses.retrieve).not.toHaveBeenCalled();
  });
  it("refuses a different model or instructions before contacting the provider", async () => {
    const f = await seeded();
    const changed = new OpenAIResponsesProvider({
      client: f.client,
      model: "different",
      instructions: "test",
      resumableStreams: true,
      responseJournal: new ResponseJournal(f.path),
    });
    await expect(
      collect(changed.recoverPendingStream(new AbortController().signal)),
    ).rejects.toThrow(/does not match/);
    expect(f.client.responses.retrieve).not.toHaveBeenCalled();
  });
  it.each(["conflict", "gap", "expired"])(
    "fails closed on %s without another inference",
    async (failure) => {
      const f = await seeded();
      f.client.responses.retrieve = vi.fn(async () => {
        if (failure === "expired")
          throw Object.assign(new Error("expired"), { status: 404 });
        return (async function* () {
          yield delta(failure === "gap" ? 3 : 1, "changed");
        })();
      });
      await expect(
        collect(f.provider.recoverPendingStream(new AbortController().signal)),
      ).rejects.toThrow();
      expect(f.client.responses.create).not.toHaveBeenCalled();
      expect(f.client.responses.cancel).toHaveBeenCalledOnce();
    },
  );
});

async function recoveryFixture() {
  const f = await seeded();
  const store = new JsonlEventStore(`${f.path}.events`);
  let sequence = 0;
  const record = async (type: string, payload: unknown) =>
    store.append(
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: sequence++,
        timestamp: new Date().toISOString(),
        threadId,
        turnId,
        type,
        payload,
      }),
    );
  await record("turn.started", {});
  await record("turn.context", {
    provider: "openai",
    model: "test",
    workspaceRoot: "/workspace",
    approvalMode: "on-request",
    instructionsSha256: "a".repeat(64),
    repositoryInstructions: [],
    skills: [],
    commandTemplates: [],
    plugins: [],
  });
  await record("item.recorded", {
    item: { type: "user_message", id: "user", content: "Hello" },
  });
  await record("context.prepared", {
    step: 1,
    contextWindowTokens: 1000,
    maxOutputTokens: 100,
    safetyMarginTokens: 0,
    inputBudgetTokens: 900,
    fixedInputTokens: 0,
    rawEstimatedInputTokens: 1,
    estimatedInputTokens: 1,
    calibrationFactor: 1,
    activeItemCount: 1,
    activeItemTypes: [{ type: "user_message", count: 1 }],
    activeItemsSha256: "a".repeat(64),
    toolCount: 0,
    toolsSha256: "a".repeat(64),
  });
  await record("assistant.delta", { text: "Hello " });
  return { ...f, store, record };
}
const calls = ["finished", "uncertain", "unstarted"].map((id) => ({
  type: "tool_call" as const,
  callId: toolCallIdSchema.parse(id),
  name: "exec_command",
  arguments: { command: id },
}));
function toolProvider(): ModelProvider {
  return {
    stream: vi.fn(),
    recoverPendingStream: async function* () {
      yield { type: "assistant_delta", text: "Hello world" };
      yield* calls;
      yield {
        type: "completed",
        finishReason: "tool_calls",
        responseId: "response-1",
      };
    },
  };
}
describe("recovery audit reconciliation", () => {
  it("preserves completed tools, records unknown outcomes, and never executes recovered calls", async () => {
    const f = await recoveryFixture();
    for (const call of calls.slice(0, 2)) {
      await f.record("item.recorded", {
        item: { ...call, id: `call-${call.callId}` },
      });
      await f.record("tool.started", {
        callId: call.callId,
        name: call.name,
        executionBoundary: true,
      });
      await f.record("tool.execution_started", {
        callId: call.callId,
        name: call.name,
        effect: "execute",
      });
    }
    await f.record("item.recorded", {
      item: {
        type: "tool_result",
        id: "finished-result",
        callId: "finished",
        name: "exec_command",
        status: "success",
        output: "done",
      },
    });
    const p = toolProvider();
    expect(
      await reconcileResponseJournal(
        f.journal,
        f.store,
        p,
        threadId,
        new AbortController().signal,
      ),
    ).toBe(true);
    expect(p.stream).not.toHaveBeenCalled();
    const recovered = recoverThread(await f.store.readAll(), threadId);
    const results = recovered.history.filter(
      (item) => item.type === "tool_result",
    );
    expect(results).toMatchObject([
      { callId: "finished", status: "success" },
      { callId: "uncertain", error: { code: "TOOL_OUTCOME_UNKNOWN" } },
      { callId: "unstarted", error: { code: "TOOL_NOT_EXECUTED" } },
    ]);
    expect(
      recovered.uncertainToolCalls.some((call) => call.callId === "uncertain"),
    ).toBe(true);
    expect(await f.journal.load()).toBeUndefined();
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])(
    "reconciles idempotently after interruption at append %s",
    async (stop) => {
      const f = await recoveryFixture();
      const append = f.store.append.bind(f.store);
      let count = 0;
      const spy = vi
        .spyOn(f.store, "append")
        .mockImplementation(async (event) => {
          await append(event);
          if (++count === stop) throw new Error("simulated crash after append");
        });
      await expect(
        reconcileResponseJournal(
          f.journal,
          f.store,
          toolProvider(),
          threadId,
          new AbortController().signal,
        ),
      ).rejects.toThrow(/simulated crash/);
      spy.mockRestore();
      await reconcileResponseJournal(
        f.journal,
        f.store,
        toolProvider(),
        threadId,
        new AbortController().signal,
      );
      const read = await f.store.readAll();
      expect(
        read.events
          .filter((e) => e.type === "assistant.delta")
          .map((e) => (e.type === "assistant.delta" ? e.payload.text : ""))
          .join(""),
      ).toBe("Hello world");
      const history = recoverThread(read, threadId).history;
      expect(
        history.filter((item) => item.type === "assistant_message"),
      ).toHaveLength(1);
      expect(history.filter((item) => item.type === "tool_call")).toHaveLength(
        3,
      );
      expect(
        history.filter((item) => item.type === "tool_result"),
      ).toHaveLength(3);
    },
  );
  it("does not reopen a terminal turn even when its journal survived cleanup", async () => {
    const f = await recoveryFixture();
    await f.record("turn.cancelled", { reason: "user cancelled" });
    const recover = vi.spyOn(f.provider, "recoverPendingStream");
    expect(
      await reconcileResponseJournal(
        f.journal,
        f.store,
        f.provider,
        threadId,
        new AbortController().signal,
      ),
    ).toBe(false);
    expect(recover).not.toHaveBeenCalled();
    expect(await f.journal.load()).toBeUndefined();
  });
  it("rejects a journal for another thread without modifying the audit", async () => {
    const f = await recoveryFixture();
    await f.journal.begin({
      ...header,
      threadId: threadIdSchema.parse("another"),
    });
    await expect(
      reconcileResponseJournal(
        f.journal,
        f.store,
        f.provider,
        threadId,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/another thread/);
    expect((await f.store.readAll()).events).toHaveLength(5);
  });
  it("rejects a mismatched delivery ledger before appending recovery output", async () => {
    const f = await recoveryFixture();
    await f.record("assistant.delta", { text: "conflict" });
    const before = (await f.store.readAll()).events.length;
    await expect(
      reconcileResponseJournal(
        f.journal,
        f.store,
        f.provider,
        threadId,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/conflicts/);
    expect((await f.store.readAll()).events).toHaveLength(before);
  });
});

it.skipIf(process.platform === "win32")(
  "recovers through KodaApplication in a fresh process after SIGKILL, without repeating inference or text",
  async () => {
    const root = await directory();
    await mkdir(join(root, "repo"));
    const fixture = fileURLToPath(
      new URL("../fixtures/durable-stream-process.mjs", import.meta.url),
    );
    const run = promisify(execFile);
    const options = {
      env: { ...process.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" },
      timeout: 20000,
    };
    await expect(
      run(process.execPath, [fixture, "crash", root], options),
    ).rejects.toMatchObject({ signal: "SIGKILL" });
    await run(process.execPath, [fixture, "resume", root], options);
    const output = JSON.parse(
      await readFile(join(root, "report.json"), "utf8"),
    );
    expect(output).toMatchObject({
      completion: { status: "completed" },
      counts: { creates: 1, retrieves: 1, cancels: 0 },
    });
    const read = await new JsonlEventStore(
      join(root, "state", "threads", "crash-thread.jsonl"),
    ).readAll();
    const recovered = recoverThread(read, threadIdSchema.parse("crash-thread"));
    expect(
      recovered.history
        .filter((item) => item.type === "assistant_message")
        .map((item) => (item.type === "assistant_message" ? item.content : "")),
    ).toEqual(["Hello world", "Continued"]);
    expect(
      read.events
        .filter((e) => e.type === "assistant.delta")
        .map((e) => (e.type === "assistant.delta" ? e.payload.text : ""))
        .join(""),
    ).toBe("Hello worldContinued");
  },
  30000,
);
