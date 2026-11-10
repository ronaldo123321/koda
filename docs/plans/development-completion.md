# Development completion record

The agreed continuation work is implemented:

- Context compaction retains historical user requirements and supports bounded
  semantic summaries with deterministic fallback, cancellation, replay and usage
  accounting. See [summary behavior](semantic-context-summaries.md).
- Provider request/first-event retries are bounded. Opt-in OpenAI background streams
  resume the same response by sequence, deduplicate output and cancel abandoned
  work. See [retry and recovery boundaries](provider-retry-boundaries.md).
- Up to four eligible read-only tools run concurrently. Prepared tools, namespace
  tools, custom policies and active plans retain serial execution. Recorder writes
  remain ordered; context/recovery normalize interleaved tool histories.
- Initialization negotiates required capabilities while preserving the exact
  protocol-version contract. The macOS version constant matches the server.
  See [capability compatibility](app-server-capability-compatibility.md).
- History, queries, child-task registration and turn execution have separate
  internal services. See [service ownership](application-service-boundaries.md).

## Validation

On Linux with Node 24.22.1 and pnpm 10.28.2:

- Full workspace build and `pnpm typecheck` (including test type checks) pass.
- Pre-merge full Vitest run: 934 passed, 27 skipped (platform dependent), across
  94 test files. Includes the final summary edge cases, required Linux Bubblewrap
  acceptance, and three live v1-to-v8 executor compatibility tests.
- Rust workspace tests: 90 passed.
- Rust and Prettier formatting checks pass.

The full suite needs local TCP/Unix sockets and process execution. It was run
outside the restricted command sandbox through the child-reaping wrapper, with
`umask 022`, `--maxWorkers=2` and `--testTimeout=15000`, plus
`KODA_REQUIRE_LINUX_BUBBLEWRAP=1` and `KODA_LEGACY_EXECUTOR_BINARY` pointing to the
pinned executor built by `scripts/build-phase-4c1-v1-executor.sh`. Under the inherited 0077
umask, three existing mutation-journal fixtures disagree with their hard-coded
0644 expectations; a four-worker run also exceeded the default five-second deadline
in two process-fault tests. Standard permissions and reduced concurrency pass.

## Follow-up model evaluation

The OpenAI default is now `gpt-6.1-terra`; explicit model selections still win.
OpenAI credentials were subsequently configured and real API evaluation was run.
Summary quality, tool roundtrip, injected-429 retry, same-response resume and early
remote cancellation now have live evidence. The evaluation CLI is offline by
default and requires an explicit provider and model for paid runs.

See [model evaluation results](../evaluations/model-quality.md) for observations,
conservative rubric corrections, cancellation lifecycle boundaries and current
validation counts. Original failed reports are retained separately from rescoring.
Anthropic live validation remains unavailable without its credential. Native
macOS/Windows acceptance remains platform-dependent; Linux tests do not establish
those platforms' behavior.

## Cross-process response recovery

Opt-in OpenAI resumable streams now journal response metadata and raw events to a
private bounded file before delivering output. On resume, the application retrieves
the same response after its durable cursor, reconstructs cached output, and
reconciles it with the original turn's text and tool audit. It does not execute
recovered tool intents or repeat completed tools. Unknown execution outcomes remain
explicit and require reassessment under the current turn's policy.

See [the recovery contract](cross-process-stream-recovery.md) for limits and crash
coverage. This is independent of semantic-summary evaluation and leaves other
provider protocols unchanged.
