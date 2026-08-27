import type {
  AppServerClientApi,
  AppServerNotification,
} from "@koda/app-server-client-node";
import {
  APP_SERVER_PROTOCOL_VERSION,
  agentEventSchema,
  initializeResultSchema,
  threadIdSchema,
  threadMetadataSchema,
  toolCallIdSchema,
  turnFinishedNotificationParamsSchema,
  turnIdSchema,
  type ApprovalResolveParams,
  type ApprovalResolveResult,
  type InitializeResult,
  type ThreadGetParams,
  type ThreadGetResult,
  type ThreadEventsParams,
  type ThreadEventsResult,
  type ThreadListParams,
  type ThreadListResult,
  type TurnCancelParams,
  type TurnCancelResult,
  type TurnStartParams,
  type TurnStartResult,
} from "@koda/protocol";
import { TuiController, projectThreadHistory } from "@koda/tui";
import { describe, expect, it } from "vitest";

describe("TuiController", () => {
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
      details: "old -> new",
      reason: "workspace write",
    });

    controller.setInput("must not be accepted");
    expect(controller.getSnapshot().input).toBe("");
    controller.toggleApprovalDetails();
    expect(controller.getSnapshot().approval).toMatchObject({
      detailsVisible: true,
      resolving: false,
    });
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
    client.threadEventsResult = { events: [], hasEarlier: false };
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
    const events = Array.from({ length: 101 }, (_, sequence) =>
      recordedItemEvent(sequence, "bounded-history", {
        type: "assistant_message",
        id: `bounded-message-${sequence}`,
        content: `\u001b[31m\u009b${"界".repeat(4_000)}`,
      }),
    );

    const projected = projectThreadHistory(events);

    expect(projected).toHaveLength(100);
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
  public readonly threadListRequests: ThreadListParams[] = [];
  public readonly threadGetRequests: ThreadGetParams[] = [];
  public readonly threadEventRequests: ThreadEventsParams[] = [];
  public threadListResult: ThreadListResult = { threads: [], diagnostics: [] };
  public threadGetResult: ThreadGetResult | undefined;
  public threadEventsResult: ThreadEventsResult = {
    events: [],
    hasEarlier: false,
  };
  public threadListError: Error | undefined;
  public threadEventsError: Error | undefined;
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
    if (this.threadEventsError !== undefined) {
      return Promise.reject(this.threadEventsError);
    }
    return Promise.resolve(this.threadEventsResult);
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
  return { id, displayName, credentialEnvironmentVariable, defaultModel };
}
