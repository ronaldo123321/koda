import type {
  PlanAcceptanceRequest,
  PlanAcceptanceResolution,
  ThreadId,
  TurnId,
} from "@koda/protocol";

import { PlanReducerError } from "./plan-reducer.js";

export interface PlanAcceptanceBrokerRequest extends PlanAcceptanceRequest {
  threadId: ThreadId;
  turnId: TurnId;
}

export interface PlanAcceptanceBroker {
  request(
    request: PlanAcceptanceBrokerRequest,
    signal: AbortSignal,
  ): Promise<PlanAcceptanceResolution>;
}

export const rejectPlanAcceptancesBroker: PlanAcceptanceBroker = {
  request: async () => {
    throw new PlanReducerError(
      "PLAN_ACCEPTANCE_NOT_PENDING",
      "No live Plan acceptance broker is configured.",
    );
  },
};
