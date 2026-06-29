# Obsidian Canvas Development Guidelines

Updated: 2026-05-21

This document is the AMO project guardrail for future Obsidian Canvas work. Read it before changing `md-anno-tools` canvas behavior, broker canvas writes, or overlay actions that open/focus an Obsidian canvas.

## Current Boundary

AMO treats Obsidian Canvas as a workflow surface, not as AMO's primary data model.

The stable integration boundary is:

- Broker owns AMO workspace/session state.
- Broker writes JSON Canvas data for AMO-owned nodes and edges.
- Markdown notes own readable prompt/reply content and annotations.
- Obsidian Canvas renders the graph and embedded file-node previews.
- The plugin may provide explicit user actions around the active canvas or selected note, but it must not take over Canvas rendering.

The current MVP deliberately does not hide Obsidian properties inside Canvas file-node previews. AMO note property hiding is Markdown-view-scoped only. Canvas notecard property hiding is deferred until there is a safe, separately validated design.

## External Plugin Lessons

The 2026-05-21 research pass looked at representative Canvas-heavy plugins: Advanced Canvas, Canvas MindMap, Canvas Mindmap Helper, Canvas Candy, Canvas CSS Class, Canvas Connect, Obsidian Collapse Node, Enhanced Canvas, Canvas2Document, and Excalidraw for Obsidian.

Useful patterns to borrow:

- Advanced Canvas proves a large Canvas extension can be organized around a patcher plus feature modules, custom events, and data-driven styles. AMO may borrow the feature-module/event-bus shape, not the prototype patching.
- Canvas MindMap and Canvas Mindmap Helper show that auto-layout works best as graph data calculation plus explicit user commands. AMO should compute layout from `nodes`/`edges` and save the result, not chase live DOM positions every frame.
- Canvas Candy shows a low-intrusion style model: put visual intent into Markdown/content conventions and CSS classes. AMO can borrow metadata/CSS-class-driven visual intent where it does not affect Canvas geometry.
- Canvas CSS Class shows a safer canvas-level hook: add classes/data attributes to the canvas view container, not to every native node. AMO can use this for AMO-managed canvas markers, debug styling, or temporary view-level affordances.
- Canvas Connect shows a limited data-layer repair command can improve edge anchors without touching node DOM. AMO can use the same philosophy for explicit edge/layout repair.
- Excalidraw shows the long-term escape hatch for complex interaction: create an independent view/workbench with its own API, and let Obsidian Canvas remain an entry/reference surface.

Patterns not to copy into AMO MVP:

- Prototype patching `Canvas`, `CanvasView`, or `CanvasNode`.
- Treating `canvas.nodes`, `canvas.edges`, `node.nodeEl`, `canvas.selection`, or viewport methods as stable public APIs.
- Injecting persistent headers, buttons, badges, or wrappers inside native Canvas nodes.
- Using broad `.canvas-node` CSS to hide metadata or change node measurement.
- Running continuous frame-by-frame polling for normal AMO state.
- Depending on canvas-specific frontmatter/properties behavior for core AMO identity.

The practical takeaway is: AMO may shape Canvas data and Markdown note content, but it should not shape the native Canvas node renderer.

## Allowed Canvas Work

Allowed without a new architecture spike:

- Append AMO-owned file nodes and edges to `Canvases/AgentFlow.base.canvas`.
- Preserve unrelated user nodes, edges, groups, positions, and styles.
- Write normal JSON Canvas fields plus the top-level AMO metadata block.
- Read the active canvas selection best-effort to find a Markdown file node.
- Show a fallback chooser when canvas selection cannot be read reliably.
- Add lightweight visual hints only through plugin-owned classes, such as the latest-note ring.
- Open or focus a canvas through the plugin protocol when the user explicitly clicks an AMO action.
- Add explicit user-triggered commands, such as Send, Copy, Open Panel, or future Arrange AMO Nodes.

## Forbidden In The MVP Path

Do not do these in production MVP code:

- Do not override native `.canvas-node` layout, sizing, overflow, transform, or positioning.
- Do not inject persistent buttons, badges, property controls, or wrappers into Canvas node DOM.
- Do not hide native Canvas file-node properties with broad Canvas CSS.
- Do not mutate Obsidian's native Canvas selection state to fake selection.
- Do not force live Canvas reloads by rewriting private view data or zoom/pan state.
- Do not re-layout all nodes automatically while the user is working.
- Do not assume Canvas embedded note previews share the same lifecycle as normal Markdown views.
- Do not make a global `MutationObserver` own Canvas rendering state.

## CSS Policy

Canvas CSS must be inert and scoped.

Safe CSS examples:

- A plugin-owned class used only for a visual hint.
- Outline, box-shadow, or opacity changes that do not affect node geometry.
- Styles guarded by both an AMO class and an AMO-managed canvas check.

Risky CSS examples:

- Any selector that targets `.canvas-node` without a plugin-owned class.
- Any `display: none`, `position`, `transform`, `overflow`, `width`, `height`, `margin`, or `padding` change on native Canvas nodes.
- Any attempt to hide `.metadata-*` or property DOM inside Canvas previews.

If a Canvas CSS change can affect zooming, panning, dragging, edge routing, node measurement, or native selection visuals, it needs a separate spike and explicit validation.

## Data Policy

Use the Canvas file as data, not as a live view patch target.

For AMO-owned canvas data:

- Write `Canvases/AgentFlow.base.canvas` atomically where practical.
- Keep `nodes` and `edges` valid JSON Canvas data.
- Add `amo.managedBy = "agent-monitor-overlay"` and `amo.canvasType = "agent-flow-base"` for the AMO-managed base flow canvas.
- Use short file-node paths under `Sessions/<session-id>/turns/generated/`, such as `reply 01.md` and `prompt 01.md`.
- Store durable AMO identity outside fragile canvas labels. New note-format work should prefer a compact hidden AMO marker or sidecar index over large visible frontmatter.
- Use explicit edge endpoint fields (`fromEnd: "none"`, `toEnd: "arrow"`) plus sides.
- Chain nodes only within the same session unless a user action explicitly creates a cross-session relation.

For existing canvas content:

- Preserve unknown top-level keys.
- Preserve unknown node and edge fields.
- Never delete non-AMO nodes during append.
- Cleanup actions may clear only AMO-generated vault content after explicit user confirmation.

## Canvas Notecard Properties

There are two different property surfaces:

- Markdown note view properties: stable enough for AMO to hide with a Markdown-view-scoped class.
- Canvas file-node preview properties: owned by the native Canvas renderer and intentionally not hidden by the current plugin.

Do not "fix" Canvas notecard properties by adding broad `.canvas-node .metadata-* { display: none }` CSS. That route previously pushed AMO into Canvas renderer ownership and caused regressions around refresh, zoom, pan, and node behavior.

If hiding Canvas notecard properties becomes important enough, treat it as a dedicated design task. A safe proposal must answer:

- Can the behavior be limited to AMO-managed canvases and AMO-generated notes?
- Can it avoid changing node geometry or breaking edge routing?
- Can it survive zoom, pan, drag, edit/read transitions, and plugin reload?
- Does Obsidian expose a public API or setting for preview property display?
- What is the rollback path if a future Obsidian version changes Canvas DOM?

Until that design exists, the product rule is: hide properties in opened note views; leave Canvas notecard previews native.

Current near-term direction:

- Move AMO technical metadata out of visible YAML frontmatter for new generated notes.
- Keep generated note files stable and short, such as `Sessions/<session-id>/turns/generated/reply 01.md`.
- Put the human-facing title in the note body as the first H1. Canvas file-node previews can then show a meaningful title without AMO changing the node renderer.
- Keep full technical provenance in broker state or an AMO sidecar index keyed by a stable note id.
- Keep the current Markdown-view property hiding as compatibility for older notes that still use frontmatter.

Implementation note: plugin version `1.4.19` writes new AMO notes with a hidden `<!-- amo: {...} -->` marker, stores full note metadata in broker `state/note-index.json`, and lets the AMO panel update the display title by changing the marker, note H1, and note index. This keeps Canvas file-node previews native while removing visible AMO properties from newly generated notes.

Avoid using file renames as the first title mechanism. Renaming the physical note can make the native Canvas label prettier, but it creates path migration, duplicate-title, invalid-character, canvas-link, and external-reference work that should be designed separately.

Avoid adding companion title text nodes as the first MVP mechanism. It can make Canvas cleaner, but it changes the graph model from one message node to title/content node pairs and complicates selected-note actions.

## Canvas Adapter Rule

Canvas private API usage must be isolated behind a narrow adapter before it grows further.

Allowed adapter responsibilities:

- Find the active canvas view.
- Read a best-effort graph snapshot from JSON Canvas or the current view.
- Resolve selected Markdown file nodes with fallback chooser support.
- Apply explicit user-triggered layout or edge repairs by writing JSON Canvas data.
- Perform best-effort focus/center when the user explicitly opens a canvas.

The adapter must mark each method as one of:

- JSON Canvas data-layer only
- Obsidian workspace/view API
- private Canvas internals
- DOM fallback

Business logic should call the adapter rather than touching `(leaf.view as any).canvas`, `.canvas-node`, `canvas.selection`, or viewport methods directly.

## Refresh And Focus Policy

The safe MVP refresh model is explicit:

- Broker may append to `Canvases/AgentFlow.base.canvas`.
- Overlay or plugin may open/focus the canvas when the user clicks an AMO action.
- If an already-open canvas does not immediately show a newly appended node, manual reopen/refresh is acceptable.
- Automatic live Canvas refresh is a future task and must use a validated Obsidian API path.

The latest-note visual hint must not replace native selection:

- It may add a subtle plugin-owned outline to the target node.
- It must not leave a confusing fake selected state.
- It must not call private selection mutators.
- It must degrade to a plain canvas jump if the note/node cannot be found.

## Required Validation

Run the relevant subset after any Canvas change:

- Open `Canvases/AgentFlow.base.canvas` without freeze or crash.
- Zoom in and out; node content, latest hint, and edges stay aligned.
- Pan the canvas; node content and edges stay aligned.
- Drag a node; edge endpoints remain connected.
- Open an existing note node and edit/read it; annotation rendering remains stable.
- Append prompt/reply nodes while the canvas is open; if it does not live-refresh, explicit reopen still shows valid nodes.
- Open Canvas from overlay; latest note is focused/highlighted when present and plain jump works when absent.
- Use canvas Send/Copy/Panel actions on different nodes; actions target the selected/current node, not stale state.
- Confirm non-AMO canvases keep native behavior.

## Escalation Rule

When a requested feature requires touching Canvas internals, stop and make it explicit in the task plan. The supervisor should decide whether to:

- Keep the feature in Markdown note views only.
- Implement it as a broker-side JSON Canvas data change.
- Implement it as a separate AMO panel/workbench instead of Canvas DOM mutation.
- Run a throwaway-vault spike against a specific Obsidian version.
- Defer until Obsidian exposes a public API that supports the behavior.
