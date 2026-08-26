import { PassThrough, Readable } from "node:stream";

import { TerminalApprovalBroker, type TextWriter } from "@koda/cli";
import { toolCallIdSchema } from "@koda/protocol";
import { describe, expect, it } from "vitest";

class MemoryWriter implements TextWriter {
  public value = "";

  public write(text: string): void {
    this.value += text;
  }
}

const request = {
  callId: toolCallIdSchema.parse("terminal-approval-call"),
  name: "apply_patch",
  title: "Update README.md",
  summary: "Update one exact match in README.md.",
  details: "*** Update File: README.md\n@@\n-old\n+new",
  reason: "This tool will modify a file in the workspace.",
};

describe("TerminalApprovalBroker", () => {
  it.each(["y\n", "YES\n"])("approves explicit answer %j", async (answer) => {
    const output = new MemoryWriter();
    const broker = new TerminalApprovalBroker({
      input: Readable.from([answer]),
      output,
    });

    await expect(
      broker.request(request, new AbortController().signal),
    ).resolves.toMatchObject({ decision: "approved" });
    expect(output.value).toContain("*** Update File: README.md");
    expect(output.value).toContain("patch approved");
  });

  it.each(["\n", "n\n", "anything\n"])(
    "rejects non-approval answer %j",
    async (answer) => {
      const broker = new TerminalApprovalBroker({
        input: Readable.from([answer]),
        output: new MemoryWriter(),
      });

      await expect(
        broker.request(request, new AbortController().signal),
      ).resolves.toMatchObject({ decision: "rejected" });
    },
  );

  it("propagates cancellation while waiting for input", async () => {
    const input = new PassThrough();
    const controller = new AbortController();
    const broker = new TerminalApprovalBroker({
      input,
      output: new MemoryWriter(),
    });

    const pending = broker.request(request, controller.signal);
    controller.abort("Cancelled approval.");

    await expect(pending).rejects.toBeDefined();
    input.destroy();
  });
});
