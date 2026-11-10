# Semantic context summaries

Turn execution supplies ContextEngine with a fresh, tool-free provider for each
required compaction. Short conversations incur no extra request. Summary sessions
are isolated from the main provider's response chain and use the selected model,
a maximum of 2,048 output tokens and a 20-second deadline.

The existing deterministic compactor first chooses a valid retained suffix and
constructs a fallback. The auxiliary prompt contains its evidence plus bounded
recent omitted excerpts (truncation is explicit), capped at 24 KB and reduced for
small context windows. The model receives instructions to treat this as data and
return structured JSON. It cannot invoke tools or grant permissions.

Generated summaries must match the protocol structure, with at most six entries
per array and 300 characters per entry. The latest user objective, retained item
IDs and deterministic critical facts remain authoritative. The resulting context
is re-estimated with the current calibration factor and only accepted within
budget. Invalid, oversized, unavailable or timed-out summaries fall back to the
original deterministic result. Parent cancellation propagates to turn cancellation.
Very small budgets use deterministic compaction without an auxiliary request.

The accepted compaction item is persisted before context.prepared. Replaying its
retained IDs reconstructs the exact context digest without another model call.
Summary calls count in turn modelRequests; reported tokens emit model.usage with
optional purpose=context_summary and contribute to total token usage. Context
inspection excludes these auxiliary usage events when matching the main request.
Failed requests may have unreported usage, as with normal provider calls.

Tests cover objective/constraint preservation, replay, no-op short contexts,
malformed results, deadlines, cancellation and aggregate usage. Live model summary
quality has not been evaluated in this environment, which has no provider credentials.
