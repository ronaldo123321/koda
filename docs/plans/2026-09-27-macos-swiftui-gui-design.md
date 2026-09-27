# Koda macOS SwiftUI application

- Status: local GUI preview implemented; installed Provider and approval acceptance pending
- Date: 2026-09-27
- Scope: native macOS client over the existing local app-server contract
- Deployment: unsigned internal `.app` with the existing self-contained Koda runtime

## Current application

The SwiftUI client launches `koda app-server` from its bundled runtime and
checks protocol version 18. It uses the local stdio JSON-RPC surface for
workspace-scoped Thread listing and history, Turn start/cancel, durable event
notifications, and explicit approval decisions. The sidebar keeps Thread
navigation visible. The conversation pane shows user and assistant messages,
while the approval sheet presents the server's title, summary, reason, and
details before the user chooses Approve or Reject.

The client does not store Provider secrets. It reads only the initialization
metadata's `configured` boolean and the credential variable name; sending is
disabled when the selected Provider is unavailable. The host process must
already have the credential in its environment. The app's current history
view shows the newest 200 events of one Thread and does not yet render tools,
plans, artifacts, process panes, or rich Markdown.

`package-preview.sh` copies a previously verified, architecture-matched Koda
runtime under `Contents/Resources/runtime/koda`, then runs the copied
runtime's bundle doctor. It produces an unsigned internal `.app`; it is not a
Developer ID release or notarized archive. `package-unsigned-pkg.sh` wraps
that app as an unsigned component package for internal installation testing;
its actual install and rollback acceptance remain pending.

## Next acceptance and release work

1. Exercise a real Provider turn and an approval in the `.app`, including
   interruption/relaunch recovery and preservation of prompt input on error.
2. Add user-controlled macOS Keychain credential setup without putting secret
   values in app-server JSON-RPC, thread logs, settings, diagnostics, or build
   artifacts. Gate any live Provider request behind an explicit user action.
3. Complete local GUI coverage for tool results, plans, artifacts, processes,
   search, settings, and workspace mutation recovery before claiming feature
   parity with the TUI.
4. Connect the native client to Phase 4D's authenticated remote endpoint with
   certificate trust and device lifecycle, then accept reconnect and replay on
   two real devices.
5. Build a reversible `.pkg` installation path, signed/notarized release, and
   provenance-checked automatic update with rollback. Apple Developer
   credentials are needed for public signing and notarization, not for the
   unsigned local acceptance steps.
