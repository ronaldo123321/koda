import { PassThrough, Readable } from "node:stream";

import { TerminalPlanAcceptanceBroker, type TextWriter } from "@koda/cli";
import {
  planIdSchema,
  planStageIdSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
} from "@koda/protocol";
import { describe, expect, it } from "vitest";

class MemoryWriter implements TextWriter {
  public value = "";

  public write(text: string): void {
    this.value += text;
  }
}

const request = {
  threadId: threadIdSchema.parse("terminal-plan-thread"),
  turnId: turnIdSchema.parse("terminal-plan-turn"),
  callId: toolCallIdSchema.parse("terminal-plan-call"),
  planId: planIdSchema.parse("plan:terminal"),
  planRevision: 3,
  stageId: planStageIdSchema.parse("stage:verify"),
  criteria: ["All offline tests pass.", "Recovery remains fail-closed."],
  summary: "Implementation and verification are complete.",
  evidence: [
    { kind: "tool_call" as const, callId: toolCallIdSchema.parse("test-call") },
  ],
};

describe("TerminalPlanAcceptanceBroker", () => {
  it.each(["y\n", "YES\n"])(
    "accepts only explicit answer %j",
    async (answer) => {
      const output = new MemoryWriter();
      const broker = new TerminalPlanAcceptanceBroker({
        input: Readable.from([answer]),
        output,
      });

      await expect(
        broker.request(request, new AbortController().signal),
      ).resolves.toMatchObject({
        callId: request.callId,
        planRevision: 3,
        decision: "accepted",
      });
      expect(output.value).toContain("stage:verify");
      expect(output.value).toContain("All offline tests pass.");
      expect(output.value).toContain("tool call test-call");
      expect(output.value).toContain("stage accepted");
    },
  );

  it("collects bounded feedback for an explicit rejection", async () => {
    const output = new MemoryWriter();
    const broker = new TerminalPlanAcceptanceBroker({
      input: Readable.from(["n\nAdd the missing crash test.\n"]),
      output,
    });

    await expect(
      broker.request(request, new AbortController().signal),
    ).resolves.toMatchObject({
      decision: "changes_requested",
      feedback: "Add the missing crash test.",
    });
    expect(output.value).toContain("Describe the required changes:");
    expect(output.value).toContain("stage changes requested");
  });

  it.each(["\n", "anything\n"])(
    "fails closed with default feedback for answer %j",
    async (answer) => {
      const broker = new TerminalPlanAcceptanceBroker({
        input: Readable.from([answer]),
        output: new MemoryWriter(),
      });

      await expect(
        broker.request(request, new AbortController().signal),
      ).resolves.toMatchObject({
        decision: "changes_requested",
        feedback: "Stage acceptance was not granted by the user.",
      });
    },
  );

  it("leaves acceptance unresolved when input is unavailable", async () => {
    const output = new MemoryWriter();
    const broker = new TerminalPlanAcceptanceBroker({
      input: Readable.from([]),
      output,
    });

    await expect(
      broker.request(request, new AbortController().signal),
    ).rejects.toBeDefined();
    expect(output.value).toContain("acceptance unresolved");
  });

  it("propagates cancellation while waiting for input", async () => {
    const input = new PassThrough();
    const controller = new AbortController();
    const broker = new TerminalPlanAcceptanceBroker({
      input,
      output: new MemoryWriter(),
    });

    const pending = broker.request(request, controller.signal);
    controller.abort("Cancelled stage acceptance.");

    await expect(pending).rejects.toBeDefined();
    input.destroy();
  });
});
