# App-server capability compatibility

The current wire protocol remains version 19. Different versions are rejected;
this change does not establish compatibility with versions 18 or earlier.

Clients may send `requiredCapabilities: string[]` with `initialize`. Names are
bounded to 64 ASCII alphanumeric characters (starting with a letter), with at
most 64 entries. Every requested capability must be an own property of the
server capability map whose value is `true`. Unknown or disabled requirements
fail with `REQUIRED_CAPABILITY_UNAVAILABLE` before initialization completes.
The client can retry initialization after a rejected requirement.

Omitting this field preserves the existing handshake. Node clients expose it
through `NodeAppServerClientOptions.requiredCapabilities` and also verify the
returned map. An older server that rejects this optional request field is not
silently retried without the requirements.

Clients using the updated response schema accept additional boolean capability
keys. Known required capabilities, including interactive approval and execution
evidence, retain their existing strict validation. Unknown capability values of
other types are rejected. Capability declaration does not grant execution or
approval authority and does not bypass runtime policy.

The macOS GUI uses one local protocol constant for its request and response
check. A cross-language contract test compares it with the TypeScript protocol
constant. Native SwiftUI compilation and runtime verification still require macOS.

This is additive capability negotiation, not protocol-range negotiation. Future
support for earlier versions requires explicit per-version payload adaptation
and approval/evidence compatibility tests.
