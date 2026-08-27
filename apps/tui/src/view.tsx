import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { Box, Static, Text, useApp, useInput, useStdout, type Key } from "ink";

import {
  TuiController,
  boundPresentationText,
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
      controller.setViewportHeight((stdout.rows ?? 20) - 8);
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
  resolveApproval(decision: "approved" | "rejected"): Promise<void>;
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
  setViewportHeight(height: number): void;
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
                  : "y approve · n reject · d details · Esc cancel turn"}
              </Text>
            </Box>
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
            : "↑/↓ scroll · PgUp/PgDn page · Home/End boundary · r resume · Esc back"}
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
      {state.tools.map((tool) => (
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
  return (
    <Text dimColor>
      {`${state.connection} · ${active} · approval ${state.configuration.approvalMode}`}
      {usage === undefined ? "" : ` · ${usage.tokens.totalTokens} tokens`}
    </Text>
  );
}

function Prompt({ state }: { state: TuiState }) {
  if (state.approval !== undefined) {
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
