import {
  ContextEngine,
  digestContextItems,
  projectActiveContext,
  type ContextSummarizer,
  type SummaryObserver,
} from "@koda/agent-core";
import { compactionItemSchema, type TokenUsage } from "@koda/protocol";
import { DeterministicItemIdFactory } from "../deterministic.js";
import type { SummaryCase } from "./summary-cases.js";

export function scoreSummary(definition: SummaryCase, candidate: unknown) {
  const parsed = compactionItemSchema.shape.summary.safeParse(candidate);
  if (!parsed.success)
    return {
      valid: false,
      passed: false,
      checks: [{ id: "valid-structure", passed: false }],
    };
  const checks = definition.rules.map((rule) => {
    const text = rule.fields
      .flatMap((field) => parsed.data[field])
      .filter(
        (entry) =>
          !rule.allowedEntryPattern ||
          !new RegExp(rule.allowedEntryPattern, "i").test(entry),
      )
      .join("\n");
    const matched = new RegExp(rule.pattern, "i").test(text);
    return { id: rule.id, passed: rule.absent ? !matched : matched };
  });
  return { valid: true, passed: checks.every((check) => check.passed), checks };
}

export async function evaluateSummary(
  definition: SummaryCase,
  summarizer?: ContextSummarizer,
  signal: AbortSignal = new AbortController().signal,
) {
  let candidate: unknown;
  let calls = 0;
  let requests = 0;
  const usages: TokenUsage[] = [];
  const observer: SummaryObserver = {
    requested: () => {
      requests += 1;
    },
    reported: async (usage) => {
      usages.push(usage);
    },
  };
  const options = {
    contextWindowTokens: 8000,
    maxOutputTokens: 2048,
    safetyMarginTokens: 100,
  };
  const baseline = new ContextEngine({
    ...options,
    ids: new DeterministicItemIdFactory("baseline"),
  }).prepare(definition.transcript, []);
  const engine = new ContextEngine({
    ...options,
    ids: new DeterministicItemIdFactory("candidate"),
    ...(summarizer
      ? {
          summarizer: async (
            source: string,
            signal: AbortSignal,
            observer: SummaryObserver,
          ) => {
            calls += 1;
            candidate = await summarizer(source, signal, observer);
            return candidate;
          },
        }
      : {}),
  });
  const start = performance.now();
  const prepared = await engine.prepareAsync(
    definition.transcript,
    [],
    signal,
    observer,
  );
  const latencyMs = Math.round(performance.now() - start);
  const compaction = prepared.compaction;
  const replayValid =
    compaction !== undefined &&
    digestContextItems(
      projectActiveContext([...definition.transcript, compaction]),
    ) === digestContextItems(prepared.items);
  const invariants = {
    onlyLatestUserRetained:
      prepared.items.length === 2 && prepared.items[1]?.type === "user_message",
    latestObjectivePreserved:
      compaction?.summary.objective === definition.reference.objective,
    compacted: compaction !== undefined,
    withinBudget: prepared.estimatedInputTokens <= prepared.inputBudgetTokens,
    replayValid,
  };
  return {
    id: definition.id,
    description: definition.description,
    mode: summarizer ? "candidate" : "deterministic_baseline",
    latencyMs,
    requests,
    reportedRequests: usages.length,
    usage: usages,
    monetaryCost: null,
    summaryAttempts: calls,
    candidateAvailable: candidate !== undefined,
    finalMatchesBaseline:
      JSON.stringify(compaction?.summary) ===
      JSON.stringify(baseline.compaction?.summary),
    invariants,
    estimatedInputTokens: prepared.estimatedInputTokens,
    inputBudgetTokens: prepared.inputBudgetTokens,
    baselineQuality: scoreSummary(definition, baseline.compaction?.summary),
    candidateQuality:
      candidate === undefined ? null : scoreSummary(definition, candidate),
    finalQuality: scoreSummary(definition, compaction?.summary),
    baseline: baseline.compaction?.summary ?? null,
    candidate: candidate ?? null,
    final: compaction?.summary ?? null,
  };
}
