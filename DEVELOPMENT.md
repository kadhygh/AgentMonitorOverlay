# Development Handoff

This document is for continuing Agent Monitor Overlay development on a new machine.

## Repository

```powershell
git clone https://github.com/kadhygh/AgentMonitorOverlay.git
cd AgentMonitorOverlay
git switch master
```

Branches:

- `master`: current stable/default handoff branch. New machines should start here.
- `phase/1-2-spikes`: phase checkpoint branch retained for history; its current work is merged into `master` for handoff.

Remote:

```text
origin https://github.com/kadhygh/AgentMonitorOverlay.git
```

## Required Tools

Windows is the primary target for the current phase.

Install:

- Git
- Node.js 18 or newer
- npm
- Rust stable MSVC toolchain
- Microsoft Edge WebView2 Runtime
- Visual Studio Build Tools with C++ desktop build tools and Windows SDK
- PowerShell 5.1 or newer

Known working environment from the previous machine:

```text
Node: v24.13.0
npm: 11.14.0
Rust: rustc 1.93.1
Cargo: cargo 1.93.1
Broker port: 17654
Overlay dev port: 1420
```

## Install Dependencies

The broker currently has no external npm dependencies. The overlay has its own package.

```powershell
cd overlay
npm install
cd ..
```

Do not commit generated dependency or build folders. They are ignored:

- `node_modules/`
- `dist/`
- `target/`
- `tmp/`
- `broker/data/`

## Verification

Run these from the repository root unless noted.

```powershell
node --check broker\server.js
npm run broker:verify
npm run adapters:verify
```

Overlay frontend build:

```powershell
cd overlay
npm run build
cd ..
```

Tauri native check:

```powershell
cd overlay\src-tauri
cargo check
cd ..\..
```

If port `17654` is already occupied, verification scripts can use another port:

```powershell
npm run broker:verify -- -Port 17655
npm run adapters:verify -- -Port 17655
```

## Running Locally

Start only the broker:

```powershell
npm run broker
```

Start the current user-facing Claude routing demo:

```powershell
npm run demo:claude-routing
```

The demo starts:

- broker on `http://127.0.0.1:17654`
- a Claude demo target window
- Tauri overlay dev app
- Vite dev server on `http://127.0.0.1:1420`

The overlay should show `broker live` in the header. If it shows `mock mode`, check:

- broker health: `Invoke-RestMethod http://127.0.0.1:17654/api/health`
- sessions: `Invoke-RestMethod http://127.0.0.1:17654/api/sessions`
- Vite/WebView CORS access to broker

Browser-only UI inspection:

```powershell
cd overlay
npm run dev
```

Native overlay:

```powershell
cd overlay
npm run tauri:dev
```

## Current Behavior

Current MVP scope is read-only monitoring plus click-to-window routing.

Implemented:

- local broker with:
  - `GET /api/health`
  - `GET /api/sessions`
  - `POST /api/events`
  - `POST /api/sessions/:id/heartbeat`
- broker CORS headers for local Tauri WebView fetches
- broker snapshot persistence under `broker/data/`
- adapter verification for Codex / Claude / Kiro payloads
- Tauri overlay UI
- broker-backed session refresh
- tool icons per session row
- route hints for exact/token/fallback routing
- row drag handle placeholder, currently disabled while routing validation continues
- header drag region for moving the overlay window
- Windows native window activation using HWND, PID, title token, process/title, and project fallbacks
- Claude routing demo
- candidate/debug panel for ambiguous routing
- local dismiss action per session row, intended to hide the current snapshot until a later real hook event refreshes it

## Current Validation Notes

User validation so far:

- overlay appears
- `broker live` mode works after broker CORS fix
- mock `NoHeartbeat` fallback no longer appears when broker is running
- tool icons are acceptable
- header drag moves the overlay
- Codex mock/window route can jump to an existing Mecho Codex window
- Claude demo route works when only one matching demo target window is open

Recent UX issue:

- Card drag proved disruptive during validation. The handle is currently left visible as a placeholder, but card reordering is temporarily disabled until the routing and exact-session identity work is stable.

Known routing behavior:

- If two matching Claude demo windows are open, activation intentionally refuses because the target is ambiguous.
- Closing the duplicate window makes exact-route demo rows route correctly.
- The overlay now shows a candidate/debug panel for ambiguous rows, and exact/token/fallback route hints per session row.

Current unverified but implemented behavior:

- Session rows now include a dismiss button.
- Dismiss is overlay-local only. It hides the current card snapshot without deleting the broker session.
- Dismissed session ids are stored in browser/WebView storage under `amo.dismissed.sessions.v1`.
- A dismissed session should reappear automatically when the same session later arrives with a newer `eventCount` or `updatedAt`.
- If every visible session is dismissed, the overlay should show an empty state instead of falling back to mock data.

## Known Open Gaps

- Codex live hook loading is not fully validated.
  - The adapter/broker contract passes.
  - Codex can run with the user's normal provider configuration.
  - Repo-local hooks are now wired in `.codex/`, but Codex still needs `/hooks` review and live smoke in a real interactive session.
  - Current smoke evidence is mixed: broker can receive real hook events while Codex still reports hook failure/timeout noise.
  - Next route: isolate the hook-runner failure cause without regressing event delivery, preferably through a disposable project-local review/smoke path first.
- Claude live hook smoke passed with disposable `--settings`.
- Kiro is still mock/hook-spike level for MVP.
- Window routing still needs clearer blocked-focus feedback and stronger exact-route identity for real sessions.
- Card reorder is temporarily disabled and should stay out of the critical path until routing work is stable.

## Repo-Local Hook Smoke Route

Current repo-local hook files:

- `.codex/config.toml`
- `.codex/hooks.json`
- `.codex/hooks/codex-lifecycle-hook.ps1`

Recommended first smoke path:

- Use a disposable sibling repo or test project for the first `codex` trust + `/hooks` review round.
- Confirm that real `SessionStart` / `UserPromptSubmit` events reach the broker before relying on the main repo.
- Treat "broker received events" and "Codex hook runner exits cleanly" as two separate checks.

Current local example from the active machine:

- `D:\Projects\CommonProject\AgentMonitorOverlayTestproject`

That disposable test project is not part of this repo. Recreate it locally if needed rather than assuming it exists on another machine.

## Deferred Future Integration

Obsidian workflow integration is accepted as a future direction, but it is intentionally deferred beyond the current MVP phase.

Planned shape:

- Phase 5A: `Open in Obsidian` / open related note from a monitored session
- Phase 6.x: session-note linking, final output note generation, structured annotations, single-direction canvas attachment, and explicit sync-back to the target agent session

Guardrails:

- Keep Obsidian as a sidecar workflow, not the primary data model for current MVP
- Let an Obsidian plugin own vault-native note/canvas mutation
- Let a local bridge/helper own any route-back to the correct CLI session or window
- Prefer `copy + focus target session` before any auto-send behavior

## Useful Documents

Read in this order when taking over:

1. `PROJECT_PLAN.md`
2. `docs/supervisor-status.md`
3. `docs/validation-checklist.md`
4. `docs/window-routing-notes.md`
5. `docs/tool-adapter-spike.md`
6. `docs/worktree-checkpoint-guide.md`
7. `docs/session-handoffs/2026-05-11-phase-3-4-checkpoint.md`
8. `broker/README.md`
9. `overlay/README.md`
10. `USER_SESSION_MANUAL.md`

## Development Workflow

Before changing code:

```powershell
git status --short --branch
git pull --ff-only
```

Commit focused changes:

```powershell
git status --short
git diff --stat
git add -- <specific files>
git commit -m "<type>: <short description>"
git push
```

Do not use `git add .` for broad commits when generated files or unrelated local state may exist.

For multi-worktree or multi-session continuation, use:

- `docs/worktree-checkpoint-guide.md`

That checklist is the current supervisor-side rule for collecting branch, scoped files, validation, commit, push, and repo-local handoff notes before changing machines.

Do not commit:

- `broker/data/`
- `tmp/`
- logs
- build outputs
- credentials or tool auth files

## Recommended Next Tasks

1. Continue tightening exact route identity so real sessions prefer `pid/hwnd` over token/fallback matching.
2. Continue Codex live hook loading validation.
3. Make the ambiguous routing/debug experience clearer without expanding into broader control features.
4. Validate the new dismiss flow against a real hook-emitting session, especially "dismiss -> next event -> card reappears".
5. Decide whether local card order should return later as a stable, non-intrusive enhancement.
6. Keep Obsidian workflow integration as a future tracked direction, not part of the current MVP closeout.
