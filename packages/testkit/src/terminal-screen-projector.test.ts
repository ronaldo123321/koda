import { TERMINAL_TRUNCATION_MARKER, TerminalScreenProjector } from "@koda/tui";
import { describe, expect, it } from "vitest";

describe("TerminalScreenProjector", () => {
  it("streams split UTF-8 and consumes split CSI and OSC sequences", () => {
    const projector = new TerminalScreenProjector({ width: 40 });
    const prefix = Buffer.from("你", "utf8");
    projector.push(prefix.subarray(0, 1));
    projector.push(prefix.subarray(1));
    projector.push(Buffer.from("\u001b[3"));
    projector.push(Buffer.from("1mred\u001b[0m"));
    projector.push(Buffer.from("\u001b]52;c;secret"));
    projector.push(Buffer.from("\u0007safe"));
    projector.finish();

    const rows = projector.renderRows(10).join("\n");
    expect(rows).toContain("你redsafe");
    expect(rows).not.toContain("31m");
    expect(rows).not.toContain("secret");
    expect(rows).not.toContain("\u001b");
  });

  it("projects carriage return, backspace, cursor movement, and erase safely", () => {
    const projector = new TerminalScreenProjector({ width: 20 });
    projector.push(Buffer.from("abc\rZ\bY\u001b[1CZ\nnext\u001b[2K\rdone"));

    expect(projector.snapshot().rows).toEqual(["YbZ", "done"]);
  });

  it("bounds retained lines and exposes a visible truncation marker", () => {
    const projector = new TerminalScreenProjector({
      width: 20,
      maximumLines: 3,
    });
    projector.push(Buffer.from("one\r\ntwo\r\nthree\r\nfour\r\nfive"));

    const rows = projector.renderRows(10);
    expect(rows[0]).toBe(TERMINAL_TRUNCATION_MARKER);
    expect(rows).toEqual([TERMINAL_TRUNCATION_MARKER, "three", "four", "five"]);
  });
});
