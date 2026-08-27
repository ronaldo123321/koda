import type {
  AppServerClientApi,
  AppServerNotification,
} from "@koda/app-server-client-node";
import {
  ARTIFACT_READ_DEFAULT_BYTES,
  CONTEXT_INSTRUCTION_READ_DEFAULT_BYTES,
  RUNTIME_SETTINGS_MODEL_BUDGET_BYTES,
  artifactIdSchema,
  modelProviderIdSchema,
  runtimeSettingsModelSchema,
  threadIdSchema,
  type AgentEvent,
  type ArtifactId,
  type ArtifactReadResult,
  type ContextInstructionReadResult,
  type ContextReadResult,
  type ContextRequestDescriptor,
  type ModelProviderId,
  type RuntimePreference,
  type RuntimeProviderMetadata,
  type ThreadMetadataMessage,
  type ThreadArtifactDescriptor,
  type ThreadId,
  type ThreadSearchCursor,
  type ThreadSearchMatch,
  type TokenUsage,
  type ToolCallId,
  type TurnId,
  type TurnUsage,
} from "@koda/protocol";

const MAXIMUM_INPUT_CHARACTERS = 32_768;
const MAXIMUM_PRESENTATION_CHARACTERS = 8_192;
const MAXIMUM_HISTORY_ROWS = 200;
const MAXIMUM_HISTORY_EVENTS = 400;
const MAXIMUM_SEARCH_RESULTS = 500;
const THREAD_BROWSER_LIMIT = 100;
const THREAD_SEARCH_PAGE_LIMIT = 100;
const DEFAULT_VIEWPORT_HEIGHT = 12;
const MINIMUM_VIEWPORT_HEIGHT = 5;
const MAXIMUM_VIEWPORT_HEIGHT = 30;
const DEFAULT_VIEWPORT_WIDTH = 80;
const MINIMUM_VIEWPORT_WIDTH = 20;
const MAXIMUM_VIEWPORT_WIDTH = 240;

export type TuiConnectionStatus = "ready" | "closing" | "closed" | "error";
export type TuiMode =
  | "chat"
  | "settings_provider"
  | "settings_model"
  | "artifact_list"
  | "artifact_view"
  | "context_list"
  | "context_detail"
  | "context_instruction_view"
  | "thread_list"
  | "thread_search_input"
  | "thread_search_results"
  | "thread_preview";
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
  settingsRevision?: number;
  settingsPreference?: RuntimePreference;
  initialNotice?: string;
}

export interface TuiConfiguration {
  cwd: string;
  provider: ModelProviderId;
  model: string;
  resumeThreadId?: string;
  approvalMode: "on-request" | "never";
}

export interface TuiNewThreadConfiguration {
  provider: ModelProviderId;
  model: string;
}

export interface TuiRuntimeSettingsState {
  revision: number;
  selectedIndex: number;
  draftProvider?: ModelProviderId;
  modelInput: string;
  draftModels: Partial<Record<ModelProviderId, string>>;
  persistedPreference?: RuntimePreference;
  loading: boolean;
}

export interface TuiArtifactListState {
  artifacts: readonly ThreadArtifactDescriptor[];
  selectedIndex: number;
  scrollOffset: number;
  currentCursor: number | null;
  newerCursors: readonly (number | null)[];
  hasEarlier: boolean;
  nextBeforeSequence?: number;
}

export interface TuiArtifactViewState {
  page: ArtifactReadResult;
  rows: readonly string[];
  scrollOffset: number;
}

export interface TuiArtifactNavigationState {
  origin: "chat" | "thread_preview";
  threadId: ThreadId;
  list?: TuiArtifactListState;
  view?: TuiArtifactViewState;
  loading: boolean;
  viewportHeight: number;
  viewportWidth: number;
}

export interface TuiContextListState {
  requests: readonly ContextRequestDescriptor[];
  selectedIndex: number;
  scrollOffset: number;
  currentCursor: number | null;
  newerCursors: readonly (number | null)[];
  hasEarlier: boolean;
  nextBeforeSequence?: number;
}

export interface TuiContextDetailState {
  result: ContextReadResult;
  selectedSourceIndex: number;
  sourceScrollOffset: number;
}

export interface TuiContextInstructionViewState {
  page: ContextInstructionReadResult;
  rows: readonly string[];
  scrollOffset: number;
}

export interface TuiContextNavigationState {
  origin: "chat" | "thread_preview";
  threadId: ThreadId;
  list?: TuiContextListState;
  detail?: TuiContextDetailState;
  instructionView?: TuiContextInstructionViewState;
  loading: boolean;
  viewportHeight: number;
  viewportWidth: number;
}

export interface TuiTranscriptEntry {
  id: string;
  kind: "user" | "assistant" | "tool" | "usage" | "system" | "error";
  text: string;
  sequence?: number;
  matched?: boolean;
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
  source: "list" | "search_results";
  thread: ThreadMetadataMessage;
  events: readonly AgentEvent[];
  entries: readonly TuiTranscriptEntry[];
  scrollOffset: number;
  hasEarlier: boolean;
  hasLater: boolean;
  hasProjectedEarlier: boolean;
  hasProjectedLater: boolean;
  match?: ThreadSearchMatch;
  query?: string;
}

export interface TuiThreadSearchState {
  origin: "chat" | "thread_list";
  input: string;
  query: string;
  matches: readonly ThreadSearchMatch[];
  selectedIndex: number;
  scrollOffset: number;
  loading: boolean;
  hasMore: boolean;
  revision?: number;
  nextCursor?: ThreadSearchCursor;
}

export interface TuiThreadBrowserState {
  threads: readonly ThreadMetadataMessage[];
  selectedIndex: number;
  listScrollOffset: number;
  viewportHeight: number;
  loading: boolean;
  search?: TuiThreadSearchState;
  preview?: TuiThreadPreviewState;
}

export interface TuiState {
  connection: TuiConnectionStatus;
  mode: TuiMode;
  configuration: TuiConfiguration;
  nextThreadConfiguration: TuiNewThreadConfiguration;
  providers: readonly RuntimeProviderMetadata[];
  threadId: string | undefined;
  transcript: readonly TuiTranscriptEntry[];
  activeTurn: TuiActiveTurnState | undefined;
  approval: TuiApprovalState | undefined;
  input: string;
  notice: string | undefined;
  threadBrowser: TuiThreadBrowserState | undefined;
  runtimeSettings: TuiRuntimeSettingsState | undefined;
  artifactNavigation: TuiArtifactNavigationState | undefined;
  contextNavigation: TuiContextNavigationState | undefined;
}

export type TuiSubmitResult = "handled" | "exit";

export class TuiController {
  private state: TuiState;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeNotification: () => void;
  private readonly unsubscribeDisconnect: () => void;
  private nextTranscriptId = 1;
  private nextLocalTurnId = 1;
  private navigationGeneration = 0;
  private navigationBusy = false;
  private viewportHeight = DEFAULT_VIEWPORT_HEIGHT;
  private viewportWidth = DEFAULT_VIEWPORT_WIDTH;
  private preferenceRevision: number;
  private persistedPreference: RuntimePreference | undefined;
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
    const model = runtimeSettingsModelSchema.parse(
      configuration.model ?? metadata.defaultModel,
    );
    this.preferenceRevision = configuration.settingsRevision ?? 0;
    this.persistedPreference = configuration.settingsPreference;
    this.state = {
      connection: "ready",
      mode: "chat",
      configuration: {
        cwd: configuration.cwd,
        provider,
        model,
        approvalMode: configuration.approvalMode ?? "on-request",
        ...(configuration.resumeThreadId === undefined
          ? {}
          : { resumeThreadId: configuration.resumeThreadId }),
      },
      nextThreadConfiguration: { provider, model },
      providers: client.initialization.providers,
      threadId: configuration.resumeThreadId,
      transcript: [],
      activeTurn: undefined,
      approval: undefined,
      input: "",
      notice: configuration.initialNotice,
      threadBrowser: undefined,
      runtimeSettings: undefined,
      artifactNavigation: undefined,
      contextNavigation: undefined,
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
    if (input.startsWith("/search ")) {
      await this.openThreadSearch(input.slice("/search ".length), "chat");
      return "handled";
    }
    if (input === "/artifact" || input.startsWith("/artifact ")) {
      await this.openDirectArtifact(input.slice("/artifact".length));
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
            "/search <query> — search durable history in this workspace",
            "/settings — choose provider/model for the next new thread",
            "/artifacts — browse artifacts referenced by this thread",
            "/artifact <id> — open a referenced text artifact",
            "/context — inspect prepared model context and instructions",
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
      case "/settings":
        await this.openRuntimeSettings();
        return "handled";
      case "/artifacts":
        await this.openCurrentThreadArtifacts();
        return "handled";
      case "/context":
        await this.openCurrentThreadContext();
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
    const provider = this.state.providers.find(
      (candidate) => candidate.id === this.state.configuration.provider,
    );
    if (provider === undefined || !provider.configured) {
      this.update({
        notice:
          provider === undefined
            ? `Provider '${this.state.configuration.provider}' is unavailable.`
            : `${provider.credentialEnvironmentVariable} is required for provider '${provider.id}'. Use /settings to choose a configured provider.`,
      });
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

  public async openRuntimeSettings(): Promise<void> {
    if (!this.canEditInput() || this.navigationBusy) {
      this.update({ notice: "Settings are available only while idle." });
      return;
    }
    const selectedIndex = Math.max(
      0,
      this.state.providers.findIndex(
        (provider) =>
          provider.id === this.state.nextThreadConfiguration.provider,
      ),
    );
    const draftModels: Partial<Record<ModelProviderId, string>> = {
      [this.state.nextThreadConfiguration.provider]:
        this.state.nextThreadConfiguration.model,
    };
    if (this.persistedPreference !== undefined) {
      draftModels[this.persistedPreference.provider] ??=
        this.persistedPreference.model;
    }
    const generation = this.beginNavigation();
    this.navigationBusy = true;
    this.update({
      mode: "settings_provider",
      runtimeSettings: {
        revision: this.preferenceRevision,
        selectedIndex,
        modelInput: "",
        draftModels,
        ...(this.persistedPreference === undefined
          ? {}
          : { persistedPreference: this.persistedPreference }),
        loading: true,
      },
      notice: "Loading workspace settings…",
    });
    try {
      const result = await this.client.getRuntimeSettings({
        workspace: this.state.configuration.cwd,
      });
      if (
        !this.isCurrentNavigation(generation) ||
        this.state.mode !== "settings_provider"
      ) {
        return;
      }
      const current = this.state.runtimeSettings;
      if (current === undefined) {
        return;
      }
      this.preferenceRevision = result.revision;
      this.persistedPreference = result.preference;
      const models = { ...current.draftModels };
      const {
        persistedPreference: _previousPreference,
        ...settingsWithoutPreference
      } = current;
      if (result.preference !== undefined) {
        models[result.preference.provider] ??= result.preference.model;
      }
      this.update({
        runtimeSettings: {
          ...settingsWithoutPreference,
          revision: result.revision,
          draftModels: models,
          loading: false,
          ...(result.preference === undefined
            ? {}
            : { persistedPreference: result.preference }),
        },
        notice: runtimeSettingsResultNotice(result),
      });
    } catch (error) {
      if (!this.isCurrentNavigation(generation)) {
        return;
      }
      this.update({
        mode: "chat",
        runtimeSettings: undefined,
        notice: `Could not load runtime settings: ${errorMessage(error)}`,
      });
    } finally {
      if (this.isCurrentNavigation(generation)) {
        this.navigationBusy = false;
      }
    }
  }

  public selectRuntimeSettingsProvider(offset: -1 | 1): void {
    const settings = this.state.runtimeSettings;
    if (
      this.state.mode !== "settings_provider" ||
      settings === undefined ||
      settings.loading ||
      this.state.providers.length === 0
    ) {
      return;
    }
    this.update({
      runtimeSettings: {
        ...settings,
        selectedIndex: Math.min(
          this.state.providers.length - 1,
          Math.max(0, settings.selectedIndex + offset),
        ),
      },
      notice: undefined,
    });
  }

  public enterRuntimeSettingsModel(): void {
    const settings = this.state.runtimeSettings;
    const provider =
      settings === undefined
        ? undefined
        : this.state.providers[settings.selectedIndex];
    if (
      this.state.mode !== "settings_provider" ||
      settings === undefined ||
      settings.loading ||
      provider === undefined
    ) {
      return;
    }
    if (!provider.configured) {
      this.update({
        notice: `${provider.credentialEnvironmentVariable} is required for provider '${provider.id}'.`,
      });
      return;
    }
    const modelInput =
      settings.draftModels[provider.id] ??
      (settings.persistedPreference?.provider === provider.id
        ? settings.persistedPreference.model
        : provider.defaultModel);
    this.update({
      mode: "settings_model",
      runtimeSettings: {
        ...settings,
        draftProvider: provider.id,
        modelInput,
        draftModels: {
          ...settings.draftModels,
          [provider.id]: modelInput,
        },
      },
      notice: undefined,
    });
  }

  public setRuntimeSettingsModelInput(input: string): void {
    const settings = this.state.runtimeSettings;
    if (
      this.state.mode !== "settings_model" ||
      settings === undefined ||
      settings.loading ||
      settings.draftProvider === undefined
    ) {
      return;
    }
    const modelInput = boundModelInput(input);
    this.update({
      runtimeSettings: {
        ...settings,
        modelInput,
        draftModels: {
          ...settings.draftModels,
          [settings.draftProvider]: modelInput,
        },
      },
      notice: undefined,
    });
  }

  public resetRuntimeSettingsModel(): void {
    const settings = this.state.runtimeSettings;
    if (
      this.state.mode !== "settings_model" ||
      settings === undefined ||
      settings.loading ||
      settings.draftProvider === undefined
    ) {
      return;
    }
    const provider = this.state.providers.find(
      (candidate) => candidate.id === settings.draftProvider,
    );
    if (provider !== undefined) {
      this.setRuntimeSettingsModelInput(provider.defaultModel);
    }
  }

  public async applyRuntimeSettings(): Promise<void> {
    const settings = this.state.runtimeSettings;
    if (
      this.state.mode !== "settings_model" ||
      settings === undefined ||
      settings.loading ||
      settings.draftProvider === undefined ||
      this.navigationBusy
    ) {
      return;
    }
    const parsedModel = runtimeSettingsModelSchema.safeParse(
      settings.modelInput.trim(),
    );
    if (!parsedModel.success) {
      this.update({
        notice: `Model ID is invalid or exceeds ${RUNTIME_SETTINGS_MODEL_BUDGET_BYTES} UTF-8 bytes.`,
      });
      return;
    }
    const provider = this.state.providers.find(
      (candidate) => candidate.id === settings.draftProvider,
    );
    if (provider === undefined || !provider.configured) {
      this.update({
        notice:
          provider === undefined
            ? "The selected provider is unavailable."
            : `${provider.credentialEnvironmentVariable} is required for provider '${provider.id}'.`,
      });
      return;
    }
    const generation = this.beginNavigation();
    this.navigationBusy = true;
    this.update({
      runtimeSettings: { ...settings, loading: true },
      notice: "Saving workspace settings…",
    });
    try {
      const result = await this.client.updateRuntimeSettings({
        workspace: this.state.configuration.cwd,
        provider: provider.id,
        model: parsedModel.data,
        expectedRevision: settings.revision,
      });
      if (
        !this.isCurrentNavigation(generation) ||
        this.state.mode !== "settings_model"
      ) {
        return;
      }
      this.preferenceRevision = result.revision;
      this.persistedPreference = result.preference;
      const nextThreadConfiguration = {
        provider: result.preference.provider,
        model: result.preference.model,
      };
      const immediatelyActive = this.state.threadId === undefined;
      this.update({
        mode: "chat",
        configuration: immediatelyActive
          ? {
              ...this.state.configuration,
              provider: nextThreadConfiguration.provider,
              model: nextThreadConfiguration.model,
            }
          : this.state.configuration,
        nextThreadConfiguration,
        runtimeSettings: undefined,
        notice:
          runtimeSettingsResultNotice(result) ??
          (immediatelyActive
            ? `Using ${result.preference.provider}/${result.preference.model} for the next prompt.`
            : `Saved ${result.preference.provider}/${result.preference.model}; run /new to use it.`),
      });
    } catch (error) {
      if (!this.isCurrentNavigation(generation)) {
        return;
      }
      const current = this.state.runtimeSettings;
      if (current !== undefined) {
        const code = structuredErrorCode(error);
        this.update({
          runtimeSettings: { ...current, loading: false },
          notice:
            code === "SETTINGS_CHANGED"
              ? "Settings changed in another client. Your draft is preserved; press Ctrl+L to reload the revision."
              : `Could not save runtime settings: ${errorMessage(error)}`,
        });
      }
    } finally {
      if (this.isCurrentNavigation(generation)) {
        this.navigationBusy = false;
      }
    }
  }

  public async reloadRuntimeSettings(): Promise<void> {
    const settings = this.state.runtimeSettings;
    if (
      (this.state.mode !== "settings_provider" &&
        this.state.mode !== "settings_model") ||
      settings === undefined ||
      settings.loading ||
      this.navigationBusy
    ) {
      return;
    }
    const generation = this.beginNavigation();
    this.navigationBusy = true;
    this.update({
      runtimeSettings: { ...settings, loading: true },
      notice: "Reloading workspace settings…",
    });
    try {
      const result = await this.client.getRuntimeSettings({
        workspace: this.state.configuration.cwd,
      });
      if (!this.isCurrentNavigation(generation)) {
        return;
      }
      const current = this.state.runtimeSettings;
      if (current === undefined) {
        return;
      }
      this.preferenceRevision = result.revision;
      this.persistedPreference = result.preference;
      const {
        persistedPreference: _previousPreference,
        ...settingsWithoutPreference
      } = current;
      this.update({
        runtimeSettings: {
          ...settingsWithoutPreference,
          revision: result.revision,
          loading: false,
          ...(result.preference === undefined
            ? {}
            : { persistedPreference: result.preference }),
        },
        notice:
          runtimeSettingsResultNotice(result) ??
          "Reloaded the settings revision; your draft is unchanged.",
      });
    } catch (error) {
      if (!this.isCurrentNavigation(generation)) {
        return;
      }
      const current = this.state.runtimeSettings;
      if (current !== undefined) {
        this.update({
          runtimeSettings: { ...current, loading: false },
          notice: `Could not reload runtime settings: ${errorMessage(error)}`,
        });
      }
    } finally {
      if (this.isCurrentNavigation(generation)) {
        this.navigationBusy = false;
      }
    }
  }

  public closeRuntimeSettingsLevel(): void {
    this.cancelNavigation();
    const settings = this.state.runtimeSettings;
    if (this.state.mode === "settings_model" && settings !== undefined) {
      this.update({
        mode: "settings_provider",
        runtimeSettings: { ...settings, loading: false },
        notice: undefined,
      });
      return;
    }
    if (this.state.mode === "settings_provider") {
      this.update({
        mode: "chat",
        runtimeSettings: undefined,
        notice: undefined,
      });
    }
  }

  public async openCurrentThreadArtifacts(): Promise<void> {
    if (!this.canEditInput() || this.navigationBusy) {
      this.update({ notice: "Artifacts are available only while idle." });
      return;
    }
    if (this.state.threadId === undefined) {
      this.update({
        notice: "No current thread has referenced an artifact yet.",
      });
      return;
    }
    await this.openArtifactList("chat", this.state.threadId);
  }

  public async openPreviewArtifacts(): Promise<void> {
    const preview = this.state.threadBrowser?.preview;
    if (
      this.state.mode !== "thread_preview" ||
      preview === undefined ||
      this.navigationBusy
    ) {
      return;
    }
    await this.openArtifactList("thread_preview", preview.thread.threadId);
  }

  public selectArtifact(offset: -1 | 1): void {
    const navigation = this.state.artifactNavigation;
    const list = navigation?.list;
    if (
      this.state.mode !== "artifact_list" ||
      navigation === undefined ||
      list === undefined ||
      navigation.loading ||
      list.artifacts.length === 0
    ) {
      return;
    }
    const selectedIndex = Math.min(
      list.artifacts.length - 1,
      Math.max(0, list.selectedIndex + offset),
    );
    this.update({
      artifactNavigation: {
        ...navigation,
        list: {
          ...list,
          selectedIndex,
          scrollOffset: keepSelectionVisible(
            selectedIndex,
            list.scrollOffset,
            navigation.viewportHeight,
            list.artifacts.length,
          ),
        },
      },
      notice: undefined,
    });
  }

  public async pageArtifactList(
    action: "newer" | "older" | "home" | "end",
  ): Promise<void> {
    const navigation = this.state.artifactNavigation;
    const list = navigation?.list;
    if (
      this.state.mode !== "artifact_list" ||
      navigation === undefined ||
      list === undefined ||
      navigation.loading ||
      this.navigationBusy
    ) {
      return;
    }
    if (
      (action === "older" &&
        (!list.hasEarlier || list.nextBeforeSequence === undefined)) ||
      (action === "newer" && list.newerCursors.length === 0) ||
      (action === "home" && list.currentCursor === null) ||
      (action === "end" && !list.hasEarlier)
    ) {
      return;
    }

    const generation = this.beginNavigation();
    this.navigationBusy = true;
    this.update({
      artifactNavigation: { ...navigation, loading: true },
      notice: "Loading artifact list…",
    });
    try {
      let cursor = list.currentCursor;
      let newerCursors = [...list.newerCursors];
      let result;
      if (action === "newer") {
        cursor = newerCursors.at(-1) ?? null;
        newerCursors = newerCursors.slice(0, -1);
        result = await this.fetchArtifactList(navigation.threadId, cursor);
      } else if (action === "home") {
        cursor = null;
        newerCursors = [];
        result = await this.fetchArtifactList(navigation.threadId, cursor);
      } else {
        let hasEarlier = list.hasEarlier;
        let nextBeforeSequence = list.nextBeforeSequence;
        result = {
          artifacts: list.artifacts,
          hasEarlier,
          ...(nextBeforeSequence === undefined ? {} : { nextBeforeSequence }),
        };
        do {
          if (nextBeforeSequence === undefined) {
            break;
          }
          newerCursors.push(cursor);
          cursor = nextBeforeSequence;
          result = await this.fetchArtifactList(navigation.threadId, cursor);
          if (!this.isCurrentNavigation(generation)) {
            return;
          }
          hasEarlier = result.hasEarlier;
          nextBeforeSequence = result.nextBeforeSequence;
        } while (action === "end" && hasEarlier);
      }
      if (
        !this.isCurrentNavigation(generation) ||
        this.state.mode !== "artifact_list"
      ) {
        return;
      }
      const current = this.state.artifactNavigation;
      if (current === undefined) {
        return;
      }
      this.update({
        artifactNavigation: {
          ...current,
          loading: false,
          list: artifactListState(
            result,
            cursor,
            newerCursors,
            current.viewportHeight,
          ),
        },
        notice:
          result.artifacts.length === 0
            ? "No artifacts on this page."
            : undefined,
      });
    } catch (error) {
      const current = this.state.artifactNavigation;
      if (
        this.isCurrentNavigation(generation) &&
        current !== undefined &&
        this.state.mode === "artifact_list"
      ) {
        this.update({
          artifactNavigation: { ...current, loading: false },
          notice: `Could not load artifact list: ${errorMessage(error)}`,
        });
      }
    } finally {
      if (this.isCurrentNavigation(generation)) {
        this.navigationBusy = false;
      }
    }
  }

  public async openSelectedArtifact(): Promise<void> {
    const navigation = this.state.artifactNavigation;
    const list = navigation?.list;
    const selected = list?.artifacts[list.selectedIndex];
    if (
      this.state.mode !== "artifact_list" ||
      navigation === undefined ||
      list === undefined ||
      selected === undefined ||
      navigation.loading ||
      this.navigationBusy
    ) {
      return;
    }
    await this.openArtifactView(navigation, selected.artifact.id);
  }

  public async scrollArtifact(
    action: "up" | "down" | "page_up" | "page_down" | "home" | "end",
  ): Promise<void> {
    const navigation = this.state.artifactNavigation;
    const view = navigation?.view;
    if (
      this.state.mode !== "artifact_view" ||
      navigation === undefined ||
      view === undefined ||
      navigation.loading ||
      this.navigationBusy
    ) {
      return;
    }
    const maximum = maximumScrollOffset(
      view.rows.length,
      navigation.viewportHeight,
    );
    if (action === "up" || action === "down") {
      this.update({
        artifactNavigation: {
          ...navigation,
          view: {
            ...view,
            scrollOffset: Math.min(
              maximum,
              Math.max(0, view.scrollOffset + (action === "up" ? -1 : 1)),
            ),
          },
        },
        notice: undefined,
      });
      return;
    }
    if (action === "page_up" && !view.page.hasEarlier) {
      this.update({
        artifactNavigation: {
          ...navigation,
          view: { ...view, scrollOffset: 0 },
        },
      });
      return;
    }
    if (action === "page_down" && !view.page.hasLater) {
      this.update({
        artifactNavigation: {
          ...navigation,
          view: { ...view, scrollOffset: maximum },
        },
      });
      return;
    }
    const cursor =
      action === "page_up"
        ? { beforeByte: view.page.startByte }
        : action === "page_down"
          ? { afterByte: view.page.endByte }
          : action === "end"
            ? { beforeByte: view.page.totalBytes }
            : {};
    await this.loadArtifactRange(view.page.artifact.id, cursor);
  }

  public closeArtifactLevel(): void {
    const navigation = this.state.artifactNavigation;
    if (navigation === undefined) {
      return;
    }
    this.cancelNavigation();
    if (this.state.mode === "artifact_view" && navigation.list !== undefined) {
      const { view: _view, ...navigationWithoutView } = navigation;
      this.update({
        mode: "artifact_list",
        artifactNavigation: {
          ...navigationWithoutView,
          loading: false,
        },
        notice: undefined,
      });
      return;
    }
    if (
      this.state.mode === "artifact_view" ||
      this.state.mode === "artifact_list"
    ) {
      this.update({
        mode: navigation.origin,
        artifactNavigation: undefined,
        notice: undefined,
      });
    }
  }

  private async openArtifactList(
    origin: "chat" | "thread_preview",
    threadIdInput: string,
  ): Promise<void> {
    const threadId = threadIdSchema.parse(threadIdInput);
    const generation = this.beginNavigation();
    this.navigationBusy = true;
    const navigation: TuiArtifactNavigationState = {
      origin,
      threadId,
      loading: true,
      viewportHeight: this.viewportHeight,
      viewportWidth: this.viewportWidth,
    };
    this.update({
      mode: "artifact_list",
      artifactNavigation: navigation,
      notice: "Loading thread artifacts…",
    });
    try {
      const result = await this.fetchArtifactList(threadId, null);
      if (
        !this.isCurrentNavigation(generation) ||
        this.state.mode !== "artifact_list"
      ) {
        return;
      }
      const current = this.state.artifactNavigation;
      if (current === undefined) {
        return;
      }
      this.update({
        artifactNavigation: {
          ...current,
          loading: false,
          list: artifactListState(result, null, [], current.viewportHeight),
        },
        notice:
          result.artifacts.length === 0
            ? "This thread has no recorded artifacts."
            : undefined,
      });
    } catch (error) {
      if (this.isCurrentNavigation(generation)) {
        this.update({
          mode: origin,
          artifactNavigation: undefined,
          notice: `Could not load thread artifacts: ${errorMessage(error)}`,
        });
      }
    } finally {
      if (this.isCurrentNavigation(generation)) {
        this.navigationBusy = false;
      }
    }
  }

  private async openDirectArtifact(input: string): Promise<void> {
    if (!this.canEditInput() || this.navigationBusy) {
      this.update({ notice: "Artifacts are available only while idle." });
      return;
    }
    if (this.state.threadId === undefined) {
      this.update({ notice: "No current thread is selected." });
      return;
    }
    const parsed = artifactIdSchema.safeParse(input.trim());
    if (!parsed.success) {
      this.update({
        notice:
          "Artifact ID must use 'sha256:' followed by 64 lowercase hexadecimal characters.",
      });
      return;
    }
    const navigation: TuiArtifactNavigationState = {
      origin: "chat",
      threadId: threadIdSchema.parse(this.state.threadId),
      loading: false,
      viewportHeight: this.viewportHeight,
      viewportWidth: this.viewportWidth,
    };
    await this.openArtifactView(navigation, parsed.data);
  }

  private async openArtifactView(
    navigation: TuiArtifactNavigationState,
    artifactId: ArtifactId,
  ): Promise<void> {
    const generation = this.beginNavigation();
    this.navigationBusy = true;
    const { view: _view, ...navigationWithoutView } = navigation;
    this.update({
      mode: "artifact_view",
      artifactNavigation: { ...navigationWithoutView, loading: true },
      notice: "Loading artifact…",
    });
    try {
      const result = await this.client.readArtifact({
        workspace: this.state.configuration.cwd,
        threadId: navigation.threadId,
        artifactId,
        maxBytes: ARTIFACT_READ_DEFAULT_BYTES,
      });
      if (
        !this.isCurrentNavigation(generation) ||
        this.state.mode !== "artifact_view"
      ) {
        return;
      }
      const current = this.state.artifactNavigation;
      if (current === undefined) {
        return;
      }
      this.update({
        artifactNavigation: {
          ...current,
          loading: false,
          view: artifactViewState(
            result,
            current.viewportWidth,
            current.viewportHeight,
            "start",
          ),
        },
        notice: undefined,
      });
    } catch (error) {
      if (this.isCurrentNavigation(generation)) {
        if (navigation.list !== undefined) {
          this.update({
            mode: "artifact_list",
            artifactNavigation: { ...navigation, loading: false },
            notice: `Could not open artifact: ${errorMessage(error)}`,
          });
        } else {
          this.update({
            mode: navigation.origin,
            artifactNavigation: undefined,
            notice: `Could not open artifact: ${errorMessage(error)}`,
          });
        }
      }
    } finally {
      if (this.isCurrentNavigation(generation)) {
        this.navigationBusy = false;
      }
    }
  }

  private async loadArtifactRange(
    artifactId: ArtifactId,
    cursor: { beforeByte?: number; afterByte?: number },
  ): Promise<void> {
    const navigation = this.state.artifactNavigation;
    const view = navigation?.view;
    if (navigation === undefined || view === undefined) {
      return;
    }
    const generation = this.beginNavigation();
    this.navigationBusy = true;
    this.update({
      artifactNavigation: { ...navigation, loading: true },
      notice: "Loading artifact range…",
    });
    try {
      const result = await this.client.readArtifact({
        workspace: this.state.configuration.cwd,
        threadId: navigation.threadId,
        artifactId,
        ...cursor,
        maxBytes: ARTIFACT_READ_DEFAULT_BYTES,
      });
      if (
        !this.isCurrentNavigation(generation) ||
        this.state.mode !== "artifact_view"
      ) {
        return;
      }
      const current = this.state.artifactNavigation;
      if (current === undefined) {
        return;
      }
      this.update({
        artifactNavigation: {
          ...current,
          loading: false,
          view: artifactViewState(
            result,
            current.viewportWidth,
            current.viewportHeight,
            cursor.beforeByte === undefined ? "start" : "end",
          ),
        },
        notice: undefined,
      });
    } catch (error) {
      const current = this.state.artifactNavigation;
      if (
        this.isCurrentNavigation(generation) &&
        current !== undefined &&
        this.state.mode === "artifact_view"
      ) {
        this.update({
          artifactNavigation: { ...current, loading: false },
          notice: `Could not load artifact range: ${errorMessage(error)}`,
        });
      }
    } finally {
      if (this.isCurrentNavigation(generation)) {
        this.navigationBusy = false;
      }
    }
  }

  private fetchArtifactList(threadId: ThreadId, beforeSequence: number | null) {
    return this.client.listThreadArtifacts({
      workspace: this.state.configuration.cwd,
      threadId,
      ...(beforeSequence === null ? {} : { beforeSequence }),
    });
  }

  public async openCurrentThreadContext(): Promise<void> {
    if (!this.canEditInput() || this.navigationBusy) {
      this.update({
        notice: "Context inspection is available only while idle.",
      });
      return;
    }
    if (this.state.threadId === undefined) {
      this.update({ notice: "No current thread is selected." });
      return;
    }
    await this.openContextList("chat", this.state.threadId);
  }

  public async openPreviewContext(): Promise<void> {
    const preview = this.state.threadBrowser?.preview;
    if (
      this.state.mode !== "thread_preview" ||
      preview === undefined ||
      this.navigationBusy
    ) {
      return;
    }
    await this.openContextList("thread_preview", preview.thread.threadId);
  }

  public selectContextRequest(offset: -1 | 1): void {
    const navigation = this.state.contextNavigation;
    const list = navigation?.list;
    if (
      this.state.mode !== "context_list" ||
      navigation === undefined ||
      list === undefined ||
      navigation.loading ||
      list.requests.length === 0
    ) {
      return;
    }
    const selectedIndex = Math.min(
      list.requests.length - 1,
      Math.max(0, list.selectedIndex + offset),
    );
    this.update({
      contextNavigation: {
        ...navigation,
        list: {
          ...list,
          selectedIndex,
          scrollOffset: keepSelectionVisible(
            selectedIndex,
            list.scrollOffset,
            navigation.viewportHeight,
            list.requests.length,
          ),
        },
      },
      notice: undefined,
    });
  }

  public async pageContextList(
    action: "newer" | "older" | "home" | "end",
  ): Promise<void> {
    const navigation = this.state.contextNavigation;
    const list = navigation?.list;
    if (
      this.state.mode !== "context_list" ||
      navigation === undefined ||
      list === undefined ||
      navigation.loading ||
      this.navigationBusy
    ) {
      return;
    }
    if (
      (action === "older" &&
        (!list.hasEarlier || list.nextBeforeSequence === undefined)) ||
      (action === "newer" && list.newerCursors.length === 0) ||
      (action === "home" && list.currentCursor === null) ||
      (action === "end" && !list.hasEarlier)
    ) {
      return;
    }
    const generation = this.beginNavigation();
    this.navigationBusy = true;
    this.update({
      contextNavigation: { ...navigation, loading: true },
      notice: "Loading context requests…",
    });
    try {
      let cursor = list.currentCursor;
      let newerCursors = [...list.newerCursors];
      let result;
      if (action === "newer") {
        cursor = newerCursors.at(-1) ?? null;
        newerCursors = newerCursors.slice(0, -1);
        result = await this.fetchContextList(navigation.threadId, cursor);
      } else if (action === "home") {
        cursor = null;
        newerCursors = [];
        result = await this.fetchContextList(navigation.threadId, cursor);
      } else {
        let hasEarlier = list.hasEarlier;
        let nextBeforeSequence = list.nextBeforeSequence;
        result = {
          requests: list.requests,
          hasEarlier,
          ...(nextBeforeSequence === undefined ? {} : { nextBeforeSequence }),
        };
        do {
          if (nextBeforeSequence === undefined) {
            break;
          }
          newerCursors.push(cursor);
          cursor = nextBeforeSequence;
          result = await this.fetchContextList(navigation.threadId, cursor);
          if (!this.isCurrentNavigation(generation)) {
            return;
          }
          hasEarlier = result.hasEarlier;
          nextBeforeSequence = result.nextBeforeSequence;
        } while (action === "end" && hasEarlier);
      }
      if (
        !this.isCurrentNavigation(generation) ||
        this.state.mode !== "context_list"
      ) {
        return;
      }
      const current = this.state.contextNavigation;
      if (current === undefined) {
        return;
      }
      this.update({
        contextNavigation: {
          ...current,
          loading: false,
          list: contextListState(
            result,
            cursor,
            newerCursors,
            current.viewportHeight,
          ),
        },
        notice:
          result.requests.length === 0
            ? "No context requests on this page."
            : undefined,
      });
    } catch (error) {
      const current = this.state.contextNavigation;
      if (
        this.isCurrentNavigation(generation) &&
        current !== undefined &&
        this.state.mode === "context_list"
      ) {
        this.update({
          contextNavigation: { ...current, loading: false },
          notice: `Could not load context requests: ${errorMessage(error)}`,
        });
      }
    } finally {
      if (this.isCurrentNavigation(generation)) {
        this.navigationBusy = false;
      }
    }
  }

  public async openSelectedContext(): Promise<void> {
    const navigation = this.state.contextNavigation;
    const list = navigation?.list;
    const selected = list?.requests[list.selectedIndex];
    if (
      this.state.mode !== "context_list" ||
      navigation === undefined ||
      list === undefined ||
      selected === undefined ||
      navigation.loading ||
      this.navigationBusy
    ) {
      return;
    }
    const generation = this.beginNavigation();
    this.navigationBusy = true;
    this.update({
      mode: "context_detail",
      contextNavigation: { ...navigation, loading: true },
      notice: "Loading context detail…",
    });
    try {
      const result = await this.client.readContext({
        workspace: this.state.configuration.cwd,
        threadId: navigation.threadId,
        anchorSequence: selected.anchorSequence,
      });
      if (
        !this.isCurrentNavigation(generation) ||
        this.getSnapshot().mode !== "context_detail"
      ) {
        return;
      }
      const current = this.state.contextNavigation;
      if (current === undefined) {
        return;
      }
      this.update({
        contextNavigation: {
          ...current,
          loading: false,
          detail: {
            result,
            selectedSourceIndex: 0,
            sourceScrollOffset: 0,
          },
        },
        notice: undefined,
      });
    } catch (error) {
      if (this.isCurrentNavigation(generation)) {
        this.update({
          mode: "context_list",
          contextNavigation: { ...navigation, loading: false },
          notice: `Could not load context detail: ${errorMessage(error)}`,
        });
      }
    } finally {
      if (this.isCurrentNavigation(generation)) {
        this.navigationBusy = false;
      }
    }
  }

  public selectContextInstructionSource(offset: -1 | 1): void {
    const navigation = this.state.contextNavigation;
    const detail = navigation?.detail;
    const sources = detail?.result.instructions.sources;
    if (
      this.state.mode !== "context_detail" ||
      navigation === undefined ||
      detail === undefined ||
      sources === undefined ||
      navigation.loading ||
      sources.length === 0
    ) {
      return;
    }
    const selectedSourceIndex = Math.min(
      sources.length - 1,
      Math.max(0, detail.selectedSourceIndex + offset),
    );
    this.update({
      contextNavigation: {
        ...navigation,
        detail: {
          ...detail,
          selectedSourceIndex,
          sourceScrollOffset: keepSelectionVisible(
            selectedSourceIndex,
            detail.sourceScrollOffset,
            navigation.viewportHeight,
            sources.length,
          ),
        },
      },
      notice: undefined,
    });
  }

  public async openSelectedContextInstruction(): Promise<void> {
    const navigation = this.state.contextNavigation;
    const detail = navigation?.detail;
    const source =
      detail?.result.instructions.sources[detail.selectedSourceIndex];
    if (
      this.state.mode !== "context_detail" ||
      navigation === undefined ||
      detail === undefined ||
      source === undefined ||
      navigation.loading ||
      this.navigationBusy
    ) {
      return;
    }
    if (source.sourceId === undefined) {
      this.update({ notice: "This historical instruction source is missing." });
      return;
    }
    const generation = this.beginNavigation();
    this.navigationBusy = true;
    const { instructionView: _instructionView, ...withoutInstructionView } =
      navigation;
    this.update({
      mode: "context_instruction_view",
      contextNavigation: { ...withoutInstructionView, loading: true },
      notice: "Loading current instruction source…",
    });
    try {
      const result = await this.client.readContextInstruction({
        workspace: this.state.configuration.cwd,
        threadId: navigation.threadId,
        anchorSequence: detail.result.request.anchorSequence,
        sourceId: source.sourceId,
        maxBytes: CONTEXT_INSTRUCTION_READ_DEFAULT_BYTES,
      });
      if (
        !this.isCurrentNavigation(generation) ||
        this.getSnapshot().mode !== "context_instruction_view"
      ) {
        return;
      }
      const current = this.state.contextNavigation;
      if (current === undefined) {
        return;
      }
      this.update({
        contextNavigation: {
          ...current,
          loading: false,
          instructionView: contextInstructionViewState(
            result,
            current.viewportWidth,
            current.viewportHeight,
            "start",
          ),
        },
        notice: undefined,
      });
    } catch (error) {
      if (this.isCurrentNavigation(generation)) {
        this.update({
          mode: "context_detail",
          contextNavigation: { ...navigation, loading: false },
          notice: `Could not open instruction source: ${errorMessage(error)}`,
        });
      }
    } finally {
      if (this.isCurrentNavigation(generation)) {
        this.navigationBusy = false;
      }
    }
  }

  public async scrollContextInstruction(
    action: "up" | "down" | "page_up" | "page_down" | "home" | "end",
  ): Promise<void> {
    const navigation = this.state.contextNavigation;
    const view = navigation?.instructionView;
    if (
      this.state.mode !== "context_instruction_view" ||
      navigation === undefined ||
      view === undefined ||
      navigation.loading ||
      this.navigationBusy
    ) {
      return;
    }
    const maximum = maximumScrollOffset(
      view.rows.length,
      navigation.viewportHeight,
    );
    if (action === "up" || action === "down") {
      this.update({
        contextNavigation: {
          ...navigation,
          instructionView: {
            ...view,
            scrollOffset: Math.min(
              maximum,
              Math.max(0, view.scrollOffset + (action === "up" ? -1 : 1)),
            ),
          },
        },
        notice: undefined,
      });
      return;
    }
    if (action === "page_up" && !view.page.hasEarlier) {
      this.update({
        contextNavigation: {
          ...navigation,
          instructionView: { ...view, scrollOffset: 0 },
        },
      });
      return;
    }
    if (action === "page_down" && !view.page.hasLater) {
      this.update({
        contextNavigation: {
          ...navigation,
          instructionView: { ...view, scrollOffset: maximum },
        },
      });
      return;
    }
    const cursor =
      action === "page_up"
        ? { beforeByte: view.page.startByte }
        : action === "page_down"
          ? { afterByte: view.page.endByte }
          : action === "end"
            ? { beforeByte: view.page.totalBytes }
            : {};
    await this.loadContextInstructionRange(view.page.sourceId, cursor);
  }

  public closeContextLevel(): void {
    const navigation = this.state.contextNavigation;
    if (navigation === undefined) {
      return;
    }
    this.cancelNavigation();
    if (
      this.state.mode === "context_instruction_view" &&
      navigation.detail !== undefined
    ) {
      const { instructionView: _view, ...withoutView } = navigation;
      this.update({
        mode: "context_detail",
        contextNavigation: { ...withoutView, loading: false },
        notice: undefined,
      });
      return;
    }
    if (this.state.mode === "context_detail" && navigation.list !== undefined) {
      const {
        detail: _detail,
        instructionView: _view,
        ...withoutDetail
      } = navigation;
      this.update({
        mode: "context_list",
        contextNavigation: { ...withoutDetail, loading: false },
        notice: undefined,
      });
      return;
    }
    if (
      this.state.mode === "context_instruction_view" ||
      this.state.mode === "context_detail" ||
      this.state.mode === "context_list"
    ) {
      this.update({
        mode: navigation.origin,
        contextNavigation: undefined,
        notice: undefined,
      });
    }
  }

  private async openContextList(
    origin: "chat" | "thread_preview",
    threadIdInput: string,
  ): Promise<void> {
    const threadId = threadIdSchema.parse(threadIdInput);
    const generation = this.beginNavigation();
    this.navigationBusy = true;
    const navigation: TuiContextNavigationState = {
      origin,
      threadId,
      loading: true,
      viewportHeight: this.viewportHeight,
      viewportWidth: this.viewportWidth,
    };
    this.update({
      mode: "context_list",
      contextNavigation: navigation,
      notice: "Loading prepared context requests…",
    });
    try {
      const result = await this.fetchContextList(threadId, null);
      if (
        !this.isCurrentNavigation(generation) ||
        this.state.mode !== "context_list"
      ) {
        return;
      }
      const current = this.state.contextNavigation;
      if (current === undefined) {
        return;
      }
      this.update({
        contextNavigation: {
          ...current,
          loading: false,
          list: contextListState(result, null, [], current.viewportHeight),
        },
        notice:
          result.requests.length === 0
            ? "This thread has no inspectable model requests."
            : undefined,
      });
    } catch (error) {
      if (this.isCurrentNavigation(generation)) {
        this.update({
          mode: origin,
          contextNavigation: undefined,
          notice: `Could not load prepared context: ${errorMessage(error)}`,
        });
      }
    } finally {
      if (this.isCurrentNavigation(generation)) {
        this.navigationBusy = false;
      }
    }
  }

  private async loadContextInstructionRange(
    sourceId: string,
    cursor: { beforeByte?: number; afterByte?: number },
  ): Promise<void> {
    const navigation = this.state.contextNavigation;
    const detail = navigation?.detail;
    const view = navigation?.instructionView;
    if (
      navigation === undefined ||
      detail === undefined ||
      view === undefined
    ) {
      return;
    }
    const generation = this.beginNavigation();
    this.navigationBusy = true;
    this.update({
      contextNavigation: { ...navigation, loading: true },
      notice: "Loading instruction range…",
    });
    try {
      const result = await this.client.readContextInstruction({
        workspace: this.state.configuration.cwd,
        threadId: navigation.threadId,
        anchorSequence: detail.result.request.anchorSequence,
        sourceId,
        ...cursor,
        maxBytes: CONTEXT_INSTRUCTION_READ_DEFAULT_BYTES,
      });
      if (
        !this.isCurrentNavigation(generation) ||
        this.state.mode !== "context_instruction_view"
      ) {
        return;
      }
      const current = this.state.contextNavigation;
      if (current === undefined) {
        return;
      }
      this.update({
        contextNavigation: {
          ...current,
          loading: false,
          instructionView: contextInstructionViewState(
            result,
            current.viewportWidth,
            current.viewportHeight,
            cursor.beforeByte === undefined ? "start" : "end",
          ),
        },
        notice: undefined,
      });
    } catch (error) {
      const current = this.state.contextNavigation;
      if (
        this.isCurrentNavigation(generation) &&
        current !== undefined &&
        this.state.mode === "context_instruction_view"
      ) {
        this.update({
          contextNavigation: { ...current, loading: false },
          notice: `Could not load instruction range: ${errorMessage(error)}`,
        });
      }
    } finally {
      if (this.isCurrentNavigation(generation)) {
        this.navigationBusy = false;
      }
    }
  }

  private fetchContextList(threadId: ThreadId, beforeSequence: number | null) {
    return this.client.listThreadContexts({
      workspace: this.state.configuration.cwd,
      threadId,
      ...(beforeSequence === null ? {} : { beforeSequence }),
    });
  }

  public async openThreadBrowser(): Promise<void> {
    if (!this.canBrowseThreads() || this.navigationBusy) {
      this.update({ notice: "Thread browsing is available only while idle." });
      return;
    }
    const generation = this.beginNavigation();
    this.navigationBusy = true;
    this.update({ notice: "Loading recent threads…" });
    try {
      const result = await this.client.listThreads({
        workspace: this.state.configuration.cwd,
        limit: THREAD_BROWSER_LIMIT,
      });
      if (!this.isCurrentNavigation(generation) || !this.canBrowseThreads()) {
        return;
      }
      this.update({
        mode: "thread_list",
        threadBrowser: {
          threads: result.threads,
          selectedIndex: 0,
          listScrollOffset: 0,
          viewportHeight: DEFAULT_VIEWPORT_HEIGHT,
          loading: false,
        },
        notice:
          result.diagnostics.length === 0
            ? undefined
            : `${result.diagnostics.length} thread index diagnostic(s) reported.`,
      });
    } catch (error) {
      if (!this.isCurrentNavigation(generation)) {
        return;
      }
      this.update({
        mode: "chat",
        threadBrowser: undefined,
        notice: `Could not list threads: ${errorMessage(error)}`,
      });
    } finally {
      if (this.isCurrentNavigation(generation)) {
        this.navigationBusy = false;
      }
    }
  }

  public selectThread(offset: -1 | 1): void {
    const browser = this.state.threadBrowser;
    if (
      (this.state.mode !== "thread_list" &&
        this.state.mode !== "thread_search_results") ||
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
    const listScrollOffset = keepSelectionVisible(
      selectedIndex,
      browser.listScrollOffset,
      browser.viewportHeight,
      browser.threads.length,
    );
    this.update({
      threadBrowser: { ...browser, selectedIndex, listScrollOffset },
      notice: undefined,
    });
  }

  public pageThreadList(direction: -1 | 1): void {
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
      Math.max(0, browser.selectedIndex + direction * browser.viewportHeight),
    );
    this.update({
      threadBrowser: {
        ...browser,
        selectedIndex,
        listScrollOffset: keepSelectionVisible(
          selectedIndex,
          browser.listScrollOffset,
          browser.viewportHeight,
          browser.threads.length,
        ),
      },
      notice: undefined,
    });
  }

  public enterThreadSearch(): void {
    const browser = this.state.threadBrowser;
    if (
      this.state.mode !== "thread_list" ||
      browser === undefined ||
      browser.loading ||
      this.navigationBusy
    ) {
      return;
    }
    this.update({
      mode: "thread_search_input",
      threadBrowser: {
        ...browser,
        search:
          browser.search === undefined
            ? emptySearchState("thread_list")
            : {
                ...browser.search,
                input: browser.search.query,
                loading: false,
              },
      },
      notice: undefined,
    });
  }

  public setThreadSearchInput(input: string): void {
    const browser = this.state.threadBrowser;
    const search = browser?.search;
    if (
      this.state.mode !== "thread_search_input" ||
      browser === undefined ||
      search === undefined ||
      search.loading
    ) {
      return;
    }
    this.update({
      threadBrowser: {
        ...browser,
        search: {
          ...search,
          input: boundText(input, 256),
        },
      },
      notice: undefined,
    });
  }

  public async submitThreadSearch(): Promise<void> {
    const search = this.state.threadBrowser?.search;
    if (this.state.mode !== "thread_search_input" || search === undefined) {
      return;
    }
    await this.openThreadSearch(search.input, search.origin);
  }

  public selectSearchResult(offset: -1 | 1): void {
    const browser = this.state.threadBrowser;
    const search = browser?.search;
    if (
      this.state.mode !== "thread_search_results" ||
      browser === undefined ||
      search === undefined ||
      search.loading ||
      search.matches.length === 0
    ) {
      return;
    }
    const selectedIndex = Math.min(
      search.matches.length - 1,
      Math.max(0, search.selectedIndex + offset),
    );
    this.update({
      threadBrowser: {
        ...browser,
        search: {
          ...search,
          selectedIndex,
          scrollOffset: keepSelectionVisible(
            selectedIndex,
            search.scrollOffset,
            browser.viewportHeight,
            search.matches.length,
          ),
        },
      },
      notice: undefined,
    });
  }

  public async pageSearchResults(direction: -1 | 1): Promise<void> {
    const browser = this.state.threadBrowser;
    const search = browser?.search;
    if (
      this.state.mode !== "thread_search_results" ||
      browser === undefined ||
      search === undefined ||
      search.loading ||
      search.matches.length === 0
    ) {
      return;
    }
    if (
      direction === 1 &&
      search.hasMore &&
      search.selectedIndex + browser.viewportHeight >= search.matches.length
    ) {
      const loaded = await this.loadMoreSearchResults();
      if (!loaded) {
        return;
      }
    }
    const currentBrowser = this.state.threadBrowser;
    const currentSearch = currentBrowser?.search;
    if (
      this.state.mode !== "thread_search_results" ||
      currentBrowser === undefined ||
      currentSearch === undefined ||
      currentSearch.matches.length === 0
    ) {
      return;
    }
    const selectedIndex = Math.min(
      currentSearch.matches.length - 1,
      Math.max(
        0,
        currentSearch.selectedIndex + direction * currentBrowser.viewportHeight,
      ),
    );
    this.update({
      threadBrowser: {
        ...currentBrowser,
        search: {
          ...currentSearch,
          selectedIndex,
          scrollOffset: keepSelectionVisible(
            selectedIndex,
            currentSearch.scrollOffset,
            currentBrowser.viewportHeight,
            currentSearch.matches.length,
          ),
        },
      },
      notice: undefined,
    });
  }

  public async previewSelectedSearchResult(): Promise<void> {
    const browser = this.state.threadBrowser;
    const search = browser?.search;
    const match = search?.matches[search.selectedIndex];
    if (
      this.state.mode !== "thread_search_results" ||
      browser === undefined ||
      search === undefined ||
      match === undefined ||
      search.loading ||
      this.navigationBusy
    ) {
      return;
    }
    const generation = this.beginNavigation();
    this.navigationBusy = true;
    this.update({
      threadBrowser: {
        ...browser,
        loading: true,
        search: { ...search, loading: true },
      },
      notice: `Loading search match in ${match.threadId}…`,
    });
    try {
      const metadata = await this.client.getThread({
        threadId: match.threadId,
      });
      if (metadata.thread.workspaceRoot !== this.state.configuration.cwd) {
        throw new Error(
          `Thread workspace '${metadata.thread.workspaceRoot ?? "unknown"}' does not match '${this.state.configuration.cwd}'.`,
        );
      }
      const [before, after] = await Promise.all([
        this.client.readThreadEvents({
          threadId: match.threadId,
          beforeSequence: match.sequence + 1,
          limit: 200,
        }),
        this.client.readThreadEvents({
          threadId: match.threadId,
          afterSequence: match.sequence,
          limit: 200,
        }),
      ]);
      if (!this.isCurrentNavigation(generation)) {
        return;
      }
      const events = mergeEventWindow(before.events, after.events, "around");
      const matchedEvent = events.find(
        (event) => event.sequence === match.sequence,
      );
      if (
        matchedEvent === undefined ||
        threadSearchKindForEvent(matchedEvent, events) !== match.kind
      ) {
        throw new Error(
          "The indexed search match no longer exists in authoritative history; rerun the search.",
        );
      }
      const projection = projectHistoryWindow(events, match.sequence, "center");
      const entries = projection.entries.map((entry) =>
        this.withTranscriptId({
          ...entry,
          ...(entry.sequence === match.sequence ? { matched: true } : {}),
        }),
      );
      const matchIndex = entries.findIndex((entry) => entry.matched === true);
      const currentBrowser = this.state.threadBrowser;
      if (
        this.state.mode !== "thread_search_results" ||
        currentBrowser === undefined
      ) {
        return;
      }
      this.update({
        mode: "thread_preview",
        threadBrowser: {
          ...currentBrowser,
          loading: false,
          search: { ...search, loading: false },
          preview: {
            source: "search_results",
            thread: metadata.thread,
            events,
            entries,
            scrollOffset: Math.max(
              0,
              matchIndex - Math.floor(currentBrowser.viewportHeight / 2),
            ),
            hasEarlier: before.hasEarlier,
            hasLater: after.hasLater,
            hasProjectedEarlier: projection.hasEarlier,
            hasProjectedLater: projection.hasLater,
            match,
            query: search.query,
          },
        },
        notice:
          metadata.diagnostics.length === 0
            ? undefined
            : `${metadata.diagnostics.length} thread index diagnostic(s) reported.`,
      });
    } catch (error) {
      const currentBrowser = this.state.threadBrowser;
      const currentSearch = currentBrowser?.search;
      if (
        this.isCurrentNavigation(generation) &&
        this.state.mode === "thread_search_results" &&
        currentBrowser !== undefined &&
        currentSearch !== undefined
      ) {
        this.update({
          threadBrowser: {
            ...currentBrowser,
            loading: false,
            search: { ...currentSearch, loading: false },
          },
          notice: `Could not load search match: ${errorMessage(error)}`,
        });
      }
    } finally {
      if (this.isCurrentNavigation(generation)) {
        this.navigationBusy = false;
      }
    }
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
    if (this.navigationBusy) {
      return;
    }
    const generation = this.beginNavigation();
    this.navigationBusy = true;
    this.update({
      threadBrowser: { ...browser, loading: true },
      notice: `Loading thread ${thread.threadId}…`,
    });
    try {
      const result = await this.client.readThreadEvents({
        threadId: thread.threadId,
        limit: 200,
      });
      if (
        !this.isCurrentNavigation(generation) ||
        this.state.mode !== "thread_list"
      ) {
        return;
      }
      const currentBrowser = this.state.threadBrowser;
      if (currentBrowser === undefined) {
        return;
      }
      const projection = projectHistoryWindow(result.events, undefined, "end");
      const entries = projection.entries.map((entry) =>
        this.withTranscriptId(entry),
      );
      this.update({
        mode: "thread_preview",
        threadBrowser: {
          ...currentBrowser,
          loading: false,
          preview: {
            source: "list",
            thread,
            events: result.events,
            entries,
            scrollOffset: Math.max(
              0,
              entries.length - currentBrowser.viewportHeight,
            ),
            hasEarlier: result.hasEarlier,
            hasLater: result.hasLater,
            hasProjectedEarlier: projection.hasEarlier,
            hasProjectedLater: projection.hasLater,
          },
        },
        notice: undefined,
      });
    } catch (error) {
      const currentBrowser = this.state.threadBrowser;
      if (
        !this.isCurrentNavigation(generation) ||
        this.state.mode !== "thread_list" ||
        currentBrowser === undefined
      ) {
        return;
      }
      this.update({
        threadBrowser: { ...currentBrowser, loading: false },
        notice: `Could not load thread history: ${errorMessage(error)}`,
      });
    } finally {
      if (this.isCurrentNavigation(generation)) {
        this.navigationBusy = false;
      }
    }
  }

  public closeThreadBrowserLevel(): void {
    this.cancelNavigation();
    const browser = this.state.threadBrowser;
    if (this.state.mode === "thread_preview" && browser !== undefined) {
      if (browser.preview?.source === "search_results") {
        const { preview: _preview, ...searchState } = browser;
        this.update({
          mode: "thread_search_results",
          threadBrowser: { ...searchState, loading: false },
          notice: undefined,
        });
        return;
      }
      const { preview: _preview, ...listState } = browser;
      this.update({
        mode: "thread_list",
        threadBrowser: { ...listState, loading: false },
        notice: undefined,
      });
      return;
    }
    if (
      this.state.mode === "thread_search_results" &&
      browser?.search !== undefined
    ) {
      if (browser.search.origin === "chat") {
        this.update({
          mode: "chat",
          threadBrowser: undefined,
          notice: undefined,
        });
      } else {
        this.update({
          mode: "thread_search_input",
          threadBrowser: {
            ...browser,
            loading: false,
            search: { ...browser.search, loading: false },
          },
          notice: undefined,
        });
      }
      return;
    }
    if (this.state.mode === "thread_search_input" && browser !== undefined) {
      if (browser.search?.origin === "chat") {
        this.update({
          mode: "chat",
          threadBrowser: undefined,
          notice: undefined,
        });
      } else {
        this.update({
          mode: "thread_list",
          threadBrowser: { ...browser, loading: false },
          notice: undefined,
        });
      }
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
      browser.loading ||
      this.navigationBusy
    ) {
      return;
    }
    if (preview.thread.status === "invalid") {
      this.update({ notice: "Invalid threads cannot be resumed." });
      return;
    }
    const generation = this.beginNavigation();
    this.navigationBusy = true;
    this.update({
      threadBrowser: { ...browser, loading: true },
      notice: `Checking thread ${preview.thread.threadId}…`,
    });
    try {
      const result = await this.client.getThread({
        threadId: preview.thread.threadId,
      });
      if (
        !this.isCurrentNavigation(generation) ||
        this.state.mode !== "thread_preview"
      ) {
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
        this.isCurrentNavigation(generation) &&
        this.state.mode === "thread_preview" &&
        currentBrowser !== undefined
      ) {
        this.update({
          threadBrowser: { ...currentBrowser, loading: false },
          notice: `Could not resume thread: ${errorMessage(error)}`,
        });
      }
    } finally {
      if (this.isCurrentNavigation(generation)) {
        this.navigationBusy = false;
      }
    }
  }

  public setViewportHeight(
    height: number,
    width = DEFAULT_VIEWPORT_WIDTH,
  ): void {
    const browser = this.state.threadBrowser;
    const artifactNavigation = this.state.artifactNavigation;
    const contextNavigation = this.state.contextNavigation;
    if (!Number.isFinite(height) || !Number.isFinite(width)) {
      return;
    }
    const viewportHeight = Math.min(
      MAXIMUM_VIEWPORT_HEIGHT,
      Math.max(MINIMUM_VIEWPORT_HEIGHT, Math.floor(height)),
    );
    const viewportWidth = Math.min(
      MAXIMUM_VIEWPORT_WIDTH,
      Math.max(MINIMUM_VIEWPORT_WIDTH, Math.floor(width)),
    );
    this.viewportHeight = viewportHeight;
    this.viewportWidth = viewportWidth;
    if (
      browser === undefined &&
      artifactNavigation === undefined &&
      contextNavigation === undefined
    ) {
      return;
    }
    const search = browser?.search;
    const preview = browser?.preview;
    const artifactList = artifactNavigation?.list;
    const artifactView = artifactNavigation?.view;
    const contextList = contextNavigation?.list;
    const contextDetail = contextNavigation?.detail;
    const contextView = contextNavigation?.instructionView;
    this.update({
      ...(browser === undefined
        ? {}
        : {
            threadBrowser: {
              ...browser,
              viewportHeight,
              listScrollOffset: keepSelectionVisible(
                browser.selectedIndex,
                browser.listScrollOffset,
                viewportHeight,
                browser.threads.length,
              ),
              ...(search === undefined
                ? {}
                : {
                    search: {
                      ...search,
                      scrollOffset: keepSelectionVisible(
                        search.selectedIndex,
                        search.scrollOffset,
                        viewportHeight,
                        search.matches.length,
                      ),
                    },
                  }),
              ...(preview === undefined
                ? {}
                : {
                    preview: {
                      ...preview,
                      scrollOffset: Math.min(
                        preview.scrollOffset,
                        maximumScrollOffset(
                          preview.entries.length,
                          viewportHeight,
                        ),
                      ),
                    },
                  }),
            },
          }),
      ...(artifactNavigation === undefined
        ? {}
        : {
            artifactNavigation: {
              ...artifactNavigation,
              viewportHeight,
              viewportWidth,
              ...(artifactList === undefined
                ? {}
                : {
                    list: {
                      ...artifactList,
                      scrollOffset: keepSelectionVisible(
                        artifactList.selectedIndex,
                        artifactList.scrollOffset,
                        viewportHeight,
                        artifactList.artifacts.length,
                      ),
                    },
                  }),
              ...(artifactView === undefined
                ? {}
                : {
                    view: (() => {
                      const rows = artifactPresentationRows(
                        artifactView.page.content,
                        viewportWidth,
                      );
                      return {
                        ...artifactView,
                        rows,
                        scrollOffset: Math.min(
                          artifactView.scrollOffset,
                          maximumScrollOffset(rows.length, viewportHeight),
                        ),
                      };
                    })(),
                  }),
            },
          }),
      ...(contextNavigation === undefined
        ? {}
        : {
            contextNavigation: {
              ...contextNavigation,
              viewportHeight,
              viewportWidth,
              ...(contextList === undefined
                ? {}
                : {
                    list: {
                      ...contextList,
                      scrollOffset: keepSelectionVisible(
                        contextList.selectedIndex,
                        contextList.scrollOffset,
                        viewportHeight,
                        contextList.requests.length,
                      ),
                    },
                  }),
              ...(contextDetail === undefined
                ? {}
                : {
                    detail: {
                      ...contextDetail,
                      sourceScrollOffset: keepSelectionVisible(
                        contextDetail.selectedSourceIndex,
                        contextDetail.sourceScrollOffset,
                        viewportHeight,
                        contextDetail.result.instructions.sources.length,
                      ),
                    },
                  }),
              ...(contextView === undefined
                ? {}
                : {
                    instructionView: (() => {
                      const rows = artifactPresentationRows(
                        contextView.page.content,
                        viewportWidth,
                      );
                      return {
                        ...contextView,
                        rows,
                        scrollOffset: Math.min(
                          contextView.scrollOffset,
                          maximumScrollOffset(rows.length, viewportHeight),
                        ),
                      };
                    })(),
                  }),
            },
          }),
    });
  }

  public async scrollPreview(
    action: "up" | "down" | "page_up" | "page_down" | "home" | "end",
  ): Promise<void> {
    const browser = this.state.threadBrowser;
    const preview = browser?.preview;
    if (
      this.state.mode !== "thread_preview" ||
      browser === undefined ||
      preview === undefined ||
      browser.loading ||
      this.navigationBusy
    ) {
      return;
    }
    if (action === "home") {
      await this.loadPreviewBoundary("older", true);
      return;
    }
    if (action === "end") {
      await this.loadLatestPreview();
      return;
    }
    const amount =
      action === "page_up" || action === "page_down"
        ? browser.viewportHeight
        : 1;
    const maximum = maximumScrollOffset(
      preview.entries.length,
      browser.viewportHeight,
    );
    if (action === "up" || action === "page_up") {
      if (preview.scrollOffset > 0) {
        this.update({
          threadBrowser: {
            ...browser,
            preview: {
              ...preview,
              scrollOffset: Math.max(0, preview.scrollOffset - amount),
            },
          },
          notice: undefined,
        });
        return;
      }
      if (preview.hasProjectedEarlier) {
        this.reprojectPreview("older");
        return;
      }
      if (preview.hasEarlier) {
        await this.loadPreviewBoundary("older", false);
      }
      return;
    }
    if (preview.scrollOffset < maximum) {
      this.update({
        threadBrowser: {
          ...browser,
          preview: {
            ...preview,
            scrollOffset: Math.min(maximum, preview.scrollOffset + amount),
          },
        },
        notice: undefined,
      });
      return;
    }
    if (preview.hasProjectedLater) {
      this.reprojectPreview("newer");
      return;
    }
    if (preview.hasLater) {
      await this.loadPreviewBoundary("newer", false);
    }
  }

  private async openThreadSearch(
    queryInput: string,
    origin: "chat" | "thread_list",
  ): Promise<void> {
    const query = queryInput.trim();
    if (query.length === 0) {
      this.update({ notice: "Enter a non-empty history search query." });
      return;
    }
    if (this.navigationBusy) {
      return;
    }
    if (
      origin === "chat" &&
      this.state.mode === "chat" &&
      !this.canBrowseThreads()
    ) {
      this.update({ notice: "History search is available only while idle." });
      return;
    }
    const existing = this.state.threadBrowser;
    if (
      origin === "thread_list" &&
      (existing === undefined ||
        (this.state.mode !== "thread_search_input" &&
          this.state.mode !== "thread_search_results"))
    ) {
      return;
    }
    const generation = this.beginNavigation();
    this.navigationBusy = true;
    const browser: TuiThreadBrowserState = existing ?? {
      threads: [],
      selectedIndex: 0,
      listScrollOffset: 0,
      viewportHeight: DEFAULT_VIEWPORT_HEIGHT,
      loading: false,
    };
    const search: TuiThreadSearchState = {
      origin,
      input: queryInput,
      query,
      matches: [],
      selectedIndex: 0,
      scrollOffset: 0,
      loading: true,
      hasMore: false,
    };
    this.update({
      mode: "thread_search_results",
      threadBrowser: { ...browser, loading: true, search },
      notice: `Searching for “${boundText(query, 128)}”…`,
    });
    try {
      const result = await this.client.searchThreads({
        workspace: this.state.configuration.cwd,
        query,
        limit: THREAD_SEARCH_PAGE_LIMIT,
      });
      if (
        !this.isCurrentNavigation(generation) ||
        this.state.mode !== "thread_search_results"
      ) {
        return;
      }
      const currentBrowser = this.state.threadBrowser;
      if (currentBrowser === undefined) {
        return;
      }
      this.update({
        threadBrowser: {
          ...currentBrowser,
          loading: false,
          search: {
            ...search,
            matches: result.matches,
            loading: false,
            hasMore: result.hasMore,
            revision: result.revision,
            ...(result.nextCursor === undefined
              ? {}
              : { nextCursor: result.nextCursor }),
          },
        },
        notice:
          result.diagnostics.length === 0
            ? result.matches.length === 0
              ? `No history matches “${boundText(query, 128)}”.`
              : undefined
            : `${result.diagnostics.length} thread index diagnostic(s) reported.`,
      });
    } catch (error) {
      if (!this.isCurrentNavigation(generation)) {
        return;
      }
      const currentBrowser = this.state.threadBrowser;
      if (currentBrowser !== undefined) {
        this.update({
          threadBrowser: {
            ...currentBrowser,
            loading: false,
            search: { ...search, loading: false },
          },
          notice: `Could not search thread history: ${errorMessage(error)}`,
        });
      }
    } finally {
      if (this.isCurrentNavigation(generation)) {
        this.navigationBusy = false;
      }
    }
  }

  private async loadMoreSearchResults(): Promise<boolean> {
    const browser = this.state.threadBrowser;
    const search = browser?.search;
    if (
      this.state.mode !== "thread_search_results" ||
      browser === undefined ||
      search === undefined ||
      search.loading ||
      !search.hasMore ||
      search.nextCursor === undefined ||
      this.navigationBusy
    ) {
      return false;
    }
    if (search.matches.length >= MAXIMUM_SEARCH_RESULTS) {
      this.update({
        threadBrowser: {
          ...browser,
          search: { ...search, hasMore: false },
        },
        notice: `Search result cache is limited to ${MAXIMUM_SEARCH_RESULTS} matches.`,
      });
      return false;
    }
    const generation = this.beginNavigation();
    this.navigationBusy = true;
    this.update({
      threadBrowser: {
        ...browser,
        loading: true,
        search: { ...search, loading: true },
      },
      notice: "Loading more search results…",
    });
    try {
      const result = await this.client.searchThreads({
        workspace: this.state.configuration.cwd,
        query: search.query,
        cursor: search.nextCursor,
        limit: THREAD_SEARCH_PAGE_LIMIT,
      });
      if (
        !this.isCurrentNavigation(generation) ||
        this.state.mode !== "thread_search_results"
      ) {
        return false;
      }
      const currentBrowser = this.state.threadBrowser;
      const currentSearch = currentBrowser?.search;
      if (currentBrowser === undefined || currentSearch === undefined) {
        return false;
      }
      const seen = new Set(
        currentSearch.matches.map(
          (match) => `${match.threadId}:${match.sequence}`,
        ),
      );
      const additions = result.matches.filter(
        (match) => !seen.has(`${match.threadId}:${match.sequence}`),
      );
      const matches = [...currentSearch.matches, ...additions].slice(
        0,
        MAXIMUM_SEARCH_RESULTS,
      );
      const atCapacity = matches.length >= MAXIMUM_SEARCH_RESULTS;
      const { nextCursor: _previousCursor, ...searchWithoutCursor } =
        currentSearch;
      this.update({
        threadBrowser: {
          ...currentBrowser,
          loading: false,
          search: {
            ...searchWithoutCursor,
            matches,
            loading: false,
            hasMore: result.hasMore && !atCapacity,
            revision: result.revision,
            ...(result.nextCursor === undefined || atCapacity
              ? {}
              : { nextCursor: result.nextCursor }),
          },
        },
        notice: atCapacity
          ? `Search result cache is limited to ${MAXIMUM_SEARCH_RESULTS} matches.`
          : undefined,
      });
      return true;
    } catch (error) {
      const currentBrowser = this.state.threadBrowser;
      const currentSearch = currentBrowser?.search;
      if (
        this.isCurrentNavigation(generation) &&
        currentBrowser !== undefined &&
        currentSearch !== undefined
      ) {
        const indexChanged =
          structuredErrorCode(error) === "THREAD_SEARCH_INDEX_CHANGED";
        this.update({
          threadBrowser: {
            ...currentBrowser,
            loading: false,
            search: {
              ...currentSearch,
              loading: false,
              ...(indexChanged ? { hasMore: false } : {}),
            },
          },
          notice: indexChanged
            ? "The history index changed. Press / to keep the query and rerun it."
            : `Could not load more search results: ${errorMessage(error)}`,
        });
      }
      return false;
    } finally {
      if (this.isCurrentNavigation(generation)) {
        this.navigationBusy = false;
      }
    }
  }

  private reprojectPreview(direction: "older" | "newer"): void {
    const browser = this.state.threadBrowser;
    const preview = browser?.preview;
    if (browser === undefined || preview === undefined) {
      return;
    }
    const edge =
      direction === "older"
        ? preview.entries[0]?.sequence
        : preview.entries.at(-1)?.sequence;
    if (edge === undefined) {
      return;
    }
    const projection = projectHistoryWindow(
      preview.events,
      direction === "older" ? Math.max(0, edge - 1) : edge + 1,
      direction === "older" ? "end" : "start",
    );
    const entries = this.previewEntries(projection.entries, preview.match);
    this.update({
      threadBrowser: {
        ...browser,
        preview: {
          ...preview,
          entries,
          scrollOffset:
            direction === "older"
              ? maximumScrollOffset(entries.length, browser.viewportHeight)
              : 0,
          hasProjectedEarlier: projection.hasEarlier,
          hasProjectedLater: projection.hasLater,
        },
      },
      notice: undefined,
    });
  }

  private async loadPreviewBoundary(
    direction: "older" | "newer",
    toBoundary: boolean,
  ): Promise<void> {
    const browser = this.state.threadBrowser;
    const preview = browser?.preview;
    if (browser === undefined || preview === undefined || this.navigationBusy) {
      return;
    }
    const generation = this.beginNavigation();
    this.navigationBusy = true;
    this.update({
      threadBrowser: { ...browser, loading: true },
      notice:
        direction === "older"
          ? "Loading older history…"
          : "Loading newer history…",
    });
    try {
      let events = [...preview.events];
      let hasEarlier = preview.hasEarlier;
      let hasLater = preview.hasLater;
      do {
        const cursor =
          direction === "older" ? events[0]?.sequence : events.at(-1)?.sequence;
        if (cursor === undefined) {
          break;
        }
        const page = await this.client.readThreadEvents({
          threadId: preview.thread.threadId,
          ...(direction === "older"
            ? { beforeSequence: cursor }
            : { afterSequence: cursor }),
          limit: 200,
        });
        if (!this.isCurrentNavigation(generation)) {
          return;
        }
        if (page.events.length === 0) {
          if (
            (direction === "older" && page.hasEarlier) ||
            (direction === "newer" && page.hasLater)
          ) {
            throw new Error("History pagination returned no cursor progress.");
          }
          hasEarlier = direction === "older" ? false : hasEarlier;
          hasLater = direction === "newer" ? false : hasLater;
          break;
        }
        const combinedCount = uniqueEventCount(events, page.events);
        events = mergeEventWindow(
          events,
          page.events,
          direction === "older" ? "older" : "newer",
        );
        if (direction === "older") {
          hasEarlier = page.hasEarlier;
          hasLater = hasLater || combinedCount > events.length;
        } else {
          hasLater = page.hasLater;
          hasEarlier = hasEarlier || combinedCount > events.length;
        }
      } while (toBoundary && (direction === "older" ? hasEarlier : hasLater));

      const previousEdge =
        direction === "older"
          ? preview.events[0]?.sequence
          : preview.events.at(-1)?.sequence;
      const projection = projectHistoryWindow(
        events,
        toBoundary || previousEdge === undefined
          ? undefined
          : direction === "older"
            ? Math.max(0, previousEdge - 1)
            : previousEdge + 1,
        toBoundary
          ? direction === "older"
            ? "start"
            : "end"
          : direction === "older"
            ? "end"
            : "start",
      );
      const entries = this.previewEntries(projection.entries, preview.match);
      const currentBrowser = this.state.threadBrowser;
      if (
        this.state.mode !== "thread_preview" ||
        currentBrowser === undefined
      ) {
        return;
      }
      this.update({
        threadBrowser: {
          ...currentBrowser,
          loading: false,
          preview: {
            ...preview,
            events,
            entries,
            scrollOffset:
              direction === "older"
                ? toBoundary
                  ? 0
                  : maximumScrollOffset(
                      entries.length,
                      currentBrowser.viewportHeight,
                    )
                : toBoundary
                  ? maximumScrollOffset(
                      entries.length,
                      currentBrowser.viewportHeight,
                    )
                  : 0,
            hasEarlier,
            hasLater,
            hasProjectedEarlier: projection.hasEarlier,
            hasProjectedLater: projection.hasLater,
          },
        },
        notice: undefined,
      });
    } catch (error) {
      const currentBrowser = this.state.threadBrowser;
      if (
        this.isCurrentNavigation(generation) &&
        this.state.mode === "thread_preview" &&
        currentBrowser !== undefined
      ) {
        this.update({
          threadBrowser: { ...currentBrowser, loading: false },
          notice: `Could not load thread history: ${errorMessage(error)}`,
        });
      }
    } finally {
      if (this.isCurrentNavigation(generation)) {
        this.navigationBusy = false;
      }
    }
  }

  private async loadLatestPreview(): Promise<void> {
    const browser = this.state.threadBrowser;
    const preview = browser?.preview;
    if (browser === undefined || preview === undefined || this.navigationBusy) {
      return;
    }
    const generation = this.beginNavigation();
    this.navigationBusy = true;
    this.update({
      threadBrowser: { ...browser, loading: true },
      notice: "Loading latest history…",
    });
    try {
      const page = await this.client.readThreadEvents({
        threadId: preview.thread.threadId,
        limit: 200,
      });
      if (!this.isCurrentNavigation(generation)) {
        return;
      }
      const projection = projectHistoryWindow(page.events, undefined, "end");
      const entries = this.previewEntries(projection.entries, preview.match);
      const currentBrowser = this.state.threadBrowser;
      if (
        this.state.mode !== "thread_preview" ||
        currentBrowser === undefined
      ) {
        return;
      }
      this.update({
        threadBrowser: {
          ...currentBrowser,
          loading: false,
          preview: {
            ...preview,
            events: page.events,
            entries,
            scrollOffset: maximumScrollOffset(
              entries.length,
              currentBrowser.viewportHeight,
            ),
            hasEarlier: page.hasEarlier,
            hasLater: page.hasLater,
            hasProjectedEarlier: projection.hasEarlier,
            hasProjectedLater: projection.hasLater,
          },
        },
        notice: undefined,
      });
    } catch (error) {
      const currentBrowser = this.state.threadBrowser;
      if (
        this.isCurrentNavigation(generation) &&
        this.state.mode === "thread_preview" &&
        currentBrowser !== undefined
      ) {
        this.update({
          threadBrowser: { ...currentBrowser, loading: false },
          notice: `Could not load latest history: ${errorMessage(error)}`,
        });
      }
    } finally {
      if (this.isCurrentNavigation(generation)) {
        this.navigationBusy = false;
      }
    }
  }

  private previewEntries(
    entries: ReadonlyArray<Omit<TuiTranscriptEntry, "id">>,
    match: ThreadSearchMatch | undefined,
  ): TuiTranscriptEntry[] {
    return entries.map((entry) =>
      this.withTranscriptId({
        ...entry,
        ...(match !== undefined && entry.sequence === match.sequence
          ? { matched: true }
          : {}),
      }),
    );
  }

  private detachThread(): void {
    const previous = this.state.threadId;
    const { resumeThreadId: _resumeThreadId, ...configuration } =
      this.state.configuration;
    const nextConfiguration = {
      ...configuration,
      provider: this.state.nextThreadConfiguration.provider,
      model: this.state.nextThreadConfiguration.model,
    };
    this.appendTranscript(
      "system",
      previous === undefined
        ? `Ready for a new thread with ${nextConfiguration.provider}/${nextConfiguration.model}.`
        : `Detached from thread ${previous}; the next prompt will create a thread with ${nextConfiguration.provider}/${nextConfiguration.model}.`,
      {
        configuration: nextConfiguration,
        threadId: undefined,
        notice: undefined,
      },
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
    this.cancelNavigation();
    this.update({ connection: "closing", notice: "Shutting down…" });
    try {
      await this.client.shutdown();
      this.update({
        connection: "closed",
        mode: "chat",
        activeTurn: undefined,
        approval: undefined,
        threadBrowser: undefined,
        runtimeSettings: undefined,
        artifactNavigation: undefined,
        contextNavigation: undefined,
        notice: undefined,
      });
    } catch (error) {
      this.update({
        connection: "error",
        mode: "chat",
        activeTurn: undefined,
        approval: undefined,
        threadBrowser: undefined,
        runtimeSettings: undefined,
        artifactNavigation: undefined,
        contextNavigation: undefined,
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
          details: event.payload.details,
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
      case "workspace.change_set_prepared":
        next = updateTool(next, event.payload.callId, event.payload.name, {
          status: "running",
          detail: `${event.payload.changes.length} changes prepared`,
        });
        break;
      case "workspace.change_set_committed":
        next = updateTool(next, event.payload.callId, event.payload.name, {
          status: "success",
          detail: `${event.payload.changeCount} changes committed`,
        });
        break;
      case "workspace.change_set_rolled_back":
        next = updateTool(next, event.payload.callId, event.payload.name, {
          status: "error",
          detail: `${event.payload.appliedCount} changes rolled back`,
        });
        break;
      case "workspace.change_set_uncertain":
        next = updateTool(next, event.payload.callId, event.payload.name, {
          status: "error",
          detail: `uncertain: ${event.payload.uncertainPaths.join(", ")}`,
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
    this.cancelNavigation();
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
      runtimeSettings: undefined,
      artifactNavigation: undefined,
      contextNavigation: undefined,
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
    const next = this.state.nextThreadConfiguration;
    const nextDiffers =
      next.provider !== this.state.configuration.provider ||
      next.model !== this.state.configuration.model;
    return [
      `connection: ${this.state.connection}`,
      `thread: ${this.state.threadId ?? "new"}`,
      `provider: ${this.state.configuration.provider}`,
      `model: ${this.state.configuration.model}`,
      ...(nextDiffers ? [`next: ${next.provider}/${next.model}`] : []),
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

  private beginNavigation(): number {
    this.navigationGeneration += 1;
    return this.navigationGeneration;
  }

  private cancelNavigation(): void {
    this.navigationGeneration += 1;
    this.navigationBusy = false;
  }

  private isCurrentNavigation(generation: number): boolean {
    return generation === this.navigationGeneration;
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

function artifactListState(
  result: {
    artifacts: readonly ThreadArtifactDescriptor[];
    hasEarlier: boolean;
    nextBeforeSequence?: number | undefined;
  },
  currentCursor: number | null,
  newerCursors: readonly (number | null)[],
  viewportHeight: number,
): TuiArtifactListState {
  return {
    artifacts: result.artifacts,
    selectedIndex: 0,
    scrollOffset: keepSelectionVisible(
      0,
      0,
      viewportHeight,
      result.artifacts.length,
    ),
    currentCursor,
    newerCursors,
    hasEarlier: result.hasEarlier,
    ...(result.nextBeforeSequence === undefined
      ? {}
      : { nextBeforeSequence: result.nextBeforeSequence }),
  };
}

function artifactViewState(
  page: ArtifactReadResult,
  viewportWidth: number,
  viewportHeight: number,
  alignment: "start" | "end",
): TuiArtifactViewState {
  const rows = artifactPresentationRows(page.content, viewportWidth);
  return {
    page,
    rows,
    scrollOffset:
      alignment === "start"
        ? 0
        : maximumScrollOffset(rows.length, viewportHeight),
  };
}

function contextListState(
  result: {
    requests: readonly ContextRequestDescriptor[];
    hasEarlier: boolean;
    nextBeforeSequence?: number | undefined;
  },
  currentCursor: number | null,
  newerCursors: readonly (number | null)[],
  viewportHeight: number,
): TuiContextListState {
  return {
    requests: result.requests,
    selectedIndex: 0,
    scrollOffset: keepSelectionVisible(
      0,
      0,
      viewportHeight,
      result.requests.length,
    ),
    currentCursor,
    newerCursors,
    hasEarlier: result.hasEarlier,
    ...(result.nextBeforeSequence === undefined
      ? {}
      : { nextBeforeSequence: result.nextBeforeSequence }),
  };
}

function contextInstructionViewState(
  page: ContextInstructionReadResult,
  viewportWidth: number,
  viewportHeight: number,
  alignment: "start" | "end",
): TuiContextInstructionViewState {
  const rows = artifactPresentationRows(page.content, viewportWidth);
  return {
    page,
    rows,
    scrollOffset:
      alignment === "start"
        ? 0
        : maximumScrollOffset(rows.length, viewportHeight),
  };
}

function artifactPresentationRows(
  content: string,
  viewportWidth: number,
): string[] {
  const normalized = content
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
    .replaceAll("\t", "    ");
  const width = Math.min(
    MAXIMUM_VIEWPORT_WIDTH,
    Math.max(MINIMUM_VIEWPORT_WIDTH, Math.floor(viewportWidth) - 4),
  );
  const rows: string[] = [];
  for (const logicalLine of normalized.split("\n")) {
    const characters = [...logicalLine];
    if (characters.length === 0) {
      rows.push("");
      continue;
    }
    for (let start = 0; start < characters.length; start += width) {
      rows.push(characters.slice(start, start + width).join(""));
    }
  }
  return rows.length === 0 ? [""] : rows;
}

function runtimeSettingsResultNotice(result: {
  diagnostics: readonly { message: string }[];
  recovery?: { preferenceBackup: string } | undefined;
}): string | undefined {
  if (result.recovery !== undefined) {
    return `Recovered invalid settings to ${boundText(result.recovery.preferenceBackup, 1_024)}.`;
  }
  if (result.diagnostics.length > 0) {
    return boundText(result.diagnostics[0]?.message ?? "Settings diagnostic.");
  }
  return undefined;
}

function boundModelInput(input: string): string {
  const sanitized = input.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "");
  if (
    Buffer.byteLength(sanitized, "utf8") <= RUNTIME_SETTINGS_MODEL_BUDGET_BYTES
  ) {
    return sanitized;
  }
  let low = 0;
  let high = sanitized.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      Buffer.byteLength(sanitized.slice(0, middle), "utf8") <=
      RUNTIME_SETTINGS_MODEL_BUDGET_BYTES
    ) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  let prefix = sanitized.slice(0, low);
  if (/\p{Surrogate}$/u.test(prefix)) {
    prefix = prefix.slice(0, -1);
  }
  return prefix;
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

function projectThreadHistoryRows(
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
          entries.push({
            kind: "user",
            text: item.content,
            sequence: event.sequence,
          });
          break;
        case "assistant_message":
          entries.push({
            kind: "assistant",
            text: item.content,
            sequence: event.sequence,
          });
          break;
        case "tool_result":
          entries.push({
            kind: item.status === "error" ? "error" : "tool",
            text:
              item.status === "error"
                ? `${item.name}: ${item.error?.code ?? "error"}${item.error?.message === undefined ? "" : ` — ${item.error.message}`}`
                : `${item.name}: success${item.output === undefined ? "" : ` — ${jsonSummary(item.output)}`}`,
            sequence: event.sequence,
          });
          break;
        case "compaction":
          entries.push({
            kind: "system",
            text: `Context compacted: ${item.summary.objective || "summary recorded"}.`,
            sequence: event.sequence,
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
            sequence: event.sequence,
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
        sequence: event.sequence,
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
        sequence: event.sequence,
      });
      continue;
    }
    if (event.type === "turn.completed") {
      entries.push(
        event.payload.usage === undefined
          ? {
              kind: "system",
              text: "Turn completed.",
              sequence: event.sequence,
            }
          : {
              kind: "usage",
              text: formatUsage(event.payload.usage),
              sequence: event.sequence,
            },
      );
      continue;
    }
    if (event.type === "turn.cancelled") {
      entries.push({
        kind: "system",
        text: `Turn cancelled: ${event.payload.reason}`,
        sequence: event.sequence,
      });
      continue;
    }
    if (event.type === "turn.failed") {
      entries.push({
        kind: "error",
        text: `${event.payload.code}: ${event.payload.message}`,
        sequence: event.sequence,
      });
    }
  }
  return entries.map((entry) => ({
    ...entry,
    text: boundText(entry.text),
  }));
}

export function projectThreadHistory(
  events: readonly AgentEvent[],
): Array<Omit<TuiTranscriptEntry, "id" | "sequence" | "matched">> {
  const rows = projectThreadHistoryRows(events).map(
    ({ sequence: _sequence, matched: _matched, ...entry }) => entry,
  );
  const bounded = rows;
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

function projectHistoryWindow(
  events: readonly AgentEvent[],
  focusSequence: number | undefined,
  alignment: "start" | "center" | "end",
): {
  entries: Array<Omit<TuiTranscriptEntry, "id">>;
  hasEarlier: boolean;
  hasLater: boolean;
} {
  const rows = projectThreadHistoryRows(events);
  if (rows.length <= MAXIMUM_HISTORY_ROWS) {
    return { entries: rows, hasEarlier: false, hasLater: false };
  }
  let focusIndex: number;
  if (focusSequence === undefined) {
    focusIndex = alignment === "start" ? 0 : rows.length - 1;
  } else if (alignment === "end") {
    let found = -1;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if ((rows[index]?.sequence ?? -1) <= focusSequence) {
        found = index;
        break;
      }
    }
    focusIndex = found === -1 ? 0 : found;
  } else {
    const found = rows.findIndex(
      (entry) => (entry.sequence ?? Number.MAX_SAFE_INTEGER) >= focusSequence,
    );
    focusIndex = found === -1 ? rows.length - 1 : found;
  }
  const maximumStart = rows.length - MAXIMUM_HISTORY_ROWS;
  const start = Math.min(
    maximumStart,
    Math.max(
      0,
      alignment === "start"
        ? focusIndex
        : alignment === "end"
          ? focusIndex - MAXIMUM_HISTORY_ROWS + 1
          : focusIndex - Math.floor(MAXIMUM_HISTORY_ROWS / 2),
    ),
  );
  const end = start + MAXIMUM_HISTORY_ROWS;
  return {
    entries: rows.slice(start, end),
    hasEarlier: start > 0,
    hasLater: end < rows.length,
  };
}

function emptySearchState(
  origin: "chat" | "thread_list",
): TuiThreadSearchState {
  return {
    origin,
    input: "",
    query: "",
    matches: [],
    selectedIndex: 0,
    scrollOffset: 0,
    loading: false,
    hasMore: false,
  };
}

function keepSelectionVisible(
  selectedIndex: number,
  currentOffset: number,
  viewportHeight: number,
  itemCount: number,
): number {
  if (itemCount === 0) {
    return 0;
  }
  const maximum = maximumScrollOffset(itemCount, viewportHeight);
  if (selectedIndex < currentOffset) {
    return Math.max(0, selectedIndex);
  }
  if (selectedIndex >= currentOffset + viewportHeight) {
    return Math.min(maximum, selectedIndex - viewportHeight + 1);
  }
  return Math.min(maximum, currentOffset);
}

function maximumScrollOffset(
  itemCount: number,
  viewportHeight: number,
): number {
  return Math.max(0, itemCount - viewportHeight);
}

function mergeEventWindow(
  first: readonly AgentEvent[],
  second: readonly AgentEvent[],
  retain: "older" | "newer" | "around",
): AgentEvent[] {
  const bySequence = new Map<number, AgentEvent>();
  for (const event of [...first, ...second]) {
    const existing = bySequence.get(event.sequence);
    if (
      existing !== undefined &&
      JSON.stringify(existing) !== JSON.stringify(event)
    ) {
      throw new Error(`History pages disagree about event ${event.sequence}.`);
    }
    bySequence.set(event.sequence, event);
  }
  const events = [...bySequence.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const threadId = events[0]?.threadId;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const previous = events[index - 1];
    if (event?.threadId !== threadId) {
      throw new Error("History pages contain events from different threads.");
    }
    if (
      previous !== undefined &&
      event !== undefined &&
      event.sequence !== previous.sequence + 1
    ) {
      throw new Error("History pages are not contiguous at their boundary.");
    }
  }
  if (events.length <= MAXIMUM_HISTORY_EVENTS) {
    return events;
  }
  if (retain === "older") {
    return events.slice(0, MAXIMUM_HISTORY_EVENTS);
  }
  if (retain === "newer") {
    return events.slice(-MAXIMUM_HISTORY_EVENTS);
  }
  const middle = Math.floor(events.length / 2);
  const start = Math.max(0, middle - Math.floor(MAXIMUM_HISTORY_EVENTS / 2));
  return events.slice(start, start + MAXIMUM_HISTORY_EVENTS);
}

function uniqueEventCount(
  first: readonly AgentEvent[],
  second: readonly AgentEvent[],
): number {
  return new Set([...first, ...second].map((event) => event.sequence)).size;
}

function threadSearchKindForEvent(
  event: AgentEvent,
  _events: readonly AgentEvent[],
): ThreadSearchMatch["kind"] | undefined {
  if (event.type === "item.recorded") {
    switch (event.payload.item.type) {
      case "user_message":
        return "user_message";
      case "assistant_message":
        return "assistant_message";
      case "tool_result":
        return "tool_result";
      case "compaction":
        return "compaction";
      case "recovery":
        return "recovery";
      default:
        return undefined;
    }
  }
  if (event.type === "tool.completed" && event.payload.status === "error") {
    return "tool_failure";
  }
  if (event.type === "turn.cancelled") {
    return "turn_cancelled";
  }
  if (event.type === "turn.failed") {
    return "turn_failed";
  }
  return undefined;
}

function structuredErrorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "dataCode" in error &&
    typeof (error as { dataCode?: unknown }).dataCode === "string"
    ? (error as { dataCode: string }).dataCode
    : error instanceof Error &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
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
