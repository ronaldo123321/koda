import { createHash } from "node:crypto";

import type { ApprovalDecision, ApprovalRequest } from "@koda/agent-core";
import type { KodaApplication, TurnHandle } from "@koda/app";

import {
  RemoteAccessCatalog,
  RemoteAccessDeniedError,
  type RemotePrincipal,
} from "./remote-access.js";
import { RemoteApprovalTransferStore } from "./remote-approval-transfer-store.js";
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
  effects?: readonly ("workspace:mutate" | "process:control" | "mcp:invoke")[];
}

interface PendingRemoteApproval {
  threadId: string;
  turnId: string;
  deviceId: string;
  effects: readonly ("workspace:mutate" | "process:control" | "mcp:invoke")[];
  mcpServerIds?: readonly string[];
  request: ApprovalRequest;
  expiresAt: number;
  transferring?: boolean;
  settle(decision: ApprovalDecision): boolean;
}

export interface RemoteApprovalPreview {
  turnId: string;
  callId: string;
  name: string;
  title: string;
  summary: string;
  details: string;
  reason: string;
  expiresAt: string;
}

export interface RemoteTurnStartResult {
  requestId: string;
  threadId: string;
  turnId: string;
  status: "started" | "reserved" | "abandoned";
  replayed: boolean;
}

export class RemoteTurnHost {
  private readonly active = new Map<
    string,
    { handle: TurnHandle; workspaceRoot: string }
  >();
  private readonly pendingApprovals = new Map<string, PendingRemoteApproval>();
  private pendingStarts = 0;
  private closed = false;

  public constructor(
    private readonly application: KodaApplication,
    private readonly threads: RemoteThreadStore,
    private readonly requests: RemoteTurnRequestStore,
    private readonly transferAudit?: RemoteApprovalTransferStore,
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
    for (const effect of input.effects ?? []) {
      await catalog.authorizeWorkspace(principal, input.workspaceId, effect);
    }
    const mcpServerIds = input.effects?.includes("mcp:invoke")
      ? await catalog.authorizedMcpServers(principal, input.workspaceId)
      : undefined;
    if ((input.effects?.length ?? 0) > 0) {
      await catalog.authorizeWorkspace(
        principal,
        input.workspaceId,
        "approval:resolve",
      );
      await catalog.authorizeWorkspace(
        principal,
        input.workspaceId,
        "thread:read",
      );
    }
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
          ...(input.effects?.length ? { effects: input.effects } : {}),
        }),
      )
      .digest("hex");
    const existing = await this.requests.get(input.requestId);
    if (existing !== undefined) {
      return replay(existing, principal, input, bodySha256);
    }
    const lease = await this.requests.acquireLease(input.requestId);
    try {
      const inFlight = await this.requests.get(input.requestId);
      if (inFlight !== undefined) {
        return replay(inFlight, principal, input, bodySha256);
      }
      if (this.active.size + this.pendingStarts >= 8) {
        throw new RemoteTurnHostCapacityError();
      }
      this.pendingStarts += 1;
      let duplicate: RemoteTurnRequestRecord | undefined;
      let handle: TurnHandle;
      let turnIds: { threadId: string; turnId: string } | undefined;
      try {
        handle = await this.application.startTurnAfter(
          {
            prompt: input.prompt,
            cwd: root,
            approvalMode: input.effects?.length ? "on-request" : "never",
            ...(input.effects?.length
              ? {
                  remoteEffects: {
                    ...(input.effects.includes("workspace:mutate")
                      ? { workspaceMutations: true as const }
                      : {}),
                    ...(input.effects.includes("process:control")
                      ? { processExecution: true as const }
                      : {}),
                    ...(mcpServerIds === undefined ? {} : { mcpServerIds }),
                  },
                }
              : {}),
            ...(input.resumeThreadId === undefined
              ? {}
              : { resume: input.resumeThreadId }),
          },
          {
            events: { append: async () => undefined },
            approvals: {
              request: (request, signal) => {
                if (turnIds === undefined)
                  throw new Error("Remote approval has no bound Turn.");
                return this.requestApproval(
                  turnIds,
                  principal.deviceId,
                  input.effects ?? [],
                  mcpServerIds,
                  request,
                  signal,
                );
              },
            },
          },
          async (ids) => {
            if (this.closed)
              throw new Error("Remote Turn host is shutting down.");
            turnIds = ids;
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
      this.active.set(handle.turnId, { handle, workspaceRoot: root });
      this.pendingStarts -= 1;
      void handle.completion
        .finally(() => {
          this.active.delete(handle.turnId);
          this.rejectTurnApprovals(handle.turnId);
        })
        .catch(() => undefined);
      return {
        requestId: input.requestId,
        threadId: handle.threadId,
        turnId: handle.turnId,
        status: "started",
        replayed: false,
      };
    } finally {
      await lease.release();
    }
  }

  public async cancel(
    principal: RemotePrincipal,
    catalog: RemoteAccessCatalog,
    threadId: string,
    turnId: string,
  ): Promise<boolean> {
    const root = await catalog.authorizeThread(
      principal,
      await this.threads.get(threadId),
      "turn:control",
    );
    const metadata = (await this.application.getThread(threadId)).value;
    if (
      !this.matchesLiveOrIndexedThread(threadId, root, metadata?.workspaceRoot)
    ) {
      throw new RemoteAccessDeniedError();
    }
    const handle = this.active.get(turnId)?.handle;
    if (handle?.threadId !== threadId) return false;
    return handle.cancel("Cancelled by an authorized remote device.");
  }

  public async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.pendingApprovals.values()) {
      pending.settle({ decision: "rejected", reason: "Remote host stopped." });
    }
    const handles = [...this.active.values()].map((entry) => entry.handle);
    for (const handle of handles)
      handle.cancel("Remote host is shutting down.");
    await Promise.allSettled(handles.map((handle) => handle.completion));
  }

  public async listApprovals(
    principal: RemotePrincipal,
    catalog: RemoteAccessCatalog,
    threadId: string,
  ): Promise<RemoteApprovalPreview[]> {
    await this.authorizeApprovalThread(principal, catalog, threadId);
    return [...this.pendingApprovals.values()]
      .filter(
        (pending) =>
          pending.threadId === threadId &&
          pending.deviceId === principal.deviceId &&
          !pending.transferring &&
          pending.expiresAt > Date.now(),
      )
      .map((pending) => ({
        turnId: pending.turnId,
        callId: pending.request.callId,
        name: pending.request.name,
        title: pending.request.title,
        summary: pending.request.summary,
        details: pending.request.details,
        reason: pending.request.reason,
        expiresAt: new Date(pending.expiresAt).toISOString(),
      }));
  }

  public async resolveApproval(
    principal: RemotePrincipal,
    catalog: RemoteAccessCatalog,
    threadId: string,
    turnId: string,
    callId: string,
    decision: "approved" | "rejected",
  ): Promise<boolean> {
    await this.authorizeApprovalThread(principal, catalog, threadId);
    const pending = this.pendingApprovals.get(JSON.stringify([turnId, callId]));
    if (
      pending === undefined ||
      pending.threadId !== threadId ||
      pending.deviceId !== principal.deviceId ||
      pending.transferring === true ||
      pending.expiresAt <= Date.now()
    )
      return false;
    return pending.settle({ decision });
  }

  public async transferApproval(
    principal: RemotePrincipal,
    catalog: RemoteAccessCatalog,
    target: RemotePrincipal,
    targetCatalog: RemoteAccessCatalog,
    threadId: string,
    turnId: string,
    callId: string,
  ): Promise<boolean> {
    await this.authorizeApprovalThread(principal, catalog, threadId);
    await this.authorizeApprovalThread(target, targetCatalog, threadId);
    if (
      this.closed ||
      principal.ownerId !== target.ownerId ||
      principal.deviceId === target.deviceId
    ) {
      return false;
    }
    const binding = await this.threads.get(threadId);
    const key = JSON.stringify([turnId, callId]);
    const pending = this.pendingApprovals.get(key);
    if (
      binding === undefined ||
      pending === undefined ||
      pending.threadId !== threadId ||
      pending.deviceId !== principal.deviceId ||
      pending.transferring === true ||
      pending.expiresAt <= Date.now()
    ) {
      return false;
    }
    for (const effect of pending.effects) {
      await targetCatalog.authorizeWorkspace(
        target,
        binding.workspaceId,
        effect,
      );
    }
    if (pending.mcpServerIds !== undefined) {
      const targetServers = await targetCatalog.authorizedMcpServers(
        target,
        binding.workspaceId,
      );
      if (pending.mcpServerIds.some((id) => !targetServers.includes(id))) {
        return false;
      }
    }
    if (this.transferAudit === undefined) {
      throw new Error("Remote approval transfer audit is unavailable.");
    }
    const current = this.pendingApprovals.get(key);
    if (
      this.closed ||
      current !== pending ||
      current?.transferring === true ||
      pending.deviceId !== principal.deviceId ||
      pending.expiresAt <= Date.now()
    ) {
      return false;
    }
    pending.transferring = true;
    try {
      await this.transferAudit.append({
        ownerId: principal.ownerId,
        workspaceId: binding.workspaceId,
        threadId,
        turnId,
        callId,
        fromDeviceId: principal.deviceId,
        toDeviceId: target.deviceId,
        requestedAt: new Date().toISOString(),
      });
      if (
        this.closed ||
        this.pendingApprovals.get(key) !== pending ||
        pending.expiresAt <= Date.now()
      ) {
        return false;
      }
      pending.deviceId = target.deviceId;
      return true;
    } finally {
      pending.transferring = false;
    }
  }

  private async authorizeApprovalThread(
    principal: RemotePrincipal,
    catalog: RemoteAccessCatalog,
    threadId: string,
  ): Promise<void> {
    const binding = await this.threads.get(threadId);
    const root = await catalog.authorizeThread(
      principal,
      binding,
      "approval:resolve",
    );
    await catalog.authorizeThread(principal, binding, "thread:read");
    const metadata = (await this.application.getThread(threadId)).value;
    if (
      !this.matchesLiveOrIndexedThread(threadId, root, metadata?.workspaceRoot)
    ) {
      throw new RemoteAccessDeniedError();
    }
  }

  private matchesLiveOrIndexedThread(
    threadId: string,
    root: string,
    indexedRoot: string | undefined,
  ): boolean {
    if (indexedRoot !== undefined) return indexedRoot === root;
    return [...this.active.values()].some(
      ({ handle, workspaceRoot }) =>
        handle.threadId === threadId && workspaceRoot === root,
    );
  }

  private requestApproval(
    ids: { threadId: string; turnId: string },
    deviceId: string,
    effects: readonly ("workspace:mutate" | "process:control" | "mcp:invoke")[],
    mcpServerIds: readonly string[] | undefined,
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    if (this.closed || signal.aborted || this.pendingApprovals.size >= 4) {
      return Promise.resolve({
        decision: "rejected",
        reason: "Remote approval is unavailable.",
      });
    }
    const key = JSON.stringify([ids.turnId, request.callId]);
    if (this.pendingApprovals.has(key)) {
      return Promise.resolve({
        decision: "rejected",
        reason: "Approval is already pending.",
      });
    }
    return new Promise<ApprovalDecision>((resolve) => {
      const expiresAt = Date.now() + 5 * 60_000;
      let settled = false;
      const settle = (decision: ApprovalDecision) => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.pendingApprovals.delete(key);
        resolve(decision);
        return true;
      };
      const onAbort = () =>
        settle({ decision: "rejected", reason: "Remote Turn was cancelled." });
      const timer = setTimeout(
        () =>
          settle({ decision: "rejected", reason: "Remote approval expired." }),
        5 * 60_000,
      );
      signal.addEventListener("abort", onAbort, { once: true });
      this.pendingApprovals.set(key, {
        ...ids,
        deviceId,
        effects,
        ...(mcpServerIds === undefined ? {} : { mcpServerIds }),
        request,
        expiresAt,
        settle,
      });
      if (signal.aborted) onAbort();
    });
  }

  private rejectTurnApprovals(turnId: string): void {
    for (const pending of this.pendingApprovals.values()) {
      if (pending.turnId === turnId) {
        pending.settle({ decision: "rejected", reason: "Remote Turn ended." });
      }
    }
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
