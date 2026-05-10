# Supervisor Status

Updated: 2026-05-10

## Current Git

- Stable/default handoff branch: `master`
- Phase checkpoint branch: `phase/1-2-spikes`
- Latest stable baseline: current `master`, merged from `phase/1-2-spikes` on 2026-05-10
- Remote: `origin https://github.com/kadhygh/AgentMonitorOverlay.git`
- Push policy: push only on explicit user request. User requested merge to `master` and push on 2026-05-10.

## Current Stage

- Phase 0: done, documentation baseline established
- Phase 1: spike done, window routing strategy documented and Win32 enumeration script added
- Phase 2: MVP skeleton done, broker API verified locally
- Phase 3: prototype done, overlay UI builds, native Rust code compiles, and user smoke validation has run
- Phase 4: spike done, Codex / Claude / Kiro adapter routes documented with example hooks

## Active Tasks

| Task | Owner | Status | Write Scope |
| --- | --- | --- | --- |
| Task A: Window Routing Spike | worker-window-routing | done | `docs/window-routing-notes.md`, `scripts/window-routing/` |
| Task B: Broker Skeleton | worker-broker | done | `broker/`, `examples/events/`, `scripts/broker/` |
| Task C: Overlay UI Prototype | worker-overlay-ui | done | `overlay/` |
| Task D: Codex Claude Kiro Hook Spike | worker-tool-adapters | done | `docs/tool-adapter-spike.md`, `examples/hooks/`, `scripts/adapters/` |
| Task E: Supervisor Integration | supervisor-agent | done | project plan, status docs, integration and checkpoint |

## Environment Snapshot

- Node: `v24.13.0`
- npm: `11.14.0`
- Rust: `rustc 1.93.1`
- Cargo: `cargo 1.93.1`
- PowerShell: available via `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`

## Supervisor Decisions

- First implementation round ran on `phase/1-2-spikes`; the branch is now a checkpoint and `master` is the handoff branch.
- MVP remains read-only monitoring plus click-to-window routing.
- User will not be asked to approve routine branch/task-card/checkpoint mechanics.
- User validation is reserved for real workflow or vibe checkpoints.
- Broker default port is `17654`.
- Overlay reads `GET http://127.0.0.1:17654/api/sessions`.
- `windowHint.titleToken` follows `[AMO:<tool>:<project-slug>:<session-slug>]` and is the primary routing key when available.
- Overlay external activation uses native Win32 enumeration/focus on Windows, with ambiguity and blocked-focus feedback.
- User accepted the first overlay vibe checkpoint. Small UI details can be tuned later.
- Broker and adapter verification scripts clear their own data files before running, assert exact session counts, and fail fast if the target port is already occupied.
- User feedback on 2026-05-08: overlay appears and broker data is correct, but session rows need stronger tool recognition and click-to-window did not route.
- Overlay session rows now include a per-tool icon and a row-level drag handle; click target remains the full row.
- Window activation now accepts `windowHint.pid` as a first-class exact match and uses a stronger foreground-focus path on Windows.
- Claude routing demo now publishes the console host PID for the demo window and clears stale overlay dev/Vite processes before starting Tauri.
- User clarified on 2026-05-08 that the row handle should drag task cards, not the whole overlay.
- Broker now returns local CORS headers so the Tauri WebView can fetch `127.0.0.1:17654` from the Vite/WebView origin instead of falling back to mock sessions.
- Session row handles now reorder visible cards locally; the overlay header remains the drag target for moving the whole window.
- User validation by 2026-05-10: overlay appears, `broker live` is active, mock `NoHeartbeat` fallback is gone, tool icons are acceptable, header drag moves the overlay, Codex/Mecho routing works, and Claude demo routing works after duplicate matching demo windows are closed.
- Duplicate matching Claude demo windows are treated as ambiguous; activation refusal is expected until a candidate/debug panel is added.
- Latest card drag implementation uses pointer-driven drag preview and live reordering, but still needs user revalidation because the prior build triggered drag without visually moving the card reliably.

## Verified This Round

- `node --check broker\server.js`
- `npm run broker:verify` with isolated broker data; exact 3-session API and persistence checks pass
- `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\adapters\Send-AgentMonitorEvent.ps1 -Tool codex -DryRun`
- Adapter POST into a live broker created `adapter-demo-001` with `waiting_permission`.
- `powershell -ExecutionPolicy Bypass -File .\scripts\window-routing\Get-WindowCandidates.ps1 -TitleContains AgentMonitorOverlay`
- `npm install` in `overlay/`
- `npm run build` in `overlay/`
- `cargo check` in `overlay/src-tauri/`
- `npm run adapters:verify` with isolated adapter data; exact Codex / Claude / Kiro contract checks pass
- `git diff --check`
- `npm run build` in `overlay/` after tool-icon and drag-handle UI updates
- `cargo check` in `overlay/src-tauri/` after PID routing and focus-path updates
- `npm run demo:claude-routing` starts broker, demo PowerShell target, Vite, and `agent-monitor-overlay.exe`; broker sessions include `windowHint.process=conhost.exe` and a concrete PID
- `npm run broker:verify -- -Port 17655` after broker CORS update
- CORS smoke on port `17657`: `GET /api/sessions` returns `Access-Control-Allow-Origin: *`; `OPTIONS /api/sessions` returns `204` and allowed methods
- `npm run build` in `overlay/` after changing row drag handle from overlay-drag to card reorder
- `npm run build` in `overlay/` after pointer-driven card drag preview changes
- `cargo check` in `overlay/src-tauri/` after pointer-driven card drag preview changes
- `node --check broker\server.js` after pointer-driven card drag preview changes
- User smoke validation: native overlay appears, broker-backed sessions load, header drag works, Codex/Mecho jump works, and Claude demo jump works when the target is not ambiguous.

## Live Hook Smoke Results

- Claude live smoke passed with disposable `--settings`; broker received real `UserPromptSubmit` and `Stop` events.
- Codex live smoke can run the prompt successfully with the user's normal provider configuration, but the disposable project-local hook file did not load, and a minimal temporary `CODEX_HOME` is not sufficient for this Codex install.
- Codex remains a hook-loading validation gap, not an adapter/broker contract failure.

## Next Supervisor Checkpoint

- Keep `master` as the default new-device handoff branch.
- Revalidate pointer-driven card dragging with two-card and multi-card lists.
- Add a user-visible candidate/debug panel for ambiguous routing, especially duplicate Claude demo windows.
- Keep adapter contract verification as the automated gate.
- Keep Claude live smoke as a verified real-hook gate.
- Decide the Codex hook validation route: supported per-process hook injection, or temporary install/restore of a user-layer hook in the real Codex home.
