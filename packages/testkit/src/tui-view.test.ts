import { PassThrough } from "node:stream";

import {
  APP_SERVER_PROTOCOL_VERSION,
  artifactReferenceSchema,
  initializeResultSchema,
  modelProviderIdSchema,
  planIdSchema,
  planSnapshotSchema,
  planStageIdSchema,
  threadIdSchema,
  toolCallIdSchema,
  turnIdSchema,
} from "@koda/protocol";
import {
  KodaView,
  createTuiProgram,
  resolveTuiRuntimeSelection,
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

  it("renders a bounded durable Plan view and compact chat status", () => {
    const state = baseState();
    state.threadId = "tui-thread";
    state.mode = "plan_view";
    state.planNavigation = {
      threadId: threadIdSchema.parse("tui-thread"),
      rows: [
        "Plan plan:tui · revision 2 · active",
        "Objective: Ship it",
        "hidden",
      ],
      scrollOffset: 1,
      loading: false,
      viewportHeight: 1,
      viewportWidth: 80,
    };
    let frame = renderToString(createElement(KodaView, { state }));
    expect(frame).toContain("Durable Plan · tui-thread");
    expect(frame).toContain("Objective: Ship it");
    expect(frame).not.toContain("hidden");
    expect(frame).toContain("2–2 / 3 rows");

    state.mode = "chat";
    state.planNavigation = undefined;
    state.currentPlan = planSnapshotSchema.parse({
      schemaVersion: 1,
      planId: "plan:tui",
      revision: 2,
      objective: "Ship it",
      status: "active",
      stages: [
        {
          id: "stage:tui",
          title: "Build interaction",
          status: "active",
          requiresAcceptance: false,
          acceptanceCriteria: [],
          evidence: [],
          todos: [
            {
              id: "todo:tui",
              title: "Add tests",
              status: "in_progress",
            },
          ],
        },
      ],
    });
    frame = renderToString(createElement(KodaView, { state }));
    expect(frame).toContain("plan r2 · Build interaction · Add tests");
    expect(frame).toContain("progress)");
  });

  it("renders Stage acceptance and routes decision and feedback keys", () => {
    const controller = fakeInputController();
    const state = baseState();
    state.threadId = "tui-thread";
    state.activeTurn = {
      localId: 1,
      prompt: "Review",
      status: "running",
      threadId: "tui-thread",
      turnId: turnIdSchema.parse("tui-turn"),
      assistantText: "",
      tools: [],
      notes: [],
      cancelRequested: false,
    };
    state.planAcceptance = {
      callId: toolCallIdSchema.parse("plan-view-call"),
      planId: planIdSchema.parse("plan:tui"),
      planRevision: 4,
      stageId: planStageIdSchema.parse("stage:tui"),
      criteria: ["Regression tests pass."],
      summary: "Ready for review.",
      evidence: [{ kind: "event", sequence: 12 }],
      interaction: "decision",
      feedback: "",
      resolving: false,
    };

    let frame = renderToString(createElement(KodaView, { state }));
    expect(frame).toContain("Stage acceptance required · stage:tui · Plan r4");
    expect(frame).toContain("criterion: Regression tests pass.");
    expect(frame).toContain("evidence: event #12");
    expect(frame).toContain("y accept · n request changes");
    expect(frame).not.toContain(">  ");

    routeTuiInput(controller, state, "y", key(), vi.fn());
    routeTuiInput(controller, state, "n", key(), vi.fn());
    expect(controller.resolvePlanAcceptance).toHaveBeenCalledWith("accepted");
    expect(controller.enterPlanAcceptanceFeedback).toHaveBeenCalledOnce();

    state.planAcceptance.interaction = "feedback";
    state.planAcceptance.feedback = "Add";
    frame = renderToString(createElement(KodaView, { state }));
    expect(frame).toContain("changes> Add");
    routeTuiInput(controller, state, " tests", key(), vi.fn());
    routeTuiInput(controller, state, "", key({ backspace: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ return: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ escape: true }), vi.fn());
    expect(controller.setPlanAcceptanceFeedback).toHaveBeenCalledWith(
      "Add tests",
    );
    expect(controller.setPlanAcceptanceFeedback).toHaveBeenCalledWith("Ad");
    expect(controller.resolvePlanAcceptance).toHaveBeenCalledWith(
      "changes_requested",
    );
    expect(controller.cancelPlanAcceptanceFeedback).toHaveBeenCalledOnce();
  });

  it("routes Plan navigation keys only within the Plan view", () => {
    const controller = fakeInputController();
    const state = baseState();
    state.mode = "plan_view";
    state.planNavigation = {
      threadId: threadIdSchema.parse("tui-thread"),
      rows: ["row"],
      scrollOffset: 0,
      loading: false,
      viewportHeight: 10,
      viewportWidth: 80,
    };
    routeTuiInput(controller, state, "", key({ downArrow: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ pageDown: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ end: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ escape: true }), vi.fn());
    expect(controller.scrollPlan.mock.calls).toEqual([
      ["down"],
      ["page_down"],
      ["end"],
    ]);
    expect(controller.closePlan).toHaveBeenCalledOnce();
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

    state.approval = {
      ...state.approval,
      grantCandidate: {
        kind: "exact_command",
        key: "a".repeat(64),
        summary: "exact command",
        defaultExpiresInSeconds: 900,
        maximumExpiresInSeconds: 3600,
      },
    };
    routeTuiInput(controller, state, "a", key(), vi.fn());
    expect(controller.resolveApproval).toHaveBeenLastCalledWith(
      "approved",
      true,
    );

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

  it("renders and routes thread list and preview modes", () => {
    const controller = fakeInputController();
    const state = baseState();
    routeTuiInput(controller, state, "t", key({ ctrl: true }), vi.fn());
    expect(controller.openThreadBrowser).toHaveBeenCalledOnce();
    const thread = {
      threadId: threadIdSchema.parse("view-thread"),
      logFile: "/state/view-thread.jsonl",
      status: "completed" as const,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:01:00.000Z",
      provider: modelProviderIdSchema.parse("openai"),
      model: "gpt-5.6-terra",
      workspaceRoot: "/workspace",
      approvalMode: "on-request",
      turnCount: 2,
      eventCount: 4,
      lastSequence: 3,
      usage: {
        modelRequests: 2,
        reportedRequests: 2,
        tokens: {
          inputTokens: 10,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 0,
          totalTokens: 15,
        },
      },
      sourceBytes: 100,
      indexedBytes: 100,
      sourceMtimeMs: 1,
    };
    state.mode = "thread_list";
    state.threadBrowser = {
      threads: [thread],
      selectedIndex: 0,
      listScrollOffset: 0,
      viewportHeight: 10,
      loading: false,
    };
    let frame = renderToString(createElement(KodaView, { state }));
    expect(frame).toContain("Recent threads");
    expect(frame).toContain("> view-thread");
    routeTuiInput(controller, state, "", key({ downArrow: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ return: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ escape: true }), vi.fn());
    expect(controller.selectThread).toHaveBeenCalledWith(1);
    expect(controller.previewSelectedThread).toHaveBeenCalledOnce();
    expect(controller.closeThreadBrowserLevel).toHaveBeenCalledOnce();

    state.mode = "thread_preview";
    state.threadBrowser = {
      ...state.threadBrowser,
      preview: {
        source: "list",
        thread,
        events: [],
        entries: [{ id: "history", kind: "assistant", text: "Remembered" }],
        scrollOffset: 0,
        hasEarlier: true,
        hasLater: false,
        hasProjectedEarlier: false,
        hasProjectedLater: false,
      },
    };
    frame = renderToString(createElement(KodaView, { state }));
    expect(frame).toContain("Remembered");
    expect(frame).toContain("Earlier durable events are available");
    routeTuiInput(controller, state, "r", key(), vi.fn());
    expect(controller.resumePreviewedThread).toHaveBeenCalledOnce();
    routeTuiInput(controller, state, "", key({ pageUp: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ home: true }), vi.fn());
    expect(controller.scrollPreview).toHaveBeenCalledWith("page_up");
    expect(controller.scrollPreview).toHaveBeenCalledWith("home");

    state.mode = "thread_search_input";
    const { preview: _preview, ...browserWithoutPreview } = state.threadBrowser;
    state.threadBrowser = {
      ...browserWithoutPreview,
      search: {
        origin: "thread_list",
        input: "parser",
        query: "",
        matches: [],
        selectedIndex: 0,
        scrollOffset: 0,
        loading: false,
        hasMore: false,
      },
    };
    frame = renderToString(createElement(KodaView, { state }));
    expect(frame).toContain("Search durable history");
    expect(frame).toContain("parser");
    routeTuiInput(controller, state, "x", key(), vi.fn());
    routeTuiInput(controller, state, "", key({ return: true }), vi.fn());
    expect(controller.setThreadSearchInput).toHaveBeenCalledWith("parserx");
    expect(controller.submitThreadSearch).toHaveBeenCalledOnce();

    state.mode = "thread_search_results";
    state.threadBrowser = {
      ...state.threadBrowser,
      search: {
        origin: "thread_list",
        input: "parser",
        query: "parser",
        matches: [
          {
            threadId: thread.threadId,
            sequence: 3,
            kind: "assistant_message",
            timestamp: thread.updatedAt,
            snippet: "parser repaired",
            threadUpdatedAt: thread.updatedAt,
            status: "completed",
            provider: "openai",
            model: "gpt-5.6-terra",
            turnCount: 2,
          },
        ],
        selectedIndex: 0,
        scrollOffset: 0,
        loading: false,
        hasMore: false,
      },
    };
    frame = renderToString(createElement(KodaView, { state }));
    expect(frame).toContain("History search");
    expect(frame).toContain("parser repaired");
    routeTuiInput(controller, state, "", key({ downArrow: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ pageDown: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ return: true }), vi.fn());
    expect(controller.selectSearchResult).toHaveBeenCalledWith(1);
    expect(controller.pageSearchResults).toHaveBeenCalledWith(1);
    expect(controller.previewSelectedSearchResult).toHaveBeenCalledOnce();
  });

  it("renders and routes provider and model settings modes", () => {
    const controller = fakeInputController();
    const state = baseState();
    state.providers = [
      ...state.providers,
      {
        id: "deepseek",
        displayName: "DeepSeek",
        credentialEnvironmentVariable: "DEEPSEEK_API_KEY",
        defaultModel: "deepseek-v4-pro",
        configured: false,
      },
    ];
    state.mode = "settings_provider";
    state.runtimeSettings = {
      revision: 1,
      selectedIndex: 1,
      modelInput: "",
      draftModels: {},
      loading: false,
    };

    let frame = renderToString(createElement(KodaView, { state }));
    expect(frame).toContain("Runtime settings · choose provider");
    expect(frame).toContain("missing DEEPSEEK_API_KEY");
    routeTuiInput(controller, state, "", key({ upArrow: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ return: true }), vi.fn());
    routeTuiInput(controller, state, "l", key({ ctrl: true }), vi.fn());
    expect(controller.selectRuntimeSettingsProvider).toHaveBeenCalledWith(-1);
    expect(controller.enterRuntimeSettingsModel).toHaveBeenCalledOnce();
    expect(controller.reloadRuntimeSettings).toHaveBeenCalledOnce();

    state.mode = "settings_model";
    state.runtimeSettings = {
      ...state.runtimeSettings,
      draftProvider: "openai",
      modelInput: "gpt-draft",
    };
    frame = renderToString(createElement(KodaView, { state }));
    expect(frame).toContain("model: gpt-draft");
    routeTuiInput(controller, state, "x", key(), vi.fn());
    routeTuiInput(controller, state, "r", key({ ctrl: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ return: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ escape: true }), vi.fn());
    expect(controller.setRuntimeSettingsModelInput).toHaveBeenCalledWith(
      "gpt-draftx",
    );
    expect(controller.resetRuntimeSettingsModel).toHaveBeenCalledOnce();
    expect(controller.applyRuntimeSettings).toHaveBeenCalledOnce();
    expect(controller.closeRuntimeSettingsLevel).toHaveBeenCalledOnce();
  });

  it("renders and routes artifact list, viewer, and preview entry modes", () => {
    const controller = fakeInputController();
    const state = baseState();
    const sha256 = "d".repeat(64);
    const artifact = artifactReferenceSchema.parse({
      type: "artifact",
      id: `sha256:${sha256}`,
      sha256,
      bytes: 11,
      mediaType: "text/plain; charset=utf-8",
    });
    state.mode = "artifact_list";
    state.artifactNavigation = {
      origin: "chat",
      threadId: threadIdSchema.parse("artifact-view-thread"),
      loading: false,
      viewportHeight: 10,
      viewportWidth: 80,
      list: {
        artifacts: [
          {
            sequence: 7,
            callId: toolCallIdSchema.parse("artifact-view-call"),
            name: "report.txt",
            artifact,
          },
        ],
        selectedIndex: 0,
        scrollOffset: 0,
        currentCursor: null,
        newerCursors: [],
        hasEarlier: false,
      },
    };

    let frame = renderToString(createElement(KodaView, { state }));
    expect(frame).toContain("Thread artifacts · artifact-view-thread");
    expect(frame).toContain("report.txt");
    expect(frame).toContain("sha256:dddddddd…dddddddd");
    routeTuiInput(controller, state, "", key({ downArrow: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ pageUp: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ pageDown: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ home: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ end: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ return: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ escape: true }), vi.fn());
    expect(controller.selectArtifact).toHaveBeenCalledWith(1);
    expect(controller.pageArtifactList).toHaveBeenCalledWith("newer");
    expect(controller.pageArtifactList).toHaveBeenCalledWith("older");
    expect(controller.pageArtifactList).toHaveBeenCalledWith("home");
    expect(controller.pageArtifactList).toHaveBeenCalledWith("end");
    expect(controller.openSelectedArtifact).toHaveBeenCalledOnce();
    expect(controller.closeArtifactLevel).toHaveBeenCalledOnce();

    state.mode = "artifact_view";
    state.artifactNavigation = {
      ...state.artifactNavigation,
      view: {
        page: {
          workspace: "/workspace",
          threadId: threadIdSchema.parse("artifact-view-thread"),
          artifact,
          content: "hello\nworld",
          startByte: 0,
          endByte: 11,
          totalBytes: 11,
          hasEarlier: false,
          hasLater: false,
        },
        rows: ["hello", "world"],
        scrollOffset: 0,
      },
    };
    frame = renderToString(createElement(KodaView, { state }));
    expect(frame).toContain(artifact.id);
    expect(frame).toContain("0–11 / 11 bytes");
    expect(frame).toContain("hello");
    routeTuiInput(controller, state, "", key({ downArrow: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ pageDown: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ end: true }), vi.fn());
    expect(controller.scrollArtifact).toHaveBeenCalledWith("down");
    expect(controller.scrollArtifact).toHaveBeenCalledWith("page_down");
    expect(controller.scrollArtifact).toHaveBeenCalledWith("end");

    state.mode = "thread_preview";
    routeTuiInput(controller, state, "a", key(), vi.fn());
    expect(controller.openPreviewArtifacts).toHaveBeenCalledOnce();
  });

  it("renders and routes context list, detail, instruction, and preview entry modes", () => {
    const controller = fakeInputController();
    const state = baseState();
    const hash = "a".repeat(64);
    const sourceId = `ctxsrc:${"b".repeat(64)}`;
    const request = {
      anchorSequence: 8,
      turnId: turnIdSchema.parse("context-view-turn"),
      step: 1,
      timestamp: "2026-08-27T00:00:00.000Z",
      precise: true as const,
      provider: "openai" as const,
      model: "gpt-5.6-terra",
      estimatedInputTokens: 220,
      inputBudgetTokens: 8_000,
      measuredInputTokens: 210,
      activeItemCount: 1,
      toolCount: 2,
    };
    state.mode = "context_list";
    state.contextNavigation = {
      origin: "chat",
      threadId: threadIdSchema.parse("context-view-thread"),
      loading: false,
      viewportHeight: 10,
      viewportWidth: 80,
      list: {
        requests: [request],
        selectedIndex: 0,
        scrollOffset: 0,
        currentCursor: null,
        newerCursors: [],
        hasEarlier: false,
      },
    };

    let frame = renderToString(createElement(KodaView, { state }));
    expect(frame).toContain("Prepared context · context-view-thread");
    expect(frame).toContain("precise");
    expect(frame).toContain("210 measured");
    routeTuiInput(controller, state, "", key({ downArrow: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ pageUp: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ return: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ escape: true }), vi.fn());
    expect(controller.selectContextRequest).toHaveBeenCalledWith(1);
    expect(controller.pageContextList).toHaveBeenCalledWith("newer");
    expect(controller.openSelectedContext).toHaveBeenCalledOnce();
    expect(controller.closeContextLevel).toHaveBeenCalledOnce();

    state.mode = "context_detail";
    state.contextNavigation = {
      ...state.contextNavigation,
      detail: {
        selectedSourceIndex: 0,
        sourceScrollOffset: 0,
        result: {
          workspace: "/workspace",
          threadId: threadIdSchema.parse("context-view-thread"),
          request,
          turnContext: {
            provider: "openai",
            model: "gpt-5.6-terra",
            workspaceRoot: "/workspace",
            approvalMode: "on-request",
            instructionsSha256: hash,
            repositoryInstructions: [],
          },
          telemetry: {
            step: 1,
            contextWindowTokens: 10_000,
            maxOutputTokens: 1_000,
            safetyMarginTokens: 1_000,
            inputBudgetTokens: 8_000,
            fixedInputTokens: 100,
            rawEstimatedInputTokens: 200,
            estimatedInputTokens: 220,
            calibrationFactor: 1.1,
            activeItemCount: 1,
            activeItemTypes: [{ type: "user_message", count: 1 }],
            activeItemsSha256: hash,
            toolCount: 2,
            toolsSha256: "c".repeat(64),
          },
          reconstruction: {
            activeItemCount: 1,
            activeItemTypes: [{ type: "user_message", count: 1 }],
            activeItemsSha256: hash,
            valid: true,
          },
          instructions: {
            historicalEffectiveSha256: hash,
            currentEffectiveSha256: hash,
            effectiveMatchesHistorical: true,
            sources: [
              {
                kind: "effective",
                sourceId,
                path: "effective",
                scope: ".",
                status: "unchanged",
                historical: { sha256: hash },
                current: { bytes: 6, sha256: hash },
              },
            ],
          },
        },
      },
    };
    frame = renderToString(createElement(KodaView, { state }));
    expect(frame).toContain("Context #8");
    expect(frame).toContain("Current effective instructions exactly match");
    expect(frame).toContain("reconstruction valid");
    routeTuiInput(controller, state, "", key({ downArrow: true }), vi.fn());
    routeTuiInput(controller, state, "", key({ return: true }), vi.fn());
    expect(controller.selectContextInstructionSource).toHaveBeenCalledWith(1);
    expect(controller.openSelectedContextInstruction).toHaveBeenCalledOnce();

    state.mode = "context_instruction_view";
    state.contextNavigation = {
      ...state.contextNavigation,
      instructionView: {
        page: {
          workspace: "/workspace",
          threadId: threadIdSchema.parse("context-view-thread"),
          anchorSequence: 8,
          sourceId,
          path: "effective",
          content: "你好",
          startByte: 0,
          endByte: 6,
          totalBytes: 6,
          hasEarlier: false,
          hasLater: false,
        },
        rows: ["你好"],
        scrollOffset: 0,
      },
    };
    frame = renderToString(createElement(KodaView, { state }));
    expect(frame).toContain("0–6 / 6 UTF-8 bytes");
    expect(frame).toContain("你好");
    routeTuiInput(controller, state, "", key({ pageDown: true }), vi.fn());
    expect(controller.scrollContextInstruction).toHaveBeenCalledWith(
      "page_down",
    );

    state.mode = "thread_preview";
    routeTuiInput(controller, state, "c", key(), vi.fn());
    expect(controller.openPreviewContext).toHaveBeenCalledOnce();
  });
});

describe("koda-chat program", () => {
  it("resolves CLI, environment, workspace, and registry settings in order", () => {
    const providers = [
      {
        id: "openai" as const,
        displayName: "OpenAI",
        credentialEnvironmentVariable: "OPENAI_API_KEY",
        defaultModel: "gpt-default",
        configured: true,
      },
      {
        id: "deepseek" as const,
        displayName: "DeepSeek",
        credentialEnvironmentVariable: "DEEPSEEK_API_KEY",
        defaultModel: "deepseek-default",
        configured: true,
      },
    ];
    const preference = {
      provider: "deepseek" as const,
      model: "deepseek-workspace",
      updatedAt: "2026-08-27T08:00:00.000Z",
    };

    expect(resolveTuiRuntimeSelection({}, {}, preference, providers)).toEqual({
      provider: "deepseek",
      model: "deepseek-workspace",
    });
    expect(
      resolveTuiRuntimeSelection(
        {},
        { KODA_PROVIDER: "openai" },
        preference,
        providers,
      ),
    ).toEqual({ provider: "openai", model: "gpt-default" });
    expect(
      resolveTuiRuntimeSelection(
        { provider: "deepseek" },
        { KODA_PROVIDER: "openai", KODA_MODEL: "environment-model" },
        preference,
        providers,
      ),
    ).toEqual({ provider: "deepseek", model: "environment-model" });
    expect(
      resolveTuiRuntimeSelection(
        { provider: "openai", model: "cli-model" },
        { KODA_PROVIDER: "deepseek", KODA_MODEL: "environment-model" },
        preference,
        providers,
      ),
    ).toEqual({ provider: "openai", model: "cli-model" });
  });

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
    protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    server: { name: "koda-app-server", version: "test" },
    capabilities: {
      threadQueries: true,
      turnStart: true,
      turnResume: true,
      turnCancellation: true,
      interactiveApproval: true,
      durableEventNotifications: true,
      threadEvents: true,
      threadSearch: true,
      bidirectionalThreadEvents: true,
      runtimeSettings: true,
      artifactInspection: true,
      contextInspection: true,
      multiFileChanges: true,
      patchDocuments: true,
      approvalGrants: true,
      planning: true,
      planCheckpoints: true,
      stageAcceptance: true,
    },
    providers: [
      {
        id: "openai",
        displayName: "OpenAI",
        credentialEnvironmentVariable: "OPENAI_API_KEY",
        defaultModel: "gpt-5.6-terra",
        configured: true,
      },
    ],
  });
  return {
    connection: "ready",
    mode: "chat",
    configuration: {
      cwd: "/workspace",
      provider: modelProviderIdSchema.parse("openai"),
      model: "gpt-5.6-terra",
      approvalMode: "on-request",
    },
    nextThreadConfiguration: {
      provider: modelProviderIdSchema.parse("openai"),
      model: "gpt-5.6-terra",
    },
    providers: initialization.providers,
    threadId: undefined,
    transcript: [],
    activeTurn: undefined,
    approval: undefined,
    planAcceptance: undefined,
    currentPlan: undefined,
    currentPlanCheckpoint: undefined,
    planNeedsRevalidation: false,
    input: "",
    notice: undefined,
    threadBrowser: undefined,
    runtimeSettings: undefined,
    artifactNavigation: undefined,
    contextNavigation: undefined,
    planNavigation: undefined,
  };
}

function fakeInputController() {
  return {
    setInput: vi.fn(),
    submitInput: vi.fn(() => Promise.resolve("handled" as const)),
    cancelActiveTurn: vi.fn(() => Promise.resolve()),
    resolveApproval: vi.fn(() => Promise.resolve()),
    toggleApprovalDetails: vi.fn(),
    openThreadBrowser: vi.fn(() => Promise.resolve()),
    selectThread: vi.fn(),
    pageThreadList: vi.fn(),
    previewSelectedThread: vi.fn(() => Promise.resolve()),
    enterThreadSearch: vi.fn(),
    setThreadSearchInput: vi.fn(),
    submitThreadSearch: vi.fn(() => Promise.resolve()),
    selectSearchResult: vi.fn(),
    pageSearchResults: vi.fn(() => Promise.resolve()),
    previewSelectedSearchResult: vi.fn(() => Promise.resolve()),
    scrollPreview: vi.fn(() => Promise.resolve()),
    closeThreadBrowserLevel: vi.fn(),
    resumePreviewedThread: vi.fn(() => Promise.resolve()),
    setViewportHeight: vi.fn(),
    openRuntimeSettings: vi.fn(() => Promise.resolve()),
    selectRuntimeSettingsProvider: vi.fn(),
    enterRuntimeSettingsModel: vi.fn(),
    setRuntimeSettingsModelInput: vi.fn(),
    resetRuntimeSettingsModel: vi.fn(),
    applyRuntimeSettings: vi.fn(() => Promise.resolve()),
    reloadRuntimeSettings: vi.fn(() => Promise.resolve()),
    closeRuntimeSettingsLevel: vi.fn(),
    openPreviewArtifacts: vi.fn(() => Promise.resolve()),
    selectArtifact: vi.fn(),
    pageArtifactList: vi.fn(() => Promise.resolve()),
    openSelectedArtifact: vi.fn(() => Promise.resolve()),
    scrollArtifact: vi.fn(() => Promise.resolve()),
    closeArtifactLevel: vi.fn(),
    openPreviewContext: vi.fn(() => Promise.resolve()),
    selectContextRequest: vi.fn(),
    pageContextList: vi.fn(() => Promise.resolve()),
    openSelectedContext: vi.fn(() => Promise.resolve()),
    selectContextInstructionSource: vi.fn(),
    openSelectedContextInstruction: vi.fn(() => Promise.resolve()),
    scrollContextInstruction: vi.fn(() => Promise.resolve()),
    closeContextLevel: vi.fn(),
    openCurrentPlan: vi.fn(() => Promise.resolve()),
    scrollPlan: vi.fn(),
    closePlan: vi.fn(),
    enterPlanAcceptanceFeedback: vi.fn(),
    setPlanAcceptanceFeedback: vi.fn(),
    cancelPlanAcceptanceFeedback: vi.fn(),
    resolvePlanAcceptance: vi.fn(() => Promise.resolve()),
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
