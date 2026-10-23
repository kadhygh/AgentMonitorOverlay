# Task: AMO Obsidian Bridge MVP

Owner: supervisor-agent / future implementation worker
Stage: Phase 5
Status: current MVP baseline

## Goal

Implement the first AMO bridge slice that connects manually enrolled workspace-local adapters/hooks, overlay session state, Obsidian reply notes, canvas flow, annotation extraction, and safe CLI sync-back.

Current MVP target:

- Codex CLI plus Claude CLI workspace-local hooks.
- Codex App as an accepted target-binding provider.
- One selected project folder.
- Project-local `.amo/`.
- Dedicated `.amo/AMO - <project>/` vault.
- One default `.amo/AMO - <project>/Canvases/AgentFlow.base.canvas`.
- Prompt/reply notes under `.amo/AMO - <project>/Sessions/<session-id>/turns/generated/`.

## Inputs

- `docs/amo-obsidian-bridge-mvp.md`
- `docs/adapter-deployment-guide.md`
- `docs/session-handoffs/2026-05-13-amo-obsidian-bridge-pivot.md`
- `D:\Projects\CommonProject\obsidianplugintest\docs\CODEX_REPLY_NOTE_HOOK_INTEGRATION.md`
- `D:\Projects\CommonProject\obsidianplugintest\docs\OBSIDIAN_ANNOTATION_PLUGIN_DEVELOPMENT.md`

## Scope

First implementation slice:

- Extend existing `broker/server.js` into an AMO bridge without replacing existing session APIs.
- Add script-driven workspace inspect/enroll for a user-selected project folder.
- Detect likely CLI/TUI adapter options from folder contents and local tool configuration.
- Produce an inspect/deployment plan before writing files.
- Support `codex-cli` and `claude-cli` in the current MVP.
- Keep Codex App as a target-binding/launch provider, not as a Codex CLI hook clone.
- Create `.amo/`, `.amo/enrollment.json`, `.amo/hooks/`, `.amo/state/`, and `.amo/AMO - <project>/`.
- Reject global hook deployment by default.
- Add `POST /api/replies`.
- Write reply notes into the project-local `.amo/AMO - <project>/Sessions/<session-id>/turns/generated/`.
- Update session snapshots with reply note metadata.
- Keep hook cache fallback and protocol-clean stdout when integrating project-local hook scripts.

Follow-up slices:

- Append reply notes as file nodes into `Canvases/AgentFlow.base.canvas`.
- Add overlay card actions for `Open Note` and `Open Canvas`.
- Add Obsidian plugin command to send `[!anno]...[/anno]` annotations to AMO.
- Add `POST /api/obsidian/annotations`, pending continuation prompt state, and overlay automatic copy+focus after Obsidian `Send to AMO`.
- Keep multi-CLI canvas shortcuts and advanced work-canvas promote behavior parked until real usage calls for them.

## Non-Goals

- Do not auto-paste or auto-submit into the CLI/App. Automatic clipboard copy and window focus after `Send to AMO` are allowed.
- Do not implement auto approval.
- Do not install global hooks.
- Do not silently install hooks or adapters without a user-selected workspace folder.
- Do not rely on an LLM to decide deployment file writes during normal operation.
- Do not treat `windowHint.pid` as valid unless it is a verified visible-window owner pid.
- Do not rewrite the bridge in Rust before the Node bridge workflow is proven.
- Do not make Obsidian/canvas the primary AMO data model.
- Do not implement rich anchored annotation comments yet.
- Do not mutate a user's existing Obsidian vault in the first MVP; use the project-local `.amo/obsidian-vault/`.

## Acceptance

The first slice is complete when:

- `POST /api/workspaces/inspect` or equivalent local function can inspect a selected folder and report candidate adapter plans.
- Inspect reports `codex-cli` and `claude-cli` availability. Codex App may appear as an app target provider. Kiro IDE should not be presented as an active roadmap item.
- Enrollment writes only project-local hook/adapter files after explicit confirmation.
- Enrollment creates `.amo/` and `.amo/AMO - <project>/`.
- Global hook deployment is rejected or absent from the product path.
- `POST /api/replies` accepts a Codex Stop-hook-like payload.
- Bridge writes a Markdown note with a hidden AMO marker into `.amo/AMO - <project>/Sessions/<session-id>/turns/generated/`.
- `GET /api/sessions` exposes `lastReplyNote`, `lastReplyAt`, and `canvasPath` when available.
- Existing broker event/session behavior still passes its verification script.
- Hook failure remains non-blocking and hook stdout remains protocol-clean.

End-to-end Phase 5 acceptance:

- User selects and enrolls a project folder.
- Codex CLI workspace-local adapter captures a reply and creates a note.
- Canvas gets a linked file node.
- Overlay opens the note/canvas.
- Obsidian plugin extracts annotations and sends them to AMO.
- Overlay automatically copies a pending continuation prompt and focuses the target CLI/App.
- User manually pastes/submits; AMO does not auto-paste, press Enter, or approve prompts.
