# Canvas foundation — 2026-09-07

Status: foundation implemented and integrated. Automated regression and isolated browser acceptance passed; actual Windows desktop layering/focus smoke remains unverified.

## Scope

One local, cross-workspace task board, opened from the overlay in a nonmodal Canvas window. Add existing task references and text notes, move/select/remove nodes, connect/remove directed edges, pan/zoom, and durably restore layout. Live/archived/missing session references remain distinct from graph identity. Removing nodes never changes sessions. Groups, fork, orchestration, AI authorization, undo history, and multiple boards are later work.

## Shared contract

- Native label: `canvas`; component: `overlay/src/windows/CanvasWorkbenchApp.tsx`, named export `CanvasWorkbenchApp`.
- GET `/api/task-canvas` -> `{board}`.
- POST `/api/task-canvas` body `{operationId, expectedRevision, document}` -> `{board}`. Revision conflict HTTP 409; malformed input HTTP 400. Successful identical operation replay returns its committed result. No silent overwrite or automatic retry of conflicts.
- Board: `{schemaVersion:1, id:"default", revision:number, updatedAt:string|null, document}`.
- Document: `{nodes: CanvasNode[], edges: CanvasEdge[], viewport:{x:number,y:number,zoom:number}}`.
- Node: `{id:string, kind:"task"|"note", x:number, y:number, width:number, height:number, sessionId?:string, text?:string}`. Task nodes require sessionId; note nodes use text. IDs independent from sessions; bounded unique IDs, finite bounded geometry; max 500 nodes / 1000 edges, zoom 0.2..2.
- Edge: `{id:string, source:string, target:string}`; existing endpoints, no self links or duplicate directed pairs.
- Default document: empty nodes/edges and viewport `{x:0,y:0,zoom:1}`.
- GET `/api/task-canvas/sessions?ids=<comma-separated encoded IDs>` -> `{sessions:AgentSession[]}`; exact IDs, includes archived, omits missing. Limit 500. Use decorated existing session projection. No lifecycle mutation.
- Dedicated broker-owned `task-canvas.json` beside sessions data (optional `AGENT_MONITOR_TASK_CANVAS_DATA_FILE`). Persistence acknowledgement follows successful durable write; serialized commits. Keep a bounded persisted operation replay ledger. Corrupt storage must be visible, not silently replaced.
- UI uses explicit Save with dirty/saving/saved/error state, preserving edits on failure/conflict and offering explicit Reload. Warn on reloading dirty data; hidden window retains draft; no continuous autosave writes.
- Read-only session refresh while visible; pause when hidden and reconcile when shown. Do not instantiate native notification, window probing, or automatic clipboard/focus owners in Canvas.
- Window plumbing sends `amo-canvas-visibility` boolean payload to canvas on show/hide; UI also uses document visibility and focus. Canvas never becomes `activeUtilityWindow` or blocks/lowers the overlay. Native close hides Canvas; Escape is reserved for canvas selection/interaction cancellation.

## Delegation and automatic assessment

All implementation agents: GPT-6 Astra, reasoning medium. Assessment is an engineering estimate, not a model-generated product feature.

| Task | Initial complexity | Initial risk | Owner | Acceptance |
|---|---|---|---|---|
| A. Store and HTTP contract | High | High: persistence/concurrency | backend agent | restart, conflicts, replay, failed write, validation, exact references |
| B. Canvas interaction | High | Medium: geometry/state | UI agent | usable board, save/reload errors, pan/zoom/drag, task references |
| C. Entry and window policy | Medium | Medium: native layering | window agent | lazy entry, nonmodal behavior, hide/show policy, existing windows preserved |
| D. Integration and review | High | High: cross-boundary regressions | primary agent | build/tests, isolated HTTP and browser smoke, documented limits |

Final grades: A = acceptance verified; B = useful delivery with documented verification gaps; C = acceptance gaps requiring follow-up; F = unusable or unsafe. Record evidence separately from self-reported completion.

## Final assessment

| Task | Final grade | Evidence and limitations |
|---|---|---|
| A. Store and HTTP contract | A | 13 new store/route tests; real HTTP integration; restart, exact historical replay, write failure isolation, atomic rename cleanup, corruption, conflict and encoded-ID coverage |
| B. Canvas interaction | A | 6 geometry/API tests; real UI and isolated Broker smoke covering add/edit/drag/connect/zoom/save/reload, task204, conflicts, lost-response retry, newer edits during retry, Ctrl+S inside notes, archive/missing references, hide/show polling, removal and dark/light layouts |
| C. Entry and window policy | B | 6 executable native-port tests, existing utility regressions and successful Rust check. Native calls are verified; actual Windows stacking/focus has not been visually tested |
| D. Integration and review | B | 139 Broker + 67 frontend runtime tests passed; production build and cargo check passed; browser smoke has zero page errors. Overall confidence limited by the native desktop smoke gap |

The three implementation subtasks ran concurrently with the requested GPT-6 Astra / medium setting. The primary agent defined the shared interface before dispatch, inspected delivered code, requested corrections, and ran integration acceptance rather than using each agent's completion statement as its grade.

Review corrections included preserving percent-encoded comma session IDs, bounding exact-reference URLs, surfacing refresh timeouts, preserving hidden visibility state across reference changes, subscribing to theme changes, blocking draft edits during reload, allowing Ctrl+S in the note editor, guarding stale initial loads, and retaining the save-state indicator at minimum window width.

## Verification record

- `node --test broker/lib/*.test.js`: 139 passed, 0 failed.
- `node --test tests/runtime/*.test.mjs` from `overlay`: 67 passed, 0 failed.
- `npm run build` from `overlay`: TypeScript and production Vite build passed; Canvas is a lazy JS/CSS chunk.
- `cargo check --offline` from `overlay/src-tauri`: passed.
- `node scripts/performance/canvas-smoke.cjs`: passed with an isolated Broker and headless Edge. Native APIs stubbed, actual UI and HTTP store used. Screenshots and JSON evidence are written under ignored `tmp/canvas-smoke-*`; the accepted integrated run was `tmp/canvas-smoke-upjXHO`.
- Dark 1440×960 and light 800×560 screenshots visually inspected. No clipping of essential controls; save status remains visible at minimum width.

Sandbox child-process restrictions initially caused npm/test spawn EPERM. The required dependency install, test runners and browser smoke passed with scoped execution approval; these environmental errors were not counted as product failures. No active AMO runtime or real task data was used. No commit or deployment was performed.

## Follow-up boundaries

Complete a real Windows smoke for opening/hiding/reopening/minimizing Canvas alongside the overlay, existing modal utilities, and theme changes. Future task command reuse, groups, fork, multiple boards, undo, and AI-client workspace authorization need separate implementation. Node/edge limits do not establish a performance guarantee: SVG edges remain mounted up to the limit, while task nodes use viewport culling and compact low-zoom rendering.

Storage is serialized per Broker process; sharing one file between multiple Broker processes is unsupported. The temporary file is flushed before atomic rename; portable Windows directory fsync is not claimed. Replay is bounded to 32 operations/16 MiB. See [the workbench guide](../task-canvas-workbench.md) for user behavior and API limits.
