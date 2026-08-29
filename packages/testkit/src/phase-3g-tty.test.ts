import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const pythonExecutable = "/usr/bin/python3";
const describeRealTty =
  process.platform === "win32" || !existsSync(pythonExecutable)
    ? describe.skip
    : describe;

describeRealTty("Phase 3I real TTY closure", () => {
  it("accepts a live Stage, inspects Plan, extensions, and activity, and restores the terminal", async () => {
    const entry = join(
      process.cwd(),
      "packages",
      "testkit",
      "dist",
      "phase-3g-tty-fixture.js",
    );
    const driver = join(
      process.cwd(),
      "packages",
      "testkit",
      "fixtures",
      "phase-3g-tty-driver.py",
    );
    const child = spawn(pythonExecutable, [driver, process.execPath, entry], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLUMNS: "100",
        LINES: "30",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    const exit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    const result = await withTimeout(exit, 25_000, "TTY fixture exit");

    expect(result).toEqual({ code: 0, signal: null });
    expect(stripTerminalControl(output)).toContain(
      "Stage acceptance required · stage:tty · Plan r1",
    );
    expect(stripTerminalControl(output)).toContain(
      "update_plan: accepted · stage stage:tty",
    );
    expect(stripTerminalControl(output)).toContain(
      "Durable Plan · phase-3g-tty-thread",
    );
    expect(stripTerminalControl(output)).toContain(
      "Stage 1/1 [accepted] Review the real-TTY flow",
    );
    expect(stripTerminalControl(output)).toContain("Extension catalogs");
    expect(stripTerminalControl(output)).toContain("Current workspace:");
    expect(stripTerminalControl(output)).toContain(
      "Durable activity · phase-3g-tty-thread",
    );
    expect(stripTerminalControl(output)).toContain(
      "#0 tool.started · update_plan · call phase-3g-tty-call",
    );
    expect(stripTerminalControl(output)).toContain("Durable terminal jobs");
    expect(stripTerminalControl(output)).toContain("pty-ready");
    expect(stripTerminalControl(output)).toContain("pty-input:03");
    expect(stripTerminalControl(output)).toContain("[phase-3g-tty] exit 0");
    expect(output).toContain("\u001b[?25h");
    expect(output).not.toContain("An interactive TTY is required");
    expect(output).not.toContain("Protocol state error");
  }, 30_000);
});

function stripTerminalControl(output: string): string {
  return output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "").replace(/\r/gu, "");
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`${label} timed out after ${milliseconds} ms.`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
