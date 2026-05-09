# Development Handoff

This document is for continuing Agent Monitor Overlay development on a new machine.

## Repository

```powershell
git clone https://github.com/kadhygh/AgentMonitorOverlay.git
cd AgentMonitorOverlay
git checkout phase/1-2-spikes
```

Branches:

- `master`: stable documentation baseline.
- `phase/1-2-spikes`: current active development branch.

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
- row drag handle for visible card ordering
- header drag region for moving the overlay window
- Windows native window activation using HWND, PID, title token, process/title, and project fallbacks
- Claude routing demo

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

- Row drag can trigger, but should feel like the card follows the pointer and should reorder reliably even with only two cards. The latest implementation uses pointer-driven drag preview and live reordering; it still needs user revalidation on the new machine.

Known routing behavior:

- If two matching Claude demo windows are open, activation intentionally refuses because the target is ambiguous.
- Closing the duplicate window made both Claude demo rows route correctly.
- Next improvement should make duplicate-candidate feedback more actionable, for example by showing a small candidate/debug panel.

## Known Open Gaps

- Codex live hook loading is not fully validated.
  - The adapter/broker contract passes.
  - Codex can run with the user's normal provider configuration.
  - Disposable project-local hook loading did not work in the previous smoke test.
  - Next route: find a safe per-process hook injection method or carefully install/restore a user-layer Codex hook.
- Claude live hook smoke passed with disposable `--settings`.
- Kiro is still mock/hook-spike level for MVP.
- Window routing still needs better visible diagnostics for ambiguity and blocked focus transfer.
- Card reorder is local UI state only; it is not persisted yet.

## Useful Documents

Read in this order when taking over:

1. `PROJECT_PLAN.md`
2. `docs/supervisor-status.md`
3. `docs/validation-checklist.md`
4. `docs/window-routing-notes.md`
5. `docs/tool-adapter-spike.md`
6. `broker/README.md`
7. `overlay/README.md`
8. `USER_SESSION_MANUAL.md`

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

Do not commit:

- `broker/data/`
- `tmp/`
- logs
- build outputs
- credentials or tool auth files

## Recommended Next Tasks

1. Revalidate pointer-driven card dragging on the new machine.
2. Add a window candidate/debug panel for ambiguous routing.
3. Make `npm run demo:claude-routing` produce a target window that is easy to identify and clean up.
4. Continue Codex live hook loading validation.
5. Decide whether local card order should persist across refresh/restart.

