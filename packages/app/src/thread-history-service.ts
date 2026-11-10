import { join } from "node:path";
import {
  THREAD_EVENTS_DEFAULT_LIMIT,
  THREAD_EVENTS_MAXIMUM_LIMIT,
  THREAD_EVENTS_RESULT_BUDGET_BYTES,
  type AgentEvent,
  type ThreadId,
} from "@koda/protocol";
import { JsonlEventStore } from "@koda/runtime-node";
import { parseLocalThreadId } from "./config.js";

export interface ThreadEventsInput {
  threadId: string;
  beforeSequence?: number;
  afterSequence?: number;
  limit?: number;
}

export interface ThreadEventsPage {
  events: AgentEvent[];
  hasEarlier: boolean;
  hasLater: boolean;
  nextBeforeSequence?: number;
  nextAfterSequence?: number;
}

export class ThreadHistoryError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ThreadHistoryError";
  }
}

/** Owns validated history reads and bounded, bidirectional event pagination.
 * The home resolver is evaluated per read, preserving application configuration semantics.
 */
export class ThreadHistoryService {
  public constructor(private readonly kodaHome: () => string) {}

  public async readThreadEvents(
    input: ThreadEventsInput,
  ): Promise<ThreadEventsPage> {
    const threadId = parseLocalThreadId(input.threadId);
    const beforeSequence = input.beforeSequence;
    const afterSequence = input.afterSequence;
    if (beforeSequence !== undefined && afterSequence !== undefined) {
      throw new ThreadHistoryError(
        "INVALID_THREAD_EVENT_CURSOR",
        "beforeSequence and afterSequence are mutually exclusive cursors.",
      );
    }
    if (
      beforeSequence !== undefined &&
      (!Number.isSafeInteger(beforeSequence) || beforeSequence < 0)
    ) {
      throw new ThreadHistoryError(
        "INVALID_THREAD_EVENT_CURSOR",
        "Thread event cursor must be a non-negative safe integer.",
      );
    }
    if (
      afterSequence !== undefined &&
      (!Number.isSafeInteger(afterSequence) || afterSequence < -1)
    ) {
      throw new ThreadHistoryError(
        "INVALID_THREAD_EVENT_CURSOR",
        "Thread event cursor must be -1 or a non-negative safe integer.",
      );
    }
    const limit = input.limit ?? THREAD_EVENTS_DEFAULT_LIMIT;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > THREAD_EVENTS_MAXIMUM_LIMIT
    ) {
      throw new ThreadHistoryError(
        "INVALID_THREAD_EVENT_LIMIT",
        `Thread event limit must be between 1 and ${THREAD_EVENTS_MAXIMUM_LIMIT}.`,
      );
    }
    const events = await this.readValidatedThreadLog(threadId);

    if (afterSequence !== undefined) {
      return readForwardEventPage(events, afterSequence, limit);
    }

    const endIndex = findEventPageEnd(events, beforeSequence);
    const selected: AgentEvent[] = [];
    let startIndex = endIndex;
    while (startIndex > 0 && selected.length < limit) {
      const event = events[startIndex - 1];
      if (event === undefined) {
        break;
      }
      const candidate = [event, ...selected];
      const page = eventPage(
        candidate,
        startIndex - 1,
        endIndex,
        events.length,
      );
      if (serializedBytes(page) > THREAD_EVENTS_RESULT_BUDGET_BYTES) {
        if (selected.length === 0) {
          throw new ThreadHistoryError(
            "THREAD_EVENT_TOO_LARGE",
            `Thread event ${event.sequence} exceeds the ${THREAD_EVENTS_RESULT_BUDGET_BYTES}-byte history response budget.`,
          );
        }
        break;
      }
      selected.unshift(event);
      startIndex -= 1;
    }

    return eventPage(selected, startIndex, endIndex, events.length);
  }

  public async readValidatedThreadLog(
    threadId: ThreadId,
  ): Promise<AgentEvent[]> {
    const eventLogPath = join(this.kodaHome(), "threads", `${threadId}.jsonl`);
    let readResult;
    try {
      readResult = await new JsonlEventStore(eventLogPath).readAllRequired();
    } catch (error) {
      const code = applicationErrorCode(error);
      throw new ThreadHistoryError(code, errorMessage(error), {
        cause: error,
      });
    }
    if (readResult.diagnostics.length > 0) {
      throw new ThreadHistoryError(
        "THREAD_EVENT_LOG_CORRUPT",
        `Thread '${threadId}' has an incomplete trailing event and cannot be browsed safely.`,
      );
    }
    if (readResult.events.length === 0) {
      throw new ThreadHistoryError(
        "THREAD_EVENT_LOG_CORRUPT",
        `Thread '${threadId}' event log does not contain a durable event.`,
      );
    }
    if (readResult.events.some((event) => event.threadId !== threadId)) {
      throw new ThreadHistoryError(
        "THREAD_EVENT_LOG_CORRUPT",
        `Thread '${threadId}' event log contains an event for another thread.`,
      );
    }
    return readResult.events;
  }
}

function applicationErrorCode(error: unknown): string {
  return error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "THREAD_EVENT_READ_FAILED";
}

function findEventPageEnd(
  events: readonly AgentEvent[],
  beforeSequence: number | undefined,
): number {
  if (beforeSequence === undefined) {
    return events.length;
  }
  const index = events.findIndex((event) => event.sequence >= beforeSequence);
  return index === -1 ? events.length : index;
}

function readForwardEventPage(
  events: readonly AgentEvent[],
  afterSequence: number,
  limit: number,
): ThreadEventsPage {
  const found = events.findIndex((event) => event.sequence > afterSequence);
  const startIndex = found === -1 ? events.length : found;
  let endIndex = startIndex;
  const selected: AgentEvent[] = [];
  while (endIndex < events.length && selected.length < limit) {
    const event = events[endIndex];
    if (event === undefined) {
      break;
    }
    const candidate = [...selected, event];
    const page = eventPage(candidate, startIndex, endIndex + 1, events.length);
    if (serializedBytes(page) > THREAD_EVENTS_RESULT_BUDGET_BYTES) {
      if (selected.length === 0) {
        throw new ThreadHistoryError(
          "THREAD_EVENT_TOO_LARGE",
          `Thread event ${event.sequence} exceeds the ${THREAD_EVENTS_RESULT_BUDGET_BYTES}-byte history response budget.`,
        );
      }
      break;
    }
    selected.push(event);
    endIndex += 1;
  }
  return eventPage(selected, startIndex, endIndex, events.length);
}

function eventPage(
  events: AgentEvent[],
  startIndex: number,
  endIndex: number,
  eventCount: number,
): ThreadEventsPage {
  const hasEarlier = startIndex > 0;
  const hasLater = endIndex < eventCount;
  const first = events[0];
  const last = events.at(-1);
  return {
    events,
    hasEarlier,
    hasLater,
    ...(hasEarlier && first !== undefined
      ? { nextBeforeSequence: first.sequence }
      : {}),
    ...(hasLater && last !== undefined
      ? { nextAfterSequence: last.sequence }
      : {}),
  };
}

function serializedBytes(page: ThreadEventsPage): number {
  return Buffer.byteLength(JSON.stringify(page), "utf8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
