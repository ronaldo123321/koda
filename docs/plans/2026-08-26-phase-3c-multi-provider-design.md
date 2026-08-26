# Koda Phase 3C: Explicit Multi-Provider Runtime

- Status: Implemented and verified (2026-08-26)
- Date: 2026-08-26
- Depends on: Phase 3A transport-neutral application boundary and Phase 3B external tool lifecycle
- Scope: explicit provider selection, five named provider profiles, provider-specific conversation projection, durable reasoning continuity, normalized usage and errors, and app-server protocol v2

## 1. Outcome

Phase 3C lets one Koda runtime use OpenAI, Anthropic, DeepSeek, Kimi, or GLM without moving vendor-specific request formats into `agent-core` or weakening JSONL durability, tool approval, recovery, cancellation, compaction, and output-budget guarantees.

The user selects a provider explicitly. Koda resolves a named, built-in provider profile, validates only that provider's configuration, constructs the appropriate adapter, and records the selected provider in the durable turn context. Provider-neutral conversation items remain the authoritative history. Each adapter projects those items into its vendor protocol and persists only the small amount of opaque continuation state that the vendor requires for a later tool round.

This phase does not implement arbitrary endpoints, automatic provider routing, fallback, cross-provider resume, or a generic OpenAI-compatible escape hatch. Those features require separate trust, compatibility, and recovery designs.

## 2. Alternatives and decision

Three approaches were considered:

1. **Named provider registry with dedicated protocol families — selected.** OpenAI uses its Responses adapter, Anthropic uses a Messages adapter, and DeepSeek, Kimi, and GLM use one OpenAI-compatible Chat Completions adapter parameterized by reviewed profiles. This shares mechanics without pretending the providers have identical semantics.
2. **One generic OpenAI-compatible adapter for every provider — rejected.** Anthropic is not an OpenAI-compatible API, OpenAI Responses has different continuation semantics, and provider-specific reasoning fields, usage shapes, stop reasons, and tool-call rules would become scattered conditionals.
3. **Allow arbitrary base URLs and model identifiers immediately — deferred.** This would turn a finite compatibility contract into an unbounded one and could let ambient environment variables silently redirect credentials.

The selected design keeps the core provider interface narrow while making compatibility rules explicit, testable, and owned by the adapter that understands them.

## 3. Provider registry and built-in profiles

The protocol defines the closed Phase 3C provider identifier set:

```text
openai | anthropic | deepseek | kimi | glm
```

`@koda/providers` exports a registry that resolves each identifier to its configuration metadata and adapter factory. Application and transport layers depend on this registry rather than branching on provider strings.

| Provider  | Credential          | Default model     | Endpoint strategy                             |
| --------- | ------------------- | ----------------- | --------------------------------------------- |
| OpenAI    | `OPENAI_API_KEY`    | `gpt-5.6-terra`   | official SDK default                          |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-5` | official SDK default                          |
| DeepSeek  | `DEEPSEEK_API_KEY`  | `deepseek-v4-pro` | fixed `https://api.deepseek.com`              |
| Kimi      | `MOONSHOT_API_KEY`  | `kimi-k2.6`       | fixed `https://api.moonshot.cn/v1`            |
| GLM       | `ZAI_API_KEY`       | `glm-5.2`         | fixed `https://open.bigmodel.cn/api/paas/v4/` |

Every profile owns its credential name, default model, endpoint, capability flags, usage mapping, stop-reason mapping, error mapping, and protocol quirks. Only the selected provider's credential is required. Phase 3C does not read `OPENAI_BASE_URL` or an equivalent ambient override for the domestic profiles.

Configuration precedence is transport argument, then environment, then the built-in default:

```text
--provider / turn.start.provider > KODA_PROVIDER > openai
--model / turn.start.model       > KODA_MODEL    > selected provider default
```

`KODA_MODEL` is interpreted only inside the selected provider. A new thread defaults to OpenAI for backward compatibility. A resumed thread must use its durable provider; changing model within that provider is permitted, while changing provider fails before a model request is made.

## 4. Adapter architecture

The provider boundary continues to expose provider-neutral model events to `AgentLoop`:

```text
KodaApplication
  -> ProviderRegistry
      -> OpenAI Responses adapter
      -> Anthropic Messages adapter
      -> OpenAI-compatible Chat adapter
           -> DeepSeek profile
           -> Kimi profile
           -> GLM profile
```

OpenAI keeps the existing Responses API adapter and `previous_response_id` continuation optimization. Anthropic uses the official TypeScript SDK and projects Koda tools into Messages API tool definitions and `tool_use`/`tool_result` blocks. DeepSeek, Kimi, and GLM share streaming Chat Completions mechanics but retain separate profiles and conformance fixtures.

Adapters emit normalized text deltas, completed tool calls, usage, finish state, and optional provider continuation state. `AgentLoop` never parses vendor wire responses. Cancellation always flows through the turn abort signal. No adapter may execute tools, decide approval, read workspace files, or append directly to JSONL.

## 5. Conversation projection

JSONL conversation items remain the source of truth; Koda does not persist complete vendor responses or HTTP traffic.

OpenAI projects provider-neutral history into Responses input as it does today and uses a valid stored response identifier when available. Anthropic projects assistant text and tool calls into one assistant message containing text and `tool_use` blocks, followed by user messages containing the corresponding `tool_result` blocks. The OpenAI-compatible adapter coalesces Koda's durable interleaved sequence:

```text
tool_call A -> tool_result A -> tool_call B -> tool_result B
```

into one assistant Chat Completions message containing both `tool_calls`, followed by ordered tool-role result messages. This coalescing is a projection only; it does not change durable execution order.

Approval records are never model messages. Recovery and compaction summaries become bounded system context. Provider continuation records are invisible to generic prompt construction and can be consumed only by their owning adapter. Malformed history, unmatched calls, or provider-incompatible continuation data fail closed instead of being guessed or silently dropped.

## 6. Durable provider continuation state

Some providers require exact reasoning material to be returned during a multi-step tool turn. Disabling thinking would reduce model capability, while storing full raw responses would retain unnecessary data. Phase 3C therefore adds a bounded `provider_state` conversation item containing only the exact continuity fields required by the owning protocol.

The durable envelope is provider-tagged and schema-validated:

```json
{
  "type": "provider_state",
  "id": "item_...",
  "provider": "anthropic",
  "data": {}
}
```

Anthropic state may contain the complete `thinking` and `redacted_thinking` blocks, including signatures, that must accompany later tool use. DeepSeek, Kimi, and GLM state may contain `reasoning_content` and a small provider-profile allowlist of continuity fields. OpenAI continues to use its existing response identifier record rather than duplicating raw reasoning content.

The state item is appended before the tool calls produced by that model step:

```text
assistant_message? -> provider_state -> tool_call -> tool_result
```

One state record and all calls/results from the same model step are an atomic context unit for compaction. The unit is retained or summarized as a whole. A missing, corrupt, oversized, or foreign-provider state fails before another model request. Each serialized state is limited to 256 KiB, counts toward the provider output budget, and is rejected before tools execute if the limit would be crossed. Signatures and reasoning fields are never truncated.

Provider state is not user-visible assistant content, is never copied into approval previews, and cannot contain arbitrary response bodies, headers, API keys, or request metadata.

## 7. Usage, finish reasons, and errors

Adapters normalize provider usage into the existing Koda dimensions: input, cached input, cache write, output, reasoning output, and total tokens. Unsupported dimensions are zero only when the provider reports enough information to establish zero; absent usage remains unmeasured rather than fabricated. Provider-specific totals are validated against normalized components where possible.

Vendor stop reasons are mapped into the model boundary's completed state. A tool-use finish is valid only when well-formed tool calls were emitted. Truncated or structurally invalid streamed arguments produce a protocol or output error and never reach tool execution.

Provider failures use stable public codes:

- `PROVIDER_AUTHENTICATION_FAILED`
- `PROVIDER_RATE_LIMITED`
- `PROVIDER_REQUEST_FAILED`
- `PROVIDER_PROTOCOL_ERROR`
- `PROVIDER_OUTPUT_INVALID`

Messages are bounded and credential-safe. SDK response objects, request headers, raw bodies, and environment values are not persisted. Cancellation remains cancellation rather than being remapped to a provider request failure.

## 8. CLI and app-server protocol v2

The CLI adds `--provider <id>` while preserving `--model`. Help and validation display the five built-in identifiers and report a configuration error before opening a thread when the selection is invalid.

The strict app-server schema moves from protocol version 1 to version 2. `turn/start` gains `provider`; initialization returns the supported provider metadata needed by clients to present a selector. Because Koda is pre-release and the schema is intentionally strict, Phase 3C does not maintain parallel v1 and v2 servers. Version mismatch continues to fail during initialization rather than after a turn starts.

Transport clients pass selection into the shared application service. They do not construct provider SDK clients or read provider credentials. Provider identity is included in the turn context snapshot and durable recovery checks.

## 9. Testing and acceptance criteria

Tests use injected fake clients and deterministic stream fixtures; CI never calls live provider APIs or requires real credentials.

Every provider must pass a shared adapter contract covering streaming text, fragmented multi-tool arguments, ordered tool result replay, usage normalization, stop reasons, cancellation, authentication failure, rate limiting, request errors, malformed streams, and invalid output. Anthropic and the three compatible profiles additionally test reasoning/state preservation across tool rounds.

Provider-state tests cover strict schema validation, the 256 KiB limit, accounting against output budgets, append-before-execute ordering, atomic compaction, recovery, missing state, corruption, and provider mismatch. Registry and application tests cover selection precedence, provider-specific credentials, default models, new-thread defaults, same-provider model changes, cross-provider resume rejection, and unchanged OpenAI behavior.

CLI and app-server tests cover `--provider`, environment selection, app-server v2 initialization metadata, `turn/start.provider`, strict unknown-provider rejection, and credential-free thread queries. End-to-end application tests exercise every provider through the shared model/tool/model loop with fake transports.

Phase 3C is complete when all five named providers can safely participate in the durable Koda turn lifecycle, exact reasoning continuity survives tools, recovery, and compaction, invalid state fails before effects, and the full format, typecheck, unit, integration, and offline scenario gates pass.

## 10. Deferred destinations

- Arbitrary base URLs, user-defined provider profiles, and custom certificate/proxy policy: a later Phase 3 provider-configuration slice, followed by Phase 4 hardening where network trust requires it.
- Qwen, Doubao, MiniMax, and other providers: later Phase 3 registry extensions after a profile has official protocol documentation and conformance fixtures.
- Model discovery, capability negotiation, automatic routing, fallback, retries, and provider health scoring: a later Phase 3 routing design; effectful tool recovery must remain conservative.
- Cross-provider thread resume or history migration: a later Phase 3 migration design with explicit handling for opaque provider state.
- Exact provider tokenizers, live pricing, budget forecasting, and billing reports: a later Phase 3 accounting slice.
- Provider-assisted semantic compaction: a later measured experiment against the deterministic Phase 2 compactor; it is not part of Phase 3C correctness.

## 11. Primary protocol references

- OpenAI provider behavior remains based on the official OpenAI SDK and Responses API used by the existing adapter.
- Anthropic SDK and Messages/tool-use semantics: <https://github.com/anthropics/anthropic-sdk-typescript> and <https://platform.claude.com/docs/en/claude_api_primer>
- Anthropic thinking continuity: <https://platform.claude.com/docs/en/about-claude/models/extended-thinking-models>
- DeepSeek API, thinking, and tool calls: <https://api-docs.deepseek.com/>, <https://api-docs.deepseek.com/guides/thinking_mode/>, and <https://api-docs.deepseek.com/guides/tool_calls/>
- Kimi API and K2.6 guide: <https://platform.kimi.com/docs/api/overview>, <https://platform.kimi.com/docs/api/chat>, and <https://platform.kimi.com/docs/guide/kimi-k2-6-quickstart>
- GLM OpenAI compatibility, thinking, and function calling: <https://docs.bigmodel.cn/cn/guide/develop/openai/introduction>, <https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode>, and <https://docs.bigmodel.cn/cn/guide/capabilities/function-calling>
