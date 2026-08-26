import type { JsonObject, ToolCallId } from "@koda/protocol";

export type ToolEffect = "read" | "write" | "execute";

export type PolicyDecision =
  | { decision: "allow" }
  | { decision: "ask"; reason: string }
  | { decision: "deny"; reason: string };

export interface ToolPolicyInput {
  callId: ToolCallId;
  name: string;
  effect: ToolEffect;
  arguments: JsonObject;
}

export interface ToolPolicy {
  evaluate(input: ToolPolicyInput): PolicyDecision | Promise<PolicyDecision>;
}

export interface ToolApprovalPreview {
  title: string;
  summary: string;
  details: string;
}

export interface ApprovalRequest extends ToolApprovalPreview {
  callId: ToolCallId;
  name: string;
  reason: string;
}

export type ApprovalDecision =
  | { decision: "approved"; reason?: string }
  | { decision: "rejected"; reason?: string };

export interface ApprovalBroker {
  request(
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalDecision>;
}

export type WriteApprovalMode = "on-request" | "never";

export class EffectToolPolicy implements ToolPolicy {
  public constructor(private readonly writeMode: WriteApprovalMode) {}

  public evaluate(input: ToolPolicyInput): PolicyDecision {
    if (input.effect === "read") {
      return { decision: "allow" };
    }
    if (input.effect === "execute") {
      return {
        decision: "deny",
        reason: "Process execution is not enabled in this Koda phase.",
      };
    }
    return this.writeMode === "on-request"
      ? {
          decision: "ask",
          reason: "This tool will modify a file in the workspace.",
        }
      : {
          decision: "deny",
          reason: "Writes are disabled by the configured approval mode.",
        };
  }
}

export const denySideEffectsPolicy: ToolPolicy = new EffectToolPolicy("never");

export const rejectApprovalsBroker: ApprovalBroker = {
  request: async () => ({
    decision: "rejected",
    reason: "No approval broker is configured.",
  }),
};
