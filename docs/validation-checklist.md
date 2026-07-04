# Validation Checklist

This checklist is maintained by the supervisor agent. It should only be handed to the user when there is a runnable build or a precise manual workflow to validate.

## Phase 1: Window Routing

Status: supervisor/user smoke validated for Codex/Mecho and Claude demo routing; ambiguity diagnostics still need polish

- Verify at least three different windows can be identified by title, process name, or explicit handle.
- Verify clicking a monitored session activates the intended window.
- Verify failure behavior when a target window is missing or ambiguous.
- Verify the proposed Codex / Claude / Kiro title naming convention fits the user's real workflow.
- Run `npm run demo:claude-routing`, then click the Claude live demo row in the overlay and confirm it routes to the PowerShell window with the `[AMO:claude:agent-monitor-overlay:live-demo]` title.
- Confirm the Claude demo row routes using the published `conhost.exe` PID when direct console HWND is unavailable.

## Phase 2: Broker MVP

Status: verified locally by supervisor; isolated verification script passes on 2026-05-08

- Start broker locally.
- POST mock Codex event.
- POST mock Claude event.
- POST mock Kiro event.
- Confirm `GET /api/sessions` returns unified session models.
- Restart broker and confirm persistence or documented rebuild behavior.

## Phase 3: Overlay MVP

Status: build verified locally; native overlay appeared in user smoke validation; current closeout priority is exact-route clarity, not card reorder

- Start overlay locally.
- Confirm window is always on top.
- Confirm broker-backed sessions refresh automatically every few seconds.
- Confirm the header says `broker live` when the broker is running; mock `NoHeartbeat` fallback should not appear in the demo.
- Confirm window can be dragged without disrupting the main workspace.
- Confirm 3-8 sessions remain readable.
- Confirm `waiting_user` and `waiting_permission` states are visible without feeling noisy.
- Confirm each row is easier to identify with the tool icon before the project/title.
- Confirm the row handle does not interfere with session activation; card reorder is intentionally disabled in the current Phase 3/4 closeout path.
- Confirm dragging from the overlay header moves the overlay window.
- Click a real exact-route session and confirm routing behavior or clear failure feedback.
- Confirm each session row shows a clear exact/token/fallback route hint.
- When multiple matching windows exist, confirm the candidate/debug panel appears instead of a vague failure message.
- When multiple matching windows exist, confirm clicking the intended candidate in the debug panel routes to the correct window.
- Dismiss a live session card and confirm it disappears from the overlay and the persisted broker snapshot.
- Trigger another real hook event for the same dismissed session and confirm the card returns automatically.
- After a Claude/Codex reply stop hook, confirm the card shows a green review prompt.
- Click `Seen`, `Note`, or `Canvas` and confirm the green review prompt clears.
- Trigger another user prompt/running hook and confirm any stale review prompt clears.

## Phase 4 Spike: Tool Adapters

Status: isolated adapter contract verification passes on 2026-05-08; Claude live hook smoke passed; Codex hook loading still pending

- Confirm Codex event payload can map to broker session model.
- Confirm Claude event payload can map to broker session model.
- Confirm Kiro route is either tested or explicitly marked as mock/manual for MVP.
- Confirm no global user tool configuration is changed without approval.
- Re-run Codex live smoke after choosing a safe hook loading route for the current Codex CLI.
- Prefer the first interactive smoke in a disposable test project or sibling repo so `/hooks` review state does not have to land in the main worktree first.
- Distinguish two outcomes during Codex smoke:
  - broker received the event
  - Codex hook runner completed without `hook failed` / timeout noise
- Claude live smoke is verified with disposable `--settings`.

## Phase 5: Obsidian Bridge MVP

Status: user smoke validated for the current Codex CLI MVP loop on 2026-05-20; prompt chaining and PermissionRequest behavior are confirmed working.

- Confirm Codex CLI reply hooks create reply notes under `Sessions/<session-id>/turns/generated/` and append them to `Canvases/AgentFlow.base.canvas`.
- Confirm Obsidian annotations create pending prompts without broker-added numbering by default.
- Confirm Obsidian `Send to AMO` automatically copies the pending prompt, focuses the target CLI/App, records outgoing prompt notes under the same session `turns/generated/` folder, and chains them after the latest canvas node.
- Confirm the target input is not auto-pasted or auto-submitted; the user still manually presses `Ctrl+V` and submits.
- Confirm direct Codex `UserPromptSubmit` payloads can enter the same prompt-note/canvas chain when available.
- Confirm Claude CLI deployment writes `.amo/hooks/claude-message.mjs`, `.amo/adapters/claude-cli.json`, and merges `.claude/settings.local.json`.
- Confirm Claude CLI `UserPromptSubmit` and `Stop` hooks create prompt/reply notes and append them to `Canvases/AgentFlow.base.canvas` without generated H1 headings.
- Confirm Claude CLI `PermissionRequest` events make the overlay card show the compact permission state and route the user back to the CLI for manual approval.
- Confirm PermissionRequest events make the overlay card show the compact permission state and route the user back to the CLI for manual approval.
- Confirm opening a canvas from an overlay card focuses the latest note node when present and falls back to a plain canvas jump when it is absent.
- Confirm broker appends prompt/reply nodes to `Canvases/AgentFlow.base.canvas` without corrupting the open canvas; if the canvas is already open, manual reopen/refresh is acceptable in the current safe MVP.
- Confirm prompt/reply canvas edges visibly connect the source and target nodes and include explicit `fromEnd: none` / `toEnd: arrow` endpoint data.
- Confirm newly enrolled AMO canvases include `amo.managedBy = agent-monitor-overlay` and `amo.canvasType = agent-flow-base`.
- Confirm new generated notes use chronological physical names such as `Sessions/<session-id>/turns/generated/001 prompt.md` and `Sessions/<session-id>/turns/generated/002 reply.md`.
- Confirm new reply/prompt notes use a hidden `<!-- amo: {...} -->` marker instead of visible YAML frontmatter.
- Confirm AMO note edit/source mode hides the hidden marker line while keeping it in the source file.
- Confirm broker `.amo/state/note-index.json` records the full metadata for new reply/prompt notes.
- Confirm new reply/prompt notes do not write a default `# reply xx` / `# prompt xx` H1.
- Confirm custom AMO display titles are stored in hidden metadata and rendered as an AMO header: custom title large, original document name small.
- Confirm note edit/source mode hides the marker line without preventing files from opening; editor-mode AMO title rendering is deferred until a safer CodeMirror approach is validated.
- Confirm the note view title action can update an AMO display title without renaming the note file.
- Confirm the canvas view title action can update the selected note's AMO display title without renaming the note file.
- Confirm AMO Markdown note views hide properties by default and can temporarily show them from the note action button.
- Confirm Canvas file-node previews may still show native properties in the current MVP, and the note-view property hiding does not affect Canvas zoom/drag/edge behavior.
- Confirm newly generated Canvas file-node previews no longer show AMO technical properties because new notes do not use visible frontmatter.
- Confirm annotations can be deleted from the AMO panel, from the note editor context menu/command when the cursor is inside `[!anno]...[/anno]`, and from the rendered annotation shell in note/canvas reading previews.
- Confirm AMO does not inject controls into canvas node DOM or override `.canvas-node` positioning; node property hiding is deferred until a safe canvas rendering design exists.
- Confirm each overlay card has a top-right workspace maintenance button whose status dot reflects plugin/vault health.
- Confirm the card maintenance panel shows `Sessions`, generated note counts, canvas counts, AMO canvas marker state, and plugin health.
- Confirm the maintenance panel can open the project/vault folders from the card.
- Confirm the maintenance panel cleanup action clears generated `Sessions/` note content, resets `Canvases/AgentFlow.base.canvas`, and clears canvas bindings without removing hooks, workspace enrollment metadata, or future work canvas folders.
- Confirm the deploy panel `Clear Generated` action performs the same generated-content cleanup for an enrolled workspace after a confirmation prompt, then leaves adapters/hooks deployed.

## Vibe Checks

Status: passed by user on 2026-05-07 and refreshed during 2026-05-08 to 2026-05-10 overlay smoke checks; minor details deferred

- The overlay should feel like a compact workbench, not a dashboard page.
- Waiting states should be noticeable but not attention-stealing.
- The default view should make active agent sessions legible at a glance.
- Collapse/expand behavior should support frequent context switching.
