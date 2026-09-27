import type { ThreadId } from "@koda/protocol";

import type { TurnCompletion, TurnHandle } from "./koda-application.js";

export interface ChildSnapshot {
  threadId: ThreadId;
  status: "running" | "interrupted" | TurnCompletion["status"];
  answer?: string;
  errorCode?: string;
  worktreePath?: string;
}

interface ChildRecord {
  parentThreadId: ThreadId;
  workspaceRoot: string;
  handle: TurnHandle;
  worktreePath?: string;
  settled?: ChildSnapshot;
  completed: Promise<void>;
}

const MAX_ACTIVE_CHILDREN = 8;
const MAX_RETAINED_CHILDREN = 64;
const CHILD_TIMEOUT_MS = 120_000;

export class ChildRegistry {
  private readonly records = new Map<ThreadId, ChildRecord>();

  public canStart(): boolean {
    return (
      [...this.records.values()].filter((record) => !record.settled).length <
      MAX_ACTIVE_CHILDREN
    );
  }

  public register(input: {
    parentThreadId: ThreadId;
    workspaceRoot: string;
    handle: TurnHandle;
    answer: () => string;
    parentSignal: AbortSignal;
    worktreePath?: string;
  }): ChildSnapshot {
    if (!this.canStart() || this.records.has(input.handle.threadId)) {
      throw new Error("Child registry is full or duplicated.");
    }
    this.evictCompleted();
    const cancelWithParent = () =>
      input.handle.cancel("Parent turn was cancelled.");
    input.parentSignal.addEventListener("abort", cancelWithParent, {
      once: true,
    });
    const timeout = setTimeout(
      () => input.handle.cancel("Child task timed out."),
      CHILD_TIMEOUT_MS,
    );
    const record: ChildRecord = {
      parentThreadId: input.parentThreadId,
      workspaceRoot: input.workspaceRoot,
      handle: input.handle,
      ...(input.worktreePath === undefined
        ? {}
        : { worktreePath: input.worktreePath }),
      completed: Promise.resolve(),
    };
    record.completed = input.handle.completion
      .then((result) => {
        record.settled = {
          threadId: input.handle.threadId,
          status: result.status,
          answer: input.answer().slice(0, 4_000),
          ...(input.worktreePath === undefined
            ? {}
            : { worktreePath: input.worktreePath }),
          ...(result.error === undefined
            ? {}
            : { errorCode: result.error.code }),
        };
      })
      .catch(() => {
        record.settled = {
          threadId: input.handle.threadId,
          status: "failed",
          errorCode: "CHILD_RUNTIME_ERROR",
          ...(input.worktreePath === undefined
            ? {}
            : { worktreePath: input.worktreePath }),
        };
      })
      .finally(() => {
        clearTimeout(timeout);
        input.parentSignal.removeEventListener("abort", cancelWithParent);
      });
    this.records.set(input.handle.threadId, record);
    return {
      threadId: input.handle.threadId,
      status: "running",
      ...(input.worktreePath === undefined
        ? {}
        : { worktreePath: input.worktreePath }),
    };
  }

  public get(
    parentThreadId: ThreadId,
    workspaceRoot: string,
    childThreadId: ThreadId,
  ): ChildSnapshot | undefined {
    const record = this.owned(parentThreadId, workspaceRoot, childThreadId);
    if (record === undefined) return undefined;
    return (
      record.settled ?? {
        threadId: childThreadId,
        status: "running",
        ...(record.worktreePath === undefined
          ? {}
          : { worktreePath: record.worktreePath }),
      }
    );
  }

  public async wait(
    parentThreadId: ThreadId,
    workspaceRoot: string,
    childThreadIds: readonly ThreadId[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<ChildSnapshot[] | undefined> {
    signal.throwIfAborted();
    const records = childThreadIds.map((id) =>
      this.owned(parentThreadId, workspaceRoot, id),
    );
    if (records.some((record) => record === undefined)) return undefined;
    const owned = records as ChildRecord[];
    if (!owned.some((record) => record.settled) && timeoutMs > 0) {
      signal.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        await Promise.race([
          ...owned.map((record) => record.completed),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
          }),
          new Promise<void>((_, reject) => {
            onAbort = () => reject(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      }
    }
    return owned.map(
      (record) =>
        record.settled ?? {
          threadId: record.handle.threadId,
          status: "running",
          ...(record.worktreePath === undefined
            ? {}
            : { worktreePath: record.worktreePath }),
        },
    );
  }

  public send(
    parentThreadId: ThreadId,
    workspaceRoot: string,
    childThreadId: ThreadId,
    message: string,
  ): ReturnType<TurnHandle["steer"]> | "not_found" {
    const record = this.owned(parentThreadId, workspaceRoot, childThreadId);
    if (record === undefined) return "not_found";
    if (record.settled !== undefined) return "closed";
    return record.handle.steer(message);
  }

  public interrupt(
    parentThreadId: ThreadId,
    workspaceRoot: string,
    childThreadId: ThreadId,
  ): "accepted" | "not_found" | "not_running" {
    const record = this.owned(parentThreadId, workspaceRoot, childThreadId);
    if (record === undefined) return "not_found";
    if (record.settled !== undefined) return "not_running";
    return record.handle.cancel("Interrupted by the parent thread.")
      ? "accepted"
      : "not_running";
  }

  private owned(
    parentThreadId: ThreadId,
    workspaceRoot: string,
    childThreadId: ThreadId,
  ): ChildRecord | undefined {
    const record = this.records.get(childThreadId);
    return record?.parentThreadId === parentThreadId &&
      record.workspaceRoot === workspaceRoot
      ? record
      : undefined;
  }

  private evictCompleted(): void {
    if (this.records.size < MAX_RETAINED_CHILDREN) return;
    for (const [id, record] of this.records) {
      if (record.settled !== undefined) {
        this.records.delete(id);
        if (this.records.size < MAX_RETAINED_CHILDREN) return;
      }
    }
  }
}
