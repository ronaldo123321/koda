import {
  OpenAIResponsesProvider,
  createRegisteredProvider,
  type OpenAIResponsesClient,
} from "@koda/providers";
import {
  threadIdSchema,
  turnIdSchema,
  userMessageItemSchema,
} from "@koda/protocol";
import { describe, expect, it, vi, afterEach } from "vitest";

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
const delta = (sequence: number, text: string) =>
  event({
    type: "response.output_text.delta",
    sequence_number: sequence,
    delta: text,
  });
const done = (sequence: number) =>
  event({
    type: "response.completed",
    sequence_number: sequence,
    response: { id: "response-1" },
  });
const disconnected = Object.assign(new Error("disconnect"), {
  code: "ECONNRESET",
});
async function* stream(events: Event[], error?: unknown) {
  yield* events;
  if (error) throw error;
}
const request = {
  threadId: threadIdSchema.parse("stream-thread"),
  turnId: turnIdSchema.parse("stream-turn"),
  step: 1,
  items: [
    userMessageItemSchema.parse({
      id: "input",
      type: "user_message",
      content: "Hello",
    }),
  ],
  tools: [],
};
function provider(client: OpenAIResponsesClient) {
  return new OpenAIResponsesProvider({
    client,
    model: "test",
    instructions: "test",
    resumableStreams: true,
  });
}
async function collect(
  p: OpenAIResponsesProvider,
  signal = new AbortController().signal,
) {
  const result = [];
  for await (const e of p.stream(request, signal)) result.push(e);
  return result;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("OpenAI same-response recovery", () => {
  it("wires registered providers to the real SDK background request", async () => {
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        background: true,
        stream: true,
      });
      return new Response(
        [created, delta(1, "Hello"), done(2)]
          .map((value) => `data: ${JSON.stringify(value)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const registered = createRegisteredProvider({
      provider: "openai",
      apiKey: "offline",
      model: "test",
      instructions: "test",
      maxOutputTokens: 100,
      resumableStreams: true,
    });
    const output = [];
    for await (const event of registered.stream(
      request,
      new AbortController().signal,
    ))
      output.push(event);
    expect(output.at(-1)?.type).toBe("completed");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("resumes using a cursor and suppresses replayed text and tool calls", async () => {
    const call = event({
      type: "response.output_item.done",
      sequence_number: 2,
      item: {
        type: "function_call",
        name: "read_file",
        call_id: "call-one",
        arguments: '{"path":"README.md"}',
      },
    });
    const create = vi.fn(async () =>
      stream([created, delta(1, "Hello"), call], disconnected),
    );
    const retrieve = vi.fn(async () =>
      stream([delta(1, "Hello"), call, delta(3, " world"), done(4)]),
    );
    const cancel = vi.fn(async () => {});
    const result = await collect(
      provider({ responses: { create, retrieve, cancel } }),
    );
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]).toBeDefined();
    expect(retrieve).toHaveBeenCalledWith(
      "response-1",
      { stream: true, starting_after: 2 },
      { signal: expect.any(AbortSignal) },
    );
    expect(
      result
        .filter((e) => e.type === "assistant_delta")
        .map((e) => e.text)
        .join(""),
    ).toBe("Hello world");
    expect(result.filter((e) => e.type === "tool_call")).toHaveLength(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each([
    [delta(1, "changed")],
    [delta(3, "missing event")],
    [
      event({
        type: "response.completed",
        sequence_number: 2,
        response: { id: "wrong" },
      }),
    ],
    [event({ type: "response.output_text.delta", delta: "missing cursor" })],
  ])("rejects invalid resumed events %j", async (events) => {
    const cancel = vi.fn(async () => {});
    await expect(
      collect(
        provider({
          responses: {
            create: async () =>
              stream([created, delta(1, "Hello")], disconnected),
            retrieve: async () => stream([events]),
            cancel,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("shares one bounded retry budget across GET acquisition and consumption", async () => {
    const retrieve = vi.fn(async () => stream([], disconnected));
    const cancel = vi.fn(async () => {});
    await expect(
      collect(
        provider({
          responses: {
            create: async () => stream([created], disconnected),
            retrieve,
            cancel,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_REQUEST_FAILED" });
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("recovers an unexpected EOF without repeating creation", async () => {
    const create = vi.fn(async () => stream([created, delta(1, "Hello")]));
    const result = await collect(
      provider({
        responses: {
          create,
          retrieve: async () => stream([done(2)]),
          cancel: async () => {},
        },
      }),
    );
    expect(create).toHaveBeenCalledOnce();
    expect(result.at(-1)?.type).toBe("completed");
  });

  it("cancels the background response on abort and closes the stream", async () => {
    const controller = new AbortController();
    let closed = false;
    const cancel = vi.fn(async () => {}),
      retrieve = vi.fn(async () => stream([]));
    const create = async () =>
      (async function* () {
        try {
          yield created;
          yield delta(1, "Hello");
          controller.abort();
          throw disconnected;
        } finally {
          closed = true;
        }
      })();
    await expect(
      collect(
        provider({ responses: { create, retrieve, cancel } }),
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(closed).toBe(true);
    expect(retrieve).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith("response-1", {
      signal: expect.any(AbortSignal),
    });
  });

  it("does not retry an ambiguous creation or a protocol failure", async () => {
    const create = vi.fn(async () => {
      throw disconnected;
    });
    const retrieve = vi.fn(async () => stream([]));
    await expect(
      collect(
        provider({ responses: { create, retrieve, cancel: async () => {} } }),
      ),
    ).rejects.toThrow();
    expect(create).toHaveBeenCalledOnce();
    expect(retrieve).not.toHaveBeenCalled();
  });
});
