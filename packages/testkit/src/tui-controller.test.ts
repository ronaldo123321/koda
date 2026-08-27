import type {
  AppServerClientApi,
  AppServerNotification,
} from "@koda/app-server-client-node";
import {
  APP_SERVER_PROTOCOL_VERSION,
  agentEventSchema,
  artifactReferenceSchema,
  initializeResultSchema,
  threadIdSchema,
  threadMetadataSchema,
  toolCallIdSchema,
  turnFinishedNotificationParamsSchema,
  turnIdSchema,
  type ApprovalResolveParams,
  type ApprovalResolveResult,
  type ApprovalGrantsListParams,
  type ApprovalGrantsListResult,
  type ApprovalGrantsRevokeAllParams,
  type ApprovalGrantsRevokeAllResult,
  type ApprovalGrantsRevokeParams,
  type ApprovalGrantsRevokeResult,
  type ArtifactReadParams,
  type ArtifactReadResult,
  type ContextInstructionReadParams,
  type ContextInstructionReadResult,
  type ContextReadParams,
  type ContextReadResult,
  type InitializeResult,
  type SettingsGetParams,
  type SettingsGetResult,
  type SettingsUpdateParams,
  type SettingsUpdateResult,
  type ThreadGetParams,
  type ThreadGetResult,
  type ThreadArtifactsParams,
  type ThreadArtifactsResult,
  type ThreadContextParams,
  type ThreadContextResult,
  type ThreadEventsParams,
  type ThreadEventsResult,
  type ThreadListParams,
  type ThreadListResult,
  type ThreadSearchParams,
  type ThreadSearchResult,
  type TurnCancelParams,
  type TurnCancelResult,
  type TurnStartParams,
  type TurnStartResult,
} from "@koda/protocol";
import { TuiController, projectThreadHistory } from "@koda/tui";
import { describe, expect, it } from "vitest";

describe("TuiController", () => {
  it("edits and applies workspace runtime settings for a new thread", async () => {
    const client = new FakeAppServerClient();
    const controller = createController(client);

    controller.setInput("/settings");
    await controller.submitInput();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "settings_provider",
      runtimeSettings: { revision: 0, selectedIndex: 0, loading: false },
    });
    controller.selectRuntimeSettingsProvider(1);
    controller.selectRuntimeSettingsProvider(1);
    controller.enterRuntimeSettingsModel();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "settings_model",
      runtimeSettings: {
        draftProvider: "deepseek",
        modelInput: "deepseek-v4-pro",
      },
    });
    controller.setRuntimeSettingsModelInput("deepseek-chat");
    await controller.applyRuntimeSettings();

    expect(client.settingsUpdateRequests).toEqual([
      {
        workspace: "/workspace",
        provider: "deepseek",
        model: "deepseek-chat",
        expectedRevision: 0,
      },
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      mode: "chat",
      configuration: { provider: "deepseek", model: "deepseek-chat" },
      nextThreadConfiguration: {
        provider: "deepseek",
        model: "deepseek-chat",
      },
      runtimeSettings: undefined,
    });
  });

  it("keeps the current thread configuration until /new adopts saved settings", async () => {
    const client = new FakeAppServerClient();
    const controller = createController(client);
    await controller.startPrompt("Create the current thread");
    client.finish("completed");

    controller.setInput("/settings");
    await controller.submitInput();
    controller.selectRuntimeSettingsProvider(1);
    controller.selectRuntimeSettingsProvider(1);
    controller.enterRuntimeSettingsModel();
    controller.setRuntimeSettingsModelInput("deepseek-next");
    await controller.applyRuntimeSettings();
    expect(controller.getSnapshot()).toMatchObject({
      threadId: "tui-thread",
      configuration: { provider: "openai", model: "gpt-5.6-terra" },
      nextThreadConfiguration: {
        provider: "deepseek",
        model: "deepseek-next",
      },
    });
    expect(controller.getSnapshot().notice).toContain("run /new");

    controller.setInput("/new");
    await controller.submitInput();
    expect(controller.getSnapshot()).toMatchObject({
      threadId: undefined,
      configuration: { provider: "deepseek", model: "deepseek-next" },
    });
  });

  it("blocks unavailable providers and preserves a conflicting settings draft", async () => {
    const client = new FakeAppServerClient();
    const deepseek = client.initialization.providers.find(
      (provider) => provider.id === "deepseek",
    );
    if (deepseek === undefined) {
      throw new Error("DeepSeek fixture metadata is unavailable.");
    }
    deepseek.configured = false;
    const unavailableController = createController(client, {
      provider: "deepseek",
    });
    await unavailableController.startPrompt("Must stay local");
    expect(client.startRequests).toEqual([]);
    expect(unavailableController.getSnapshot().notice).toContain(
      "DEEPSEEK_API_KEY",
    );
    const controller = createController(client);
    await controller.openRuntimeSettings();
    controller.selectRuntimeSettingsProvider(1);
    controller.selectRuntimeSettingsProvider(1);
    controller.enterRuntimeSettingsModel();
    expect(controller.getSnapshot().mode).toBe("settings_provider");
    expect(controller.getSnapshot().notice).toContain("DEEPSEEK_API_KEY");

    controller.selectRuntimeSettingsProvider(-1);
    controller.selectRuntimeSettingsProvider(-1);
    controller.enterRuntimeSettingsModel();
    controller.setRuntimeSettingsModelInput("gpt-draft");
    client.settingsUpdateImplementation = () =>
      Promise.reject(
        Object.assign(new Error("revision conflict"), {
          dataCode: "SETTINGS_CHANGED",
        }),
      );
    await controller.applyRuntimeSettings();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "settings_model",
      runtimeSettings: { modelInput: "gpt-draft", loading: false },
    });
    expect(controller.getSnapshot().notice).toContain("Ctrl+L");

    client.settingsGetResult = {
      workspace: "/workspace",
      revision: 2,
      preference: {
        provider: "openai",
        model: "gpt-other-client",
        updatedAt: "2026-08-27T08:01:00.000Z",
      },
      diagnostics: [],
    };
    await controller.reloadRuntimeSettings();
    expect(controller.getSnapshot().runtimeSettings).toMatchObject({
      revision: 2,
      modelInput: "gpt-draft",
    });
    controller.closeRuntimeSettingsLevel();
    expect(controller.getSnapshot().mode).toBe("settings_provider");
    controller.closeRuntimeSettingsLevel();
    expect(controller.getSnapshot().mode).toBe("chat");
  });

  it("ignores a late settings response after Escape closes the panel", async () => {
    const client = new FakeAppServerClient();
    let release: ((result: SettingsGetResult) => void) | undefined;
    client.settingsGetImplementation = () =>
      new Promise<SettingsGetResult>((resolve) => {
        release = resolve;
      });
    const controller = createController(client);

    const opening = controller.openRuntimeSettings();
    expect(controller.getSnapshot().mode).toBe("settings_provider");
    controller.closeRuntimeSettingsLevel();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "chat",
      runtimeSettings: undefined,
    });
    release?.({
      workspace: "/workspace",
      revision: 4,
      preference: {
        provider: "openai",
        model: "late-model",
        updatedAt: "2026-08-27T08:00:00.000Z",
      },
      diagnostics: [],
    });
    await opening;
    expect(controller.getSnapshot()).toMatchObject({
      mode: "chat",
      runtimeSettings: undefined,
      nextThreadConfiguration: {
        provider: "openai",
        model: "gpt-5.6-terra",
      },
    });
  });

  it("uses provider metadata and handles local commands without server mutation", async () => {
    const client = new FakeAppServerClient();
    client.diagnosticText = "fixture diagnostic";
    const controller = createController(client, { provider: "deepseek" });

    expect(controller.getSnapshot().configuration).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      approvalMode: "on-request",
    });
    controller.setInput("/status");
    await expect(controller.submitInput()).resolves.toBe("handled");
    expect(controller.getSnapshot().transcript.at(-1)?.text).toContain(
      "diagnostics: fixture diagnostic",
    );
    controller.setInput("/help");
    await controller.submitInput();
    expect(controller.getSnapshot().transcript.at(-1)?.text).toContain(
      "/clear",
    );
    controller.setInput("/clear");
    await controller.submitInput();
    expect(controller.getSnapshot()).toMatchObject({
      transcript: [],
      notice: "Display history cleared.",
    });
    controller.setInput("/exit");
    await expect(controller.submitInput()).resolves.toBe("exit");
    expect(client.startRequests).toEqual([]);
  });

  it("reduces early streaming events and carries the thread into later turns", async () => {
    const client = new FakeAppServerClient();
    const controller = createController(client);
    client.beforeStartResult = () => {
      client.emitEvent("assistant.delta", { text: "Hello " });
      client.emitEvent("assistant.delta", { text: "from Koda." });
    };

    await controller.startPrompt("First task");
    expect(controller.getSnapshot().activeTurn).toMatchObject({
      status: "running",
      assistantText: "Hello from Koda.",
      turnId: "tui-turn-1",
    });
    client.emitEvent("tool.started", {
      callId: toolCallIdSchema.parse("tui-call-1"),
      name: "read_file",
    });
    client.emitEvent("tool.completed", {
      callId: toolCallIdSchema.parse("tui-call-1"),
      name: "read_file",
      status: "success",
    });
    client.emitEvent("model.usage", {
      step: 1,
      usage: {
        inputTokens: 12,
        cachedInputTokens: 2,
        cacheWriteInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 1,
        totalTokens: 17,
      },
    });
    client.finish("completed");

    expect(controller.getSnapshot()).toMatchObject({
      threadId: "tui-thread",
      activeTurn: undefined,
    });
    expect(
      controller
        .getSnapshot()
        .transcript.map((entry) => [entry.kind, entry.text]),
    ).toEqual(
      expect.arrayContaining([
        ["user", "First task"],
        ["assistant", "Hello from Koda."],
        ["tool", "read_file: success"],
        [
          "usage",
          "tokens: 12 input, 5 output (1 reasoning), 17 total; 1/1 requests reported",
        ],
      ]),
    );

    client.beforeStartResult = undefined;
    await controller.startPrompt("Second task");
    expect(client.startRequests[1]).toMatchObject({
      prompt: "Second task",
      resumeThreadId: "tui-thread",
    });
  });

  it("locks input during approval and sends only one-shot decisions", async () => {
    const client = new FakeAppServerClient();
    const controller = createController(client);
    await controller.startPrompt("Apply the patch");
    client.emitEvent("tool.started", {
      callId: toolCallIdSchema.parse("approval-call"),
      name: "apply_patch",
    });
    client.emitEvent("approval.requested", {
      callId: toolCallIdSchema.parse("approval-call"),
      name: "apply_patch",
      title: "Patch README",
      summary: "Replace one line",
      details: "x".repeat(9_000),
      reason: "workspace write",
    });

    controller.setInput("must not be accepted");
    expect(controller.getSnapshot().input).toBe("");
    controller.toggleApprovalDetails();
    expect(controller.getSnapshot().approval).toMatchObject({
      detailsVisible: true,
      resolving: false,
    });
    expect(controller.getSnapshot().approval?.details).toHaveLength(9_000);
    await controller.resolveApproval("approved");
    expect(client.approvalRequests).toEqual([
      expect.objectContaining({
        turnId: "tui-turn-1",
        callId: "approval-call",
        decision: "approved",
      }),
    ]);
    expect(controller.getSnapshot().approval?.resolving).toBe(true);
    client.emitEvent("approval.resolved", {
      callId: toolCallIdSchema.parse("approval-call"),
      decision: "approved",
      reason: "Approved by test.",
    });
    expect(controller.getSnapshot().approval).toBeUndefined();
    expect(controller.getSnapshot().activeTurn?.tools[0]).toMatchObject({
      status: "approved",
    });
  });

  it("creates a default 15-minute exact-command grant and manages grants", async () => {
    const client = new FakeAppServerClient();
    const controller = createController(client);
    await controller.startPrompt("Run tests");
    const callId = toolCallIdSchema.parse("approval-grant-call");
    client.emitEvent("tool.started", { callId, name: "exec_command" });
    client.emitEvent("approval.requested", {
      callId,
      name: "exec_command",
      title: 'Run "pnpm"',
      summary: "Run tests",
      details: 'argv: ["pnpm","test"]',
      reason: "process execution",
      grantCandidate: {
        kind: "exact_command",
        key: "a".repeat(64),
        summary: 'argv: ["pnpm","test"]',
        defaultExpiresInSeconds: 900,
        maximumExpiresInSeconds: 3600,
      },
    });

    await controller.resolveApproval("approved", true);
    expect(client.approvalRequests).toEqual([
      expect.objectContaining({
        callId: "approval-grant-call",
        decision: "approved",
        grant: { expiresInSeconds: 900 },
      }),
    ]);

    const idleClient = new FakeAppServerClient();
    const idleController = createController(idleClient);
    idleController.setInput("/approvals");
    await idleController.submitInput();
    idleController.setInput("/approvals revoke grant:test-1");
    await idleController.submitInput();
    idleController.setInput("/approvals clear");
    await idleController.submitInput();
    expect(idleClient.approvalGrantListRequests).toEqual([
      { workspace: "/workspace" },
    ]);
    expect(idleClient.approvalGrantRevokeRequests).toEqual([
      { workspace: "/workspace", grantId: "grant:test-1" },
    ]);
    expect(idleClient.approvalGrantRevokeAllRequests).toEqual([
      { workspace: "/workspace" },
    ]);
    expect(
      idleController
        .getSnapshot()
        .transcript.map((entry) => entry.text)
        .join("\n"),
    ).toContain("No active session command approval grants.");
  });

  it("projects change-set commit and uncertainty evidence into tool status", async () => {
    const client = new FakeAppServerClient();
    const controller = createController(client);
    await controller.startPrompt("Apply coordinated changes");
    const callId = toolCallIdSchema.parse("change-set-status-call");
    client.emitEvent("tool.started", { callId, name: "apply_changes" });
    client.emitEvent("tool.execution_started", {
      callId,
      name: "apply_changes",
      effect: "write",
    });
    client.emitEvent("workspace.change_set_prepared", {
      callId,
      name: "apply_changes",
      planSha256: "a".repeat(64),
      changes: [
        {
          index: 0,
          operation: "create",
          path: "new.txt",
          beforeSha256: null,
          afterSha256: "b".repeat(64),
          bytes: 4,
        },
      ],
    });
    expect(controller.getSnapshot().activeTurn?.tools[0]).toMatchObject({
      status: "running",
      detail: "1 changes prepared",
    });
    client.emitEvent("workspace.change_set_committed", {
      callId,
      name: "apply_changes",
      planSha256: "a".repeat(64),
      changeCount: 1,
    });
    expect(controller.getSnapshot().activeTurn?.tools[0]).toMatchObject({
      status: "success",
      detail: "1 changes committed",
    });
    client.emitEvent("workspace.change_set_uncertain", {
      callId,
      name: "apply_changes",
      planSha256: "a".repeat(64),
      appliedCount: 1,
      uncertainPaths: ["new.txt"],
      errorCode: "WORKSPACE_CHANGED",
    });
    expect(controller.getSnapshot().activeTurn?.tools[0]).toMatchObject({
      status: "error",
      detail: "uncertain: new.txt",
    });
  });

  it("remembers cancellation requested before turn/start responds", async () => {
    const client = new FakeAppServerClient();
    const controller = createController(client);
    let release: ((value: TurnStartResult) => void) | undefined;
    client.startImplementation = (params) => {
      client.startRequests.push(params);
      return new Promise<TurnStartResult>((resolve) => {
        release = resolve;
      });
    };

    const starting = controller.startPrompt("Wait");
    await controller.cancelActiveTurn();
    expect(controller.getSnapshot().activeTurn).toMatchObject({
      status: "cancelling",
      cancelRequested: true,
    });
    expect(client.cancelRequests).toEqual([]);
    release?.({
      threadId: threadIdSchema.parse("tui-thread"),
      turnId: turnIdSchema.parse("tui-turn-delayed"),
    });
    await starting;
    expect(client.cancelRequests).toEqual([
      expect.objectContaining({ turnId: "tui-turn-delayed" }),
    ]);
  });

  it("fails closed and clears approval when the child disconnects", async () => {
    const client = new FakeAppServerClient();
    const controller = createController(client);
    await controller.startPrompt("Effectful work");
    client.emitEvent("assistant.delta", { text: "Partial answer." });
    client.emitEvent("approval.requested", {
      callId: toolCallIdSchema.parse("disconnect-call"),
      name: "exec_command",
      title: "Run command",
      summary: "Execute a process",
      details: "command details",
      reason: "execute",
    });

    client.disconnect(new Error("fixture child crashed"));
    expect(controller.getSnapshot()).toMatchObject({
      connection: "error",
      activeTurn: undefined,
      approval: undefined,
    });
    expect(controller.getSnapshot().transcript.at(-1)).toMatchObject({
      kind: "error",
      text: expect.stringContaining("fixture child crashed"),
    });
    expect(controller.getSnapshot().transcript).toContainEqual(
      expect.objectContaining({ kind: "assistant", text: "Partial answer." }),
    );
    expect(client.approvalRequests).toEqual([]);
  });

  it("browses, previews, and resumes a thread with refreshed provider metadata", async () => {
    const client = new FakeAppServerClient();
    const first = threadMetadata(
      "first-thread",
      "completed",
      "openai",
      "gpt-5.6-terra",
    );
    const selected = threadMetadata(
      "selected-thread",
      "interrupted",
      "deepseek",
      "deepseek-v4-pro",
    );
    client.threadListResult = {
      threads: [first, selected],
      diagnostics: [],
    };
    client.threadEventsResult = {
      events: [
        recordedItemEvent(0, "selected-thread", {
          type: "user_message",
          id: "history-user",
          content: "Earlier question",
        }),
        recordedItemEvent(1, "selected-thread", {
          type: "assistant_message",
          id: "history-assistant",
          content: "Earlier answer",
        }),
      ],
      hasEarlier: false,
      hasLater: false,
    };
    client.threadGetResult = { thread: selected, diagnostics: [] };
    const controller = createController(client);

    await controller.openThreadBrowser();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "thread_list",
      threadBrowser: { selectedIndex: 0 },
    });
    controller.selectThread(1);
    await controller.previewSelectedThread();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "thread_preview",
      threadBrowser: {
        preview: { thread: { threadId: "selected-thread" } },
      },
    });
    expect(client.threadEventRequests).toEqual([
      { threadId: "selected-thread", limit: 200 },
    ]);

    await controller.resumePreviewedThread();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "chat",
      threadId: "selected-thread",
      configuration: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
      },
      nextThreadConfiguration: {
        provider: "openai",
        model: "gpt-5.6-terra",
      },
      threadBrowser: undefined,
    });
    expect(client.threadGetRequests).toEqual([{ threadId: "selected-thread" }]);
    expect(
      controller.getSnapshot().transcript.map((entry) => entry.text),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Resumed thread selected-thread"),
        "Earlier question",
        "Earlier answer",
      ]),
    );
  });

  it("keeps the active thread when browsing or resume validation fails", async () => {
    const client = new FakeAppServerClient();
    const invalid = threadMetadata(
      "invalid-thread",
      "invalid",
      "openai",
      "gpt-5.6-terra",
    );
    client.threadListResult = { threads: [invalid], diagnostics: [] };
    client.threadEventsResult = {
      events: [],
      hasEarlier: false,
      hasLater: false,
    };
    const controller = createController(client);
    await controller.startPrompt("Create current thread");
    client.finish("completed");

    await controller.openThreadBrowser();
    await controller.previewSelectedThread();
    await controller.resumePreviewedThread();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "thread_preview",
      threadId: "tui-thread",
      notice: "Invalid threads cannot be resumed.",
    });
    expect(client.threadGetRequests).toEqual([]);

    controller.closeThreadBrowserLevel();
    controller.closeThreadBrowserLevel();
    controller.setInput("/new");
    await controller.submitInput();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "chat",
      threadId: undefined,
      configuration: { provider: "openai", model: "gpt-5.6-terra" },
    });
  });

  it("preserves chat state across list, preview, and workspace validation failures", async () => {
    const client = new FakeAppServerClient();
    const selected = threadMetadata(
      "failure-thread",
      "completed",
      "openai",
      "gpt-5.6-terra",
    );
    const controller = createController(client);
    await controller.startPrompt("Keep this thread");
    client.finish("completed");

    client.threadListError = new Error("list unavailable");
    await controller.openThreadBrowser();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "chat",
      threadId: "tui-thread",
      notice: expect.stringContaining("list unavailable"),
    });

    client.threadListError = undefined;
    client.threadListResult = { threads: [selected], diagnostics: [] };
    await controller.openThreadBrowser();
    client.threadEventsError = new Error("history unavailable");
    await controller.previewSelectedThread();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "thread_list",
      threadId: "tui-thread",
      notice: expect.stringContaining("history unavailable"),
    });

    client.threadEventsError = undefined;
    await controller.previewSelectedThread();
    client.threadGetResult = {
      thread: { ...selected, workspaceRoot: "/different-workspace" },
      diagnostics: [],
    };
    await controller.resumePreviewedThread();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "thread_preview",
      threadId: "tui-thread",
      configuration: { provider: "openai", model: "gpt-5.6-terra" },
      notice: expect.stringContaining("does not match"),
    });
  });

  it("does not browse while a turn is active", async () => {
    const client = new FakeAppServerClient();
    const controller = createController(client);
    await controller.startPrompt("Still running");

    await controller.openThreadBrowser();

    expect(client.threadListRequests).toEqual([]);
    expect(controller.getSnapshot()).toMatchObject({
      mode: "chat",
      activeTurn: { status: "running" },
      notice: "Thread browsing is available only while idle.",
    });
  });

  it("searches workspace history, opens an authoritative match, and returns by layer", async () => {
    const client = new FakeAppServerClient();
    const selected = threadMetadata(
      "search-thread",
      "completed",
      "openai",
      "gpt-5.6-terra",
    );
    const match = searchMatch(
      "search-thread",
      1,
      "assistant_message",
      "Parser repaired",
    );
    client.threadSearchResult = {
      matches: [match],
      revision: 4,
      hasMore: false,
      diagnostics: [],
    };
    client.threadGetResult = { thread: selected, diagnostics: [] };
    client.threadEventsImplementation = (params) => {
      if (params.beforeSequence !== undefined) {
        return Promise.resolve({
          events: [
            recordedItemEvent(0, "search-thread", {
              type: "user_message",
              id: "search-context-user",
              content: "Repair the parser",
            }),
            recordedItemEvent(1, "search-thread", {
              type: "assistant_message",
              id: "search-context-assistant",
              content: "Parser repaired",
            }),
          ],
          hasEarlier: false,
          hasLater: true,
          nextAfterSequence: 1,
        });
      }
      return Promise.resolve({
        events: [
          recordedItemEvent(2, "search-thread", {
            type: "user_message",
            id: "search-context-next",
            content: "Run the tests",
          }),
        ],
        hasEarlier: true,
        hasLater: false,
        nextBeforeSequence: 2,
      });
    };
    const controller = createController(client);

    controller.setInput("/search parser repaired");
    await controller.submitInput();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "thread_search_results",
      threadBrowser: {
        search: {
          query: "parser repaired",
          selectedIndex: 0,
          matches: [{ threadId: "search-thread", sequence: 1 }],
        },
      },
    });
    expect(client.threadSearchRequests).toEqual([
      {
        workspace: "/workspace",
        query: "parser repaired",
        limit: 100,
      },
    ]);

    await controller.previewSelectedSearchResult();
    expect(client.threadEventRequests).toEqual([
      { threadId: "search-thread", beforeSequence: 2, limit: 200 },
      { threadId: "search-thread", afterSequence: 1, limit: 200 },
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      mode: "thread_preview",
      threadBrowser: {
        preview: {
          source: "search_results",
          match: { sequence: 1 },
        },
      },
    });
    expect(
      controller
        .getSnapshot()
        .threadBrowser?.preview?.entries.find((entry) => entry.matched),
    ).toMatchObject({ text: "Parser repaired", sequence: 1 });

    controller.closeThreadBrowserLevel();
    expect(controller.getSnapshot().mode).toBe("thread_search_results");
    controller.closeThreadBrowserLevel();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "chat",
      threadBrowser: undefined,
    });
  });

  it("loads older history to Home and restores the latest window with End", async () => {
    const client = new FakeAppServerClient();
    const selected = threadMetadata(
      "paged-thread",
      "completed",
      "openai",
      "gpt-5.6-terra",
    );
    client.threadListResult = { threads: [selected], diagnostics: [] };
    const latest: ThreadEventsResult = {
      events: [
        recordedItemEvent(2, "paged-thread", {
          type: "assistant_message",
          id: "paged-two",
          content: "newer two",
        }),
        recordedItemEvent(3, "paged-thread", {
          type: "assistant_message",
          id: "paged-three",
          content: "newest three",
        }),
      ],
      hasEarlier: true,
      hasLater: false,
      nextBeforeSequence: 2,
    };
    client.threadEventsImplementation = (params) =>
      params.beforeSequence === undefined
        ? Promise.resolve(latest)
        : Promise.resolve({
            events: [
              recordedItemEvent(0, "paged-thread", {
                type: "user_message",
                id: "paged-zero",
                content: "oldest zero",
              }),
              recordedItemEvent(1, "paged-thread", {
                type: "assistant_message",
                id: "paged-one",
                content: "older one",
              }),
            ],
            hasEarlier: false,
            hasLater: true,
            nextAfterSequence: 1,
          });
    const controller = createController(client);

    await controller.openThreadBrowser();
    await controller.previewSelectedThread();
    await controller.scrollPreview("home");
    expect(
      controller.getSnapshot().threadBrowser?.preview?.entries[0],
    ).toMatchObject({ text: "oldest zero", sequence: 0 });
    expect(controller.getSnapshot().threadBrowser?.preview).toMatchObject({
      hasEarlier: false,
      hasLater: false,
      scrollOffset: 0,
    });

    await controller.scrollPreview("end");
    expect(
      controller.getSnapshot().threadBrowser?.preview?.entries.at(-1),
    ).toMatchObject({ text: "newest three", sequence: 3 });
    expect(client.threadEventRequests).toEqual([
      { threadId: "paged-thread", limit: 200 },
      { threadId: "paged-thread", beforeSequence: 2, limit: 200 },
      { threadId: "paged-thread", limit: 200 },
    ]);
  });

  it("ignores a search response after Escape invalidates its UI generation", async () => {
    const client = new FakeAppServerClient();
    let release: ((result: ThreadSearchResult) => void) | undefined;
    client.threadSearchImplementation = () =>
      new Promise<ThreadSearchResult>((resolve) => {
        release = resolve;
      });
    const controller = createController(client);
    controller.setInput("/search delayed");
    const pending = controller.submitInput();
    await Promise.resolve();
    expect(controller.getSnapshot().mode).toBe("thread_search_results");

    controller.closeThreadBrowserLevel();
    expect(controller.getSnapshot().mode).toBe("chat");
    release?.({
      matches: [
        searchMatch("late-thread", 1, "assistant_message", "late result"),
      ],
      revision: 1,
      hasMore: false,
      diagnostics: [],
    });
    await pending;
    expect(controller.getSnapshot()).toMatchObject({
      mode: "chat",
      threadBrowser: undefined,
    });
  });

  it("browses a current thread's artifacts and pages UTF-8 byte ranges by layer", async () => {
    const client = new FakeAppServerClient();
    const artifact = textArtifact("a", 8);
    client.threadArtifactsResult = {
      workspace: "/workspace",
      threadId: threadIdSchema.parse("tui-thread"),
      artifacts: [artifactDescriptor(12, artifact)],
      hasEarlier: false,
    };
    client.artifactReadImplementation = (params) => {
      if (params.afterByte === 6) {
        return Promise.resolve(artifactPage(artifact, "ok", 6, 8));
      }
      return Promise.resolve(artifactPage(artifact, "你好", 0, 6));
    };
    const controller = createController(client);
    await controller.startPrompt("Create artifact thread");
    client.finish("completed");

    controller.setInput("/artifacts");
    await controller.submitInput();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "artifact_list",
      artifactNavigation: {
        origin: "chat",
        threadId: "tui-thread",
        list: { selectedIndex: 0, artifacts: [{ sequence: 12 }] },
      },
    });
    expect(client.threadArtifactRequests).toEqual([
      { workspace: "/workspace", threadId: "tui-thread" },
    ]);

    await controller.openSelectedArtifact();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "artifact_view",
      artifactNavigation: {
        view: {
          page: { content: "你好", startByte: 0, endByte: 6 },
        },
      },
    });
    await controller.scrollArtifact("page_down");
    expect(
      controller.getSnapshot().artifactNavigation?.view?.page,
    ).toMatchObject({ content: "ok", startByte: 6, endByte: 8 });
    await controller.scrollArtifact("page_up");
    expect(
      controller.getSnapshot().artifactNavigation?.view?.page,
    ).toMatchObject({ content: "你好", startByte: 0, endByte: 6 });
    expect(client.artifactReadRequests).toEqual([
      expect.objectContaining({ artifactId: artifact.id, maxBytes: 16_384 }),
      expect.objectContaining({
        artifactId: artifact.id,
        afterByte: 6,
        maxBytes: 16_384,
      }),
      expect.objectContaining({
        artifactId: artifact.id,
        beforeByte: 6,
        maxBytes: 16_384,
      }),
    ]);

    controller.closeArtifactLevel();
    expect(controller.getSnapshot().mode).toBe("artifact_list");
    controller.closeArtifactLevel();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "chat",
      artifactNavigation: undefined,
      threadId: "tui-thread",
    });
  });

  it("opens direct and preview-scoped artifacts without accepting an invalid ID", async () => {
    const client = new FakeAppServerClient();
    const artifact = textArtifact("b", 2);
    client.artifactReadResult = artifactPage(artifact, "ok", 0, 2);
    const controller = createController(client);
    await controller.startPrompt("Create current thread");
    client.finish("completed");

    controller.setInput("/artifact SHA256:not-valid");
    await controller.submitInput();
    expect(controller.getSnapshot().notice).toContain("64 lowercase");
    expect(client.artifactReadRequests).toEqual([]);

    controller.setInput(`/artifact ${artifact.id}`);
    await controller.submitInput();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "artifact_view",
      artifactNavigation: { origin: "chat", threadId: "tui-thread" },
    });
    controller.closeArtifactLevel();

    const previewed = threadMetadata(
      "preview-artifacts",
      "completed",
      "openai",
      "gpt-5.6-terra",
    );
    client.threadListResult = { threads: [previewed], diagnostics: [] };
    client.threadEventsResult = {
      events: [],
      hasEarlier: false,
      hasLater: false,
    };
    client.threadArtifactsResult = {
      workspace: "/workspace",
      threadId: previewed.threadId,
      artifacts: [artifactDescriptor(4, artifact)],
      hasEarlier: false,
    };
    await controller.openThreadBrowser();
    await controller.previewSelectedThread();
    await controller.openPreviewArtifacts();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "artifact_list",
      artifactNavigation: {
        origin: "thread_preview",
        threadId: "preview-artifacts",
      },
    });
    controller.closeArtifactLevel();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "thread_preview",
      artifactNavigation: undefined,
    });
  });

  it("inspects context, current instructions, and layered Escape without transcript mutation", async () => {
    const client = new FakeAppServerClient();
    const hash = "a".repeat(64);
    const sourceId = `ctxsrc:${"b".repeat(64)}`;
    const request = {
      anchorSequence: 7,
      turnId: turnIdSchema.parse("tui-turn-1"),
      step: 1,
      timestamp: "2026-08-27T00:00:00.000Z",
      precise: true,
      provider: "openai" as const,
      model: "gpt-5.6-terra",
      estimatedInputTokens: 220,
      inputBudgetTokens: 8_000,
      measuredInputTokens: 210,
      activeItemCount: 1,
      toolCount: 2,
    };
    client.threadContextResult = {
      workspace: "/workspace",
      threadId: threadIdSchema.parse("tui-thread"),
      requests: [request],
      hasEarlier: false,
    };
    client.contextReadResult = {
      workspace: "/workspace",
      threadId: threadIdSchema.parse("tui-thread"),
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
            current: { bytes: 8, sha256: hash },
          },
        ],
      },
    };
    client.contextInstructionReadImplementation = (params) =>
      Promise.resolve(
        params.afterByte === 6
          ? {
              workspace: "/workspace",
              threadId: threadIdSchema.parse("tui-thread"),
              anchorSequence: 7,
              sourceId,
              path: "effective",
              content: "ok",
              startByte: 6,
              endByte: 8,
              totalBytes: 8,
              hasEarlier: true,
              hasLater: false,
            }
          : {
              workspace: "/workspace",
              threadId: threadIdSchema.parse("tui-thread"),
              anchorSequence: 7,
              sourceId,
              path: "effective",
              content: "你好",
              startByte: 0,
              endByte: 6,
              totalBytes: 8,
              hasEarlier: false,
              hasLater: true,
            },
      );
    const controller = createController(client);
    await controller.startPrompt("Create context thread");
    client.finish("completed");
    const transcriptLength = controller.getSnapshot().transcript.length;

    controller.setInput("/context");
    await controller.submitInput();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "context_list",
      contextNavigation: {
        origin: "chat",
        list: { requests: [{ anchorSequence: 7 }], selectedIndex: 0 },
      },
    });
    await controller.openSelectedContext();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "context_detail",
      contextNavigation: {
        detail: {
          result: { request: { anchorSequence: 7 } },
          selectedSourceIndex: 0,
        },
      },
    });
    await controller.openSelectedContextInstruction();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "context_instruction_view",
      contextNavigation: {
        instructionView: {
          page: { content: "你好", startByte: 0, endByte: 6 },
        },
      },
    });
    await controller.scrollContextInstruction("page_down");
    expect(
      controller.getSnapshot().contextNavigation?.instructionView?.page,
    ).toMatchObject({ content: "ok", startByte: 6, endByte: 8 });
    expect(client.contextInstructionReadRequests).toEqual([
      expect.objectContaining({ sourceId, maxBytes: 16_384 }),
      expect.objectContaining({ sourceId, afterByte: 6, maxBytes: 16_384 }),
    ]);

    controller.closeContextLevel();
    expect(controller.getSnapshot().mode).toBe("context_detail");
    controller.closeContextLevel();
    expect(controller.getSnapshot().mode).toBe("context_list");
    controller.closeContextLevel();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "chat",
      contextNavigation: undefined,
      threadId: "tui-thread",
    });
    expect(controller.getSnapshot().transcript).toHaveLength(transcriptLength);
  });

  it("ignores a late artifact response after Escape restores the list", async () => {
    const client = new FakeAppServerClient();
    const artifact = textArtifact("c", 2);
    client.threadArtifactsResult = {
      workspace: "/workspace",
      threadId: threadIdSchema.parse("tui-thread"),
      artifacts: [artifactDescriptor(2, artifact)],
      hasEarlier: false,
    };
    let release: ((result: ArtifactReadResult) => void) | undefined;
    client.artifactReadImplementation = () =>
      new Promise<ArtifactReadResult>((resolve) => {
        release = resolve;
      });
    const controller = createController(client);
    await controller.startPrompt("Create artifact thread");
    client.finish("completed");
    await controller.openCurrentThreadArtifacts();

    const opening = controller.openSelectedArtifact();
    await Promise.resolve();
    expect(controller.getSnapshot().mode).toBe("artifact_view");
    controller.closeArtifactLevel();
    expect(controller.getSnapshot().mode).toBe("artifact_list");
    release?.(artifactPage(artifact, "ok", 0, 2));
    await opening;
    expect(controller.getSnapshot().mode).toBe("artifact_list");
    expect(controller.getSnapshot().artifactNavigation?.view).toBeUndefined();
  });

  it("ignores late context detail and preserves preview origin", async () => {
    const client = new FakeAppServerClient();
    const detail = legacyContextResult("tui-thread");
    client.threadContextResult = {
      workspace: "/workspace",
      threadId: threadIdSchema.parse("tui-thread"),
      requests: [detail.request],
      hasEarlier: false,
    };
    let release: ((result: ContextReadResult) => void) | undefined;
    client.contextReadImplementation = () =>
      new Promise<ContextReadResult>((resolve) => {
        release = resolve;
      });
    const controller = createController(client);
    await controller.startPrompt("Create context thread");
    client.finish("completed");
    await controller.openCurrentThreadContext();

    const opening = controller.openSelectedContext();
    await Promise.resolve();
    expect(controller.getSnapshot().mode).toBe("context_detail");
    controller.closeContextLevel();
    expect(controller.getSnapshot().mode).toBe("context_list");
    release?.(detail);
    await opening;
    expect(controller.getSnapshot().mode).toBe("context_list");
    expect(controller.getSnapshot().contextNavigation?.detail).toBeUndefined();
    controller.closeContextLevel();

    const previewed = threadMetadata(
      "preview-context",
      "completed",
      "openai",
      "gpt-5.6-terra",
    );
    client.threadListResult = { threads: [previewed], diagnostics: [] };
    client.threadEventsResult = {
      events: [],
      hasEarlier: false,
      hasLater: false,
    };
    client.threadContextResult = {
      workspace: "/workspace",
      threadId: previewed.threadId,
      requests: [],
      hasEarlier: false,
    };
    await controller.openThreadBrowser();
    await controller.previewSelectedThread();
    await controller.openPreviewContext();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "context_list",
      contextNavigation: {
        origin: "thread_preview",
        threadId: "preview-context",
      },
    });
    controller.closeContextLevel();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "thread_preview",
      contextNavigation: undefined,
    });
  });

  it("keeps a query when a revision-bound search continuation expires", async () => {
    const client = new FakeAppServerClient();
    const matches = Array.from({ length: 100 }, (_, index) =>
      searchMatch(
        "revision-thread",
        199 - index,
        "assistant_message",
        `result ${index}`,
      ),
    );
    const last = matches.at(-1);
    if (last === undefined) {
      throw new Error("Revision search fixture is empty.");
    }
    client.threadSearchImplementation = (params) => {
      if (params.cursor !== undefined) {
        return Promise.reject(
          Object.assign(new Error("index changed"), {
            dataCode: "THREAD_SEARCH_INDEX_CHANGED",
          }),
        );
      }
      return Promise.resolve({
        matches,
        revision: 9,
        hasMore: true,
        nextCursor: {
          revision: 9,
          updatedAt: last.threadUpdatedAt,
          threadId: last.threadId,
          sequence: last.sequence,
        },
        diagnostics: [],
      });
    };
    const controller = createController(client);
    controller.setInput("/search revision");
    await controller.submitInput();
    controller.setViewportHeight(100);
    expect(controller.getSnapshot().threadBrowser?.viewportHeight).toBe(30);
    await controller.pageSearchResults(1);
    await controller.pageSearchResults(1);
    await controller.pageSearchResults(1);
    await controller.pageSearchResults(1);

    expect(client.threadSearchRequests).toHaveLength(2);
    expect(controller.getSnapshot()).toMatchObject({
      mode: "thread_search_results",
      notice: expect.stringContaining("index changed"),
      threadBrowser: {
        search: {
          query: "revision",
          matches: expect.any(Array),
          hasMore: false,
          loading: false,
        },
      },
    });
    expect(
      controller.getSnapshot().threadBrowser?.search?.matches,
    ).toHaveLength(100);
    controller.setViewportHeight(1);
    expect(controller.getSnapshot().threadBrowser?.viewportHeight).toBe(5);
  });

  it("projects durable items without replaying assistant deltas or approvals", () => {
    const events = [
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 0,
        timestamp: "2026-08-27T00:00:00.000Z",
        threadId: "history-thread",
        turnId: "history-turn",
        type: "assistant.delta",
        payload: { text: "duplicate" },
      }),
      recordedItemEvent(1, "history-thread", {
        type: "assistant_message",
        id: "history-message",
        content: "Complete answer",
      }),
      agentEventSchema.parse({
        schemaVersion: 1,
        sequence: 2,
        timestamp: "2026-08-27T00:00:02.000Z",
        threadId: "history-thread",
        turnId: "history-turn",
        type: "approval.requested",
        payload: {
          callId: "history-call",
          name: "apply_patch",
          title: "Patch",
          summary: "summary",
          details: "details",
          reason: "write",
        },
      }),
    ];

    expect(projectThreadHistory(events)).toEqual([
      { kind: "assistant", text: "Complete answer" },
    ]);
  });

  it("bounds restored history by row count and UTF-8 bytes", () => {
    const events = Array.from({ length: 201 }, (_, sequence) =>
      recordedItemEvent(sequence, "bounded-history", {
        type: "assistant_message",
        id: `bounded-message-${sequence}`,
        content: `\u001b[31m\u009b${"界".repeat(4_000)}`,
      }),
    );

    const projected = projectThreadHistory(events);

    expect(projected).toHaveLength(200);
    expect(projected[0]).toEqual({
      kind: "system",
      text: "2 older history row(s) omitted from this preview.",
    });
    expect(
      projected.every(
        (entry) => Buffer.byteLength(entry.text, "utf8") <= 8_192,
      ),
    ).toBe(true);
    expect(projected.some((entry) => entry.text.includes("\u001b"))).toBe(
      false,
    );
    expect(projected.some((entry) => entry.text.includes("\u009b"))).toBe(
      false,
    );
  });
});

class FakeAppServerClient implements AppServerClientApi {
  public readonly initialization: InitializeResult =
    initializeResultSchema.parse({
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
      },
      providers: [
        provider("openai", "OpenAI", "OPENAI_API_KEY", "gpt-5.6-terra"),
        provider(
          "anthropic",
          "Anthropic",
          "ANTHROPIC_API_KEY",
          "claude-sonnet-5",
        ),
        provider("deepseek", "DeepSeek", "DEEPSEEK_API_KEY", "deepseek-v4-pro"),
        provider("kimi", "Kimi", "MOONSHOT_API_KEY", "kimi-k2.6"),
        provider("glm", "GLM", "ZAI_API_KEY", "glm-5.2"),
      ],
    });
  public readonly startRequests: TurnStartParams[] = [];
  public readonly cancelRequests: TurnCancelParams[] = [];
  public readonly approvalRequests: ApprovalResolveParams[] = [];
  public readonly approvalGrantListRequests: ApprovalGrantsListParams[] = [];
  public readonly approvalGrantRevokeRequests: ApprovalGrantsRevokeParams[] =
    [];
  public readonly approvalGrantRevokeAllRequests: ApprovalGrantsRevokeAllParams[] =
    [];
  public readonly threadListRequests: ThreadListParams[] = [];
  public readonly threadGetRequests: ThreadGetParams[] = [];
  public readonly threadEventRequests: ThreadEventsParams[] = [];
  public readonly threadSearchRequests: ThreadSearchParams[] = [];
  public readonly settingsGetRequests: SettingsGetParams[] = [];
  public readonly settingsUpdateRequests: SettingsUpdateParams[] = [];
  public readonly threadArtifactRequests: ThreadArtifactsParams[] = [];
  public readonly artifactReadRequests: ArtifactReadParams[] = [];
  public readonly threadContextRequests: ThreadContextParams[] = [];
  public readonly contextReadRequests: ContextReadParams[] = [];
  public readonly contextInstructionReadRequests: ContextInstructionReadParams[] =
    [];
  public threadListResult: ThreadListResult = { threads: [], diagnostics: [] };
  public threadGetResult: ThreadGetResult | undefined;
  public threadEventsResult: ThreadEventsResult = {
    events: [],
    hasEarlier: false,
    hasLater: false,
  };
  public threadSearchResult: ThreadSearchResult = {
    matches: [],
    revision: 0,
    hasMore: false,
    diagnostics: [],
  };
  public settingsGetResult: SettingsGetResult = {
    workspace: "/workspace",
    revision: 0,
    diagnostics: [],
  };
  public settingsUpdateResult: SettingsUpdateResult | undefined;
  public threadArtifactsResult: ThreadArtifactsResult = {
    workspace: "/workspace",
    threadId: threadIdSchema.parse("tui-thread"),
    artifacts: [],
    hasEarlier: false,
  };
  public artifactReadResult: ArtifactReadResult | undefined;
  public threadContextResult: ThreadContextResult = {
    workspace: "/workspace",
    threadId: threadIdSchema.parse("tui-thread"),
    requests: [],
    hasEarlier: false,
  };
  public contextReadResult: ContextReadResult | undefined;
  public contextInstructionReadResult: ContextInstructionReadResult | undefined;
  public threadListError: Error | undefined;
  public threadEventsError: Error | undefined;
  public threadSearchError: Error | undefined;
  public threadEventsImplementation:
    ((params: ThreadEventsParams) => Promise<ThreadEventsResult>) | undefined;
  public threadSearchImplementation:
    ((params: ThreadSearchParams) => Promise<ThreadSearchResult>) | undefined;
  public settingsGetImplementation:
    ((params: SettingsGetParams) => Promise<SettingsGetResult>) | undefined;
  public settingsUpdateImplementation:
    | ((params: SettingsUpdateParams) => Promise<SettingsUpdateResult>)
    | undefined;
  public artifactReadImplementation:
    ((params: ArtifactReadParams) => Promise<ArtifactReadResult>) | undefined;
  public contextInstructionReadImplementation:
    | ((
        params: ContextInstructionReadParams,
      ) => Promise<ContextInstructionReadResult>)
    | undefined;
  public contextReadImplementation:
    ((params: ContextReadParams) => Promise<ContextReadResult>) | undefined;
  public diagnosticText = "";
  public beforeStartResult: (() => void) | undefined;
  public startImplementation:
    ((params: TurnStartParams) => Promise<TurnStartResult>) | undefined;
  private readonly notificationListeners = new Set<
    (notification: AppServerNotification) => void
  >();
  private readonly disconnectListeners = new Set<(error?: Error) => void>();
  private currentTurnId = turnIdSchema.parse("tui-turn-1");

  public listThreads(params: ThreadListParams = {}): Promise<ThreadListResult> {
    this.threadListRequests.push(params);
    if (this.threadListError !== undefined) {
      return Promise.reject(this.threadListError);
    }
    return Promise.resolve(this.threadListResult);
  }

  public getThread(params: ThreadGetParams): Promise<ThreadGetResult> {
    this.threadGetRequests.push(params);
    if (this.threadGetResult === undefined) {
      return Promise.reject(new Error("Thread fixture is unavailable."));
    }
    return Promise.resolve(this.threadGetResult);
  }

  public readThreadEvents(
    params: ThreadEventsParams,
  ): Promise<ThreadEventsResult> {
    this.threadEventRequests.push(params);
    if (this.threadEventsImplementation !== undefined) {
      return this.threadEventsImplementation(params);
    }
    if (this.threadEventsError !== undefined) {
      return Promise.reject(this.threadEventsError);
    }
    return Promise.resolve(this.threadEventsResult);
  }

  public listThreadArtifacts(
    params: ThreadArtifactsParams,
  ): Promise<ThreadArtifactsResult> {
    this.threadArtifactRequests.push(params);
    return Promise.resolve(this.threadArtifactsResult);
  }

  public readArtifact(params: ArtifactReadParams): Promise<ArtifactReadResult> {
    this.artifactReadRequests.push(params);
    if (this.artifactReadImplementation !== undefined) {
      return this.artifactReadImplementation(params);
    }
    if (this.artifactReadResult === undefined) {
      return Promise.reject(new Error("Artifact fixture is unavailable."));
    }
    return Promise.resolve(this.artifactReadResult);
  }

  public listThreadContexts(
    params: ThreadContextParams,
  ): Promise<ThreadContextResult> {
    this.threadContextRequests.push(params);
    return Promise.resolve(this.threadContextResult);
  }

  public readContext(params: ContextReadParams): Promise<ContextReadResult> {
    this.contextReadRequests.push(params);
    if (this.contextReadImplementation !== undefined) {
      return this.contextReadImplementation(params);
    }
    if (this.contextReadResult === undefined) {
      return Promise.reject(new Error("Context fixture is unavailable."));
    }
    return Promise.resolve(this.contextReadResult);
  }

  public readContextInstruction(
    params: ContextInstructionReadParams,
  ): Promise<ContextInstructionReadResult> {
    this.contextInstructionReadRequests.push(params);
    if (this.contextInstructionReadImplementation !== undefined) {
      return this.contextInstructionReadImplementation(params);
    }
    if (this.contextInstructionReadResult === undefined) {
      return Promise.reject(new Error("Instruction fixture is unavailable."));
    }
    return Promise.resolve(this.contextInstructionReadResult);
  }

  public searchThreads(
    params: ThreadSearchParams,
  ): Promise<ThreadSearchResult> {
    this.threadSearchRequests.push(params);
    if (this.threadSearchImplementation !== undefined) {
      return this.threadSearchImplementation(params);
    }
    if (this.threadSearchError !== undefined) {
      return Promise.reject(this.threadSearchError);
    }
    return Promise.resolve(this.threadSearchResult);
  }

  public getRuntimeSettings(
    params: SettingsGetParams,
  ): Promise<SettingsGetResult> {
    this.settingsGetRequests.push(params);
    return (
      this.settingsGetImplementation?.(params) ??
      Promise.resolve(this.settingsGetResult)
    );
  }

  public updateRuntimeSettings(
    params: SettingsUpdateParams,
  ): Promise<SettingsUpdateResult> {
    this.settingsUpdateRequests.push(params);
    if (this.settingsUpdateImplementation !== undefined) {
      return this.settingsUpdateImplementation(params);
    }
    return Promise.resolve(
      this.settingsUpdateResult ?? {
        workspace: params.workspace,
        revision: params.expectedRevision + 1,
        preference: {
          provider: params.provider,
          model: params.model,
          updatedAt: "2026-08-27T08:00:00.000Z",
        },
        diagnostics: [],
      },
    );
  }

  public startTurn(params: TurnStartParams): Promise<TurnStartResult> {
    if (this.startImplementation !== undefined) {
      return this.startImplementation(params);
    }
    this.startRequests.push(params);
    this.currentTurnId = turnIdSchema.parse(
      `tui-turn-${this.startRequests.length}`,
    );
    this.beforeStartResult?.();
    return Promise.resolve({
      threadId: threadIdSchema.parse("tui-thread"),
      turnId: this.currentTurnId,
    });
  }

  public cancelTurn(params: TurnCancelParams): Promise<TurnCancelResult> {
    this.cancelRequests.push(params);
    return Promise.resolve({ accepted: true });
  }

  public resolveApproval(
    params: ApprovalResolveParams,
  ): Promise<ApprovalResolveResult> {
    this.approvalRequests.push(params);
    return Promise.resolve({ accepted: true });
  }

  public listApprovalGrants(
    params: ApprovalGrantsListParams,
  ): Promise<ApprovalGrantsListResult> {
    this.approvalGrantListRequests.push(params);
    return Promise.resolve({ workspace: params.workspace, grants: [] });
  }

  public revokeApprovalGrant(
    params: ApprovalGrantsRevokeParams,
  ): Promise<ApprovalGrantsRevokeResult> {
    this.approvalGrantRevokeRequests.push(params);
    return Promise.resolve({ revoked: true });
  }

  public revokeAllApprovalGrants(
    params: ApprovalGrantsRevokeAllParams,
  ): Promise<ApprovalGrantsRevokeAllResult> {
    this.approvalGrantRevokeAllRequests.push(params);
    return Promise.resolve({ revokedCount: 0 });
  }

  public onNotification(
    listener: (notification: AppServerNotification) => void,
  ): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  public onDisconnect(listener: (error?: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  public diagnostics(): string {
    return this.diagnosticText;
  }

  public shutdown(): Promise<void> {
    return Promise.resolve();
  }

  public emitEvent(type: string, payload: unknown): void {
    const notification: AppServerNotification = {
      method: "turn/event",
      params: {
        event: agentEventSchema.parse({
          schemaVersion: 1,
          sequence: 1,
          timestamp: "2026-08-26T00:00:00.000Z",
          threadId: threadIdSchema.parse("tui-thread"),
          turnId: this.currentTurnId,
          type,
          payload,
        }),
      },
    };
    this.emit(notification);
  }

  public finish(status: "completed" | "cancelled" | "failed"): void {
    this.emit({
      method: "turn/finished",
      params: turnFinishedNotificationParamsSchema.parse({
        threadId: threadIdSchema.parse("tui-thread"),
        turnId: this.currentTurnId,
        status,
        exitCode: status === "completed" ? 0 : status === "cancelled" ? 130 : 1,
        ...(status === "failed"
          ? { error: { code: "FIXTURE_FAILED", message: "Fixture failed." } }
          : {}),
      }),
    });
  }

  public disconnect(error?: Error): void {
    for (const listener of this.disconnectListeners) {
      listener(error);
    }
  }

  private emit(notification: AppServerNotification): void {
    for (const listener of this.notificationListeners) {
      listener(notification);
    }
  }
}

function threadMetadata(
  threadId: string,
  status: "completed" | "interrupted" | "invalid",
  providerId: "openai" | "deepseek",
  model: string,
) {
  return threadMetadataSchema.parse({
    threadId,
    logFile: `/state/threads/${threadId}.jsonl`,
    status,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:01:00.000Z",
    provider: providerId,
    model,
    workspaceRoot: "/workspace",
    approvalMode: "on-request",
    turnCount: 1,
    eventCount: 2,
    lastSequence: 1,
    usage: {
      modelRequests: 1,
      reportedRequests: 1,
      tokens: {
        inputTokens: 10,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
        totalTokens: 15,
      },
    },
    sourceBytes: 200,
    indexedBytes: 200,
    sourceMtimeMs: 1,
  });
}

function recordedItemEvent(sequence: number, threadId: string, item: unknown) {
  return agentEventSchema.parse({
    schemaVersion: 1,
    sequence,
    timestamp: "2026-08-27T00:00:00.000Z",
    threadId,
    turnId: "history-turn",
    type: "item.recorded",
    payload: { item },
  });
}

function textArtifact(hashCharacter: string, bytes: number) {
  const sha256 = hashCharacter.repeat(64);
  return artifactReferenceSchema.parse({
    type: "artifact",
    id: `sha256:${sha256}`,
    sha256,
    bytes,
    mediaType: "text/plain; charset=utf-8",
  });
}

function artifactDescriptor(
  sequence: number,
  artifact: ReturnType<typeof textArtifact>,
) {
  return {
    sequence,
    callId: toolCallIdSchema.parse(`artifact-call-${sequence}`),
    name: "read_file",
    artifact,
  };
}

function artifactPage(
  artifact: ReturnType<typeof textArtifact>,
  content: string,
  startByte: number,
  endByte: number,
): ArtifactReadResult {
  return {
    workspace: "/workspace",
    threadId: threadIdSchema.parse("tui-thread"),
    artifact,
    content,
    startByte,
    endByte,
    totalBytes: artifact.bytes,
    hasEarlier: startByte > 0,
    hasLater: endByte < artifact.bytes,
  };
}

function legacyContextResult(threadIdInput: string): ContextReadResult {
  const hash = "d".repeat(64);
  const threadId = threadIdSchema.parse(threadIdInput);
  return {
    workspace: "/workspace",
    threadId,
    request: {
      anchorSequence: 4,
      turnId: turnIdSchema.parse("legacy-context-turn"),
      step: 1,
      timestamp: "2026-08-27T00:00:00.000Z",
      precise: false,
      provider: "openai",
      model: "gpt-5.6-terra",
      measuredInputTokens: 10,
    },
    turnContext: {
      provider: "openai",
      model: "gpt-5.6-terra",
      workspaceRoot: "/workspace",
      approvalMode: "on-request",
      instructionsSha256: hash,
      repositoryInstructions: [],
    },
    instructions: {
      historicalEffectiveSha256: hash,
      currentEffectiveSha256: hash,
      effectiveMatchesHistorical: true,
      sources: [
        {
          kind: "effective",
          sourceId: `ctxsrc:${"e".repeat(64)}`,
          path: "effective",
          scope: ".",
          status: "unchanged",
          historical: { sha256: hash },
          current: { bytes: 10, sha256: hash },
        },
      ],
    },
  };
}

function searchMatch(
  threadId: string,
  sequence: number,
  kind:
    | "user_message"
    | "assistant_message"
    | "tool_result"
    | "compaction"
    | "recovery"
    | "tool_failure"
    | "turn_cancelled"
    | "turn_failed",
  snippet: string,
) {
  return {
    threadId: threadIdSchema.parse(threadId),
    sequence,
    kind,
    timestamp: "2026-08-27T00:00:01.000Z",
    snippet,
    threadUpdatedAt: "2026-08-27T00:01:00.000Z",
    status: "completed" as const,
    provider: "openai" as const,
    model: "gpt-5.6-terra",
    turnCount: 1,
  };
}

function createController(
  client: FakeAppServerClient,
  overrides: { provider?: string } = {},
): TuiController {
  return new TuiController(client, {
    cwd: "/workspace",
    provider: overrides.provider ?? "openai",
  });
}

function provider(
  id: string,
  displayName: string,
  credentialEnvironmentVariable: string,
  defaultModel: string,
) {
  return {
    id,
    displayName,
    credentialEnvironmentVariable,
    defaultModel,
    configured: true,
  };
}
