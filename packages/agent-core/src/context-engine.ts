import { createHash } from "node:crypto";

import {
  CONVERSATION_ITEM_TYPES,
  collectArtifactReferences,
  compactionItemSchema,
  itemIdSchema,
  type CompactionItem,
  type ConversationItem,
  type ConversationItemType,
  type ItemId,
} from "@koda/protocol";

import type { ModelToolDefinition } from "./model.js";

export interface ContextItemIdFactory {
  next(): ItemId;
}

export interface ContextEngineOptions {
  contextWindowTokens: number;
  maxOutputTokens: number;
  ids: ContextItemIdFactory;
  safetyMarginTokens?: number;
  fixedInputTokens?: number;
}

export interface PreparedModelContext {
  items: readonly ConversationItem[];
  rawEstimatedInputTokens: number;
  estimatedInputTokens: number;
  inputBudgetTokens: number;
  budget: Readonly<ContextBudgetSnapshot>;
  compaction?: CompactionItem;
}

export interface ContextBudgetSnapshot {
  contextWindowTokens: number;
  maxOutputTokens: number;
  safetyMarginTokens: number;
  inputBudgetTokens: number;
  fixedInputTokens: number;
  calibrationFactor: number;
}

export interface ContextItemTypeCount {
  type: ConversationItemType;
  count: number;
}

export type ContextBudgetErrorCode =
  | "CONTEXT_CONFIGURATION_INVALID"
  | "CONTEXT_BUDGET_EXCEEDED"
  | "CONTEXT_COMPACTION_INVALID";

export class ContextBudgetError extends Error {
  public constructor(
    public readonly code: ContextBudgetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ContextBudgetError";
  }
}

interface ItemGroup {
  items: ConversationItem[];
}

export const DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS = 8_192;
const STRUCTURAL_TOKENS_PER_ITEM = 12;
const REQUEST_BASE_TOKENS = 16;
const MAX_CALIBRATION_FACTOR = 8;
const PLACEHOLDER_ID = itemIdSchema.parse(`context-${"x".repeat(256)}`);

export class ContextEngine {
  public readonly inputBudgetTokens: number;
  private readonly fixedInputTokens: number;
  private readonly safetyMarginTokens: number;
  private calibrationFactor = 1;

  public constructor(private readonly options: ContextEngineOptions) {
    const safetyMarginTokens =
      options.safetyMarginTokens ?? DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS;
    this.safetyMarginTokens = safetyMarginTokens;
    for (const [name, value] of [
      ["contextWindowTokens", options.contextWindowTokens],
      ["maxOutputTokens", options.maxOutputTokens],
      ["safetyMarginTokens", safetyMarginTokens],
      ["fixedInputTokens", options.fixedInputTokens ?? 0],
    ] as const) {
      if (!Number.isInteger(value) || value < 0) {
        throw new ContextBudgetError(
          "CONTEXT_CONFIGURATION_INVALID",
          `${name} must be a non-negative integer.`,
        );
      }
    }
    if (options.contextWindowTokens < 1 || options.maxOutputTokens < 1) {
      throw new ContextBudgetError(
        "CONTEXT_CONFIGURATION_INVALID",
        "Context window and maximum output tokens must be positive.",
      );
    }
    this.inputBudgetTokens =
      options.contextWindowTokens -
      options.maxOutputTokens -
      safetyMarginTokens;
    if (this.inputBudgetTokens < 1) {
      throw new ContextBudgetError(
        "CONTEXT_CONFIGURATION_INVALID",
        "Context window must exceed the output reserve and safety margin.",
      );
    }
    this.fixedInputTokens = options.fixedInputTokens ?? 0;
    if (this.fixedInputTokens >= this.inputBudgetTokens) {
      throw new ContextBudgetError(
        "CONTEXT_CONFIGURATION_INVALID",
        "Fixed instructions consume the entire context input budget.",
      );
    }
  }

  public prepare(
    transcript: readonly ConversationItem[],
    tools: readonly ModelToolDefinition[],
  ): PreparedModelContext {
    const active = projectActiveContext(transcript);
    const beforeRaw = this.estimateRaw(active, tools);
    const before = this.calibrate(beforeRaw);
    if (before <= this.inputBudgetTokens) {
      return {
        items: active,
        rawEstimatedInputTokens: beforeRaw,
        estimatedInputTokens: before,
        inputBudgetTokens: this.inputBudgetTokens,
        budget: this.getBudgetSnapshot(),
      };
    }

    const groups = groupConversationItems(active);
    const latestUserGroup = findLatestUserGroup(groups);
    if (latestUserGroup < 0) {
      throw new ContextBudgetError(
        "CONTEXT_BUDGET_EXCEEDED",
        "Context cannot be compacted because it has no user message.",
      );
    }

    let retainedStart = latestUserGroup;
    let selected = this.buildCompactedCandidate(
      groups,
      retainedStart,
      before,
      tools,
      PLACEHOLDER_ID,
    );
    if (selected.estimatedInputTokens > this.inputBudgetTokens) {
      throw new ContextBudgetError(
        "CONTEXT_BUDGET_EXCEEDED",
        `The newest user turn requires approximately ${selected.estimatedInputTokens} input tokens, exceeding the ${this.inputBudgetTokens}-token budget.`,
      );
    }

    for (
      let candidateStart = latestUserGroup - 1;
      candidateStart > 0;
      candidateStart -= 1
    ) {
      const candidate = this.buildCompactedCandidate(
        groups,
        candidateStart,
        before,
        tools,
        PLACEHOLDER_ID,
      );
      if (candidate.estimatedInputTokens > this.inputBudgetTokens) {
        break;
      }
      retainedStart = candidateStart;
      selected = candidate;
    }

    const compactionId = this.options.ids.next();
    const finalCandidate = this.buildCompactedCandidate(
      groups,
      retainedStart,
      before,
      tools,
      compactionId,
    );
    if (finalCandidate.estimatedInputTokens > this.inputBudgetTokens) {
      throw new ContextBudgetError(
        "CONTEXT_BUDGET_EXCEEDED",
        "Compacted context unexpectedly exceeds its input budget.",
      );
    }
    return {
      items: finalCandidate.items,
      rawEstimatedInputTokens: finalCandidate.rawEstimatedInputTokens,
      estimatedInputTokens: finalCandidate.estimatedInputTokens,
      inputBudgetTokens: this.inputBudgetTokens,
      budget: this.getBudgetSnapshot(),
      compaction: finalCandidate.compaction,
    };
  }

  public observe(
    rawEstimatedInputTokens: number,
    measuredInputTokens: number,
  ): void {
    if (
      !Number.isFinite(rawEstimatedInputTokens) ||
      rawEstimatedInputTokens <= 0 ||
      !Number.isFinite(measuredInputTokens) ||
      measuredInputTokens <= 0
    ) {
      return;
    }
    const observedFactor =
      (measuredInputTokens / rawEstimatedInputTokens) * 1.1;
    this.calibrationFactor = Math.min(
      MAX_CALIBRATION_FACTOR,
      Math.max(this.calibrationFactor, observedFactor, 1),
    );
  }

  public getCalibrationFactor(): number {
    return this.calibrationFactor;
  }

  public getBudgetSnapshot(): Readonly<ContextBudgetSnapshot> {
    return Object.freeze({
      contextWindowTokens: this.options.contextWindowTokens,
      maxOutputTokens: this.options.maxOutputTokens,
      safetyMarginTokens: this.safetyMarginTokens,
      inputBudgetTokens: this.inputBudgetTokens,
      fixedInputTokens: this.fixedInputTokens,
      calibrationFactor: this.calibrationFactor,
    });
  }

  private buildCompactedCandidate(
    groups: readonly ItemGroup[],
    retainedStart: number,
    estimatedTokensBefore: number,
    tools: readonly ModelToolDefinition[],
    id: ItemId,
  ): {
    items: ConversationItem[];
    compaction: CompactionItem;
    rawEstimatedInputTokens: number;
    estimatedInputTokens: number;
  } {
    const omitted = groups
      .slice(0, retainedStart)
      .flatMap((group) => group.items);
    const retained = groups
      .slice(retainedStart)
      .flatMap((group) => group.items)
      .filter((item) => item.type !== "compaction");
    const retainedItemIds = retained
      .filter((item) => item.type !== "plan_state")
      .map((item) => item.id);
    const base = {
      type: "compaction" as const,
      id,
      reason: "context_budget" as const,
      retainedItemIds,
      estimatedTokensBefore,
      summary: buildSummary(omitted, [...omitted, ...retained]),
    };
    const provisional = compactionItemSchema.parse({
      ...base,
      estimatedTokensAfter: 0,
    });
    const provisionalItems: ConversationItem[] = [provisional, ...retained];
    const provisionalEstimate = this.calibrate(
      this.estimateRaw(provisionalItems, tools),
    );
    const compaction = compactionItemSchema.parse({
      ...base,
      estimatedTokensAfter: provisionalEstimate,
    });
    const items: ConversationItem[] = [compaction, ...retained];
    const rawEstimatedInputTokens = this.estimateRaw(items, tools);
    return {
      items,
      compaction,
      rawEstimatedInputTokens,
      estimatedInputTokens: this.calibrate(rawEstimatedInputTokens),
    };
  }

  private estimateRaw(
    items: readonly ConversationItem[],
    tools: readonly ModelToolDefinition[],
  ): number {
    const itemTokens = items.reduce(
      (total, item) =>
        total + estimateJsonTokens(item) + STRUCTURAL_TOKENS_PER_ITEM,
      0,
    );
    const toolTokens = tools.reduce(
      (total, tool) =>
        total + estimateJsonTokens(tool) + STRUCTURAL_TOKENS_PER_ITEM,
      0,
    );
    return (
      REQUEST_BASE_TOKENS + this.fixedInputTokens + itemTokens + toolTokens
    );
  }

  private calibrate(rawTokens: number): number {
    return Math.ceil(rawTokens * this.calibrationFactor);
  }
}

export function estimateTextTokens(value: string): number {
  return Math.ceil(new TextEncoder().encode(value).byteLength / 3);
}

function estimateJsonTokens(value: unknown): number {
  return estimateTextTokens(JSON.stringify(value));
}

export function projectActiveContext(
  transcript: readonly ConversationItem[],
): ConversationItem[] {
  let compactionIndex = -1;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (
      item?.type === "compaction" &&
      item.reason === "context_budget" &&
      item.retainedItemIds !== undefined
    ) {
      compactionIndex = index;
      break;
    }
  }
  if (compactionIndex < 0) {
    return [...transcript];
  }
  const compaction = transcript[compactionIndex];
  if (
    compaction?.type !== "compaction" ||
    compaction.retainedItemIds === undefined
  ) {
    throw new ContextBudgetError(
      "CONTEXT_COMPACTION_INVALID",
      "Latest compaction metadata is incomplete.",
    );
  }
  const retainedIds = new Set(compaction.retainedItemIds);
  if (retainedIds.size !== compaction.retainedItemIds.length) {
    throw new ContextBudgetError(
      "CONTEXT_COMPACTION_INVALID",
      "Compaction retained item IDs are duplicated.",
    );
  }
  const retained = transcript
    .slice(0, compactionIndex)
    .filter((item) => item.type !== "compaction" && retainedIds.has(item.id));
  if (retained.length !== retainedIds.size) {
    throw new ContextBudgetError(
      "CONTEXT_COMPACTION_INVALID",
      "Compaction references a retained item that is not in the transcript.",
    );
  }
  const later = transcript
    .slice(compactionIndex + 1)
    .filter((item) => item.type !== "compaction");
  return [compaction, ...retained, ...later];
}

export function summarizeContextItemTypes(
  items: readonly ConversationItem[],
): ContextItemTypeCount[] {
  const counts = new Map<ConversationItemType, number>();
  for (const item of items) {
    counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
  }
  return CONVERSATION_ITEM_TYPES.flatMap((type) => {
    const count = counts.get(type);
    return count === undefined ? [] : [{ type, count }];
  });
}

export function digestContextItems(items: readonly ConversationItem[]): string {
  return sha256CanonicalJson(items);
}

export function digestModelTools(
  tools: readonly ModelToolDefinition[],
): string {
  return sha256CanonicalJson(tools);
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError("Canonical JSON cannot encode undefined values.");
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function groupConversationItems(
  items: readonly ConversationItem[],
): ItemGroup[] {
  const groups: ItemGroup[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) {
      continue;
    }
    if (item.type === "approval" || item.type === "tool_result") {
      throw new ContextBudgetError(
        "CONTEXT_COMPACTION_INVALID",
        `Context contains an orphan ${item.type} item.`,
      );
    }
    if (item.type === "provider_state") {
      const grouped: ConversationItem[] = [item];
      let cursor = index + 1;
      while (items[cursor]?.type === "tool_call") {
        const toolGroup = collectToolGroup(items, cursor);
        grouped.push(...toolGroup.items);
        cursor = toolGroup.nextIndex;
      }
      if (!grouped.some((entry) => entry.type === "tool_call")) {
        throw new ContextBudgetError(
          "CONTEXT_COMPACTION_INVALID",
          `Provider state '${item.id}' has no following tool call.`,
        );
      }
      groups.push({ items: grouped });
      index = cursor - 1;
      continue;
    }
    if (item.type !== "tool_call") {
      groups.push({ items: [item] });
      continue;
    }
    const toolGroup = collectToolGroup(items, index);
    groups.push({ items: toolGroup.items });
    index = toolGroup.nextIndex - 1;
  }
  return groups;
}

function collectToolGroup(
  items: readonly ConversationItem[],
  index: number,
): { items: ConversationItem[]; nextIndex: number } {
  const item = items[index];
  if (item?.type !== "tool_call") {
    throw new ContextBudgetError(
      "CONTEXT_COMPACTION_INVALID",
      "Expected a tool call while grouping model context.",
    );
  }
  const grouped: ConversationItem[] = [item];
  let cursor = index + 1;
  while (cursor < items.length) {
    const related = items[cursor];
    if (
      related === undefined ||
      (related.type !== "approval" && related.type !== "tool_result") ||
      related.callId !== item.callId
    ) {
      break;
    }
    grouped.push(related);
    cursor += 1;
  }
  if (!grouped.some((entry) => entry.type === "tool_result")) {
    throw new ContextBudgetError(
      "CONTEXT_COMPACTION_INVALID",
      `Tool call '${item.callId}' has no result in model context.`,
    );
  }
  return { items: grouped, nextIndex: cursor };
}

function findLatestUserGroup(groups: readonly ItemGroup[]): number {
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    if (groups[index]?.items.some((item) => item.type === "user_message")) {
      return index;
    }
  }
  return -1;
}

function buildSummary(
  omitted: readonly ConversationItem[],
  active: readonly ConversationItem[],
): CompactionItem["summary"] {
  const latestUser = [...active]
    .reverse()
    .find((item) => item.type === "user_message");
  const assistantConclusions = omitted
    .filter((item) => item.type === "assistant_message")
    .slice(-4)
    .map((item) => excerpt(item.content));
  const priorSummaries = omitted.flatMap((item) =>
    item.type === "compaction" ? [item.summary] : [],
  );
  const successfulTools = omitted.flatMap((item) =>
    item.type === "tool_result" && item.status === "success"
      ? [`${item.name} completed successfully.`]
      : [],
  );
  const failedAttempts = omitted.flatMap((item) =>
    item.type === "tool_result" && item.status === "error"
      ? [
          excerpt(
            `${item.name}: ${item.error?.code ?? "TOOL_ERROR"}: ${item.error?.message ?? "Unknown tool error."}`,
          ),
        ]
      : [],
  );
  const modifiedFiles = omitted.flatMap((item) => {
    if (
      item.type !== "tool_result" ||
      item.name !== "apply_patch" ||
      item.status !== "success" ||
      item.output === undefined ||
      item.output === null ||
      typeof item.output !== "object" ||
      Array.isArray(item.output)
    ) {
      return [];
    }
    const path = item.output.path;
    return typeof path === "string" ? [path] : [];
  });
  const recoveryFacts = omitted.flatMap((item) =>
    item.type === "recovery" ? [excerpt(item.message)] : [],
  );
  const artifacts = omitted.flatMap((item) =>
    item.type === "tool_result" && item.output !== undefined
      ? collectArtifactReferences(item.output).map(
          (artifact) =>
            `Output artifact ${artifact.id} contains ${artifact.bytes} bytes.`,
        )
      : [],
  );
  return {
    objective:
      latestUser?.type === "user_message" ? excerpt(latestUser.content) : "",
    decisions: uniqueBounded([
      ...priorSummaries.flatMap((summary) => summary.decisions),
      ...assistantConclusions,
    ]),
    modifiedFiles: uniqueBounded([
      ...priorSummaries.flatMap((summary) => summary.modifiedFiles),
      ...modifiedFiles,
    ]),
    completedWork: uniqueBounded([
      ...priorSummaries.flatMap((summary) => summary.completedWork),
      ...successfulTools,
    ]),
    pendingWork: uniqueBounded([
      ...priorSummaries.flatMap((summary) => summary.pendingWork),
      ...(latestUser?.type === "user_message"
        ? [excerpt(latestUser.content)]
        : []),
    ]),
    failedAttempts: uniqueBounded([
      ...priorSummaries.flatMap((summary) => summary.failedAttempts),
      ...failedAttempts,
    ]),
    criticalFacts: uniqueBounded([
      ...priorSummaries.flatMap((summary) => summary.criticalFacts),
      ...recoveryFacts,
      ...artifacts,
    ]),
  };
}

function uniqueBounded(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
    .slice(-6)
    .map((value) => excerpt(value));
}

function excerpt(value: string, maximumCharacters = 500): string {
  return value.length <= maximumCharacters
    ? value
    : `${value.slice(0, maximumCharacters - 1)}…`;
}
