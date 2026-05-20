# AMO Obsidian Bridge MVP

Updated: 2026-05-16

This document is the current control design for moving Agent Monitor Overlay from a pure session monitor into a small local bridge between agent hooks, the overlay, and an Obsidian reading/canvas workflow.

## Current Decision

The next product shape is:

```text
Selected project folder
  -> workspace-local Codex / Claude / Kiro adapter or hook
  -> AMO local bridge server
  -> overlay session status and window focus
  -> Obsidian vault notes and canvas flow
  -> annotation extraction
  -> copy + focus back to the target CLI session
```

The overlay should remain the visible status and jump surface. It should also launch or supervise a small local bridge server. The bridge server is the handoff point between short-lived workspace-local hooks or adapters, vault file writes, Obsidian plugin actions, and overlay UI state.

AMO should not deploy global hooks in Phase 5. The safer default is manual workspace enrollment:

- User selects a target project folder.
- AMO inspects that folder and any obvious local tool configuration.
- AMO chooses or suggests a folder-scoped adapter path for the detected CLI/TUI.
- AMO writes only project-local hook/adapter files after explicit user confirmation.
- AMO records the workspace enrollment so the overlay can show which folders are bridged.
- AMO can disable or remove its project-local hook/adapter files for a selected folder.

This keeps the bridge compatible with future CLI/TUI providers. Codex, Claude, Kiro, Gemini CLI, OpenCode, Aider, Cursor, or other tools may expose different hook, transcript, statusline, or wrapper surfaces, so the first AMO decision point should be "which folder and which local adapter fits this folder?" rather than "install one global hook for every tool."

## Target Workflow

The long-term product flow is:

1. User starts the monitor.
2. User clicks deploy and selects a project folder.
3. AMO inspects the folder without LLM involvement.
4. AMO shows supported adapter options for that folder, initially targeting:
   - Codex CLI
   - Codex App
   - Claude CLI
   - Kiro IDE
5. User selects which adapters/hooks to deploy.
6. AMO creates a project-local `.amo/` folder with workspace config, adapter config, state, logs, and a dedicated Obsidian vault.
7. AMO installs only project-local hook/adapter files.
8. User starts a CLI/TUI from the monitor or starts it manually.
9. When the agent finishes a reply, the workspace-local hook/adapter sends the final reply to the AMO bridge.
10. The monitor shows or updates the matching task card.
11. User can focus the CLI directly from the task card.
12. User can open Obsidian/canvas from the task card.
13. If the CLI session is not bound to a work canvas, the Obsidian plugin lets the user create or choose one.
14. The bridge records the binding and inserts the reply note into the work canvas.
15. One work canvas can be associated with multiple CLI/TUI sessions.
16. User adds `[!anno]...[/anno]` annotations in the canvas-linked note.
17. The Obsidian plugin summarizes/sends annotations to AMO.
18. AMO creates a pending continuation prompt, copies it, and focuses the selected CLI.
19. User manually pastes/submits the prompt.

This target flow keeps the monitor as the session/window bridge and keeps Obsidian as the long-form reading and annotation workspace.

### Identity Model

Do not use window PID/HWND as the long-term identity. They are routing hints and can become stale.

Use these durable IDs:

- `workspaceId`: selected project folder and its `.amo/` state.
- `agentInstanceId`: one CLI/TUI process or window instance known to AMO.
- `sessionId`: provider session id from Codex, Claude, Kiro, or another adapter.
- `workCanvasId`: Obsidian work canvas bound to one or more agent instances.
- `replyNoteId`: one assistant reply note.
- `pendingPromptId`: one annotation summary waiting to return to a CLI/TUI.

Use these volatile routing hints:

- `windowHint.hwnd`
- `windowHint.pid`
- `windowHint.titleToken`
- `windowHint.titleContains`
- `windowHint.cwd`

`windowHint.pid` must mean a validated visible-window owner process id, not a hook runner pid.

### Project Local `.amo/` Shape

Recommended first shape:

```text
project/
  .amo/
    workspace.json
    enrollment.json
    adapters/
      codex-cli.json
      codex-app.json
      claude-cli.json
      kiro-ide.json
    hooks/
      codex-stop-message.mjs
    state/
      sessions.json
      bindings.json
      pending-replies.json
    obsidian-vault/
      AgentFlow.canvas
      Replies/
      .obsidian/
        plugins/
          amo-bridge/
    logs/
      hook-errors.log
      bridge-events.log
```

AMO should add `.amo/state/`, `.amo/logs/`, and large generated vault artifacts to ignore rules where practical. The first MVP can keep this disposable and local, but the design should avoid accidentally committing live session state, logs, or generated reply content.

### Deployment Contract

Deployment should be script-driven and deterministic:

```text
inspect selected folder
  -> produce deployment plan
  -> show detected adapters, files to write, risks, and unsupported tools
  -> apply after user confirmation
  -> run health checks
```

The deployment system must support:

- repair/redeploy
- disable one adapter
- uninstall AMO-owned files
- backup before changing user-owned config
- merge rather than overwrite existing hook config
- report partial success and exact remediation steps

Deployment UI follow-up: keep the main overlay focused on monitoring, task cards, and window jumps. The deploy entry should open a separate popup/tool window instead of taking over the overlay card area; that window can grow into the full deployment workbench for directory selection, read-only checks, deploy confirmation, repair, history, adapter choices, risk preview, and settings.

The deployment maintenance guide lives in `docs/adapter-deployment-guide.md`.

## Current MVP Workflow

The current MVP should intentionally narrow the target flow:

```text
Codex CLI
  -> one manually selected project folder
  -> project-local `.amo/`
  -> `.amo/obsidian-vault/`
  -> one `AgentFlow.canvas`
  -> reply notes
  -> `[!anno]...[/anno]`
  -> copy pending prompt + focus CLI
```

MVP acceptance flow:

1. Start monitor and bridge.
2. Select one project folder.
3. AMO inspects the folder and offers only the `codex-cli` adapter if supported.
4. AMO creates `.amo/` and the dedicated `.amo/obsidian-vault/`.
5. AMO installs or updates project-local Codex hook files after confirmation.
6. User starts Codex CLI manually or from the monitor.
7. Codex `Stop` hook sends `last_assistant_message` to `POST /api/replies`.
8. Bridge records the reply and updates the task card.
9. Bridge writes a reply note under `.amo/obsidian-vault/Replies/`.
10. Bridge creates or appends a file node in `.amo/obsidian-vault/AgentFlow.canvas`.
11. Task card exposes `Focus CLI`, `Open Canvas`, and `Open Note`.
12. User annotates the note with `[!anno]...[/anno]`.
13. Obsidian plugin sends annotations to AMO.
14. AMO creates a pending prompt.
15. User clicks `Copy + Focus CLI`.
16. User manually pastes/submits.

MVP defers:

- Codex App direct integration.
- Claude CLI reply capture.
- Kiro IDE deployment.
- Multiple CLI quick-jump controls inside one canvas.
- Permission approval from task cards.
- Automatic paste, Enter, or approval.
- Integration with the user's existing long-lived Obsidian vault.
- Complex canvas layout or re-layout.

The Obsidian workflow is no longer only a distant future idea. Two local MVPs have made the Phase 5 direction concrete:

- `D:\Projects\CommonProject\obsidianplugintest\docs\CODEX_REPLY_NOTE_HOOK_INTEGRATION.md`
- `D:\Projects\CommonProject\obsidianplugintest\docs\OBSIDIAN_ANNOTATION_PLUGIN_DEVELOPMENT.md`

The useful parts of that external MVP have also been copied into this repo for cross-device handoff:

- `docs/reference-mvps/obsidianplugintest/README.md`
- `docs/reference-mvps/obsidianplugintest/handoff/`
- `docs/reference-mvps/obsidianplugintest/codex-hook/`
- `docs/reference-mvps/obsidianplugintest/plugin/`

## Source MVP Findings

### Codex Reply Note Hook

The Codex hook MVP uses the Codex CLI `Stop` hook because it fires after a completed assistant turn and includes `last_assistant_message`.

Verified useful pieces:

- Project-local hook file: `.codex/hooks.json`
- Hook script: `.codex/hooks/cache-stop-message.mjs`
- Trigger: `Stop`
- Payload field used for note content: `last_assistant_message`
- Stable output protocol: hook stdout should only return `{"continue":true}`
- Current local cache:
  - `.codex/cache/latest-assistant-message.md`
  - `.codex/cache/latest-assistant-message.json`
  - `.codex/cache/assistant-turns/`
  - `.codex/cache/assistant-turn-errors.log`
- Record fields already proven useful:
  - `capturedAt`
  - `sessionId`
  - `turnId`
  - `model`
  - `hookEventName`
  - `cwd`
  - `transcriptPath`
  - `stopHookActive`
  - `message`

Design implication:

- Treat this as a project-local enrollment pattern, not a global Codex setup.
- Keep the Stop hook short and safe.
- Keep file cache as a fallback.
- Add a best-effort POST to the AMO bridge server.
- Never let bridge or vault failure block the Codex turn.

### Obsidian Annotation Plugin

The Obsidian plugin MVP is `Markdown Annotation Tools` with plugin id `md-anno-tools`.

Verified useful pieces:

- Plugin project: `D:\Projects\CommonProject\obsidianplugintest`
- Test vault: `D:\Projects\CommonProject\obsidianplugintestvault`
- Plugin install target: `D:\Projects\CommonProject\obsidianplugintestvault\.obsidian\plugins\md-anno-tools`
- Source files:
  - `src/main.ts`
  - `styles.css`
  - `manifest.json`
  - `package.json`
- Annotation syntax:

```md
[!anno]annotation text[/anno]
```

Multiline annotations are also valid:

```md
[!anno]
first paragraph

second paragraph
[/anno]
```

Current plugin abilities:

- Render `[!anno]...[/anno]` in Obsidian reading mode.
- Copy annotations from the current note to the clipboard.
- Quote selected editor text into a new `[!anno]...[/anno]` block from the editor context menu, leaving the original text in place and using Markdown quote markers as the reply context.
- Insert an empty annotation block from the command palette.
- Append an annotation to the end of the current note.

Design implication:

- Keep `[!anno]...[/anno]` as the Phase 5 annotation format.
- Do not introduce an annotation database yet.
- Do not require rich anchored comments in the first bridge MVP.
- Add a new command later for "Send current note annotations to AMO" without replacing the existing clipboard command.

## Architecture

### Components

```text
Agent hook scripts
  - observe lifecycle events
  - capture assistant replies on Stop
  - cache locally
  - POST to AMO bridge if available

Workspace enrollment
  - starts from a user-selected project folder
  - detects local tool configuration and likely CLI/TUI adapter options
  - installs, updates, disables, or removes only folder-scoped AMO hook files

AMO bridge server
  - receives hook events and replies
  - maintains latest session state
  - writes reply notes into a configured vault
  - appends file nodes and edges to an Obsidian canvas
  - stores session to note/canvas linkage
  - receives annotation summaries from the Obsidian plugin
  - prepares pending continuation prompts

Tauri overlay
  - starts or verifies the bridge server
  - renders status cards from bridge session state
  - focuses the target CLI window
  - opens linked notes/canvas files
  - copies pending continuation prompts

Obsidian plugin
  - renders and edits annotation markers inside Markdown
  - extracts annotations from the active note
  - sends annotation payloads to the AMO bridge
```

### Bridge Ownership

The current Node broker should evolve into the bridge instead of creating a separate service.

Current broker API remains:

```text
GET  /api/health
GET  /api/sessions
POST /api/events
POST /api/sessions/:id/heartbeat
```

Phase 5 bridge API adds:

```text
POST /api/workspaces/inspect
POST /api/workspaces/enroll
POST /api/workspaces/:id/disable
POST /api/replies
POST /api/obsidian/register-vault
POST /api/obsidian/annotations
POST /api/obsidian/open-note
POST /api/obsidian/open-canvas
POST /api/sync-back
GET  /api/config
POST /api/config
```

The smallest useful first implementation can start with only:

```text
POST /api/workspaces/inspect
POST /api/workspaces/enroll
POST /api/replies
POST /api/obsidian/annotations
GET  /api/sessions
POST /api/events
```

## Contracts

### Workspace Enrollment

The bridge should model hook installation as an explicit project-folder operation.

Inspect request:

```json
{
  "schemaVersion": 1,
  "workspacePath": "D:\\Projects\\SomeProject"
}
```

Inspect response:

```json
{
  "ok": true,
  "workspacePath": "D:\\Projects\\SomeProject",
  "detected": [
    {
      "tool": "codex",
      "confidence": "high",
      "reason": "folder has .codex or Codex transcript/config hints",
      "adapter": "codex-stop-hook",
      "scope": "project-local",
      "filesToWrite": [
        ".codex/hooks.json",
        ".codex/hooks/cache-stop-message.mjs"
      ],
      "risks": [
        "Codex hook runner behavior still needs local smoke validation"
      ]
    }
  ]
}
```

Enrollment must be explicit. A future overlay flow can show the detected adapter plan and require the user to confirm before writing project-local files.

Enrollment response:

```json
{
  "ok": true,
  "workspaceId": "workspace-id",
  "workspacePath": "D:\\Projects\\SomeProject",
  "tool": "codex",
  "adapter": "codex-stop-hook",
  "scope": "project-local",
  "installedFiles": [
    ".codex/hooks.json",
    ".codex/hooks/cache-stop-message.mjs"
  ]
}
```

The bridge should reject global hook installation requests by default.

### Reply Capture

Hook to bridge:

```json
{
  "schemaVersion": 1,
  "tool": "codex",
  "source": "codex-stop-hook",
  "sessionId": "session-id",
  "turnId": "turn-id",
  "cwd": "D:\\Projects\\SomeProject",
  "model": "gpt-5.5",
  "hookEventName": "Stop",
  "transcriptPath": "optional path",
  "capturedAt": "2026-05-13T00:00:00.000Z",
  "message": "assistant reply body"
}
```

Bridge response:

```json
{
  "ok": true,
  "sessionId": "session-id",
  "notePath": "Codex Replies/2026-05/2026-05-13_001_codex_reply.md",
  "canvasPath": "AgentFlow.canvas",
  "canvasNodeId": "amo-node-..."
}
```

### Reply Note

Bridge-generated Markdown should use frontmatter so the Obsidian plugin and the overlay can associate the note with the originating session.

```md
---
amo:
  schemaVersion: 1
  tool: codex
  sessionId: session-id
  turnId: turn-id
  cwd: D:\Projects\SomeProject
  source: codex-stop-hook
  capturedAt: 2026-05-13T00:00:00.000Z
  transcriptPath: optional path
---

# Codex Reply

assistant reply body
```

### Canvas Attachment

Use file nodes for reply notes. Do not put long assistant replies directly into canvas text nodes.

Recommended vault shape:

```text
Vault/
  AgentFlow.canvas
  Codex Replies/
    2026-05/
      2026-05-13_001_codex_reply.md
```

The first layout can be simple append-only placement:

- Add each reply as a file node.
- Link it from the previous node for the same session when available.
- Place the next node from the previous session node's actual canvas position and size, using the configured append direction.
- The default append direction is down (`bottom -> top` edges); users can switch to right (`right -> left` edges) in the Obsidian plugin settings.
- Avoid editing or re-layouting unrelated user canvas content.
- Automatic layout/re-layout is a later Obsidian-plugin optimization, not part of the current append-only MVP.

### Annotation Extraction

Obsidian plugin to bridge:

```json
{
  "schemaVersion": 1,
  "source": "obsidian-md-anno-tools",
  "vaultRoot": "D:\\Projects\\CommonProject\\obsidianplugintestvault",
  "notePath": "Codex Replies/2026-05/2026-05-13_001_codex_reply.md",
  "sessionId": "session-id",
  "turnId": "turn-id",
  "annotations": [
    {
      "index": 1,
      "content": "annotation body"
    }
  ]
}
```

Bridge response:

```json
{
  "ok": true,
  "sessionId": "session-id",
  "pendingPromptId": "prompt-id",
  "prompt": "Continue based only on these annotations..."
}
```

### Sync Back

Phase 5 sync-back must be explicit and user-controlled.

Recommended first action:

```text
Copy pending prompt -> focus target CLI window -> user pastes or presses Enter manually
```

Do not auto-send, auto-approve, or auto-press Enter in the first implementation.

Pending prompt text rule: the bridge should not inject task instructions, source-note metadata, turn ids, or policy text into the CLI prompt. The default generated prompt should contain only user-authored annotation content, plus an optional user-authored summary when the plugin explicitly sends one. Annotation numbering is off by default because each annotation block should already carry its own human-authored context; the Obsidian plugin exposes a setting to re-enable `1.`, `2.`, `3.` prefixes when needed. If the user wants extra context or instructions, they should write that into the annotation itself.

When a pending prompt is copied/focused back to a CLI, the broker records the outgoing user-authored prompt as a prompt note under `Prompts/` and appends it to `AgentFlow.canvas` on the same session chain. Project-local Codex deployment also registers `UserPromptSubmit`, so prompts typed directly in the CLI can enter the same note/canvas chain when the hook payload includes the submitted `prompt`.

Window binding follow-up: when `Copy + Focus CLI` or card activation finds multiple candidate windows, the candidate menu should include a default-on `Bind this window` option. Selecting a candidate with binding enabled records the validated `hwnd`/`processId` on the session window hint, so later sync/open actions can route directly. The task card must also expose an explicit unbind/rebind path for mistakes or stale windows. If the bound window disappears or validation fails, AMO should fall back to the candidate menu instead of guessing.

## Overlay Changes

The overlay should keep the existing session cards and add small actions when bridge metadata exists:

- `Focus CLI`
- `Open Note`
- `Open Canvas`
- `Copy Pending Prompt`
- `Bind/Unbind Window` when routing is ambiguous or a manual binding exists

For the interim overlay-only path, `Open Note` and `Open Canvas` may use `obsidian://open` with `paneType=tab` so opening a canvas does not replace the currently active note. This is only a fallback. Precise behavior for "if the target note/canvas is already open, focus that existing tab; otherwise open a new tab" belongs in the Obsidian plugin because the external URI layer cannot reliably inspect or control Obsidian workspace leaves.

The current fallback registers the project-local `.amo/obsidian-vault/` in Obsidian's vault registry before opening by vault id and vault-relative file path. This fixes `Vault not found` after the vault is known to Obsidian, but user smoke confirmed that if Obsidian is already running when a brand-new AMO vault is registered, Obsidian must be restarted once before the external URI layer sees that vault. That restart requirement is an MVP limitation only. The Obsidian plugin stage should remove it by owning AMO note/canvas opening inside Obsidian itself instead of relying on registry writes plus external URI reload behavior.

Card state can show:

- linked note path
- linked canvas path
- pending annotation count
- last reply age
- whether sync-back prompt is waiting
- whether a manual or exact window binding exists

## Bridge Launch Behavior

Preferred Phase 5 path:

```text
overlay starts
  -> GET http://127.0.0.1:17654/api/health
  -> if unavailable, launch the Node bridge/broker
  -> overlay keeps polling sessions
```

This keeps the current Node broker useful and avoids rewriting the bridge into Rust before the workflow is proven.

Later, after the workflow is stable, the bridge can become a bundled Tauri sidecar or be moved into the Rust backend.

## Guardrails

- Listen only on `127.0.0.1`.
- Never bind to `0.0.0.0` by default.
- Do not install global hooks in Phase 5.
- Hook and adapter deployment must start from a user-selected workspace folder.
- Write only project-local hook/adapter files after explicit confirmation.
- Inspect folder contents before choosing an adapter path.
- Keep per-workspace enrollment state visible and reversible.
- Restrict vault writes to configured `vaultRoot`.
- Reject paths that escape `vaultRoot`.
- Set a body size limit for reply payloads.
- Write notes and canvas files atomically where practical.
- Keep hook stdout protocol-clean.
- Keep hook POST failures non-blocking.
- Keep `.codex/cache/`, `broker/data/`, `tmp/`, logs, and build output out of commits.
- Obsidian plugin actions that send annotations to AMO should be explicit user commands.
- Do not make Obsidian/canvas the primary AMO data model; keep them as a sidecar workflow.

## Iteration Plan

### Phase 5.0: Documentation And Contract

- Record this bridge design in repo docs.
- Update project plan and supervisor status from "future Obsidian direction" to "next Phase 5 bridge MVP".
- Keep current dirty implementation changes separate from documentation commits.

### Phase 5.1: Bridge Reply Endpoint

- Add manual workspace inspection/enrollment for a selected folder.
- Follow the deterministic deployment contract in `docs/adapter-deployment-guide.md`.
- Support only `codex-cli` for the first MVP.
- Create project-local `.amo/` and `.amo/obsidian-vault/`.
- Reject global hook deployment by default.
- Add `POST /api/replies` to the existing broker.
- Persist reply notes into `.amo/obsidian-vault/Replies/`.
- Update session snapshot with `lastReplyNote`, `canvasPath`, and `lastReplyAt`.
- Keep `.codex/cache/` fallback in the hook script.

### Phase 5.2: Canvas Append

- Add append-only `.canvas` file node creation.
- Add edges for same-session flow.
- Avoid full canvas re-layout.

### Phase 5.3: Overlay Actions

- Add note/canvas buttons to session cards.
- Add pending prompt state and `Copy + Focus CLI`.
- Keep auto-paste and auto-submit out of scope.

### Phase 5.4: Obsidian Plugin Bridge Command

- Own AMO note/canvas open behavior inside Obsidian instead of relying on `obsidian://open`.
- Reuse an existing leaf when the target note or canvas is already open.
- Open the target in a new tab only when no existing leaf is found.
- Remove the first-open restart requirement for newly enrolled AMO vaults; plugin-side opening should work without asking the user to restart Obsidian after deployment.
- Add command: `Send current note annotations to AMO`.
- Extract `[!anno]...[/anno]` from the active note.
- Read AMO frontmatter if present.
- POST annotations to the bridge.
- Preserve the existing "copy annotations to clipboard" command.

Current implementation status: workspace enroll writes a vault-local `md-anno-tools` plugin under `.amo/obsidian-vault/.obsidian/plugins/`, enables it in `community-plugins.json`, stores the bridge URL in plugin `data.json`, adds `Send current note annotations to AMO`, and registers `obsidian://amo-open` so overlay note/canvas buttons can ask the plugin to reuse an existing tab before opening a new one. The plugin can also target a Markdown note selected as a file node on `AgentFlow.canvas` for panel/copy/send/append actions; canvas targeting now prefers the current canvas selection and only falls back to the last clicked file node if no selection can be read, so actions should not silently drift to a previous node. The AMO panel keeps canvas target context even while the panel itself is the active leaf, and panel Copy/Send buttons operate on the note currently displayed in the panel rather than re-resolving Obsidian's active Markdown view at click time. If Obsidian's canvas selection cannot be read reliably, the plugin should ask the user to choose one of the Markdown file nodes from the canvas instead of silently using a stale target. Editor selection insertion now creates a quoted annotation block instead of wrapping the selected source text, so a selected question title becomes quoted context and the user's answer can be written underneath. If the user is in reading mode, the plugin can append the current DOM text selection as a referenced annotation block because there is no editable cursor location. Annotation rendering supports both inline `[!anno]...[/anno]` and multi-block annotations. The stable path is now source-backed and lifecycle-managed: the Markdown postprocessor uses `sourcePath` and `getSectionInfo` to map each rendered section back to the source file, renders one plugin-owned `MarkdownRenderChild` for the annotation start section, and hides the remaining annotation sections. This avoids treating cross-section DOM ranges as durable state in note read/edit/read and canvas embedded previews. The plugin setting `Number annotations in sync prompt` defaults off; when off, pending prompts use raw annotation content without broker-added numbering. The plugin setting `Canvas note append direction` defaults to down and can switch to right; broker reads that vault-local setting when adding new reply/prompt file nodes and writes explicit canvas edge sides. The previous delayed DOM repair helpers were removed from the primary plugin path because they hid symptoms while still fighting Obsidian's renderer ownership. The custom `amo-open` URI intentionally passes only a vault-relative `path` and `kind`, not `vault=...`, because Obsidian resolves the `vault` parameter before the plugin protocol handler can run. Obsidian may still require a vault reload/restart before a newly deployed plugin is loaded; removing that first-load friction is part of the plugin-side opening/reload UX follow-up.

### Debug Logging

The MVP now has a shared debug channel for this exact class of "works once, then drifts" bugs:

- Broker owns the runtime switch and in-memory log buffer with `GET /api/debug`, `POST /api/debug`, `POST /api/debug/logs`, and `POST /api/debug/clear`.
- Overlay exposes the switch in the header. When enabled, it logs open-note/open-canvas, copy/sync-back, window activation, window binding, workspace inspect, and workspace enroll actions.
- The Obsidian plugin posts best-effort debug events to the broker for plugin load, canvas target tracking, canvas Send/Panel actions, annotation extraction/frontmatter/send, and annotation render/rescan passes.
- The broker also logs the server-side half of replies, annotation payloads, sync-back, vault registration, workspace enroll, and window binding while debug is enabled.

Debug logging is intentionally temporary and local: it is not persisted to the session snapshot, and the overlay toggle should stay off during normal use. For reproduction, enable debug in overlay, run the exact failing Obsidian operation, then inspect `GET /api/debug?limit=200`.

Current health check: once a task card links to a vault, broker decorates the session with `obsidianPluginHealth`, including installed `md-anno-tools` version, enabled state, `main.js` presence, and plugin `data.json` bridge URL. Overlay surfaces the result as a compact plugin status pill on the card. Follow-up repair flow: mismatches should offer repair/redeploy from the card or deploy/check panel.

### Phase 5.5: End-To-End Smoke

Manual acceptance path:

1. Start overlay.
2. Overlay starts or verifies bridge server.
3. User selects a project folder to enroll.
4. AMO inspects the folder and shows the detected local adapter plan.
5. User confirms project-local hook/adapter installation.
6. Start Codex or another supported CLI/TUI in the enrolled project.
7. Ask a prompt.
8. Stop hook or equivalent local adapter caches and POSTs the assistant reply.
9. Bridge creates a reply note in the test vault.
10. Bridge appends the reply note to the canvas.
11. Overlay card shows `Open Note` / `Open Canvas`.
12. User adds `[!anno]...[/anno]` in Obsidian.
13. Obsidian plugin sends annotations to AMO.
14. Overlay shows pending continuation.
15. User clicks `Copy + Focus CLI`.
16. Bridge records the outgoing prompt as a `Prompts/` note and chains it after the latest canvas node.
17. Target CLI receives focus and the prompt is in clipboard.
18. Codex `UserPromptSubmit` can also record directly typed CLI prompts into the same chain.

Permission request MVP behavior: project-local Codex deployment also registers `PermissionRequest`. The hook posts an event-only payload to the broker; the broker marks the task card `waiting_permission` / `needsAttention`; overlay shows a compact permission prompt on the card. The user should click the card to return to the CLI/TUI and manually approve or deny the request there. AMO does not auto-approve permissions in this MVP.

## Out Of Scope For The First Bridge MVP

- Automatic paste or Enter into CLI.
- Automatic permission approval.
- Global hook deployment.
- Silent hook/adapter installation without selecting a workspace folder.
- Full historical event database.
- Rich anchored comments mapped to exact Markdown source ranges.
- Multi-vault routing.
- Team/cloud synchronization.
- Editing Obsidian notes inside the overlay.
- Replacing the user's normal CLI with an embedded terminal.

## Next Agent Startup Note

When continuing this work, read these files first:

1. `DEVELOPMENT.md`
2. `docs/supervisor-status.md`
3. `PROJECT_PLAN.md`
4. `docs/amo-obsidian-bridge-mvp.md`
5. `docs/adapter-deployment-guide.md`
6. `docs/reference-mvps/obsidianplugintest/README.md`
7. `docs/reference-mvps/obsidianplugintest/handoff/CODEX_REPLY_NOTE_HOOK_INTEGRATION.md`
8. `docs/reference-mvps/obsidianplugintest/handoff/OBSIDIAN_ANNOTATION_PLUGIN_DEVELOPMENT.md`
9. Optional live source, if present on the current machine: `D:\Projects\CommonProject\obsidianplugintest\docs\CODEX_REPLY_NOTE_HOOK_INTEGRATION.md`
10. Optional live source, if present on the current machine: `D:\Projects\CommonProject\obsidianplugintest\docs\OBSIDIAN_ANNOTATION_PLUGIN_DEVELOPMENT.md`

Current instruction:

- Treat Phase 5 as Hook-to-Obsidian Bridge MVP.
- Reuse the existing broker as the bridge server first.
- Treat hook deployment as manual workspace enrollment, not global installation.
- Current MVP is Codex CLI only, one selected project folder, project-local `.amo/obsidian-vault/`, one `AgentFlow.canvas`, and explicit `Copy + Focus CLI`.
- Keep hooks short and protocol-clean.
- Keep Obsidian mutation vault-native and explicit.
- Keep sync-back to `copy + focus target CLI` until the user explicitly accepts stronger automation.
