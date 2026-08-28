import {
  PlanReducerError,
  type PlanAcceptanceBroker,
  type PlanAcceptanceBrokerRequest,
} from "@koda/agent-core";
import type {
  PlanAcceptanceResolveParams,
  PlanAcceptanceResolution,
  ToolCallId,
  TurnId,
} from "@koda/protocol";

export const DEFAULT_PLAN_ACCEPTANCE_TIMEOUT_MS = 5 * 60 * 1_000;

interface PendingPlanAcceptance {
  request: PlanAcceptanceBrokerRequest;
  settled: boolean;
  promise: Promise<PlanAcceptanceResolution>;
  resolve(resolution: PlanAcceptanceResolution): void;
  reject(error: unknown): void;
  timer?: NodeJS.Timeout;
}

export type PlanAcceptanceRegistryResolution =
  "accepted" | "not_found" | "already_resolved" | "stale";

export class PendingPlanAcceptanceRegistry {
  private readonly pending = new Map<string, PendingPlanAcceptance>();
  private readonly settled = new Map<string, PlanAcceptanceBrokerRequest>();

  public constructor(
    private readonly timeoutMs = DEFAULT_PLAN_ACCEPTANCE_TIMEOUT_MS,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new RangeError("Plan acceptance timeout must be positive.");
    }
  }

  public preregister(request: PlanAcceptanceBrokerRequest): void {
    const key = acceptanceKey(request.turnId, request.callId);
    const pending = this.pending.get(key);
    if (pending !== undefined) {
      if (!sameIdentity(pending.request, request)) {
        throw new PlanReducerError(
          "PLAN_ACCEPTANCE_STALE",
          "A pending Plan acceptance has conflicting identity.",
        );
      }
      return;
    }
    const settled = this.settled.get(key);
    if (settled !== undefined) {
      throw new PlanReducerError(
        sameIdentity(settled, request)
          ? "PLAN_ACCEPTANCE_NOT_PENDING"
          : "PLAN_ACCEPTANCE_STALE",
        "The Plan acceptance request is no longer pending.",
      );
    }
    this.pending.set(key, deferredAcceptance(request));
  }

  public broker(): PlanAcceptanceBroker {
    return {
      request: async (request, signal) => {
        this.preregister(request);
        const key = acceptanceKey(request.turnId, request.callId);
        const pending = this.pending.get(key);
        if (pending === undefined) {
          throw new PlanReducerError(
            "PLAN_ACCEPTANCE_NOT_PENDING",
            "Plan acceptance is no longer pending.",
          );
        }
        if (signal.aborted) {
          this.abort(key, signal.reason);
          signal.throwIfAborted();
        }
        if (pending.timer === undefined) {
          pending.timer = setTimeout(() => {
            this.timeout(key);
          }, this.timeoutMs);
          pending.timer.unref();
        }
        const onAbort = () => {
          this.abort(key, signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          return await pending.promise;
        } finally {
          signal.removeEventListener("abort", onAbort);
          if (pending.timer !== undefined) {
            clearTimeout(pending.timer);
          }
          this.pending.delete(key);
        }
      },
    };
  }

  public resolve(
    input: PlanAcceptanceResolveParams,
  ): PlanAcceptanceRegistryResolution {
    const key = acceptanceKey(input.turnId, input.callId);
    const pending = this.pending.get(key);
    if (pending === undefined) {
      const settled = this.settled.get(key);
      if (settled === undefined) {
        return "not_found";
      }
      return sameIdentity(settled, input) ? "already_resolved" : "stale";
    }
    if (!sameIdentity(pending.request, input)) {
      return "stale";
    }
    if (pending.settled) {
      return "already_resolved";
    }
    pending.settled = true;
    this.settled.set(key, pending.request);
    pending.resolve({
      callId: input.callId,
      planId: input.planId,
      planRevision: input.planRevision,
      stageId: input.stageId,
      decision: input.decision,
      ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
    });
    return "accepted";
  }

  public rejectTurn(turnId: TurnId, reason: string): void {
    for (const [key, pending] of this.pending) {
      if (pending.request.turnId !== turnId || pending.settled) {
        continue;
      }
      pending.settled = true;
      this.settled.set(key, pending.request);
      if (pending.timer !== undefined) {
        clearTimeout(pending.timer);
      }
      pending.reject(createAbortError(reason));
    }
  }

  public clearTurn(turnId: TurnId): void {
    this.rejectTurn(
      turnId,
      "The turn finished before Plan acceptance resolved.",
    );
    for (const [key, pending] of this.pending) {
      if (pending.request.turnId === turnId) {
        if (pending.timer !== undefined) {
          clearTimeout(pending.timer);
        }
        this.pending.delete(key);
      }
    }
    for (const [key, settled] of this.settled) {
      if (settled.turnId === turnId) {
        this.settled.delete(key);
      }
    }
  }

  private timeout(key: string): void {
    const pending = this.pending.get(key);
    if (pending === undefined || pending.settled) {
      return;
    }
    pending.settled = true;
    this.settled.set(key, pending.request);
    pending.reject(
      new PlanReducerError(
        "PLAN_ACCEPTANCE_NOT_PENDING",
        `Plan acceptance timed out after ${this.timeoutMs} ms.`,
      ),
    );
  }

  private abort(key: string, reason: unknown): void {
    const pending = this.pending.get(key);
    if (pending === undefined || pending.settled) {
      return;
    }
    pending.settled = true;
    this.settled.set(key, pending.request);
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
    }
    pending.reject(createAbortError(abortReason(reason)));
  }
}

function deferredAcceptance(
  request: PlanAcceptanceBrokerRequest,
): PendingPlanAcceptance {
  let resolvePromise: (resolution: PlanAcceptanceResolution) => void = () =>
    undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<PlanAcceptanceResolution>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return {
    request,
    settled: false,
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function sameIdentity(
  expected: PlanAcceptanceBrokerRequest,
  candidate: Pick<
    PlanAcceptanceBrokerRequest,
    "threadId" | "turnId" | "callId" | "planId" | "planRevision" | "stageId"
  >,
): boolean {
  return (
    expected.threadId === candidate.threadId &&
    expected.turnId === candidate.turnId &&
    expected.callId === candidate.callId &&
    expected.planId === candidate.planId &&
    expected.planRevision === candidate.planRevision &&
    expected.stageId === candidate.stageId
  );
}

function acceptanceKey(turnId: TurnId, callId: ToolCallId): string {
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
