import type {
  ApprovalGrantCandidate,
  ApprovalGrantId,
  ApprovalGrantRecord,
  ApprovalGrantSelection,
  JsonObject,
  ToolCallId,
} from "@koda/protocol";

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
  grantCandidate?: ApprovalGrantCandidate;
}

export interface ApprovalRequest extends ToolApprovalPreview {
  callId: ToolCallId;
  name: string;
  reason: string;
}

export type ApprovalDecision =
  | {
      decision: "approved";
      reason?: string;
      grant?: ApprovalGrantSelection;
    }
  | { decision: "rejected"; reason?: string };

export interface PreparedApprovalGrant {
  record: ApprovalGrantRecord;
  activate(): void;
  cancel(): void;
}

export interface ApprovalGrantManager {
  match(
    toolName: string,
    candidate: ApprovalGrantCandidate,
  ): ApprovalGrantRecord | undefined;
  prepare(
    toolName: string,
    candidate: ApprovalGrantCandidate,
    selection: ApprovalGrantSelection,
  ): PreparedApprovalGrant;
  markUsed(grantId: ApprovalGrantId): boolean;
}

export interface ApprovalBroker {
  request(
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalDecision>;
}

export type ApprovalMode = "on-request" | "never";

/** @deprecated Use ApprovalMode. */
export type WriteApprovalMode = ApprovalMode;

export class EffectToolPolicy implements ToolPolicy {
  public constructor(private readonly approvalMode: ApprovalMode) {}

  public evaluate(input: ToolPolicyInput): PolicyDecision {
    if (input.effect === "read") {
      return { decision: "allow" };
    }
    if (input.effect === "execute") {
      return this.approvalMode === "on-request"
        ? {
            decision: "ask",
            reason:
              "This tool will execute a process with the current user's permissions.",
          }
        : {
            decision: "deny",
            reason: "Process execution is disabled by the approval mode.",
          };
    }
    return this.approvalMode === "on-request"
      ? {
          decision: "ask",
          reason: "This tool will modify one or more files in the workspace.",
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
