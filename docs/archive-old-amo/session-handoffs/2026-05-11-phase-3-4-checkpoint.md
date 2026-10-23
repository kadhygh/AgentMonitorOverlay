# Phase 3/4 Checkpoint - 2026-05-11

This note captures the current Agent Monitor Overlay checkpoint before another manual validation round.

## Scope

- exact-route and ambiguity UX tightening
- Codex repo-local hook loading investigation
- future Obsidian task-card split
- multi-worktree continuation hygiene

## Current Branch Baseline

- repo branch: `master`
- current stable handoff branch remains `master`
- Phase 3/4 MVP scope remains read-only monitoring plus click-to-window routing

## Implemented In Workspace

- session rows now expose route hints: exact, token, fallback
- ambiguous activation now opens a candidate/debug panel instead of only returning a vague failure message
- row handle remains visible as a placeholder, but card reorder is intentionally disabled for now
- session rows now expose a dismiss action
- dismiss is overlay-local only; it does not delete the broker session
- dismissed sessions are remembered under `amo.dismissed.sessions.v1`
- a dismissed session is expected to return after a later real hook event changes `eventCount` or `updatedAt`
- repo-local Codex hook files now exist under `.codex/`
- future Obsidian exploration has been split into three task docs: external note jump, plugin model, sync-back bridge

## Validated So Far

- `npm run build` in `overlay/` after the current overlay UI changes
- `cargo test` in `overlay/src-tauri/` after recent routing refinements
- adapter dry runs for explicit routing override guardrails
- broker can receive at least some real Codex hook events in disposable smoke attempts

## Not Yet Verified

- real exact-route behavior when several windows share the same terminal host
- duplicate/conflict routing flow in a real session, including manual candidate selection from the debug panel
- real dismiss flow: dismiss a live card, emit another hook event in the same session, confirm the card returns
- clean Codex hook-runner success without `hook failed` or timeout noise
- whether the current repo-local hook wrapper reliably emits `Stop` in the same stable way as `SessionStart` and `UserPromptSubmit`

## Current Hook Diagnosis

Current state is narrower than a generic broker failure:

- project-local hooks are discoverable
- `/hooks` review is part of the real path
- broker delivery can succeed
- Codex may still label the hook command as failed

That means the remaining problem is likely in the hook runner path, timing, or wrapper behavior, not in the broker contract itself.

## Suggested Next Manual Validation

1. Use a real exact-route row from the live workflow and click through it.
2. Keep a duplicate/conflict window around and verify the candidate/debug panel path.
3. Confirm the row handle is now only a harmless placeholder.
4. Run a repo-local Codex hook smoke in an interactive session, ideally in a disposable test project before using the main repo.
5. After a card appears from real hook traffic, click dismiss, then trigger another prompt in the same session and confirm the card returns.

## Suggested First Commands For The Next Session

```powershell
git status --short -uall
git branch --show-current
Get-Content DEVELOPMENT.md
Get-Content docs/supervisor-status.md
Get-Content docs/validation-checklist.md
```

For multi-session cleanup:

```powershell
Get-Content docs/worktree-checkpoint-guide.md
```
