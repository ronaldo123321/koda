import { createHash } from "node:crypto";

import type { KodaApplication, TurnHandle } from "@koda/app";

import {
  RemoteAccessCatalog,
  RemoteAccessDeniedError,
  type RemotePrincipal,
} from "./remote-access.js";
import { RemoteThreadStore } from "./remote-thread-store.js";
import {
  RemoteTurnRequestConflictError,
  RemoteTurnRequestStore,
  type RemoteTurnRequestRecord,
} from "./remote-turn-request-store.js";

export interface RemoteTurnStartInput {
  requestId: string;
  workspaceId: string;
  prompt: string;
  resumeThreadId?: string;
}

export interface RemoteTurnStartResult {
  requestId: string;
  threadId: string;
  turnId: string;
  status: "started" | "reserved";
  replayed: boolean;
}

export class RemoteTurnHost {
  private readonly active = new Map<string, TurnHandle>();
  private pendingStarts = 0;
  private closed = false;

  public constructor(
    private readonly application: KodaApplication,
    private readonly threads: RemoteThreadStore,
    private readonly requests: RemoteTurnRequestStore,
  ) {
    if (!application.isRemoteRestricted) {
      throw new Error("Remote Turn host requires a restricted application.");
    }
  }

  public async start(
    principal: RemotePrincipal,
    catalog: RemoteAccessCatalog,
    input: RemoteTurnStartInput,
  ): Promise<RemoteTurnStartResult> {
    if (this.closed) throw new Error("Remote Turn host is shutting down.");
    const root = await catalog.authorizeWorkspace(
      principal,
      input.workspaceId,
      "workspace:read",
    );
    await catalog.authorizeWorkspace(
      principal,
      input.workspaceId,
      "turn:start",
    );
    if (input.resumeThreadId !== undefined) {
      const binding = await this.threads.get(input.resumeThreadId);
      if (
        binding?.workspaceId !== input.workspaceId ||
        (await catalog.authorizeThread(principal, binding, "turn:start")) !==
          root
      ) {
        throw new RemoteAccessDeniedError();
      }
      await catalog.authorizeThread(principal, binding, "thread:read");
      const metadata = (await this.application.getThread(input.resumeThreadId))
        .value;
      if (metadata?.workspaceRoot !== root) throw new RemoteAccessDeniedError();
    }
    const bodySha256 = createHash("sha256")
      .update(
        JSON.stringify({
          workspaceId: input.workspaceId,
          prompt: input.prompt,
          resumeThreadId: input.resumeThreadId ?? null,
        }),
      )
      .digest("hex");
    const existing = await this.requests.get(input.requestId);
    if (existing !== undefined) {
      return replay(existing, principal, input, bodySha256);
    }
    if (this.active.size + this.pendingStarts >= 8) {
      throw new RemoteTurnHostCapacityError();
    }
    this.pendingStarts += 1;
    let duplicate: RemoteTurnRequestRecord | undefined;
    let handle: TurnHandle;
    try {
      handle = await this.application.startTurnAfter(
        {
          prompt: input.prompt,
          cwd: root,
          approvalMode: "never",
          ...(input.resumeThreadId === undefined
            ? {}
            : { resume: input.resumeThreadId }),
        },
        {
          events: { append: async () => undefined },
          approvals: {
            request: async () => ({
              decision: "rejected",
              reason: "Remote approval is unavailable.",
            }),
          },
        },
        async (ids) => {
          if (this.closed)
            throw new Error("Remote Turn host is shutting down.");
          const claimed = await this.requests.claim({
            requestId: input.requestId,
            deviceId: principal.deviceId,
            workspaceId: input.workspaceId,
            bodySha256,
            threadId: ids.threadId,
            turnId: ids.turnId,
          });
          if (!claimed.created) {
            duplicate = claimed.record;
            throw new ExistingRemoteTurnRequest();
          }
          if (input.resumeThreadId === undefined) {
            await this.threads.bind({
              ownerId: principal.ownerId,
              workspaceId: input.workspaceId,
              threadId: ids.threadId,
            });
          }
        },
      );
    } catch (error) {
      this.pendingStarts -= 1;
      if (
        error instanceof ExistingRemoteTurnRequest &&
        duplicate !== undefined
      ) {
        return replay(duplicate, principal, input, bodySha256);
      }
      throw error;
    }
    try {
      await this.requests.markStarted(
        input.requestId,
        handle.threadId,
        handle.turnId,
      );
    } catch (error) {
      this.pendingStarts -= 1;
      handle.cancel("Remote Turn request could not be committed.");
      await handle.completion;
      throw error;
    }
    if (this.closed) {
      this.pendingStarts -= 1;
      handle.cancel("Remote host is shutting down.");
      await handle.completion;
      throw new Error("Remote Turn host is shutting down.");
    }
    this.active.set(handle.turnId, handle);
    this.pendingStarts -= 1;
    void handle.completion
      .finally(() => this.active.delete(handle.turnId))
      .catch(() => undefined);
    return {
      requestId: input.requestId,
      threadId: handle.threadId,
      turnId: handle.turnId,
      status: "started",
      replayed: false,
    };
  }

  public async close(): Promise<void> {
    this.closed = true;
    const handles = [...this.active.values()];
    for (const handle of handles)
      handle.cancel("Remote host is shutting down.");
    await Promise.allSettled(handles.map((handle) => handle.completion));
  }
}

export class RemoteTurnHostCapacityError extends Error {
  public constructor() {
    super("Remote Turn capacity is reached.");
    this.name = "RemoteTurnHostCapacityError";
  }
}

class ExistingRemoteTurnRequest extends Error {}

function replay(
  record: RemoteTurnRequestRecord,
  principal: RemotePrincipal,
  input: RemoteTurnStartInput,
  bodySha256: string,
): RemoteTurnStartResult {
  if (
    record.ownerId !== principal.ownerId ||
    record.deviceId !== principal.deviceId ||
    record.workspaceId !== input.workspaceId ||
    record.bodySha256 !== bodySha256
  ) {
    throw new RemoteTurnRequestConflictError();
  }
  return {
    requestId: record.requestId,
    threadId: record.threadId,
    turnId: record.turnId,
    status: record.status,
    replayed: true,
  };
}
