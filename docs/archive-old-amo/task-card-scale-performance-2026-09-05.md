# Task Card Scale And Performance

Date: 2026-09-05
Baseline: `2a166a8`, AMO 0.1.7.
Scope: preparation for hundreds of task cards; the Canvas feature itself is not implemented.

## Product Boundary

A task card represents one task/session. The existing overlay remains the compact single-task monitoring surface. The future Canvas adds an outer layer for nodes, groups, relationships, and task organization. This implementation keeps provider identities and the existing card interaction model intact.

## Measurements

Browser measurements used local headless Microsoft Edge, production React, the actual existing card markup/styles, and a 1536 x 960 viewport. Each case mounted all cards, changed one card per animation frame, discarded ten warm-up updates, and reported forty samples. Baseline mode renders `SessionRowContent` directly; optimized mode uses the new memoized `TaskCard` adapter. Both use the same task data, stable command functions, and DOM structure.

| Mounted cards | Baseline single-card update p95 | Optimized single-card update p95 | Optimized initial mount | DOM elements |
| --- | ---: | ---: | ---: | ---: |
| 20 | 1.9 ms | 0.5 ms | 13.4 ms | 1,387 |
| 100 | 6.3 ms | 0.6 ms | 32.7 ms | 6,907 |
| 300 | 14.7 ms | 1.4 ms | 57.2 ms | 20,707 |

The update measurements are synchronous React reconciliation/commit duration measured around `flushSync`. They are not total frame time, input-to-paint latency, or a Canvas pan/zoom benchmark. Initial mounting is not improved by memoizing later updates. Timing varies with machine load and card content.

An earlier exploratory fixture omitted the row's drag-column placeholder. The table above uses the corrected, matching layout in both modes; those earlier exploratory timings are superseded.

Broker measurements used synthetic data and Node 24.13.0:

| Workload | Baseline | After adjustment |
| --- | --- | --- |
| 100 ordinary owner hooks, 100 stored launches | 100 synchronous writes, 97.4 ms | 0 synchronous writes, 0.84 ms |
| 100 ordinary owner hooks, 300 stored launches | 100 synchronous writes, 136.8 ms | 0 synchronous writes, 0.27 ms |
| Active-page query, 100-1,000 active plus 5,000 archived | p95 0.55-0.77 ms | p95 0.72-0.90 ms with version metadata |

The hook figures measure the synchronous claim path for already connected, unchanged owners. Initial ownership and changed runtime identity still persist normally. The query figures cover an ordinary page and serialization, with synthetic sessions lacking real Obsidian health data. Query indexing was not introduced because this measurement did not establish it as a current bottleneck.

## Implemented Changes

### Single-Task Rendering

- Added a memoized `TaskCard` adapter over the existing card content.
- Added stable command dispatch through `useTaskCardCommands`; commands still see the latest handlers, and each receives its current task explicitly.
- The main overlay uses the adapter without changing its 20-card local pagination, card actions, or drag wrapper.
- Session replicas preserve unchanged object references across snapshots and ignore stale per-task results. This lets memoization continue working when another task updates.
- Session order reconciliation now uses sets instead of repeated linear membership searches.

The adapter is deliberately small. Canvas-specific groups, node handles, selection, and geometry belong to a future container outside the task card.

### Session Consistency

- Broker sessions now carry a process-instance ID and a mutation revision assigned when the state changes, before asynchronous persistence completes.
- Those runtime fields are excluded from durable session snapshots and reset under a new instance ID on restart.
- SSE publication resolves the current authoritative session rather than broadcasting a stale object captured before a disk await.
- Main and Priority Manager use the same freshness-aware replica implementation. Command responses, SSE updates, and snapshots preserve newer per-task state.
- Explicit deletion results carry versioned tombstones, including bulk deletion. A late deletion cannot remove a newer revived task, and a late older command cannot revive an already deleted task.
- Complete active snapshots establish a freshness barrier for sessions removed while the client was disconnected.
- Broker generation changes reset the transport revision gate. Request-generation checks reject an old in-flight response even when its old instance ID was never previously observed.
- SSE includes authoritative active/archive counts, maintained by the session collection without scanning every task per event.

This is still a snapshot-based local Broker, not a transaction log or an AI workbench command API. Disk failure acknowledgment policy remains the existing policy; durable operation IDs and Canvas edit conflicts are future work.

### Complete Hydration And Scheduling

- `GET /api/sessions?scope=active&snapshot=1&summary=1` returns the complete active snapshot in one synchronous query. Ordinary paginated queries retain their existing limits.
- Older Brokers that ignore `snapshot=1` are handled by consuming their pages. Mixed revisions during legacy pagination produce an explicit retryable loading error rather than silently combining inconsistent pages.
- Priority Manager applies ordinary single-session SSE payloads instead of requesting a full list for every task event.
- Reconciliation has a maximum wait so continuous invalidation cannot indefinitely postpone it.
- Hidden/offline views defer reconciliation, then catch up on resume even when their SSE transport remains healthy.

### Managed Launch Writes

Repeated owner observations no longer call the durable update path when connected state, owner identity, host PID, and binding revision are unchanged. `claimedAt` consequently describes the last durable claim transition rather than being rewritten by every ordinary tool hook. Creation, initial claim, changed host identity, supersession, and offline transitions preserve their existing persistence behavior.

## Verification

- Broker: 126 tests passed. Frontend runtime: 55 tests passed. These cover restart generations, delayed mutation completion, per-task freshness, tombstones/revival, complete active hydration, stable references, steady-owner writes, and bounded reconciliation.
- Production TypeScript/Vite build verified.
- Browser benchmark: no page errors in baseline or optimized mode; rendered output inspected.
- Isolated UI smoke: a real Broker seeded with 300 synthetic sessions, actual main and Priority Manager frontend code in two browser pages, and stubbed native capabilities. Verified access to session 299, shared title updates, Broker-only restart without page reload, and archive propagation to both pages. No page errors.
- Native focus/drag, real CLI launches, live Obsidian work, and Rust were not exercised. The normal AMO Broker and native app were not restarted or used for synthetic data.

## Reproduction

```powershell
node scripts/performance/session-scale.js
$env:AMO_PLAYWRIGHT_MODULE = '<installed-playwright-module-path>'
node scripts/performance/card-render.js baseline
node scripts/performance/card-render.js optimized
```

The browser runner requires the overlay dependencies, Playwright, and an installed Microsoft Edge browser. It starts a temporary HTTP server on an automatically assigned local port and closes it and the browser after the run. Output JSON and screenshots are under `tmp/card-performance`. Broker fixtures are written to fresh OS temporary directories. No real agent processes or sessions are used.

The run-specific full UI smoke harness is `tmp/session-ui-smoke.cjs`; it also starts and stops its own isolated Broker. It is intentionally outside the shipped application.

## Remaining Canvas Work

Hundreds of stored tasks and hundreds of simultaneously mounted full cards are different budgets. The following belong to the future Canvas wrapper:

- Cull nodes outside the viewport with a small margin. Keep task subscriptions/state alive independently of DOM mounting.
- Keep pan/zoom and drag geometry independent of task data updates. Camera movement should not rebuild every task's view model.
- Use a compact representation at low zoom; full task controls need only exist where usable.
- Keep selected IDs and graph relations separate from the overlay's priority/order and from provider lifecycle.
- Define a nonmodal window policy so the Canvas can remain open while the overlay is interactive. Existing utility windows still retain their current modal behavior.
- Keep native notifications, managed-window probing, and automatic clipboard/focus under one explicit runtime owner across windows.
- Measure simultaneous many-task bursts, Canvas edge rendering, first load, pan/zoom frames, memory, and background CPU when the actual Canvas exists.

Obsidian artifact writes remain synchronous, and session summaries still include pending prompt content for existing consumers. Those paths should be measured with realistic long conversations before selecting an asynchronous artifact queue or a smaller Canvas-specific projection. The tests here do not justify claiming that a finished 300-node Canvas will maintain a particular frame rate.
