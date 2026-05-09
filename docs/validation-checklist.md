# Validation Checklist

This checklist is maintained by the supervisor agent. It should only be handed to the user when there is a runnable build or a precise manual workflow to validate.

## Phase 1: Window Routing

Status: ready for supervisor/user manual validation

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

Status: build verified locally; native window vibe still needs user validation

- Start overlay locally.
- Confirm window is always on top.
- Confirm broker-backed sessions refresh automatically every few seconds.
- Confirm the header says `broker live` when the broker is running; mock `NoHeartbeat` fallback should not appear in the demo.
- Confirm window can be dragged without disrupting the main workspace.
- Confirm 3-8 sessions remain readable.
- Confirm `waiting_user` and `waiting_permission` states are visible without feeling noisy.
- Confirm each row is easier to identify with the tool icon before the project/title.
- Confirm dragging from the row handle reorders task cards without triggering session activation.
- Confirm dragging from the overlay header moves the overlay window.
- Click a session and confirm routing behavior or clear failure feedback.

## Phase 4 Spike: Tool Adapters

Status: isolated adapter contract verification passes on 2026-05-08; Claude live hook smoke passed; Codex hook loading still pending

- Confirm Codex event payload can map to broker session model.
- Confirm Claude event payload can map to broker session model.
- Confirm Kiro route is either tested or explicitly marked as mock/manual for MVP.
- Confirm no global user tool configuration is changed without approval.
- Re-run Codex live smoke after choosing a safe hook loading route for the current Codex CLI.
- Claude live smoke is verified with disposable `--settings`.

## Vibe Checks

Status: passed by user on 2026-05-07; minor details deferred

- The overlay should feel like a compact workbench, not a dashboard page.
- Waiting states should be noticeable but not attention-stealing.
- The default view should make active agent sessions legible at a glance.
- Collapse/expand behavior should support frequent context switching.
