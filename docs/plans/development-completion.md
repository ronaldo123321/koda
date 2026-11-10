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

No provider credentials are configured here, so live model summary quality and
OpenAI background API compatibility are not claimed. Native macOS/Windows checks
remain platform-dependent. All live-stream recovery tests use scripted streams;
an additional test exercises the actual OpenAI SDK against a mocked HTTP response.
