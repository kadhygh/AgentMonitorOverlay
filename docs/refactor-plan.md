# AMO Refactor Plan

Updated: 2026-07-09

This plan turns the current working MVP into a maintainable project without changing product behavior as part of the refactor itself.

The active long-task execution guide is `docs/refactor-execution-guide.md`. Use this file as the historical plan and progress log; use the execution guide for the next concrete split order, guardrails, validations, and stop conditions.

## Goals

- Keep most hand-written source files around 300-500 lines.
- Allow larger files only when they are stable orchestration roots, generated bundles, lockfiles, or schema output.
- Avoid over-splitting. A file with only one or two tiny functions is usually worse than the current problem.
- Move code by responsibility first, then improve internals only after behavior is covered by a checkpoint.
- Update architecture and structure documentation while code moves, so future work has a map.
- Keep Obsidian Canvas behavior inside the existing safe boundary: broker writes JSON Canvas data, plugin may add explicit user actions, and AMO must not take over native Canvas rendering.

## Current Hotspots

| File | Current Size | Problem |
| --- | ---: | --- |
| `broker/server.js` | ~450 lines | Native HTTP bootstrap, route dispatch, SSE publishing, and session target/window binding helpers remain in the root; feature behavior and route groups have moved out. |
| `overlay/src/App.tsx` | ~2830 lines | Main overlay session polling, target activation, Obsidian open/recovery, workspace panel actions, card drag, window bind drag, and resize logic still live in one root. |
| `broker/assets/obsidian/md-anno-tools/src/plugin.ts` | ~2165 lines | Plugin lifecycle, Canvas actions, annotation source edits, bridge actions, note title/property behavior, and work-canvas helpers remain concentrated. |
| `overlay/src-tauri/src/windows.rs` | ~592 lines | Native window enumeration/activation is the only Tauri file above 500 lines; it is not urgent because `lib.rs` is already thin. |
| `broker/assets/obsidian/md-anno-tools/src/ui/panel-view.ts` | ~558 lines | Panel view is large but cohesive and lower priority than `plugin.ts`. |
| `broker/assets/obsidian/md-anno-tools/styles.css` | ~529 lines | Plugin CSS is slightly over target but less risky than behavior roots. |

Generated files and lockfiles are excluded from the source-size target.

## Target Structure

### Overlay

Target:

```text
overlay/src/
  api/
    brokerClient.ts
  domain/
    sessionModel.ts
    workspaceModel.ts
    routingModel.ts
  components/
    SessionCard.tsx
    BrokerReadinessPanel.tsx
    CandidateMenu.tsx
    WorkspacePanel.tsx
    LaunchPanel.tsx
  windows/
    MainOverlayApp.tsx
    DeployWorkspaceApp.tsx
    SettingsWindowApp.tsx
    ScratchpadApp.tsx
  theme/
    amoTheme.ts
  App.tsx
  types.ts
```

`App.tsx` should become a thin window switch/root entry, not the owner of every feature.

### Broker

Target:

```text
broker/
  server.js
  lib/
    http.js
    debug.js
    session-store.js
    workspace-deploy.js
    workspace-maintenance.js
    workspace-launch.js
    obsidian-vault.js
    conversation-artifacts.js
    canvas-writer.js
    target-binding.js
    display-names.js
    filesystem.js
  hooks/
    codex.js
    claude.js
```

`server.js` should keep the native HTTP server and route table. Route handlers should delegate to modules.

### Obsidian Plugin

Target:

```text
broker/assets/obsidian/md-anno-tools/src/
  plugin.ts
  protocol/
    amo-open.ts
  bridge/
    actions.ts
  canvas/
    target.ts
    controller.ts
  editor/
    annotation-commands.ts
    local-code-links.ts
  note/
    title.ts
  annotations/
    syntax.ts
    render.ts
  ui/
    panel-view.ts
    settings-tab.ts
    modals.ts
  core/
    api.ts
    constants.ts
    metadata.ts
    paths.ts
    ui-utils.ts
```

`plugin.ts` should stay as lifecycle and command registration. Canvas private/DOM fallback usage must stay behind canvas modules and must follow `docs/agnets/obsidian-canvas-development-guidelines.md`.

### Tauri

Target:

```text
overlay/src-tauri/src/
  lib.rs
  broker.rs
  clipboard.rs
  dialogs.rs
  scratchpad.rs
  windows.rs
```

This is a later phase because the immediate maintenance pressure is in JS/TS.

## Phases And Checkpoints

### Phase 1: Overlay API And Session Model

Move pure, low-risk code out of `App.tsx`:

- broker URL constants and `postBrokerJson`
- per-session broker URL helpers
- session ordering, filtering, archive/review/attention helpers

Validation:

```powershell
cd overlay
npm run build
cd src-tauri
cargo check
cd ..\..
node --check broker/server.js
```

Expected result:

- `App.tsx` still owns UI behavior, but broker API and session model no longer live in the root file.
- No UI or broker behavior changes.

### Phase 2: Overlay Utility Windows And Cards

Move UI chunks out of `App.tsx`:

- `ScratchpadApp`
- `DeployWorkspaceApp`
- `SettingsWindowApp`
- `SessionRowContent` into `SessionCard`
- small presentational panels when props are stable

Validation:

```powershell
cd overlay
npm run build
cd src-tauri
cargo check
cd ..\..
npm run routing:verify
```

Manual smoke:

- AMO starts with `npm run amo`.
- Deploy window opens/closes.
- Settings window opens/closes.
- Scratchpad shortcut opens/copy/clear still works.
- Existing session cards can open note/canvas/app/CLI and archive/unarchive behavior remains intact.

### Phase 3: Broker Session And HTTP Modules

Move the stable support layer first:

- `lib/http.js`
- `lib/debug.js`
- `lib/session-store.js`
- `lib/target-binding.js`
- `lib/display-names.js`

Validation:

```powershell
node --check broker/server.js
npm run broker:verify
npm run adapters:verify
```

Manual smoke:

- `GET /api/health`
- `GET /api/sessions`
- archive, dismiss, review, target binding, and heartbeat routes.

### Phase 4: Broker Workspace And Artifact Modules

Move file-writing and deployment responsibilities:

- workspace inspect/enroll/git exclude/maintenance/launch
- Obsidian vault registration and plugin health
- prompt/reply note writing
- canvas append and note index
- Codex/Claude hook script generation

Validation:

```powershell
node --check broker/server.js
npm run broker:verify
npm run adapters:verify
```

Manual smoke:

- Deploy a disposable workspace.
- Launch Codex CLI and Claude CLI from AMO.
- Capture prompt/reply hooks.
- Confirm generated notes under session layout v2 and base canvas append.

### Phase 5: Obsidian Plugin Modules

Use the Obsidian Plugin Agent charter for this phase.

Move responsibilities from `plugin.ts` into existing or new plugin submodules:

- protocol open handling
- Canvas controller
- editor annotation commands
- local code links
- note title/header handling
- bridge send/copy actions

Validation:

```powershell
cd broker/assets/obsidian/md-anno-tools
npm run build
cd ../../../..
npm run broker:verify
```

Manual smoke:

- Reload or restart Obsidian.
- Open note and canvas through AMO.
- Insert, render, delete, copy, and send annotations.
- Local code links open the configured editor at the correct line.
- Canvas selected-note actions target the selected/current node, not stale state.

### Phase 6: Styles And Tauri

After component/module boundaries are stable:

- split CSS by window/component family
- split Rust modules by platform responsibility

Validation:

```powershell
cd overlay
npm run build
cd src-tauri
cargo check
cd ..\..
npm run amo
```

Manual smoke:

- Dark/light themes.
- Window resize and drag.
- Scratchpad shortcut.
- Folder picker.
- Drag-to-window binding.

## Done Criteria

- No hand-written source hotspot remains above ~800 lines without a documented reason.
- Most feature files fall in the 300-500 line range.
- `server.js`, `App.tsx`, and `plugin.ts` are orchestration roots rather than feature dumping grounds.
- Architecture/structure docs match the code tree.
- Every phase has build/test evidence before being considered complete.
- User-facing behavior remains equivalent unless a behavior change is explicitly requested.

## Progress Log

### 2026-07-07: Phase 1 Started

- Added `overlay/src/api/brokerClient.ts` for broker URL constants, session endpoint helpers, and `postBrokerJson`.
- Added `overlay/src/domain/sessionModel.ts` for session ordering, archive/review/attention, and filter logic.
- Kept `sessionMatchesSearch` in `App.tsx` for now because it still depends on UI-specific target/tool label helpers.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `node --check broker/server.js`
  - `git diff --check`

### 2026-07-07: Phase 2 Started

- Added `overlay/src/theme/amoTheme.ts` for AMO theme persistence, window broadcast, and runtime subscription.
- Added `overlay/src/native/clipboard.ts` for shared clipboard writing and CLI paste normalization.
- Added `overlay/src/windows/ScratchpadApp.tsx` and removed the scratchpad implementation from `App.tsx`.
- Kept utility-window lifecycle helpers in `App.tsx` for now because deploy/settings windows still share them.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `node --check broker/server.js`
  - `git diff --check`

### 2026-07-07: Phase 2 Workspace Model Extracted

- Added `overlay/src/domain/workspaceModel.ts` for deploy adapter state, launch availability, workspace cleanup feedback, and maintenance tone/title logic.
- Kept window positioning, fetch calls, and React state in `App.tsx`; those still belong to UI/window extraction work.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `node --check broker/server.js`
  - `git diff --check`

### 2026-07-07: Phase 2 Routing Model Extracted

- Added `overlay/src/domain/routingModel.ts` for project names, workspace/session paths, note/canvas open paths, Obsidian URI construction, short path labels, and plugin health titles.
- Kept activation candidate UI copy and window operations in `App.tsx`; those still depend on the current menu/window implementation.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `node --check broker/server.js`
  - `git diff --check`

### 2026-07-07: Phase 2 Target Routing Added

- Extended `overlay/src/domain/routingModel.ts` with tool ID detection, Codex App/CLI target construction, window target extraction, activation target selection, candidate keys, and target labels.
- Kept visual tool metadata and candidate menu copy in `App.tsx` because those still depend on UI assets and menu presentation.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `node --check broker/server.js`
  - `git diff --check`

### 2026-07-07: Phase 2 Session Card Extracted

- Added `overlay/src/components/SessionCard.tsx` for task card rendering, tool badges, launch tool marks, card actions, and card-local status labels.
- Moved `formatAgo` into `overlay/src/domain/sessionModel.ts` so the card and overlay header share the same time label helper.
- Removed the old `SessionRowContent`, tool icon map, and card-local JSX from `App.tsx`.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `node --check broker/server.js`
  - `git diff --check`

### 2026-07-07: Phase 2 Utility Boundaries Extracted

- Added `overlay/src/native/scratchpadShortcut.ts` for shortcut persistence and the native shortcut command.
- Added `overlay/src/windows/utilityWindow.ts` for utility window lifecycle, close behavior, always-on-top layering, and native-dialog layering.
- Updated `App.tsx` to consume these helpers so Settings and Deploy window extraction can share the same boundary.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `node --check broker/server.js`
  - `git diff --check`

### 2026-07-07: Phase 2 Settings Window Extracted

- Added `overlay/src/windows/SettingsWindowApp.tsx` for the standalone settings utility window.
- Exported `SettingsSidebar`, `SettingsDetail`, and `SettingsSection` from the same file so the main overlay can reuse the same settings panel without duplicating UI.
- Removed the settings sidebar/detail/window implementations from `App.tsx`.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `node --check broker/server.js`
  - `git diff --check`

### 2026-07-07: Phase 2 Standalone Deploy Window Extracted

- Added `overlay/src/windows/DeployWorkspaceApp.tsx` for the standalone deploy utility window.
- Kept the main overlay inline deploy panel in `App.tsx` for now; it will be reconciled with the standalone deploy surface in a separate checkpoint.
- Preserved deploy behavior: workspace folder selection, inspect/enroll, Git exclude, clear generated content, and launch actions still call the same broker endpoints.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `node --check broker/server.js`
  - `git diff --check`

### 2026-07-07: Phase 2 Legacy Inline Deploy Removed

- Removed the unreachable legacy inline deploy dialog from `App.tsx`; the deploy toolbar action now has a single owner, the standalone utility window.
- Removed the inline-only deploy state and actions for inspect/enroll/clear/launch from `App.tsx`.
- Kept workspace maintenance and launch-panel behavior in the main overlay because those are active task-card workflows, not deploy-window behavior.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `node --check broker/server.js`
  - `git diff --check`

### 2026-07-07: Phase 2 Legacy Inline Settings Removed

- Removed the unreachable legacy inline settings dialog from `App.tsx`; settings UI ownership is now the standalone settings utility window.
- Removed the old inline settings state, imported settings panel components, and modal resize helpers that only served legacy inline dialogs.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `node --check broker/server.js`
  - `git diff --check`

### 2026-07-07: Phase 2 Candidate Menu Extracted

- Added `overlay/src/components/CandidateMenu.tsx` for target-window selection UI and candidate display helpers.
- Kept activation, binding, Codex App, and Codex CLI resume side effects in `App.tsx` as callbacks.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `node --check broker/server.js`
  - `git diff --check`

### 2026-07-07: Phase 2 Launch Panel Extracted

- Added `overlay/src/components/LaunchPanel.tsx` for task-card project CLI launch UI.
- Kept broker launch calls and launch-panel state updates in `App.tsx`.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `node --check broker/server.js`
  - `git diff --check`

### 2026-07-07: Phase 2 Workspace Panel Extracted

- Added `overlay/src/components/WorkspacePanel.tsx` for task-card workspace maintenance UI.
- Kept broker maintenance calls, title save, cleanup confirmation, and path-opening side effects in `App.tsx`.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `node --check broker/server.js`
  - `git diff --check`

### 2026-07-07: Phase 2 Overlay Dialogs Extracted

- Added `overlay/src/components/ObsidianVaultRecoveryDialog.tsx` for vault-not-loaded recovery UI.
- Added `overlay/src/components/CleanConfirmDialog.tsx` for generated-vault cleanup confirmation UI.
- Kept path opening, clipboard writing, and cleanup broker calls in `App.tsx`.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `node --check broker/server.js`
  - `git diff --check`

### 2026-07-07: Phase 3 Broker Support Modules Started

- Added `broker/lib/http.js` for JSON body parsing, CORS response helpers, and HTTP errors.
- Added `broker/lib/debug.js` for bounded debug logs, debug config/status, remote debug logs, and compact message previews.
- Added `broker/lib/display-names.js` for Codex/Claude session display-name cache lookup.
- Kept route ownership, session mutation, workspace/artifact writes, hook generation, and Obsidian/Canvas behavior in `broker/server.js`.
- Validation passed:
  - `node --check broker/server.js`
  - `node --check broker/lib/http.js`
  - `node --check broker/lib/debug.js`
  - `node --check broker/lib/display-names.js`
  - `powershell -ExecutionPolicy Bypass -File scripts/broker/verify.ps1 -Port 17665`
  - `powershell -ExecutionPolicy Bypass -File scripts/adapters/verify.ps1 -Port 17666`
  - `git diff --check`

### 2026-07-07: Phase 3 Broker Filesystem Helpers Extracted

- Added `broker/lib/filesystem.js` for workspace path resolution, directory checks, Git root detection, safe path bounds, JSON/text file IO, and atomic writes.
- Kept workspace/git-exclude planning, deployment, artifact writes, and Canvas behavior in `broker/server.js`.
- Validation passed:
  - `node --check broker/server.js`
  - `node --check broker/lib/filesystem.js`
  - `powershell -ExecutionPolicy Bypass -File scripts/broker/verify.ps1 -Port 17667`
  - `powershell -ExecutionPolicy Bypass -File scripts/adapters/verify.ps1 -Port 17668`
  - `git diff --check`

### 2026-07-07: Phase 3 Broker Hook Generators Extracted

- Added `broker/hooks/codex.js` and `broker/hooks/claude.js` for adapter event lists and generated hook script text.
- Kept hook deployment, settings merge, workspace enrollment, and route ownership in `broker/server.js`.
- `broker/server.js` now passes deployment/protocol versions into the hook generators explicitly.
- Validation passed:
  - `node --check broker/server.js`
  - `node --check broker/lib/http.js`
  - `node --check broker/lib/debug.js`
  - `node --check broker/lib/display-names.js`
  - `node --check broker/lib/filesystem.js`
  - `node --check broker/hooks/codex.js`
  - `node --check broker/hooks/claude.js`
  - `powershell -ExecutionPolicy Bypass -File scripts/broker/verify.ps1 -Port 17669`
  - `powershell -ExecutionPolicy Bypass -File scripts/adapters/verify.ps1 -Port 17670`
  - `git diff --check`

### 2026-07-07: Phase 3 Broker Hook Config Merge Extracted

- Moved Codex `.codex/hooks.json` merge logic into `broker/hooks/codex.js`.
- Moved Claude `.claude/settings.local.json` merge logic into `broker/hooks/claude.js`.
- Kept workspace enrollment orchestration in `broker/server.js`; hook modules now own adapter-specific script generation and config merge behavior.
- Validation passed:
  - `node --check broker/server.js`
  - `node --check broker/lib/http.js`
  - `node --check broker/lib/debug.js`
  - `node --check broker/lib/display-names.js`
  - `node --check broker/lib/filesystem.js`
  - `node --check broker/hooks/codex.js`
  - `node --check broker/hooks/claude.js`
  - `powershell -ExecutionPolicy Bypass -File scripts/broker/verify.ps1 -Port 17671`
  - `powershell -ExecutionPolicy Bypass -File scripts/adapters/verify.ps1 -Port 17672`
  - `git diff --check`

### 2026-07-07: Phase 3 Broker Normalize Helpers Extracted

- Added `broker/lib/normalize.js` for shared text, text-array, integer, and version normalization.
- Removed the duplicated utility definitions from `broker/server.js` while preserving the existing `null`-for-empty text semantics.
- Validation passed:
  - `node --check broker/server.js`
  - `node --check broker/lib/http.js`
  - `node --check broker/lib/debug.js`
  - `node --check broker/lib/display-names.js`
  - `node --check broker/lib/filesystem.js`
  - `node --check broker/lib/normalize.js`
  - `node --check broker/hooks/codex.js`
  - `node --check broker/hooks/claude.js`
  - `powershell -ExecutionPolicy Bypass -File scripts/broker/verify.ps1 -Port 17673`
  - `powershell -ExecutionPolicy Bypass -File scripts/adapters/verify.ps1 -Port 17674`
  - `git diff --check`

### 2026-07-07: Phase 3 Broker Target Binding Extracted

- Added `broker/lib/target-binding.js` for window, Codex CLI session, and Codex App thread target binding rules.
- Moved default hook target binding, window-hint normalization, and candidate-menu window identity clearing out of `broker/server.js`.
- Kept route handlers and session mutation in `broker/server.js`.
- Validation passed:
  - `node --check broker/server.js`
  - `node --check broker/lib/http.js`
  - `node --check broker/lib/debug.js`
  - `node --check broker/lib/display-names.js`
  - `node --check broker/lib/filesystem.js`
  - `node --check broker/lib/normalize.js`
  - `node --check broker/lib/target-binding.js`
  - `node --check broker/hooks/codex.js`
  - `node --check broker/hooks/claude.js`
  - `powershell -ExecutionPolicy Bypass -File scripts/broker/verify.ps1 -Port 17675`
  - `powershell -ExecutionPolicy Bypass -File scripts/adapters/verify.ps1 -Port 17676`
  - `git diff --check`

### 2026-07-07: Phase 4 Workspace Git Exclude Extracted

- Added `broker/lib/workspace-git-exclude.js` for Git root detection, AMO exclude pattern planning, and tracked-file checks.
- Kept the `/api/workspaces/git-exclude` route and file write orchestration in `broker/server.js`.
- Validation passed:
  - `node --check broker/server.js`
  - `node --check broker/lib/http.js`
  - `node --check broker/lib/debug.js`
  - `node --check broker/lib/display-names.js`
  - `node --check broker/lib/filesystem.js`
  - `node --check broker/lib/normalize.js`
  - `node --check broker/lib/target-binding.js`
  - `node --check broker/lib/workspace-git-exclude.js`
  - `node --check broker/hooks/codex.js`
  - `node --check broker/hooks/claude.js`
  - `powershell -ExecutionPolicy Bypass -File scripts/broker/verify.ps1 -Port 17677`
  - `powershell -ExecutionPolicy Bypass -File scripts/adapters/verify.ps1 -Port 17678`
  - `git diff --check`

### 2026-07-07: Phase 4 Obsidian Vault Helpers Extracted

- Added `broker/lib/obsidian-vault.js` for Obsidian vault registry writes, runtime-state evidence, process counting, vault IDs, and comparable paths.
- Kept HTTP payload validation and debug logging for `/api/obsidian/register-vault` in `broker/server.js`.
- Validation passed:
  - `node --check broker/server.js`
  - `node --check broker/lib/http.js`
  - `node --check broker/lib/debug.js`
  - `node --check broker/lib/display-names.js`
  - `node --check broker/lib/filesystem.js`
  - `node --check broker/lib/normalize.js`
  - `node --check broker/lib/obsidian-vault.js`
  - `node --check broker/lib/target-binding.js`
  - `node --check broker/lib/workspace-git-exclude.js`
  - `node --check broker/hooks/codex.js`
  - `node --check broker/hooks/claude.js`
  - `powershell -ExecutionPolicy Bypass -File scripts/broker/verify.ps1 -Port 17679`
  - `powershell -ExecutionPolicy Bypass -File scripts/adapters/verify.ps1 -Port 17680`
  - `git diff --check`

### 2026-07-07: Phase 4 Obsidian Plugin Install And Health Extracted

- Moved Obsidian plugin asset copy, community-plugin enabling, plugin data defaults, plugin health checks, and session health decoration into `broker/lib/obsidian-vault.js`.
- `broker/server.js` now passes the active broker bridge URL into install/health helpers explicitly.
- Kept workspace enrollment, workspace status, and session list orchestration in `broker/server.js`.
- Validation passed:
  - `node --check broker/server.js`
  - `node --check broker/lib/http.js`
  - `node --check broker/lib/debug.js`
  - `node --check broker/lib/display-names.js`
  - `node --check broker/lib/filesystem.js`
  - `node --check broker/lib/normalize.js`
  - `node --check broker/lib/obsidian-vault.js`
  - `node --check broker/lib/target-binding.js`
  - `node --check broker/lib/workspace-git-exclude.js`
  - `node --check broker/hooks/codex.js`
  - `node --check broker/hooks/claude.js`
  - `powershell -ExecutionPolicy Bypass -File scripts/broker/verify.ps1 -Port 17681`
  - `powershell -ExecutionPolicy Bypass -File scripts/adapters/verify.ps1 -Port 17682`
  - `git diff --check`

### 2026-07-07: Phase 4 Terminal Launch Helpers Extracted

- Added `broker/lib/terminal-launch.js` for Windows Terminal / PowerShell launch command construction and detached process spawning.
- Kept workspace launch validation, session target binding, and launch response shaping in `broker/server.js`.
- Validation passed:
  - `node --check broker/server.js`
  - `node --check broker/lib/http.js`
  - `node --check broker/lib/debug.js`
  - `node --check broker/lib/display-names.js`
  - `node --check broker/lib/filesystem.js`
  - `node --check broker/lib/normalize.js`
  - `node --check broker/lib/obsidian-vault.js`
  - `node --check broker/lib/target-binding.js`
  - `node --check broker/lib/terminal-launch.js`
  - `node --check broker/lib/workspace-git-exclude.js`
  - `node --check broker/hooks/codex.js`
  - `node --check broker/hooks/claude.js`
  - `powershell -ExecutionPolicy Bypass -File scripts/broker/verify.ps1 -Port 17683`
  - `powershell -ExecutionPolicy Bypass -File scripts/adapters/verify.ps1 -Port 17684`
  - `git diff --check`

### 2026-07-07: Phase 4 Text Formatting Helpers Extracted

- Added `broker/lib/text-format.js` for note display titles, safe filename fragments, Obsidian filename fragments, and short message previews.
- Removed unused legacy `uniquePath`, `yamlString`, and `fileSafeTimestamp` helpers from `broker/server.js`.
- Validation passed:
  - `node --check broker/server.js`
  - `node --check broker/lib/http.js`
  - `node --check broker/lib/debug.js`
  - `node --check broker/lib/display-names.js`
  - `node --check broker/lib/filesystem.js`
  - `node --check broker/lib/normalize.js`
  - `node --check broker/lib/obsidian-vault.js`
  - `node --check broker/lib/target-binding.js`
  - `node --check broker/lib/terminal-launch.js`
  - `node --check broker/lib/text-format.js`
  - `node --check broker/lib/workspace-git-exclude.js`
  - `node --check broker/hooks/codex.js`
  - `node --check broker/hooks/claude.js`
  - `powershell -ExecutionPolicy Bypass -File scripts/broker/verify.ps1 -Port 17685`
  - `powershell -ExecutionPolicy Bypass -File scripts/adapters/verify.ps1 -Port 17686`
  - `git diff --check`

### 2026-07-07: Phase 4 AMO Constants Extracted

- Added `broker/lib/amo-constants.js` for AMO version, layout, vault, canvas, and Obsidian plugin constants.
- Updated `broker/server.js` and `broker/lib/obsidian-vault.js` to share the same plugin/layout constants.
- Validation passed:
  - `node --check broker/server.js`
  - `node --check broker/lib/amo-constants.js`
  - `node --check broker/lib/http.js`
  - `node --check broker/lib/debug.js`
  - `node --check broker/lib/display-names.js`
  - `node --check broker/lib/filesystem.js`
  - `node --check broker/lib/normalize.js`
  - `node --check broker/lib/obsidian-vault.js`
  - `node --check broker/lib/target-binding.js`
  - `node --check broker/lib/terminal-launch.js`
  - `node --check broker/lib/text-format.js`
  - `node --check broker/lib/workspace-git-exclude.js`
  - `node --check broker/hooks/codex.js`
  - `node --check broker/hooks/claude.js`
  - `powershell -ExecutionPolicy Bypass -File scripts/broker/verify.ps1 -Port 17687`
  - `powershell -ExecutionPolicy Bypass -File scripts/adapters/verify.ps1 -Port 17688`
  - `git diff --check`

### 2026-07-07: Phase 4 Canvas Writer Extracted

- Added `broker/lib/canvas-writer.js` for AgentFlow base canvas creation, AMO canvas metadata, edge normalization, conversation-node append, append direction, and canvas note-title sync.
- Kept prompt/reply route orchestration and note/index/manifest writing in `broker/server.js` for the next conversation-artifact extraction.
- Validation passed:
  - `node --check broker/server.js`
  - `node --check broker/lib/amo-constants.js`
  - `node --check broker/lib/canvas-writer.js`
  - `node --check broker/lib/http.js`
  - `node --check broker/lib/debug.js`
  - `node --check broker/lib/display-names.js`
  - `node --check broker/lib/filesystem.js`
  - `node --check broker/lib/normalize.js`
  - `node --check broker/lib/obsidian-vault.js`
  - `node --check broker/lib/target-binding.js`
  - `node --check broker/lib/terminal-launch.js`
  - `node --check broker/lib/text-format.js`
  - `node --check broker/lib/workspace-git-exclude.js`
  - `node --check broker/hooks/codex.js`
  - `node --check broker/hooks/claude.js`
  - `powershell -ExecutionPolicy Bypass -File scripts/broker/verify.ps1 -Port 17689`
  - `powershell -ExecutionPolicy Bypass -File scripts/adapters/verify.ps1 -Port 17690`
  - `git diff --check`

### 2026-07-07: Phase 4 Conversation Artifacts Extracted

- Added `broker/lib/conversation-artifacts.js` for prompt/reply generated note writing, AMO note markers, note index updates, note sequencing, and session manifests.
- Kept prompt/reply HTTP payload validation, session mutation, duplicate prompt handling, and debug logging in `broker/server.js`.
- Validation passed:
  - `node --check broker/server.js`
  - `node --check broker/lib/amo-constants.js`
  - `node --check broker/lib/canvas-writer.js`
  - `node --check broker/lib/conversation-artifacts.js`
  - `node --check broker/lib/http.js`
  - `node --check broker/lib/debug.js`
  - `node --check broker/lib/display-names.js`
  - `node --check broker/lib/filesystem.js`
  - `node --check broker/lib/normalize.js`
  - `node --check broker/lib/obsidian-vault.js`
  - `node --check broker/lib/target-binding.js`
  - `node --check broker/lib/terminal-launch.js`
  - `node --check broker/lib/text-format.js`
  - `node --check broker/lib/workspace-git-exclude.js`
  - `node --check broker/hooks/codex.js`
  - `node --check broker/hooks/claude.js`
  - `powershell -ExecutionPolicy Bypass -File scripts/broker/verify.ps1 -Port 17691`
  - `powershell -ExecutionPolicy Bypass -File scripts/adapters/verify.ps1 -Port 17692`
  - `git diff --check`

### 2026-07-07: Phase 2 Broker Readiness Panel Extracted

- Added `overlay/src/components/BrokerReadinessPanel.tsx` for broker readiness state labels and retry UI.
- Kept broker readiness probing and state updates in `overlay/src/App.tsx`.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `git diff --check`

### 2026-07-07: Phase 2 Overlay Session UI Helpers Extracted

- Added `overlay/src/domain/overlaySessionUi.ts` for Codex action-required probing and floating menu/panel positioning.
- Kept activation, binding, and panel state transitions in `overlay/src/App.tsx`.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `git diff --check`

### 2026-07-07: Phase 2 Deploy Workspace Panels Extracted

- Added `overlay/src/components/DeployWorkspaceSections.tsx` for the deploy window's workspace, Git exclude, adapter, and deployment-result panels.
- Kept broker calls, busy states, native folder picking, debug logging, and feedback ownership in `overlay/src/windows/DeployWorkspaceApp.tsx`.
- Reduced `DeployWorkspaceApp.tsx` from 724 lines to 479 lines while keeping the new panel file at 400 lines.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `git diff --check`

### 2026-07-07: Phase 3 Obsidian Local Code Links Extracted

- Added `broker/assets/obsidian/md-anno-tools/src/editor/local-code-links.ts` for Windows path detection, Markdown link hit-testing, VS Code/custom URL formatting, Zed CLI launch, and rendered local-code-link anchors.
- Kept Obsidian event wiring, suppression timing, debug logging, and operation status in `plugin.ts`.
- Reduced `plugin.ts` from 2828 lines to 2635 lines; rebuilt the tracked Obsidian `main.js` bundle.
- Validation passed:
  - `cd broker/assets/obsidian/md-anno-tools; npm run build`
  - `git diff --check`

### 2026-07-07: Phase 3 Obsidian Note Title Helpers Extracted

- Added `broker/assets/obsidian/md-anno-tools/src/note/title.ts` for AMO metadata checks, note display names, source-mode title header DOM, and first content line detection.
- Kept note file reads/writes, bridge title sync, property class toggles, and panel refresh ownership in `plugin.ts`.
- Reduced `plugin.ts` from 2635 lines to 2534 lines; rebuilt the tracked Obsidian `main.js` bundle.
- Validation passed:
  - `cd broker/assets/obsidian/md-anno-tools; npm run build`
  - `git diff --check`

### 2026-07-07: Phase 3 Obsidian Inline Render Helpers Extracted

- Moved inline annotation token replacement and local-code-link linkification into `broker/assets/obsidian/md-anno-tools/src/annotations/render.ts` alongside legacy annotation section rendering.
- Kept postprocessor orchestration, debug logging, file reads, and plugin settings checks in `plugin.ts`.
- Reduced `plugin.ts` from 2534 lines to 2434 lines while keeping `annotations/render.ts` at 322 lines; rebuilt the tracked Obsidian `main.js` bundle.
- Validation passed:
  - `cd broker/assets/obsidian/md-anno-tools; npm run build`
  - `git diff --check`

### 2026-07-07: Phase 3 Obsidian Canvas Navigation Helpers Extracted

- Added `broker/assets/obsidian/md-anno-tools/src/canvas/navigation.ts` for Canvas latest-note marking, node element lookup, selection cleanup helpers, centering, bounds, and zoom helpers.
- Kept Canvas focus orchestration, AMO marker checks, toolbar wiring, and debug-aware `safeCanvasCall` ownership in `plugin.ts`.
- Reduced `plugin.ts` from 2434 lines to 2262 lines while keeping `canvas/navigation.ts` at 176 lines; rebuilt the tracked Obsidian `main.js` bundle.
- Validation passed:
  - `cd broker/assets/obsidian/md-anno-tools; npm run build`
  - `git diff --check`

### 2026-07-07: Phase 3 Obsidian Local Code Link Controller Extracted

- Added `broker/assets/obsidian/md-anno-tools/src/editor/local-code-link-controller.ts` for document/editor link events, follow-up suppression, settings refresh, and open-result status.
- Kept plugin load-time event registration in `plugin.ts`, with parsing/open primitives still in `editor/local-code-links.ts`.
- Reduced `plugin.ts` from 2262 lines to 2113 lines; rebuilt the tracked Obsidian `main.js` bundle.
- Validation passed:
  - `cd broker/assets/obsidian/md-anno-tools; npm run build`
  - `git diff --check`

### 2026-07-07: Phase 3 Obsidian AMO Open Protocol Extracted

- Added `broker/assets/obsidian/md-anno-tools/src/protocol/amo-open.ts` for `obsidian://amo-open` path resolution, tab reuse, new-tab opening, and canvas focus-note follow-up.
- Kept `plugin.openVaultPath()` as a public wrapper for panel/command callers and kept Canvas focus implementation in `plugin.ts`.
- Reduced `plugin.ts` from 2113 lines to 1996 lines; rebuilt the tracked Obsidian `main.js` bundle.
- Validation passed:
  - `cd broker/assets/obsidian/md-anno-tools; npm run build`
  - `git diff --check`

### 2026-07-07: Phase 5 Tauri Models Extracted

- Added `overlay/src-tauri/src/models.rs` for serializable command responses, scratchpad shortcut config, scratchpad trigger data, window candidates, and activation hints.
- Kept Tauri command functions and native platform implementations in `lib.rs`.
- Reduced `lib.rs` from 1524 lines to 1443 lines while keeping `models.rs` at 85 lines.
- Validation passed:
  - `cd overlay/src-tauri; cargo check`
  - `git diff --check`

### 2026-07-07: Phase 5 Tauri Broker Startup Extracted

- Added `overlay/src-tauri/src/broker.rs` for broker health probing, `broker/server.js` discovery, Node process launch, and debug-window visibility handling.
- Kept the Tauri `ensure_broker` command wrapper in `lib.rs`.
- Reduced `lib.rs` from 1443 lines to 1281 lines while keeping `broker.rs` at 166 lines.
- Validation passed:
  - `cd overlay/src-tauri; cargo check`
  - `git diff --check`

### 2026-07-07: Phase 5 Tauri Dialogs Extracted

- Added `overlay/src-tauri/src/dialogs.rs` for the workspace folder picker and Windows COM folder dialog implementation.
- Kept the Tauri `select_workspace_directory` command wrapper in `lib.rs`.
- Reduced `lib.rs` from 1281 lines to 1171 lines while keeping `dialogs.rs` at 113 lines.
- Validation passed:
  - `cd overlay/src-tauri; cargo check`
  - `git diff --check`

### 2026-07-07: Phase 5 Tauri Clipboard Extracted

- Added `overlay/src-tauri/src/clipboard.rs` for native clipboard writing and CRLF normalization.
- Kept the Tauri `write_clipboard_text` command wrapper in `lib.rs`.
- Reduced `lib.rs` from 1171 lines to 1090 lines while keeping `clipboard.rs` at 84 lines.
- Validation passed:
  - `cd overlay/src-tauri; cargo check`
  - `git diff --check`

### 2026-07-07: Phase 5 Tauri Opener Extracted

- Added `overlay/src-tauri/src/opener.rs` for local path opening, external target launch, and Windows `ShellExecuteW` helpers.
- Kept the Tauri `open_path` and `open_uri` command wrappers in `lib.rs`.
- Reduced `lib.rs` from 1090 lines to 1012 lines while keeping `opener.rs` at 81 lines.
- Validation passed:
  - `cd overlay/src-tauri; cargo check`
  - `git diff --check`

### 2026-07-07: Phase 5 Tauri Scratchpad Extracted

- Added `overlay/src-tauri/src/scratchpad.rs` for the global mouse hook, scratchpad shortcut state, copy-request event, and cursor-relative scratchpad placement.
- Kept the Tauri `set_scratchpad_shortcut_config` and `show_scratchpad_at_cursor` command wrappers in `lib.rs`.
- Reduced `lib.rs` from 1012 lines to 801 lines while keeping `scratchpad.rs` at 222 lines.
- Validation passed:
  - `cd overlay/src-tauri; cargo check`
  - `git diff --check`

### 2026-07-07: Phase 5 Tauri Window Activation Extracted

- Added `overlay/src-tauri/src/windows.rs` for external window enumeration, activation, cursor picking, target hint matching, and fallback candidate selection.
- Kept the Tauri `activate_session_window`, `list_session_window_candidates`, and `window_candidate_at_cursor` command wrappers in `lib.rs`.
- Reduced `lib.rs` from 801 lines to 144 lines while keeping `windows.rs` at 673 lines.
- Validation passed:
  - `cd overlay/src-tauri; cargo check`
  - `git diff --check`

### 2026-07-07: Phase 6 Overlay CSS Split

- Split `overlay/src/styles.css` into feature-scoped files under `overlay/src/styles/`, preserving the original cascade order through import-only `styles.css`.
- Kept each CSS slice between 167 and 450 lines: shell, overlay header, deploy, session list/card, candidate menu, settings, workspace panels, dialogs/resize, and light-theme slices.
- Validation passed:
  - `cd overlay; npm run build`
  - `git diff --check`

### 2026-07-09: Broker Session Store Extracted

- Added `broker/lib/session-store.js` for the session map, snapshot load/persist, event upsert, heartbeat updates, archive/dismiss/review/attention state mutations, session listing, and state normalization.
- Kept HTTP routing and conversation artifact workflows in `broker/server.js`; the new store accepts a prompt-event handler so `UserPromptSubmit` still records prompt notes through the existing `handlePrompt` path.
- Reduced `broker/server.js` from about 2952 lines to about 2445 lines while keeping `session-store.js` at about 580 lines.
- Validation passed:
  - `node --check broker/server.js`
  - `node --check broker/lib/session-store.js`
  - `powershell -ExecutionPolicy Bypass -File scripts/broker/verify.ps1 -Port 17695`
  - `powershell -ExecutionPolicy Bypass -File scripts/adapters/verify.ps1 -Port 17696`
  - `git diff --check`

### 2026-07-09: Broker Workspace Inspect/Deploy Extracted

- Added `broker/lib/workspace-inspect.js` for vault-root planning, workspace state detection, adapter deployment coverage, deployability plans, and workspace IDs.
- Added `broker/lib/workspace-deploy.js` for workspace enrollment, adapter metadata writes, generated hook script install, Codex/Claude config merges, AMO vault creation, plugin install, and `.amo/.gitignore`.
- Kept workspace maintenance, Git exclude update, launch, generated note/canvas workflows, and Obsidian bridge routes in `broker/server.js` for the next broker subphases.
- Reduced `broker/server.js` from about 2445 lines to about 1891 lines while keeping `workspace-inspect.js` at about 372 lines and `workspace-deploy.js` at about 253 lines.
- Validation passed:
  - `node --check broker/server.js`
  - `node --check broker/lib/workspace-inspect.js`
  - `node --check broker/lib/workspace-deploy.js`
  - `powershell -ExecutionPolicy Bypass -File scripts/broker/verify.ps1 -Port 17697`
  - `powershell -ExecutionPolicy Bypass -File scripts/adapters/verify.ps1 -Port 17698`
  - `git diff --check`

### 2026-07-09: Broker Workspace Maintenance/Launch Extracted

- Completed `broker/lib/workspace-git-exclude.js` by moving the Git exclude update/write route logic next to the existing inspect/plan helpers.
- Added `broker/lib/workspace-launch.js` for workspace CLI/App launch, Codex CLI resume title routing, and launch-time Codex CLI target binding.
- Added `broker/lib/workspace-maintenance.js` for maintenance snapshots, vault cleanup, plugin update, Canvas inspection, generated note counts, and workspace cleanup bridge-state resets.
- Kept route parsing, persistence calls, publish calls, prompt/reply artifact orchestration, and Obsidian bridge routes in `broker/server.js`.
- Reduced `broker/server.js` from about 1891 lines to about 1339 lines while keeping the new workspace modules between about 184 and 361 lines.
- Validation passed:
  - `node --check broker/server.js`
  - `node --check broker/lib/workspace-git-exclude.js`
  - `node --check broker/lib/workspace-launch.js`
  - `node --check broker/lib/workspace-maintenance.js`
  - `powershell -ExecutionPolicy Bypass -File scripts/broker/verify.ps1 -Port 17699`
  - `powershell -ExecutionPolicy Bypass -File scripts/adapters/verify.ps1 -Port 17700`
  - `git diff --check`

### 2026-07-09: Broker Conversation And Obsidian Bridge Extracted

- Added `broker/lib/conversation-service.js` for prompt/reply note and canvas orchestration, enrolled workspace resolution, duplicate prompt handling, and session updates around prompt/reply records.
- Added `broker/lib/obsidian-bridge.js` for Obsidian annotations, sync-back, note title updates, vault registration, and recovered annotation sessions.
- Added `broker/lib/pending-prompts.js` for annotation normalization, annotation numbering, pending prompt rendering, prompt content hashes, and duplicate prompt detection.
- Rewired `broker/lib/session-store.js` through `setPromptEventHandler()` so `UserPromptSubmit` still records prompt notes through the same conversation service.
- Reduced `broker/server.js` from about 1339 lines to about 612 lines while keeping `conversation-service.js` at about 401 lines, `obsidian-bridge.js` at about 328 lines, and `pending-prompts.js` at about 90 lines.
- Validation passed:
  - `node --check broker/server.js`
  - `node --check broker/lib/conversation-service.js`
  - `node --check broker/lib/obsidian-bridge.js`
  - `node --check broker/lib/pending-prompts.js`
  - `powershell -ExecutionPolicy Bypass -File scripts/broker/verify.ps1 -Port 17703`
  - `powershell -ExecutionPolicy Bypass -File scripts/adapters/verify.ps1 -Port 17704`
  - `git diff --check`

### 2026-07-09: Broker Route Modules Extracted

- Added `broker/routes/config.js` for health and debug routes.
- Added `broker/routes/sessions.js` for session listing, SSE handoff, review/archive/dismiss/attention, heartbeat, and target/window binding routes.
- Added `broker/routes/workspaces.js` for workspace inspect/enroll/git-exclude/launch/status/clean/plugin-update routes.
- Added `broker/routes/obsidian.js` for hook event intake, prompt/reply routes, Obsidian annotation/title/vault/sync-back routes.
- Kept native HTTP bootstrap, route dispatch, SSE publishing, and the remaining session target/window binding helper implementations in `broker/server.js`.
- Reduced `broker/server.js` from about 612 lines to about 450 lines; route modules are between about 39 and 116 lines.
- Validation passed:
  - `node --check broker/server.js`
  - `node --check broker/routes/config.js`
  - `node --check broker/routes/sessions.js`
  - `node --check broker/routes/workspaces.js`
  - `node --check broker/routes/obsidian.js`
  - `powershell -ExecutionPolicy Bypass -File scripts/broker/verify.ps1 -Port 17705`
  - `powershell -ExecutionPolicy Bypass -File scripts/adapters/verify.ps1 -Port 17706`
  - `git diff --check`

### 2026-07-09: Overlay Main Window Extracted

- Added `overlay/src/windows/MainOverlayApp.tsx` and moved the existing main overlay monitor branch there without changing its internal state/action structure.
- Reduced `overlay/src/App.tsx` to a thin Tauri webview switch root for scratchpad, deploy, settings, and main overlay windows.
- Kept the intentionally large `MainOverlayApp.tsx` as the next overlay owner for hook/controller extraction.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `git diff --check`

### 2026-07-09: Overlay Broker Sessions Hook Extracted

- Added `overlay/src/hooks/useBrokerSessions.ts` for broker startup refresh, session polling, SSE updates, broker readiness, feedback text, last-refresh time, and session/order state.
- Kept Codex action-required probing and pending-prompt auto-copy behavior in `MainOverlayApp.tsx` as callbacks because they still depend on activation and target behavior.
- Reduced `MainOverlayApp.tsx` from about 2818 lines to about 2599 lines while keeping `useBrokerSessions.ts` at about 273 lines.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `git diff --check`

### 2026-07-09: Overlay Session Actions Hook Extracted

- Added `overlay/src/hooks/useSessionActions.ts` for review/seen, permission-attention clear, target unbind, archive, and dismiss broker actions.
- Kept target activation, candidate selection, Obsidian open, workspace maintenance, drag, and resize behavior in `MainOverlayApp.tsx` for later subphases.
- Reduced `MainOverlayApp.tsx` from about 2813 lines to about 2618 lines while keeping `useSessionActions.ts` at about 255 lines.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `git diff --check`

### 2026-07-09: Overlay Target Activation Hook Extracted

- Added `overlay/src/hooks/useTargetActivation.ts` for Codex App target open, Codex CLI resume launch, candidate-window listing/activation, explicit target binding, and drag-to-window cursor binding.
- Kept pointer drag lifecycle, pending-prompt copy, Obsidian open, workspace maintenance, card reorder, and resize behavior in `MainOverlayApp.tsx` for later subphases.
- Reduced `MainOverlayApp.tsx` from about 2618 lines to about 2203 lines while keeping `useTargetActivation.ts` at about 502 lines.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `git diff --check`

### 2026-07-09: Overlay Obsidian Open Hook Extracted

- Added `overlay/src/hooks/useObsidianOpen.ts` for note/canvas open, AMO vault runtime bootstrap checks, vault-not-loaded recovery dialog state, recovery folder open, and recovery path copy.
- Kept pending-prompt copy, workspace maintenance, pointer drag lifecycle, card reorder, and resize behavior in `MainOverlayApp.tsx` for later subphases.
- Reduced `MainOverlayApp.tsx` from about 2203 lines to about 1990 lines while keeping `useObsidianOpen.ts` at about 266 lines.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `git diff --check`

### 2026-07-09: Overlay Workspace Panels Hook Extracted

- Added `overlay/src/hooks/useWorkspacePanels.ts` for task-card workspace status, plugin update, generated-vault clean confirmation, task title save, maintenance path open, launch-panel inspect, and project CLI launch actions.
- Kept the panel state itself in `MainOverlayApp.tsx` for now because `useBrokerSessions.ts` also clears those panels during session reconciliation; this avoids a refactor-only state ordering change.
- Reduced `MainOverlayApp.tsx` from about 1990 lines to about 1629 lines while keeping `useWorkspacePanels.ts` at about 418 lines.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `git diff --check`

### 2026-07-09: Overlay Pointer Hooks Extracted

- Added `overlay/src/hooks/useCardDrag.ts` for task-card reorder state, drop target calculation, and card drag listener cleanup.
- Added `overlay/src/hooks/useWindowBindDrag.ts` for drag-to-window binding state, cursor tracking, target-card lookup, and listener cleanup.
- Added `overlay/src/hooks/useOverlayResize.ts` for overlay resize edge/corner pointer state and native window resizing.
- Reduced `MainOverlayApp.tsx` from about 1629 lines to about 1295 lines while keeping the new pointer hooks between about 88 and 213 lines.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `git diff --check`

### 2026-07-09: Overlay Utility Window Hook Extracted

- Added `overlay/src/hooks/useMainUtilityWindows.ts` for deploy/settings utility-window open, focus, hide, visibility sync, and main-window blocker state.
- Kept scratchpad shortcut actions and collapse behavior in `MainOverlayApp.tsx` because those are main-window header controls rather than utility-window lifecycle.
- Reduced `MainOverlayApp.tsx` from about 1295 lines to about 1192 lines while keeping `useMainUtilityWindows.ts` at about 128 lines.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `git diff --check`

### 2026-07-09: Overlay Attention Visuals Hook Extracted

- Added `overlay/src/hooks/useAttentionVisuals.ts` for attention seen-state, animation clock, visual activity checks, and taskbar review attention request/clear behavior.
- Kept debug logging functions in `MainOverlayApp.tsx` because broker startup/session polling still depends on `postDebugLog` during hook initialization.
- Reduced `MainOverlayApp.tsx` from about 1192 lines to about 1066 lines while keeping `useAttentionVisuals.ts` at about 160 lines.
- Validation passed:
  - `cd overlay; npm run build`
  - `cd overlay/src-tauri; cargo check`
  - `git diff --check`
