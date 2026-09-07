# Worktree consolidation review — 2026-09-07

The main checkout was fast-forwarded from 2a166a8 to 1d3cf7e before integrating local work. This preserves the existing task-card scale improvements and the already-ported binding/name-sync change.

## Included

- Main checkout: CLI-only startup for an existing directory, without workspace deployment or a managed launch record. Codex CLI, Claude CLI and Grok Build reuse terminal/provider preferences. DXX is an opt-in Codex CLI preset with a separate Credential Manager key and per-process routing.
- 37fe: independent Task Canvas foundation, task references, notes, connections, pan/zoom, explicit save/reload, revision conflicts and durable operation replay. The later Areas/orchestration document remains a proposal.
- 6dbf (reviewed diff observed before its external removal): preserve a previously resolved window identity across temporary offline observations and clear offline metadata when the owner reconnects. Adapted to the mainline claim deduplication logic.
- Review fix: strip inherited AMO launch/workspace/client identity from the Broker parent environment before applying the new launch's explicit identity. This prevents an ordinary CLI from inheriting an unrelated managed launch.
- Correct the older Broker integration assertion and README to check AMO-only task naming with explicit provider-name synchronization.

## Not included

- The 6dbf fallback that automatically matches a missing managed title token using only an exact project basename. Even a unique visible title cannot prove ownership when unrelated paths have the same basename. The existing strict token/HWND/PID resolution and manual recovery remain in place.
- The unused compact Canvas preview image is retained in the local consolidation backup, not shipped as a product asset.
- b72e's original 1ba3e93 patch is not applied twice: the adapted 2a166a8 commit is already in mainline. Its original branch is retained for history.
- 43a8 reports three modified files but has no Git content diff. It contains no additional feature to merge.

## Validation on the integrated source

- Broker unit/regression tests: 148 passed.
- Frontend runtime tests: 67 passed.
- Native Rust library tests (`cargo test --locked --offline --lib`): 20 passed, including strict title-token routing and saved HWND routing.
- Frontend production build: passed.
- Broker HTTP integration (`scripts/broker/verify.ps1 -Port 17655`): passed after updating the stale pre-2a166a8 naming assertion; persistence across restart verified.
- Adapter integration (`scripts/adapters/verify.ps1 -Port 17656`): passed.
- Isolated Canvas browser smoke: passed, zero page errors; screenshots reviewed at the minimum light-theme window size. Covers save/conflict/retry, fresh UI restore, missing/archived references, and hide/show polling.

The browser smoke stubs native window APIs; actual Windows Canvas stacking/focus has not been visually verified. DXX request construction and credential routing are tested, but no paid live gateway request was made.

## Recovery

Before integration/removal, modified and untracked source files plus useful ignored temporary artifacts were copied under `tmp/worktree-consolidation-20260907-201213/` in the main checkout. Main's original changes also remain in the stash named `worktree consolidation: main CLI and DXX original changes`. Worktree branches are retained; cleanup removes checkouts, not history. The 3ab3 and 6dbf worktrees disappeared externally during the initial inventory/backup pass; no full 6dbf filesystem backup was possible, but its complete source diff had already been read and the accepted reconnect behavior was reconstructed and tested.