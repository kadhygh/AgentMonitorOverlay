# 2026-05-13 AMO Obsidian Bridge Pivot

This handoff records the product direction change after two external MVPs made the Obsidian workflow concrete enough to become the next AMO phase.

## Context

The previous repo state treated Obsidian workflow integration as future sidecar work. The current user-validated direction is different:

- Keep the floating overlay.
- Keep hooks as the primary status source.
- Let the overlay launch or supervise a small local bridge server.
- Let the bridge connect hooks, overlay state, Obsidian reply notes, canvas flow, annotation extraction, and safe CLI sync-back.

## External MVP Evidence

Read these documents before implementation:

- `D:\Projects\CommonProject\obsidianplugintest\docs\CODEX_REPLY_NOTE_HOOK_INTEGRATION.md`
- `D:\Projects\CommonProject\obsidianplugintest\docs\OBSIDIAN_ANNOTATION_PLUGIN_DEVELOPMENT.md`
- Repo-local snapshot: `docs/reference-mvps/obsidianplugintest/`

Useful confirmed facts from the Codex hook MVP:

- Codex `Stop` hook fires after a completed assistant reply.
- `Stop` payload includes `last_assistant_message`.
- Hook stdout should stay protocol-clean and return `{"continue":true}`.
- The hook can cache Markdown/JSON into `.codex/cache/`.
- Useful fields are `capturedAt`, `sessionId`, `turnId`, `model`, `hookEventName`, `cwd`, `transcriptPath`, `stopHookActive`, and `message`.

Useful confirmed facts from the Obsidian plugin MVP:

- Plugin id is `md-anno-tools`.
- Annotation syntax is `[!anno]...[/anno]`.
- Reading mode rendering, editor wrapping, append annotation, and copy annotation commands already work in the external MVP.
- Phase 5 should add a new explicit command to send current note annotations to AMO.

## New Phase

Current phase:

```text
Phase 5 Hook-to-Obsidian Bridge MVP
```

Main local design doc:

```text
docs/amo-obsidian-bridge-mvp.md
```

The existing Node broker should be evolved into the AMO bridge first. Do not rewrite the bridge into Rust before the workflow is proven.

## Bridge Shape

Keep existing broker endpoints:

```text
GET  /api/health
GET  /api/sessions
POST /api/events
POST /api/sessions/:id/heartbeat
```

Add smallest first endpoint:

```text
POST /api/replies
```

Later Phase 5 endpoints:

```text
POST /api/obsidian/annotations
POST /api/obsidian/open-note
POST /api/obsidian/open-canvas
POST /api/sync-back
GET  /api/config
POST /api/config
```

## Intended First Workflow

1. Start overlay.
2. Overlay verifies or launches bridge server.
3. User selects a project folder to enroll.
4. AMO inspects the folder and shows the detected project-local adapter/hook plan.
5. User confirms enrollment; AMO writes only project-local hook/adapter files.
6. Start Codex or another supported CLI/TUI in the enrolled project.
7. User asks a prompt.
8. Stop hook or equivalent workspace-local adapter caches the reply and POSTs it to AMO bridge.
9. Bridge writes a Markdown reply note into a configured Obsidian test vault.
10. Bridge appends a file node to an Obsidian canvas.
11. Overlay session card exposes `Open Note` and `Open Canvas`.
12. User adds `[!anno]...[/anno]` in Obsidian.
13. Obsidian plugin sends extracted annotations to AMO.
14. Bridge creates a pending continuation prompt.
15. Overlay copies the prompt and focuses the target CLI.
16. User manually pastes/submits.

## Guardrails

- Keep Obsidian as a sidecar workflow, not the primary AMO data model.
- Do not deploy global hooks in Phase 5.
- Hook/adapter setup starts from a user-selected project folder.
- AMO should inspect folder contents and local tool configuration before choosing an adapter path.
- Enrollment writes only project-local files and must be reversible.
- Hook failures must not block Codex turns.
- Hook stdout must not include debug text.
- Keep `.codex/cache/` as fallback.
- First sync-back is `copy + focus target CLI`, not auto-paste or auto-submit.
- Vault writes must be restricted to configured `vaultRoot`.
- Canvas updates should be append-only and avoid re-layouting unrelated user content.
- Obsidian annotation send should be an explicit user command.

## Docs Updated In This Checkpoint

- `PROJECT_PLAN.md`
- `DEVELOPMENT.md`
- `docs/supervisor-status.md`
- `docs/amo-obsidian-bridge-mvp.md`
- `docs/session-handoffs/2026-05-13-amo-obsidian-bridge-pivot.md`

## Next Implementation Slice

Recommended first implementation task:

```text
Add manual workspace inspect/enroll plus POST /api/replies to broker/server.js, backed by a simple bridge config for test vault output.
```

Acceptance for that slice:

- `node --check broker\server.js`
- `npm run broker:verify` still passes
- selected-folder inspect reports a project-local adapter plan
- enrollment does not write global hook config
- manual POST to `/api/replies` writes a reply note under the configured test vault
- `GET /api/sessions` includes `lastReplyNote`, `lastReplyAt`, and `canvasPath` for the session

Only after that should canvas append, overlay buttons, and Obsidian plugin POST be added.
