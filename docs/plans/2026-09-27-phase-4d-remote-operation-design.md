# Koda Phase 4D: Authenticated Remote Operation

- Status: 4D1 and 4D2 in progress — local owner/device grants, workspace
  registration, credential lifecycle, immutable remote Thread bindings, safe
  Thread summary projection, and an opt-in read-only TLS listener with durable
  event-envelope cursor polling implemented; remote turns, WebSocket replay,
  event content projection, and client pairing are not yet enabled
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
The opt-in HTTPS listener serves only authenticated workspace IDs, bound
Thread summaries, and bounded event envelopes. It has TLS, bounded headers
and responses, no request body, per-request authorization, and negative
security tests. The event-envelope endpoint uses exclusive `after` cursors;
`-1` starts at sequence zero. It omits raw event payloads, which may contain
host paths or sensitive diagnostics. The HTTP turn API and WebSocket listener
stay disabled until their own authorization, replay, and disconnect tests pass
together.

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
`workspace:mutate`. A grant is bound to one workspace ID and device, and
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
`RemoteDeviceStore`, and `RemoteThreadStore`; the read-only listener uses these
for each request, but remote turn creation does not yet bind a Thread. The
owner-host CLI can register workspaces, explicitly expose an existing Thread
after verifying its workspace, issue scoped device credentials, revoke devices,
and start a read-only HTTPS listener on an
explicit private address. The listener authenticates each request and projects
only opaque workspace IDs, bound Thread summaries, or payload-free event
envelopes. It does not yet bind newly created remote Turns automatically,
transfer a verified server certificate to a client,
authorize the existing app-server method set, or implement durable remote
turns and event replay. These are required before 4D1/4D2 close.
