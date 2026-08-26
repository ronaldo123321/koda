import { useCallback, useRef, useSyncExternalStore } from "react";
import { Box, Static, Text, useApp, useInput, type Key } from "ink";

import {
  TuiController,
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
          {` · ${state.configuration.provider}/${state.configuration.model} · ${state.threadId ?? "new thread"}`}
        </Text>
      </Box>

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

      {state.notice === undefined ? null : (
        <Text color={state.connection === "error" ? "red" : "yellow"}>
          {state.notice}
        </Text>
      )}

      <StatusLine state={state} />
      <Prompt state={state} />
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
  if (key.ctrl && input.toLowerCase() === "c") {
    if (state.activeTurn === undefined) {
      requestExit();
    } else {
      void controller.cancelActiveTurn();
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

function TranscriptRow({ entry }: { entry: TuiTranscriptEntry }) {
  const presentation = transcriptPresentation(entry.kind);
  return (
    <Box>
      <Text
        bold
        {...(presentation.color === undefined
          ? {}
          : { color: presentation.color })}
      >
        {presentation.label}
      </Text>
      <Text dimColor={presentation.dim}> {entry.text}</Text>
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
