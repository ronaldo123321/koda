# Model validation and summary quality

Run `pnpm eval:models` for an offline deterministic baseline. This never makes a
model request, even when credentials are configured. JSON reports default to
`evaluation-results/`, which is gitignored. Output files are private and existing
reports are never overwritten. The output path is reserved before any paid
request, so a reused or unwritable destination cannot discard a newly billed run.
Build dependencies are compiled by the command.

For live evaluation, explicitly select both provider and model:

```sh
pnpm eval:models --live --provider openai --model "$OPENAI_MODEL" --suite all
pnpm eval:models --live --provider anthropic --model "$ANTHROPIC_MODEL" --suite all
```

Configure `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` through environment settings; do
not place credentials in arguments or reports. In the managed cloud environment,
Node 24 can use its inherited proxy with `NODE_USE_ENV_PROXY=1`. The command may
need network-capable execution outside the restricted command sandbox.

Use `--suite summaries` (default), `--suite transport`, or `--suite all`.
A focused retry avoids repeating successful model calls:

```sh
pnpm eval:models --live --provider openai --model "$OPENAI_MODEL" \
  --suite transport --probe cancel --output evaluation-results/cancel.json
```

`--probe` accepts `cancel`, `cancel-created`, `cancel-progress`, `retry`, or `resume`, only with the
transport suite.
`--timeout-ms` accepts 1,000–120,000 ms, default 90,000 ms. Production semantic
compaction retains its own 20-second deadline. Each model request reserves at
most 2,048 output tokens; the full suite has six summary requests, at most three
tool-loop steps, and five stream probes (at most fourteen logical requests).
Provider transport retries may add HTTP attempts; interrupted requests can incur
unreported usage. No automatic repeated benchmark trials are performed.

## What is measured

Six synthetic conversations cover pending validation, task replacement, failed
attempts, mid-task constraints, untrusted output and a second compaction of an
existing summary. A large final diagnostic item forces all evidence into the
omitted prefix. Tests verify the actual summary prompt contains the required
facts. The latest user request, input budget and exact context replay are checked
independently of quality scoring.

The rubric checks named facts in specific summary fields and rejects unsupported
completion claims. It is a lexical regression rubric, not a general semantic judge.
A fact in the wrong field may fail despite surviving elsewhere in the summary.
Reference summaries validate the evaluator only; they are never substituted for
model output during live runs. Reports retain deterministic, raw candidate and
accepted summaries separately, plus request/usage counts, latency and whether the
final summary equals the deterministic baseline. Missing candidates cannot count
as successful live semantic summaries.

Transport probes use actual SDKs and real inference in live mode:

- Tool roundtrip: AgentLoop must read a random in-memory marker exactly once and
  return it. No workspace mutation or process tool is available.
- Cancellation: abort after the first text delta. OpenAI uses background mode and
  also requires its cancellation request to return terminal status `cancelled`.
  If acknowledgement fails, a bounded, read-only lookup records the same response
  status. Even an already-completed response does not count as acknowledged
  cancellation. This verifies local cancellation and API acknowledgement, not
  remote compute termination timing. Anthropic verifies local cancellation only.
- Early cancellation (`cancel-created`): OpenAI background mode only. Abort after
  `response.created` reports `queued` or `in_progress`, before any text delta.
  Require the cancellation response to explicitly report `cancelled`; HTTP 200
  alone is insufficient. This validates cancellation before text delivery, not
  whether remote token generation had already begun.
- In-progress cancellation (`cancel-progress`): wait for `response.in_progress`
  with status `in_progress`, then abort before text delivery and require terminal
  `cancelled`. A queued creation event alone cannot trigger this probe. This proves
  the API lifecycle transition, not internal token-generation timing.
- Retry: a client-side wrapper injects exactly one HTTP 429, then allows a real
  request through. This tests retry behavior, not naturally observed rate limits.
- Resume: OpenAI background mode only. The wrapper cuts the initial HTTP body after
  a complete text delta, including split UTF-8/SSE frame handling. The probe checks
  exact final text, one creation and a subsequent retrieval. Other providers report
  unsupported; an unsupported-only run is not marked passed.

The fetch wrapper exists only inside the sequential evaluation process and is
always restored. It does not modify production provider transport behavior.

Exit status is 0 for a recorded baseline or passing live run, 1 for evaluation or
invariant failure, and 2 for missing credentials or an unexecuted probe. Offline
quality failures are reported as baseline findings; they do not masquerade as live
success or fail the command simply because the deterministic baseline is imperfect.
Token usage is provider-reported. Dollar cost is `null`; no pricing is invented,
and missing usage is not treated as free usage.

## Initial observation — 2026-11-10

OpenAI model availability was verified before using the project's default
`gpt-5.6-terra`. Anthropic was not configured.

| Fixture             | Deterministic structured rubric                  | Live accepted summary        |
| ------------------- | ------------------------------------------------ | ---------------------------- |
| Pending validation  | Missing modified-file field                      | Pass                         |
| Task replacement    | Pass                                             | Pass                         |
| Failed attempt      | Missing structured failure cause and next action | Pass                         |
| Mid-task constraint | Pass                                             | Pass after rubric correction |
| Untrusted output    | Pass                                             | Pass                         |
| Repeated compaction | Pass                                             | Pass                         |

All six contexts fit budget, preserved the latest objective and reconstructed the
same digest from durable compaction data. The semantic summaries used 4,592 input
and 908 output tokens (5,500 reported tokens), taking 2.225–7.661 seconds per case.
This is one small synthetic run, not a production success-rate estimate.

The original migration rubric required the phrase “no database migrations” and
incorrectly rejected “Do not add database migrations” / “prohibits database
migrations.” Those outputs were manually checked, the rubric gained equivalent
prohibition forms and an affirmative-permission negative test, and the same saved
outputs were rescored without any additional inference. Original and rescored
reports remain separate; the original run is not rewritten as having passed.

Tool roundtrip, injected-429 retry and same-response resume passed the first live
run. The original cancellation prompt requested 800 words but failed before its
first text delta; a focused repeat reported `PROVIDER_OUTPUT_INVALID`. Neither
attempt reached the cancellation trigger, so neither counts as cancellation
validation. The probe now requests a short answer within its output budget.

Two short-answer probes reached the first text delta and cancelled locally. The
last probe recorded HTTP 400 from the cancel endpoint; a read-only lookup of that
same response returned `completed`. There was no still-running response in that
lookup, but cancellation of an actively generating remote response remains
unverified. The strict cancellation check stays failed; it is not relabeled as a
passing acknowledgement. Future coverage should trigger cancellation earlier in
the response lifecycle rather than require longer generated answers.

This observation used fourteen logical inference requests, including three
focused cancellation repeats. Cancelled/incomplete requests had no reported usage
in the provider stream, so the observed token totals are incomplete. No monetary
cost or universal success rate is inferred.

The evaluator and related compaction/retry/recovery regressions pass 65 offline
tests. Testkit compilation, test type checking and changed-file formatting pass.
Production runtime code was not changed by this evaluation work.

Local report artifacts (gitignored): `baseline.json`, `openai-first-run.json`,
`openai-rescored.json`, `openai-cancel-recheck.json`, `openai-cancel-short.json`,
`openai-cancel-diagnosed.json`, and `anthropic-blocked.json` in `evaluation-results/`.

## Default model update — 2026-11-10

The OpenAI profile now defaults to `gpt-6.1-terra`. Explicit CLI, environment and
saved configuration model selections retain their existing precedence. Historical
observations above still refer to `gpt-5.6-terra`.

A live run with the new default produced six semantic summaries. All context
budget, objective preservation and replay checks passed. The lexical rubric passed
five of six cases. The failed-attempt case was flagged because its completed-work
field said “Reverted the TRY-3 timeout change.” Manual inspection confirms that
rollback happened in the source evidence; the summary also explicitly preserves
the failed test, ECONNRESET and pending investigation. The rubric currently rejects
any TRY-3 mention in completed work, so this is a conservative false positive.
The saved report remains failed and the rubric was not relaxed for this run.
Summary usage was 5,251 reported tokens, with 2.190–2.885 seconds per case.

Tool roundtrip, injected-429 retry and same-response resume passed. Early
cancellation also passed: `response.created` reported `queued` at 677 ms; no text
delta was delivered; one cancel request returned HTTP 200 and status `cancelled`.
This closes the earlier gap for cancellation before text delivery. It does not
establish cancellation during active token generation.

Cancellation after the first text delta again received HTTP 400; a lookup returned
`completed`. That strict probe remains failed. Consequently the full live suite is
reported as failed, despite passing early cancellation and the other transports.
No repeated paid run was used to seek a passing result. The run made twelve logical
inference requests; interrupted requests have incomplete usage and unknown cost.

The full offline suite passed 957 tests, with 27 platform-dependent skips.
Workspace TypeScript builds and test type checking passed. The new early-cancel
regressions reject HTTP-success responses whose body says `completed`, and check
that observing creation metadata does not alter an otherwise successful stream.
The report is `evaluation-results/openai-6-1-terra.json` (gitignored).

## Closing validation — 2026-11-10

The failed-attempt rubric now permits only complete, anchored rollback entries:
“Reverted the TRY-3 timeout change.” or “Rolled back the TRY-3 timeout change.”
It still rejects repair/test success claims in separate entries or appended to the
same rollback entry. Regression tests cover both forms and mixed false claims.
This remains a fixture-specific lexical rubric, not general semantic judgment.
Saved summaries are rescored without additional inference, with originals retained.

Both cancellation modes now require explicit terminal `cancelled`, including the
older after-text probe. HTTP 200 with status `completed` cannot count as success.
The new `cancel-progress` probe adds the server's in-progress lifecycle boundary.

The saved `gpt-6.1-terra` summaries now pass all six rubric cases in
`evaluation-results/openai-6-1-terra-summary-rescored.json`, with zero additional
inference requests. This is summary-only rescoring; the original full-suite report
is not changed to passing and its after-text cancellation race remains recorded.

One focused live `cancel-progress` request passed: the server emitted
`response.in_progress` with status `in_progress` at 4,503 ms, before any text delta;
the cancel endpoint returned HTTP 200 with terminal `cancelled` (total 5,041 ms).
There was one creation, one cancellation and no retrieval or injected fault.
This validates cancellation of an in-progress API response. It cannot measure
internal token generation or guarantee cancellation after buffered text arrives.
Usage for that interrupted request remains unknown. The report is
`evaluation-results/openai-6-1-terra-cancel-progress.json`.

Final local validation: 961 tests passed, 27 platform-dependent tests skipped
across 95 files (91 passed, 4 skipped). Workspace TypeScript compilation, test type
checking, repository Prettier checks and `git diff --check` passed. The evaluation
harness has 27 offline tests, including rollback and cancellation false-positive
regressions. No additional Rust changes were made in this follow-up.
