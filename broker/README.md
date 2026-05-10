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
