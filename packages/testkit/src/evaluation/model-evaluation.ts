import {
  CONTEXT_SUMMARY_INSTRUCTIONS,
  createModelContextSummarizer,
} from "@koda/agent-core";
import { summaryCases } from "./summary-cases.js";
import { evaluateSummary } from "./summary-evaluation.js";
import { liveProvider, runSmoke, runStreamProbe } from "./live-validation.js";

export interface EvaluationOptions {
  live: boolean;
  provider?: "openai" | "anthropic";
  model?: string;
  suite: "summaries" | "transport" | "all";
  timeoutMs: number;
  probe?: "cancel" | "cancel-created" | "cancel-progress" | "retry" | "resume";
}
export async function runEvaluation(
  options: EvaluationOptions,
  environment: NodeJS.ProcessEnv,
) {
  const base = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    mode: options.live ? "live" : "offline",
    provider: options.provider ?? null,
    model: options.model ?? null,
    suite: options.suite,
    probe: options.probe ?? null,
    limitations: [
      "Rubrics are field-specific lexical checks over synthetic fixtures, not an LLM judge or proof of semantic correctness.",
      "Token counts are provider-reported; missing usage and monetary cost are unknown, not zero.",
      "429 and disconnect faults are client-injected. This does not estimate service failure rates or cross-process recovery.",
    ],
  };
  if (options.live && (!options.provider || !options.model))
    throw new Error(
      "Live evaluation requires an explicit --provider and --model.",
    );
  const keyName =
    options.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const apiKey = environment[keyName];
  if (options.live && !apiKey?.trim())
    return {
      ...base,
      status: "blocked",
      reason: `Configure ${keyName} in environment settings. No live requests were made.`,
      summaries: [],
      transport: [],
    };
  const live = options.live
    ? {
        provider: options.provider!,
        model: options.model!,
        apiKey: apiKey!,
        timeoutMs: options.timeoutMs,
      }
    : undefined;
  const summaries = [];
  const transport = [];
  if (options.suite !== "transport") {
    for (const definition of summaryCases) {
      summaries.push(
        await evaluateSummary(
          definition,
          live
            ? createModelContextSummarizer(() =>
                liveProvider(live, CONTEXT_SUMMARY_INSTRUCTIONS),
              )
            : undefined,
          AbortSignal.timeout(options.timeoutMs),
        ),
      );
    }
  }
  if (options.suite !== "summaries") {
    if (live) {
      if (!options.probe) {
        try {
          transport.push(await runSmoke(live));
        } catch {
          transport.push({
            id: "tool-roundtrip",
            status: "failed",
            passed: false,
            reason: "Provider or runtime failure; raw error omitted.",
          });
        }
      }
      for (const mode of [
        "cancel",
        "cancel-created",
        "cancel-progress",
        "retry",
        "resume",
      ] as const) {
        if (!options.probe || options.probe === mode)
          transport.push(await runStreamProbe(live, mode));
      }
    } else
      transport.push({
        id: "live-transport",
        status: "not_run",
        passed: null,
        reason: "Requires explicit --live, provider, model and credentials.",
      });
  }
  const invariantsPassed = summaries.every((report) =>
    Object.values(report.invariants).every(Boolean),
  );
  const baselineFailures = summaries
    .filter((report) => !report.baselineQuality.passed)
    .map((report) => report.id);
  const livePassed =
    summaries.every(
      (report) => report.candidateAvailable && report.finalQuality.passed,
    ) && transport.every((report) => report.passed !== false);
  return {
    ...base,
    status:
      !invariantsPassed || (live && !livePassed)
        ? "failed"
        : live
          ? summaries.length > 0 ||
            transport.some((report) => report.passed !== null)
            ? "passed"
            : "not_run"
          : options.suite === "transport"
            ? "not_run"
            : "baseline_recorded",
    invariantsPassed,
    baselineFailures,
    summaries,
    transport,
  };
}
