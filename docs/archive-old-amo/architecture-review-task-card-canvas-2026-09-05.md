# Task Card Architecture Review Before Canvas

Date: 2026-09-05
Source baseline: `2a166a8` (`feat: stabilize task bindings and name sync`), AMO 0.1.7.
Status: investigation baseline. Subsequent implementation and measurements are recorded in `docs/task-card-scale-performance-2026-09-05.md`.

Product clarification: the existing task card remains a single-task unit. A future Canvas wraps that unit with its own node, grouping, and task-organization components. The current work does not turn the task card into a graph or workflow engine.

## Scope And Conclusion

The review follows the proposed direction: keep the established task-card overlay, make single-card extensions such as fork practical, and later add a separate task-card Canvas workbench with an AI-editable API. Canvas interaction design and provider-specific fork implementation remain separate discussions.

The current Broker / React / native-platform split is an appropriate foundation. The highest-value adjustments are session consistency, reusable card commands, explicit background-effect ownership, and a nonmodal window policy. These can be made incrementally while preserving current card behavior.

This review inspected startup and utility-window composition, session intake and reconciliation, persistence, managed launch ownership, card action composition, Obsidian artifacts, and relevant plans/tests. It did not measure live desktop frame rates, restart the running application, operate real agent sessions, or revalidate current provider CLI capabilities.

## Existing Foundations To Keep

- Broker authority over sessions, launches, and workspace enrollment.
- Separate `sessionId`, `launchId`, workspace identity, and native routing evidence. A window is not a conversation.
- Event-driven refresh, revision gating, single-flight hydration, and fallback polling.
- Coalesced asynchronous session snapshots and cached Obsidian health.
- Batched native managed-window probing and shell-first startup.
- Lazy secondary-window components. The current main list renders 20 cards per local page, so an immediate overlay virtualization rewrite is not justified by this review.
- Obsidian as a knowledge/artifact integration. Its existing conversation Canvas can continue serving that purpose.

## Verified Correctness Findings

### F1. Broker Restart Can Leave A Live Window Rejecting New State

Priority: P1. Evidence: source inspection and isolated execution of the actual revision gate.

`broker/server.js:57` initializes the event sequence to zero on each process start. `openSessionEventStream` includes `startedAt`, but `useBrokerSessions` reads only the ready event's revision. `SessionRevisionGate` accepts only nondecreasing revisions and has no process-generation reset.

Reproduction: load revision 900, then receive a restarted Broker snapshot at revision 0 and an event at revision 1. The snapshot is rejected and the event is classified as a duplicate. The stream can still report healthy. This persists until the new process catches up or the window resets its local gate.

Recommended adjustment: include a Broker instance identifier in snapshots and events, reconcile on generation changes, and invalidate in-flight requests from the previous generation. Do not simply accept every lower sequence, since ordinary delayed snapshots must still be rejected.

Acceptance: keep a client alive across an isolated Broker restart; it must recover without reloading the window, and late responses from the old instance must not replace the new snapshot.

Anchors: `broker/server.js:283`, `overlay/src/hooks/useBrokerSessions.ts` (`handleBrokerReady`), `overlay/src/runtime/sessionRevisionGate.ts`.

### F2. Publication Order Can Make Old Session State Look Newer

Priority: P1. Evidence: isolated execution of the actual session route and store, with persistence completion deliberately delayed.

Several mutation routes change the session, await asynchronous persistence, and only then publish the captured session object. Another hook can update and publish the same session while that await is pending. The earlier route subsequently publishes its old object with a larger global event sequence.

Reproduction using the reviewed route:

1. A review operation captures an `idle` session and waits for persistence.
2. A newer event changes the authoritative session to `running` and publishes sequence 1.
3. The review operation finishes and publishes the captured `idle` session as sequence 2.

The Broker store remains `running`; a client accepting publication sequence as freshness ends at `idle`. Mutation responses can also replace client state directly through React setters, bypassing the SSE revision gate.

Recommended adjustment: establish one session mutation/commit/publication contract. Assign entity freshness when applying a mutation and preserve that freshness across responses and events. Sequence durable commits/publication consistently. Route all client updates through the same freshness-aware reducer, including command results. A global transport sequence alone is insufficient.

Acceptance: concurrent hook + review, hook + title change, and hook + target binding must converge to the Broker's latest session even when disk operations and HTTP responses finish out of order. Include persistence-failure behavior in this contract.

Anchors: `broker/routes/sessions.js:131`, `broker/server.js:320`, `overlay/src/hooks/useSessionActions.ts`, `overlay/src/hooks/useTargetActivation.ts`.

### F3. Active-Session Hydration Stops At The First 200 Records

Priority: P2. Evidence: actual query execution and both client implementations.

`querySessions` limits active responses to 200 records. `useBrokerSessions.refreshSessions` requests only the default page and replaces its active-session collection with that page. It handles archive pagination separately, but does not consume active `hasMore`. Priority Manager also loads only the default page. The main window's 20-card UI pagination operates on the already truncated client collection.

Reproduction: 205 active records return `total=205`, `count=200`, `hasMore=true`. Five records remain absent from hydration. SSE can temporarily introduce an omitted record, which a later default-page refresh can remove again. Search, attention counts, and native monitoring also depend on the loaded collection.

Recommended adjustment: define a complete active hydration contract, or explicit server pagination plus independent summary/attention queries. For the current monitor, fetching all active summary pages is the smaller change, but page consistency under concurrent mutation must be handled. A future Canvas should fetch referenced sessions by identity rather than inherit the overlay's visible page.

Anchors: `broker/lib/session-query.js:3`, `overlay/src/hooks/useBrokerSessions.ts:118`, `overlay/src/windows/PriorityManagerApp.tsx`, `overlay/src/windows/MainOverlayApp.tsx:425`.

## Verified Performance Finding

### F4. Steady Managed Hooks Still Rewrite Launch Snapshots Synchronously

Priority: P2. Evidence: actual launch-store calls with synthetic data and instrumentation of file writes.

`launchStore.claim` calls `update` even for an already connected owner. `update` persists the whole launch collection through synchronous filesystem helpers. Events, prompts, and replies all call claim during intake. Session snapshot coalescing does not cover this file.

Reproduction: after the first owner claim, 100 ordinary `PostToolUse` claims produced 100 synchronous whole-file writes. One local run took 72.19 ms with only one synthetic launch. This is an operation-count finding, not a claim about production frame latency. A larger launch file or file contention can increase the cost.

On Windows, the shared synchronous replacement helper can additionally block for a cumulative 300 ms of retry sleeps before its fallback copy. The fallback is not equivalent to atomic rename. This matters for both event-loop responsiveness and crash consistency.

Recommended adjustment: distinguish durable ownership transitions from repeated observations. Coalesce steady observation writes, reuse the asynchronous writer pattern where applicable, and preserve explicit durable boundaries for creation, initial claim, supersession, and offline transitions. Test restart recovery and ownership preservation before changing acknowledgment semantics.

Anchors: `broker/lib/launch-store.js:29`, `broker/lib/launch-store.js:157`, `broker/lib/filesystem.js:139`, `broker/routes/obsidian.js:4`.

## Extension Boundaries Worth Adjusting

### A1. Reusable Card Behavior Is Still Entangled With The Main Window

`SessionRowContent` has a large action/busy-state prop surface and computes provider eligibility itself. `MainOverlayApp` composes data hooks, action hooks, native liveness, notifications, menu cleanup, clipboard/focus effects, and callback refs. `useBrokerSessions` owns the session array while also accepting UI-specific callbacks. Priority Manager has another session-loading implementation.

Recommended shape:

- A reusable session replica/reducer implementation with explicit query and subscription behavior.
- A small card view model and capability calculation shared by surfaces; the Broker remains responsible for validating commands.
- Card commands with explicit results, separated from menu positioning, feedback text, and React setters.
- Thin overlay and future Canvas adapters that select presentation and invoke those commands.
- One explicit native/background-effects owner for notifications, managed-window monitoring, and automatic clipboard/focus behavior.

Tauri WebViews have separate JavaScript heaps. Sharing an imported module does not create a process-wide singleton. Each window may have its own read replica using the same implementation, synchronized through the Broker. Reusing data access must not accidentally duplicate native monitoring or automatic actions.

This does not require Redux, a generic plugin system, or a broad file-size refactor. First extract one existing action and migrate it end to end as a regression-controlled example.

Anchors: `overlay/src/components/SessionCard.tsx:117`, `overlay/src/windows/MainOverlayApp.tsx:150`, `overlay/src/hooks/useBrokerSessions.ts:20`, `overlay/src/hooks/useManagedWindowLiveness.ts`.

### A2. Existing Utility Windows Are Modal Relative To The Overlay

The window creation/lazy-loading machinery is reusable, but its behavior does not meet the proposed independent Canvas requirement unchanged.

Opening Harness Lab sets `activeUtilityWindow`. The main window then renders `main-window-blocker`, and window-layer helpers lower the main window's always-on-top state. Close requests hide utility windows rather than unmounting them. Hiding therefore does not automatically dispose subscriptions or stop future Canvas work.

Recommended adjustment: add explicit window policy for whether a window blocks the main overlay, how focus/topmost state works, and what pauses on hide. Keep existing utility behavior initially. Use a nonmodal workbench policy for a future Canvas. Centralize registration enough to cover component routing, native capabilities, and window definitions together.

Acceptance: overlay card actions remain usable while a workbench is open; hiding the workbench pauses unnecessary work; reopening reconciles state; closing it does not change session lifecycle.

Anchors: `overlay/src/windows/MainOverlayApp.tsx:1083`, `overlay/src/hooks/useMainUtilityWindows.ts`, `overlay/src/windows/utilityWindow.ts:28`, `overlay/src-tauri/capabilities/default.json`.

### A3. Fork Needs A Distinct Command And Durable Relationship

Current `workspace-launch.js` implements new and resume flows. `codex-app-server.js` is a one-shot rename adapter. The repository's `managed-side-fork-plan.md` is an unimplemented Side Chat proposal that deliberately suppresses ordinary cards and generated artifacts. It is not an approved task-card Canvas contract.

Before implementing fork, define a separate command and its identity/results. Reuse managed launch creation and ownership guards. Preserve an independent provider session identity for the branch and represent its origin as durable relationship data. Card visibility should be a product decision, not a side effect of bypassing normal session intake.

Do not treat `sourceCardSessionId` on a launch as permanent task lineage: failed/offline launches older than 24 hours are pruned. Do not infer orchestration dependencies from inherited launch environment or `attached-child` routing.

Whether a fork is shown as a full card, a related card, or a compact attachment can be discussed later. Provider CLI/API capability checks belong to that implementation phase; this review does not reuse historical version checks as current facts.

Anchors: `broker/lib/workspace-launch.js`, `broker/lib/launch-store.js:9`, `broker/lib/launch-store.js:428`, `broker/lib/codex-app-server.js:7`, `docs/managed-side-fork-plan.md:6`.

### A4. Conversation Canvas And Task Workbench Have Different Lifetimes

The existing `canvas-writer.js` creates Obsidian file nodes for prompt/reply artifacts. Its edges represent conversation progression. It reads and rewrites the complete Canvas and bindings files during artifact handling. `handleReply` performs artifact writes before installing the resulting session update, so an artifact failure can also prevent that reply's card update.

The proposed workbench needs persistent layout and relationships that can survive session archival and window closure. Today dismiss deletes a session from the store, and the public `AgentSession` type contains provider lifecycle, window hints, review, pending prompt, and artifact fields in one projection.

Boundary to preserve for later design: graph/node identity is separate from `sessionId`; a node references a live session projection; removing a node is distinct from dismissing a session; missing/archived references have an explicit representation. Whether planning requires a separate `taskId` before any session exists remains an open product question.

Keep the current Obsidian Canvas as an artifact integration. Do not use its whole-file writer as the collaborative workbench's command store. If artifact decoupling is undertaken, use a recoverable ordered job/outbox contract so failures remain visible and retryable.

Anchors: `broker/lib/canvas-writer.js:107`, `broker/lib/conversation-service.js:96`, `broker/lib/session-store.js:632`, `overlay/src/types.ts:67`.

### A5. AI Editing Needs A Command Contract, Not Direct Store Access

The existing HTTP routes already provide useful operations. However, route context exposes the mutable session map, several routes combine validation, mutation, persistence, and publication, and mutation responses do not consistently expose freshness. Generic request IDs, expected revisions, and durable operation outcomes are not established for task editing. Resume has narrow pending-launch deduplication, which is not general request idempotency.

The future AI API and UI should call the same application commands. Establish typed request/result schemas, operation IDs, conflict checks, and bounded batch semantics for the new workbench. A repeated fork request should resolve to the same operation outcome; a stale layout write should report a conflict instead of overwriting another editor.

The current HTTP layer permits wildcard CORS and routes do not establish caller/workspace authorization. When adding AI write access, define an explicit local-client and workspace scope rather than assuming that loopback address alone identifies an authorized editor. Stage this contract with the new API and preserve existing adapter compatibility.

Graph editing and launching/sending to an agent should be distinct capabilities. AI-editable Canvas does not by itself imply an autonomous workflow executor. That distinction avoids accidentally expanding this investigation into a scheduler project.

Anchors: `broker/server.js` (`routeContext`), `broker/routes/sessions.js`, `broker/lib/http.js:3`.

## Secondary Optimizations

- Session queries decorate and sort the entire store before filtering/page selection. After correctness fixes, measure archive-heavy stores and consider query-first decoration and cached/indexed ordering.
- Session summary is an omission list and retains full pending prompts. Define a bounded card projection for new consumers; migrate current clipboard/search consumers deliberately rather than dropping fields blindly.
- Whole-file artifact operations share the Broker event loop. Measure duration and file size before choosing queue or worker boundaries.
- Utility apps are lazy, but the main app is eagerly imported through `App.tsx`. This build produced a 556.89 kB render-app chunk (113.98 kB gzip) and 169.41 kB shared CSS. Code splitting main/utility entry dependencies is a possible later improvement, not a demonstrated startup bottleneck.
- Current main cards render at most 20 per local page. Fine-grained subscriptions and stable action references matter more for a future many-node workbench than for a speculative rewrite of this list now.
- Update architecture/document status as changes land. `DEVELOPMENT.md` still contains older "recommended next tasks" for functionality already present; the Side Chat plan must not silently govern the new workbench direction.

## Recommended Implementation Order

| Batch | Scope | Completion evidence |
| --- | --- | --- |
| 1 | Broker generation, mutation freshness/publication, and active hydration | Restart, delayed response/flush, and more-than-200-session integration scenarios converge |
| 2 | Session command boundary and reusable client reducer; migrate existing actions incrementally | Existing card behavior preserved; two independent consumers converge; no duplicate native effects |
| 3 | Window policy for nonmodal workbenches | Overlay stays interactive with a second window; hide/show recovery verified |
| 4 | Coalesced steady launch persistence | Hook bursts reduce writes while launch ownership and crash/restart behavior remain correct |
| Later discussion | Fork visibility and lineage, Canvas task/node model, edit API and conflict/undo behavior | Separate product agreement before feature implementation |

Batches 1-3 are the relevant preparation for Canvas. Batch 4 can proceed independently. The secondary performance items and a generic extension framework should not become prerequisites for discussing or starting the workbench.

## Validation And Limits

- `npm run broker:test`: 121 passed, 0 failed.
- `npm run test:runtime` in `overlay`: 48 passed, 0 failed.
- `npm run build` in `overlay`: TypeScript and Vite production build passed.
- `node --experimental-strip-types tmp/architecture-audit-20260905.cjs`: four isolated probes completed; confirms revision rejection, 200-record pagination, synchronous launch-write count, and stale publication after delayed flush.
- Probe fixtures were created only under the ignored repository `tmp` directory. No live session data or active desktop processes were modified.
- Some runtime tests assert source wiring with regular expressions. Passing those tests does not establish multiwindow interaction, reconnect behavior, or native focus correctness.
- No native UI smoke, Rust build/test, real fork launch, or production load benchmark was performed. The report distinguishes reproduced defects from architectural recommendations and unmeasured optimizations.
