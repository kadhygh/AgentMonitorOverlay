# AMO Shell-first Startup And Runtime Refactor

Updated: 2026-08-14

Status: active implementation plan

Branch: `codex/shell-first-runtime-refactor`

This is the living execution document for making AMO visibly responsive before its Broker and task data are ready. It also advances the Session Runtime Controller direction in `docs/runtime-architecture-v2.md` and records polling ownership, migration decisions, validation evidence, and phase completion as the implementation proceeds.

## Goal

AMO must present a truthful, usable UI shell before background runtime work completes.

The product invariant is:

> Native window first, UI shell second, runtime work afterward.

Broker startup, the initial session snapshot, SSE connection, managed-window probes, Harness status checks, credentials, workspaces, and remote versions must not gate the first visible AMO shell.

## Scope

This refactor covers:

- native startup window and Main Overlay handoff;
- HTML boot, React shell, and initial UI configuration;
- Broker startup ownership and startup state semantics;
- session snapshot, SSE, reconcile, and fallback refresh ownership;
- utility-window lifecycle coordination;
- Overlay and Harness polling policy;
- startup and runtime performance instrumentation;
- Source Stable fast-start direction;
- architecture documentation and automated regression coverage.

It does not change Broker authority, provider/session identity, Obsidian artifact ownership, Harness installation policy, credential security boundaries, or provider hook protocols.

## Baseline Architecture

Current application-process startup:

```text
Tauri process
  -> create startup and main WebView windows
  -> show startup; keep main hidden
  -> main installs startup-status replay listener
  -> main starts/ensures Broker
  -> React mounts the complete MainOverlayApp runtime
  -> first session snapshot is requested
  -> hasLoadedSessionSnapshot OR Broker error
  -> complete_startup shows main and closes startup
```

Current Source Stable cold start adds a launcher-level critical path before the Tauri process exists:

```text
npm run build
  -> cargo build
  -> stop previous UI
  -> start and verify Vite
  -> start and verify Broker
  -> start Tauri
```

The launcher path and application-process path require separate performance budgets and separate fixes.

## Confirmed Problems

### P0: Main visibility is data-gated

`complete_startup` currently depends on either a successful initial session snapshot or a Broker error. A slow or unavailable data source therefore controls whether the real AMO window can appear.

### P0: Initial snapshot failure can strand the startup window

When SSE is healthy but the initial snapshot fails, the snapshot error path intentionally avoids changing Broker readiness to `error`. The result can be:

```text
sseHealthy = true
hasLoadedSessionSnapshot = false
brokerReadiness = ready
```

Neither condition that triggers `complete_startup` is satisfied, so the startup window can remain indefinitely.

### P1: Shell, runtime connection, and data hydration share one state model

The current booleans/enums do not independently represent native visibility, HTML boot, React shell paint, runtime connection, initial data hydration, and degraded-but-usable operation.

### P1: Runtime work is still owned by React hooks

`useBrokerSessions` owns Broker startup coordination, initial fetch, SSE, fallback polling, revision reconciliation, and UI state. `main.tsx`, `startupStatus.ts`, `MainOverlayApp`, and Rust `complete_startup` each own another portion of startup semantics.

This conflicts with Runtime Architecture v2, where controllers own long-lived runtime policy and React hooks remain thin adapters.

### P1: Startup surfaces overlap

AMO currently has three successive loading surfaces:

- static `startup.html`;
- static `index.html` boot shell;
- the React-only `MainOverlayApp` boot branch.

The native startup surface is useful for WebView cold start, but it should hand off on `shellPainted`, not on session data. The React boot branch should become an in-shell runtime state rather than replacing the entire product UI.

### P1: Polling policy is distributed

Intervals are created independently by windows and hooks. There is no shared classification for protocol heartbeat, native fact sampling, UI compensation, data-sync fallback, or display clocks.

### P2: Source Stable always builds before a cold UI can exist

The normal Stable entry validates and builds frontend and Rust sources on every non-`RestartOnly` launch. This is transactionally safe but prevents immediate UI on a cold source launch even when validated artifacts already match the source tree.

### P2: Startup performance is not measured end to end

The smoke-ready command proves that React mounted, but AMO does not currently record native-visible, HTML-ready, shell-painted, Broker-ready, snapshot-ready, or interactive timestamps.

## Target Startup State Model

| State | Owner | Meaning | Main UI visible |
| --- | --- | --- | ---: |
| `native-visible` | Tauri shell | A themed native window is visible | Yes |
| `html-boot` | static HTML | Loading feedback exists without React | Yes |
| `shell-ready` | React shell adapter | Header, primary actions, and content frame committed | Yes |
| `runtime-connecting` | Startup/Session controller | Broker and event stream are connecting | Yes |
| `data-hydrating` | Session controller | Initial active-session snapshot is loading | Yes |
| `ready` | Session controller | Initial data is available | Yes |
| `degraded` | Startup/Session controller | Runtime failed or timed out; retry is available | Yes |

`shell-ready` and `data-hydrating` are independent. A timeout may transition runtime state to `degraded`, but it must never hide or close the shell.

## Target Ownership

### Tauri shell

Owns the earliest themed native surface, window lifecycle, startup-to-main handoff, native timestamps, and native capability execution. It does not own Broker or session readiness policy.

### Static HTML boot

Owns feedback before the React bundle is available and cached/default theme application. It performs no business or runtime probes.

### React App Shell

Owns the persistent frame, header, buttons, filters, skeletons, errors, retry gestures, cached UI configuration, controller subscriptions, and the `shellCommitted` signal. It does not own Broker startup, long-lived polling, SSE reconciliation, or native liveness policy.

### Startup Coordinator

Owns startup phase snapshots and timestamps, single-flight runtime bootstrap, shell/runtime/data phase separation, degraded/retry transitions, and orchestration of noncritical startup services.

### Session Runtime Controller

Owns the initial snapshot, EventSource lifecycle, revision gate, optimistic updates, reconcile scheduling, visibility-aware fallback refresh/backoff, and runtime snapshot publication.

### React session adapter

Owns only controller subscription, explicit commands, and translation into UI-facing data.

## Polling Inventory And Direction

| Current scheduler | Current cadence | Current gate | Classification | Direction |
| --- | ---: | --- | --- | --- |
| Session fallback refresh | 45 s | SSE unhealthy | data-sync fallback | Move to Session Runtime Controller; pause while hidden and use bounded backoff; refresh immediately on focus/online recovery |
| Managed window monitor | 2.5 s default | Broker ready and eligible targets | native fact sampling | Retain batching; start only with targets; add activity/visibility policy only if it does not break background attention detection |
| Utility-window visibility sync | 1.2 s | one utility marked active | UI compensation | Replace steady polling with lifecycle events plus focus reconciliation; keep a low-frequency safety audit only if native close paths require it |
| Harness status | 1.5 s | Harness window focused | external process sampling | Replace fixed cadence with immediate focus refresh plus adaptive visible-window backoff; owned process lifecycle should emit state where possible |
| Priority window sessions | 45 s | window mounted | data synchronization | Replace with Broker SSE invalidation and focus refresh; no hidden steady polling |
| Attention display clock | 1 s | component mounted | display clock | Schedule the next semantic deadline instead of re-rendering every second |
| Broker SSE heartbeat | 15 s | SSE clients exist | protocol keepalive | Retain; it is not data polling |
| Obsidian heartbeat | 15 s | plugin loaded | protocol/liveness heartbeat | Retain; document separately from UI polling |
| Transcript monitor | watched transcript exists | watched transcript exists | external file fact sampling | Keep under Broker ownership; evaluate filesystem watch/adaptive cadence separately from UI refactor |

Rules:

1. An event must replace polling when it has equivalent correctness.
2. External facts without reliable events may be polled, but only by one owner.
3. Hidden windows do not perform presentation-only polling.
4. Recovery polling uses bounded backoff and immediate event/focus refresh.
5. Protocol heartbeat is not counted as wasteful polling.
6. Every interval has an owner, start condition, stop condition, and test.

## Implementation Phases

### S0: Plan, measurement contract, and regression locks

Status: complete

- Establish this living document.
- Add tests for shell/data phase separation and startup completion semantics.
- Define timestamp names and performance budgets.
- Record the polling inventory and ownership decisions.

### S1: Shell visibility independent of session data

Status: in progress

- Add an explicit `shellCommitted` handoff and a separate first-visible-frame measurement.
- Complete native startup handoff after the shell commits, not after session hydration.
- Keep the Main Overlay frame mounted during runtime connection.
- Render Broker/session loading and degraded states inside the session content area.
- Ensure initial snapshot settle cannot strand the startup window.
- Keep Settings, Harness Lab, and other Broker-independent controls usable.

### S2: Startup Coordinator and Session Runtime boundary

Status: pending

- Remove duplicate Broker startup ownership from `main.tsx` and `useBrokerSessions`.
- Introduce a startup snapshot with independent shell/runtime/data states.
- Move Session lifecycle policy toward a controller usable without React.
- Preserve existing Broker protocol and optimistic event behavior.

### S3: Polling governance

Status: pending

- Replace Utility Window 1.2 s steady polling with event/focus reconciliation.
- Convert Harness status refresh to adaptive focused/visible scheduling.
- Replace Priority Window steady polling with SSE invalidation/focus refresh.
- Make Session fallback polling visibility-aware and back off while offline.
- Replace the Attention 1 s display clock with semantic deadline scheduling.
- Document retained native/protocol polling and why it remains necessary.

### S4: Startup instrumentation and Source Stable fast path

Status: pending

- Record `processSetup`, `startupVisible`, `mainHtmlReady`, `shellCommitted`, `firstVisibleFrame`, `brokerReady`, `snapshotReady`, and `interactive`.
- Surface diagnostics without blocking startup.
- Add validated build-input fingerprints for Stable.
- Reuse validated artifacts when inputs match; retain transactional rebuild when they differ.

### S5: Consolidation and release readiness

Status: pending

- Decide from measurements whether the separate Startup Window still earns its WebView cost.
- Finish the reusable Utility Window lifecycle coordinator.
- Update module architecture, runtime architecture, startup SOP, validation checklist, and release notes.
- Complete automated and native smoke validation.

## Performance Budgets

Initial development-machine targets:

| Measurement | Target |
| --- | ---: |
| Tauri process setup to first native surface, warm p95 | < 200 ms |
| Native surface to static HTML feedback, warm p95 | < 100 ms |
| Static HTML feedback to React shell, warm p95 | < 300 ms |
| Utility click to visible native window, warm p95 | < 150 ms |
| Slow operation progress feedback | < 300 ms |
| UI-thread synchronous task | < 50 ms |

Broker startup and session hydration are measured but are not shell-visibility gates.

## Validation Matrix

Automated:

- runtime policy unit tests;
- shell/data startup transition tests;
- EventSource reconcile and fallback scheduling tests;
- Utility Window lifecycle tests;
- Harness adaptive scheduler tests;
- `npm run test:runtime`;
- `npm run build`;
- `cargo test` and `cargo check`;
- Broker unit suite;
- `git diff --check`.

Native smoke:

- Portable cold start with Broker stopped;
- Portable warm start with Broker healthy;
- Broker port conflict;
- SSE connects while initial snapshot fails;
- Vite unavailable in Source Stable;
- rapid repeated Utility Window clicks;
- Harness hidden/focused/closed refresh behavior;
- multiple managed cards while dragging and clicking;
- sleep/resume and network/offline recovery.

## Decision Log

### 2026-08-14: Keep the Startup Window during S1

The first implementation keeps `startup.html` as a very short WebView cold-start bridge. It hands off after the React shell DOM commits. The first visible frame is measured afterward and is not a prerequisite because hidden WebViews may throttle `requestAnimationFrame`. Removing the second window is deferred until timing data shows whether the extra WebView costs more than the early native feedback it provides.

### 2026-08-14: Runtime failures degrade the shell

Broker/SSE/snapshot failure transitions to an in-shell recoverable state. It never prevents main-window visibility.

### 2026-08-14: Polling is classified, not blanket-removed

Protocol heartbeat and unavoidable external-fact sampling remain. UI compensation and data polling move to events, focus reconciliation, visibility gates, and backoff.

## Iteration Ledger

| Date | Phase | Change | Evidence | Remaining |
| --- | --- | --- | --- | --- |
| 2026-08-14 | S0 | Created active plan; recorded baseline, target state, ownership, polling inventory, budgets, and validation matrix | Source audit of Tauri setup, MainOverlayApp, useBrokerSessions, utility windows, Harness, Broker SSE, and Stable launcher | Implement S1 tests and shell handoff |
| 2026-08-14 | S1 | Main entry stopped owning Broker startup; shell-paint lifecycle now owns native handoff; session hydration is distinct from SSE/Broker readiness; full-screen React boot gate removed | TypeScript/Vite production build passed; startup regression suite added | Complete automated suite and native startup smoke |
