# Provider retry boundaries

The built-in OpenAI Responses, Anthropic Messages and OpenAI-compatible Chat
providers, in their default mode, use one retry budget for request acquisition and reading the first raw
stream event: at most three total attempts, with at most 30 seconds of cumulative
backoff. This is a wait budget, not an end-to-end request deadline. SDK-level
retries are disabled by the built-in factories; injected clients must do likewise.

Retryable failures include HTTP 408/429/5xx, SDK connection failures and explicitly
recognized Node transport reset/timeout errors. Authentication, malformed event
JSON and unknown failures are not retried. Retry-After seconds and HTTP dates are
respected; advice exceeding the remaining budget fails instead of retrying early.

Before retrying a failed first read, close that stream's iterator. Cleanup failure
is terminal. Cancellation prevents another attempt and closes an acquired iterator.
An empty normally completed stream is not retried; provider protocol validation
reports a missing completion as before.

The first raw event is the replay boundary, including metadata such as response
creation. After that boundary, consumption failures propagate without reopening
the request. Consumer termination closes the iterator. This avoids replaying local
tool calls or already-delivered text; it does not guarantee that a provider did
not perform inference or charge for an earlier failed attempt.

## OpenAI background stream recovery

Set `KODA_OPENAI_RESUMABLE_STREAMS=1` to enable background Responses requests in
Koda. The provider API also accepts `resumableStreams: true`. This is opt-in because
background execution has provider/model availability and storage requirements;
the selected OpenAI endpoint must support `background`, `retrieve` and `cancel`.
Anthropic and Chat-compatible providers keep the default first-event boundary.

In this mode the initial POST is attempted **once**. A failed POST or first read
without a response ID has an ambiguous remote outcome and is not repeated. After
`response.created` identifies a background response, a transient failure or
unexpected EOF resumes with GET `responses.retrieve(id, {stream: true,
starting_after: lastSequence})`. No second inference is started. Acquisition and
consumption of GET streams share at most two resume attempts and a 30-second
cumulative backoff budget, including Retry-After.

Sequence numbers must be contiguous; duplicate sequences must match the already
seen event digest. Conflicts, missing sequences, gaps, response-ID changes and
protocol errors fail closed. Text deltas and completed tool-call events are yielded
only once. AgentLoop still waits for model completion before executing tools.
The deduplication ledger is bounded to 100,000 events. The application also
provides a durable response journal when this mode is enabled; see the
[cross-process recovery contract](cross-process-stream-recovery.md). Standalone
provider callers without a journal retain in-process-only recovery.

Each disconnected iterator closes before GET. User cancellation, early consumer
exit and recovery exhaustion attempt to cancel an identified nonterminal background
response, with a separate five-second SDK abort deadline. If creation never yielded
an ID, or remote cancellation fails, the remote job's termination cannot be confirmed.
After process restart, the application reconciles an identified pending response
with the durable thread audit before starting a new turn.

Scripted streams cover protocol failures and retry budgets. Live OpenAI tool
roundtrips, injected-429 retry, same-response retrieval and queued/in-progress
cancellation have also been exercised; see [evaluation evidence](../evaluations/model-quality.md).
Those live probes do not establish cross-process crash recovery: that path has
separate real-process SIGKILL tests with a controlled provider.
