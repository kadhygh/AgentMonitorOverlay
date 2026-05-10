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

- Starts with mock session data only as an initial/fallback state.
- Fetches `GET http://127.0.0.1:17654/api/sessions`; when the broker is available the header shows `broker live`.
- Broker CORS support lets the Tauri WebView fetch `127.0.0.1:17654` from the Vite/WebView origin.
- Tauri window is configured as compact, frameless, transparent, resizable=false, always-on-top.
- Header can be dragged to move the overlay window.
- Collapse button switches between compact list and tiny summary mode.
- Each session row shows a tool icon before the title/project text.
- Dragging a row handle reorders visible cards locally without activating the session.
- Clicking a session row calls `activate_session_window`.
- On Windows, `activate_session_window` enumerates visible top-level windows and tries to restore/focus the best matching candidate.
- The resolver prefers `hwnd`, then `pid`, then `titleToken`, then `process + title`, then `process + titleContains`, then project/cwd basename matching.
- If multiple windows match, activation is intentionally refused and the UI reports the ambiguity instead of jumping to a possibly wrong window.

## Current Validation Notes

- User smoke validation confirms the native overlay appears and broker-backed data shows instead of mock `NoHeartbeat` fallback.
- Header drag, tool icons, Codex/Mecho routing, and Claude demo routing with one matching target have been accepted.
- If two matching Claude demo windows are open, the ambiguity refusal is expected. A candidate/debug panel is the next improvement.
- Pointer-driven row drag preview and live reordering are implemented, but still need user revalidation, especially with only two cards.

## Verification Notes

- `npm run build` verifies the React/Vite UI.
- `npm run tauri:dev` verifies the Windows native overlay window if Tauri system dependencies are installed.
