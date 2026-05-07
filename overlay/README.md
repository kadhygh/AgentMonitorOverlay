# Agent Monitor Overlay

Tauri + React prototype for the Windows desktop overlay in Task C.

## Run

```powershell
cd G:\PROJECT\AgentMonitorOverlay\overlay
npm install
npm run tauri:dev
```

For browser-only UI inspection without native window behavior:

```powershell
cd G:\PROJECT\AgentMonitorOverlay\overlay
npm run dev
```

## Current Prototype Behavior

- Uses mock session data by default.
- Attempts to fetch `GET http://127.0.0.1:17654/api/sessions`; if unavailable, keeps mock data.
- Tauri window is configured as compact, frameless, transparent, resizable=false, always-on-top.
- Header can be dragged.
- Collapse button switches between compact list and tiny summary mode.
- Clicking a session row calls `activate_session_window`.
- On Windows, `activate_session_window` enumerates visible top-level windows and tries to restore/focus the best matching candidate.
- The resolver prefers `hwnd`, then `titleToken`, then `process + title`, then `process + titleContains`, then project/cwd basename matching.
- If multiple windows match, activation is intentionally refused and the UI reports the ambiguity instead of jumping to a possibly wrong window.

## Verification Notes

- `npm run build` verifies the React/Vite UI.
- `npm run tauri:dev` verifies the Windows native overlay window if Tauri system dependencies are installed.
