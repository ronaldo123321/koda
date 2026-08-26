# Koda Phase 1A: OpenAI CLI Vertical Slice

- Status: Implemented
- Date: 2026-08-26
- Depends on: Phase 0 deterministic agent foundation
- Scope: OpenAI Responses Provider, non-interactive CLI, streaming output, and read-only repository tools

## 1. Outcome

Phase 1A turns the deterministic harness into a useful read-only coding assistant. A user can run `koda run "explain this repository"` inside a project. Koda streams the model's answer, lets the model inspect files through constrained tools, records the event stream, and exits with a meaningful status code.

This phase deliberately stops before editing files or executing arbitrary commands. Its purpose is to validate the real provider boundary and product data flow while the side-effect surface is still small.

## 2. User experience

```bash
export OPENAI_API_KEY=...
koda run "find where authentication is configured" --cwd ./my-project
```

Expected behavior:

1. Koda resolves and validates the workspace root.
2. It starts a new thread and turn and creates a JSONL event log.
3. Text deltas are written to stdout as they arrive.
4. Tool lifecycle messages are written to stderr without mixing with answer text.
5. The model may call `list_files`, `read_file`, and `search_text` repeatedly.
6. The final answer ends with a newline and the process exits with code zero.
7. Configuration, authentication, provider, or turn failures produce a concise error and a non-zero exit code.

Phase 1A is non-interactive. It does not implement a chat REPL, steering, resume, or Ink rendering.

## 3. Decisions and alternatives

### 3.1 Responses state: `previous_response_id`

Three approaches were considered:

1. Replay normalized Koda transcript items into every request.
2. Preserve every OpenAI-native output item and replay those objects.
3. Use `previous_response_id` inside the provider and send only new function outputs.

Phase 1A uses option 3. Replaying only normalized messages can lose provider-native reasoning items, while exposing OpenAI item types to `agent-core` would violate the provider boundary. The provider maintains ephemeral per-turn response state and uses `previous_response_id` for follow-up model steps. It still resends stable top-level instructions on every request.

This state is intentionally process-local in Phase 1A. Persisting response identifiers for resume belongs to Phase 2. If a provider instance loses state during a turn, it fails explicitly instead of silently rebuilding an incomplete prompt.

### 3.2 Default model

The default is `gpt-5.6-terra`, chosen as the capability/cost balance for local development. `--model` and `KODA_MODEL` allow overrides. Koda does not hard-code assumptions about model context length or pricing.

### 3.3 CLI parser

Commander is used instead of a custom argument parser. The dependency cost is small, while stable help, required commands, variadic prompts, option validation, and exit behavior would otherwise become home-grown product code.

### 3.4 Repository inspection

- File listing and reading use Node filesystem APIs.
- Text search invokes `rg` with an argument vector and no shell.
- All paths pass through one workspace boundary helper.

Using Node for path enforcement keeps the security boundary independent of command output. Using ripgrep for content search avoids implementing a slower recursive search engine.

## 4. Architecture additions

```text
apps/cli
  run command
     |
     +-- ConsoleEventSink ------ stdout/stderr
     +-- JsonlEventStore ------- ~/.koda/threads/*.jsonl
     |
     v
AgentLoop
  |
  +-- OpenAIResponsesProvider -- OpenAI Responses API
  |
  +-- ToolRegistry
        +-- list_files
        +-- read_file
        +-- search_text
              |
              v
        ReadOnlyWorkspace
```

`apps/cli` is a composition root. It may depend on all runtime packages. None of those packages may import the CLI.

## 5. Streaming event flow

Phase 0 persisted completed assistant messages but did not expose individual text deltas. Phase 1A adds an operational `assistant.delta` event:

```ts
{
  schemaVersion: 1,
  type: "assistant.delta",
  payload: { text: string },
  // sequence, timestamp, threadId, turnId
}
```

For each provider `assistant_delta`, the loop first appends the delta event to its sink and then continues accumulation. At the end of the model step, the accumulated assistant message remains the canonical transcript item.

The CLI uses a fan-out sink:

```text
Agent event
  -> JSONL persistence
  -> console projection
```

Persistence runs first. If the event cannot be durably appended, the console must not present progress that Koda cannot recover or diagnose later.

The console projection prints only `assistant.delta` payloads to stdout. Tool start/completion and failures go to stderr. Tests inject memory writers rather than replacing global process streams.

## 6. OpenAI provider mapping

The provider implements the existing neutral interface:

```ts
interface ModelProvider {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}
```

First step:

```text
Koda user items
  -> Responses input messages
Koda tool definitions
  -> strict OpenAI function tools
```

Follow-up step:

```text
new Koda tool_result items
  -> function_call_output items
previous OpenAI response ID
  -> previous_response_id
```

Provider stream mapping:

- `response.output_text.delta` -> `assistant_delta`
- completed `function_call` items from `response.output_item.done` -> parsed `tool_call`
- `response.completed` -> `completed`
- response failure, incomplete response, SDK error, invalid arguments, or missing completion -> typed provider error

Tool JSON schemas are sent with `strict: true`. Koda still parses and validates arguments locally; provider guarantees never replace runtime validation.

The SDK client is injected behind a narrow `OpenAIResponsesClient` port for tests. Production composition constructs the official OpenAI client. Tests do not require credentials or network access.

## 7. Provider session invariants

State is keyed by `threadId + turnId` and contains:

- The previous response ID.
- IDs of function results already submitted.
- Whether a request is currently in flight.
- The last completed model step.

Rules:

1. Step 1 must not have a previous response.
2. A later step requires a completed previous response.
3. A tool result is submitted at most once.
4. Concurrent streams for the same turn are rejected.
5. State advances only after `response.completed`.
6. Abort or failure leaves the session unusable for continuation and produces an explicit error.

These rules prevent duplicated function side effects and accidental use of the wrong response chain.

## 8. Read-only workspace boundary

`ReadOnlyWorkspace` owns a canonical real path for the workspace root.

Every requested path is processed as follows:

1. Reject absolute paths.
2. Resolve against the workspace root.
3. Reject lexical traversal outside the root.
4. Resolve existing targets through `realpath`.
5. Reject symlink targets outside the root.
6. Apply file-size, line-count, result-count, and output-byte limits.

Tool behavior:

### `list_files`

- Workspace-relative directory (`.` means the root).
- Recursive with bounded depth and result count.
- Skips `.git`, `node_modules`, and `.koda` by default.
- Returns workspace-relative POSIX-style paths and truncation metadata.

### `read_file`

- Requires a relative file path.
- Requires a bounded one-based line offset and line limit.
- Rejects directories and oversized files.
- Returns numbered text lines, total line count, and truncation metadata.

### `search_text`

- Requires a non-empty text pattern and relative path.
- Uses ripgrep fixed-string search by default to avoid treating model input as a regular expression.
- Executes with structured arguments, a bounded timeout, result cap, output cap, and caller cancellation.
- Returns matches and truncation metadata.

Repository content is untrusted input to the model. Instructions tell the model to treat it as data, but workspace access remains enforced by runtime code.

## 9. Configuration

Precedence:

```text
CLI option
  > KODA_* environment variable
  > built-in default
```

Phase 1A configuration:

- `OPENAI_API_KEY`: required secret, never logged or persisted.
- `--model` / `KODA_MODEL`: default `gpt-5.6-terra`.
- `--cwd`: default current process directory.
- `KODA_HOME`: default `~/.koda`.

API keys are passed only to the official SDK constructor. Diagnostic errors may state that a key is missing but must never include its value.

## 10. Error handling and exit codes

CLI exit codes:

- `0`: turn completed.
- `1`: provider, tool, persistence, or agent failure.
- `2`: invalid command line or configuration.
- `130`: cancelled by SIGINT.

SIGINT aborts the turn through one `AbortController`. A second SIGINT may use Node's default termination behavior. The CLI removes signal handlers during cleanup so programmatic tests do not leak listeners.

Missing `rg` becomes a recoverable tool error that the model can explain. Missing API credentials fail before a thread starts. Authentication and rate-limit messages are concise and preserve the original error as a cause for diagnostics without printing request headers.

## 11. Testing

All automated tests remain offline.

Provider tests use synthetic official-SDK-shaped stream events and verify:

1. First request mapping and strict tool definitions.
2. Text delta mapping.
3. Function-call argument parsing.
4. `previous_response_id` and `function_call_output` follow-up mapping.
5. Duplicate result suppression.
6. Abort forwarding.
7. Failed, incomplete, and malformed streams.

Workspace tests verify:

1. File listing and deterministic ordering.
2. Line-limited reads.
3. Fixed-string ripgrep search.
4. `..` traversal rejection.
5. Symlink escape rejection where supported.
6. Output and result truncation.

CLI tests verify configuration precedence, streamed stdout, diagnostic stderr, signal cancellation through injected dependencies, and exit-code mapping.

## 12. Acceptance criteria

- `pnpm format:check`, `pnpm typecheck`, and `pnpm test` pass without an API key.
- `@koda/agent-core` has no OpenAI SDK imports.
- OpenAI SDK stream objects do not escape `@koda/providers`.
- Every function call is locally JSON-parsed and schema-validated.
- Follow-up requests use `previous_response_id` and only new function outputs.
- `assistant.delta` events are both persisted and streamable to the CLI.
- Read-only tools cannot resolve a path outside the workspace through `..` or symlinks.
- `koda run --help` succeeds without credentials.
- A missing API key fails before the model loop and does not create a misleading completed thread.
- The implementation includes a documented manual smoke-test command, but no live API call is required in CI.

## 13. Deferred-work disposition

These items remained out of Phase 1A so the first real integration kept a small, auditable side-effect surface. Their destinations are now explicit:

| Item                                                  | Disposition                                        |
| ----------------------------------------------------- | -------------------------------------------------- |
| Anthropic provider                                    | Phase 3; moved from the original Phase 1 roadmap.  |
| Interactive Ink TUI and chat REPL                     | Phase 3; moved from the original Phase 1 roadmap.  |
| File writes and apply-patch                           | Completed in Phase 1B.                             |
| Structured foreground execution                       | Completed in Phase 1C.                             |
| Shell strings and strong process isolation            | Phase 4.                                           |
| Interactive PTY                                       | Phase 3.                                           |
| Policy and approval UI                                | Completed in Phase 1B and generalized in Phase 1C. |
| Resume and persisted provider response IDs            | Phase 2.                                           |
| Root repository instruction discovery                 | Phase 1D.                                          |
| Nested instruction scoping and context compaction     | Phase 2.                                           |
| Provider token usage display                          | Phase 1D.                                          |
| Materialized thread totals and optional cost metadata | Phase 2.                                           |
