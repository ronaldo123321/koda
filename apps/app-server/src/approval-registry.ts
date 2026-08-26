import type {
  ApprovalBroker,
  ApprovalDecision,
  ApprovalRequest,
} from "@koda/agent-core";
import type { ToolCallId, TurnId } from "@koda/protocol";

interface PendingApproval {
  turnId: TurnId;
  settled: boolean;
  promise: Promise<ApprovalDecision>;
  resolve(decision: ApprovalDecision): void;
  reject(error: unknown): void;
}

export type ApprovalResolution = "accepted" | "not_found" | "already_resolved";

export class PendingApprovalRegistry {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly settled = new Map<string, TurnId>();

  public preregister(turnId: TurnId, callId: ToolCallId): void {
    const key = approvalKey(turnId, callId);
    if (this.pending.has(key) || this.settled.has(key)) {
      return;
    }
    this.pending.set(key, deferredApproval(turnId));
  }

  public broker(getTurnId: () => TurnId | undefined): ApprovalBroker {
    return {
      request: async (
        request: ApprovalRequest,
        signal: AbortSignal,
      ): Promise<ApprovalDecision> => {
        const turnId = getTurnId();
        if (turnId === undefined) {
          throw new Error("Approval broker is not bound to a turn.");
        }
        const key = approvalKey(turnId, request.callId);
        this.preregister(turnId, request.callId);
        const pending = this.pending.get(key);
        if (pending === undefined) {
          throw new Error("Approval is no longer pending.");
        }
        if (signal.aborted) {
          this.abort(key, signal.reason);
          signal.throwIfAborted();
        }
        const onAbort = () => {
          this.abort(key, signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          return await pending.promise;
        } finally {
          signal.removeEventListener("abort", onAbort);
          this.pending.delete(key);
        }
      },
    };
  }

  public resolve(
    turnId: TurnId,
    callId: ToolCallId,
    decision: ApprovalDecision,
  ): ApprovalResolution {
    const key = approvalKey(turnId, callId);
    const pending = this.pending.get(key);
    if (pending === undefined) {
      return this.settled.has(key) ? "already_resolved" : "not_found";
    }
    if (pending.settled) {
      return "already_resolved";
    }
    pending.settled = true;
    this.settled.set(key, turnId);
    pending.resolve(decision);
    return "accepted";
  }

  public rejectTurn(turnId: TurnId, reason: string): void {
    for (const [key, pending] of this.pending) {
      if (pending.turnId !== turnId) {
        continue;
      }
      if (pending.settled) {
        continue;
      }
      pending.settled = true;
      this.settled.set(key, turnId);
      pending.reject(createAbortError(reason));
    }
  }

  public clearTurn(turnId: TurnId): void {
    this.rejectTurn(turnId, "The turn finished before approval resolved.");
    for (const [key, pending] of this.pending) {
      if (pending.turnId === turnId) {
        this.pending.delete(key);
      }
    }
    for (const [key, settledTurnId] of this.settled) {
      if (settledTurnId === turnId) {
        this.settled.delete(key);
      }
    }
  }

  private abort(key: string, reason: unknown): void {
    const pending = this.pending.get(key);
    if (pending === undefined) {
      return;
    }
    if (pending.settled) {
      return;
    }
    pending.settled = true;
    this.settled.set(key, pending.turnId);
    pending.reject(createAbortError(abortReason(reason)));
  }
}

function deferredApproval(turnId: TurnId): PendingApproval {
  let resolvePromise: (decision: ApprovalDecision) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<ApprovalDecision>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return {
    turnId,
    settled: false,
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function approvalKey(turnId: TurnId, callId: ToolCallId): string {
  return JSON.stringify([turnId, callId]);
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function abortReason(reason: unknown): string {
  return typeof reason === "string" && reason.length > 0
    ? reason
    : "The turn was cancelled.";
}
