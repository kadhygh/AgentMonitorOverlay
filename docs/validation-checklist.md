# Validation Checklist

This checklist is maintained by the supervisor agent. It should only be handed to the user when there is a runnable build or a precise manual workflow to validate.

## Phase 1: Window Routing

Status: ready for supervisor/user manual validation

- Verify at least three different windows can be identified by title, process name, or explicit handle.
- Verify clicking a monitored session activates the intended window.
- Verify failure behavior when a target window is missing or ambiguous.
- Verify the proposed Codex / Claude / Kiro title naming convention fits the user's real workflow.

## Phase 2: Broker MVP

Status: verified locally by supervisor

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
- Confirm window can be dragged without disrupting the main workspace.
- Confirm 3-8 sessions remain readable.
- Confirm `waiting_user` and `waiting_permission` states are visible without feeling noisy.
- Click a session and confirm routing behavior or clear failure feedback.

## Phase 4 Spike: Tool Adapters

Status: adapter dry-run and broker POST verified; real hooks still need disposable live validation

- Confirm Codex event payload can map to broker session model.
- Confirm Claude event payload can map to broker session model.
- Confirm Kiro route is either tested or explicitly marked as mock/manual for MVP.
- Confirm no global user tool configuration is changed without approval.

## Vibe Checks

Status: ready once overlay is launched

- The overlay should feel like a compact workbench, not a dashboard page.
- Waiting states should be noticeable but not attention-stealing.
- The default view should make active agent sessions legible at a glance.
- Collapse/expand behavior should support frequent context switching.
