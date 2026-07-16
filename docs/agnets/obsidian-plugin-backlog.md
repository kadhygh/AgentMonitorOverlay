# Obsidian Plugin Backlog

Updated: 2026-07-15

This backlog is the working queue for the AMO Obsidian Plugin Agent. Items here are scoped to Obsidian plugin behavior unless they explicitly call out a broker or overlay contract.

## Now

- Validate new AMO note format: hidden marker, sidecar note index, hidden display title metadata, and clean Canvas file-node previews.
- Validate annotation deletion from the AMO panel, note editor context menu, and rendered annotation shell in note/canvas previews.
- Keep AMO panel Copy/Send locked to the note currently displayed in the panel.
- Keep canvas selected note targeting stable without recursive panel refresh.
- Keep debug logs useful but bounded during plugin troubleshooting.

## Next

- Implement the first Codex CLI Managed Side Fork slice after approval of `docs/managed-side-fork-plan.md`; keep the Obsidian annotation entry for a later phase.
- Introduce a narrow Canvas adapter module before adding more Canvas behavior, so private view/selection/focus calls are isolated and labeled.
- Improve canvas selected note operations so selected note actions are visible and predictable.
- Design a safe Canvas notecard display strategy before attempting to hide native properties inside Canvas file-node previews.
- Add clearer plugin status in the AMO panel: selected note, source, annotation count, last send/copy result.
- Add plugin-side open note/canvas behavior that avoids the first-open Obsidian restart limitation.
- Add explicit work canvas binding UI.
- Add multi-CLI quick jump buttons when one canvas is associated with several CLI/TUI sessions.
- Add plugin-side automatic canvas layout commands, such as arranging AMO-owned nodes, selected chains, or selected groups without touching unrelated user canvas content.

## Later

- Typed annotation labels and styles, starting from the default Chinese label `批注` and later extending to question, suggestion, decision, todo, or other workflow-specific annotation types.
- Annotation grouping and summary tools inside Obsidian.
- Canvas group as workflow branch.
- Start a CLI flow from a selected note, canvas node, or canvas group.
- Branch a question from selected note text or selected canvas node.
- Multi-agent/parallel CLI orchestration from an Obsidian canvas.
- Plugin-managed permission request display, if the broker/overlay contract later supports it.

## Active Design: Managed Side Fork

The active provider-first design is `docs/managed-side-fork-plan.md`. The first implementation starts from an eligible Codex task card and launches a persistent managed fork through `codex fork`. The future Obsidian annotation action will reuse that Broker contract after the CLI workflow is stable.

The core constraints from the earlier annotation-side investigation still apply:

1. Capture an explicit parent provider session id and workspace.
2. Start a dedicated managed CLI with a fresh `launchId` and `role: side-chat`.
3. Keep child hooks out of normal task-card, generated-note, base-canvas, and parent-binding flows.
4. Keep side status observable in a compact independent surface rather than making it completely invisible.
5. Add the annotation source, selected text, and optional question only when the later Obsidian entry is implemented.

Do not implement classification from title, PID, CWD, or timing guesses. A future explicit `Promote to task` action may remove suppression and create a normal card, but implicit promotion is not allowed.

## Open Questions

- Should `[!anno]` remain the long-term user-facing syntax, or should AMO eventually migrate to Obsidian-native callout syntax for more stable rendering?
- Should annotation blocks support stable IDs for future anchored comments and branch replies?
- Should a work canvas binding live primarily in broker state, plugin data, or both with broker as the authority?
- How much of the future "Obsidian as main control surface" direction should be allowed before the current sidecar MVP is fully stable?

## Current Bugs Under Watch

- Annotation shell can disappear after Obsidian re-renders a note or canvas preview, leaving only the quoted block visible. The plugin now uses source-backed section rendering with `MarkdownPostProcessorContext` and `MarkdownRenderChild`; keep this under manual watch in note read/edit/read and canvas embedded previews.
- Canvas file-node previews still show Obsidian native note properties. This is expected in the current safe MVP because property hiding is limited to opened Markdown note views.
- Editor-mode AMO title rendering is deferred. A block widget attempt caused file-open regressions, so edit/source mode currently only hides the AMO marker line.
- Canvas DOM selection APIs can differ from Obsidian version to version; current plugin must keep a fallback chooser.
- Obsidian may not reload a newly deployed project-local plugin until the user reloads plugins or restarts Obsidian.

## Done Recently

- Moved new AMO note technical metadata out of visible YAML frontmatter into a hidden marker plus broker `state/note-index.json`.
- Hid the AMO marker line in Obsidian edit/source mode with a narrow CodeMirror editor extension.
- Added a human-facing AMO note title path: hidden display title metadata, rendered AMO title header, AMO panel title editing, note/canvas title actions, and broker note-index synchronization.
- Added annotation deletion through the AMO panel, editor context menu/command, and plugin-owned rendered annotation shell.
- Added an Obsidian plugin setting for annotation numbering in sync prompts; numbering defaults off.
- Added broker-side outgoing prompt notes so sync-back/user prompt content can chain onto `AgentFlow.canvas`.
- Migrated `md-anno-tools` from a single hand-maintained `main.js` into TypeScript source modules bundled by esbuild.
- Added broker/overlay/plugin debug logging controlled by overlay debug toggle.
- Fixed AMO panel Copy/Send using stale active Markdown view.
- Added debounce and non-reentrant panel refresh for canvas target changes.
- Added delayed whole-container annotation render passes and mutation-based rescan.
- Added workspace mutation rescan and source-backed repair rerender for annotation rendering after Obsidian mode switches.
- Reworked legacy annotation rendering to use Obsidian-managed render children and source line sections instead of cross-section DOM range replacement as the primary path.
