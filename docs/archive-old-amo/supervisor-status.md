# Supervisor Status

Updated: 2026-07-11

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
- Phase 4: spike done, Codex / Claude routes documented with example hooks; Kiro remains historical research, not an active adapter target
- Phase 5: Hook-to-Obsidian Bridge MVP planning accepted after two external MVPs proved Codex reply capture and Obsidian annotation extraction
- Phase 6: Workspace Center and managed CLI launch identity accepted for implementation planning; see `docs/workspace-managed-launch-plan.md`

## Active Tasks

| Task | Owner | Status | Write Scope |
| --- | --- | --- | --- |
| Task A: Window Routing Spike | worker-window-routing | done | `docs/window-routing-notes.md`, `scripts/window-routing/` |
| Task B: Broker Skeleton | worker-broker | done | `broker/`, `examples/events/`, `scripts/broker/` |
| Task C: Overlay UI Prototype | worker-overlay-ui | done | `overlay/` |
| Task D: Codex Claude Kiro Hook Spike | worker-tool-adapters | done | `docs/tool-adapter-spike.md`, `examples/hooks/`, `scripts/adapters/` |
| Task E: Supervisor Integration | supervisor-agent | done | project plan, status docs, integration and checkpoint |
| Task F: Obsidian External Note Jump Spike | worker-obsidian-entry | superseded | Folded into Phase 5 bridge MVP; see `docs/amo-obsidian-bridge-mvp.md` |
| Task G: Obsidian Plugin Model Spike | worker-obsidian-plugin | externally spiked | Useful MVP exists in `D:\Projects\CommonProject\obsidianplugintest`; AMO should consume the contract |
| Task H: Obsidian Sync-Back Bridge Spike | worker-obsidian-sync-back | promoted | Bridge/sync-back is now Phase 5 core, initially `copy + focus target CLI` |
| Task I: AMO Obsidian Bridge MVP | supervisor-agent | planned | `docs/amo-obsidian-bridge-mvp.md`, `broker/`, `overlay/`, external Obsidian plugin MVP |

## Environment Snapshot

- Node: `v24.13.0`
- npm: `11.14.0`
- Rust: `rustc 1.93.1`
- Cargo: `cargo 1.93.1`
- PowerShell: available via `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`

## Supervisor Decisions

- First implementation round ran on `phase/1-2-spikes`; the branch is now a checkpoint and `master` is the handoff branch.
- Phase 3/4 MVP remains read-only monitoring plus click-to-window routing.
- Phase 5 should reuse the overlay and broker as a local bridge between hooks and Obsidian sidecar workflow.
- User will not be asked to approve routine branch/task-card/checkpoint mechanics.
- User validation is reserved for real workflow or vibe checkpoints.
- Broker default port is `17654`.
- Overlay reads `GET http://127.0.0.1:17654/api/sessions`.
- `windowHint.titleToken` follows `[AMO:<tool>:<project-slug>:<session-slug>]` and remains the portable fallback/default routing contract; validated `pid/hwnd` should win when present.
- Overlay external activation uses native Win32 enumeration/focus on Windows, with ambiguity and blocked-focus feedback.
- User accepted the first overlay vibe checkpoint. Small UI details can be tuned later.
- Broker and adapter verification scripts clear their own data files before running, assert exact session counts, and fail fast if the target port is already occupied.
- User feedback on 2026-05-08: overlay appears and broker data is correct, but session rows need stronger tool recognition and click-to-window did not route.
- Overlay session rows now include a per-tool icon and a row-level drag handle; click target remains the full row.
- Window activation now accepts `windowHint.pid` as a first-class exact match and uses a stronger foreground-focus path on Windows.
- Claude routing demo now publishes the console host PID for the demo window and clears stale overlay dev/Vite processes before starting Tauri.
- User clarified on 2026-05-08 that the row handle should drag task cards, not the whole overlay.
- Broker now returns local CORS headers so the Tauri WebView can fetch `127.0.0.1:17654` from the Vite/WebView origin instead of falling back to mock sessions.
- Session row handles are currently left visible as placeholders, but card reordering is temporarily disabled because it was interfering with routing validation.
- User validation by 2026-05-10: overlay appears, `broker live` is active, mock `NoHeartbeat` fallback is gone, tool icons are acceptable, header drag moves the overlay, Codex/Mecho routing works, and Claude demo routing works after duplicate matching demo windows are closed.
- Duplicate matching Claude demo windows now surface a candidate/debug panel instead of only a vague refusal message.
- Session rows now show route hints so exact `pid/hwnd` paths can be distinguished from token/fallback routing.
- Session rows now expose a broker-backed dismiss action that removes the current card from the active session snapshot until later hook activity recreates it.
- Broker supports `POST /api/sessions/:id/dismiss` and `POST /api/sessions/dismiss-all` for stale smoke/test card cleanup.
- Reply stop events mark cards as pending review; the overlay shows a green review cue and can clear it via `POST /api/sessions/:id/reviewed`.
- Repo-local Codex hook files now exist under `.codex/`, but the interactive `/hooks` review + smoke path is still in progress rather than closed.
- A disposable sibling test repo/project is the preferred first smoke path for Codex repo-local hooks so trust/review state does not have to land in the main worktree first.
- User clarified on 2026-05-13 that global hook deployment is too risky for the current product. Phase 5 hook/adapter setup must be manual and workspace-scoped: user selects a folder, AMO inspects the folder, then AMO installs only project-local hook/adapter files after explicit confirmation.
- User clarified on 2026-05-16 the full target workflow: monitor deploys adapters into a selected project folder, creates `.amo/` plus a dedicated Obsidian vault, shows task cards from hook replies, binds CLI sessions to work canvases, lets Obsidian annotations generate a continuation prompt, then copies and focuses back to the selected CLI.
- Current MVP is narrowed to Codex CLI plus Claude CLI hook support, accepted Codex App target binding, one selected project folder, project-local `workspace.vaultRoot`, one base `Canvases/AgentFlow.base.canvas`, session-scoped generated notes, Obsidian annotation send, and automatic copy + focus back to the selected CLI/App target.
- Obsidian workflow integration is now promoted from future planning to Phase 5 bridge MVP because the user independently validated:
  - Codex `Stop` hook can capture `last_assistant_message` and cache reply Markdown/JSON.
  - Obsidian `md-anno-tools` can render and extract `[!anno]...[/anno]` annotations.
- The bridge must keep Obsidian as a sidecar workflow. AMO owns session state, bridge contracts, overlay actions, and safe sync-back.

## Verified This Round

- `node --check broker\server.js`
- `npm run broker:verify` with isolated broker data; exact 3-session API and persistence checks pass
- `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\adapters\Send-AgentMonitorEvent.ps1 -Tool codex -DryRun`
- Adapter POST into a live broker created `adapter-demo-001` with `waiting_permission`.
- `powershell -ExecutionPolicy Bypass -File .\scripts\window-routing\Get-WindowCandidates.ps1 -TitleContains AgentMonitorOverlay`
- `npm install` in `overlay/`
- `npm run build` in `overlay/`
- `cargo check` in `overlay/src-tauri/`
- `npm run adapters:verify` with isolated adapter data; exact Codex / Claude contract checks pass
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
- `cargo test` in `overlay/src-tauri/` after PID-refine routing updates; unit coverage now includes unique refinement after PID ambiguity, global fallback after stale/ambiguous PID, and explicit-HWND validation without derived project-title requirements.
- `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\adapters\Send-AgentMonitorEvent.ps1 -Tool codex -DryRun` with `AMO_WINDOW_PROCESS` override confirms no auto-detected PID leak.
- `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\adapters\Send-AgentMonitorEvent.ps1 -Tool codex -DryRun` with `AMO_WINDOW_HWND` override confirms no auto-detected PID/process leak into exact-handle hints.
- `npm run build` in `overlay/` after adding route pills, candidate/debug UI, and local dismiss state.

## Live Hook Smoke Results

- Claude live smoke passed with disposable `--settings`; broker received real `UserPromptSubmit` and `Stop` events.
- Codex live smoke can run the prompt successfully with the user's normal provider configuration, and broker has received at least some real events from repo-local smoke attempts.
- Codex still remains a hook-loading and hook-runner validation gap because the interactive session can report hook failure/timeout noise even when broker delivery partially succeeds.
- Codex remains a hook-loading validation gap, not an adapter/broker contract failure.
- External Codex reply-note MVP in `obsidianplugintest` proves the important Phase 5 content path: `Stop` hook -> `last_assistant_message` -> Markdown/JSON note cache.

## Phase 5 Bridge Inputs

- Main AMO bridge design: `docs/amo-obsidian-bridge-mvp.md`
- Codex reply hook handoff: `D:\Projects\CommonProject\obsidianplugintest\docs\CODEX_REPLY_NOTE_HOOK_INTEGRATION.md`
- Obsidian annotation plugin handoff: `D:\Projects\CommonProject\obsidianplugintest\docs\OBSIDIAN_ANNOTATION_PLUGIN_DEVELOPMENT.md`
- Repo-local MVP snapshot for cross-device continuation: `docs/reference-mvps/obsidianplugintest/`
- Useful Codex fields: `capturedAt`, `sessionId`, `turnId`, `model`, `hookEventName`, `cwd`, `transcriptPath`, `stopHookActive`, `message`.
- Useful Obsidian syntax: `[!anno]...[/anno]`.
- First bridge sync-back rule: prepare prompt, copy to clipboard, focus target CLI, let the user paste/submit.
- First bridge enrollment rule: no global hooks; install only per selected workspace folder, based on detected folder/tool capabilities.
- Deployment maintenance guide: `docs/adapter-deployment-guide.md`.

## Next Supervisor Checkpoint

- Keep `master` as the default new-device handoff branch.
- Keep existing overlay routing and hook status work as the base.
- Add script-driven workspace inspect/enroll before treating any hook deployment as a product path.
- Create project-local `.amo/` and `workspace.vaultRoot` for the first MVP. Deployments name the vault folder `.amo/AMO - <project>/`; test workspaces should be redeployed rather than migrated.
- Support `codex-cli` and `claude-cli` as active hook adapters. Treat Codex App as an accepted target-binding provider. Drop Kiro IDE adapter work from the active roadmap unless a future real workflow needs it.
- Implement the smallest bridge endpoint first: `POST /api/replies`.
- Preserve hook file-cache fallback and protocol-clean stdout.
- Add project-local vault reply note generation before broader Obsidian integration.
- Add append-only canvas file node creation after note generation is stable.
- Add overlay `Open Note`, `Open Canvas`, and automatic copy + focus only after bridge session fields exist.
- Add Obsidian plugin `Send current note annotations to AMO` as an explicit user action; do not replace the current copy-to-clipboard command.
