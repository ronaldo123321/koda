import { writeFile } from "node:fs/promises";
import { KodaApplication } from "@koda/app";
import { OpenAIResponsesProvider } from "@koda/providers";
import { ReadOnlyWorkspace } from "@koda/runtime-node";
import { randomUUID } from "node:crypto";
const [mode, root] = process.argv.slice(2);
const counts = { creates: 0, retrieves: 0, cancels: 0 };
const created = {
  type: "response.created",
  sequence_number: 0,
  response: { id: "response-crash", background: true },
};
const delta = (sequence_number, text) => ({
  type: "response.output_text.delta",
  sequence_number,
  delta: text,
});
const done = (sequence_number, id = "response-crash") => ({
  type: "response.completed",
  sequence_number,
  response: { id },
});
const app = new KodaApplication({
  environment: {
    OPENAI_API_KEY: "offline",
    KODA_HOME: `${root}/state`,
    KODA_OPENAI_RESUMABLE_STREAMS: "1",
  },
  processDirectory: `${root}/repo`,
  dependencies: {
    openWorkspace: (path) => ReadOnlyWorkspace.open(path),
    createIds: (threadId) => ({
      threadId: threadId ?? "crash-thread",
      turnId: randomUUID(),
      itemIds: { next: () => randomUUID() },
    }),
    createProvider: (configuration, instructions, responseJournal) =>
      new OpenAIResponsesProvider({
        model: configuration.model,
        instructions,
        maxOutputTokens: configuration.maxOutputTokens,
        resumableStreams: true,
        responseJournal,
        client: {
          responses: {
            create: async (body) => {
              counts.creates++;
              if (mode === "crash")
                return (async function* () {
                  yield created;
                  yield delta(1, "Hello ");
                  await new Promise(() => {});
                })();
              if (!JSON.stringify(body.input).includes("Hello world"))
                throw new Error("Recovered response missing from next request");
              return (async function* () {
                yield {
                  ...created,
                  response: { id: "next-response", background: true },
                };
                yield delta(1, "Continued");
                yield done(2, "next-response");
              })();
            },
            retrieve: async (id, query) => {
              counts.retrieves++;
              if (id !== "response-crash" || query.starting_after !== 1)
                throw new Error("Wrong response cursor");
              return (async function* () {
                yield delta(1, "Hello ");
                yield delta(2, "world");
                yield done(3);
              })();
            },
            cancel: async () => {
              counts.cancels++;
            },
          },
        },
      }),
  },
});
const handle = app.startTurn(
  {
    prompt: mode === "crash" ? "Hello" : "Continue",
    model: "test",
    ...(mode === "crash" ? {} : { resume: "crash-thread" }),
  },
  {
    events: {
      append: async (event) => {
        if (mode === "crash" && event.type === "assistant.delta")
          process.kill(process.pid, "SIGKILL");
      },
    },
    approvals: { request: async () => ({ decision: "rejected" }) },
  },
);
const report = JSON.stringify({ completion: await handle.completion, counts });
await writeFile(`${root}/report.json`, report);
console.log(report);
