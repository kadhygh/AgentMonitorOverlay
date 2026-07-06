# Agent Monitor Broker

Local HTTP JSON broker for the Agent Monitor Overlay MVP.

The broker is intentionally small:

- no external npm dependencies
- listens on `127.0.0.1` by default
- accepts normalized or tool-shaped mock events
- stores the latest session snapshot in `broker/data/sessions.json`

## Start

```powershell
npm run broker
```

Equivalent direct command:

```powershell
node .\broker\server.js
```

Optional environment variables:

```powershell
$env:AGENT_MONITOR_HOST = "127.0.0.1"
$env:AGENT_MONITOR_PORT = "17654"
$env:AGENT_MONITOR_DATA_FILE = "G:\PROJECT\AgentMonitorOverlay\broker\data\sessions.json"
node .\broker\server.js
```

## API

All API responses include local CORS headers so the Tauri/Vite WebView can fetch the broker from `http://127.0.0.1:17654`.

### `GET /api/health`

Returns broker status, uptime, session count, and storage path.

### `GET /api/sessions`

Returns the unified session list:

```json
{
  "count": 1,
  "sessions": [
    {
      "tool": "codex",
      "sessionId": "codex-demo-001",
      "cwd": "G:\\PROJECT\\AgentMonitorOverlay",
      "title": "Codex - AgentMonitorOverlay",
      "state": "running",
      "lastEvent": "PostToolUse",
      "lastMessage": "Edited broker/server.js",
      "needsAttention": false,
      "windowHint": {
        "process": "WindowsTerminal.exe",
        "title": "Codex - AgentMonitorOverlay",
        "titleToken": "[AMO:codex:agent-monitor-overlay:broker]",
        "titleContains": ["AgentMonitorOverlay", "Codex"],
        "project": "AgentMonitorOverlay",
        "cwd": "G:\\PROJECT\\AgentMonitorOverlay",
        "tool": "codex",
        "pid": null,
        "hwnd": null
      },
      "updatedAt": "2026-05-07T09:00:00.000Z",
      "createdAt": "2026-05-07T09:00:00.000Z",
      "heartbeatAt": null,
      "eventCount": 1
    }
  ]
}
```

### `GET /api/session-events`

Opens a local Server-Sent Events stream for low-latency overlay refreshes.

The stream sends `sessions.changed` whenever a broker route mutates a session, including events, replies, prompts, Obsidian annotations, sync-back, window binding, and heartbeat updates. The event includes the changed session so the overlay can update the affected card immediately; interval polling still runs as a fallback and reconciliation path.

Example event:

```text
event: sessions.changed
data: {"ok":true,"sequence":1,"event":"sessions.changed","reason":"obsidian-annotations","sessionId":"codex-demo-001","session":{"sessionId":"codex-demo-001","state":"waiting_user"},"updatedAt":"2026-05-20T07:30:40.149Z"}
```

### `POST /api/sessions/:id/dismiss`

Dismisses a session card from the broker's active session list and persists the updated snapshot. The dismissed card stays hidden after overlay or broker restart because the session is removed from `broker/data/sessions.json`. A later hook event for the same `sessionId` can recreate the session and make it visible again.

Optional payload:

```json
{
  "reason": "user"
}
```

### `POST /api/sessions/dismiss-all`

Clears the active broker session list and persists an empty snapshot. This is intended for local cleanup of stale smoke/test cards.

### `POST /api/sessions/:id/reviewed`

Marks the latest reply review prompt as viewed. Reply creation through `POST /api/replies` sets `reviewRequired: true` / `reviewStatus: "pending"` so the overlay can highlight cards that need human review. Opening the note/canvas, activating the target window, or pressing the overlay `Seen` button can call this endpoint.

Optional payload:

```json
{
  "action": "open-note",
  "by": "overlay"
}
```

### `POST /api/sessions/:id/attention-cleared`

Clears a stale non-review attention state after the user returns to the target tool and handles it there. This is primarily for permission/user-wait cards where the CLI does not emit a follow-up hook after the user approves or rejects the prompt. If the session is still in `waiting_permission` or `waiting_user`, the endpoint moves it back to `running` unless a valid `state` is supplied.

Optional payload:

```json
{
  "action": "activate-target",
  "state": "running",
  "by": "overlay"
}
```

### `POST /api/obsidian/register-vault`

Registers a project-local AMO vault in Obsidian's `obsidian.json` vault registry and reports whether the vault appears loaded enough for plugin-owned `obsidian://amo-open` links. The loaded check accepts either Obsidian's global runtime config file (`runtimeConfigFileExists`) or vault-local evidence (`vaultRuntimeState.loaded`) such as `.obsidian/workspace.json`, `.obsidian/app.json`, or `.obsidian/core-plugins.json`.

### `POST /api/events`

Accepts a JSON payload from mock adapters. Minimum useful fields:

```json
{
  "tool": "codex",
  "sessionId": "codex-demo-001",
  "cwd": "G:\\PROJECT\\AgentMonitorOverlay",
  "event": "PostToolUse",
  "message": "Edited broker/server.js",
  "windowHint": {
    "process": "WindowsTerminal.exe",
    "titleContains": ["AgentMonitorOverlay", "Codex"],
    "project": "AgentMonitorOverlay",
    "cwd": "G:\\PROJECT\\AgentMonitorOverlay"
  }
}
```

The broker maps event names and explicit state fields into the unified model. If `state` is provided, it wins over inferred state.

Supported unified states:

- `starting`
- `running`
- `waiting_permission`
- `waiting_user`
- `idle`
- `completed`
- `failed`
- `cancelled`

### `POST /api/sessions/:id/heartbeat`

Updates `heartbeatAt`, `updatedAt`, and optionally `state`, `message`, `title`, `cwd`, and `windowHint`.

## Persistence Strategy

The broker persists the latest session snapshot after every event and heartbeat. The file is:

```text
broker/data/sessions.json
```

On restart, the broker loads this snapshot and returns the last known session state. This is a last-known-state cache, not a complete event log.

If the cache is deleted, the expected rebuild strategy is:

1. keep the broker running,
2. let Codex / Claude / Kiro hooks send their next event or heartbeat,
3. rebuild the current session table from those fresh adapter updates.

For MVP this is enough because the overlay only needs recent live status. Full history/search belongs to a later phase.

## Verify

Run the PowerShell verification script:

```powershell
npm run broker:verify
```

Or:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\broker\verify.ps1
```
