import { z } from "zod";

import { agentEventSchema } from "./events.js";
import { threadIdSchema, toolCallIdSchema, turnIdSchema } from "./ids.js";
import { jsonValueSchema } from "./json.js";
import { tokenUsageSchema } from "./usage.js";
import { modelProviderIdSchema, providerMetadataSchema } from "./providers.js";

export const APP_SERVER_PROTOCOL_VERSION = 5 as const;

export const THREAD_EVENTS_DEFAULT_LIMIT = 200;
export const THREAD_EVENTS_MAXIMUM_LIMIT = 200;
export const THREAD_EVENTS_RESULT_BUDGET_BYTES = 768 * 1_024;
export const THREAD_SEARCH_DEFAULT_LIMIT = 50;
export const THREAD_SEARCH_MAXIMUM_LIMIT = 100;
export const THREAD_SEARCH_QUERY_BUDGET_BYTES = 256;
export const THREAD_SEARCH_MAXIMUM_TERMS = 8;
export const THREAD_SEARCH_SNIPPET_BUDGET_BYTES = 512;
export const THREAD_SEARCH_RESULT_BUDGET_BYTES = 256 * 1_024;
export const RUNTIME_SETTINGS_WORKSPACE_BUDGET_BYTES = 4_096;
export const RUNTIME_SETTINGS_MODEL_BUDGET_BYTES = 256;
export const RUNTIME_SETTINGS_RESULT_BUDGET_BYTES = 64 * 1_024;
export const RUNTIME_SETTINGS_DIAGNOSTIC_BUDGET_BYTES = 1_024;

export const APP_SERVER_RPC_ERROR_CODE = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  NOT_INITIALIZED: -32001,
  ALREADY_INITIALIZED: -32002,
  VERSION_MISMATCH: -32003,
  TURN_NOT_FOUND: -32010,
  APPROVAL_NOT_FOUND: -32011,
  APPROVAL_ALREADY_RESOLVED: -32012,
  SHUTTING_DOWN: -32020,
  THREAD_NOT_FOUND: -32030,
  APPLICATION: -32050,
} as const;

export const jsonRpcIdSchema = z.union([
  z.string(),
  z.number().int().refine(Number.isSafeInteger),
]);

export const jsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: jsonRpcIdSchema,
    method: z.string().min(1).max(256),
    params: jsonValueSchema.optional(),
  })
  .strict();

export const jsonRpcNotificationSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.string().min(1),
    params: jsonValueSchema.optional(),
  })
  .strict();

export const jsonRpcErrorSchema = z
  .object({
    code: z.number().int(),
    message: z.string(),
    data: jsonValueSchema.optional(),
  })
  .strict();

export const jsonRpcSuccessResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: jsonRpcIdSchema,
    result: jsonValueSchema,
  })
  .strict();

export const jsonRpcErrorResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: jsonRpcIdSchema.nullable(),
    error: jsonRpcErrorSchema,
  })
  .strict();

export const jsonRpcResponseSchema = z.union([
  jsonRpcSuccessResponseSchema,
  jsonRpcErrorResponseSchema,
]);

export const initializeParamsSchema = z
  .object({
    protocolVersion: z.literal(APP_SERVER_PROTOCOL_VERSION),
    client: z
      .object({
        name: z.string().min(1).max(128),
        version: z.string().min(1).max(128).optional(),
      })
      .strict(),
  })
  .strict();

export const runtimeProviderMetadataSchema = z
  .object({
    ...providerMetadataSchema.shape,
    configured: z.boolean(),
  })
  .strict();

export const initializeResultSchema = z
  .object({
    protocolVersion: z.literal(APP_SERVER_PROTOCOL_VERSION),
    server: z
      .object({
        name: z.literal("koda-app-server"),
        version: z.string().min(1),
      })
      .strict(),
    capabilities: z
      .object({
        threadQueries: z.literal(true),
        turnStart: z.literal(true),
        turnResume: z.literal(true),
        turnCancellation: z.literal(true),
        interactiveApproval: z.literal(true),
        durableEventNotifications: z.literal(true),
        threadEvents: z.literal(true),
        threadSearch: z.literal(true),
        bidirectionalThreadEvents: z.literal(true),
        runtimeSettings: z.literal(true),
      })
      .strict(),
    providers: z.array(runtimeProviderMetadataSchema).min(1),
  })
  .strict();

const runtimeSettingsWorkspaceSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <=
      RUNTIME_SETTINGS_WORKSPACE_BUDGET_BYTES,
    `Workspace must not exceed ${RUNTIME_SETTINGS_WORKSPACE_BUDGET_BYTES} UTF-8 bytes.`,
  );

export const runtimeSettingsModelSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value === value.trim(),
    "Model ID must not contain leading or trailing whitespace.",
  )
  .refine(
    (value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
    "Model ID must not contain control characters.",
  )
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <=
      RUNTIME_SETTINGS_MODEL_BUDGET_BYTES,
    `Model ID must not exceed ${RUNTIME_SETTINGS_MODEL_BUDGET_BYTES} UTF-8 bytes.`,
  );

export const runtimePreferenceSchema = z
  .object({
    provider: modelProviderIdSchema,
    model: runtimeSettingsModelSchema,
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const runtimeSettingsDiagnosticSchema = z
  .object({
    code: z.string().min(1).max(128),
    message: z
      .string()
      .refine(
        (value) =>
          new TextEncoder().encode(value).byteLength <=
          RUNTIME_SETTINGS_DIAGNOSTIC_BUDGET_BYTES,
        `Settings diagnostic must not exceed ${RUNTIME_SETTINGS_DIAGNOSTIC_BUDGET_BYTES} UTF-8 bytes.`,
      ),
  })
  .strict();

export const runtimeSettingsRecoverySchema = z
  .object({ preferenceBackup: z.string().min(1) })
  .strict();

export const settingsGetParamsSchema = z
  .object({ workspace: runtimeSettingsWorkspaceSchema })
  .strict();

export const settingsGetResultSchema = z
  .object({
    workspace: runtimeSettingsWorkspaceSchema,
    revision: z.number().int().safe().nonnegative(),
    preference: runtimePreferenceSchema.optional(),
    diagnostics: z.array(runtimeSettingsDiagnosticSchema),
    recovery: runtimeSettingsRecoverySchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      (result.preference === undefined && result.revision !== 0) ||
      (result.preference !== undefined && result.revision === 0)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Settings revision must be zero exactly when no preference exists.",
        path: ["revision"],
      });
    }
  });

export const settingsUpdateParamsSchema = z
  .object({
    workspace: runtimeSettingsWorkspaceSchema,
    provider: modelProviderIdSchema,
    model: runtimeSettingsModelSchema,
    expectedRevision: z.number().int().safe().nonnegative(),
  })
  .strict();

export const settingsUpdateResultSchema = z
  .object({
    workspace: runtimeSettingsWorkspaceSchema,
    revision: z.number().int().safe().positive(),
    preference: runtimePreferenceSchema,
    diagnostics: z.array(runtimeSettingsDiagnosticSchema),
    recovery: runtimeSettingsRecoverySchema.optional(),
  })
  .strict();

export const threadListParamsSchema = z
  .object({
    limit: z.number().int().min(1).max(500).optional(),
    workspace: z.string().min(1).optional(),
  })
  .strict();

export const threadGetParamsSchema = z
  .object({
    threadId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u)
      .transform((value) => threadIdSchema.parse(value)),
  })
  .strict();

export const threadIndexDiagnosticSchema = z
  .object({
    logFile: z.string(),
    message: z.string(),
  })
  .strict();

export const threadIndexRecoverySchema = z
  .object({ databaseBackup: z.string().min(1) })
  .strict();

export const threadMetadataSchema = z
  .object({
    threadId: threadIdSchema,
    logFile: z.string().min(1),
    status: z.enum([
      "running",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
      "invalid",
    ]),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    lastTurnId: turnIdSchema.optional(),
    provider: modelProviderIdSchema.optional(),
    model: z.string().optional(),
    workspaceRoot: z.string().optional(),
    approvalMode: z.string().optional(),
    turnCount: z.number().int().nonnegative(),
    eventCount: z.number().int().nonnegative(),
    lastSequence: z.number().int().nonnegative().optional(),
    usage: z
      .object({
        modelRequests: z.number().int().nonnegative(),
        reportedRequests: z.number().int().nonnegative(),
        tokens: tokenUsageSchema,
      })
      .strict(),
    sourceBytes: z.number().int().nonnegative(),
    indexedBytes: z.number().int().nonnegative(),
    sourceMtimeMs: z.number().finite().nonnegative(),
    errorMessage: z.string().optional(),
  })
  .strict();

export const threadListResultSchema = z
  .object({
    threads: z.array(threadMetadataSchema),
    diagnostics: z.array(threadIndexDiagnosticSchema),
    recovery: threadIndexRecoverySchema.optional(),
  })
  .strict();

export const threadGetResultSchema = z
  .object({
    thread: threadMetadataSchema,
    diagnostics: z.array(threadIndexDiagnosticSchema),
    recovery: threadIndexRecoverySchema.optional(),
  })
  .strict();

export const threadEventsParamsSchema = z
  .object({
    threadId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u)
      .transform((value) => threadIdSchema.parse(value)),
    beforeSequence: z.number().int().safe().nonnegative().optional(),
    afterSequence: z.number().int().safe().nonnegative().optional(),
    limit: z
      .number()
      .int()
      .safe()
      .min(1)
      .max(THREAD_EVENTS_MAXIMUM_LIMIT)
      .optional(),
  })
  .strict()
  .superRefine((params, context) => {
    if (
      params.beforeSequence !== undefined &&
      params.afterSequence !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "beforeSequence and afterSequence are mutually exclusive cursors.",
        path: ["afterSequence"],
      });
    }
  });

export const threadEventsResultSchema = z
  .object({
    events: z.array(agentEventSchema).max(THREAD_EVENTS_MAXIMUM_LIMIT),
    hasEarlier: z.boolean(),
    hasLater: z.boolean(),
    nextBeforeSequence: z.number().int().safe().nonnegative().optional(),
    nextAfterSequence: z.number().int().safe().nonnegative().optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.events.length > 1) {
      for (let index = 1; index < result.events.length; index += 1) {
        const previous = result.events[index - 1];
        const current = result.events[index];
        if (
          previous !== undefined &&
          current !== undefined &&
          current.sequence !== previous.sequence + 1
        ) {
          context.addIssue({
            code: "custom",
            message: "Thread event pages must be chronological and contiguous.",
            path: ["events", index, "sequence"],
          });
          break;
        }
      }
    }
    if (result.hasEarlier && result.events.length > 0) {
      if (result.nextBeforeSequence !== result.events[0]?.sequence) {
        context.addIssue({
          code: "custom",
          message:
            "A page with earlier events must provide its first sequence as the next cursor.",
          path: ["nextBeforeSequence"],
        });
      }
    } else if (result.nextBeforeSequence !== undefined) {
      context.addIssue({
        code: "custom",
        message: "A final page cannot provide a next cursor.",
        path: ["nextBeforeSequence"],
      });
    }
    if (result.hasLater && result.events.length > 0) {
      if (result.nextAfterSequence !== result.events.at(-1)?.sequence) {
        context.addIssue({
          code: "custom",
          message:
            "A page with later events must provide its last sequence as the next cursor.",
          path: ["nextAfterSequence"],
        });
      }
    } else if (result.nextAfterSequence !== undefined) {
      context.addIssue({
        code: "custom",
        message: "A latest page cannot provide a next cursor.",
        path: ["nextAfterSequence"],
      });
    }
  });

export const threadSearchItemKindSchema = z.enum([
  "user_message",
  "assistant_message",
  "tool_result",
  "compaction",
  "recovery",
  "tool_failure",
  "turn_cancelled",
  "turn_failed",
]);

export const threadSearchCursorSchema = z
  .object({
    revision: z.number().int().safe().nonnegative(),
    updatedAt: z.string().datetime({ offset: true }),
    threadId: threadIdSchema,
    sequence: z.number().int().safe().nonnegative(),
  })
  .strict();

export const threadSearchParamsSchema = z
  .object({
    workspace: z.string().min(1),
    query: z
      .string()
      .min(1)
      .refine(
        (value) => value.trim().length > 0,
        "Search query must contain a non-whitespace term.",
      )
      .refine(
        (value) =>
          new TextEncoder().encode(value).byteLength <=
          THREAD_SEARCH_QUERY_BUDGET_BYTES,
        `Search query must not exceed ${THREAD_SEARCH_QUERY_BUDGET_BYTES} UTF-8 bytes.`,
      )
      .refine(
        (value) =>
          value.trim().split(/\s+/u).filter(Boolean).length <=
          THREAD_SEARCH_MAXIMUM_TERMS,
        `Search query must contain at most ${THREAD_SEARCH_MAXIMUM_TERMS} terms.`,
      ),
    cursor: threadSearchCursorSchema.optional(),
    limit: z
      .number()
      .int()
      .safe()
      .min(1)
      .max(THREAD_SEARCH_MAXIMUM_LIMIT)
      .optional(),
  })
  .strict();

export const threadSearchMatchSchema = z
  .object({
    threadId: threadIdSchema,
    sequence: z.number().int().safe().nonnegative(),
    kind: threadSearchItemKindSchema,
    timestamp: z.string().datetime({ offset: true }),
    snippet: z
      .string()
      .refine(
        (value) =>
          new TextEncoder().encode(value).byteLength <=
          THREAD_SEARCH_SNIPPET_BUDGET_BYTES,
        `Search snippet must not exceed ${THREAD_SEARCH_SNIPPET_BUDGET_BYTES} UTF-8 bytes.`,
      ),
    threadUpdatedAt: z.string().datetime({ offset: true }),
    status: threadMetadataSchema.shape.status,
    provider: modelProviderIdSchema.optional(),
    model: z.string().optional(),
    turnCount: z.number().int().nonnegative(),
  })
  .strict();

export const threadSearchResultSchema = z
  .object({
    matches: z.array(threadSearchMatchSchema).max(THREAD_SEARCH_MAXIMUM_LIMIT),
    revision: z.number().int().safe().nonnegative(),
    hasMore: z.boolean(),
    nextCursor: threadSearchCursorSchema.optional(),
    diagnostics: z.array(threadIndexDiagnosticSchema),
    recovery: threadIndexRecoverySchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.hasMore) {
      const last = result.matches.at(-1);
      if (
        last === undefined ||
        result.nextCursor?.revision !== result.revision ||
        result.nextCursor.updatedAt !== last.threadUpdatedAt ||
        result.nextCursor.threadId !== last.threadId ||
        result.nextCursor.sequence !== last.sequence
      ) {
        context.addIssue({
          code: "custom",
          message:
            "A paginated search result must provide the last match as its revision-bound cursor.",
          path: ["nextCursor"],
        });
      }
    } else if (result.nextCursor !== undefined) {
      context.addIssue({
        code: "custom",
        message: "A final search result cannot provide a next cursor.",
        path: ["nextCursor"],
      });
    }
  });

export const turnStartParamsSchema = z
  .object({
    prompt: z.string().min(1),
    cwd: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    provider: modelProviderIdSchema.optional(),
    resumeThreadId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u)
      .optional(),
    approvalMode: z.enum(["on-request", "never"]).optional(),
  })
  .strict();

export const turnStartResultSchema = z
  .object({
    threadId: threadIdSchema,
    turnId: turnIdSchema,
  })
  .strict();

export const turnCancelParamsSchema = z
  .object({
    turnId: turnIdSchema,
    reason: z.string().min(1).max(1_000).optional(),
  })
  .strict();

export const turnCancelResultSchema = z
  .object({ accepted: z.boolean() })
  .strict();

export const approvalResolveParamsSchema = z
  .object({
    turnId: turnIdSchema,
    callId: toolCallIdSchema,
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().max(1_000).optional(),
  })
  .strict();

export const approvalResolveResultSchema = z
  .object({ accepted: z.literal(true) })
  .strict();

export const shutdownParamsSchema = z.object({}).strict();
export const shutdownResultSchema = z.object({}).strict();

export const turnEventNotificationParamsSchema = z
  .object({ event: agentEventSchema })
  .strict();

export const turnFinishedNotificationParamsSchema = z
  .object({
    threadId: threadIdSchema,
    turnId: turnIdSchema,
    status: z.enum(["completed", "cancelled", "failed"]),
    exitCode: z.union([z.literal(0), z.literal(1), z.literal(130)]),
    error: z
      .object({ code: z.string().min(1), message: z.string() })
      .strict()
      .optional(),
  })
  .strict();

export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;
export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;
export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>;
export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;
export type InitializeParams = z.infer<typeof initializeParamsSchema>;
export type InitializeResult = z.infer<typeof initializeResultSchema>;
export type RuntimeProviderMetadata = z.infer<
  typeof runtimeProviderMetadataSchema
>;
export type RuntimePreference = z.infer<typeof runtimePreferenceSchema>;
export type RuntimeSettingsDiagnostic = z.infer<
  typeof runtimeSettingsDiagnosticSchema
>;
export type RuntimeSettingsRecovery = z.infer<
  typeof runtimeSettingsRecoverySchema
>;
export type SettingsGetParams = z.infer<typeof settingsGetParamsSchema>;
export type SettingsGetResult = z.infer<typeof settingsGetResultSchema>;
export type SettingsUpdateParams = z.infer<typeof settingsUpdateParamsSchema>;
export type SettingsUpdateResult = z.infer<typeof settingsUpdateResultSchema>;
export type ThreadListParams = z.infer<typeof threadListParamsSchema>;
export type ThreadListResult = z.infer<typeof threadListResultSchema>;
export type ThreadGetParams = z.infer<typeof threadGetParamsSchema>;
export type ThreadGetResult = z.infer<typeof threadGetResultSchema>;
export type ThreadEventsParams = z.infer<typeof threadEventsParamsSchema>;
export type ThreadEventsResult = z.infer<typeof threadEventsResultSchema>;
export type ThreadSearchItemKind = z.infer<typeof threadSearchItemKindSchema>;
export type ThreadSearchCursor = z.infer<typeof threadSearchCursorSchema>;
export type ThreadSearchParams = z.infer<typeof threadSearchParamsSchema>;
export type ThreadSearchMatch = z.infer<typeof threadSearchMatchSchema>;
export type ThreadSearchResult = z.infer<typeof threadSearchResultSchema>;
export type ThreadMetadataMessage = z.infer<typeof threadMetadataSchema>;
export type TurnStartParams = z.infer<typeof turnStartParamsSchema>;
export type TurnStartResult = z.infer<typeof turnStartResultSchema>;
export type TurnCancelParams = z.infer<typeof turnCancelParamsSchema>;
export type TurnCancelResult = z.infer<typeof turnCancelResultSchema>;
export type ApprovalResolveParams = z.infer<typeof approvalResolveParamsSchema>;
export type ApprovalResolveResult = z.infer<typeof approvalResolveResultSchema>;
export type ShutdownResult = z.infer<typeof shutdownResultSchema>;
export type TurnEventNotificationParams = z.infer<
  typeof turnEventNotificationParamsSchema
>;
export type TurnFinishedNotificationParams = z.infer<
  typeof turnFinishedNotificationParamsSchema
>;
