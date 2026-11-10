# Cross-process OpenAI response recovery

Enable `KODA_OPENAI_RESUMABLE_STREAMS=1` and resume the original thread with
`node apps/cli/dist/main.js run "Continue" --resume <thread-id>` using the original model and instruction configuration.
The normal resumed user input is processed after reconciliation. Default streaming,
Anthropic and Chat-compatible providers do not use this journal.

## Persistence and ownership

The application holds the existing exclusive thread lease throughout recovery and
turn execution. A private `threads/<thread-id>.jsonl.response` journal records a
versioned thread/turn/step header and a SHA-256 binding of model, instructions,
reasoning effort and output budget. It contains no API key and no separate copy of
the input prompt, but raw provider events can contain generated text and tool
arguments; protect it like the thread log.

The header is atomically replaced and fsynced before POST. Every accepted raw event
is appended and fsynced before it is delivered to the agent loop. Records have
checksums; sequences, replay digests and response identity are revalidated during
reconstruction. Journals are limited to 16 MiB and 100,000 events, with mode 0600.
Leaf symlinks and multiply linked files are rejected. A torn last append is
truncated to its last complete newline; complete malformed records fail closed.
Checksums detect accidental corruption, not a malicious local user who can rewrite
both data and checksums. Parent directories retain the same trust boundary as Koda
home and thread storage.

A next model step can replace its own completed predecessor only after the live
provider session and agent loop have advanced. Normal terminal turns sync their
event log before removing the journal. A crash between terminal recording and
cleanup leaves a harmless stale journal: a durable turn terminal prevents reopening
that response. Context-summary requests are isolated and are not journaled by this
path. Per-event fsync adds local I/O latency; no throughput improvement is claimed.

## Recovery order

1. Validate the existing thread log, workspace, provider and matching prepared model
   step under the thread lease. A changed model/instruction/output configuration is
   rejected before network access.
2. Replay the cached provider prefix locally to reconstruct text and function-call
   assembly. If it already has a terminal event, no remote request is needed.
   Otherwise GET the same response with `starting_after` set to the durable cursor.
   No POST is permitted on this path. Matching overlapping events are suppressed;
   conflicting duplicates, gaps and changed response IDs fail closed.
3. Buffer at most the normal 262,144-byte model-output budget, require a valid final
   completion, and compare the reconstructed text with already-recorded deltas.
   Append only its missing suffix and missing final assistant message. Validate and
   retain existing usage, tool IDs, arguments and results. Reconciliation can itself
   be interrupted and repeated without duplicate text, items or tool results.
4. Preserve completed tool results. Newly recovered intents receive
   `TOOL_NOT_EXECUTED`; started calls without a durable result receive
   `TOOL_OUTCOME_UNKNOWN`. These placeholders do not prove success or suppress
   uncertainty and plan revalidation. Recovery executes no tools and reuses no
   approvals. Existing workspace/process recovery remains responsible for effects
   that crossed an execution boundary.
5. Close the original interrupted turn with `TURN_STREAM_RECOVERED`, validate and
   sync its reconciled event log, then remove the journal. Start the user's new turn
   with that history and the current tools, instructions and approval policy.

Recovery writes into the original turn's durable history, which clients can reload;
it does not replay the original prefix into the new turn's live event stream. The
next turn may intentionally decide to request a tool again after inspecting the
recorded outcome; this is a new model decision and goes through normal policy.

## Explicit limits

- If the process died after POST but before recording a response ID, remote outcome
  is ambiguous. Recovery reports an error and never repeats POST automatically.
- A provider-expired/deleted response, missing journal identity, corrupt checkpoint,
  incompatible configuration or mismatched audit blocks recovery. It does not
  silently start a replacement inference. Restore the original configuration or
  inspect the retained evidence; start a new thread only when deliberately abandoning
  the old request. An unidentifiable remote job cannot be confirmed cancelled.
- A journal whose step differs from the latest prepared step is rejected rather
  than guessed, including a crash in the narrow transition before the next
  journal header is installed.
- User cancellation, malformed output and exhausted retrieval retries still attempt
  bounded remote cancellation with a separate signal. Cancellation does not assert
  remote compute termination when the API cannot acknowledge it.
- The event journal supports recovery of the interrupted response and reconciliation
  into a new turn, not restoration of arbitrary JavaScript process state or automatic
  replay of side effects. It cannot recover a provider's unsaved response ID or
  guarantee behavior after the provider's retention period expires.
- Tests simulate provider responses while killing a real application process. The
  existing live retrieval/cancellation probes are supporting API evidence, not a
  claim that a real paid response was tested across process death. POSIX durability
  and SIGKILL behavior are exercised locally on Linux and are included in the macOS
  CI acceptance job; Windows has no SIGKILL acceptance.

## Regression coverage

`durable-stream-recovery.test.ts` covers cursor retrieval without repeated POST,
cached completion without a network request, overlapping replay, conflicts/gaps,
expired responses, unknown creation outcome, changed model binding, cancellation,
private file permissions, link rejection, journal-size bounds and torn-tail repair.
Audit tests preserve existing tool results and unknown execution outcomes and
interrupt recovery after each durable append, including the final terminal.

The subprocess fixture kills the first KodaApplication process with SIGKILL after
an assistant delta was persisted. A fresh process takes over its stale thread lease,
retrieves the original response at the saved cursor and continues the user turn.
Assertions check that only the new user turn creates a response, that retrieval
happens exactly once, and that final history and durable text have no duplicates.

Local validation on 2026-11-10: 986 Vitest tests passed, 27 platform-dependent
checks skipped, across 96 files. The targeted journal/recovery/provider suites
passed 69 tests, including 25 new durable-recovery cases. Workspace compilation,
test type checking, Prettier and whitespace checks passed. No paid API calls were
made for this cross-process acceptance.
