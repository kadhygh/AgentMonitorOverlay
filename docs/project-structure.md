# AMO Project Structure

Updated: 2026-07-09

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
- `styles/`: feature-scoped CSS slices imported by `styles.css`; keep visual-order imports stable unless intentionally changing cascade.
- `styles.css`: CSS entrypoint only. It should stay import-only after the split.
- `types.ts`: shared TypeScript contracts that mirror broker/plugin payloads.

### `broker`

Expected ownership after refactor:

- `server.js`: native HTTP server bootstrap and route table.
- `routes/config.js`: health and debug routes.
- `routes/sessions.js`: session listing, SSE handoff, review/archive/dismiss/attention, heartbeat, and target/window binding routes.
- `routes/workspaces.js`: workspace inspect/enroll/git-exclude/launch/status/clean/plugin-update routes.
- `routes/obsidian.js`: hook event intake, prompt/reply routes, Obsidian annotation/title/vault/sync-back routes.
- `lib/amo-constants.js`: shared AMO layout, version, canvas, and plugin constants.
- `lib/http.js`: request/response helpers.
- `lib/debug.js`: bounded debug log and debug status.
- `lib/session-store.js`: session map, snapshot load/persist, archive/dismiss/review/attention, list sessions.
- `lib/conversation-service.js`: prompt/reply note and canvas orchestration, duplicate prompt handling, and enrolled workspace resolution.
- `lib/obsidian-bridge.js`: Obsidian annotation sync-back, note title updates, vault registration, and recovered session payloads.
- `lib/pending-prompts.js`: annotation normalization, annotation numbering, prompt rendering, prompt hashes, and duplicate prompt checks.
- `lib/normalize.js`: shared payload normalization helpers.
- `lib/obsidian-vault.js`: Obsidian vault registry, plugin install/health, runtime-state, and comparable path helpers.
- `lib/target-binding.js`: window, Codex CLI, and Codex App target binding normalization.
- `lib/terminal-launch.js`: detached terminal/process launch helpers.
- `lib/text-format.js`: shared note title, filename, and preview text formatting helpers.
- `lib/workspace-inspect.js`: workspace status, vault-root planning, adapter deployment coverage, and deployability plans.
- `lib/workspace-deploy.js`: workspace enrollment, adapter hook install/merge, AMO vault creation, plugin install, and `.amo/.gitignore`.
- `lib/workspace-git-exclude.js`: project-local Git exclude inspection, planning, and update writes.
- `lib/workspace-launch.js`: workspace CLI/App launch, Codex CLI resume title route, and launch-time target binding.
- `lib/workspace-maintenance.js`: workspace maintenance snapshot, vault cleanup, plugin update, canvas inspection, and cleanup bridge-state resets.
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
- `models.rs`: serializable command payloads and shared native helper structs.
- `broker.rs`: local broker health check, broker script discovery, and hidden/visible broker process launch.
- `clipboard.rs`: native clipboard writing and newline normalization.
- `dialogs.rs`: native folder picker commands and Windows COM dialog handling.
- `opener.rs`: local file/folder opening, external URI launch, and ShellExecute helpers.
- `windows.rs`: external window enumeration, activation, and cursor window picking.
- `scratchpad.rs`: global mouse hook, shortcut state, scratchpad copy-request events, and cursor-relative window placement.

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
- overlay session UI positioning and Codex action-required helpers: `overlay/src/domain/overlaySessionUi.ts`
- workspace deployment/maintenance state helpers: `overlay/src/domain/workspaceModel.ts`
- target candidate menu presentation: `overlay/src/components/CandidateMenu.tsx`
- broker readiness presentation: `overlay/src/components/BrokerReadinessPanel.tsx`
- project CLI launch panel presentation: `overlay/src/components/LaunchPanel.tsx`
- workspace maintenance panel presentation: `overlay/src/components/WorkspacePanel.tsx`
- Obsidian vault recovery dialog: `overlay/src/components/ObsidianVaultRecoveryDialog.tsx`
- workspace cleanup confirmation dialog: `overlay/src/components/CleanConfirmDialog.tsx`
- task card presentation: `overlay/src/components/SessionCard.tsx`
- deploy workspace panel presentation: `overlay/src/components/DeployWorkspaceSections.tsx`
- AMO theme runtime: `overlay/src/theme/amoTheme.ts`
- shared clipboard helpers: `overlay/src/native/clipboard.ts`
- scratchpad shortcut persistence/native command helper: `overlay/src/native/scratchpadShortcut.ts`
- scratchpad utility window: `overlay/src/windows/ScratchpadApp.tsx`
- settings utility window and shared settings panels: `overlay/src/windows/SettingsWindowApp.tsx`
- standalone deploy utility window: `overlay/src/windows/DeployWorkspaceApp.tsx`
- shared utility window lifecycle/layering helpers: `overlay/src/windows/utilityWindow.ts`
- main overlay monitor window: `overlay/src/windows/MainOverlayApp.tsx`
- thin Tauri webview window switch root: `overlay/src/App.tsx`
- broker session polling, readiness, SSE updates, and session list state: `overlay/src/hooks/useBrokerSessions.ts`
- session review, attention clear, target unbind, archive/dismiss broker actions, and related busy state: `overlay/src/hooks/useSessionActions.ts`
- Codex App/CLI target opening, candidate window listing/activation, target binding, and activation busy state: `overlay/src/hooks/useTargetActivation.ts`
- Obsidian note/canvas opening, AMO vault recovery dialog state, and recovery folder/path actions: `overlay/src/hooks/useObsidianOpen.ts`
- task-card workspace status, plugin update, generated-vault clean, task title save, path open, and project CLI launch panel actions: `overlay/src/hooks/useWorkspacePanels.ts`
- card reorder pointer lifecycle: `overlay/src/hooks/useCardDrag.ts`
- drag-to-window binding pointer lifecycle: `overlay/src/hooks/useWindowBindDrag.ts`
- overlay resize pointer lifecycle: `overlay/src/hooks/useOverlayResize.ts`
- deploy/settings utility window open, focus, hide, and main-window blocking state: `overlay/src/hooks/useMainUtilityWindows.ts`
- attention visual seen state, attention animation clock, and taskbar review attention requests: `overlay/src/hooks/useAttentionVisuals.ts`
- pending prompt copy, sync-back acknowledgement, duplicate auto-sync guard, and target focus handoff: `overlay/src/hooks/usePendingPromptSync.ts`
- Codex CLI action-required window probing and permission-attention heartbeat update: `overlay/src/hooks/useCodexActionRequiredProbe.ts`
- overlay debug status, debug toggle, and non-blocking debug log posting: `overlay/src/hooks/useDebugLogging.ts`

`DeployWorkspaceApp.tsx` remains the deploy workflow owner: broker requests, native folder dialogs, debug logging,
busy states, and feedback messages stay there. `DeployWorkspaceSections.tsx` owns only the visible workspace,
Git exclude, adapter, and deployment-result panels.

The Obsidian plugin extraction has started. Local code link parsing, rendering, URL formatting, and Zed/URL opening
live in `broker/assets/obsidian/md-anno-tools/src/editor/local-code-links.ts`. Local code link document/editor event
handling, follow-up suppression, settings refresh, and open-result status live in
`broker/assets/obsidian/md-anno-tools/src/editor/local-code-link-controller.ts`; `plugin.ts` only wires those handlers.
AMO note metadata checks, display names, source-mode display-title header DOM, and first-content-line detection live in
`broker/assets/obsidian/md-anno-tools/src/note/title.ts`; `plugin.ts` still owns note title file writes and title bridge sync.
Annotation copy/send and bridge health actions live in
`broker/assets/obsidian/md-anno-tools/src/bridge/annotation-sync.ts`; `plugin.ts` keeps public wrapper methods for panel,
command, and shortcut callers.
Inline annotation token replacement and local-code-link linkification now live with legacy annotation section rendering in
`broker/assets/obsidian/md-anno-tools/src/annotations/render.ts`; source text range lookup and editor offset conversion live in
`broker/assets/obsidian/md-anno-tools/src/annotations/source-ranges.ts`; source editing commands for inserting, appending,
and deleting annotations live in `broker/assets/obsidian/md-anno-tools/src/annotations/commands.ts`; `plugin.ts` only
decides when postprocessing runs and exposes public wrapper methods for command/panel callers.
Canvas latest-note marking, centering, node element lookup, bounds, zoom, and selection collection helpers live in
`broker/assets/obsidian/md-anno-tools/src/canvas/navigation.ts`; `plugin.ts` keeps the debug-aware `safeCanvasCall` wrapper.
`obsidian://amo-open` path resolution, tab reuse, new-tab opening, and focus-note follow-up live in
`broker/assets/obsidian/md-anno-tools/src/protocol/amo-open.ts`; `plugin.ts` keeps `openVaultPath()` as a public wrapper
for panel and command callers.

The broker extraction has started. These boundaries have already moved out of `broker/server.js`:

- shared AMO layout, version, canvas, and plugin constants: `broker/lib/amo-constants.js`
- HTTP response/body/error helpers: `broker/lib/http.js`
- bounded debug log, debug status, and debug preview helpers: `broker/lib/debug.js`
- session map, snapshot load/persist, event upsert, heartbeat, archive/dismiss/review/attention, and session listing: `broker/lib/session-store.js`
- prompt/reply artifact orchestration and duplicate prompt policy: `broker/lib/conversation-service.js`
- Obsidian annotation sync-back, note title updates, vault registration, and recovered annotation sessions: `broker/lib/obsidian-bridge.js`
- annotation normalization, annotation numbering, pending prompt rendering, and prompt duplicate hashes: `broker/lib/pending-prompts.js`
- HTTP route grouping: `broker/routes/config.js`, `broker/routes/sessions.js`, `broker/routes/workspaces.js`, `broker/routes/obsidian.js`
- Codex/Claude session display-name cache: `broker/lib/display-names.js`
- shared text, integer, array, and version normalization helpers: `broker/lib/normalize.js`
- Obsidian vault registry, plugin install/health, runtime-state, and comparable path helpers: `broker/lib/obsidian-vault.js`
- prompt/reply generated notes, note index, and session manifest helpers: `broker/lib/conversation-artifacts.js`
- JSON Canvas create/append, metadata, edge, and note title sync helpers: `broker/lib/canvas-writer.js`
- window, Codex CLI, and Codex App target binding helpers: `broker/lib/target-binding.js`
- detached terminal/process launch helpers: `broker/lib/terminal-launch.js`
- shared note title, filename, and preview text formatting helpers: `broker/lib/text-format.js`
- project-local Git exclude inspection and update planning: `broker/lib/workspace-git-exclude.js`
- workspace inspection, vault-root planning, adapter deployability, and adapter deployment coverage: `broker/lib/workspace-inspect.js`
- workspace enrollment, hook install/merge, AMO vault creation, plugin install, and `.amo/.gitignore`: `broker/lib/workspace-deploy.js`
- workspace launch, launch-time Codex CLI target binding, maintenance status, vault cleanup, plugin update, and Git exclude writes: `broker/lib/workspace-launch.js`, `broker/lib/workspace-maintenance.js`, `broker/lib/workspace-git-exclude.js`
- workspace path, Git root, JSON read/write, and safety helpers: `broker/lib/filesystem.js`
- Codex/Claude hook event lists, generated hook script text, and CLI config merge helpers: `broker/hooks/codex.js`, `broker/hooks/claude.js`

The remaining source hotspots are:

- `broker/server.js` (about 450 lines after route module extraction)
- `overlay/src/App.tsx`
- `broker/assets/obsidian/md-anno-tools/src/plugin.ts`
- `overlay/src-tauri/src/windows.rs`
- `broker/assets/obsidian/md-anno-tools/src/ui/panel-view.ts`
- `broker/assets/obsidian/md-anno-tools/styles.css`

Use `docs/refactor-execution-guide.md` for the next long-task split order, guardrails, and validation matrix. Use `docs/refactor-plan.md` as the historical plan and progress log.

The legacy inline deploy and settings panels have been removed. Deploy/settings UI ownership now lives in standalone utility windows; task-card workspace maintenance remains in the main overlay.
