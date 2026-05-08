# Supervisor Status

Updated: 2026-05-08

## Current Git

- Stable branch: `master`
- Current phase branch: `phase/1-2-spikes`
- Latest stable baseline: `e1eb74e docs: establish agent monitor project plan`
- Push policy: local only until user explicitly confirms remote/push

## Current Stage

- Phase 0: partial, documentation baseline established
- Phase 1: spike done, window routing strategy documented and Win32 enumeration script added
- Phase 2: MVP skeleton done, broker API verified locally
- Phase 3: prototype done, overlay UI builds and native Rust code compiles
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

- First implementation round runs on `phase/1-2-spikes`.
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

## Live Hook Smoke Results

- Claude live smoke passed with disposable `--settings`; broker received real `UserPromptSubmit` and `Stop` events.
- Codex live smoke can run the prompt successfully with the user's normal provider configuration, but the disposable project-local hook file did not load, and a minimal temporary `CODEX_HOME` is not sufficient for this Codex install.
- Codex remains a hook-loading validation gap, not an adapter/broker contract failure.

## Next Supervisor Checkpoint

- Keep adapter contract verification as the automated gate.
- Keep Claude live smoke as a verified real-hook gate.
- Decide the Codex hook validation route: supported per-process hook injection, or temporary install/restore of a user-layer hook in the real Codex home.
- Ask the user to re-check the visible overlay: tool icons, row drag handle, and clicking a Claude demo row to route to the PowerShell demo window.
- If PID routing still does not focus the demo window, collect the overlay footer feedback and add a user-visible candidate/debug panel before continuing Codex hook work.
