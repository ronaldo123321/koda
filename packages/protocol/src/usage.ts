import { z } from "zod";

const tokenCountSchema = z.number().int().nonnegative();

export const tokenUsageSchema = z
  .object({
    inputTokens: tokenCountSchema,
    cachedInputTokens: tokenCountSchema,
    cacheWriteInputTokens: tokenCountSchema,
    outputTokens: tokenCountSchema,
    reasoningOutputTokens: tokenCountSchema,
    totalTokens: tokenCountSchema,
  })
  .superRefine((usage, context) => {
    if (usage.cachedInputTokens > usage.inputTokens) {
      context.addIssue({
        code: "custom",
        path: ["cachedInputTokens"],
        message: "Cached input tokens cannot exceed input tokens.",
      });
    }
    if (usage.cacheWriteInputTokens > usage.inputTokens) {
      context.addIssue({
        code: "custom",
        path: ["cacheWriteInputTokens"],
        message: "Cache-write input tokens cannot exceed input tokens.",
      });
    }
    if (usage.reasoningOutputTokens > usage.outputTokens) {
      context.addIssue({
        code: "custom",
        path: ["reasoningOutputTokens"],
        message: "Reasoning output tokens cannot exceed output tokens.",
      });
    }
  });

export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export const turnUsageSchema = z
  .object({
    modelRequests: tokenCountSchema,
    reportedRequests: tokenCountSchema,
    tokens: tokenUsageSchema,
  })
  .superRefine((usage, context) => {
    if (usage.reportedRequests > usage.modelRequests) {
      context.addIssue({
        code: "custom",
        path: ["reportedRequests"],
        message: "Reported requests cannot exceed model requests.",
      });
    }
  });

export type TurnUsage = z.infer<typeof turnUsageSchema>;
