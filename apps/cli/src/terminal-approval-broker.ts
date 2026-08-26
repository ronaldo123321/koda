import { createInterface } from "node:readline/promises";

import type {
  ApprovalBroker,
  ApprovalDecision,
  ApprovalRequest,
} from "@koda/agent-core";

import type { TextWriter } from "./console-event-sink.js";

export interface TerminalApprovalBrokerOptions {
  input: NodeJS.ReadableStream;
  output: TextWriter;
}

export class TerminalApprovalBroker implements ApprovalBroker {
  public constructor(private readonly options: TerminalApprovalBrokerOptions) {}

  public async request(
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    signal.throwIfAborted();
    this.options.output.write(
      `\n[koda] approval required: ${request.title}\n${request.summary}\n${request.details}\nApprove this action? [y/N] `,
    );
    const lines = createInterface({
      input: this.options.input,
      terminal: false,
    });
    try {
      const answer = (await lines.question("", { signal }))
        .trim()
        .toLowerCase();
      const approved = answer === "y" || answer === "yes";
      this.options.output.write(
        approved ? "[koda] action approved\n" : "[koda] action rejected\n",
      );
      return approved
        ? { decision: "approved", reason: "Approved by the user." }
        : { decision: "rejected", reason: "Rejected by the user." };
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      this.options.output.write("[koda] action rejected: input unavailable\n");
      return {
        decision: "rejected",
        reason: "Approval input was unavailable.",
      };
    } finally {
      lines.close();
    }
  }
}
