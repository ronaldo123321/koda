import type {
  AppServerClientApi,
  AppServerNotification,
} from "@koda/app-server-client-node";
import {
  modelProviderIdSchema,
  type AgentEvent,
  type ModelProviderId,
  type ProviderMetadata,
  type ThreadMetadataMessage,
  type TokenUsage,
  type ToolCallId,
  type TurnId,
  type TurnUsage,
} from "@koda/protocol";

const MAXIMUM_INPUT_CHARACTERS = 32_768;
const MAXIMUM_PRESENTATION_CHARACTERS = 8_192;
const MAXIMUM_HISTORY_ROWS = 100;
const THREAD_BROWSER_LIMIT = 100;

export type TuiConnectionStatus = "ready" | "closing" | "closed" | "error";
export type TuiMode = "chat" | "thread_list" | "thread_preview";
export type TuiTurnStatus =
  "starting" | "running" | "cancelling" | "completed" | "cancelled" | "failed";
export type TuiToolStatus =
  | "preparing"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "running"
  | "success"
  | "error"
  | "terminating";

export interface TuiConfigurationInput {
  cwd: string;
  provider: string;
  model?: string;
  resumeThreadId?: string;
  approvalMode?: "on-request" | "never";
}

export interface TuiConfiguration {
  cwd: string;
  provider: ModelProviderId;
  model: string;
  resumeThreadId?: string;
  approvalMode: "on-request" | "never";
}

export interface TuiTranscriptEntry {
  id: string;
  kind: "user" | "assistant" | "tool" | "usage" | "system" | "error";
  text: string;
}

export interface TuiToolState {
  callId: ToolCallId;
  name: string;
  status: TuiToolStatus;
  detail?: string;
}

export interface TuiApprovalState {
  callId: ToolCallId;
  name: string;
  title: string;
  summary: string;
  details: string;
  reason: string;
  detailsVisible: boolean;
  resolving: boolean;
}

export interface TuiActiveTurnState {
  localId: number;
  prompt: string;
  status: TuiTurnStatus;
  threadId?: string;
  turnId?: TurnId;
  assistantText: string;
  tools: readonly TuiToolState[];
  notes: readonly string[];
  usage?: TurnUsage;
  cancelRequested: boolean;
}

export interface TuiThreadPreviewState {
  thread: ThreadMetadataMessage;
  entries: readonly TuiTranscriptEntry[];
  hasEarlier: boolean;
}

export interface TuiThreadBrowserState {
  threads: readonly ThreadMetadataMessage[];
  selectedIndex: number;
  loading: boolean;
  preview?: TuiThreadPreviewState;
}

export interface TuiState {
  connection: TuiConnectionStatus;
  mode: TuiMode;
  configuration: TuiConfiguration;
  providers: readonly ProviderMetadata[];
  threadId: string | undefined;
  transcript: readonly TuiTranscriptEntry[];
  activeTurn: TuiActiveTurnState | undefined;
  approval: TuiApprovalState | undefined;
  input: string;
  notice: string | undefined;
  threadBrowser: TuiThreadBrowserState | undefined;
}

export type TuiSubmitResult = "handled" | "exit";

export class TuiController {
  private state: TuiState;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeNotification: () => void;
  private readonly unsubscribeDisconnect: () => void;
  private nextTranscriptId = 1;
  private nextLocalTurnId = 1;
  private cancelPromise: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;

  public constructor(
    private readonly client: AppServerClientApi,
    configuration: TuiConfigurationInput,
  ) {
    const provider = modelProviderIdSchema.parse(configuration.provider);
    const metadata = client.initialization.providers.find(
      (candidate) => candidate.id === provider,
    );
    if (metadata === undefined) {
      throw new Error(`Provider '${provider}' is not supported by app-server.`);
    }
    this.state = {
      connection: "ready",
      mode: "chat",
      configuration: {
        cwd: configuration.cwd,
        provider,
        model: configuration.model ?? metadata.defaultModel,
        approvalMode: configuration.approvalMode ?? "on-request",
        ...(configuration.resumeThreadId === undefined
          ? {}
          : { resumeThreadId: configuration.resumeThreadId }),
      },
      providers: client.initialization.providers,
      threadId: configuration.resumeThreadId,
      transcript: [],
      activeTurn: undefined,
      approval: undefined,
      input: "",
      notice: undefined,
      threadBrowser: undefined,
    };
    this.unsubscribeNotification = client.onNotification((notification) => {
      this.receiveNotification(notification);
    });
    this.unsubscribeDisconnect = client.onDisconnect((error) => {
      this.receiveDisconnect(error);
    });
  }

  public readonly getSnapshot = (): TuiState => this.state;

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  public setInput(input: string): void {
    if (!this.canEditInput()) {
      return;
    }
    this.update({ input: input.slice(0, MAXIMUM_INPUT_CHARACTERS) });
  }

  public async submitInput(): Promise<TuiSubmitResult> {
    const input = this.state.input.trim();
    if (input.length === 0) {
      this.update({ input: "" });
      return "handled";
    }
    if (!this.canEditInput()) {
      this.update({
        notice: "Wait for the active turn to finish or cancel it.",
      });
      return "handled";
    }
    this.update({ input: "", notice: undefined });
    if (!input.startsWith("/")) {
      await this.startPrompt(input);
      return "handled";
    }
    switch (input) {
      case "/help":
        this.appendTranscript(
          "system",
          [
            "/help — show commands",
            "/status — show connection and session state",
            "/clear — clear displayed history only",
            "/threads — browse threads in this workspace",
            "/new — detach so the next prompt creates a thread",
            "/exit — shut down Koda",
            "Ctrl+T — open the thread browser",
            "Esc — cancel active turn",
            "Ctrl+C — cancel while running, exit while idle",
          ].join("\n"),
        );
        return "handled";
      case "/status":
        this.appendTranscript("system", this.statusText());
        return "handled";
      case "/clear":
        this.update({ transcript: [], notice: "Display history cleared." });
        return "handled";
      case "/threads":
        await this.openThreadBrowser();
        return "handled";
      case "/new":
        this.detachThread();
        return "handled";
      case "/exit":
        return "exit";
      default:
        this.appendTranscript(
          "error",
          `Unknown command '${boundText(input, 256)}'. Use /help.`,
        );
        return "handled";
    }
  }

  public async startPrompt(prompt: string): Promise<void> {
    if (!this.canEditInput()) {
      this.update({ notice: "A turn is already active." });
      return;
    }
    const localId = this.nextLocalTurnId;
    this.nextLocalTurnId += 1;
    const activeTurn: TuiActiveTurnState = {
      localId,
      prompt,
      status: "starting",
      assistantText: "",
      tools: [],
      notes: [],
      cancelRequested: false,
      ...(this.state.threadId === undefined
        ? {}
        : { threadId: this.state.threadId }),
    };
    this.appendTranscript("user", prompt, {
      activeTurn,
      approval: undefined,
      notice: undefined,
    });
    try {
      const result = await this.client.startTurn({
        prompt,
        cwd: this.state.configuration.cwd,
        provider: this.state.configuration.provider,
        model: this.state.configuration.model,
        approvalMode: this.state.configuration.approvalMode,
        ...(this.state.threadId === undefined
          ? {}
          : { resumeThreadId: this.state.threadId }),
      });
      const current = this.state.activeTurn;
      if (current === undefined || current.localId !== localId) {
        return;
      }
      if (
        (current.turnId !== undefined && current.turnId !== result.turnId) ||
        (current.threadId !== undefined && current.threadId !== result.threadId)
      ) {
        this.recordSemanticProtocolError(
          "turn/start response did not match streamed turn identity.",
        );
        return;
      }
      this.update({
        threadId: result.threadId,
        activeTurn: {
          ...current,
          threadId: result.threadId,
          turnId: result.turnId,
          status: current.cancelRequested ? "cancelling" : "running",
        },
      });
      if (current.cancelRequested) {
        await this.cancelActiveTurn();
      }
    } catch (error) {
      const current = this.state.activeTurn;
      if (current?.localId !== localId) {
        return;
      }
      this.update({ activeTurn: undefined, approval: undefined });
      this.appendTranscript(
        "error",
        `Could not start turn: ${errorMessage(error)}`,
      );
    }
  }

  public async openThreadBrowser(): Promise<void> {
    if (!this.canBrowseThreads()) {
      this.update({ notice: "Thread browsing is available only while idle." });
      return;
    }
    this.update({ notice: "Loading recent threads…" });
    try {
      const result = await this.client.listThreads({
        workspace: this.state.configuration.cwd,
        limit: THREAD_BROWSER_LIMIT,
      });
      if (!this.canBrowseThreads()) {
        return;
      }
      this.update({
        mode: "thread_list",
        threadBrowser: {
          threads: result.threads,
          selectedIndex: 0,
          loading: false,
        },
        notice:
          result.diagnostics.length === 0
            ? undefined
            : `${result.diagnostics.length} thread index diagnostic(s) reported.`,
      });
    } catch (error) {
      this.update({
        mode: "chat",
        threadBrowser: undefined,
        notice: `Could not list threads: ${errorMessage(error)}`,
      });
    }
  }

  public selectThread(offset: -1 | 1): void {
    const browser = this.state.threadBrowser;
    if (
      this.state.mode !== "thread_list" ||
      browser === undefined ||
      browser.loading ||
      browser.threads.length === 0
    ) {
      return;
    }
    const selectedIndex = Math.min(
      browser.threads.length - 1,
      Math.max(0, browser.selectedIndex + offset),
    );
    this.update({
      threadBrowser: { ...browser, selectedIndex },
      notice: undefined,
    });
  }

  public async previewSelectedThread(): Promise<void> {
    const browser = this.state.threadBrowser;
    if (
      this.state.mode !== "thread_list" ||
      browser === undefined ||
      browser.loading
    ) {
      return;
    }
    const thread = browser.threads[browser.selectedIndex];
    if (thread === undefined) {
      this.update({ notice: "No thread is available to preview." });
      return;
    }
    this.update({
      threadBrowser: { ...browser, loading: true },
      notice: `Loading thread ${thread.threadId}…`,
    });
    try {
      const result = await this.client.readThreadEvents({
        threadId: thread.threadId,
        limit: 200,
      });
      if (this.state.mode !== "thread_list") {
        return;
      }
      const currentBrowser = this.state.threadBrowser;
      if (currentBrowser === undefined) {
        return;
      }
      this.update({
        mode: "thread_preview",
        threadBrowser: {
          ...currentBrowser,
          loading: false,
          preview: {
            thread,
            entries: projectThreadHistory(result.events).map((entry) =>
              this.withTranscriptId(entry),
            ),
            hasEarlier: result.hasEarlier,
          },
        },
        notice: undefined,
      });
    } catch (error) {
      const currentBrowser = this.state.threadBrowser;
      if (this.state.mode !== "thread_list" || currentBrowser === undefined) {
        return;
      }
      this.update({
        threadBrowser: { ...currentBrowser, loading: false },
        notice: `Could not load thread history: ${errorMessage(error)}`,
      });
    }
  }

  public closeThreadBrowserLevel(): void {
    const browser = this.state.threadBrowser;
    if (this.state.mode === "thread_preview" && browser !== undefined) {
      const { preview: _preview, ...listState } = browser;
      this.update({
        mode: "thread_list",
        threadBrowser: { ...listState, loading: false },
        notice: undefined,
      });
      return;
    }
    if (this.state.mode === "thread_list") {
      this.update({
        mode: "chat",
        threadBrowser: undefined,
        notice: undefined,
      });
    }
  }

  public async resumePreviewedThread(): Promise<void> {
    const browser = this.state.threadBrowser;
    const preview = browser?.preview;
    if (
      this.state.mode !== "thread_preview" ||
      browser === undefined ||
      preview === undefined ||
      browser.loading
    ) {
      return;
    }
    if (preview.thread.status === "invalid") {
      this.update({ notice: "Invalid threads cannot be resumed." });
      return;
    }
    this.update({
      threadBrowser: { ...browser, loading: true },
      notice: `Checking thread ${preview.thread.threadId}…`,
    });
    try {
      const result = await this.client.getThread({
        threadId: preview.thread.threadId,
      });
      if (this.state.mode !== "thread_preview") {
        return;
      }
      const thread = result.thread;
      if (thread.status === "invalid") {
        throw new Error("Invalid threads cannot be resumed.");
      }
      if (thread.workspaceRoot !== this.state.configuration.cwd) {
        throw new Error(
          `Thread workspace '${thread.workspaceRoot ?? "unknown"}' does not match '${this.state.configuration.cwd}'.`,
        );
      }
      if (thread.provider === undefined || thread.model === undefined) {
        throw new Error("Thread provider and model metadata are required.");
      }
      const provider = modelProviderIdSchema.parse(thread.provider);
      if (
        !this.state.providers.some((candidate) => candidate.id === provider)
      ) {
        throw new Error(
          `Provider '${provider}' is not supported by app-server.`,
        );
      }
      const historyEntries = preview.entries.map(({ kind, text }) =>
        this.withTranscriptId({ kind, text }),
      );
      this.update({
        mode: "chat",
        configuration: {
          ...this.state.configuration,
          provider,
          model: thread.model,
          resumeThreadId: thread.threadId,
        },
        threadId: thread.threadId,
        transcript: [
          ...this.state.transcript,
          this.withTranscriptId({
            kind: "system",
            text: `Resumed thread ${thread.threadId} (${provider}/${thread.model}).`,
          }),
          ...historyEntries,
        ],
        input: "",
        threadBrowser: undefined,
        notice: undefined,
      });
    } catch (error) {
      const currentBrowser = this.state.threadBrowser;
      if (
        this.state.mode === "thread_preview" &&
        currentBrowser !== undefined
      ) {
        this.update({
          threadBrowser: { ...currentBrowser, loading: false },
          notice: `Could not resume thread: ${errorMessage(error)}`,
        });
      }
    }
  }

  private detachThread(): void {
    const previous = this.state.threadId;
    const { resumeThreadId: _resumeThreadId, ...configuration } =
      this.state.configuration;
    this.appendTranscript(
      "system",
      previous === undefined
        ? "Already detached; the next prompt will create a new thread."
        : `Detached from thread ${previous}; the next prompt will create a new thread.`,
      { configuration, threadId: undefined, notice: undefined },
    );
  }

  public toggleApprovalDetails(): void {
    if (this.state.approval === undefined || this.state.approval.resolving) {
      return;
    }
    this.update({
      approval: {
        ...this.state.approval,
        detailsVisible: !this.state.approval.detailsVisible,
      },
    });
  }

  public async resolveApproval(
    decision: "approved" | "rejected",
  ): Promise<void> {
    const approval = this.state.approval;
    const turnId = this.state.activeTurn?.turnId;
    if (approval === undefined || turnId === undefined || approval.resolving) {
      return;
    }
    this.update({ approval: { ...approval, resolving: true } });
    try {
      await this.client.resolveApproval({
        turnId,
        callId: approval.callId,
        decision,
        reason:
          decision === "approved"
            ? "Approved by the TUI user."
            : "Rejected by the TUI user.",
      });
    } catch (error) {
      if (this.state.approval?.callId === approval.callId) {
        this.update({
          approval: { ...approval, resolving: false },
          notice: `Approval was not resolved: ${errorMessage(error)}`,
        });
      }
    }
  }

  public cancelActiveTurn(): Promise<void> {
    this.cancelPromise ??= this.cancelActiveTurnOnce().finally(() => {
      this.cancelPromise = undefined;
    });
    return this.cancelPromise;
  }

  public shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownOnce();
    return this.shutdownPromise;
  }

  public dispose(): void {
    this.unsubscribeNotification();
    this.unsubscribeDisconnect();
    this.listeners.clear();
  }

  private async cancelActiveTurnOnce(): Promise<void> {
    const active = this.state.activeTurn;
    if (active === undefined) {
      return;
    }
    this.update({
      activeTurn: {
        ...active,
        status: "cancelling",
        cancelRequested: true,
      },
      notice: "Cancelling active turn…",
    });
    if (active.turnId === undefined) {
      return;
    }
    try {
      const result = await this.client.cancelTurn({
        turnId: active.turnId,
        reason: "Cancelled by the TUI user.",
      });
      if (!result.accepted) {
        this.update({ notice: "The turn had already begun finishing." });
      }
    } catch (error) {
      this.update({ notice: `Cancellation failed: ${errorMessage(error)}` });
    }
  }

  private async shutdownOnce(): Promise<void> {
    if (this.state.connection === "closed") {
      return;
    }
    this.update({ connection: "closing", notice: "Shutting down…" });
    try {
      await this.client.shutdown();
      this.update({
        connection: "closed",
        mode: "chat",
        activeTurn: undefined,
        approval: undefined,
        threadBrowser: undefined,
        notice: undefined,
      });
    } catch (error) {
      this.update({
        connection: "error",
        mode: "chat",
        activeTurn: undefined,
        approval: undefined,
        threadBrowser: undefined,
        notice: `Shutdown failed: ${errorMessage(error)}`,
      });
    }
  }

  private receiveNotification(notification: AppServerNotification): void {
    if (notification.method === "turn/event") {
      this.receiveEvent(notification.params.event);
    } else {
      this.finishTurn(notification.params);
    }
  }

  private receiveEvent(event: AgentEvent): void {
    const active = this.state.activeTurn;
    if (active === undefined) {
      this.recordSemanticProtocolError(
        `Received ${event.type} for inactive turn '${event.turnId}'.`,
      );
      return;
    }
    if (active.turnId !== undefined && active.turnId !== event.turnId) {
      this.recordSemanticProtocolError(
        `Received ${event.type} for unexpected turn '${event.turnId}'.`,
      );
      return;
    }
    if (active.threadId !== undefined && active.threadId !== event.threadId) {
      this.recordSemanticProtocolError(
        `Received ${event.type} for unexpected thread '${event.threadId}'.`,
      );
      return;
    }
    let next: TuiActiveTurnState = {
      ...active,
      threadId: event.threadId,
      turnId: event.turnId,
      status:
        active.status === "starting" && !active.cancelRequested
          ? "running"
          : active.status,
    };
    let approval = this.state.approval;
    switch (event.type) {
      case "assistant.delta":
        next = {
          ...next,
          assistantText: next.assistantText + event.payload.text,
        };
        break;
      case "model.usage":
        next = {
          ...next,
          usage: addModelUsage(next.usage, event.payload.usage),
        };
        break;
      case "tool.started":
        next = updateTool(next, event.payload.callId, event.payload.name, {
          status: "preparing",
        });
        break;
      case "approval.requested":
        next = updateTool(next, event.payload.callId, event.payload.name, {
          status: "awaiting_approval",
          detail: event.payload.summary,
        });
        approval = {
          callId: event.payload.callId,
          name: boundText(event.payload.name),
          title: boundText(event.payload.title),
          summary: boundText(event.payload.summary),
          details: boundText(event.payload.details),
          reason: boundText(event.payload.reason),
          detailsVisible: false,
          resolving: false,
        };
        break;
      case "approval.resolved":
        next = updateTool(next, event.payload.callId, undefined, {
          status:
            event.payload.decision === "approved" ? "approved" : "rejected",
          ...(event.payload.reason === undefined
            ? {}
            : { detail: event.payload.reason }),
        });
        if (approval?.callId === event.payload.callId) {
          approval = undefined;
        }
        break;
      case "tool.execution_started":
        next = updateTool(next, event.payload.callId, event.payload.name, {
          status: "running",
          detail: event.payload.effect,
        });
        break;
      case "tool.completed":
        next = updateTool(next, event.payload.callId, event.payload.name, {
          status: event.payload.status,
        });
        break;
      case "process.started":
        next = updateTool(next, event.payload.callId, event.payload.name, {
          status: "running",
          detail: `process ${event.payload.pid}`,
        });
        break;
      case "process.termination_requested":
        next = updateTool(next, event.payload.callId, event.payload.name, {
          status: "terminating",
          detail: `${event.payload.reason}, ${event.payload.attempt}`,
        });
        break;
      case "process.termination_completed":
        next = updateTool(next, event.payload.callId, event.payload.name, {
          status: event.payload.outcome === "uncertain" ? "error" : "success",
          detail: `termination ${event.payload.outcome}`,
        });
        break;
      case "artifact.recorded":
        next = updateTool(next, event.payload.callId, event.payload.name, {
          detail: `artifact ${event.payload.artifact.id} (${event.payload.artifact.bytes} bytes)`,
        });
        break;
      case "item.recorded":
        next = receiveItem(next, event);
        break;
      case "turn.completed":
        next = {
          ...next,
          status: "completed",
          ...(event.payload.usage === undefined
            ? {}
            : { usage: event.payload.usage }),
        };
        break;
      case "turn.cancelled":
        next = {
          ...next,
          status: "cancelled",
          notes: [...next.notes, boundText(event.payload.reason)],
          ...(event.payload.usage === undefined
            ? {}
            : { usage: event.payload.usage }),
        };
        break;
      case "turn.failed":
        next = {
          ...next,
          status: "failed",
          notes: [
            ...next.notes,
            boundText(`${event.payload.code}: ${event.payload.message}`),
          ],
          ...(event.payload.usage === undefined
            ? {}
            : { usage: event.payload.usage }),
        };
        break;
      default:
        break;
    }
    this.update({
      threadId: event.threadId,
      activeTurn: next,
      approval,
    });
  }

  private finishTurn(
    finished: Extract<
      AppServerNotification,
      { method: "turn/finished" }
    >["params"],
  ): void {
    const active = this.state.activeTurn;
    if (
      active === undefined ||
      (active.turnId !== undefined && active.turnId !== finished.turnId)
    ) {
      this.recordSemanticProtocolError(
        `Received completion for unexpected turn '${finished.turnId}'.`,
      );
      return;
    }
    const additions = activeTranscriptEntries(active);
    if (finished.status === "cancelled") {
      additions.push({ kind: "system", text: "Turn cancelled." });
    } else if (finished.status === "failed") {
      additions.push({
        kind: "error",
        text:
          finished.error === undefined
            ? "Turn failed."
            : `${finished.error.code}: ${finished.error.message}`,
      });
    }
    this.update({
      threadId: finished.threadId,
      transcript: [
        ...this.state.transcript,
        ...additions.map((entry) => this.withTranscriptId(entry)),
      ],
      activeTurn: undefined,
      approval: undefined,
      notice: undefined,
    });
  }

  private receiveDisconnect(error: Error | undefined): void {
    if (
      this.state.connection === "closing" ||
      this.state.connection === "closed"
    ) {
      return;
    }
    const message =
      error === undefined
        ? "The app-server connection closed."
        : `The app-server connection closed: ${error.message}`;
    const activeEntries =
      this.state.activeTurn === undefined
        ? []
        : activeTranscriptEntries(this.state.activeTurn);
    this.update({
      connection: "error",
      mode: "chat",
      activeTurn: undefined,
      approval: undefined,
      threadBrowser: undefined,
      transcript: [
        ...this.state.transcript,
        ...activeEntries.map((entry) => this.withTranscriptId(entry)),
        this.withTranscriptId({ kind: "error", text: boundText(message) }),
      ],
      notice: boundText(message),
    });
  }

  private statusText(): string {
    const diagnostics = this.client.diagnostics().trim();
    return [
      `connection: ${this.state.connection}`,
      `thread: ${this.state.threadId ?? "new"}`,
      `provider: ${this.state.configuration.provider}`,
      `model: ${this.state.configuration.model}`,
      `workspace: ${this.state.configuration.cwd}`,
      `approval: ${this.state.configuration.approvalMode}`,
      `turn: ${this.state.activeTurn?.status ?? "idle"}`,
      `view: ${this.state.mode}`,
      `diagnostics: ${diagnostics.length === 0 ? "none" : boundText(diagnostics, 2_000)}`,
    ].join("\n");
  }

  private canEditInput(): boolean {
    return (
      this.state.connection === "ready" &&
      this.state.mode === "chat" &&
      this.state.activeTurn === undefined &&
      this.state.approval === undefined
    );
  }

  private canBrowseThreads(): boolean {
    return (
      this.state.connection === "ready" &&
      this.state.mode === "chat" &&
      this.state.activeTurn === undefined &&
      this.state.approval === undefined
    );
  }

  private recordSemanticProtocolError(message: string): void {
    this.appendTranscript(
      "error",
      `Protocol state error: ${boundText(message)}`,
    );
  }

  private appendTranscript(
    kind: TuiTranscriptEntry["kind"],
    text: string,
    changes: Partial<TuiState> = {},
  ): void {
    this.update({
      ...changes,
      transcript: [
        ...this.state.transcript,
        this.withTranscriptId({ kind, text: boundText(text) }),
      ],
    });
  }

  private withTranscriptId(
    entry: Omit<TuiTranscriptEntry, "id">,
  ): TuiTranscriptEntry {
    const id = `transcript-${this.nextTranscriptId}`;
    this.nextTranscriptId += 1;
    return { id, ...entry, text: boundText(entry.text) };
  }

  private update(changes: Partial<TuiState>): void {
    this.state = { ...this.state, ...changes };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function updateTool(
  active: TuiActiveTurnState,
  callId: ToolCallId,
  name: string | undefined,
  changes: Partial<Omit<TuiToolState, "callId" | "name">>,
): TuiActiveTurnState {
  const existing = active.tools.find((tool) => tool.callId === callId);
  const next: TuiToolState =
    existing === undefined
      ? {
          callId,
          name: boundText(name ?? "tool"),
          status: changes.status ?? "preparing",
          ...(changes.detail === undefined
            ? {}
            : { detail: boundText(changes.detail) }),
        }
      : {
          ...existing,
          ...changes,
          ...(name === undefined ? {} : { name: boundText(name) }),
          ...(changes.detail === undefined
            ? {}
            : { detail: boundText(changes.detail) }),
        };
  return {
    ...active,
    tools:
      existing === undefined
        ? [...active.tools, next]
        : active.tools.map((tool) => (tool.callId === callId ? next : tool)),
  };
}

function receiveItem(
  active: TuiActiveTurnState,
  event: Extract<AgentEvent, { type: "item.recorded" }>,
): TuiActiveTurnState {
  if (event.payload.item.type === "compaction") {
    return { ...active, notes: [...active.notes, "Context compacted."] };
  }
  if (event.payload.item.type !== "recovery") {
    return active;
  }
  const notes: string[] = [];
  if (event.payload.item.uncertainToolCalls.length > 0) {
    notes.push(
      `Uncertain operations: ${event.payload.item.uncertainToolCalls
        .map((call) => call.name)
        .join(", ")}`,
    );
  }
  if (event.payload.item.unavailableArtifacts.length > 0) {
    notes.push(
      `Unavailable artifacts: ${event.payload.item.unavailableArtifacts.length}`,
    );
  }
  if (event.payload.item.instructionChanges.length > 0) {
    notes.push(
      `Repository instruction changes: ${event.payload.item.instructionChanges.length}`,
    );
  }
  return {
    ...active,
    notes: [...active.notes, ...notes.map((note) => boundText(note))],
  };
}

export function projectThreadHistory(
  events: readonly AgentEvent[],
): Array<Omit<TuiTranscriptEntry, "id">> {
  const recordedToolResults = new Set(
    events.flatMap((event) =>
      event.type === "item.recorded" &&
      event.payload.item.type === "tool_result"
        ? [event.payload.item.callId]
        : [],
    ),
  );
  const entries: Array<Omit<TuiTranscriptEntry, "id">> = [];
  for (const event of events) {
    if (event.type === "item.recorded") {
      const item = event.payload.item;
      switch (item.type) {
        case "user_message":
          entries.push({ kind: "user", text: item.content });
          break;
        case "assistant_message":
          entries.push({ kind: "assistant", text: item.content });
          break;
        case "tool_result":
          entries.push({
            kind: item.status === "error" ? "error" : "tool",
            text:
              item.status === "error"
                ? `${item.name}: ${item.error?.code ?? "error"}${item.error?.message === undefined ? "" : ` — ${item.error.message}`}`
                : `${item.name}: success${item.output === undefined ? "" : ` — ${jsonSummary(item.output)}`}`,
          });
          break;
        case "compaction":
          entries.push({
            kind: "system",
            text: `Context compacted: ${item.summary.objective || "summary recorded"}.`,
          });
          break;
        case "recovery": {
          const uncertain =
            item.uncertainToolCalls.length === 0
              ? ""
              : ` Uncertain operations: ${item.uncertainToolCalls.map((call) => call.name).join(", ")}.`;
          entries.push({
            kind: item.uncertainToolCalls.length === 0 ? "system" : "error",
            text: `Recovery (${item.previousStatus}): ${item.message}${uncertain}`,
          });
          break;
        }
        default:
          break;
      }
      continue;
    }
    if (
      event.type === "tool.completed" &&
      event.payload.status === "error" &&
      !recordedToolResults.has(event.payload.callId)
    ) {
      entries.push({
        kind: "error",
        text: `${event.payload.name}: tool execution failed.`,
      });
      continue;
    }
    if (
      event.type === "process.termination_completed" &&
      event.payload.outcome === "uncertain"
    ) {
      entries.push({
        kind: "error",
        text: `${event.payload.name}: process termination outcome is uncertain (pid ${event.payload.pid}).`,
      });
      continue;
    }
    if (event.type === "turn.completed") {
      entries.push(
        event.payload.usage === undefined
          ? { kind: "system", text: "Turn completed." }
          : { kind: "usage", text: formatUsage(event.payload.usage) },
      );
      continue;
    }
    if (event.type === "turn.cancelled") {
      entries.push({
        kind: "system",
        text: `Turn cancelled: ${event.payload.reason}`,
      });
      continue;
    }
    if (event.type === "turn.failed") {
      entries.push({
        kind: "error",
        text: `${event.payload.code}: ${event.payload.message}`,
      });
    }
  }
  const bounded = entries.map((entry) => ({
    ...entry,
    text: boundText(entry.text),
  }));
  if (bounded.length <= MAXIMUM_HISTORY_ROWS) {
    return bounded;
  }
  return [
    {
      kind: "system",
      text: `${bounded.length - (MAXIMUM_HISTORY_ROWS - 1)} older history row(s) omitted from this preview.`,
    },
    ...bounded.slice(-(MAXIMUM_HISTORY_ROWS - 1)),
  ];
}

function addModelUsage(
  current: TurnUsage | undefined,
  usage: TokenUsage,
): TurnUsage {
  const tokens = current?.tokens;
  return {
    modelRequests: (current?.modelRequests ?? 0) + 1,
    reportedRequests: (current?.reportedRequests ?? 0) + 1,
    tokens: {
      inputTokens: (tokens?.inputTokens ?? 0) + usage.inputTokens,
      cachedInputTokens:
        (tokens?.cachedInputTokens ?? 0) + usage.cachedInputTokens,
      cacheWriteInputTokens:
        (tokens?.cacheWriteInputTokens ?? 0) + usage.cacheWriteInputTokens,
      outputTokens: (tokens?.outputTokens ?? 0) + usage.outputTokens,
      reasoningOutputTokens:
        (tokens?.reasoningOutputTokens ?? 0) + usage.reasoningOutputTokens,
      totalTokens: (tokens?.totalTokens ?? 0) + usage.totalTokens,
    },
  };
}

function formatUsage(usage: TurnUsage): string {
  const tokens = usage.tokens;
  return `tokens: ${tokens.inputTokens} input, ${tokens.outputTokens} output (${tokens.reasoningOutputTokens} reasoning), ${tokens.totalTokens} total; ${usage.reportedRequests}/${usage.modelRequests} requests reported`;
}

function activeTranscriptEntries(
  active: TuiActiveTurnState,
): Array<Omit<TuiTranscriptEntry, "id">> {
  const entries: Array<Omit<TuiTranscriptEntry, "id">> = [];
  if (active.assistantText.length > 0) {
    entries.push({ kind: "assistant", text: active.assistantText });
  }
  for (const tool of active.tools) {
    entries.push({
      kind: "tool",
      text: `${tool.name}: ${toolStatusLabel(tool.status)}${tool.detail === undefined ? "" : ` (${tool.detail})`}`,
    });
  }
  for (const note of active.notes) {
    entries.push({ kind: "system", text: note });
  }
  if (active.usage !== undefined) {
    entries.push({ kind: "usage", text: formatUsage(active.usage) });
  }
  return entries;
}

function toolStatusLabel(status: TuiToolStatus): string {
  return status.replaceAll("_", " ");
}

function boundText(
  text: string,
  maximum = MAXIMUM_PRESENTATION_CHARACTERS,
): string {
  const normalized = text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
  if (Buffer.byteLength(normalized, "utf8") <= maximum) {
    return normalized;
  }
  const budget = Math.max(0, maximum - 3);
  let low = 0;
  let high = normalized.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(normalized.slice(0, middle), "utf8") <= budget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  let prefix = normalized.slice(0, low);
  if (/\p{Surrogate}$/u.test(prefix)) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}...`;
}

export function boundPresentationText(
  text: string,
  maximum = MAXIMUM_PRESENTATION_CHARACTERS,
): string {
  return boundText(text, maximum);
}

function jsonSummary(value: unknown): string {
  try {
    return boundText(JSON.stringify(value));
  } catch {
    return "[unserializable output]";
  }
}

function errorMessage(error: unknown): string {
  return boundText(error instanceof Error ? error.message : String(error));
}
