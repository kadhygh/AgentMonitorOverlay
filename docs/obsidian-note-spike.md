# Obsidian Linked Note Spike

Updated: 2026-05-11

## Purpose

This worktree isolates the first end-to-end spike for:

```text
Agent Monitor Overlay session row
  -> Open Note button
  -> write request into disposable vault inbox
  -> focus a user-selected Obsidian target window
  -> Obsidian plugin polls inbox and creates/opens a linked note
```

The spike intentionally prioritizes real user interaction over a purely theoretical plugin model.

## Paths

- Worktree: `D:\Projects\commonproject\AgentMonitorOverlay-obsidian-spike`
- Test vault: `D:\Projects\commonproject\AgentMonitorOverlay-obsidian-test-vault`
- Plugin source: `obsidian-plugin/`
- Plugin deploy target:
  - `.obsidian/plugins/agent-monitor-overlay/`

## Current Architecture

### 1. Overlay side

- `overlay/src/App.tsx`
  - adds row-level `Open Note` button
  - adds Obsidian target selection UI
- `overlay/src-tauri/src/lib.rs`
  - gathers session payload
  - enumerates visible `Obsidian.exe` windows
  - lets the user bind one Obsidian target window by HWND/PID/title
  - writes request JSON into the disposable vault `.amo/inbox`
  - focuses the selected Obsidian target window after queueing the request

### 2. Plugin side

- `obsidian-plugin/src/main.ts`
  - registers plugin commands
  - processes pending `.amo/inbox` requests
  - polls inbox every 1.5s after load
  - creates or opens deterministic linked notes inside the vault

The plugin still keeps a protocol handler scaffold, but the current MVP path no longer depends on URI-triggered note creation.

### 3. Request sidecar

- `.amo/inbox/`
  - receives create-linked-note request JSON from the overlay
- `.amo/outbox/`
  - receives plugin-side result/status output

## Deterministic note path

The linked note path is currently:

```text
AMO/Sessions/<Project>/<Tool>-<SessionId>.md
```

Example:

```text
AMO/Sessions/AgentMonitorOverlay/codex-manual-demo-session.md
```

## What has been verified locally

- plugin build
- plugin deploy into disposable vault
- overlay frontend build
- Tauri Rust compile
- row-level `Open Note` action wiring
- visible Obsidian window enumeration from Tauri
- selected Obsidian window binding UI
- plugin auto-polling for inbox requests
- request queue write into disposable vault inbox
- focus-back to a selected Obsidian target window after queueing a request

## What is not yet verified end to end

- clicking `Open Note` after a target is selected and observing the note appear in the test vault
- verifying that the selected Obsidian window is really the vault that has the AMO plugin enabled
- verifying repeated clicks reopen the same note rather than create duplicates

## Current blocker

The earlier URI-first path proved too brittle in practice. The user hit real Windows/Obsidian popups such as:

- `Unable to find a vault for the URL obsidian://open/...`
- `Unable to find a vault for the URL obsidian://amo-create-note/...`

The spike has now pivoted away from that path. The active MVP path is:

```text
bind target Obsidian window manually
  -> queue request into .amo/inbox
  -> focus that bound window
  -> let the plugin process the inbox inside the already-open vault
```

## Next manual validation

1. Open the disposable test vault in Obsidian and make sure the `agent-monitor-overlay` plugin is enabled.
2. Open the spike overlay window from this worktree.
3. Click the top `Obsidian` button and select the correct visible Obsidian target window.
4. Click `Open Note` on a session row.
5. Confirm:
   - the overlay feedback line reports the request JSON path
   - focus jumps to the selected Obsidian window
   - a note appears at `AMO/Sessions/<Project>/<Tool>-<SessionId>.md`

## Current branch and handoff

- Branch: `spike/obsidian-plugin-note-create`
- Remote push is expected after this handoff snapshot.
- The primary handoff risk is not compile failure; it is runtime alignment:
  - selecting the correct Obsidian window
  - ensuring that selected window is the vault with the plugin enabled
