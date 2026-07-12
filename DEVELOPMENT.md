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

Use the root entry point for both internal startup modes. Source mode runs a frontend production build first, then starts the Tauri development stack:

```powershell
.\amo.ps1 -Mode Source
```

This starts the broker first, waits for `http://127.0.0.1:17654/api/health`, clears stale AMO overlay dev processes that would block Vite port `1420`, and then starts the Tauri overlay dev process. Use a visible broker/overlay console only while debugging:

```powershell
.\amo.ps1 -Mode Source -DebugMode
```

Portable mode stops repository-owned AMO processes, preserves the latest Portable `data/` directory, builds the current version, restores that data, and starts the resulting package:

```powershell
.\amo.ps1 -Mode Portable -SkipDependencyInstall
```

The npm aliases are `npm run amo`, `npm run amo:debug`, and `npm run amo:portable`.

Start only the broker:

```powershell
npm run broker
```

This starts the broker hidden in the background. Use a visible broker console only while debugging:

```powershell
npm run broker:debug
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

Current working direction is Phase 5 Hook-to-Obsidian Bridge MVP.

The existing overlay/broker MVP remains the base:

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
- broker-backed dismiss action per session row, intended to remove the current active snapshot until a later real hook event recreates it

New Phase 5 direction:

- overlay should keep the floating status surface and click-to-window routing
- overlay should launch or verify a small local bridge server
- the existing Node broker should evolve into that bridge first
- hook/adapter deployment should be manual and workspace-scoped, not global
- user selects a project folder, then AMO inspects the folder and chooses or suggests the local adapter path
- workspace-local hooks can be the primary source for status and completed assistant replies
- Codex `Stop` hook reply capture should POST to the bridge and keep local `.codex/cache/` only for debug mode or bridge/hook failure fallback
- bridge should create Obsidian reply notes and append file nodes to an Obsidian canvas
- Obsidian plugin should own vault-native annotation extraction using `[!anno]...[/anno]`
- sync-back now runs from Obsidian `Send to AMO` as automatic clipboard copy plus target CLI/App focus; the user still manually pastes/submits

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

Current implemented behavior:

- Session rows include a dismiss button.
- Dismiss is broker-owned: it removes the session from the active broker snapshot and persists the updated `broker/data/sessions.json`.
- A dismissed session can reappear when a hook later posts a fresh event for the same `sessionId`.
- If every visible session is dismissed, the overlay shows an empty broker state instead of falling back to mock data.
- Reply stop events create a green pending-review card state. Pressing `Seen`, opening Note/Canvas, or activating the target window marks the reply reviewed; a later prompt/running event clears stale review state.

## Known Open Gaps

- Codex hook status has changed:
  - The old adapter/broker contract passes.
  - A separate MVP in `D:\Projects\CommonProject\obsidianplugintest` proves `Stop` can read `last_assistant_message` and cache it as Markdown/JSON.
  - AMO now receives this as `POST /api/replies`, writes reply notes, appends canvas nodes, and links the result to overlay session state.
- Claude live hook smoke passed with disposable `--settings`.
- Kiro is still mock/hook-spike level for MVP.
- Window routing still needs clearer blocked-focus feedback and stronger exact-route identity for real sessions.
- Card reorder is enabled again after switching drag handling to window-level pointer listeners; user confirmed the interaction feels smooth.
- Future overlay setting: gate window resizing behind a settings toggle. When disabled, hide resize edge/corner indicators and ignore resize gestures; when enabled, show the resize handles and allow size changes.
- Tauri overlay now checks `127.0.0.1:17654/api/health` on startup and can start the local Node broker from `broker/server.js` when it is not already running.
- Manual workspace inspect/enroll is implemented in the broker and exposed through a compact overlay deploy panel backed by a Windows folder picker.
- Future deploy UX should become a clearer step-by-step settings surface: `Check` is read-only folder inspection, `Deploy` writes project-local files, and later repair/disable/uninstall/history should be visible.
- Future startup UX should avoid the brief white overlay flash while the app initializes or auto-starts the broker; add a lightweight loading state with text such as `Initializing` / `Starting broker`.
- Obsidian vault note writing and canvas append are implemented for the project-local `workspace.vaultRoot`.
- Deployments create a friendly vault folder named `.amo/AMO - <project>/` so Obsidian's vault list is distinguishable. Test workspaces can be redeployed instead of migrated.
- Before opening note/canvas links, the overlay asks the broker to register `workspace.vaultRoot` in Obsidian's vault registry and checks whether Obsidian has a per-vault runtime config for that vault. If Obsidian is already running but has not loaded a brand-new AMO vault, overlay reports the manual open-vault requirement instead of firing a URI that produces `Vault not found`. Once loaded, the plugin-owned `amo-open` URI uses only vault-relative `path/kind`.
- Broker-side `/api/obsidian/annotations` and `/api/sync-back` are implemented.
- Workspace enroll installs and enables a vault-local `md-anno-tools` Obsidian plugin with an explicit `Send current note annotations to AMO` command. First-load behavior still depends on Obsidian loading/reloading the project-local vault and community plugin state.

## Manual Workspace Hook Enrollment

Do not treat global hook deployment as the Phase 5 default. The current product direction is:

- User selects a target project folder.
- AMO inspects folder contents and local tool configuration.
- AMO identifies the likely CLI/TUI adapter path, such as Codex project-local `Stop` hook, Claude disposable settings, Kiro hook/mock, or a future transcript/wrapper adapter.
- AMO shows the files it would write before writing them.
- AMO writes only project-local hook/adapter files after explicit confirmation.
- AMO records the workspace enrollment and keeps it reversible.

Current repo-local hook files remain useful as implementation examples:

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

## Phase 5 Bridge Inputs

Useful external MVP documents:

- `D:\Projects\CommonProject\obsidianplugintest\docs\CODEX_REPLY_NOTE_HOOK_INTEGRATION.md`
- `D:\Projects\CommonProject\obsidianplugintest\docs\OBSIDIAN_ANNOTATION_PLUGIN_DEVELOPMENT.md`

Repo-local reference snapshot for cross-device handoff:

- `docs/reference-mvps/obsidianplugintest/README.md`
- `docs/reference-mvps/obsidianplugintest/handoff/`
- `docs/reference-mvps/obsidianplugintest/codex-hook/`
- `docs/reference-mvps/obsidianplugintest/plugin/`

Useful Codex reply hook facts:

- Trigger: Codex `Stop`
- Content field: `last_assistant_message`
- Hook stdout should stay protocol-clean and return `{"continue":true}`
- Keep `.codex/cache/latest-assistant-message.md`, `.codex/cache/latest-assistant-message.json`, and `.codex/cache/assistant-turns/` only when broker debug is enabled or bridge delivery fails
- Useful record fields: `capturedAt`, `sessionId`, `turnId`, `model`, `hookEventName`, `cwd`, `transcriptPath`, `stopHookActive`, `message`

Useful Obsidian plugin facts:

- Plugin id: `md-anno-tools`
- Annotation syntax: `[!anno]...[/anno]`
- Current plugin supports reading-mode rendering, editor selection wrapping, appending an annotation, and copying current note annotations
- The enrolled AMO plugin also adds `Send current note annotations to AMO`, which reads AMO frontmatter from reply notes and POSTs extracted annotations to the bridge without replacing the existing clipboard command

Guardrails:

- Keep Obsidian as a sidecar workflow, not the primary AMO data model
- Do not install global hooks in Phase 5
- Start adapter deployment from a user-selected project folder
- Choose adapter behavior from folder contents and local CLI/TUI capabilities
- Let the Obsidian plugin own vault-native note/canvas behavior and annotation UX
- Let the AMO bridge own session linkage, reply note routing, pending prompts, and overlay-visible state
- `Send to AMO` may automatically copy the pending prompt and focus the target session
- Do not auto-paste, auto-enter, auto-submit, or auto-approve in Phase 5

## Useful Documents

Read in this order when taking over:

1. `PROJECT_PLAN.md`
2. `docs/supervisor-status.md`
3. `docs/amo-obsidian-bridge-mvp.md`
4. `docs/reference-mvps/obsidianplugintest/README.md`
5. `docs/reference-mvps/obsidianplugintest/handoff/CODEX_REPLY_NOTE_HOOK_INTEGRATION.md`
6. `docs/reference-mvps/obsidianplugintest/handoff/OBSIDIAN_ANNOTATION_PLUGIN_DEVELOPMENT.md`
7. `docs/validation-checklist.md`
8. `docs/window-routing-notes.md`
9. `docs/tool-adapter-spike.md`
10. `docs/adapter-deployment-guide.md`
11. `docs/worktree-checkpoint-guide.md`
12. `docs/session-handoffs/2026-05-13-amo-obsidian-bridge-pivot.md`
13. `broker/README.md`
14. `overlay/README.md`
15. `USER_SESSION_MANUAL.md`

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

1. Implement script-driven workspace inspect/enroll in the existing Node broker, starting from a user-selected project folder and following `docs/adapter-deployment-guide.md`.
2. For the first MVP, support only the `codex-cli` adapter and create project-local `.amo/` plus `workspace.vaultRoot`.
3. Implement the smallest bridge `/api/replies` endpoint.
4. Add bridge config for the project-local `workspace.vaultRoot`, session generated-note folder, and `Canvases/AgentFlow.base.canvas`.
5. Adapt the proven Codex `Stop` hook script as a project-local enrolled adapter so it keeps `.codex/cache/` only for debug/failure fallback and best-effort POSTs to AMO bridge.
6. Generate a reply note and append-only canvas file node in the project-local vault.
7. Add overlay actions for `Focus CLI`, `Open Note`, and `Open Canvas`; Obsidian `Send to AMO` should trigger automatic copy+focus instead of a card-face Sync button.
8. Add an Obsidian plugin command that owns note/canvas opening with tab reuse and sends extracted `[!anno]...[/anno]` annotations to AMO.
9. Run a manual end-to-end smoke before expanding to Codex App, Claude CLI, Kiro IDE, or multi-CLI canvas shortcuts.
