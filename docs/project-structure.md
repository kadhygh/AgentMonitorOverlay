# AMO Project Structure

Updated: 2026-07-07

This document records the intended ownership boundaries for the Agent Monitor Overlay repository. Keep it updated when code moves.

## Product Boundaries

AMO has four runtime surfaces:

- Overlay: the lightweight monitor, task card surface, deployment entry, settings UI, scratchpad, and window jump surface.
- Broker: the local HTTP bridge and durable state owner for hooks, sessions, workspace enrollment, generated notes, canvas writes, and sync-back.
- Obsidian plugin: the vault-native reading, annotation, note/canvas tab reuse, selected-note actions, and future human workflow surface.
- Tauri shell: Windows integration for native windows, clipboard, directory picker, scratchpad shortcut, and broker startup.

The broker is the source of truth for AMO workspace/session state. Obsidian and Canvas are workflow surfaces, not the primary state model.

## Source Ownership

### `overlay/src`

Expected ownership after refactor:

- `api/`: broker HTTP client constants and helpers. No React state.
- `domain/`: pure UI-domain logic such as session filtering, ordering, attention, workspace status, and routing labels. No Tauri calls and no DOM calls.
- `components/`: reusable presentational UI. Components receive props and callbacks; they do not fetch broker state directly.
- `windows/`: top-level Tauri webview apps such as main overlay, deploy, settings, and scratchpad.
- `theme/`: theme persistence and broadcast helpers.
- `types.ts`: shared TypeScript contracts that mirror broker/plugin payloads.

### `broker`

Expected ownership after refactor:

- `server.js`: native HTTP server bootstrap and route table.
- `lib/http.js`: request/response helpers.
- `lib/debug.js`: bounded debug log and debug status.
- `lib/session-store.js`: session map, snapshot load/persist, archive/dismiss/review/attention, list sessions.
- `lib/normalize.js`: shared payload normalization helpers.
- `lib/target-binding.js`: window, Codex CLI, and Codex App target binding normalization.
- `lib/workspace-*.js`: workspace inspection, deployment, maintenance, git exclude, and launch.
- `lib/obsidian-vault.js`: vault registry, runtime state, plugin install/health.
- `lib/conversation-artifacts.js`: prompt/reply notes, note index, session layout v2 files.
- `lib/canvas-writer.js`: JSON Canvas append and metadata. Must not depend on Obsidian live DOM.
- `hooks/*.js`: generated hook script text and hook metadata.

### `broker/assets/obsidian/md-anno-tools/src`

Expected ownership after refactor:

- `plugin.ts`: lifecycle, commands, event registration, module wiring.
- `protocol/`: `obsidian://amo-open` and related protocol handling.
- `bridge/`: broker calls and send/copy/check actions.
- `canvas/`: selected-note discovery, latest-note visual hint, focus/center adapters.
- `editor/`: editor commands, mouse shortcuts, local code link handling.
- `note/`: AMO note title/header/property behavior.
- `annotations/`: annotation syntax and Markdown rendering.
- `ui/`: panel, settings tab, and modals.
- `core/`: constants, metadata, paths, API primitives, UI helpers.

Canvas work must follow `docs/agnets/obsidian-canvas-development-guidelines.md`.

### `overlay/src-tauri/src`

Expected ownership after refactor:

- `lib.rs`: Tauri builder and command registration.
- `windows.rs`: external window enumeration, activation, and cursor window picking.
- `scratchpad.rs`: global mouse hook and scratchpad window placement.
- `clipboard.rs`: native clipboard fallback.
- `dialogs.rs`: native folder picker.
- `broker.rs`: broker startup/health helpers.

## Size Policy

Preferred hand-written file size:

- 300-500 lines for feature files.
- 100-250 lines for focused utility/domain modules.
- Up to ~800 lines for orchestration roots during transition.

Allowed exceptions:

- generated bundles such as Obsidian `main.js`
- lockfiles
- generated schemas
- temporary transition roots with an active refactor phase

Avoid files below ~40 lines unless they are clear public entrypoints, type barrels, or generated shims.

## Validation Policy

Use the narrowest relevant checkpoint after each move:

- Overlay TypeScript/UI: `cd overlay; npm run build`
- Tauri/Rust: `cd overlay/src-tauri; cargo check`
- Broker syntax: `node --check broker/server.js`
- Broker behavior: `npm run broker:verify`
- Adapter contracts: `npm run adapters:verify`
- Window routing: `npm run routing:verify`
- Obsidian plugin: `cd broker/assets/obsidian/md-anno-tools; npm run build`

Manual smoke is required when a refactor touches:

- Tauri windows or native commands
- Obsidian plugin behavior
- broker hook script generation
- deployment/enrollment
- note/canvas writing

## Current Transition State

The repository has completed the first overlay extraction pass. These boundaries have already moved out of `overlay/src/App.tsx`:

- broker client constants/helpers: `overlay/src/api/brokerClient.ts`
- session ordering/filtering/attention helpers: `overlay/src/domain/sessionModel.ts`
- session target, path, and Obsidian URI helpers: `overlay/src/domain/routingModel.ts`
- workspace deployment/maintenance state helpers: `overlay/src/domain/workspaceModel.ts`
- target candidate menu presentation: `overlay/src/components/CandidateMenu.tsx`
- project CLI launch panel presentation: `overlay/src/components/LaunchPanel.tsx`
- workspace maintenance panel presentation: `overlay/src/components/WorkspacePanel.tsx`
- Obsidian vault recovery dialog: `overlay/src/components/ObsidianVaultRecoveryDialog.tsx`
- workspace cleanup confirmation dialog: `overlay/src/components/CleanConfirmDialog.tsx`
- task card presentation: `overlay/src/components/SessionCard.tsx`
- AMO theme runtime: `overlay/src/theme/amoTheme.ts`
- shared clipboard helpers: `overlay/src/native/clipboard.ts`
- scratchpad shortcut persistence/native command helper: `overlay/src/native/scratchpadShortcut.ts`
- scratchpad utility window: `overlay/src/windows/ScratchpadApp.tsx`
- settings utility window and shared settings panels: `overlay/src/windows/SettingsWindowApp.tsx`
- standalone deploy utility window: `overlay/src/windows/DeployWorkspaceApp.tsx`
- shared utility window lifecycle/layering helpers: `overlay/src/windows/utilityWindow.ts`

The broker extraction has started. These boundaries have already moved out of `broker/server.js`:

- HTTP response/body/error helpers: `broker/lib/http.js`
- bounded debug log, debug status, and debug preview helpers: `broker/lib/debug.js`
- Codex/Claude session display-name cache: `broker/lib/display-names.js`
- shared text, integer, array, and version normalization helpers: `broker/lib/normalize.js`
- window, Codex CLI, and Codex App target binding helpers: `broker/lib/target-binding.js`
- workspace path, Git root, JSON read/write, and safety helpers: `broker/lib/filesystem.js`
- Codex/Claude hook event lists, generated hook script text, and CLI config merge helpers: `broker/hooks/codex.js`, `broker/hooks/claude.js`

The largest files are still the historical roots:

- `overlay/src/App.tsx`
- `broker/server.js`
- `overlay/src/styles.css`
- `broker/assets/obsidian/md-anno-tools/src/plugin.ts`
- `overlay/src-tauri/src/lib.rs`

Use `docs/refactor-plan.md` for phase order and checkpoints.

The legacy inline deploy and settings panels have been removed. Deploy/settings UI ownership now lives in standalone utility windows; task-card workspace maintenance remains in the main overlay.
