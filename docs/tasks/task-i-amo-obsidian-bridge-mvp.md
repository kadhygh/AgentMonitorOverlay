# Task: AMO Obsidian Bridge MVP

Owner: supervisor-agent / future implementation worker
Stage: Phase 5
Status: planned

## Goal

Implement the first AMO bridge slice that connects Codex reply hooks, overlay session state, Obsidian reply notes, canvas flow, annotation extraction, and safe CLI sync-back.

## Inputs

- `docs/amo-obsidian-bridge-mvp.md`
- `docs/session-handoffs/2026-05-13-amo-obsidian-bridge-pivot.md`
- `D:\Projects\CommonProject\obsidianplugintest\docs\CODEX_REPLY_NOTE_HOOK_INTEGRATION.md`
- `D:\Projects\CommonProject\obsidianplugintest\docs\OBSIDIAN_ANNOTATION_PLUGIN_DEVELOPMENT.md`

## Scope

First implementation slice:

- Extend existing `broker/server.js` into an AMO bridge without replacing existing session APIs.
- Add `POST /api/replies`.
- Write reply notes into a configured disposable/test Obsidian vault.
- Update session snapshots with reply note metadata.
- Keep hook cache fallback and protocol-clean stdout when integrating hook scripts.

Follow-up slices:

- Append reply notes as file nodes into an Obsidian `.canvas`.
- Add overlay card actions for `Open Note`, `Open Canvas`, and `Copy Pending Prompt + Focus CLI`.
- Add Obsidian plugin command to send `[!anno]...[/anno]` annotations to AMO.
- Add `POST /api/obsidian/annotations` and pending continuation prompt state.

## Non-Goals

- Do not auto-paste or auto-submit into the CLI.
- Do not implement auto approval.
- Do not rewrite the bridge in Rust before the Node bridge workflow is proven.
- Do not make Obsidian/canvas the primary AMO data model.
- Do not implement rich anchored annotation comments yet.
- Do not mutate real user vault files without an explicit configured test vault or user confirmation.

## Acceptance

The first slice is complete when:

- `POST /api/replies` accepts a Codex Stop-hook-like payload.
- Bridge writes a Markdown note with AMO frontmatter into the configured vault.
- `GET /api/sessions` exposes `lastReplyNote`, `lastReplyAt`, and `canvasPath` when available.
- Existing broker event/session behavior still passes its verification script.
- Hook failure remains non-blocking and hook stdout remains protocol-clean.

End-to-end Phase 5 acceptance:

- Codex reply creates a note.
- Canvas gets a linked file node.
- Overlay opens the note/canvas.
- Obsidian plugin extracts annotations and sends them to AMO.
- Overlay copies a pending continuation prompt and focuses the target CLI.
