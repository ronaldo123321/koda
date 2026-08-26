import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { ThreadId } from "@koda/protocol";
import {
  ThreadMetadataIndex,
  type ThreadIndexDiagnostic,
  type ThreadMetadata,
} from "@koda/runtime-node";

import { parseLocalThreadId, resolveKodaHome } from "./config.js";
import type { TextWriter } from "./console-event-sink.js";

export interface ThreadCommandContext {
  environment: NodeJS.ProcessEnv;
  processDirectory: string;
  stdout: TextWriter;
  stderr: TextWriter;
}

export interface ThreadListCommandInput {
  limit?: string;
  workspace?: string;
}

export async function runThreadListCommand(
  input: ThreadListCommandInput,
  context: ThreadCommandContext,
): Promise<number> {
  let limit: number;
  try {
    limit = parseLimit(input.limit);
  } catch (error) {
    context.stderr.write(`[koda] ${errorMessage(error)}\n`);
    return 2;
  }

  let workspaceRoot: string | undefined;
  if (input.workspace !== undefined) {
    try {
      workspaceRoot = await realpath(
        resolve(context.processDirectory, input.workspace),
      );
    } catch (error) {
      context.stderr.write(
        `[koda] Workspace filter could not be resolved: ${errorMessage(error)}\n`,
      );
      return 2;
    }
  }

  return withIndex(context, async (index) => {
    const refresh = await index.refresh();
    writeDiagnostics(context.stderr, refresh.diagnostics);
    const threads = index.list({
      limit,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    });
    if (threads.length === 0) {
      context.stdout.write("No threads found.\n");
      return 0;
    }
    context.stdout.write("THREAD ID\tSTATUS\tUPDATED\tMODEL\tWORKSPACE\n");
    for (const thread of threads) {
      context.stdout.write(
        [
          thread.threadId,
          thread.status,
          thread.updatedAt,
          thread.model ?? "-",
          thread.workspaceRoot ?? "-",
        ]
          .map(formatCell)
          .join("\t") + "\n",
      );
    }
    return 0;
  });
}

export async function runThreadShowCommand(
  threadIdInput: string,
  context: ThreadCommandContext,
): Promise<number> {
  let threadId: ThreadId;
  try {
    threadId = parseLocalThreadId(threadIdInput);
  } catch {
    context.stderr.write(
      "[koda] Thread ID must use 1-128 letters, digits, underscores, or hyphens and cannot contain path syntax.\n",
    );
    return 2;
  }

  return withIndex(context, async (index) => {
    const refresh = await index.refresh();
    writeDiagnostics(context.stderr, refresh.diagnostics);
    const thread = index.get(threadId);
    if (thread === undefined) {
      context.stderr.write(`[koda] Thread '${threadId}' was not found.\n`);
      return 3;
    }
    writeThreadDetails(context.stdout, thread);
    return 0;
  });
}

async function withIndex(
  context: ThreadCommandContext,
  operation: (index: ThreadMetadataIndex) => Promise<number>,
): Promise<number> {
  let index: ThreadMetadataIndex | undefined;
  try {
    index = await ThreadMetadataIndex.open(
      resolveKodaHome(context.environment),
    );
    if (index.recovery !== undefined) {
      context.stderr.write(
        `[koda] warning: rebuilt a corrupt metadata database; preserved it at ${index.recovery.databaseBackup}\n`,
      );
    }
    return await operation(index);
  } catch (error) {
    context.stderr.write(`[koda] ${errorMessage(error)}\n`);
    return 1;
  } finally {
    index?.close();
  }
}

function parseLimit(input: string | undefined): number {
  const value = input?.trim() || "50";
  if (!/^\d+$/u.test(value)) {
    throw new Error("Thread list limit must be an integer between 1 and 500.");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Thread list limit must be an integer between 1 and 500.");
  }
  return limit;
}

function writeDiagnostics(
  writer: TextWriter,
  diagnostics: readonly ThreadIndexDiagnostic[],
): void {
  for (const diagnostic of diagnostics) {
    writer.write(
      `[koda] warning: ${formatCell(diagnostic.logFile)}: ${formatCell(diagnostic.message)}\n`,
    );
  }
}

function writeThreadDetails(writer: TextWriter, thread: ThreadMetadata): void {
  const rows: Array<[string, string | number]> = [
    ["Thread", thread.threadId],
    ["Status", thread.status],
    ["Created", thread.createdAt],
    ["Updated", thread.updatedAt],
    ["Last turn", thread.lastTurnId ?? "-"],
    ["Provider", thread.provider ?? "-"],
    ["Model", thread.model ?? "-"],
    ["Workspace", thread.workspaceRoot ?? "-"],
    ["Approval mode", thread.approvalMode ?? "-"],
    ["Turns", thread.turnCount],
    ["Events", thread.eventCount],
    ["Last sequence", thread.lastSequence ?? "-"],
    ["Log file", thread.logFile],
    ["Indexed bytes", `${thread.indexedBytes}/${thread.sourceBytes}`],
    [
      "Model requests",
      `${thread.usage.reportedRequests}/${thread.usage.modelRequests} reported`,
    ],
    ["Input tokens", thread.usage.tokens.inputTokens],
    ["Cached input tokens", thread.usage.tokens.cachedInputTokens],
    ["Cache-write input tokens", thread.usage.tokens.cacheWriteInputTokens],
    ["Output tokens", thread.usage.tokens.outputTokens],
    ["Reasoning output tokens", thread.usage.tokens.reasoningOutputTokens],
    ["Total tokens", thread.usage.tokens.totalTokens],
  ];
  if (thread.errorMessage !== undefined) {
    rows.push(["Index error", thread.errorMessage]);
  }
  for (const [label, value] of rows) {
    writer.write(`${label}: ${formatCell(String(value))}\n`);
  }
}

function formatCell(value: string | ThreadId): string {
  return String(value).replace(/[\t\r\n]/gu, " ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
