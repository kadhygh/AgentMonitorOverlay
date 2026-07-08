# AMO Refactor Execution Guide

Updated: 2026-07-09

This guide is the execution contract for the next long AMO refactor task. The goal is not to make the code look clever. The goal is to make the existing MVP easier to maintain and extend while keeping behavior stable.

## Core Principles

1. Existing behavior wins.
   - Every split must preserve current user-facing behavior unless the user explicitly asks for a behavior change.
   - Refactor commits should be reviewable as moves and boundary extraction first, not feature rewrites.

2. Maintainability is the reason for the split.
   - Split by product responsibility and ownership boundary, not by arbitrary utility categories.
   - A future maintainer should be able to answer "where does this behavior live?" from the folder structure.

3. Small local refactors are allowed when they support the split.
   - Allowed: extracting pure helpers, tightening private names, introducing narrow service modules, deleting unreachable legacy code, moving type definitions closer to owners.
   - Not allowed by default: changing hook protocols, changing note/canvas storage layout, changing target-binding semantics, changing Obsidian Canvas DOM behavior, introducing automatic paste/submit/approval.

4. Checkpoint frequently.
   - Each subphase should end with syntax/build validation and a narrow commit.
   - If a phase touches runtime behavior, run the relevant manual smoke before committing.

## Current Baseline

Generated bundles and lockfiles are excluded from this baseline. In particular, `broker/assets/obsidian/md-anno-tools/main.js` is a tracked Obsidian plugin build output and should not be used as a source-size hotspot.

| Area | Files | Source lines | Files >800 lines | Files >500 lines | Largest source file |
| --- | ---: | ---: | ---: | ---: | --- |
| Overlay | 40 | 10429 | 1 | 1 | `overlay/src/App.tsx` at about 2830 lines |
| Broker | 18 | 6207 | 1 | 2 | `broker/server.js` at about 2950 lines |
| Obsidian plugin source | 19 | 4669 | 1 | 2 | `broker/assets/obsidian/md-anno-tools/src/plugin.ts` at about 2165 lines |
| Tauri | 10 | 1394 | 0 | 1 | `overlay/src-tauri/src/windows.rs` at about 592 lines |

Previous refactor progress already paid off:

- `overlay/src/styles.css` is now import-only.
- `overlay/src-tauri/src/lib.rs` is now a small command-registration root.
- Many broker helpers already live in `broker/lib/`.
- Broker session state now lives in `broker/lib/session-store.js`.
- Broker workspace inspect/deploy now lives in `broker/lib/workspace-inspect.js` and `broker/lib/workspace-deploy.js`.
- Broker workspace Git exclude writes, launch, and maintenance now live in `broker/lib/workspace-git-exclude.js`, `broker/lib/workspace-launch.js`, and `broker/lib/workspace-maintenance.js`.
- Broker prompt/reply workflows, Obsidian bridge workflows, and pending prompt helpers now live in `broker/lib/conversation-service.js`, `broker/lib/obsidian-bridge.js`, and `broker/lib/pending-prompts.js`.
- Broker HTTP route groups now live in `broker/routes/config.js`, `broker/routes/sessions.js`, `broker/routes/workspaces.js`, and `broker/routes/obsidian.js`.
- Several Obsidian plugin helper families already live under `src/editor`, `src/canvas`, `src/annotations`, `src/note`, and `src/protocol`.

Remaining hotspots are historical orchestration roots:

- `broker/server.js` (about 450 lines after B1-B5 extraction)
- `overlay/src/App.tsx`
- `broker/assets/obsidian/md-anno-tools/src/plugin.ts`

## Recommended Order

Recommended order for the long task:

1. Broker split.
2. Overlay root split.
3. Obsidian plugin split.
4. Tauri cleanup only if needed.

Reasoning:

- Broker has the clearest module boundaries and the strongest verification scripts.
- Overlay has more UI state and desktop side effects, so it should be split after the broker API boundaries are clearer.
- Obsidian plugin work has the highest regression risk, especially around Canvas and editor lifecycle, so it should be later and smaller.
- Tauri is already mostly healthy; `windows.rs` can wait.

## Global Guardrails

Do not change these during the refactor unless the user asks for that behavior change:

- No global hook deployment.
- No automatic paste, Enter, permission approval, or prompt submission.
- Kiro IDE adapter stays out of the active roadmap.
- Codex CLI new-session naming stays unsupported until the CLI exposes a verified option.
- Codex App remains an accepted target-binding provider, not a Codex CLI hook clone.
- Work canvas promote/group/auto-layout stays parked. Users can manually assemble work canvases.
- Obsidian Canvas integration stays at the safe boundary: broker writes JSON Canvas files; plugin may add explicit user actions and lightweight hints; AMO must not take over Canvas renderer internals.
- Provider `sessionId` remains durable identity. Window title, process id, hwnd, and pending launch labels are routing hints only.
- Generated notes remain under `Sessions/<session-id>/turns/generated/`.
- Base canvas remains `Canvases/AgentFlow.base.canvas`.

## Validation Matrix

Use the narrowest relevant checkpoint after each subphase:

| Area touched | Required validation |
| --- | --- |
| Broker syntax only | `node --check broker/server.js` and `node --check` any new broker modules |
| Broker session/routes | `npm run broker:verify` |
| Adapter/hook contract | `npm run adapters:verify` |
| Workspace deploy/launch/maintenance | `npm run broker:verify`, `npm run adapters:verify`, and manual disposable workspace smoke |
| Overlay TypeScript/UI | `cd overlay; npm run build` |
| Tauri/native command use | `cd overlay/src-tauri; cargo check` |
| Window activation/routing | `npm run routing:verify` plus a manual click-to-window smoke if behavior changed |
| Obsidian plugin source | `cd broker/assets/obsidian/md-anno-tools; npm run build` |
| Obsidian note/canvas behavior | manual Obsidian smoke with existing AMO vault |
| CSS/theme/layout | `cd overlay; npm run build` plus quick visual smoke in light/dark themes |

Minimum validation before any refactor commit:

```powershell
git diff --check
```

If a subphase moves code across runtime boundaries, also run the relevant build/test command before committing.

## Broker Split Plan

Current largest broker hotspot: `broker/server.js`.

Target:

```text
broker/
  server.js
  routes/
    health.js
    sessions.js
    workspaces.js
    obsidian.js
    config.js
  lib/
    session-store.js
    session-events.js
    workspace-inspect.js
    workspace-deploy.js
    workspace-maintenance.js
    workspace-launch.js
    pending-prompts.js
    obsidian-bridge.js
```

`server.js` should keep:

- HTTP server bootstrap.
- CORS setup through `lib/http.js`.
- route table and dispatch.
- Event-stream connection registration if it remains simpler there.

`server.js` should not keep:

- workspace inspection/deploy implementation.
- session mutation policy.
- prompt/reply/annotation workflow details.
- Obsidian vault and plugin operation details.
- target binding mutation details.

### Broker Subphase B1: Session Store And State Policy

Create or complete:

```text
broker/lib/session-store.js
broker/lib/session-events.js
```

Move responsibilities:

- snapshot load/persist
- `listSessions`
- heartbeat update
- archive/dismiss/review/attention state mutations
- `sessionHasAttentionState`
- `shouldClearAttentionForActivity`
- `clearSessionAttentionFields`
- `reviveArchivedSession`
- `upsertSessionFromEvent`

Keep route request/response parsing in `server.js` for the first pass if that makes the move safer.

Expected result:

- `server.js` calls session-store functions instead of directly mutating the global session map everywhere.
- Session behavior remains identical.

Validation:

```powershell
node --check broker/server.js
node --check broker/lib/session-store.js
node --check broker/lib/session-events.js
npm run broker:verify
npm run adapters:verify
git diff --check
```

Manual smoke:

- Existing cards still load.
- Archive/dismiss/review/attention actions still work.
- A hook event can revive an archived card.

### Broker Subphase B2: Workspace Inspect/Deploy

Create:

```text
broker/lib/workspace-inspect.js
broker/lib/workspace-deploy.js
```

Move responsibilities:

- `amoVaultDirectoryName`
- `defaultWorkspaceVaultRoot`
- `resolveWorkspaceVaultRoot`
- `workspaceRelativePath`
- `adapterConfigPath`
- `inspectHookConfigCoverage`
- `inspectAdapterDeployment`
- `inspectWorkspace`
- `enrollWorkspace`
- `deferredAdapter`
- `adapterDeploymentReason`
- `isDeployableAdapterPlan`
- `normalizeAdapterIds`

Keep existing helpers in `broker/hooks/codex.js`, `broker/hooks/claude.js`, `broker/lib/obsidian-vault.js`, and `broker/lib/workspace-git-exclude.js`.

Expected result:

- Workspace deploy/inspect has one clear owner.
- `server.js` route handler becomes payload parsing plus `inspectWorkspace()` / `enrollWorkspace()`.

Validation:

```powershell
node --check broker/server.js
node --check broker/lib/workspace-inspect.js
node --check broker/lib/workspace-deploy.js
npm run broker:verify
npm run adapters:verify
git diff --check
```

Manual smoke:

- Deploy window can check a project.
- `Deploy Selected` still updates stale adapters.
- Plugin update and vault creation behavior stay unchanged.

### Broker Subphase B3: Workspace Maintenance, Git Exclude, Launch

Create or complete:

```text
broker/lib/workspace-maintenance.js
broker/lib/workspace-launch.js
```

Move responsibilities:

- `updateWorkspaceGitExclude`
- `launchWorkspace`
- `codexCliLaunchRoute`
- `bindLaunchedCodexCliTarget`
- `inspectWorkspaceMaintenance`
- `cleanWorkspaceVault`
- `updateWorkspaceObsidianPlugin`
- `workspaceMaintenanceSnapshot`
- `inspectCanvasFile`
- `countFilesByExtension`
- `countConversationGeneratedNotes`
- `clearWorkspaceBridgeState`
- `resetWorkspaceCanvasBindings`
- `resetWorkspaceNoteIndex`

Expected result:

- Deploy window and card workspace settings talk to a workspace-maintenance/launch module.
- Launch behavior remains intentionally conservative:
  - Claude may support session name later.
  - Codex CLI launches plain unless resume is explicit.
  - no synthetic card on launch.

Validation:

```powershell
node --check broker/server.js
node --check broker/lib/workspace-maintenance.js
node --check broker/lib/workspace-launch.js
npm run broker:verify
npm run adapters:verify
git diff --check
```

Manual smoke:

- Card settings panel still reports workspace/vault/plugin state.
- Clean generated content still requires confirmation and preserves enrollment/hooks.
- Launch Codex/Claude from deployed workspace.
- Add Git exclude with and without `.claude/settings.local.json`.

### Broker Subphase B4: Conversation And Obsidian Bridge Workflows

Create:

```text
broker/lib/conversation-service.js
broker/lib/obsidian-bridge.js
broker/lib/pending-prompts.js
```

Move responsibilities:

- `handleReply`
- `handlePrompt`
- duplicate prompt handling
- `handleObsidianAnnotations`
- `renderPendingPrompt`
- `shouldNumberAnnotations`
- `promptContentHash`
- `findDuplicatePrompt`
- `handleObsidianNoteTitle`
- `recoverSessionFromAnnotationPayload`
- `handleRegisterObsidianVault`
- `handleSyncBack`
- `normalizeAnnotations`

Keep file writing primitives in existing modules:

- `conversation-artifacts.js`
- `canvas-writer.js`
- `obsidian-vault.js`

Expected result:

- Prompt/reply/annotation business flow has one service owner.
- File writing remains in lower-level artifact modules.

Validation:

```powershell
node --check broker/server.js
node --check broker/lib/conversation-service.js
node --check broker/lib/obsidian-bridge.js
node --check broker/lib/pending-prompts.js
npm run broker:verify
npm run adapters:verify
git diff --check
```

Manual smoke:

- Codex/Claude prompt notes still write under session layout v2.
- Reply notes still append to base canvas.
- Obsidian `Send to AMO` still creates a prompt note, copies prompt, and focuses the selected target.
- Annotation numbering setting still defaults off.

### Broker Subphase B5: Route Modules

Create:

```text
broker/routes/sessions.js
broker/routes/workspaces.js
broker/routes/obsidian.js
broker/routes/config.js
```

Move request handlers only after the service modules are stable.

Expected result:

- `server.js` is under about 800 lines.
- Routes are grouped by product surface.
- Service modules own behavior; routes own HTTP shape.

Validation:

```powershell
node --check broker/server.js
node --check broker/routes/sessions.js
node --check broker/routes/workspaces.js
node --check broker/routes/obsidian.js
node --check broker/routes/config.js
npm run broker:verify
npm run adapters:verify
git diff --check
```

## Overlay Split Plan

Current largest overlay hotspot: `overlay/src/App.tsx`.

Target:

```text
overlay/src/
  App.tsx
  windows/
    MainOverlayApp.tsx
  hooks/
    useBrokerSessions.ts
    useSessionActions.ts
    useTargetActivation.ts
    useObsidianOpen.ts
    useWorkspaceMaintenance.ts
    useCardDrag.ts
    useWindowBindDrag.ts
    useOverlayResize.ts
  controllers/
    pendingPromptController.ts
```

`App.tsx` should become:

- Tauri window-kind detection.
- Return the right top-level window app.
- No session polling, no card state, no drag logic.

`MainOverlayApp.tsx` should own:

- visible monitor UI composition.
- high-level state wiring.
- callbacks passed to components.

Hooks/controllers should own:

- broker polling and event-stream updates.
- side-effectful session actions.
- target activation/candidate menu operations.
- Obsidian vault recovery/open flows.
- drag/reorder/resize pointer state.

### Overlay Subphase O1: MainOverlayApp Extraction

Create:

```text
overlay/src/windows/MainOverlayApp.tsx
```

Move the main overlay branch from `App.tsx` without changing internals first.

Expected result:

- `App.tsx` becomes a thin window switch root.
- `MainOverlayApp.tsx` is still large but has a clear owner.

Validation:

```powershell
cd overlay
npm run build
cd src-tauri
cargo check
cd ..\..
git diff --check
```

Manual smoke:

- AMO starts.
- Header buttons, collapse/expand, filters, search, cards still render.

### Overlay Subphase O2: Broker Sessions Hook

Create:

```text
overlay/src/hooks/useBrokerSessions.ts
```

Move:

- broker readiness/session polling.
- event stream subscription.
- session list state.
- broker heartbeat/footer status update.

Expected result:

- Main overlay UI no longer owns polling mechanics.
- Session updates still arrive quickly after hook/Obsidian actions.

Validation:

```powershell
cd overlay
npm run build
cd src-tauri
cargo check
cd ..\..
git diff --check
```

Manual smoke:

- Start AMO with broker running.
- Trigger or reload existing sessions.
- Confirm review/attention/running state updates.

### Overlay Subphase O3: Session Actions And Target Activation

Create:

```text
overlay/src/hooks/useSessionActions.ts
overlay/src/hooks/useTargetActivation.ts
```

Move:

- review/seen/archive/unarchive/dismiss calls.
- target bind/unbind.
- candidate menu open/confirm.
- Codex App and Codex CLI target open actions.
- app/CLI launch panel callbacks.

Keep presentational menu in `CandidateMenu.tsx`.

Expected result:

- Main overlay passes action callbacks, but activation logic is testable in one hook/controller.

Validation:

```powershell
cd overlay
npm run build
cd src-tauri
cargo check
cd ..\..
npm run routing:verify
git diff --check
```

Manual smoke:

- Click task card target.
- Candidate menu appears when ambiguous.
- Manual bind/unbind works.
- App button opens Codex App target when bound.
- Card `+` still launches a new CLI without synthetic card creation.

### Overlay Subphase O4: Obsidian Open And Workspace Maintenance Hooks

Create:

```text
overlay/src/hooks/useObsidianOpen.ts
overlay/src/hooks/useWorkspaceMaintenance.ts
```

Move:

- note/canvas open calls.
- vault-not-loaded recovery dialog state.
- plugin update call.
- workspace maintenance panel open/refresh/save title.
- clean generated content confirmation flow.

Expected result:

- Obsidian/vault recovery logic has one owner.
- Workspace panel remains presentational.

Validation:

```powershell
cd overlay
npm run build
cd src-tauri
cargo check
cd ..\..
git diff --check
```

Manual smoke:

- Open Note.
- Open Canvas and focus latest note.
- Vault-not-loaded dialog still offers folder open/copy path.
- Card settings panel still updates plugin and cleans generated content.

### Overlay Subphase O5: Pointer Interaction Hooks

Create:

```text
overlay/src/hooks/useCardDrag.ts
overlay/src/hooks/useWindowBindDrag.ts
overlay/src/hooks/useOverlayResize.ts
```

Move:

- card reorder pointer listeners.
- drag-to-window binding pointer listeners.
- overlay resize state.

Expected result:

- Pointer lifecycle cleanup is localized.
- Main overlay no longer mixes product actions with mouse bookkeeping.

Validation:

```powershell
cd overlay
npm run build
cd src-tauri
cargo check
cd ..\..
npm run routing:verify
git diff --check
```

Manual smoke:

- Drag cards slowly through the list.
- Drag unbound card to external CLI window.
- Resize overlay width and height.
- Collapse/expand overlay.

## Obsidian Plugin Split Plan

Current plugin hotspot: `broker/assets/obsidian/md-anno-tools/src/plugin.ts`.

Target:

```text
broker/assets/obsidian/md-anno-tools/src/
  plugin.ts
  bridge/
    actions.ts
    client.ts
  canvas/
    actions.ts
    target.ts
    navigation.ts
  editor/
    annotation-commands.ts
    local-code-link-controller.ts
    local-code-links.ts
  note/
    title.ts
    properties.ts
  annotations/
    commands.ts
    render.ts
    syntax.ts
  ui/
    panel-view.ts
    modals.ts
    settings-tab.ts
```

`plugin.ts` should keep:

- lifecycle `onload` / `onunload`
- settings load/save
- command registration
- event registration
- module wiring

It should not keep:

- source-editing annotation details
- bridge POST details
- canvas selected-note operations
- work canvas modal logic
- local code link logic
- note title implementation

### Plugin Subphase P1: Bridge Client And Actions

Create:

```text
src/bridge/client.ts
src/bridge/actions.ts
```

Move:

- bridge health check.
- copy/send annotations calls.
- sync-back request shaping.
- operation status text helpers.

Validation:

```powershell
cd broker/assets/obsidian/md-anno-tools
npm run build
cd ../../../..
git diff --check
```

Manual smoke:

- Panel `返回到窗口`.
- Panel `拷贝批注`.
- Send annotations from note.

### Plugin Subphase P2: Annotation Source Commands

Create:

```text
src/annotations/commands.ts
src/editor/annotation-commands.ts
```

Move:

- insert annotation from current selection.
- append referenced annotation.
- delete annotation from file.
- copy/focus single annotation item.
- read-mode referenced annotation behavior.

Validation:

```powershell
cd broker/assets/obsidian/md-anno-tools
npm run build
cd ../../../..
git diff --check
```

Manual smoke:

- In note edit mode: select text -> insert quoted annotation.
- In note read mode: select text -> append referenced annotation.
- Delete annotation from panel/rendered control.
- Copy single annotation.

### Plugin Subphase P3: Canvas Actions

Create:

```text
src/canvas/actions.ts
src/canvas/work-canvas.ts
```

Move:

- selected canvas note actions.
- open note from canvas.
- edit title from canvas.
- choose canvas Markdown file.
- list canvas Markdown file targets.
- light add-note-to-work-canvas behavior.

Do not add advanced promote/group/auto-layout.

Validation:

```powershell
cd broker/assets/obsidian/md-anno-tools
npm run build
cd ../../../..
git diff --check
```

Manual smoke:

- Canvas selected AMO note can open note.
- Canvas selected note can return to window if metadata supports it.
- Non-AMO note behavior stays disabled where intended.
- Canvas action target does not drift to previously selected note.

### Plugin Subphase P4: Note Title And Properties

Create:

```text
src/note/properties.ts
```

Move:

- AMO note property view sync.
- property visibility toggle.
- AMO Markdown file detection if not already in `note/title.ts`.
- display title file update wrappers if stable.

Validation:

```powershell
cd broker/assets/obsidian/md-anno-tools
npm run build
cd ../../../..
git diff --check
```

Manual smoke:

- Open generated note.
- Display title renders in read mode.
- Title edit from AMO panel still stores hidden metadata and does not rename file.
- Property hiding still only affects Markdown note views, not Canvas node DOM.

## Tauri Plan

Tauri is not a priority. Current root is healthy:

- `overlay/src-tauri/src/lib.rs` is about 131 lines.
- `windows.rs` is about 592 lines.

Only split `windows.rs` if native window behavior becomes hard to change.

Possible later split:

```text
overlay/src-tauri/src/windows/
  mod.rs
  enumerate.rs
  matchers.rs
  activate.rs
  cursor.rs
```

Validation:

```powershell
cd overlay/src-tauri
cargo check
cd ..\..
npm run routing:verify
git diff --check
```

## Documentation Duties During Refactor

Update docs as code moves:

- `docs/project-structure.md`: ownership boundaries and current transition state.
- `docs/refactor-plan.md`: high-level status and progress log.
- `docs/refactor-execution-guide.md`: only when the execution strategy changes.
- Obsidian Canvas changes must also respect `docs/agnets/obsidian-canvas-development-guidelines.md`.

Do not let architecture decisions live only in a chat or commit message. If a boundary changes, record it.

## Commit Strategy

Use one commit per coherent subphase:

- Good: `refactor(broker): extract workspace launch service`
- Good: `refactor(overlay): move target activation into hook`
- Good: `refactor(obsidian): extract annotation source commands`
- Avoid: one giant commit touching broker, overlay, plugin, and docs.

Before each commit:

1. Review `git diff --stat`.
2. Run relevant validation.
3. Ensure generated `main.js` is included only when Obsidian plugin source changed and the plugin build regenerated it.
4. Keep unrelated untracked files out of the commit.

## Stop Conditions

Stop and reassess before continuing if:

- A refactor requires changing hook payload shape.
- A test fails in a way that is not obviously caused by the moved code.
- Obsidian Canvas behavior requires DOM mutation or live renderer patching.
- A split would create many tiny files with unclear ownership.
- Manual smoke shows a UI timing/focus regression.
- The same helper is needed by both broker and overlay; do not create cross-runtime shared code casually.

## Suggested First Long-Task Slice

Start with Broker Subphase B1 and B2:

1. Extract session store/state policy.
2. Extract workspace inspect/deploy.
3. Validate broker and adapter scripts.
4. Commit.

Why this first:

- It reduces the largest file with the least UI risk.
- It makes later overlay work easier because the broker API owner is clearer.
- Verification is strong and mostly automated.

Expected first-slice outcome:

- `broker/server.js` drops by roughly 700-1000 lines.
- session mutation policy has a single owner.
- workspace deploy/inspect has a single owner.
- no visible product behavior changes.

After that, continue with B3/B4 or switch to Overlay O1/O2 depending on which file feels more painful in real work.
