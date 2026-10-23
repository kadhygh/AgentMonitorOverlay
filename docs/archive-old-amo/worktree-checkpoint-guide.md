# Multi-Worktree Checkpoint Guide

Use this guide when several Codex sessions are working in different worktrees and the user wants a clean checkpoint before switching machines.

## Goal

Each session should leave behind:

- a clear branch
- a scoped commit
- a push result or explicit push blocker
- a repo-local handoff note

This avoids mixing unfinished work from unrelated sessions and gives the next machine a deterministic restart point.

## Required Command Snapshot

Run and record:

```powershell
pwd
git rev-parse --show-toplevel
git branch --show-current
git status --short -uall
git remote -v
```

## Required Written Summary

Before committing, summarize:

- current task goal
- what is already done
- what is still not done
- biggest risk or blocker

Keep this factual. Do not claim validation that did not happen.

## Scoped Commit Rule

- Commit only files directly related to the current session's task.
- Do not stage unrelated dirty files from the same repo or from sibling worktrees.
- Prefer path-limited `git status`, `git diff`, and `git add`.
- Do not use `git add .` in a shared dirty worktree.

## Repo-Local Handoff Note

Create or update a Markdown note under:

```text
docs/session-handoffs/
```

Recommended filename:

```text
YYYY-MM-DD-<task-slug>-handoff.md
```

Minimum contents:

- task goal
- files changed
- design decisions
- verified
- not verified
- known issues or blockers
- next steps
- first commands for the next session

## Validation Expectation

Run the smallest useful validation for the actual change:

- build
- unit test
- smoke script
- syntax check

Document:

- exact commands
- pass/fail result
- why validation was skipped or blocked, if applicable

## Commit and Push

Suggested commit prefixes:

- `feat:`
- `fix:`
- `docs:`
- `chore:`

After commit, try:

```powershell
git push -u origin <current-branch>
```

If push is blocked, record the exact reason:

- no remote
- permission
- network
- branch policy

## Required Final Report Shape

Every session should report back with:

- worktree path
- current branch
- commit hash
- pushed or not pushed
- pushed branch name, if any
- committed file list
- change summary
- validation summary
- unfinished risks
- handoff note path

## Current Supervisor Guidance

For Agent Monitor Overlay specifically:

- keep `master` as the stable/default handoff branch
- prefer docs-only checkpoint commits when implementation exists but user validation is still pending
- keep unverified code changes out of a broad catch-all commit unless the user explicitly asks for that checkpoint
