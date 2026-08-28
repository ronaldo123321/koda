import { createInterface } from "node:readline/promises";

import type {
  PlanAcceptanceBroker,
  PlanAcceptanceBrokerRequest,
} from "@koda/agent-core";
import {
  PLAN_DETAIL_BUDGET_BYTES,
  type PlanAcceptanceResolution,
  type PlanEvidenceReference,
} from "@koda/protocol";

import type { TextWriter } from "./console-event-sink.js";

export interface TerminalPlanAcceptanceBrokerOptions {
  input: NodeJS.ReadableStream;
  output: TextWriter;
}

const DEFAULT_REJECTION_FEEDBACK =
  "Stage acceptance was not granted by the user.";

export class TerminalPlanAcceptanceBroker implements PlanAcceptanceBroker {
  public constructor(
    private readonly options: TerminalPlanAcceptanceBrokerOptions,
  ) {}

  public async request(
    request: PlanAcceptanceBrokerRequest,
    signal: AbortSignal,
  ): Promise<PlanAcceptanceResolution> {
    signal.throwIfAborted();
    this.options.output.write(renderAcceptanceRequest(request));
    const lines = createInterface({
      input: this.options.input,
      terminal: false,
    });
    try {
      const iterator = lines[Symbol.asyncIterator]();
      const answer = (await readLine(iterator, signal)).trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        this.options.output.write("[koda] stage accepted\n");
        return resolution(request, "accepted");
      }
      let feedback = DEFAULT_REJECTION_FEEDBACK;
      if (answer === "n" || answer === "no") {
        this.options.output.write("Describe the required changes: ");
        feedback =
          (await readLine(iterator, signal)).trim() ||
          "Changes requested by the user.";
      }
      assertBoundedFeedback(feedback);
      this.options.output.write("[koda] stage changes requested\n");
      return resolution(request, "changes_requested", feedback);
    } catch (error) {
      if (!signal.aborted) {
        this.options.output.write(
          "[koda] stage acceptance unresolved: input unavailable\n",
        );
      }
      throw error;
    } finally {
      lines.close();
    }
  }
}

async function readLine(
  iterator: AsyncIterator<string>,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = () => {
      finish(() => reject(abortError(signal.reason)));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void iterator.next().then(
      (result) => {
        finish(() => {
          if (result.done) {
            reject(new Error("Stage acceptance input reached EOF."));
          } else {
            resolve(result.value);
          }
        });
      },
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error(
    typeof reason === "string" && reason.length > 0
      ? reason
      : "Stage acceptance was cancelled.",
  );
  error.name = "AbortError";
  return error;
}

function renderAcceptanceRequest(request: PlanAcceptanceBrokerRequest): string {
  return [
    "",
    `[koda] stage acceptance required: ${request.stageId} (plan ${request.planId} r${request.planRevision})`,
    request.summary,
    "Acceptance criteria:",
    ...request.criteria.map((criterion) => `- ${criterion}`),
    "Evidence:",
    ...request.evidence.map((evidence) => `- ${evidenceLabel(evidence)}`),
    "Accept this stage? [y/N] ",
  ].join("\n");
}

function evidenceLabel(evidence: PlanEvidenceReference): string {
  switch (evidence.kind) {
    case "item":
      return `item ${evidence.itemId}`;
    case "tool_call":
      return `tool call ${evidence.callId}`;
    case "artifact":
      return `artifact ${evidence.artifactId}`;
    case "event":
      return `event #${evidence.sequence}`;
  }
}

function resolution(
  request: PlanAcceptanceBrokerRequest,
  decision: "accepted" | "changes_requested",
  feedback?: string,
): PlanAcceptanceResolution {
  return {
    callId: request.callId,
    planId: request.planId,
    planRevision: request.planRevision,
    stageId: request.stageId,
    decision,
    ...(feedback === undefined ? {} : { feedback }),
  };
}

function assertBoundedFeedback(feedback: string): void {
  if (Buffer.byteLength(feedback, "utf8") > PLAN_DETAIL_BUDGET_BYTES) {
    throw new RangeError(
      `Stage acceptance feedback exceeds ${PLAN_DETAIL_BUDGET_BYTES} UTF-8 bytes.`,
    );
  }
}
