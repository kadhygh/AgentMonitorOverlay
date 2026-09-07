# Task Canvas workbench

The overlay header's **Open Canvas** button opens an independent task board. The overlay remains usable while Canvas is open. The board can reference tasks from different workspaces.

## Using the board

1. Find a task in the left sidebar and click it to add a reference. Use **Add note** for your own planning text.
2. Drag a card header to move it. Drag the background to pan; scroll or use the zoom buttons to zoom. **Fit board** brings the layout into view.
3. Select a card and choose **Connect**, then click another card. Connections are directed relationships, with no execution or scheduling behavior.
4. Select a card or connection and choose **Remove**, or press Delete. Removing a task reference does not archive, dismiss, or stop its session.
5. Choose **Save** to preserve the layout across application restarts. **Hide Canvas** keeps the draft in the existing window; hidden drafts still need saving before exiting AMO.

Escape cancels an interaction or selection. Ctrl/Cmd+S saves. **Reload** reads the stored board; a dirty draft requires an explicit discard confirmation. A failed save retains the draft. A revision conflict also retains the draft and requires an explicit reload; it never overwrites another editor's newer layout automatically.

Task information refreshes while Canvas is visible. Archived references stay on the board, and unavailable sessions appear as missing references after a successful lookup. Lookup failures retain the last known task information and show an update error. Canvas does not own native notifications, window monitoring, or automatic clipboard/focus behavior.

## Foundation and limits

This first version provides one local board, up to 500 nodes and 1,000 directed connections. Notes contain up to 4,000 characters. Zoom ranges from 20% to 200%; distant nodes are culled and low zoom uses a compact presentation. These bounds are validation limits, not a measured 500-node frame-rate guarantee.

The graph is separate from the Obsidian conversation Canvas. Broker storage is `task-canvas.json` beside `sessions.json`, overridable with `AGENT_MONITOR_TASK_CANVAS_DATA_FILE`. Node identity is independent of provider/session identity. Closing the window or deleting graph elements does not mutate a session.

The local HTTP interface is documented in [the implementation contract](tasks/task-canvas-foundation-2026-09-07.md). Writes require an expected board revision and operation ID. Replaying an identical recent operation returns its original committed result, including after restart. The replay ledger retains at most 32 operations within 16 MiB; older requests encounter revision conflicts. Persistence serializes writes inside one Broker process and flushes a temporary file before atomic replacement; it does not coordinate multiple Broker processes writing the same file. Invalid stored data is reported as an error and is not silently reset.

The HTTP interface is a local application foundation. Browser writes accept the Tauri origins and local development port 1420; native/CLI requests without Origin are accepted. This is not a workspace-scoped authorization system for external AI clients.

Groups, multiple boards, fork creation, undo history, automated task execution, and external AI editing authorization remain later work.

The next product direction—Areas with their own context, requirement cards wrapping multiple sessions, existing-window Fork repair, Side Chat, and AI CLI collaboration—is recorded in [the 2026-09-07 analysis and plan](canvas-area-task-orchestration-plan-2026-09-07.md). It describes proposed work rather than additional implemented features.

## Isolated verification

`node scripts/performance/canvas-smoke.cjs` bundles the real Canvas UI, launches an isolated Broker and headless Microsoft Edge, and stubs native window APIs. Set `AMO_PLAYWRIGHT_MODULE` to an existing Playwright module if it is not locally resolvable. Test data and screenshots remain under the ignored `tmp/canvas-smoke-*` directory. This script never operates the normal AMO Broker or real tasks.

The browser smoke verifies rendering and HTTP interaction. Native window layering requires a separate desktop check.
