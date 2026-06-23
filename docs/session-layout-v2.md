# AMO Session Layout v2

Updated: 2026-06-23

This document defines the next storage contract for AMO-generated Obsidian vault content. It is the migration target after the current flat `Replies/`, `Prompts/`, and root `AgentFlow.canvas` MVP.

## Goals

- Put each provider session behind a clear `Sessions/<session-id>/` boundary.
- Keep prompt and reply notes together in the same chronological turn stream.
- Separate machine-generated conversation artifacts from user-authored work canvases.
- Keep base canvas as a raw session flow and work canvas as the human organization surface.
- Avoid relying on Obsidian file names as durable identity; AMO metadata remains the source of truth.

## Vault Shape

New deployments should converge on this shape:

```text
.amo/
  workspace.json
  enrollment.json
  state/
    sessions.json
    bindings.json
    note-index.json
    canvas-index.json
  AMO - <project>/
    Sessions/
      <session-id>/
        session.json
        turns/
          generated/
            prompt 01.md
            reply 01.md
            prompt 02.md
            reply 02.md
        canvases/
          AgentFlow.base.canvas
    Canvases/
      AgentFlow.base.canvas
      Work/
        work 01.canvas
    .obsidian/
      plugins/
        md-anno-tools/
```

### `Sessions/<session-id>/`

This is the durable folder for one Codex, Claude, Kiro, or future adapter session. The physical folder name should be a sanitized form of the provider `sessionId`; the original session id remains in `session.json` and every generated note marker.

`session.json` records session-scoped metadata that is useful outside the broker snapshot:

```json
{
  "schemaVersion": 1,
  "workspaceId": "ws_xxx",
  "sessionId": "019e...",
  "tool": "codex",
  "workspacePath": "G:\\PROJECT\\SomeProject",
  "createdAt": "2026-06-23T00:00:00.000Z",
  "updatedAt": "2026-06-23T00:00:00.000Z"
}
```

### `turns/generated/`

This folder stores AMO-generated Markdown notes from hook or bridge events. It intentionally does not split `Replies/` and `Prompts/` into separate folders because the user's reading flow is chronological:

```text
prompt 01.md
reply 01.md
prompt 02.md
reply 02.md
```

The note marker remains the durable identity layer:

```md
<!-- amo: {"schemaVersion":1,"noteId":"note_xxx","workspaceId":"ws_xxx","sessionId":"019e...","kind":"reply","role":"assistant","sequence":1,"displayName":"reply 01","turnId":"019e...","tool":"codex"} -->
```

The note index should map both `noteId -> notePath` and `notePath -> noteId` so future renames, display titles, and canvas promotion do not depend on physical filenames.

### `canvases/`

Session-local canvases are optional projections. The first v2 implementation can keep a single `AgentFlow.base.canvas` here if it is useful for a per-session raw flow. If workspace-level `Canvases/AgentFlow.base.canvas` is enough, this folder may be created lazily.

## Workspace Canvases

Workspace-level canvases live outside individual sessions:

```text
Canvases/
  AgentFlow.base.canvas
  Work/
    work 01.canvas
```

`AgentFlow.base.canvas` is the append-only raw flow. It is allowed to be visually messy because its job is provenance and chronology.

Work canvases are user-facing organization surfaces. They should contain promoted references to selected generated notes, user-created notes, groups, and manual relationships. They are not the primary log.

## Base Canvas

Base canvas behavior:

- Every generated prompt/reply note can be appended to the base canvas.
- Edges represent the known session sequence at the time of insertion.
- The broker may write JSON Canvas nodes and edges.
- The broker should not re-layout user-edited canvas content.
- The Obsidian plugin may add lightweight AMO-only affordances only after checking the canvas metadata marker.

Required metadata:

```json
{
  "amo": {
    "schemaVersion": 2,
    "canvasType": "agent-flow-base",
    "managedBy": "agent-monitor-overlay",
    "workspaceId": "ws_xxx",
    "layoutVersion": 2
  }
}
```

## Work Canvas Promote

Promote is an explicit user action. It copies or links selected generated notes from the base flow into a work canvas so the user can organize planning, branch points, decisions, and follow-up tasks.

Initial promote action:

```text
selected generated note
  -> choose or create work canvas
  -> add file node reference
  -> preserve AMO note metadata
  -> optionally copy selected base-canvas edges when both endpoints are promoted
```

Deferred promote behaviors:

- Promote a contiguous range from base canvas.
- Promote a group plus its internal links.
- Promote annotations as separate decision notes.
- Auto-layout the promoted subset.
- Multi-session work canvas quick-jump controls.

## Compatibility

No production migration is required yet. Existing test projects can be deleted and redeployed. During the transition, code may still understand the old flat shape:

```text
Replies/
Prompts/
AgentFlow.canvas
```

but new layout work should target v2. Once v2 lands, the broker should write new generated notes under:

```text
Sessions/<session-id>/turns/generated/
```

and new base canvases under:

```text
Canvases/AgentFlow.base.canvas
```

## Implementation Order

1. Add path helpers for v2 without changing existing write behavior.
2. Write new generated notes into `Sessions/<session-id>/turns/generated/`.
3. Write or mirror base canvas to `Canvases/AgentFlow.base.canvas`.
4. Update overlay and plugin open paths to consume `notePath` and `canvasPath` from broker state only, not hardcoded old folders.
5. Add work canvas promote as a separate explicit action.

## Guardrails

- Do not use PID/HWND as session identity.
- Do not infer AMO behavior from folder names alone; use metadata markers.
- Do not hide or rewrite Obsidian Canvas internals.
- Do not auto-promote every generated note to a work canvas.
- Do not make work canvas the canonical event log.
