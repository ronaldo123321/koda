# Koda Phase 3D: Ink Chat REPL

- Status: Approved for implementation (2026-08-26)
- Date: 2026-08-26
- Depends on: Phase 3A local stdio app-server and Phase 3C app-server protocol v2 provider metadata
- Scope: a local interactive Ink chat client that exercises the app-server protocol, streams durable turn events, mediates one-shot approvals, and owns one app-server child process

## 1. Outcome

Phase 3D adds Koda's first long-lived interactive client. A user can select a workspace, provider, model, approval mode, and optional thread to resume at startup; submit prompts continuously; watch streamed assistant and tool activity; resolve approvals; inspect token usage and errors; and cancel an active turn without leaving the process.

The client is a presentation and interaction layer over the Phase 3A application protocol. It does not import `@koda/app`, construct provider SDK clients, read model credentials, execute tools, or own durable conversation state. Completed transcript rows remain visible in normal terminal scrollback while the active response, tool status, approval card, and prompt are rendered in one bounded live region.

This phase does not add a thread picker, runtime provider switching, a full-screen alternate-buffer UI, rich artifact previews, attachments, or remote app-server connections. Those are explicit later destinations rather than hidden acceptance criteria.

## 2. Alternatives and decision

Three client boundaries were considered:

1. **Independent Ink TUI plus an owned app-server child process — selected.** The TUI communicates exclusively through the versioned stdio JSON-RPC protocol and exercises the same boundary intended for future IDE and desktop clients. The user starts one command; the client owns child startup and cleanup.
2. **Ink components directly import `@koda/app` — rejected.** This would be simpler initially but create a second client path that bypasses app-server framing, version negotiation, cancellation, and disconnect behavior.
3. **Require the user to launch app-server separately — deferred.** This is useful for remote or shared deployments, but it adds lifecycle configuration without improving the first local chat workflow.

The selected design introduces a reusable Node-specific app-server client below the TUI so process and protocol mechanics do not leak into React components.

## 3. Component architecture

```text
apps/tui
  -> React + Ink presentation
  -> TuiController / reducer
  -> @koda/app-server-client-node
       -> child-process lifecycle
       -> NDJSON framing
       -> JSON-RPC request correlation
       -> notification dispatch
          | local stdio
          v
       koda-app-server
          -> @koda/app
```

`@koda/app-server-client-node` is independent of React and Ink. It starts an injected or resolved app-server command, assigns monotonically increasing request IDs, matches responses to pending calls, validates protocol messages, publishes typed notifications, captures bounded stderr diagnostics, and performs graceful shutdown. That package is reusable by later Node-based clients and test fixtures.

`apps/tui` owns argument parsing, terminal capability checks, the controller, Ink rendering, and keyboard input. One TUI process owns exactly one app-server child. Startup performs the protocol v2 `initialize` handshake and caches the returned provider metadata before accepting a prompt. Production resolves the built app-server entry point from the installed Koda layout; tests inject a command, streams, or a fixture child.

The TUI never calls application services directly. Turns, thread queries, cancellation, approval resolution, and shutdown all cross JSON-RPC. This prevents the interactive client and app-server protocol from becoming divergent implementations of the same workflow.

## 4. Startup configuration and command boundary

The first release accepts startup arguments for:

- canonical workspace directory;
- provider identifier;
- optional model override;
- optional thread ID to resume;
- approval mode supported by app-server v2.

Provider metadata returned by `initialize` validates provider selection and supplies default-model/help information. Provider, model, workspace, and approval mode remain fixed for the life of the TUI process. A resumed thread continues with the durable provider constraints already enforced by `@koda/app`; the client does not attempt cross-provider migration.

Ordinary non-empty input starts a turn. The local command surface is intentionally small:

- `/help` lists local commands and shortcuts;
- `/status` shows connection, workspace, thread, provider, model, approval mode, active-turn state, and bounded child diagnostics;
- `/clear` clears only the displayed transcript and does not delete or mutate the durable thread;
- `/exit` performs graceful shutdown.

At most one turn is active. A prompt submitted while a turn or approval is pending is rejected locally with a clear status instead of being queued implicitly. Runtime provider/model switching, thread browsing, and settings panels belong to Phase 3E.

## 5. Controller state and message flow

`TuiController` owns a single serializable view state containing connection status, startup configuration, provider metadata, current thread ID, immutable completed transcript entries, active turn state, current assistant text, live tool rows, pending approval, usage totals, input text, and a bounded error/diagnostic summary. Ink components render this state and forward semantic user actions; they do not issue JSON-RPC requests themselves.

Submitting a prompt calls `turn/start`. Its response means only that the turn was accepted. Subsequent `turn/event` notifications are reduced by `turnId` into assistant deltas, tool status, approval state, usage, and diagnostics. `turn/finished` finalizes the active rows into the immutable transcript, records the returned thread identity/status, and re-enables input. The first new turn adopts the server-created thread ID; later turns automatically resume that thread.

Completed rows render through Ink's `<Static>` component so growing history is not repeatedly redrawn. The active assistant response, tool rows, approval card, status line, and input compose one live region beneath it. Koda stays in the terminal's normal screen buffer, preserving native scrollback and copy behavior. A full-screen viewport, transcript search, and custom scrolling are not part of Phase 3D.

Notifications for unknown or completed turns never mutate the active view silently. The controller reports a bounded protocol diagnostic and the client layer retains strict schema validation.

## 6. Approval and cancellation semantics

When app-server requests approval, ordinary prompt input is disabled and an inline approval card becomes the focused interaction:

- `y` approves the one pending request;
- `n` rejects it;
- `d` toggles a bounded detail view of the proposed operation;
- `Esc` cancels the whole active turn.

Phase 3D does not add session-wide approval caching or trusted command prefixes. Every approval remains the existing one-shot server-side decision, and presentation never changes the runtime's effect classification.

`Esc` and `Ctrl+C` during an active turn request `turn/cancel`. If an approval is pending, cancellation remains fail-closed: losing the client or cancelling the turn cannot be interpreted as approval. While idle, `Ctrl+C` and `/exit` initiate client shutdown. A second termination signal may force local process exit but still grants no approval.

The controller waits for the server's completion notification after requesting cancellation and shows a cancelling state. It does not optimistically claim that an effectful tool stopped. Existing durable process and tool events remain authoritative about whether execution started and how termination completed.

## 7. Process lifecycle and protocol safety

Child `stdout` is protocol-only NDJSON. Child `stderr` is collected independently in a bounded ring buffer and exposed through diagnostics without entering assistant output. The client applies the same 1 MiB maximum logical-line boundary as app-server and correctly handles fragmented lines, multiple messages in one chunk, and a final unterminated line only according to the transport contract.

Every response and notification is runtime-validated against `@koda/protocol`. Unknown request IDs, invalid JSON, oversized messages, incompatible initialization results, and structurally invalid notifications are protocol failures. A protocol failure disconnects the client, rejects all pending requests, terminates the active UI state with an error, and never resolves an approval positively.

Initialization, short RPCs, and graceful shutdown have bounded timeouts. `turn/start` returns promptly; the duration of the turn is represented by notifications rather than one long blocking RPC. Unexpected child exit rejects pending RPCs and ends the active turn visibly. Shutdown first sends `shutdown`, waits for the configured grace period, then terminates the owned child if necessary.

Phase 3D supports interactive TTY input and output. Non-TTY invocation exits with an actionable message directing automation to the existing line-oriented CLI or stdio app-server. Remote transports, authentication, reconnect/resubscribe, shared app-server processes, and crash-surviving supervision remain Phase 4 concerns.

## 8. Rendering responsibilities

Presentation components stay small and state-driven:

- `Transcript` renders completed user, assistant, tool, usage, and error rows through `<Static>`;
- `ActiveTurn` renders the streamed assistant body and current tool statuses;
- `ApprovalCard` renders a bounded operation summary and optional details;
- `StatusLine` renders provider/model/thread/connection state and keyboard hints;
- `PromptInput` handles editable input only while the controller is idle;
- `App` wires keyboard actions to controller commands.

The first release favors readable plain text and conservative color. It preserves exact model text but does not implement a full Markdown layout engine, syntax highlighting, diff browsing, or artifact downloads. Tool arguments and diagnostics are bounded before rendering so a single event cannot flood the live region.

The UI derives all durable facts from server responses and notifications. Clearing display history affects only presentation state. Exiting, terminal resizing, or React re-rendering cannot create, modify, approve, or complete a turn by themselves.

## 9. Testing and acceptance criteria

Tests remain offline and do not require provider credentials.

The app-server client suite covers child startup, protocol-v2 initialization, fragmented and coalesced NDJSON, request correlation, unknown IDs, notifications, invalid JSON, oversized lines, RPC timeouts, bounded stderr, graceful shutdown, forced cleanup, unexpected exit, and rejection of every pending request on disconnect.

Controller tests use a fake typed client and cover streaming deltas, ordered tool transitions, approval approve/reject/detail actions, cancel states, thread-ID adoption and reuse, usage aggregation, duplicate-submit rejection, command handling, `/clear` presentation-only behavior, and failure recovery. Focused Ink tests cover static history, the live region, approval input locking, status output, and keyboard routing. A credential-free real-subprocess smoke test exercises app-server initialize and shutdown.

The implementation is accepted when:

1. a TTY user can start or resume a multi-turn session with any Phase 3C provider configuration;
2. streamed assistant, tool, approval, usage, completion, cancellation, and error states remain coherent;
3. all client-loss and malformed-protocol paths fail closed;
4. the TUI communicates only through app-server v2;
5. format, typecheck, unit/integration tests, the existing six reliability scenarios, and a manual TTY smoke test pass.

## 10. Deferred destinations

- Thread selector, history search, full-screen/alternate-buffer navigation, custom scrolling, runtime provider/model switching, and settings panels: **Phase 3E interactive client expansion**.
- Markdown layout, syntax highlighting, diff and artifact viewers, artifact range/download UI, attachments, context-budget inspection, and instruction-change views: **Phase 3E or Phase 4 client APIs and rich presentation**.
- PTY-backed foreground/background workflows and managed process panes: **Phase 4 process UX and hardening**.
- Remote app-server connections, authentication, reconnect/resubscribe, shared servers, and multi-client broadcasting: **Phase 4 transport and distribution**.
- Session-wide approval caching or trusted command prefixes: **later explicit authorization design**, requiring inspectable scope, expiry, and revocation.
- Parent/child agent views, mailboxes, and multi-agent steering: **Phase 5 multi-agent and memory**.

## 11. Primary implementation references

- Ink repository, API, and current runtime requirements: <https://github.com/vadimdemedes/ink>
- Ink package metadata: <https://www.npmjs.com/package/ink>
- React package metadata: <https://www.npmjs.com/package/react>
