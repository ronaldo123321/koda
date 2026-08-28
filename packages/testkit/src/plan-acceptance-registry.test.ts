import { PendingPlanAcceptanceRegistry } from "@koda/app-server";
import type { PlanAcceptanceBrokerRequest } from "@koda/agent-core";
import {
  planAcceptanceResolveParamsSchema,
  planIdSchema,
  planStageIdSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
} from "@koda/protocol";
import { describe, expect, it } from "vitest";

describe("PendingPlanAcceptanceRegistry", () => {
  it("resolves only the exact pending Stage identity", async () => {
    const registry = new PendingPlanAcceptanceRegistry();
    const request = acceptanceRequest();
    const pending = registry
      .broker()
      .request(request, new AbortController().signal);

    expect(
      registry.resolve(
        planAcceptanceResolveParamsSchema.parse({
          ...acceptanceIdentity(request),
          planRevision: request.planRevision + 1,
          decision: "accepted",
        }),
      ),
    ).toBe("stale");
    expect(
      registry.resolve(
        planAcceptanceResolveParamsSchema.parse({
          ...acceptanceIdentity(request),
          decision: "accepted",
        }),
      ),
    ).toBe("accepted");
    await expect(pending).resolves.toEqual({
      callId: request.callId,
      planId: request.planId,
      planRevision: request.planRevision,
      stageId: request.stageId,
      decision: "accepted",
    });
  });

  it("allows exactly one decision under concurrent resolution", async () => {
    const registry = new PendingPlanAcceptanceRegistry();
    const request = acceptanceRequest();
    const pending = registry
      .broker()
      .request(request, new AbortController().signal);
    const decision = planAcceptanceResolveParamsSchema.parse({
      ...acceptanceIdentity(request),
      decision: "changes_requested",
      feedback: "Add the missing failure case.",
    });

    expect([registry.resolve(decision), registry.resolve(decision)]).toEqual([
      "accepted",
      "already_resolved",
    ]);
    await expect(pending).resolves.toMatchObject({
      decision: "changes_requested",
      feedback: "Add the missing failure case.",
    });
  });

  it("fails closed when a decision times out", async () => {
    const registry = new PendingPlanAcceptanceRegistry(5);

    await expect(
      registry
        .broker()
        .request(acceptanceRequest(), new AbortController().signal),
    ).rejects.toMatchObject({
      name: "PlanReducerError",
      code: "PLAN_ACCEPTANCE_NOT_PENDING",
    });
  });

  it("releases a waiting Turn when it is cancelled or disconnected", async () => {
    const registry = new PendingPlanAcceptanceRegistry();
    const request = acceptanceRequest();
    const pending = registry
      .broker()
      .request(request, new AbortController().signal);

    registry.rejectTurn(request.turnId, "Client disconnected.");

    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
      message: "Client disconnected.",
    });
    registry.clearTurn(request.turnId);
    expect(
      registry.resolve(
        planAcceptanceResolveParamsSchema.parse({
          ...acceptanceIdentity(request),
          decision: "accepted",
        }),
      ),
    ).toBe("not_found");
  });
});

function acceptanceRequest(): PlanAcceptanceBrokerRequest {
  return {
    threadId: threadIdSchema.parse("planning-thread"),
    turnId: turnIdSchema.parse("planning-turn"),
    callId: toolCallIdSchema.parse("planning-call"),
    planId: planIdSchema.parse("plan:planning"),
    planRevision: 1,
    stageId: planStageIdSchema.parse("stage:verify"),
    criteria: ["All tests pass."],
    summary: "Implementation is ready for review.",
    evidence: [],
  };
}

function acceptanceIdentity(request: PlanAcceptanceBrokerRequest) {
  return {
    threadId: request.threadId,
    turnId: request.turnId,
    callId: request.callId,
    planId: request.planId,
    planRevision: request.planRevision,
    stageId: request.stageId,
  };
}
