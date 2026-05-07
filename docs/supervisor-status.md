# Supervisor Status

Updated: 2026-05-07

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

## Verified This Round

- `node --check broker\server.js`
- `powershell -ExecutionPolicy Bypass -File .\scripts\broker\verify.ps1`
- `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\adapters\Send-AgentMonitorEvent.ps1 -Tool codex -DryRun`
- Adapter POST into a live broker created `adapter-demo-001` with `waiting_permission`.
- `powershell -ExecutionPolicy Bypass -File .\scripts\window-routing\Get-WindowCandidates.ps1 -TitleContains AgentMonitorOverlay`
- `npm install` in `overlay/`
- `npm run build` in `overlay/`
- `cargo check` in `overlay/src-tauri/`

## Next Supervisor Checkpoint

- Start broker and overlay together.
- Hand the user a focused vibe and routing validation checklist.
- If user accepts MVP feel, move to live hook verification in a disposable repo.
