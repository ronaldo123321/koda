import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  THREAD_SEARCH_DEFAULT_LIMIT,
  THREAD_SEARCH_MAXIMUM_LIMIT,
  THREAD_SEARCH_MAXIMUM_TERMS,
  THREAD_SEARCH_QUERY_BUDGET_BYTES,
  THREAD_SEARCH_RESULT_BUDGET_BYTES,
  type ThreadId,
  type ThreadSearchCursor,
  type ThreadSearchMatch,
} from "@koda/protocol";
import {
  ThreadMetadataIndex,
  normalizeThreadSearchText,
  type ThreadMetadata,
  type ThreadIndexDiagnostic,
  type ThreadIndexRecovery,
  type ThreadIndexRefreshResult,
} from "@koda/runtime-node";
import { parseLocalThreadId } from "./config.js";
import { ThreadHistoryError } from "./thread-history-service.js";

export interface ThreadListInput {
  limit?: number;
  workspace?: string;
}

export interface ThreadSearchInput {
  workspace: string;
  query: string;
  cursor?: ThreadSearchCursor;
  limit?: number;
}

export interface ThreadSearchPage {
  matches: ThreadSearchMatch[];
  revision: number;
  hasMore: boolean;
  nextCursor?: ThreadSearchCursor;
}

export interface ThreadQueryResult<T> {
  value: T;
  diagnostics: ThreadIndexDiagnostic[];
  recovery?: ThreadIndexRecovery;
}

/** Query facade over the rebuildable index; every query refreshes from logs
 * and closes its index even when validation or querying fails.
 */
export class ThreadQueryService {
  public constructor(
    private readonly kodaHome: () => string,
    private readonly processDirectory: string,
  ) {}

  public async listThreads(
    input: ThreadListInput = {},
  ): Promise<ThreadQueryResult<ThreadMetadata[]>> {
    let workspaceRoot: string | undefined;
    if (input.workspace !== undefined) {
      workspaceRoot = await realpath(
        resolve(this.processDirectory, input.workspace),
      );
    }
    return this.withMetadataIndex(async (index) => {
      const refresh = await index.refresh();
      return {
        value: index.list({
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
        }),
        diagnostics: refresh.diagnostics,
      };
    });
  }

  public async getThread(
    threadIdInput: string,
  ): Promise<ThreadQueryResult<ThreadMetadata | undefined>> {
    const threadId = parseLocalThreadId(threadIdInput);
    return this.withMetadataIndex(async (index) => {
      const refresh = await index.refresh();
      return {
        value: index.get(threadId),
        diagnostics: refresh.diagnostics,
      };
    });
  }

  public async searchThreads(
    input: ThreadSearchInput,
  ): Promise<ThreadQueryResult<ThreadSearchPage>> {
    if (
      Buffer.byteLength(input.query, "utf8") > THREAD_SEARCH_QUERY_BUDGET_BYTES
    ) {
      throw new ThreadHistoryError(
        "INVALID_THREAD_SEARCH_QUERY",
        `Thread search query must not exceed ${THREAD_SEARCH_QUERY_BUDGET_BYTES} UTF-8 bytes.`,
      );
    }
    const normalizedQuery = normalizeThreadSearchText(input.query);
    const terms = normalizedQuery.split(" ").filter(Boolean);
    if (terms.length === 0 || terms.length > THREAD_SEARCH_MAXIMUM_TERMS) {
      throw new ThreadHistoryError(
        "INVALID_THREAD_SEARCH_QUERY",
        `Thread search query must contain between 1 and ${THREAD_SEARCH_MAXIMUM_TERMS} terms.`,
      );
    }
    const limit = input.limit ?? THREAD_SEARCH_DEFAULT_LIMIT;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > THREAD_SEARCH_MAXIMUM_LIMIT
    ) {
      throw new ThreadHistoryError(
        "INVALID_THREAD_SEARCH_LIMIT",
        `Thread search limit must be between 1 and ${THREAD_SEARCH_MAXIMUM_LIMIT}.`,
      );
    }
    const workspaceRoot = await realpath(
      resolve(this.processDirectory, input.workspace),
    );
    return this.withMetadataIndex(async (index) => {
      const refresh = await index.refresh();
      const page = index.search({
        workspaceRoot,
        query: normalizedQuery,
        limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      if (serializedSearchBytes(page) > THREAD_SEARCH_RESULT_BUDGET_BYTES) {
        throw new ThreadHistoryError(
          "THREAD_SEARCH_RESULT_TOO_LARGE",
          `Thread search result exceeds the ${THREAD_SEARCH_RESULT_BUDGET_BYTES}-byte response budget.`,
        );
      }
      return { value: page, diagnostics: refresh.diagnostics };
    });
  }

  public async refreshThread(
    kodaHome: string,
    threadId: ThreadId,
    onRecovery: (recovery: ThreadIndexRecovery) => Promise<void>,
  ): Promise<ThreadIndexRefreshResult> {
    let index: ThreadMetadataIndex | undefined;
    try {
      index = await ThreadMetadataIndex.open(kodaHome);
      if (index.recovery !== undefined) await onRecovery(index.recovery);
      return await index.refreshThread(threadId);
    } finally {
      index?.close();
    }
  }

  private async withMetadataIndex<T>(
    operation: (index: ThreadMetadataIndex) => Promise<ThreadQueryResult<T>>,
  ): Promise<ThreadQueryResult<T>> {
    let index: ThreadMetadataIndex | undefined;
    try {
      index = await ThreadMetadataIndex.open(this.kodaHome());
      const result = await operation(index);
      return {
        ...result,
        ...(index.recovery === undefined ? {} : { recovery: index.recovery }),
      };
    } finally {
      index?.close();
    }
  }
}

function serializedSearchBytes(page: ThreadSearchPage): number {
  return Buffer.byteLength(JSON.stringify(page), "utf8");
}
