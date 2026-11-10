import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { summaryCases } from "./evaluation/summary-cases.js";
import {
  evaluateSummary,
  scoreSummary,
} from "./evaluation/summary-evaluation.js";
import { parseEvaluationArguments, saveEvaluation } from "./evaluation/cli.js";
import { runEvaluation } from "./evaluation/model-evaluation.js";
import { runStreamProbe } from "./evaluation/live-validation.js";
import { failureEvidence } from "./evaluation/failure.js";
import { withTransportProbe } from "./evaluation/transport-probe.js";

afterEach(() => vi.unstubAllGlobals());
describe("model evaluation harness", () => {
  it.each(summaryCases)(
    "accepts grounded reference and rejects omission: $id",
    async (definition) => {
      expect(scoreSummary(definition, definition.reference).passed).toBe(true);
      const missing = {
        ...definition.reference,
        criticalFacts: [],
        decisions: [],
        pendingWork: [],
        modifiedFiles: [],
        failedAttempts: [],
      };
      expect(scoreSummary(definition, missing).passed).toBe(false);
      const report = await evaluateSummary(definition, async (source) => {
        const input = JSON.parse(source) as {
          evidence: unknown;
          excerpts: string[];
        };
        const evidence =
          JSON.stringify(input.evidence) + input.excerpts.join("\n");
        for (const rule of definition.rules.filter((rule) => !rule.absent)) {
          expect(evidence).toMatch(new RegExp(rule.pattern, "i"));
        }
        return definition.reference;
      });
      expect(report.candidateAvailable).toBe(true);
      expect(report.finalQuality.passed).toBe(true);
      expect(Object.values(report.invariants).every(Boolean)).toBe(true);
      expect(report.requests).toBe(0); // A fixture callback is not a real model call.
    },
  );
  it("accepts equivalent prohibitions but rejects affirmative migration claims", () => {
    const definition = summaryCases.find(
      (value) => value.id === "mid-task-constraint",
    )!;
    for (const phrase of [
      "Do not add database migrations or new dependencies.",
      "CONS-8 prohibits database migrations and new dependencies.",
    ]) {
      expect(
        scoreSummary(definition, {
          ...definition.reference,
          criticalFacts: ["SQLite 3.35 compatibility.", phrase],
        }).passed,
      ).toBe(true);
    }
    expect(
      scoreSummary(definition, {
        ...definition.reference,
        criticalFacts: [
          "SQLite 3.35 compatibility; allow database migrations.",
        ],
      }).passed,
    ).toBe(false);
  });
  it("accepts evidenced rollback without hiding fabricated fixes", () => {
    const definition = summaryCases.find(
      (value) => value.id === "failed-attempt",
    )!;
    for (const rollback of [
      "Reverted the TRY-3 timeout change.",
      "Rolled back the TRY-3 timeout change.",
    ]) {
      expect(
        scoreSummary(definition, {
          ...definition.reference,
          completedWork: [rollback],
        }).passed,
      ).toBe(true);
      for (const claim of [
        "TRY-3 fixed",
        "NEXT-3 completed",
        "TRY-3 tests passed",
      ]) {
        for (const completedWork of [
          [rollback, claim],
          [rollback + " " + claim],
          [claim],
        ]) {
          expect(
            scoreSummary(definition, { ...definition.reference, completedWork })
              .passed,
          ).toBe(false);
        }
      }
    }
  });
  it("redacts arbitrary provider messages and preserves safe failure categories", () => {
    const evidence = failureEvidence({
      code: "PROVIDER_REQUEST_FAILED",
      message: "secret-key",
      cause: {
        status: 503,
        code: "secret-key",
        headers: { authorization: "secret-key" },
      },
    });
    expect(evidence).toEqual({
      code: "PROVIDER_REQUEST_FAILED",
      httpStatus: 503,
    });
    expect(JSON.stringify(evidence)).not.toContain("secret-key");
  });
  it("detects fabricated completion and rejects malformed summaries", () => {
    const definition = summaryCases[0]!;
    expect(
      scoreSummary(definition, {
        ...definition.reference,
        completedWork: ["CHECK-17 passed"],
      }).passed,
    ).toBe(false);
    expect(scoreSummary(definition, { objective: "malformed" }).valid).toBe(
      false,
    );
  });
  it("records fallback without presenting it as a semantic candidate", async () => {
    const report = await evaluateSummary(summaryCases[0]!, async () => {
      throw new Error("offline");
    });
    expect(report.candidateAvailable).toBe(false);
    expect(report.candidateQuality).toBeNull();
    expect(report.finalMatchesBaseline).toBe(true);
    expect(report.summaryAttempts).toBe(1);
  });
  it("runs offline without fetching and treats missing credentials as blocked", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("Must not fetch");
    });
    vi.stubGlobal("fetch", fetch);
    const offline = await runEvaluation(
      { live: false, suite: "all", timeoutMs: 1000 },
      {},
    );
    expect(offline.status).toBe("baseline_recorded");
    expect(offline.summaries).toHaveLength(6);
    expect(offline.transport[0]).toMatchObject({
      status: "not_run",
      passed: null,
    });
    const live = await runEvaluation(
      {
        live: true,
        provider: "openai",
        model: "explicit-model",
        suite: "all",
        timeoutMs: 1000,
      },
      {},
    );
    expect(live.status).toBe("blocked");
    expect(live.summaries).toEqual([]);
    const unsupported = await runEvaluation(
      {
        live: true,
        provider: "anthropic",
        model: "offline",
        suite: "transport",
        probe: "resume",
        timeoutMs: 1000,
      },
      { ANTHROPIC_API_KEY: "offline" },
    );
    expect(unsupported.status).toBe("not_run");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses an existing report before making any paid request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "koda-eval-output-"));
    const fetch = vi.fn(async () => {
      throw new Error("must not fetch");
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const output = join(directory, "report.json");
      await writeFile(output, "original");
      await expect(
        saveEvaluation(
          {
            live: true,
            provider: "openai",
            model: "offline",
            suite: "transport",
            probe: "retry",
            timeoutMs: 1000,
          },
          { OPENAI_API_KEY: "offline" },
          output,
        ),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("requires explicit live model selection and bounds evaluation deadlines", () => {
    expect(parseEvaluationArguments([]).options.live).toBe(false);
    expect(
      parseEvaluationArguments(["--suite", "transport", "--probe", "cancel"])
        .options.probe,
    ).toBe("cancel");
    expect(
      parseEvaluationArguments([
        "--suite",
        "transport",
        "--probe",
        "cancel-created",
      ]).options.probe,
    ).toBe("cancel-created");
    expect(() => parseEvaluationArguments(["--probe", "cancel"])).toThrow(
      "--suite transport",
    );
    expect(() => parseEvaluationArguments(["--live"])).toThrow("--model");
    expect(() => parseEvaluationArguments(["--timeout-ms", "999999"])).toThrow(
      "Timeout",
    );
    expect(() => parseEvaluationArguments(["--live", "--live"])).toThrow(
      "Duplicate",
    );
    expect(() => parseEvaluationArguments(["--unknown"])).toThrow("Unknown");
  });
});

const event = (
  type: string,
  sequence_number: number,
  rest: Record<string, unknown> = {},
) => ({ type, sequence_number, ...rest });
const created = event("response.created", 0, {
  response: { id: "eval-response", background: true },
});
const delta = event("response.output_text.delta", 1, {
  delta: "KODA_PROBE_OK",
});
const completed = event("response.completed", 2, {
  response: { id: "eval-response" },
});
const sse = (events: unknown[]) =>
  events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");
const response = (events: unknown[]) =>
  new Response(sse(events), {
    headers: { "content-type": "text/event-stream" },
  });
const options = {
  provider: "openai" as const,
  model: "offline-model",
  apiKey: "offline-only",
  timeoutMs: 4000,
};

describe("live validation machinery against mocked HTTP, not live API", () => {
  it("uses real SDK retry after one injected 429", async () => {
    const upstream = vi.fn(async () => response([created, delta, completed]));
    vi.stubGlobal("fetch", upstream);
    const report = await runStreamProbe(options, "retry");
    expect(report).toMatchObject({
      passed: true,
      transport: { injected: true, creates: 2, upstreamRequests: 1 },
    });
    expect(upstream).toHaveBeenCalledOnce();
  });
  it("recovers from injected disconnect without repeating inference or text", async () => {
    const upstream = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        return response(
          request.method === "GET"
            ? [delta, completed]
            : [created, delta, completed],
        );
      },
    );
    vi.stubGlobal("fetch", upstream);
    const report = await runStreamProbe(options, "resume");
    expect(report).toMatchObject({
      passed: true,
      transport: {
        injected: true,
        creates: 1,
        retrieves: 1,
        upstreamRequests: 2,
      },
    });
  });
  it.each([
    { mode: "cancel-created" as const, terminalStatus: "cancelled" },
    { mode: "cancel-created" as const, terminalStatus: "completed" },
    { mode: "cancel-progress" as const, terminalStatus: "cancelled" },
    { mode: "cancel-progress" as const, terminalStatus: "completed" },
  ])(
    "requires terminal cancelled confirmation ($mode, $terminalStatus)",
    async ({ mode, terminalStatus }) => {
      vi.stubGlobal(
        "fetch",
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const request =
            input instanceof Request ? input : new Request(input, init);
          if (request.url.endsWith("/cancel"))
            return Response.json({
              id: "eval-response",
              status: terminalStatus,
            });
          const signal = init?.signal ?? request.signal;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    sse([
                      event("response.created", 0, {
                        response: {
                          id: "eval-response",
                          background: true,
                          status: "queued",
                        },
                      }),
                      event("response.in_progress", 1, {
                        response: {
                          id: "eval-response",
                          background: true,
                          status: "in_progress",
                        },
                      }),
                    ]),
                  ),
                );
                signal?.addEventListener(
                  "abort",
                  () =>
                    controller.error(
                      new DOMException("Cancelled", "AbortError"),
                    ),
                  { once: true },
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      );
      const report = await runStreamProbe(options, mode);
      expect(report).toMatchObject({
        passed: terminalStatus === "cancelled",
        cancelledAfterCreation: true,
        createdStatus: mode === "cancel-progress" ? "in_progress" : "queued",
        firstDeltaMs: null,
        completed: false,
        transport: {
          creates: 1,
          cancels: 1,
          cancelledResponseConfirmed: terminalStatus === "cancelled",
        },
      });
    },
  );
  it("metadata observation leaves a completed stream intact", async () => {
    vi.stubGlobal("fetch", async () =>
      response([
        event("response.created", 0, {
          response: { id: "eval-response", background: true, status: "queued" },
        }),
        delta,
        completed,
      ]),
    );
    const observe = vi.fn();
    await withTransportProbe(
      undefined,
      async (evidence) => {
        const result = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
        });
        expect(await result.text()).toContain("response.completed");
        expect(evidence.injected).toBe(false);
      },
      observe,
    );
    expect(observe).toHaveBeenCalledExactlyOnceWith("queued");
  });
  it.each(["cancelled", "completed"])(
    "checks the terminal state after a delta (%s)",
    async (terminalStatus) => {
      const upstream = vi.fn(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const request =
            input instanceof Request ? input : new Request(input, init);
          return request.url.endsWith("/cancel")
            ? Response.json({ id: "eval-response", status: terminalStatus })
            : response([created, delta, completed]);
        },
      );
      vi.stubGlobal("fetch", upstream);
      expect(await runStreamProbe(options, "cancel")).toMatchObject({
        passed: terminalStatus === "cancelled",
        completed: false,
        cancelledAfterDelta: true,
        transport: { cancels: 1 },
      });
    },
  );
  it("does not count an unacknowledged remote cancellation as passing", async () => {
    vi.stubGlobal(
      "fetch",
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        return request.url.endsWith("/cancel")
          ? Response.json(
              { error: { message: "controlled failure" } },
              { status: 503 },
            )
          : response([created, delta, completed]);
      },
    );
    expect(await runStreamProbe(options, "cancel")).toMatchObject({
      passed: false,
      cancelledAfterDelta: true,
      transport: { cancels: 1, cancelAcknowledged: 0 },
    });
  });
  it("reports an already completed remote response without claiming cancellation succeeded", async () => {
    vi.stubGlobal(
      "fetch",
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        if (request.url.endsWith("/cancel"))
          return Response.json(
            { error: { message: "already completed" } },
            { status: 400 },
          );
        if (request.method === "GET")
          return Response.json({ status: "completed" });
        return response([created, delta, completed]);
      },
    );
    expect(await runStreamProbe(options, "cancel")).toMatchObject({
      passed: false,
      cancelledAfterDelta: true,
      remoteStatus: "completed",
      transport: {
        cancels: 1,
        cancelAcknowledged: 0,
        cancelHttpStatuses: [400],
      },
    });
  });
  it("handles split UTF-8 SSE frames and restores fetch on failure", async () => {
    const bytes = new TextEncoder().encode(
      sse([created, { ...delta, delta: "中文" }, completed]),
    );
    let cursor = 0;
    let cancelled = false;
    const upstream = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (cursor === bytes.length) controller.close();
              else controller.enqueue(bytes.slice(cursor, (cursor += 1)));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    vi.stubGlobal("fetch", upstream);
    await withTransportProbe("disconnect_once", async (evidence) => {
      const result = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
      });
      const reader = result.body!.getReader();
      let text = "";
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += new TextDecoder().decode(chunk.value);
        }
      } catch (error) {
        expect(error).toMatchObject({ code: "ECONNRESET" });
      }
      expect(text).toContain("中文");
      expect(text).not.toContain("response.completed");
      expect(evidence.injected).toBe(true);
      expect(cancelled).toBe(true);
    });
    expect(globalThis.fetch).toBe(upstream);
    await expect(
      withTransportProbe(undefined, async () => {
        throw new Error("test failure");
      }),
    ).rejects.toThrow("test failure");
    expect(globalThis.fetch).toBe(upstream);
  });
  it("does not inject faults into unrelated endpoints", async () => {
    const upstream = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", upstream);
    await withTransportProbe("rate_limit_once", async (evidence) => {
      expect(
        (await fetch("https://example.com/v1/responses", { method: "POST" }))
          .status,
      ).toBe(200);
      expect(evidence.injected).toBe(false);
    });
  });
});
