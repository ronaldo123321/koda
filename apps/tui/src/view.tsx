import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { Box, Static, Text, useApp, useInput, useStdout, type Key } from "ink";
import type { ExecutionSecuritySnapshot } from "@koda/protocol";

import {
  TuiController,
  boundPresentationText,
  compactPlanStatus,
  planEvidenceLabel,
  projectLiveToolActivity,
  type TuiState,
  type TuiTranscriptEntry,
} from "./controller.js";

export interface KodaTuiProps {
  controller: TuiController;
}

export function KodaTui({ controller }: KodaTuiProps) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const { exit } = useApp();
  const { stdout } = useStdout();
  const exiting = useRef(false);
  const requestExit = useCallback(() => {
    if (exiting.current) {
      return;
    }
    exiting.current = true;
    void controller.shutdown().finally(() => {
      exit();
    });
  }, [controller, exit]);

  useInput((input, key) => {
    routeTuiInput(controller, state, input, key, requestExit);
  });

  useEffect(() => {
    const updateViewport = () => {
      controller.setViewportHeight(
        (stdout.rows ?? 20) - 8,
        stdout.columns ?? 80,
      );
    };
    updateViewport();
    stdout.on("resize", updateViewport);
    return () => {
      stdout.off("resize", updateViewport);
    };
  }, [controller, stdout]);

  return <KodaView state={state} />;
}

export interface KodaViewProps {
  state: TuiState;
}

export interface TuiInputController {
  setInput(input: string): void;
  submitInput(): Promise<"handled" | "exit">;
  cancelActiveTurn(): Promise<void>;
  resolveApproval(
    decision: "approved" | "rejected",
    createGrant?: boolean,
  ): Promise<void>;
  toggleApprovalDetails(): void;
  openThreadBrowser(): Promise<void>;
  selectThread(offset: -1 | 1): void;
  pageThreadList(direction: -1 | 1): void;
  previewSelectedThread(): Promise<void>;
  enterThreadSearch(): void;
  setThreadSearchInput(input: string): void;
  submitThreadSearch(): Promise<void>;
  selectSearchResult(offset: -1 | 1): void;
  pageSearchResults(direction: -1 | 1): Promise<void>;
  previewSelectedSearchResult(): Promise<void>;
  scrollPreview(
    action: "up" | "down" | "page_up" | "page_down" | "home" | "end",
  ): Promise<void>;
  closeThreadBrowserLevel(): void;
  resumePreviewedThread(): Promise<void>;
  setViewportHeight(height: number, width?: number): void;
  openRuntimeSettings(): Promise<void>;
  selectRuntimeSettingsProvider(offset: -1 | 1): void;
  enterRuntimeSettingsModel(): void;
  setRuntimeSettingsModelInput(input: string): void;
  resetRuntimeSettingsModel(): void;
  applyRuntimeSettings(): Promise<void>;
  reloadRuntimeSettings(): Promise<void>;
  closeRuntimeSettingsLevel(): void;
  openPreviewArtifacts(): Promise<void>;
  selectArtifact(offset: -1 | 1): void;
  pageArtifactList(action: "newer" | "older" | "home" | "end"): Promise<void>;
  openSelectedArtifact(): Promise<void>;
  scrollArtifact(
    action: "up" | "down" | "page_up" | "page_down" | "home" | "end",
  ): Promise<void>;
  closeArtifactLevel(): void;
  openPreviewContext(): Promise<void>;
  selectContextRequest(offset: -1 | 1): void;
  pageContextList(action: "newer" | "older" | "home" | "end"): Promise<void>;
  openSelectedContext(): Promise<void>;
  selectContextInstructionSource(offset: -1 | 1): void;
  openSelectedContextInstruction(): Promise<void>;
  scrollContextInstruction(
    action: "up" | "down" | "page_up" | "page_down" | "home" | "end",
  ): Promise<void>;
  closeContextLevel(): void;
  openCurrentPlan(): Promise<void>;
  scrollPlan(
    action: "up" | "down" | "page_up" | "page_down" | "home" | "end",
  ): void;
  closePlan(): void;
  openCurrentExtensions(): Promise<void>;
  scrollExtensions(
    action: "up" | "down" | "page_up" | "page_down" | "home" | "end",
  ): void;
  closeExtensions(): void;
  openCurrentActivity(): Promise<void>;
  navigateActivity(
    action: "up" | "down" | "page_up" | "page_down" | "home" | "end",
  ): Promise<void>;
  closeActivity(): void;
  openProcesses(): Promise<void>;
  refreshProcesses(): Promise<void>;
  navigateProcessList(
    action: "up" | "down" | "page_up" | "page_down" | "home" | "end",
  ): void;
  attachSelectedProcess(): Promise<void>;
  retryProcessInput(): Promise<void>;
  sendProcessInput(data: string): void;
  beginProcessTermination(): void;
  cancelProcessTermination(): void;
  confirmProcessTermination(): Promise<void>;
  detachProcessSession(refresh?: boolean): Promise<void>;
  closeProcessLevel(): void;
  enterPlanAcceptanceFeedback(): void;
  setPlanAcceptanceFeedback(feedback: string): void;
  cancelPlanAcceptanceFeedback(): void;
  resolvePlanAcceptance(
    decision: "accepted" | "changes_requested",
  ): Promise<void>;
}

export function KodaView({ state }: KodaViewProps) {
  return (
    <Box flexDirection="column">
      <Static items={[...state.transcript]}>
        {(entry) => <TranscriptRow key={entry.id} entry={entry} />}
      </Static>

      <Box>
        <Text bold color="green">
          Koda
        </Text>
        <Text dimColor>
          {` · ${state.configuration.provider}/${boundPresentationText(state.configuration.model, 256)} · ${state.threadId ?? "new thread"}`}
        </Text>
      </Box>

      {state.mode === "thread_list" ? <ThreadList state={state} /> : null}
      {state.mode === "thread_search_input" ? (
        <ThreadSearchInput state={state} />
      ) : null}
      {state.mode === "thread_search_results" ? (
        <ThreadSearchResults state={state} />
      ) : null}
      {state.mode === "thread_preview" ? <ThreadPreview state={state} /> : null}
      {state.mode === "settings_provider" ? (
        <RuntimeSettingsProvider state={state} />
      ) : null}
      {state.mode === "settings_model" ? (
        <RuntimeSettingsModel state={state} />
      ) : null}
      {state.mode === "artifact_list" ? <ArtifactList state={state} /> : null}
      {state.mode === "artifact_view" ? <ArtifactViewer state={state} /> : null}
      {state.mode === "context_list" ? <ContextList state={state} /> : null}
      {state.mode === "context_detail" ? <ContextDetail state={state} /> : null}
      {state.mode === "context_instruction_view" ? (
        <ContextInstructionViewer state={state} />
      ) : null}
      {state.mode === "plan_view" ? <PlanView state={state} /> : null}
      {state.mode === "extensions_view" ? (
        <ExtensionsView state={state} />
      ) : null}
      {state.mode === "activity_view" ? <ActivityView state={state} /> : null}
      {state.mode === "process_list" ? <ProcessList state={state} /> : null}
      {state.mode === "process_view" ? <ProcessView state={state} /> : null}
      {state.mode === "process_terminate_confirm" ? (
        <ProcessTerminateConfirmation state={state} />
      ) : null}

      {state.mode === "chat" ? (
        <>
          {state.activeTurn === undefined ? null : (
            <ActiveTurn state={state.activeTurn} />
          )}

          {state.approval === undefined ? null : (
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor="yellow"
              paddingX={1}
            >
              <Text bold color="yellow">
                Approval required · {state.approval.title}
              </Text>
              <Text>{state.approval.summary}</Text>
              <Text dimColor>reason: {state.approval.reason}</Text>
              {state.approval.detailsVisible ? (
                <Text>{state.approval.details}</Text>
              ) : null}
              <Text dimColor>
                {state.approval.resolving
                  ? "Resolving approval…"
                  : state.approval.grantCandidate === undefined
                    ? "y approve · n reject · d details · Esc cancel turn"
                    : "y approve once · a approve for 15m · n reject · d details · Esc cancel turn"}
              </Text>
            </Box>
          )}

          {state.planAcceptance === undefined ? null : (
            <PlanAcceptanceCard state={state} />
          )}
        </>
      ) : null}

      {state.notice === undefined ? null : (
        <Text color={state.connection === "error" ? "red" : "yellow"}>
          {state.notice}
        </Text>
      )}

      {state.mode === "chat" ? (
        <>
          <StatusLine state={state} />
          <Prompt state={state} />
        </>
      ) : null}
    </Box>
  );
}

export function routeTuiInput(
  controller: TuiInputController,
  state: TuiState,
  input: string,
  key: Key,
  requestExit: () => void,
): void {
  if (state.mode === "process_terminate_confirm") {
    if (key.escape || input.toLowerCase() === "n") {
      controller.cancelProcessTermination();
    } else if (input.toLowerCase() === "y") {
      void controller.confirmProcessTermination();
    }
    return;
  }
  if (state.mode === "process_list") {
    if (key.escape) {
      controller.closeProcessLevel();
    } else if (key.upArrow) {
      controller.navigateProcessList("up");
    } else if (key.downArrow) {
      controller.navigateProcessList("down");
    } else if (key.pageUp) {
      controller.navigateProcessList("page_up");
    } else if (key.pageDown) {
      controller.navigateProcessList("page_down");
    } else if (key.home) {
      controller.navigateProcessList("home");
    } else if (key.end) {
      controller.navigateProcessList("end");
    } else if (key.return) {
      void controller.attachSelectedProcess();
    } else if (input.toLowerCase() === "r") {
      void controller.refreshProcesses();
    }
    return;
  }
  if (state.mode === "process_view") {
    const session = state.processNavigation?.session;
    if (session === undefined) {
      controller.closeProcessLevel();
      return;
    }
    if ((key.ctrl && input === "]") || input === "\u001d") {
      void controller.detachProcessSession();
      return;
    }
    if (key.ctrl && input.toLowerCase() === "k") {
      controller.beginProcessTermination();
      return;
    }
    if (session.inputState === "read_only") {
      if (input.toLowerCase() === "w") {
        void controller.retryProcessInput();
      } else if (input.toLowerCase() === "k") {
        controller.beginProcessTermination();
      }
      return;
    }
    const terminalInput = processKeySequence(input, key);
    if (terminalInput !== undefined) controller.sendProcessInput(terminalInput);
    return;
  }
  if (
    key.ctrl &&
    input.toLowerCase() === "t" &&
    state.mode === "chat" &&
    state.activeTurn === undefined &&
    state.connection === "ready"
  ) {
    void controller.openThreadBrowser();
    return;
  }
  if (key.ctrl && input.toLowerCase() === "c") {
    if (state.activeTurn === undefined) {
      requestExit();
    } else {
      void controller.cancelActiveTurn();
    }
    return;
  }
  if (state.mode === "plan_view") {
    if (key.escape) {
      controller.closePlan();
    } else if (key.upArrow) {
      controller.scrollPlan("up");
    } else if (key.downArrow) {
      controller.scrollPlan("down");
    } else if (key.pageUp) {
      controller.scrollPlan("page_up");
    } else if (key.pageDown) {
      controller.scrollPlan("page_down");
    } else if (key.home) {
      controller.scrollPlan("home");
    } else if (key.end) {
      controller.scrollPlan("end");
    }
    return;
  }
  if (state.mode === "activity_view") {
    if (key.escape) {
      controller.closeActivity();
    } else if (key.upArrow) {
      void controller.navigateActivity("up");
    } else if (key.downArrow) {
      void controller.navigateActivity("down");
    } else if (key.pageUp) {
      void controller.navigateActivity("page_up");
    } else if (key.pageDown) {
      void controller.navigateActivity("page_down");
    } else if (key.home) {
      void controller.navigateActivity("home");
    } else if (key.end) {
      void controller.navigateActivity("end");
    }
    return;
  }
  if (state.mode === "extensions_view") {
    if (key.escape) {
      controller.closeExtensions();
    } else if (key.upArrow) {
      controller.scrollExtensions("up");
    } else if (key.downArrow) {
      controller.scrollExtensions("down");
    } else if (key.pageUp) {
      controller.scrollExtensions("page_up");
    } else if (key.pageDown) {
      controller.scrollExtensions("page_down");
    } else if (key.home) {
      controller.scrollExtensions("home");
    } else if (key.end) {
      controller.scrollExtensions("end");
    }
    return;
  }
  if (state.mode === "context_list") {
    if (key.escape) {
      controller.closeContextLevel();
    } else if (key.upArrow) {
      controller.selectContextRequest(-1);
    } else if (key.downArrow) {
      controller.selectContextRequest(1);
    } else if (key.pageUp) {
      void controller.pageContextList("newer");
    } else if (key.pageDown) {
      void controller.pageContextList("older");
    } else if (key.home) {
      void controller.pageContextList("home");
    } else if (key.end) {
      void controller.pageContextList("end");
    } else if (key.return) {
      void controller.openSelectedContext();
    }
    return;
  }
  if (state.mode === "context_detail") {
    if (key.escape) {
      controller.closeContextLevel();
    } else if (key.upArrow) {
      controller.selectContextInstructionSource(-1);
    } else if (key.downArrow) {
      controller.selectContextInstructionSource(1);
    } else if (key.return) {
      void controller.openSelectedContextInstruction();
    }
    return;
  }
  if (state.mode === "context_instruction_view") {
    if (key.escape) {
      controller.closeContextLevel();
    } else if (key.upArrow) {
      void controller.scrollContextInstruction("up");
    } else if (key.downArrow) {
      void controller.scrollContextInstruction("down");
    } else if (key.pageUp) {
      void controller.scrollContextInstruction("page_up");
    } else if (key.pageDown) {
      void controller.scrollContextInstruction("page_down");
    } else if (key.home) {
      void controller.scrollContextInstruction("home");
    } else if (key.end) {
      void controller.scrollContextInstruction("end");
    }
    return;
  }
  if (state.mode === "artifact_list") {
    if (key.escape) {
      controller.closeArtifactLevel();
    } else if (key.upArrow) {
      controller.selectArtifact(-1);
    } else if (key.downArrow) {
      controller.selectArtifact(1);
    } else if (key.pageUp) {
      void controller.pageArtifactList("newer");
    } else if (key.pageDown) {
      void controller.pageArtifactList("older");
    } else if (key.home) {
      void controller.pageArtifactList("home");
    } else if (key.end) {
      void controller.pageArtifactList("end");
    } else if (key.return) {
      void controller.openSelectedArtifact();
    }
    return;
  }
  if (state.mode === "artifact_view") {
    if (key.escape) {
      controller.closeArtifactLevel();
    } else if (key.upArrow) {
      void controller.scrollArtifact("up");
    } else if (key.downArrow) {
      void controller.scrollArtifact("down");
    } else if (key.pageUp) {
      void controller.scrollArtifact("page_up");
    } else if (key.pageDown) {
      void controller.scrollArtifact("page_down");
    } else if (key.home) {
      void controller.scrollArtifact("home");
    } else if (key.end) {
      void controller.scrollArtifact("end");
    }
    return;
  }
  if (state.mode === "settings_provider") {
    if (key.escape) {
      controller.closeRuntimeSettingsLevel();
    } else if (key.ctrl && input.toLowerCase() === "l") {
      void controller.reloadRuntimeSettings();
    } else if (key.upArrow) {
      controller.selectRuntimeSettingsProvider(-1);
    } else if (key.downArrow) {
      controller.selectRuntimeSettingsProvider(1);
    } else if (key.return) {
      controller.enterRuntimeSettingsModel();
    }
    return;
  }
  if (state.mode === "settings_model") {
    const modelInput = state.runtimeSettings?.modelInput ?? "";
    if (key.escape) {
      controller.closeRuntimeSettingsLevel();
    } else if (key.ctrl && input.toLowerCase() === "r") {
      controller.resetRuntimeSettingsModel();
    } else if (key.ctrl && input.toLowerCase() === "l") {
      void controller.reloadRuntimeSettings();
    } else if (key.return) {
      void controller.applyRuntimeSettings();
    } else if (key.backspace || key.delete) {
      controller.setRuntimeSettingsModelInput(modelInput.slice(0, -1));
    } else if (
      !key.ctrl &&
      !key.meta &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow &&
      !key.pageDown &&
      !key.pageUp &&
      !key.home &&
      !key.end &&
      !key.tab
    ) {
      const printable = input.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "");
      if (printable.length > 0) {
        controller.setRuntimeSettingsModelInput(modelInput + printable);
      }
    }
    return;
  }
  if (state.mode === "thread_list") {
    if (key.escape) {
      controller.closeThreadBrowserLevel();
    } else if (input === "/") {
      controller.enterThreadSearch();
    } else if (key.upArrow) {
      controller.selectThread(-1);
    } else if (key.downArrow) {
      controller.selectThread(1);
    } else if (key.pageUp) {
      controller.pageThreadList(-1);
    } else if (key.pageDown) {
      controller.pageThreadList(1);
    } else if (key.return) {
      void controller.previewSelectedThread();
    }
    return;
  }
  if (state.mode === "thread_search_input") {
    const searchInput = state.threadBrowser?.search?.input ?? "";
    if (key.escape) {
      controller.closeThreadBrowserLevel();
    } else if (key.return) {
      void controller.submitThreadSearch();
    } else if (key.backspace || key.delete) {
      controller.setThreadSearchInput(searchInput.slice(0, -1));
    } else if (
      !key.ctrl &&
      !key.meta &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow &&
      !key.pageDown &&
      !key.pageUp &&
      !key.home &&
      !key.end &&
      !key.tab
    ) {
      const printable = input.replace(/[\u0000-\u001f\u007f]/gu, "");
      if (printable.length > 0) {
        controller.setThreadSearchInput(searchInput + printable);
      }
    }
    return;
  }
  if (state.mode === "thread_search_results") {
    if (key.escape) {
      controller.closeThreadBrowserLevel();
    } else if (input === "/") {
      controller.enterThreadSearch();
    } else if (key.upArrow) {
      controller.selectSearchResult(-1);
    } else if (key.downArrow) {
      controller.selectSearchResult(1);
    } else if (key.pageUp) {
      void controller.pageSearchResults(-1);
    } else if (key.pageDown) {
      void controller.pageSearchResults(1);
    } else if (key.return) {
      void controller.previewSelectedSearchResult();
    }
    return;
  }
  if (state.mode === "thread_preview") {
    if (key.escape) {
      controller.closeThreadBrowserLevel();
    } else if (key.upArrow) {
      void controller.scrollPreview("up");
    } else if (key.downArrow) {
      void controller.scrollPreview("down");
    } else if (key.pageUp) {
      void controller.scrollPreview("page_up");
    } else if (key.pageDown) {
      void controller.scrollPreview("page_down");
    } else if (key.home) {
      void controller.scrollPreview("home");
    } else if (key.end) {
      void controller.scrollPreview("end");
    } else if (input.toLowerCase() === "r") {
      void controller.resumePreviewedThread();
    } else if (input.toLowerCase() === "a") {
      void controller.openPreviewArtifacts();
    } else if (input.toLowerCase() === "c") {
      void controller.openPreviewContext();
    }
    return;
  }
  if (state.planAcceptance !== undefined) {
    const acceptance = state.planAcceptance;
    if (acceptance.resolving) {
      return;
    }
    if (acceptance.interaction === "feedback") {
      if (key.escape) {
        controller.cancelPlanAcceptanceFeedback();
      } else if (key.return) {
        void controller.resolvePlanAcceptance("changes_requested");
      } else if (key.backspace || key.delete) {
        controller.setPlanAcceptanceFeedback(
          [...acceptance.feedback].slice(0, -1).join(""),
        );
      } else if (
        !key.ctrl &&
        !key.meta &&
        !key.upArrow &&
        !key.downArrow &&
        !key.leftArrow &&
        !key.rightArrow &&
        !key.pageDown &&
        !key.pageUp &&
        !key.home &&
        !key.end &&
        !key.tab
      ) {
        const printable = input.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "");
        if (printable.length > 0) {
          controller.setPlanAcceptanceFeedback(acceptance.feedback + printable);
        }
      }
      return;
    }
    if (key.escape) {
      void controller.cancelActiveTurn();
    } else if (input.toLowerCase() === "y") {
      void controller.resolvePlanAcceptance("accepted");
    } else if (input.toLowerCase() === "n") {
      controller.enterPlanAcceptanceFeedback();
    }
    return;
  }
  if (key.escape && state.activeTurn !== undefined) {
    void controller.cancelActiveTurn();
    return;
  }
  if (state.approval !== undefined) {
    if (state.approval.resolving) {
      return;
    }
    const decision = input.toLowerCase();
    if (decision === "y") {
      void controller.resolveApproval("approved");
    } else if (
      decision === "a" &&
      state.approval.grantCandidate !== undefined
    ) {
      void controller.resolveApproval("approved", true);
    } else if (decision === "n") {
      void controller.resolveApproval("rejected");
    } else if (decision === "d") {
      controller.toggleApprovalDetails();
    }
    return;
  }
  if (state.activeTurn !== undefined || state.connection !== "ready") {
    return;
  }
  if (key.return) {
    void controller.submitInput().then((result) => {
      if (result === "exit") {
        requestExit();
      }
    });
    return;
  }
  if (key.backspace || key.delete) {
    controller.setInput(state.input.slice(0, -1));
    return;
  }
  if (
    key.ctrl ||
    key.meta ||
    key.upArrow ||
    key.downArrow ||
    key.leftArrow ||
    key.rightArrow ||
    key.pageDown ||
    key.pageUp ||
    key.home ||
    key.end ||
    key.tab
  ) {
    return;
  }
  const printable = input.replace(/[\u0000-\u001f\u007f]/gu, "");
  if (printable.length > 0) {
    controller.setInput(state.input + printable);
  }
}

function processKeySequence(input: string, key: Key): string | undefined {
  if (key.return) return "\r";
  if (key.tab) return "\t";
  if (key.backspace) return "\u007f";
  if (key.delete) return "\u001b[3~";
  if (key.upArrow) return "\u001b[A";
  if (key.downArrow) return "\u001b[B";
  if (key.rightArrow) return "\u001b[C";
  if (key.leftArrow) return "\u001b[D";
  if (key.home) return "\u001b[H";
  if (key.end) return "\u001b[F";
  if (key.pageUp) return "\u001b[5~";
  if (key.pageDown) return "\u001b[6~";
  if (key.escape) return "\u001b";
  if (key.ctrl && input.length === 1) {
    const codePoint = input.toUpperCase().codePointAt(0);
    if (codePoint !== undefined && codePoint >= 0x40 && codePoint <= 0x5f) {
      return String.fromCharCode(codePoint & 0x1f);
    }
    return undefined;
  }
  if (key.meta) return undefined;
  const printable = input.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "");
  return printable.length === 0 ? undefined : printable;
}

function ThreadList({ state }: { state: TuiState }) {
  const browser = state.threadBrowser;
  if (browser === undefined) {
    return <Text color="red">Thread browser state is unavailable.</Text>;
  }
  const visible = browser.threads.slice(
    browser.listScrollOffset,
    browser.listScrollOffset + browser.viewportHeight,
  );
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        Recent threads · {boundPresentationText(state.configuration.cwd, 512)}
      </Text>
      {browser.threads.length === 0 ? (
        <Text dimColor>No threads found in this workspace.</Text>
      ) : (
        visible.map((thread, visibleIndex) => {
          const index = browser.listScrollOffset + visibleIndex;
          return (
            <Text
              key={thread.threadId}
              bold={index === browser.selectedIndex}
              {...(index === browser.selectedIndex ? { color: "cyan" } : {})}
            >
              {`${index === browser.selectedIndex ? ">" : " "} ${thread.threadId} · ${thread.status} · ${thread.provider ?? "unknown"}/${boundPresentationText(thread.model ?? "unknown", 256)} · ${thread.turnCount} turns · ${thread.usage.tokens.totalTokens} tokens · ${thread.updatedAt}`}
            </Text>
          );
        })
      )}
      <Text dimColor>
        {browser.loading
          ? "Loading preview…"
          : "↑/↓ select · PgUp/PgDn page · / search · Enter preview · Esc back"}
      </Text>
    </Box>
  );
}

function RuntimeSettingsProvider({ state }: { state: TuiState }) {
  const settings = state.runtimeSettings;
  if (settings === undefined) {
    return <Text color="red">Runtime settings state is unavailable.</Text>;
  }
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Runtime settings · choose provider</Text>
      {state.providers.map((provider, index) => (
        <Text
          key={provider.id}
          bold={index === settings.selectedIndex}
          {...(index === settings.selectedIndex ? { color: "cyan" } : {})}
        >
          {`${index === settings.selectedIndex ? ">" : " "} ${provider.displayName} (${provider.id}) · ${provider.configured ? "configured" : `missing ${provider.credentialEnvironmentVariable}`} · default ${boundPresentationText(provider.defaultModel, 256)}`}
        </Text>
      ))}
      <Text dimColor>
        {settings.loading
          ? "Loading settings… · Esc back"
          : "↑/↓ select · Enter model · Ctrl+L reload · Esc discard"}
      </Text>
    </Box>
  );
}

function RuntimeSettingsModel({ state }: { state: TuiState }) {
  const settings = state.runtimeSettings;
  const provider = state.providers.find(
    (candidate) => candidate.id === settings?.draftProvider,
  );
  if (settings === undefined || provider === undefined) {
    return <Text color="red">Runtime model settings are unavailable.</Text>;
  }
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{`Runtime settings · ${provider.displayName}`}</Text>
      <Text
        dimColor
      >{`default: ${boundPresentationText(provider.defaultModel, 256)}`}</Text>
      <Box>
        <Text bold color="cyan">
          {"model: "}
        </Text>
        <Text>{settings.modelInput}</Text>
        <Text inverse> </Text>
      </Box>
      <Text dimColor>
        {settings.loading
          ? "Saving settings… · Esc back"
          : "Enter Apply · Ctrl+R default · Ctrl+L reload revision · Esc back"}
      </Text>
    </Box>
  );
}

function ArtifactList({ state }: { state: TuiState }) {
  const navigation = state.artifactNavigation;
  const list = navigation?.list;
  if (navigation === undefined) {
    return <Text color="red">Artifact navigation state is unavailable.</Text>;
  }
  const visible =
    list === undefined
      ? []
      : list.artifacts.slice(
          list.scrollOffset,
          list.scrollOffset + navigation.viewportHeight,
        );
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{`Thread artifacts · ${navigation.threadId}`}</Text>
      {navigation.loading && list === undefined ? (
        <Text dimColor>Loading artifacts…</Text>
      ) : list === undefined || list.artifacts.length === 0 ? (
        <Text dimColor>No recorded artifacts in this thread.</Text>
      ) : (
        visible.map((descriptor, visibleIndex) => {
          const index = list.scrollOffset + visibleIndex;
          return (
            <Text
              key={`${descriptor.sequence}:${descriptor.artifact.id}`}
              bold={index === list.selectedIndex}
              {...(index === list.selectedIndex ? { color: "cyan" } : {})}
            >
              {`${index === list.selectedIndex ? ">" : " "} ${boundPresentationText(descriptor.name, 128)} · ${descriptor.artifact.mediaType} · ${descriptor.artifact.bytes} bytes · ${shortArtifactId(descriptor.artifact.id)}`}
            </Text>
          );
        })
      )}
      <Text dimColor>
        {navigation.loading
          ? "Loading artifact list… · Esc back"
          : "↑/↓ select · PgUp/PgDn page · Home/End boundary · Enter open · Esc back"}
      </Text>
    </Box>
  );
}

function ArtifactViewer({ state }: { state: TuiState }) {
  const navigation = state.artifactNavigation;
  const view = navigation?.view;
  if (navigation === undefined) {
    return <Text color="red">Artifact viewer state is unavailable.</Text>;
  }
  const rows =
    view === undefined
      ? []
      : view.rows.slice(
          view.scrollOffset,
          view.scrollOffset + navigation.viewportHeight,
        );
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        {view === undefined ? "Artifact" : view.page.artifact.id}
      </Text>
      {view === undefined ? null : (
        <Text dimColor>
          {`${view.page.artifact.mediaType} · ${view.page.startByte}–${view.page.endByte} / ${view.page.totalBytes} bytes`}
        </Text>
      )}
      {navigation.loading && view === undefined ? (
        <Text dimColor>Loading artifact…</Text>
      ) : (
        rows.map((row, index) => (
          <Text
            key={`${view?.page.startByte ?? 0}:${view?.scrollOffset ?? 0}:${index}`}
          >
            {row.length === 0 ? " " : row}
          </Text>
        ))
      )}
      <Text dimColor>
        {navigation.loading
          ? "Loading artifact range… · Esc back"
          : "↑/↓ scroll · PgUp/PgDn byte range · Home/End boundary · Esc back"}
      </Text>
    </Box>
  );
}

function ContextList({ state }: { state: TuiState }) {
  const navigation = state.contextNavigation;
  const list = navigation?.list;
  if (navigation === undefined) {
    return <Text color="red">Context navigation state is unavailable.</Text>;
  }
  const visible =
    list === undefined
      ? []
      : list.requests.slice(
          list.scrollOffset,
          list.scrollOffset + navigation.viewportHeight,
        );
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{`Prepared context · ${navigation.threadId}`}</Text>
      {navigation.loading && list === undefined ? (
        <Text dimColor>Loading context requests…</Text>
      ) : list === undefined || list.requests.length === 0 ? (
        <Text dimColor>No inspectable model requests in this thread.</Text>
      ) : (
        visible.map((request, visibleIndex) => {
          const index = list.scrollOffset + visibleIndex;
          const percentage =
            request.estimatedInputTokens === undefined ||
            request.inputBudgetTokens === undefined
              ? "budget unknown"
              : `${Math.round((request.estimatedInputTokens / request.inputBudgetTokens) * 100)}% budget`;
          const measured =
            request.measuredInputTokens === undefined
              ? "unmeasured"
              : `${request.measuredInputTokens} measured`;
          return (
            <Text
              key={request.anchorSequence}
              bold={index === list.selectedIndex}
              {...(index === list.selectedIndex ? { color: "cyan" } : {})}
            >
              {`${index === list.selectedIndex ? ">" : " "} #${request.anchorSequence} · Turn ${request.turnId} step ${request.step} · ${request.precise ? "precise" : "legacy"} · ${request.estimatedInputTokens ?? "?"} estimated / ${percentage} · ${measured} · ${request.activeItemCount ?? "?"} items · ${request.toolCount ?? "?"} tools${request.compactionItemId === undefined ? "" : " · compacted"}`}
            </Text>
          );
        })
      )}
      <Text dimColor>
        {navigation.loading
          ? "Loading context requests… · Esc back"
          : "↑/↓ select · PgUp/PgDn page · Home/End boundary · Enter detail · Esc back"}
      </Text>
    </Box>
  );
}

function ContextDetail({ state }: { state: TuiState }) {
  const navigation = state.contextNavigation;
  const detail = navigation?.detail;
  if (navigation === undefined) {
    return <Text color="red">Context detail state is unavailable.</Text>;
  }
  if (detail === undefined) {
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>Context detail</Text>
        <Text dimColor>Loading context detail…</Text>
      </Box>
    );
  }
  const result = detail.result;
  const telemetry = result.telemetry;
  const visibleSources = result.instructions.sources.slice(
    detail.sourceScrollOffset,
    detail.sourceScrollOffset + navigation.viewportHeight,
  );
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        {`Context #${result.request.anchorSequence} · ${result.request.provider}/${boundPresentationText(result.request.model, 256)} · Turn ${result.request.turnId} step ${result.request.step}`}
      </Text>
      <Text dimColor>
        {`${result.request.timestamp} · ${result.request.precise ? "precise durable telemetry" : "legacy Usage projection"}`}
      </Text>
      {telemetry === undefined ? (
        <Text dimColor>Exact historical budget telemetry is unavailable.</Text>
      ) : (
        <>
          <Text>
            {`budget ${telemetry.estimatedInputTokens}/${telemetry.inputBudgetTokens} · raw ${telemetry.rawEstimatedInputTokens} · fixed ${telemetry.fixedInputTokens} · output reserve ${telemetry.maxOutputTokens} · safety ${telemetry.safetyMarginTokens}`}
          </Text>
          <Text>
            {`calibration ×${telemetry.calibrationFactor.toFixed(3)} · ${telemetry.activeItemCount} items (${telemetry.activeItemTypes.map((entry) => `${entry.type}:${entry.count}`).join(", ") || "none"}) · ${telemetry.toolCount} tools`}
          </Text>
          <Text dimColor>
            {`items sha256 ${shortDigest(telemetry.activeItemsSha256)} · tools sha256 ${shortDigest(telemetry.toolsSha256)} · reconstruction ${result.reconstruction?.valid === true ? "valid" : "unavailable"}`}
          </Text>
        </>
      )}
      <Text>
        {result.usage === undefined
          ? "measured Usage: unavailable"
          : `measured Usage: ${result.usage.usage.inputTokens} input · ${result.usage.usage.outputTokens} output · ${result.usage.usage.totalTokens} total`}
      </Text>
      <Text>
        {result.compaction === undefined
          ? "Compaction: none"
          : `Compaction: ${result.compaction.id} · ${result.compaction.estimatedTokensBefore ?? "?"} → ${result.compaction.estimatedTokensAfter ?? "?"} · ${boundPresentationText(result.compaction.summary.objective || "summary recorded", 256)}`}
      </Text>
      <Text
        color={
          result.instructions.effectiveMatchesHistorical ? "green" : "yellow"
        }
      >
        {result.instructions.effectiveMatchesHistorical
          ? "Current effective instructions exactly match this request."
          : "Current effective instructions differ from this historical request."}
      </Text>
      {visibleSources.map((source, visibleIndex) => {
        const index = detail.sourceScrollOffset + visibleIndex;
        const bytes = source.current?.bytes ?? source.historical?.bytes ?? "?";
        const digest = source.current?.sha256 ?? source.historical?.sha256;
        return (
          <Text
            key={`${source.kind}:${source.path}`}
            bold={index === detail.selectedSourceIndex}
            {...(index === detail.selectedSourceIndex ? { color: "cyan" } : {})}
          >
            {`${index === detail.selectedSourceIndex ? ">" : " "} ${source.path} · ${source.status} · scope ${source.scope} · ${bytes} bytes · ${digest === undefined ? "no digest" : shortDigest(digest)}${source.sourceId === undefined ? " · unavailable" : ""}`}
          </Text>
        );
      })}
      <Text dimColor>
        {navigation.loading
          ? "Loading context detail… · Esc back"
          : "↑/↓ select current instruction · Enter open · Esc request list"}
      </Text>
    </Box>
  );
}

function ContextInstructionViewer({ state }: { state: TuiState }) {
  const navigation = state.contextNavigation;
  const view = navigation?.instructionView;
  if (navigation === undefined) {
    return <Text color="red">Instruction viewer state is unavailable.</Text>;
  }
  const rows =
    view === undefined
      ? []
      : view.rows.slice(
          view.scrollOffset,
          view.scrollOffset + navigation.viewportHeight,
        );
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{view?.page.path ?? "Current instruction source"}</Text>
      {view === undefined ? null : (
        <Text dimColor>
          {`${view.page.startByte}–${view.page.endByte} / ${view.page.totalBytes} UTF-8 bytes · current content`}
        </Text>
      )}
      {navigation.loading && view === undefined ? (
        <Text dimColor>Loading instruction source…</Text>
      ) : (
        rows.map((row, index) => (
          <Text
            key={`${view?.page.startByte ?? 0}:${view?.scrollOffset ?? 0}:${index}`}
          >
            {row.length === 0 ? " " : row}
          </Text>
        ))
      )}
      <Text dimColor>
        {navigation.loading
          ? "Loading instruction range… · Esc detail"
          : "↑/↓ scroll · PgUp/PgDn byte range · Home/End boundary · Esc detail"}
      </Text>
    </Box>
  );
}

function PlanView({ state }: { state: TuiState }) {
  const navigation = state.planNavigation;
  if (navigation === undefined) {
    return <Text color="red">Plan view state is unavailable.</Text>;
  }
  const visible = navigation.rows.slice(
    navigation.scrollOffset,
    navigation.scrollOffset + navigation.viewportHeight,
  );
  const firstRow =
    navigation.rows.length === 0 ? 0 : navigation.scrollOffset + 1;
  const lastRow = Math.min(
    navigation.rows.length,
    navigation.scrollOffset + navigation.viewportHeight,
  );
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color="cyan">
        Durable Plan · {navigation.threadId}
      </Text>
      {navigation.loading ? (
        <Text dimColor>Loading authoritative Plan state…</Text>
      ) : (
        visible.map((row, index) => (
          <Text key={`${navigation.scrollOffset}:${index}`}>
            {row.length === 0 ? " " : row}
          </Text>
        ))
      )}
      <Text dimColor>
        {navigation.loading
          ? "Loading… · Esc back"
          : `${firstRow}–${lastRow} / ${navigation.rows.length} rows · ↑/↓ scroll · PgUp/PgDn page · Home/End boundary · Esc back`}
      </Text>
    </Box>
  );
}

function ExtensionsView({ state }: { state: TuiState }) {
  const navigation = state.extensionNavigation;
  if (navigation === undefined) {
    return <Text color="red">Extension view state is unavailable.</Text>;
  }
  const visible = navigation.rows.slice(
    navigation.scrollOffset,
    navigation.scrollOffset + navigation.viewportHeight,
  );
  const firstRow =
    navigation.rows.length === 0 ? 0 : navigation.scrollOffset + 1;
  const lastRow = Math.min(
    navigation.rows.length,
    navigation.scrollOffset + navigation.viewportHeight,
  );
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color="cyan">
        Extension catalogs
      </Text>
      {navigation.loading ? (
        <Text dimColor>Loading current and durable extension catalogs…</Text>
      ) : (
        visible.map((row, index) => (
          <Text key={`${navigation.scrollOffset}:${index}`}>
            {row.length === 0 ? " " : row}
          </Text>
        ))
      )}
      <Text dimColor>
        {navigation.loading
          ? "Loading… · Esc back"
          : `${firstRow}–${lastRow} / ${navigation.rows.length} rows · ↑/↓ scroll · PgUp/PgDn page · Home/End boundary · Esc back`}
      </Text>
    </Box>
  );
}

function ActivityView({ state }: { state: TuiState }) {
  const navigation = state.activityNavigation;
  if (navigation === undefined) {
    return <Text color="red">Activity view state is unavailable.</Text>;
  }
  const visible = navigation.rows.slice(
    navigation.scrollOffset,
    navigation.scrollOffset + navigation.viewportHeight,
  );
  const firstRow =
    navigation.rows.length === 0 ? 0 : navigation.scrollOffset + 1;
  const lastRow = Math.min(
    navigation.rows.length,
    navigation.scrollOffset + navigation.viewportHeight,
  );
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color="cyan">
        Durable activity · {navigation.threadId}
      </Text>
      {navigation.loading ? (
        <Text dimColor>Loading authoritative activity events…</Text>
      ) : visible.length === 0 ? (
        <Text dimColor>No execution activity on this event page.</Text>
      ) : (
        visible.map((row, index) => (
          <Text key={`${navigation.scrollOffset}:${index}`}>
            {row.length === 0 ? " " : row}
          </Text>
        ))
      )}
      <Text dimColor>
        {navigation.loading
          ? "Loading… · Esc back"
          : `${firstRow}–${lastRow} / ${navigation.rows.length} activity rows · ${navigation.hasEarlier ? "earlier available" : "earliest page"} · ${navigation.hasLater ? "later available" : "latest page"} · ↑/↓ scroll · PgUp/PgDn event page · Home/End boundary · Esc back`}
      </Text>
    </Box>
  );
}

function ProcessList({ state }: { state: TuiState }) {
  const navigation = state.processNavigation;
  if (navigation === undefined) {
    return <Text color="red">Process navigation state is unavailable.</Text>;
  }
  const visible = navigation.processes.slice(
    navigation.scrollOffset,
    navigation.scrollOffset + navigation.viewportHeight,
  );
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color="cyan">
        Durable terminal jobs · {state.configuration.cwd}
      </Text>
      {navigation.loading ? (
        <Text dimColor>Loading terminal jobs…</Text>
      ) : visible.length === 0 ? (
        <Text dimColor>No PTY jobs in this workspace.</Text>
      ) : (
        visible.map((process, visibleIndex) => {
          const index = navigation.scrollOffset + visibleIndex;
          return (
            <Text
              key={process.jobId}
              bold={index === navigation.selectedIndex}
              {...(index === navigation.selectedIndex ? { color: "cyan" } : {})}
            >
              {`${index === navigation.selectedIndex ? ">" : " "} ${boundPresentationText(process.displayName, 128)} · ${process.jobId.slice(0, 8)} · ${process.state} · ${process.lifecycle} · pid ${process.pid ?? "—"} · ${compactExecutionSecurity(process.security)} · ${process.updatedAtMs}`}
            </Text>
          );
        })
      )}
      <Text dimColor>
        {navigation.loading
          ? "Loading… · Esc back"
          : "↑/↓ select · PgUp/PgDn page · Home/End · r refresh · Enter attach · Esc back"}
      </Text>
    </Box>
  );
}

function ProcessView({ state }: { state: TuiState }) {
  const navigation = state.processNavigation;
  const session = navigation?.session;
  if (navigation === undefined || session === undefined) {
    return <Text color="red">Process attachment state is unavailable.</Text>;
  }
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color="cyan">
        {`${session.process.displayName} · ${session.process.jobId.slice(0, 8)} · ${session.process.state}`}
      </Text>
      <Text dimColor>
        {`${session.inputState === "owned" ? "input owned" : "read-only"} · ${session.rows}×${session.cols} · cursor ${session.cursor} · retained ${session.earliestCursor}–${session.latestCursor}${session.complete ? " · complete" : ""} · ${compactExecutionSecurity(session.process.security)}`}
      </Text>
      {session.screenRows.length === 0 ? (
        <Text dimColor>Waiting for terminal output…</Text>
      ) : (
        session.screenRows.map((row, index) => (
          <Text key={`${session.cursor}:${index}`}>
            {row.length === 0 ? " " : row}
          </Text>
        ))
      )}
      <Text dimColor>
        {session.inputState === "owned"
          ? "typing → PTY · Ctrl+C interrupt · Ctrl+K terminate · Ctrl+] detach"
          : "w acquire input · k terminate · Ctrl+] detach"}
      </Text>
    </Box>
  );
}

function compactExecutionSecurity(security: ExecutionSecuritySnapshot): string {
  return security.kind === "legacy_unknown"
    ? "security unknown (legacy)"
    : `OS sandbox: none · ${security.backend} · fs ${security.policy.filesystem} · net ${security.policy.network}`;
}

function ProcessTerminateConfirmation({ state }: { state: TuiState }) {
  const session = state.processNavigation?.session;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="red"
      paddingX={1}
    >
      <Text bold color="red">
        Terminate durable process?
      </Text>
      <Text>
        {session === undefined
          ? "The attached process is unavailable."
          : `${session.process.displayName} · ${session.process.jobId}`}
      </Text>
      <Text dimColor>
        {session?.terminating === true
          ? "Terminating the complete process group…"
          : "y terminate · n/Esc cancel"}
      </Text>
    </Box>
  );
}

function PlanAcceptanceCard({ state }: { state: TuiState }) {
  const acceptance = state.planAcceptance;
  if (acceptance === undefined) {
    return null;
  }
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
    >
      <Text bold color="magenta">
        {`Stage acceptance required · ${acceptance.stageId} · Plan r${acceptance.planRevision}`}
      </Text>
      <Text>{acceptance.summary}</Text>
      {acceptance.criteria.map((criterion, index) => (
        <Text key={`criterion:${index}`}>{`criterion: ${criterion}`}</Text>
      ))}
      {acceptance.evidence.map((evidence, index) => (
        <Text key={`evidence:${index}`} dimColor>
          {`evidence: ${planEvidenceLabel(evidence)}`}
        </Text>
      ))}
      {acceptance.interaction === "feedback" ? (
        <>
          <Box>
            <Text bold color="cyan">
              changes{"> "}
            </Text>
            <Text>{acceptance.feedback}</Text>
            <Text inverse> </Text>
          </Box>
          <Text dimColor>
            {acceptance.resolving
              ? "Submitting required changes…"
              : "Enter submit · Esc back"}
          </Text>
        </>
      ) : (
        <Text dimColor>
          {acceptance.resolving
            ? "Resolving Stage acceptance…"
            : "y accept · n request changes · Esc cancel turn"}
        </Text>
      )}
    </Box>
  );
}

function ThreadSearchInput({ state }: { state: TuiState }) {
  const search = state.threadBrowser?.search;
  if (search === undefined) {
    return <Text color="red">Thread search state is unavailable.</Text>;
  }
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Search durable history</Text>
      <Box>
        <Text bold color="cyan">
          {"/ "}
        </Text>
        <Text>{search.input}</Text>
        <Text inverse> </Text>
      </Box>
      <Text dimColor>Enter search · Esc back · up to 8 AND terms</Text>
    </Box>
  );
}

function ThreadSearchResults({ state }: { state: TuiState }) {
  const browser = state.threadBrowser;
  const search = browser?.search;
  if (browser === undefined || search === undefined) {
    return <Text color="red">Thread search results are unavailable.</Text>;
  }
  const visible = search.matches.slice(
    search.scrollOffset,
    search.scrollOffset + browser.viewportHeight,
  );
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        {`History search · “${boundPresentationText(search.query, 256)}” · ${search.matches.length}${search.hasMore ? "+" : ""} matches`}
      </Text>
      {search.loading && search.matches.length === 0 ? (
        <Text dimColor>Searching…</Text>
      ) : search.matches.length === 0 ? (
        <Text dimColor>No matching durable history.</Text>
      ) : (
        visible.map((match, visibleIndex) => {
          const index = search.scrollOffset + visibleIndex;
          return (
            <Box key={`${match.threadId}:${match.sequence}`}>
              <Text
                bold={index === search.selectedIndex}
                {...(index === search.selectedIndex ? { color: "cyan" } : {})}
              >
                {`${index === search.selectedIndex ? ">" : " "} ${match.threadId} #${match.sequence} · ${match.kind} · `}
              </Text>
              <Text dimColor>{match.snippet}</Text>
            </Box>
          );
        })
      )}
      <Text dimColor>
        {search.loading
          ? "Loading results… · Esc back"
          : "↑/↓ select · PgUp/PgDn page/load · / edit · Enter context · Esc back"}
      </Text>
    </Box>
  );
}

function ThreadPreview({ state }: { state: TuiState }) {
  const preview = state.threadBrowser?.preview;
  if (preview === undefined) {
    return <Text color="red">Thread preview state is unavailable.</Text>;
  }
  const viewportHeight = state.threadBrowser?.viewportHeight ?? 12;
  const visibleEntries = preview.entries.slice(
    preview.scrollOffset,
    preview.scrollOffset + viewportHeight,
  );
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        {`${preview.thread.threadId} · ${preview.thread.status} · ${preview.thread.provider ?? "unknown"}/${boundPresentationText(preview.thread.model ?? "unknown", 256)}`}
      </Text>
      <Text dimColor>
        {`${preview.thread.updatedAt} · ${preview.thread.turnCount} turns · ${preview.thread.usage.tokens.totalTokens} tokens`}
      </Text>
      {preview.hasEarlier ? (
        <Text dimColor>Earlier durable events are available.</Text>
      ) : null}
      {preview.hasLater ? (
        <Text dimColor>Later durable events are available.</Text>
      ) : null}
      {preview.match === undefined ? null : (
        <Text color="magenta">
          {`match #${preview.match.sequence} · ${preview.match.kind}`}
        </Text>
      )}
      {preview.entries.length === 0 ? (
        <Text dimColor>No displayable history in the latest event page.</Text>
      ) : (
        visibleEntries.map((entry) => (
          <TranscriptRow key={entry.id} entry={entry} />
        ))
      )}
      <Text dimColor>
        {state.threadBrowser?.loading
          ? "Checking thread… · Esc back"
          : preview.thread.status === "invalid"
            ? "Invalid thread · Esc back"
            : "↑/↓ scroll · PgUp/PgDn page · Home/End boundary · a artifacts · c context · r resume · Esc back"}
      </Text>
    </Box>
  );
}

function TranscriptRow({ entry }: { entry: TuiTranscriptEntry }) {
  const presentation = transcriptPresentation(entry.kind);
  return (
    <Box>
      {entry.matched === true ? (
        <Text bold color="magenta">
          match{" "}
        </Text>
      ) : null}
      <Text
        bold
        {...(presentation.color === undefined
          ? {}
          : { color: presentation.color })}
      >
        {presentation.label}
      </Text>
      <Text
        dimColor={entry.matched === true ? false : presentation.dim}
        {...(entry.matched === true ? { color: "magenta" } : {})}
      >
        {" "}
        {entry.text}
      </Text>
    </Box>
  );
}

function ActiveTurn({ state }: { state: NonNullable<TuiState["activeTurn"]> }) {
  const activity = projectLiveToolActivity(state.tools);
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="green">
          Koda
        </Text>
        <Text>
          {state.assistantText.length === 0 ? " …" : ` ${state.assistantText}`}
        </Text>
      </Box>
      {activity.readSummary === undefined ? null : (
        <Text color="yellow">{`↳ ${activity.readSummary}`}</Text>
      )}
      {activity.hiddenCompletedCount === 0 ? null : (
        <Text dimColor>
          {`↳ ${activity.hiddenCompletedCount} older completed tool call${activity.hiddenCompletedCount === 1 ? "" : "s"} hidden · /activity for full trace`}
        </Text>
      )}
      {activity.visibleTools.map((tool) => (
        <Text key={tool.callId} color="yellow">
          {`↳ ${tool.name}: ${tool.status.replaceAll("_", " ")}${tool.detail === undefined ? "" : ` · ${tool.detail}`}`}
        </Text>
      ))}
    </Box>
  );
}

function StatusLine({ state }: { state: TuiState }) {
  const active = state.activeTurn?.status ?? "idle";
  const usage = state.activeTurn?.usage;
  const next = state.nextThreadConfiguration;
  const nextLabel =
    next.provider === state.configuration.provider &&
    next.model === state.configuration.model
      ? ""
      : ` · next ${next.provider}/${boundPresentationText(next.model, 256)}`;
  const plan = compactPlanStatus(
    state.currentPlan,
    state.planNeedsRevalidation,
  );
  return (
    <Text dimColor>
      {`${state.connection} · ${active} · approval ${state.configuration.approvalMode}${nextLabel}${plan === undefined ? "" : ` · plan ${plan}`}`}
      {usage === undefined ? "" : ` · ${usage.tokens.totalTokens} tokens`}
    </Text>
  );
}

function Prompt({ state }: { state: TuiState }) {
  if (state.approval !== undefined || state.planAcceptance !== undefined) {
    return null;
  }
  if (state.activeTurn !== undefined) {
    return <Text dimColor>Esc or Ctrl+C to cancel</Text>;
  }
  if (state.connection !== "ready") {
    return <Text dimColor>Ctrl+C to exit</Text>;
  }
  return (
    <Box>
      <Text bold color="cyan">
        {"> "}
      </Text>
      <Text>{state.input}</Text>
      <Text inverse> </Text>
    </Box>
  );
}

function transcriptPresentation(kind: TuiTranscriptEntry["kind"]): {
  label: string;
  color: "cyan" | "green" | "yellow" | "red" | undefined;
  dim: boolean;
} {
  switch (kind) {
    case "user":
      return { label: "You", color: "cyan", dim: false };
    case "assistant":
      return { label: "Koda", color: "green", dim: false };
    case "tool":
      return { label: "Tool", color: "yellow", dim: true };
    case "error":
      return { label: "Error", color: "red", dim: false };
    case "usage":
      return { label: "Usage", color: undefined, dim: true };
    case "system":
      return { label: "Koda", color: undefined, dim: true };
  }
}

function shortArtifactId(id: string): string {
  return id.length <= 24 ? id : `${id.slice(0, 15)}…${id.slice(-8)}`;
}

function shortDigest(digest: string): string {
  return digest.length <= 20
    ? digest
    : `${digest.slice(0, 12)}…${digest.slice(-7)}`;
}
