# AMO Obsidian Bridge MVP

Updated: 2026-05-13

This document is the current control design for moving Agent Monitor Overlay from a pure session monitor into a small local bridge between agent hooks, the overlay, and an Obsidian reading/canvas workflow.

## Current Decision

The next product shape is:

```text
Codex / Claude / Kiro hooks
  -> AMO local bridge server
  -> overlay session status and window focus
  -> Obsidian vault notes and canvas flow
  -> annotation extraction
  -> copy + focus back to the target CLI session
```

The overlay should remain the visible status and jump surface. It should also launch or supervise a small local bridge server. The bridge server is the handoff point between short-lived hooks, vault file writes, Obsidian plugin actions, and overlay UI state.

The Obsidian workflow is no longer only a distant future idea. Two local MVPs have made the Phase 5 direction concrete:

- `D:\Projects\CommonProject\obsidianplugintest\docs\CODEX_REPLY_NOTE_HOOK_INTEGRATION.md`
- `D:\Projects\CommonProject\obsidianplugintest\docs\OBSIDIAN_ANNOTATION_PLUGIN_DEVELOPMENT.md`

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
- Wrap selected editor text in `[!anno]...[/anno]` from the editor context menu.
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
POST /api/replies
POST /api/obsidian/annotations
POST /api/obsidian/open-note
POST /api/obsidian/open-canvas
POST /api/sync-back
GET  /api/config
POST /api/config
```

The smallest useful first implementation can start with only:

```text
POST /api/replies
POST /api/obsidian/annotations
GET  /api/sessions
POST /api/events
```

## Contracts

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
- Place the next node to the right of the previous session node.
- Avoid editing or re-layouting unrelated user canvas content.

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

## Overlay Changes

The overlay should keep the existing session cards and add small actions when bridge metadata exists:

- `Focus CLI`
- `Open Note`
- `Open Canvas`
- `Copy Pending Prompt`

Card state can show:

- linked note path
- linked canvas path
- pending annotation count
- last reply age
- whether sync-back prompt is waiting

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

- Add `POST /api/replies` to the existing broker.
- Persist reply notes into a configured vault.
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

- Add command: `Send current note annotations to AMO`.
- Extract `[!anno]...[/anno]` from the active note.
- Read AMO frontmatter if present.
- POST annotations to the bridge.
- Preserve the existing "copy annotations to clipboard" command.

### Phase 5.5: End-To-End Smoke

Manual acceptance path:

1. Start overlay.
2. Overlay starts or verifies bridge server.
3. Start Codex in a hooked project.
4. Ask a prompt.
5. Stop hook caches and POSTs the assistant reply.
6. Bridge creates a reply note in the test vault.
7. Bridge appends the reply note to the canvas.
8. Overlay card shows `Open Note` / `Open Canvas`.
9. User adds `[!anno]...[/anno]` in Obsidian.
10. Obsidian plugin sends annotations to AMO.
11. Overlay shows pending continuation.
12. User clicks `Copy + Focus CLI`.
13. Target CLI receives focus and the prompt is in clipboard.

## Out Of Scope For The First Bridge MVP

- Automatic paste or Enter into CLI.
- Automatic permission approval.
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
5. `D:\Projects\CommonProject\obsidianplugintest\docs\CODEX_REPLY_NOTE_HOOK_INTEGRATION.md`
6. `D:\Projects\CommonProject\obsidianplugintest\docs\OBSIDIAN_ANNOTATION_PLUGIN_DEVELOPMENT.md`

Current instruction:

- Treat Phase 5 as Hook-to-Obsidian Bridge MVP.
- Reuse the existing broker as the bridge server first.
- Keep hooks short and protocol-clean.
- Keep Obsidian mutation vault-native and explicit.
- Keep sync-back to `copy + focus target CLI` until the user explicitly accepts stronger automation.
