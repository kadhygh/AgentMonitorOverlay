# AMO Refactor Plan

Updated: 2026-07-07

This plan turns the current working MVP into a maintainable project without changing product behavior as part of the refactor itself.

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
| `overlay/src/App.tsx` | ~5900 lines | Main overlay, utility windows, broker API, session model, drag/drop, Obsidian opening, debug, deploy, settings, and card UI are in one closure. |
| `broker/server.js` | ~5300 lines | HTTP routing, session state, workspace deployment, hook script generation, Obsidian vault/note/canvas writes, debug, launch, and title indexes are coupled. |
| `overlay/src/styles.css` | ~3800 lines | Styling follows feature growth but no longer mirrors component boundaries. |
| `broker/assets/obsidian/md-anno-tools/src/plugin.ts` | ~2500 lines | Plugin lifecycle, Canvas coordination, editor commands, annotation operations, title rendering, and local code links remain concentrated. |
| `overlay/src-tauri/src/lib.rs` | ~1300 lines | Windows APIs, scratchpad, clipboard, broker launch, directory dialogs, and window activation are together. This is lower priority than the JS/TS files. |

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
