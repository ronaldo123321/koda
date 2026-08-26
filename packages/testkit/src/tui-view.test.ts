import { PassThrough } from "node:stream";

import {
  initializeResultSchema,
  modelProviderIdSchema,
  toolCallIdSchema,
} from "@koda/protocol";
import {
  KodaView,
  createTuiProgram,
  routeTuiInput,
  type TuiInputController,
  type TuiState,
} from "@koda/tui";
import { renderToString, type Key } from "ink";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

describe("Koda Ink view", () => {
  it("renders immutable transcript rows and a bounded live region", () => {
    const state = baseState();
    state.transcript = [
      { id: "1", kind: "user", text: "Inspect the repository" },
      { id: "2", kind: "assistant", text: "I found the entry point." },
    ];
    state.activeTurn = {
      localId: 1,
      prompt: "Continue",
      status: "running",
      assistantText: "Reading files…",
      tools: [
        {
          callId: toolCallIdSchema.parse("view-call"),
          name: "read_file",
          status: "running",
          detail: "src/main.ts",
        },
      ],
      notes: [],
      cancelRequested: false,
    };

    const frame = renderToString(createElement(KodaView, { state }));
    expect(frame).toContain("You Inspect the repository");
    expect(frame).toContain("Koda I found the entry point.");
    expect(frame).toContain("Koda Reading files…");
    expect(frame).toContain("read_file: running · src/main.ts");
    expect(frame).toContain("Esc or Ctrl+C to cancel");
  });

  it("renders approval details and removes the ordinary prompt", () => {
    const state = baseState();
    state.approval = {
      callId: toolCallIdSchema.parse("approval-view-call"),
      name: "apply_patch",
      title: "Patch README",
      summary: "Replace one line",
      details: "old -> new",
      reason: "workspace write",
      detailsVisible: true,
      resolving: false,
    };
    state.activeTurn = {
      localId: 1,
      prompt: "Patch",
      status: "running",
      assistantText: "",
      tools: [],
      notes: [],
      cancelRequested: false,
    };

    const frame = renderToString(createElement(KodaView, { state }));
    expect(frame).toContain("Approval required · Patch README");
    expect(frame).toContain("old -> new");
    expect(frame).toContain("y approve · n reject · d details");
    expect(frame).not.toContain(">  ");
  });

  it("routes prompt, approval, cancellation, and exit keys", async () => {
    const controller = fakeInputController();
    const state = baseState();
    routeTuiInput(controller, state, "hello", key(), vi.fn());
    expect(controller.setInput).toHaveBeenCalledWith("hello");

    state.input = "hello";
    routeTuiInput(controller, state, "", key({ backspace: true }), vi.fn());
    expect(controller.setInput).toHaveBeenLastCalledWith("hell");
    routeTuiInput(controller, state, "", key({ return: true }), vi.fn());
    expect(controller.submitInput).toHaveBeenCalledOnce();

    state.approval = {
      callId: toolCallIdSchema.parse("route-approval-call"),
      name: "exec_command",
      title: "Run",
      summary: "Run command",
      details: "details",
      reason: "execute",
      detailsVisible: false,
      resolving: false,
    };
    routeTuiInput(controller, state, "y", key(), vi.fn());
    routeTuiInput(controller, state, "d", key(), vi.fn());
    expect(controller.resolveApproval).toHaveBeenCalledWith("approved");
    expect(controller.toggleApprovalDetails).toHaveBeenCalledOnce();

    state.approval = undefined;
    state.activeTurn = {
      localId: 1,
      prompt: "Run",
      status: "running",
      assistantText: "",
      tools: [],
      notes: [],
      cancelRequested: false,
    };
    routeTuiInput(controller, state, "", key({ escape: true }), vi.fn());
    expect(controller.cancelActiveTurn).toHaveBeenCalledOnce();

    state.activeTurn = undefined;
    const requestExit = vi.fn();
    routeTuiInput(controller, state, "c", key({ ctrl: true }), requestExit);
    expect(requestExit).toHaveBeenCalledOnce();
  });
});

describe("koda-chat program", () => {
  it("rejects non-TTY automation before starting app-server", async () => {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    const stderr = new PassThrough() as unknown as NodeJS.WriteStream;
    let stderrText = "";
    stderr.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });
    let exitCode: number | undefined;
    const program = createTuiProgram({
      environment: {},
      processDirectory: process.cwd(),
      stdin,
      stdout,
      stderr,
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    await program.parseAsync(["node", "koda-chat"]);
    expect(exitCode).toBe(2);
    expect(stderrText).toContain("An interactive TTY is required");
  });
});

function baseState(): TuiState {
  const initialization = initializeResultSchema.parse({
    protocolVersion: 2,
    server: { name: "koda-app-server", version: "test" },
    capabilities: {
      threadQueries: true,
      turnStart: true,
      turnResume: true,
      turnCancellation: true,
      interactiveApproval: true,
      durableEventNotifications: true,
    },
    providers: [
      {
        id: "openai",
        displayName: "OpenAI",
        credentialEnvironmentVariable: "OPENAI_API_KEY",
        defaultModel: "gpt-5.6-terra",
      },
    ],
  });
  return {
    connection: "ready",
    configuration: {
      cwd: "/workspace",
      provider: modelProviderIdSchema.parse("openai"),
      model: "gpt-5.6-terra",
      approvalMode: "on-request",
    },
    providers: initialization.providers,
    threadId: undefined,
    transcript: [],
    activeTurn: undefined,
    approval: undefined,
    input: "",
    notice: undefined,
  };
}

function fakeInputController() {
  return {
    setInput: vi.fn(),
    submitInput: vi.fn(() => Promise.resolve("handled" as const)),
    cancelActiveTurn: vi.fn(() => Promise.resolve()),
    resolveApproval: vi.fn(() => Promise.resolve()),
    toggleApprovalDetails: vi.fn(),
  } satisfies TuiInputController;
}

function key(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    ...overrides,
  };
}
