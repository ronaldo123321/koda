import type { ToolOperationalEvent } from "@koda/agent-core";
import { OwnedProcessTree } from "@koda/runtime-node";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("OwnedProcessTree", () => {
  it("records an uncertain Windows tree when taskkill and direct signaling cannot confirm exit", async () => {
    const lifecycle: ToolOperationalEvent[] = [];
    const child = fakeChild({ alive: true });
    const tree = new OwnedProcessTree({
      child,
      pid: 99_999_991,
      platform: "win32",
      terminationGraceMs: 0,
      terminationConfirmationMs: 100,
      report: async (event) => {
        lifecycle.push(event);
      },
    });

    await expect(tree.terminate("timeout")).resolves.toEqual({
      reason: "timeout",
      outcome: "uncertain",
    });
    expect(
      lifecycle.filter(
        (event) => event.type === "process.termination_requested",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            attempt: "graceful",
            mechanism: "windows_taskkill",
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            attempt: "graceful",
            mechanism: "direct_child_signal",
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            attempt: "force",
            mechanism: "windows_taskkill",
          }),
        }),
      ]),
    );
    expect(lifecycle.at(-1)).toEqual({
      type: "process.termination_completed",
      payload: { pid: 99_999_991, reason: "timeout", outcome: "uncertain" },
    });
  });

  it("records already_exited without sending a termination request", async () => {
    const lifecycle: ToolOperationalEvent[] = [];
    const tree = new OwnedProcessTree({
      child: fakeChild({ alive: false }),
      pid: 99_999_992,
      platform: "win32",
      terminationGraceMs: 0,
      terminationConfirmationMs: 100,
      report: async (event) => {
        lifecycle.push(event);
      },
    });

    await expect(tree.terminate("cancellation")).resolves.toEqual({
      reason: "cancellation",
      outcome: "already_exited",
    });
    expect(lifecycle).toEqual([
      {
        type: "process.termination_completed",
        payload: {
          pid: 99_999_992,
          reason: "cancellation",
          outcome: "already_exited",
        },
      },
    ]);
  });
});

function fakeChild(options: { alive: boolean }): ChildProcess {
  return {
    exitCode: options.alive ? null : 0,
    signalCode: null,
    kill: () => true,
  } as unknown as ChildProcess;
}
