# AMO Runtime And Obsidian Open Performance Optimization Plan

Updated: 2026-08-05

Status: ready for phased implementation

## Purpose

This document is the execution contract for improving AMO runtime responsiveness and making `Note` / `Canvas` jumps to Obsidian observable, bounded, and reliable.

It combines two related problem areas:

1. Broker session/event work currently performs repeated synchronous full-snapshot, filesystem-health, serialization, and refresh work on hot paths.
2. Overlay-to-Obsidian navigation is usually fast but has an intermittent long-tail delay, and the current implementation cannot distinguish Broker delay, Windows URI dispatch, Obsidian vault routing, plugin protocol handling, note loading, or window focus delay.

This plan complements `docs/runtime-architecture-v2.md`. Runtime Architecture v2 remains the ownership model; this document supplies the concrete performance work, investigation evidence, phase order, budgets, failure semantics, and validation matrix needed to execute the optimization safely.

## Product Outcomes

- A new or changed agent card appears from SSE without waiting for interval polling.
- High-frequency hook events do not repeatedly block the Broker on full synchronous snapshot work.
- `GET /api/sessions` remains fast as archived history grows.
- Clicking `Note` or `Canvas` produces immediate, truthful progress feedback.
- AMO can identify which phase caused a slow Obsidian jump from one correlated trace.
- A URI accepted by Windows is not reported as an opened note until the Obsidian plugin confirms the result.
- Existing vault recovery, tab reuse, review, Canvas focus-note, and managed-session behavior remain intact.

## Non-Goals

- No rewrite of Tauri, React, the Broker, or the Obsidian plugin framework.
- No takeover of Obsidian Canvas rendering.
- No automatic annotation submission, paste, Enter, or permission approval.
- No removal of atomic snapshot replacement.
- No assumption that an external application can always meet an AMO latency budget.
- No silent removal of archived session history.
- No broad UI redesign as part of the performance phases.

## Investigation Summary

### Session And Event Path

The current ordinary event path is:

```text
Codex/Claude hook
  -> POST /api/events
  -> update one session
  -> persistSnapshot()
       -> listSessions()
       -> refresh presentation fields for every session
       -> inspect Obsidian plugin health per distinct vault
       -> sort every session
       -> stringify the complete snapshot
       -> synchronously write a temporary file
       -> synchronously replace sessions.json
  -> publish a decorated session through SSE
  -> Overlay optimistically merges the changed session
  -> Overlay schedules a full GET /api/sessions reconciliation
  -> Overlay also performs a full GET /api/sessions every 3 seconds
```

Relevant implementation:

- `broker/routes/obsidian.js`
- `broker/lib/session-store.js`
- `broker/lib/obsidian-vault.js`
- `overlay/src/hooks/useBrokerSessions.ts`

Observed on the development machine:

- One transient `GET /api/sessions` request exceeded a 5-second client timeout during restart and active event traffic.
- Later requests returned normally, including approximately 22 ms from `curl` and approximately 363 ms from PowerShell.
- The response contained about 47 sessions and was approximately 260 KB at the time of the first investigation.
- A later isolated snapshot benchmark contained 53 sessions and wrote a 296,215-byte file.
- Twenty isolated `persistSnapshot()` samples measured 9.77 ms minimum, 11.51 ms median, and 16.09 ms maximum.
- The isolated benchmark does not reproduce antivirus, registry, Obsidian, file-lock, or concurrent event contention. The architectural concern is synchronous amplification and long-tail latency, not the isolated median alone.

### Confirmed Overlay Reconcile Defect

The current `scheduleEventRefresh()` implementation clears an existing timeout and returns without resetting the timer reference or scheduling a replacement:

```ts
if (eventRefreshTimer !== null) {
  window.clearTimeout(eventRefreshTimer);
  return;
}
```

After a second event cancels the callback, `eventRefreshTimer` can remain non-null indefinitely. Later events keep clearing a stale timer and never schedule SSE reconciliation. The 3-second interval poll partially masks this correctness defect.

### Note / Canvas To Obsidian Path

The current normal loaded-vault path is:

```text
Overlay click
  -> POST /api/obsidian/register-vault
       -> synchronously read Obsidian registry
       -> rewrite registry even when the vault is already present
       -> inspect vault runtime evidence synchronously
       -> if runtime is not known ready, synchronously run tasklist.exe
  -> ShellExecuteW(obsidian://open?vault=...)
  -> fixed 180 ms delay
  -> ShellExecuteW(obsidian://amo-open?...)
  -> immediately report "opened"
  -> asynchronously mark the session reviewed

Obsidian
  -> receive custom protocol
  -> validate target vault
  -> resolve the target file
  -> search existing Markdown/Canvas leaves
  -> reveal an existing leaf, or await leaf.openFile(...)
  -> reveal/focus the leaf
  -> no result acknowledgment is returned to Overlay
```

The cold/unloaded-vault path can add a standard URI bootstrap, a fixed 1,200 ms delay, and a second registration/runtime check.

Relevant implementation:

- `overlay/src/hooks/useObsidianOpen.ts`
- `overlay/src-tauri/src/opener.rs`
- `broker/lib/obsidian-vault.js`
- `broker/lib/filesystem.js`
- `broker/assets/obsidian/md-anno-tools/src/protocol/amo-open.ts`

### Measured And Confirmed Obsidian Risks

#### Synchronous process scan

`countObsidianProcesses()` runs `tasklist.exe` through `spawnSync()` without a timeout when runtime readiness is not already proven.

Twelve read-only measurements on the development machine:

```text
1909.2, 1807.0, 1784.0, 1610.2, 1565.1, 1624.1,
1881.9, 1452.5, 1859.4, 1617.5, 1555.9, 1601.5 ms
```

Summary:

- minimum: 1452.5 ms
- median: 1624.1 ms
- maximum: 1909.2 ms

This is a confirmed 1.5-1.9 second synchronous Broker stall whenever the unloaded/unknown-runtime branch performs the scan.

#### Vault runtime evidence checks

Twenty repetitions of all three evidence-file checks took approximately 33-40 ms per vault. A single check is therefore small on the current local disks and is not the primary measured long-tail source. It remains synchronous and should not be multiplied unnecessarily.

#### Registry rewrite and retry sleeps

`registerObsidianVault()` rewrites the global Obsidian registry on every click, including an already registered vault. The atomic replacement helper retries Windows `EACCES`, `EBUSY`, and `EPERM` failures with synchronous sleeps of 20, 40, 60, 80, and 100 ms before falling back to copy-and-delete.

This preserves data safety, but an unnecessary write can block the Broker for up to roughly 300 ms of retry sleep, plus filesystem work, when Obsidian or another process temporarily holds the registry file.

#### Fixed vault-routing delay

The loaded-vault path sends two protocol URIs separated by a fixed 180 ms delay. The delay is not proof that Obsidian has switched to or activated the requested vault. Under Obsidian startup, indexing, plugin loading, workspace restore, or CPU pressure, the second custom URI may arrive before the target vault plugin is ready.

#### No end-to-end completion signal

`ShellExecuteW` reports whether Windows accepted the URI invocation. It does not report whether:

- Obsidian received the URI;
- the correct vault plugin accepted it;
- the target file existed;
- an existing leaf was found;
- `leaf.openFile()` completed;
- the leaf was revealed and focused;
- the Obsidian application reached the foreground.

The current Overlay nevertheless reports `Note opened in Obsidian` and starts `markSessionReviewed()` immediately after successful URI dispatch. A request can therefore be marked opened/reviewed even if the plugin ignores it or fails later.

### Ranked Long-Tail Hypotheses

| Rank | Candidate | Evidence | Current confidence |
| --- | --- | --- | --- |
| 1 | Synchronous `tasklist.exe` on unknown runtime | Measured 1.45-1.91 s, no timeout | Confirmed slow branch |
| 2 | Broker event-loop queueing behind snapshot/registry/filesystem work | Multiple synchronous hot-path operations; one transient 5 s request timeout | High architectural risk |
| 3 | Fixed 180 ms vault-route race | No readiness acknowledgment before custom URI | High correctness risk |
| 4 | Obsidian `leaf.openFile()` or plugin/render workload | Awaited inside plugin but has no duration log or acknowledgment | Plausible, unmeasured |
| 5 | Obsidian registry lock/retry | Unconditional write plus up to about 300 ms synchronous retry sleep | Plausible intermittent contributor |
| 6 | Windows URI dispatch itself | `ShellExecuteW` is synchronous but normally returns after dispatch acceptance | Lower confidence until traced |

The implementation must add correlation and phase timings before claiming that every slow open has one cause.

## Architecture Rules For This Plan

### Broker

- Session mutation, snapshot persistence, presentation decoration, workspace health, and HTTP serialization are separate responsibilities.
- No ordinary hook request should synchronously scan system processes.
- No card-list read should mutate session state or perform an uncached external health scan.
- Snapshot durability remains atomic, but burst writes may be coalesced.
- Broker routes expose bounded operations and explicit timeout/error states.

### Overlay Runtime

- SSE is the primary low-latency update source.
- Full snapshot fetches are recovery/reconciliation operations, not a mandatory consequence of every SSE message.
- At most one session refresh is in flight.
- Long-lived timers, sequence tracking, retry, and cancellation belong in a runtime controller, consistent with `docs/runtime-architecture-v2.md`.
- UI text distinguishes `request sent`, `plugin received`, `opened`, and `failed`.

### Tauri Platform Port

- URI dispatch reports dispatch acceptance only.
- Tauri does not claim that an external application completed work.
- Native calls expose duration and structured failure codes.
- React hooks should call a typed platform port rather than raw command strings after the runtime-controller phase.

### Obsidian Plugin

- Custom open requests are idempotent by request ID.
- The plugin reports received, success, ignored, not-found, and error results.
- Existing-leaf focus and new-leaf open remain separate timed phases.
- The plugin does not block note opening on debug logging or acknowledgment delivery.

## Phase P0: Baseline And Correlated Tracing

Implement observability before changing routing semantics.

### Open request identity

Generate an `openRequestId` in Overlay for every `Note` or `Canvas` click. Include it in:

- Overlay debug events;
- vault registration request;
- vault-route and custom protocol URI query parameters;
- Tauri dispatch logs;
- Obsidian plugin protocol logs;
- plugin result acknowledgment;
- session reviewed mutation metadata when applicable.

Use a random UUID. Do not derive it from the session, path, or user content.

### Required phase events

Overlay:

- `obsidian.open.click`
- `obsidian.open.registration.start|ok|error|timeout`
- `obsidian.open.vault_route.dispatch.start|accepted|error`
- `obsidian.open.plugin_uri.dispatch.start|accepted|error`
- `obsidian.open.ack.received|timeout`
- `obsidian.open.complete|failed`

Broker:

- `obsidian.register.start|complete`
- registry read/write/skip duration
- runtime evidence duration
- process probe cache hit/miss, duration, timeout, and result
- route queue/handler duration

Tauri:

- scheme, request ID, command start/end, elapsed milliseconds, and structured dispatch result
- do not log full sensitive query content by default

Obsidian plugin:

- `protocol.open.received`
- vault acceptance/foreign-vault rejection
- target resolution duration
- existing-leaf lookup duration and result
- `leaf.openFile` start/end/error
- reveal/focus completion
- acknowledgment post result

### Clock handling

- Record local monotonic phase duration with `performance.now()` or `Instant`.
- Record wall-clock UTC timestamps for cross-process ordering.
- Do not calculate a precise cross-process duration by subtracting unrelated monotonic clocks.
- The request ID and UTC timestamps provide the cross-process trace; each process owns its phase duration.

### Baseline collection

Collect at least 30 opens for each warm scenario and 10 for each cold/error scenario before changing behavior. Keep debug logging temporary and bounded.

Acceptance:

- One request ID reconstructs the complete path from click through plugin completion.
- The trace distinguishes Broker wait, process scan, registry write, vault routing, plugin receipt, leaf open, and focus.
- Debug logging failure never delays the open operation.

## Phase P1: Snapshot And Session List Hot-Path Separation

### Separate raw snapshot data from presentation data

Replace the current shared `listSessions()` dependency with explicit functions such as:

```text
getRawSessionsForSnapshot()
getSessionSummaries(options)
getSessionDetails(sessionId)
```

`persistSnapshot()` must not call the decorated card-list function.

Snapshot serialization must not:

- inspect Obsidian plugin health;
- refresh display names from external provider data;
- mutate the sessions map;
- calculate UI-only ordering unless ordering is stored state;
- copy workspace-level health onto every session.

### Workspace-level health cache

Move Obsidian plugin health to a Broker-lifetime cache keyed by normalized vault root or workspace ID.

Recommended policy:

- normal TTL: 30-60 seconds;
- shorter error TTL: 5-10 seconds;
- explicit invalidation after enroll/deploy/plugin update;
- force refresh from Workspace Panel diagnostics;
- stale-while-revalidate for card-list reads;
- publish a workspace-health event when a background refresh changes the result.

### Coalesced asynchronous persistence

Introduce a snapshot writer with:

- 100-250 ms debounce;
- maximum wait near 1 second;
- one write in flight;
- a dirty flag so changes arriving during a write schedule another flush;
- asynchronous file I/O;
- temporary file plus atomic replacement;
- explicit `flush()` for shutdown and durability-sensitive user operations;
- structured error state and retry without losing the in-memory authoritative state.

Ordinary `PreToolUse` and `PostToolUse` events should not wait for a complete full-snapshot write. User mutations such as archive, dismiss, task-title, priority, and display-order changes may await a flush before returning.

Acceptance:

- A snapshot write never calls plugin-health inspection.
- A burst of 20 hook events produces substantially fewer than 20 full snapshot writes.
- The final snapshot contains the last event from the burst.
- Broker remains responsive while a snapshot write is in progress.
- Atomic replacement and restart recovery tests pass.

## Phase P2: Session Runtime Reconciliation

This phase implements the Session Runtime Controller described by Runtime Architecture v2.

### Correct the timer defect

Until the controller lands, immediately correct `scheduleEventRefresh()` so it is a valid debounce or throttle. Add fake-timer coverage reproducing two rapid SSE events.

### SSE-first policy

When an SSE event contains a complete changed session:

- merge it locally;
- update ordering membership when needed;
- do not automatically fetch the full list.

Perform full reconciliation on:

- initial startup;
- SSE connect/reconnect;
- detected sequence gap;
- collection-level events without a complete session;
- explicit user retry/refresh;
- Broker revision mismatch;
- low-frequency recovery polling while SSE is unavailable or unhealthy.

### Request control

- Only one `GET /api/sessions` request may be in flight.
- Reuse the in-flight promise or cancel an obsolete request with `AbortController`.
- Add a bounded timeout and distinguish timeout from Broker HTTP error.
- Increase healthy SSE fallback polling from 3 seconds to 30-60 seconds, or disable it while the stream is healthy.
- Add Broker snapshot revision/sequence metadata so stale responses cannot overwrite newer SSE state.

Acceptance:

- Twenty rapid SSE events update cards without twenty full list requests.
- A sequence gap triggers exactly one reconciliation.
- A stale GET response cannot overwrite a newer SSE update.
- Reconnect restores an intentionally dropped event.
- Pending prompt and permission updates remain low latency.

## Phase P3: Obsidian Registration Fast Path

### Make registration idempotent

Do not rewrite the global Obsidian registry when the existing vault entry already has the required path/open state and no repair is required.

Registration results should expose:

- `registryChanged`;
- `registryWriteDurationMs`;
- `runtimeEvidence`;
- `processState` as `running`, `not_running`, or `unknown`;
- cache status and age.

Do not use a timestamp-only change as a reason to rewrite the registry on every note click.

### Cache registration and runtime readiness

Cache stable registration metadata by normalized vault root. Invalidate when:

- workspace enrollment changes;
- vault path changes;
- registry mtime/revision changes externally;
- Obsidian plugin heartbeat indicates a different runtime state;
- the user requests a force check.

Prefer registering/repairing the vault during workspace enroll/deploy rather than on every navigation click. The click path should normally be read-only and cache-backed.

### Remove synchronous unbounded process scanning

Replace `spawnSync(tasklist.exe)` with one of these bounded implementations, in priority order:

1. a cached native/Tauri process-status port;
2. an asynchronous child process with a hard timeout;
3. a background Broker probe whose result is not required to accept the click.

Recommended process-state cache TTL: 5-10 seconds. Recommended hard probe timeout: no more than 500-750 ms. Timeout produces `unknown`, not an indefinite request.

Recovery behavior must remain conservative when state is unknown; it must not fire a known-bad URI solely to avoid showing a recovery message.

### Bound the Overlay request

Add timeout/cancellation support to Broker client operations. A registration request must not keep the card button busy indefinitely.

Acceptance:

- Warm already-registered navigation performs no registry write and no process scan.
- Warm registration p95 is under 50 ms on the development machine.
- Process probing cannot block the Broker beyond its configured timeout.
- A locked registry produces a bounded, explicit error or cached fallback.
- First-open vault recovery behavior remains correct.

## Phase P4: Reliable Obsidian Open Handshake

### Replace fixed delay with readiness/result signaling

The fixed 180 ms vault-route delay is not a readiness protocol. Introduce a correlated open-request state machine:

```text
created
  -> registration_ready
  -> vault_route_dispatched (only when required)
  -> plugin_uri_dispatched
  -> plugin_received
  -> opened
  -> focused

Any state -> failed | timed_out | recovery_required
```

The Obsidian plugin posts a non-blocking result to a Broker endpoint such as:

```text
POST /api/obsidian/open-results
```

Minimum result fields:

```json
{
  "openRequestId": "uuid",
  "vaultRoot": "...",
  "target": "note",
  "targetPath": "Sessions/...md",
  "status": "opened",
  "reusedLeaf": true,
  "phaseDurations": {
    "resolveTargetMs": 1,
    "findLeafMs": 2,
    "openFileMs": 0,
    "revealFocusMs": 4
  }
}
```

The acknowledgment contains identifiers and timings, not note body content.

### Active-vault readiness

A historical runtime file proves that a vault was loaded at least once, not that its plugin is currently ready to receive the next custom URI.

Add a lightweight plugin runtime registration/heartbeat containing:

- vault ID/root identity;
- plugin version;
- Broker URL;
- loaded timestamp;
- last heartbeat timestamp;
- optional Obsidian window/process identity when safely available.

When the target vault plugin is recently active, dispatch the custom URI directly. When it is not active:

- dispatch the vault route once;
- wait for target-vault plugin readiness or a bounded timeout;
- then dispatch the custom URI;
- do not rely on a fixed sleep alone.

If a full heartbeat mechanism is too large for the first implementation, start with request acknowledgment plus bounded retry, but keep the protocol fields forward-compatible with heartbeat-based readiness.

### Idempotency and retry

- Include `openRequestId` in the URI.
- The plugin remembers a bounded set of recently completed request IDs.
- A retry must focus the same target and must not create duplicate tabs.
- Existing file-path leaf reuse remains the final duplication guard.
- Retry only after a missing acknowledgment or explicit retryable failure.

### Truthful UI and review semantics

Use distinct feedback:

- `Sending Note request...`
- `Waiting for Obsidian...`
- `Opening Note...`
- `Note opened in Obsidian.`
- `Obsidian accepted the request but did not confirm it yet.`
- explicit recovery or failure message

Do not keep the card globally blocked for an unbounded external-app operation. After a short threshold, allow retry/cancel while preserving the request trace.

Call `markSessionReviewed(open-note/open-canvas)` only after plugin success acknowledgment. If the product intentionally allows dispatch acceptance to count as review in a future decision, record it as a separate action such as `open-note-dispatched`; do not label dispatch acceptance as confirmed open.

Acceptance:

- Existing open note: plugin acknowledgment confirms reused leaf and focus.
- New note: acknowledgment follows successful `leaf.openFile()` and reveal.
- Foreign vault, missing target, and plugin exception return explicit failures.
- No successful review mutation occurs after plugin rejection or timeout.
- Retrying one request does not create duplicate tabs.
- Same-active-vault warm opens do not perform an unnecessary vault switch.

## Phase P5: Session Payload And Card-List UX

### Summary and detail endpoints

Create a card summary DTO that contains only fields needed by the monitor. Move large or infrequently used fields to session/workspace detail endpoints.

Candidates to load on demand include:

- complete last message;
- complete pending prompt;
- transcript path;
- note/canvas provenance history;
- full plugin health;
- full window/target diagnostics.

### Active and archive scopes

Prefer:

```text
GET /api/sessions?scope=active
GET /api/sessions?scope=archived&offset=0&limit=50
GET /api/session-counts
GET /api/sessions/:sessionId
```

The main monitor should not download all archived details merely to show active cards and an archive count.

### Visibility cues

- Show `X active · showing Y`.
- If the hard rendering limit is reached, say `showing first 20` instead of silently slicing.
- Indicate `new card below` when a new/unseen card is outside the viewport.
- Make `need attention` actionable as `jump to next attention` or a filter shortcut.
- Mark a new card unseen until it enters the viewport or the user interacts with it.
- Preserve user scroll position; do not force-scroll while the user is reading another card.

Virtualization is deferred until active-card counts or render measurements justify it. Twenty rich cards can remain directly rendered for now.

Acceptance:

- The user can tell whether a card is below the viewport or outside the render cap.
- Opening the archive triggers archive data loading; startup does not load full archived details.
- Active summary payload remains within the defined payload budget.

## Phase P6: Stable Startup And Failure Recovery

Make Stable startup transactional:

1. build/validate frontend;
2. build native executable;
3. start Vite and record PID;
4. start native app and record PID;
5. wait for native process, Broker health, Vite health, and initial sessions response;
6. report all component PIDs and log paths;
7. if any step fails, stop only the components started by this attempt.

Add health-only and restart-only commands so a normal UI restart does not require an unnecessary Rust rebuild.

Acceptance:

- A failed app start does not leave a new orphan Vite process.
- Failure output names the failed component, exit code, and log path.
- Success means Vite, native app, Broker, and initial session load all passed health checks.

## Performance Budgets

Budgets are measured on the development machine under the validation load. External Obsidian cold startup may exceed the warm-open budget, but AMO must remain responsive and show the correct phase.

| Operation | Target |
| --- | ---: |
| Broker event handler excluding deferred durability | p95 < 50 ms |
| Active session summary endpoint | p95 < 100 ms |
| Warm cached vault registration/status | p95 < 50 ms |
| Any synchronous Broker main-thread segment | < 50 ms |
| Process probe | hard timeout <= 750 ms |
| Tauri URI dispatch call | p95 < 50 ms |
| Warm same-vault click to plugin receipt | p95 < 300 ms |
| Existing-leaf plugin handling | p95 < 150 ms after receipt |
| New-note plugin handling | p95 < 500 ms after receipt, excluding pathological external plugin/render load |
| Warm same-vault end-to-end confirmed open | p95 < 750 ms, p99 < 2 s |
| Slow-path progress indication | visible within 1 s |
| Snapshot durability lag during event burst | normally < 1 s |

Every timeout must produce a recoverable state. A timeout is not permission to report success.

## Automated Test Plan

### Broker

- Snapshot serialization does not invoke plugin-health inspection.
- Burst persistence coalesces writes and preserves the final state.
- Events arriving during an in-flight write trigger a later flush.
- Atomic replacement failure retains in-memory state and exposes retryable diagnostics.
- Health cache TTL, stale-while-revalidate, and deploy/update invalidation.
- Registration skips an unchanged registry write.
- Process probe success, timeout, error, and cache behavior.
- Open-result request ID validation and bounded retention.
- Session summary/detail and active/archive scope contracts.

### Overlay

- Two rapid SSE events do not strand the reconcile timer.
- Complete SSE session updates do not trigger unnecessary full fetches.
- Sequence gap and reconnect trigger one reconciliation.
- Single-flight refresh and stale-response rejection.
- Open state machine success, timeout, retry, recovery-required, and cancellation.
- Session is reviewed only after confirmed plugin success.
- Visibility counts and offscreen-new-card indication.

### Obsidian Plugin

- Foreign-vault request is rejected and acknowledged.
- Missing target is acknowledged as not found.
- Existing Markdown/Canvas leaf is reused.
- New leaf `openFile()` success and exception paths.
- Duplicate request ID is idempotent.
- Acknowledgment failure does not block or undo a successful open.
- Phase duration fields are present and finite.

### Tauri

- Supported URI schemes dispatch through the platform port.
- Unsupported schemes remain rejected.
- Dispatch result is not represented as external completion.
- Duration and structured error mapping remain correct.

## Manual Validation Matrix

Run each applicable case for both `Note` and `Canvas`:

| Obsidian state | Vault state | Target state | Expected behavior |
| --- | --- | --- | --- |
| closed | registered and previously loaded | target exists | start/route, wait visibly, confirm through plugin |
| running | target vault active | leaf already open | direct request, reuse and focus leaf |
| running | target vault active | leaf not open | direct request, open new tab, acknowledge |
| running | another vault active | target vault loaded | bounded route-to-vault readiness, then open |
| running | target vault never loaded | target exists | explicit recovery; no false success |
| running/busy | target vault active | large note | progress remains responsive; trace attributes plugin time |
| running | registry temporarily locked | target exists | cached fast path or bounded explicit failure |
| running | plugin disabled/outdated | target exists | explicit timeout/health failure; no review mutation |
| running | target missing | missing | plugin not-found result |
| running | target active | repeated click/retry | no duplicate tab |

Also run under:

- 100 stored sessions, 20 active sessions;
- 10-20 hook events per second for 60 seconds;
- SSE disconnect/reconnect;
- snapshot write in flight;
- archive panel opening;
- continuous window drag and rapid button input.

## Rollout And Commit Strategy

Use one coherent commit per checkpoint:

1. `perf: trace runtime and obsidian open phases`
2. `perf: separate session snapshots from presentation health`
3. `perf: coalesce async session persistence`
4. `fix: make session SSE reconciliation deterministic`
5. `perf: cache and bound obsidian vault registration`
6. `feat: confirm obsidian open requests end to end`
7. `perf: split active session summaries from archive details`
8. `feat: expose card visibility and offscreen attention`
9. `fix: make stable startup transactional`

After each checkpoint:

```powershell
npm run broker:test
cd overlay
npm run test:runtime
npm run build
cd src-tauri
cargo test
cargo check
cd ..\..
git diff --check
```

Restart AMO and run the manual smoke subset relevant to the checkpoint. Do not combine snapshot semantics, SSE policy, and Obsidian routing semantics in one unreviewable change.

## Rollback Boundaries

- Tracing can remain even if later behavior phases roll back; it must stay disabled by default.
- The async writer can fall back to immediate atomic persistence behind one configuration switch during rollout.
- SSE-first mode can retain low-frequency polling as a recovery switch.
- The Obsidian acknowledgment path can initially run in observe-only mode while the existing routing remains authoritative.
- Do not remove the current recovery dialog until the new handshake passes every cold/unloaded-vault case.
- Do not make confirmed acknowledgment mandatory for review semantics until the deployed plugin version supporting acknowledgments is verified.
- Maintain compatibility with older deployed plugins: detect capability/version and use a clearly labeled legacy dispatch mode without claiming confirmed open.

## Execution Order And Stop Conditions

Proceed in this order:

1. P0 tracing and baseline.
2. P1 snapshot/list separation and coalesced persistence.
3. P2 session runtime reconciliation.
4. Re-run the Obsidian open baseline under reduced Broker contention.
5. P3 registration fast path.
6. P4 acknowledgment/readiness handshake.
7. P5 payload and visibility UX.
8. P6 startup recovery.

Stop and reassess before continuing when:

- snapshot recovery loses the last durable state;
- hook latency or permission delivery regresses;
- SSE sequence handling drops or reorders a user-visible state;
- a new Obsidian route creates duplicate tabs;
- a foreign vault accepts a request intended for another vault;
- legacy deployed plugins are incorrectly reported as confirmation-capable;
- measured traces show the dominant remaining delay is outside the phase being changed.

## Definition Of Done

This optimization program is complete when:

- the performance budgets pass under the defined load;
- session persistence, SSE recovery, and restart tests pass;
- warm Note/Canvas opens have a measured end-to-end trace and confirmation;
- slow opens identify their phase instead of appearing as an undifferentiated spinner;
- no URI-dispatch-only result is labeled as confirmed open;
- offscreen or capped cards are explicitly discoverable;
- Stable restart cannot leave a misleading partial runtime;
- architecture, validation, and user-facing documentation reflect the final behavior.

## Implementation And Validation Record (2026-08-06)

### Delivery status

The implementation phases in this plan are now landed in the working tree:

| Phase | Status | Delivered behavior |
| --- | --- | --- |
| P0 | complete | Correlated `openRequestId` tracing from overlay registration/dispatch through plugin lookup, open/reuse, reveal, focus, and terminal result. |
| P1 | complete | Raw snapshots no longer contain derived Obsidian health; health is cached; snapshot persistence is asynchronous, coalesced, atomic, retryable, and explicitly flushable. |
| P2 | complete | The stale debounce-timer defect is fixed; complete SSE session events apply directly; revision gaps/reconnects use one single-flight reconcile; fallback polling runs only while SSE is unhealthy. |
| P3 | complete | Vault registration is idempotent and bounded; unchanged registry files are not rewritten; Windows process detection is asynchronous with a 650 ms hard timeout and a 7.5 s cache. |
| P4 | complete | Plugin 1.5.0 publishes runtime heartbeat/capabilities and terminal open results; overlay retries once with the same ID; only confirmed plugin completion may mark a reply reviewed. |
| P5 | complete | Active summaries load first, archive pages load lazily, full details have a separate endpoint, and the 20-card view now has paging/counts/off-page attention instead of silently hiding cards. |
| P6 | complete | Stable startup validates/builds before shutdown, activates transactionally, starts an explicit current-source Broker, checks Vite/Broker/initial sessions/native app, and restores the old executable on failed activation. Health-only and restart-only commands are available. |

### Measured results

Measurements were taken locally on Windows from the working tree. They are evidence for the relevant hot paths, not a claim about every Obsidian vault or machine:

| Scenario | Result | Budget/result interpretation |
| --- | ---: | --- |
| Original synchronous `tasklist` process scan | 1.45-1.91 s; median about 1.62 s | Confirmed as a dominant long-tail blocker and removed from the request thread. |
| Hook/event handler under isolated load | p95 2.93 ms | Passes the 20 ms handler budget with persistence deferred. |
| Active summary endpoint under isolated load | p95 2.68 ms | Passes the 50 ms warm summary budget. |
| First registration, unloaded vault/process-cache miss | 677.67 ms | Bounded; the 650 ms process probe timed out and returned `unknown` rather than blocking indefinitely. |
| Cached registration | p95 3.43 ms | Passes the 50 ms cached-registration budget. |
| Repeated unchanged registration | `changed=false` | Registry rewrite/timestamp churn removed. |
| Snapshot settling after load | `dirty=false`, `inFlight=false` | Coalesced writer drained successfully. |
| Runtime/result protocol fixture | heartbeat active; terminal result `opened` | End-to-end Broker protocol passed with correlated request ID. |
| Real Stable runtime after restart | 56 stored sessions, 13 active summaries, revision present | Broker health, current-source initial summary, Vite, and native app checks passed. |

The original Stable restart audit also found a separate operations blocker: `Get-CimInstance Win32_Process` could itself hang for tens of seconds on this host. Stable process discovery now uses executable paths and bounded port-owner queries instead of WMI/CIM. A full build/start and a subsequent `npm run amo:restart` both completed successfully after the change.

### Automated verification record

- Broker unit suite: 83/83 passed.
- Overlay runtime suite: 13/13 passed.
- Broker end-to-end verification: passed on isolated port 17665, including workspace/session/persistence flows.
- Isolated load/protocol verification: passed on port 17664 with temporary application data.
- Overlay production build: passed.
- Obsidian plugin TypeScript/build output: passed; generated `main.js` matches plugin 1.5.0 sources.
- Rust/Tauri `cargo check`: passed.
- Stable full build/start readiness: passed.
- Stable restart-only readiness: passed.
- Stable health-only check: passed with native App, Vite, Broker, revision-bearing active summary.
- PowerShell parser validation: passed for `amo.ps1`, Stable startup, and Broker verification scripts.
- Final sensitive-pattern search and `git diff --check`: passed; no synchronous `tasklist`, 3-second session polling, fixed 180 ms route delay, or literal newline-escape corruption remains.

### Manual Obsidian validation still required

The code and protocol are complete, but the manual matrix above is deliberately not marked as passed in this record. Existing enrolled vaults must first receive/reload `md-anno-tools` 1.5.0; an older plugin cannot emit `runtime-heartbeat-v1` or `open-result-v1` and therefore cannot prove completion.

After deploying 1.5.0, run the matrix for both Note and Canvas, especially:

1. warm active-vault open and already-open leaf reuse;
2. Obsidian cold start;
3. another vault active / target vault loaded;
4. target vault never loaded;
5. missing file and plugin disabled/outdated;
6. repeated click plus timeout retry, confirming no duplicate tab;
7. large note or busy Obsidian, checking which plugin phase owns the latency.

For every case, capture the single `openRequestId` and verify that URI dispatch is never presented as confirmed success. Review state must remain pending for timeout, rejected, not-found, error, and legacy/unconfirmed results.

### Operational commands

```powershell
npm run amo:health
npm run amo:restart
npm run amo:stable
npm run broker:test
npm run broker:verify
cd overlay
npm run test:runtime
npm run build
```

Use `amo:health` for a read-only readiness check, `amo:restart` when the existing Stable binary is already current, and `amo:stable` when source changes require frontend validation and a new native build.