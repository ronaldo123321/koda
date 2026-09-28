# Koda Phase 4D: Authenticated Remote Operation

- Status: 4D1 and 4D2 in progress — local owner/device grants, workspace
  registration, credential lifecycle, immutable remote Thread bindings, safe
  Thread summary and authorized list projection, opt-in TLS transport, durable event-envelope
  and assistant-update cursor polling, safe all-type activity projection, and
  restricted remote Turn start with durable request
  idempotency and authenticated WSS replay implemented; a native macOS client
  preview now verifies a pinned certificate, stores its device token in Keychain,
  lists authorized Threads, replays assistant updates and event status, and
  previews verified Thread artifacts in bounded UTF-8 ranges. Scoped remote
  write/command approvals and allowlisted stdio/HTTPS MCP scopes are locally tested;
  automatic pairing and physical two-device acceptance remain open. Approval
  ownership and decisions are durably recorded; a crashed call remains
  interrupted and requires a new Turn. Owner-local HTTPS MCP OAuth now has encrypted credentials,
  authorization-code/PKCE loopback login, refresh, local revocation, and key rotation;
  a real TLS OAuth fixture passes, including an explicitly configured
  provider-side revocation endpoint. Live-provider interoperability remains
  unverified.
  Swift client tests now exercise the actual local HTTPS/WSS listener with
  temporary devices, restricted Turn idempotency, and replay, and reject late
  subscription frames after switching Threads. A separately authorized
  `turn:control` endpoint and SwiftUI control can cancel an active remote Turn;
  a two-device HTTPS/WSS test confirms concurrent subscriptions and continued
  delivery to one device after revoking the other. A SwiftUI model test now
  closes and restarts the actual local HTTPS/WSS listener on the same address,
  then confirms automatic cursor replay adds the later assistant update once.
  The remote HTTPS listener also exposes Thread-scoped artifact lists and
  verified UTF-8 byte ranges to devices with `thread:read`; the list omits host
  paths and tool names. A real artifact store and durable Thread reference test
  covers cross-workspace denial, absent references, invalid cursors, and
  changed artifact bytes. Remote retention ownership and physical-device
  acceptance remain open.
  The Swift client integration test reads a real artifact through the pinned
  HTTPS connection in two ranges, checks missing grants and references, and
  verifies the model assembles the same UTF-8 text for display.
- Date: 2026-09-27
- Depends on: local app-server v18, durable JSONL events, thread leases, artifact integrity, and Phase 4A–4C security evidence
- Scope: one owner across multiple devices, authenticated HTTP/WebSocket clients, reconnect/replay, remote MCP/OAuth, shared state ownership, and owner/workspace/thread authorization

## 1. Existing boundary

The current app-server is a single-client local stdio process. Its v18 methods
accept host paths such as `cwd` and `workspace`; `thread/list` can return
`logFile` and index diagnostics. Disconnect cancels active turns and pending
approvals. These are valid local-client semantics, but a network listener must
not expose them unchanged.

Remote operation uses a separate versioned API and server-side workspace IDs.
The local stdio protocol and its installed CLI/TUI behavior remain intact.
The opt-in HTTPS listener serves authenticated workspace IDs, bound Thread
summaries and paginated lists, bounded event envelopes, assistant updates,
safe event activity, and restricted Turn starts. It has TLS,
bounded headers, request bodies, and responses, per-request authorization,
and negative security tests. The event-envelope endpoint uses exclusive
`after` cursors; `-1` starts at sequence zero. It omits raw event payloads, which may contain
host paths or sensitive diagnostics. The `/activity` endpoint and WSS
`view=activity` project every event type with only selected status fields;
tool arguments, approval details, process security evidence, and structured
host paths remain on the owner host. Assistant text can quote workspace content.
Devices additionally granted `thread:events:full` can read the original
payload-bearing events through `/events/full` or WSS `view=full`. That explicit
grant exposes tool inputs, outputs, diagnostics, and paths; both routes recheck
the Thread binding and grant. HTTP responses remain capped at 3 MiB and WSS
frames at 512 KiB. For a larger event, `GET /events/:sequence?afterByte=<offset>`
returns up to 16 KiB of Base64 encoded event JSON with total size, byte offsets,
and a full-event SHA-256 so the client can reconstruct and verify it.
The separate assistant-update endpoint
returns assistant text and limited Turn status only. Assistant text can quote
workspace content, so devices need `thread:read` and must be trusted by the owner.
The default Turn start mode uses read-only tools. It binds a new Thread before
execution, uses a durable request ID to prevent duplicate starts, and does not
cancel on an HTTP client disconnect. A separate per-Turn effect scope can
expose workspace patching or command tools only when the device has matching
workspace, Thread, and approval grants; every actual effect still asks for an
exact approval. The `mcp:invoke` scope loads only server IDs explicitly granted
to the device and tool names in each host server's `remote_tools` allowlist.
Unknown-effect MCP tools ask for approval. Plugin and plan-control tools remain
unavailable to remote Turns. A separate no-body cancellation request checks the Thread binding,
authoritative workspace root, and `turn:control` grant before signaling an active
Turn; it never retries automatically after an uncertain response. WSS subscriptions are read-only, authenticate the device and
Thread before upgrade and during polling, replay by an exclusive durable
cursor, and close on revocation or bounded-buffer pressure without cancelling
the Turn. OAuth and other unreviewed effects stay disabled.

Artifact access uses `GET /v1/threads/:threadId/artifacts` with an optional
`before` sequence and limit of 25, and
`GET /v1/threads/:threadId/artifacts/sha256:<digest>` with optional exclusive
`beforeByte` or `afterByte` and a maximum 16 KiB UTF-8 range. Both check the
device's `thread:read` grant, immutable Thread binding, and authoritative
workspace root before calling the existing Thread-reference and SHA-256
verification path. Listing returns only sequence and content-addressed
artifact metadata; reading returns the verified range and byte cursors.
Integrity failures return a generic server error without artifact bytes.

## 2. Identity and authorization

This release supports one owner across multiple individually named devices.
Every request has an authenticated owner and device ID. One immutable owner
namespace is retained in durable identities so a future multi-user design
cannot accidentally reinterpret existing records. This release does not
provide team membership or cross-owner sharing. The server resolves an opaque
workspace ID to one configured canonical host root after checking the device's
grant. Clients never choose a host path or `KODA_HOME`. Thread IDs are bound
durably to the owner and one workspace; authorization checks both bindings
for every read, resume, approval, cancel, process action, and artifact range.
Listing is filtered before projection.

The permission set is explicit: `workspace:read`, `thread:read`,
`turn:start`, `turn:control`, `approval:resolve`, `process:control`, and
`workspace:mutate`, and `mcp:invoke`. An MCP grant also names exact host server
IDs; host configuration must name exact remote tool names. A grant is bound to one workspace ID and device, and
revision. No method infers write authority from a read grant. Unknown or
ungranted IDs return the same non-disclosing result. Remote projections omit
host paths, secret names not needed by the client, and raw diagnostics.

Each device has a distinct server-issued, revocable, short-lived credential
whose stored representation is a digest. Pairing and revocation require
owner-local authorization; possession of one device token cannot mint another.
The first listener targets an explicitly configured LAN or owner-managed VPN
interface, never a public bind by default. Transport requires TLS; the client
must verify the host certificate, with a pinned fingerprint or a trusted local
CA established during owner-local pairing. A bearer credential alone does not
justify skipping certificate verification. Credential rotation and revocation
take effect before a new request or WebSocket subscription; neither device
credentials nor OAuth secrets enter JSONL, remote API responses, URLs, or
routine logs.
The owner-host `remote serve` command prints the SHA-256 fingerprint of the
certificate actually loaded by the listener. A client must obtain and compare
it over an owner-controlled channel before saving a device token.

## 3. Durable sessions and replay

An HTTP request starts a turn and returns durable thread/turn identities.
The server owns the turn independently of a client socket. A WebSocket
subscription is read-only until separately authorized for control. Events are
sent only after the authoritative JSONL append. On reconnect, the client sends
the last contiguous sequence it processed; the server validates owner/device,
workspace, thread, and cursor, replays `thread/events` from that exclusive
cursor, then switches to live delivery without a gap or duplicate. A bounded
buffer/backpressure failure closes that subscription without cancelling the
turn or losing durable events. The client must reconnect and replay.

Approval ownership is a separate, expiring lease bound to a device, turn,
and exact pending call. Only the current owner may resolve it. Disconnect does
not approve or repeat an effect. Lease expiry leaves the turn paused or
cancels it according to a documented timeout; ownership transfer is explicit,
audited, and cannot reuse an earlier approval. Cancellation and command effects
are never retried merely because a request response was lost.

Current macOS preview implements device/Turn/call-bound pending approvals in
the owner-host process with a five-minute rejection timeout. Per-Turn effect
scope requires matching device grants; the default remains read-only. An
approval is removed before its decision is delivered, so a repeated resolution
cannot execute twice. The ordinary activity projection excludes tool arguments;
the separately authorized approval preview intentionally shows exact details
and may include host paths. The owner-host now persists the assignment and
terminal decision without preview details. The current
device may explicitly transfer one pending call to another active device with
the same workspace, effect scope, and MCP server grants. The host writes a
minimal transfer-request audit record before switching ownership; the old
device then loses preview and resolution rights. Transfer never extends the
five-minute expiry. An audit request may exist without an applied transfer if
the Turn ends during the write. Host shutdown rejects pending approvals;
process loss cannot resume a pending tool call. The owner can inspect its last
assignment with `koda remote approval inspect <thread-id> <turn-id> <call-id>`;
an interrupted Turn reports `start_new_turn`, while the previous call stays
non-actionable. Real child-process `SIGKILL` tests verify initial and
transferred assignments survive, and neither device can approve the old call
after restart. This records and
invalidates ownership safely; it does not replay an uncertain effect.

A real child-process `SIGKILL` test now covers the durable request record after
reservation and after the request is marked started with a Thread binding.
Reopening the stores and retrying the same request returns the original IDs
without starting another Turn. For a reservation interrupted before binding,
the owner-host `remote request inspect` and explicit `remote request abandon`
commands now provide a guarded recovery path. Abandonment requires an unbound
`reserved` record with no Thread log and the same per-request lease used by
startup; it persists
`abandoned` rather than deleting the request ID. A retry returns 409 and the
original IDs without execution, so a client can ask the user to send a new
request. Started or bound requests cannot be abandoned. The remaining crash
points, uncertain effects, and physical-device recovery still need acceptance.

## 4. Storage and process ownership

Local JSONL and SQLite are not a shared multi-node database. The first remote
deployment uses one authoritative owner host. The host's existing thread and
workspace mutation leases coordinate concurrent devices; remote clients do not
open these stores directly. An artifact key includes owner/workspace scope and
content SHA-256. Reads verify size and digest after authorization; retention
derives only from authoritative thread references, with a lease protecting
concurrent collection. Native Supervisor/Worker jobs remain on the owner host.

If a later deployment uses shared storage or multiple hosts, it must add
fenced distributed leases, artifact integrity, retention ownership, and
Worker-host routing before claiming failover. One-host multi-device acceptance
does not prove multi-host operation.

## 5. Remote MCP and OAuth

Remote MCP servers have a configured origin, transport, capability review,
owner/workspace grant, and bounded lifecycle. Tool effects use the same
approval policy as local MCP. OAuth authorization binds state and redirect URI
to the initiating principal and server registration; access and refresh tokens
remain in a dedicated encrypted secret store with rotation and revocation.
Reconnect never replays an uncertain tool call. Resource, prompt, and other
non-Tool MCP capabilities require separate policy before exposure.

Current implementation permits a remote device to invoke selected owner-host
stdio or HTTPS Streamable HTTP MCP servers only when its workspace grant
includes `mcp:invoke` and exact server IDs. The host's `mcp.json` must
independently list `remote_tools` for each selected server. HTTPS endpoints
must be configured with an exact URL, use system TLS trust, reject redirects,
and limit responses to 8 MiB. The owner inspects definitions with
`koda mcp inspect <server-id>` and pins each allowed definition SHA-256 in
`remote_tool_digests`; missing or changed digests fail closed on discovery and
refresh. Other servers and tools are not connected or advertised;
configured read tools retain their read classification, while unknown effects
require a fresh exact-call approval. Swift client TLS, device-grant, catalog
isolation, real stdio invocation, and approval tests cover this subset.
Configured OAuth HTTPS servers now use owner-local authorization-code/PKCE
login with a state-bound loopback callback. Providers without dynamic client
registration can use an owner-configured pre-registered `client_id`. Registration, discovery, tokens,
and verifier state are encrypted in an owner-only vault whose 32-byte key is
supplied separately through `KODA_MCP_OAUTH_KEY`; the key is not persisted by
Koda. Refresh is handled by the pinned MCP SDK. Local credential removal
prevents later Koda requests; vault key rotation atomically re-encrypts stored
state. A real TLS fixture covers registration, callback, refresh, tool use,
and local revocation. An explicitly configured HTTPS revocation endpoint
is exercised against the TLS fixture for both access and refresh tokens;
interoperability with a live OAuth MCP provider still needs acceptance,
so 4D4 remains open.

## 6. Delivery and acceptance

1. **4D1 identity and authorization:** strict owner/device/grant/workspace/thread
   contracts, canonical root mapping, redacted remote projections, and
   cross-device and ungranted-workspace negative tests. Verify each existing app-server method is
   either explicitly authorized or unavailable remotely.
2. **4D2 transport:** authenticated TLS HTTP and WebSocket, bounded
   request/response/event frames, no unauthenticated listener, reconnect
   cursors, durable replay, subscription ownership, and disconnect tests.
3. **4D3 shared state:** owner-scoped durable events/artifacts, one-host
   concurrency leases, integrity, retention, and crash/restart tests. Document
   the additional fenced leases needed before any multi-host claim.
4. **4D4 remote MCP/OAuth:** reviewed remote tool catalogs, OAuth lifecycle,
   secret isolation, interrupted-call recovery, and adversarial tests.
5. **4D5 closure:** real clients exercise concurrent subscriptions, loss and
   reconnect, approval transfer, device/workspace isolation, and bounded errors. Publish
   the exact guarantees and operational limits.

Phase 4D is complete only when all five slices pass their stated runtime,
security, and recovery checks. A reachable HTTP endpoint or a successful
handshake alone is not completion evidence.

Current 4D1 code provides `RemoteAccessCatalog`, `RemoteWorkspaceStore`,
`RemoteDeviceStore`, `RemoteThreadStore`, and `RemoteTurnRequestStore`; the
listener uses these for each request. Restricted remote Turn creation now binds
a Thread and journals the request ID before execution. The owner-host CLI can
register workspaces, explicitly expose an existing Thread
after verifying its workspace, issue scoped device credentials, revoke devices,
and start a restricted HTTPS listener on an explicit private address. The
listener authenticates each request and defaults to opaque workspace IDs,
bound Thread summaries, payload-free event envelopes, assistant updates,
safe all-type activity status, and verified Thread artifact ranges. Complete
event payload replay requires a separate `thread:events:full` grant. An
oversized event can be reconstructed from the bounded range endpoint.
The SwiftUI preview verifies an out-of-band pinned server certificate and
replays authorized assistant updates and event status. Automatic pairing, the full app-server
method set,
OAuth and physical two-device acceptance remain open before Phase 4D can
close. Scoped remote writes, commands, and exact-call approvals have local
macOS and HTTPS fixture coverage as described above.

After a host crash, an indexed interrupted Turn is returned as `interrupted`
when the initiating device retries the same request ID. The macOS client clears
that pending start and directs the owner to inspect the Thread before issuing a
new request. A `SIGKILL` test confirms an approval pending in the old process
cannot be resolved in the new process. The last assignment is durable and
owner-inspectable; a new Turn must request any approval again.
