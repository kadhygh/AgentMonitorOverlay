# AMO Runtime Architecture v2

Updated: 2026-07-15

This document is the execution contract for separating AMO runtime coordination from React user experience code. It complements `docs/refactor-execution-guide.md`: the previous refactor established useful source folders, while this phase fixes cross-layer timing and ownership.

## Why This Phase Exists

The first refactor successfully separated Broker services, Overlay components/hooks, Tauri helpers, and Obsidian plugin modules. The remaining problem is not primarily file size. Background runtime work is still driven by React hooks:

- Broker session refresh, SSE reconciliation, and local session snapshots live in React.
- Managed-window liveness schedules native Windows probes from React.
- Native probe results are interpreted as launch state, written back to Broker, and immediately merged into React state.
- Pending-prompt focus and Codex action-required detection depend on callbacks that are wired through refs to avoid hook initialization cycles.

This coupling became visible when native window enumeration blocked for roughly 0.9-1.1 seconds per scan. Three connected managed cards caused repeated scans every 2.5 seconds, interrupting window drag and delaying button input. The immediate Win32 fix reduced a scan to roughly 0-2 ms, but the architecture must also prevent future platform work from sharing the UX lifecycle this directly.

## Runtime Surfaces

AMO keeps its existing four product surfaces:

- Broker: authoritative session, launch, workspace, note, canvas, and sync-back state.
- Overlay: rendering and direct user interaction.
- Tauri shell: Windows-native capabilities.
- Obsidian plugin: vault-native reading, annotation, note, and Canvas workflows.

Runtime Architecture v2 adds two internal Overlay boundaries:

```text
React windows/components
        |
        v
React adapter hooks
        |
        v
runtime controllers -----------> Broker client
        |
        v
platform ports ----------------> Tauri commands
                                      |
                                      v
                               Windows APIs
```

## Ownership Rules

### React Windows And Components

Own:

- visible state such as open panels, filters, search, and selected UI controls
- rendering and user gestures
- subscribing to runtime snapshots/events
- forwarding explicit user commands to controllers

Do not own:

- long-lived polling timers
- native window miss/recovery state machines
- Tauri command names or payload details
- Broker reconciliation policy
- platform performance assumptions

### React Adapter Hooks

Hooks connect controllers to React lifecycle. They may subscribe, update component state, and dispose subscriptions. They should stay thin and should not reimplement controller state machines.

### Runtime Controllers

Own:

- background timers and cancellation
- deduplication and in-flight guards
- managed-window miss/recovery/offline policy
- session-stream reconciliation policy
- runtime events that can be consumed by UI adapters

Controllers must be usable without rendering React components.

### Platform Ports

Own typed access to native capabilities:

- window enumeration/probe/activation/cursor selection
- clipboard
- notifications and tray
- native dialogs and URI/path opening

React hooks and components should not call raw Tauri window commands directly. A platform port may expose a browser-safe fallback when useful.

### Tauri

Own:

- Win32 enumeration and title/process inspection
- strict candidate matching
- HWND activation and cursor window selection
- batching native work so one runtime tick performs at most one system enumeration

Tauri does not own Broker session policy. It reports native facts; runtime controllers decide how those facts affect AMO state.

## Phase R0: Interaction Stall Fix

- Exclude AMO's own windows before reading external titles.
- Use non-blocking cross-process top-level caption lookup rather than synchronous `WM_GETTEXT` broadcasts.
- Remove duplicate native drag initiation from the main header.
- Keep strict `launchId`/title-token matching unchanged.

Acceptance:

- window enumeration p95 under 10 ms on the development machine
- continuous main-window drag is not interrupted by liveness ticks
- normal buttons remain responsive while multiple managed cards are connected

## Phase R1: Window Platform And Monitor

Create:

```text
overlay/src/platform/windowClient.ts
overlay/src/runtime/managedWindowMonitor.ts
```

Move:

- raw window-related Tauri invokes into `windowClient`
- probe interval, in-flight guard, launch revision reset, miss counter, and offline threshold into `ManagedWindowMonitor`

Add a batch Tauri command that accepts all managed-window requests, enumerates visible windows once, and resolves every request against that immutable snapshot.

Acceptance:

- one enumeration per liveness tick regardless of connected card count
- strict title-token identity remains unchanged
- React hook only adapts sessions to monitor targets and applies monitor events
- monitor start/stop/update behavior can be tested without React

## Phase R2: Session Runtime Controller

Create a session controller/store that owns:

- initial Broker snapshot
- SSE optimistic updates
- fallback polling
- reconcile scheduling and deduplication
- session ordering-independent runtime events

Remove callback-ref cycles between Broker sessions, pending prompt sync, and action-required probing. React should subscribe to a session snapshot and separately handle explicit runtime events.

Acceptance:

- one documented source of session snapshots in Overlay
- SSE does not force an unnecessary full refresh for every event
- fallback polling remains available when SSE is disconnected
- pending prompt and permission events remain low latency

## Phase R3: Broker Event And Binding Services

Extract from `broker/server.js`:

```text
broker/lib/session-events.js
broker/lib/session-binding-service.js
```

`session-events.js` owns SSE clients and publishing. `session-binding-service.js` owns window/target bind, unbind, and managed-offline mutations. HTTP routes own request/response shape; `server.js` owns bootstrap and dependency construction.

This phase must not change hook payloads or target-binding semantics.

## Phase R4: Test Foundation

Minimum automated coverage:

- strict HWND/PID/title-token resolver order
- multiple requests resolved from one native snapshot
- monitor miss, recovery, launch change, offline, and disposal behavior
- SSE update/reconcile deduplication
- target binding and managed launch transition rules

Manual smoke remains required for native focus transfer, drag, Obsidian, and CLI launch behavior.

## Performance And UX Budgets

- Native window snapshot p95: less than 10 ms on the development machine.
- Native snapshot count: at most one per monitor tick.
- No platform call may intentionally block the UI thread for 50 ms or more.
- Broker SSE update should appear on the relevant card without waiting for interval polling.
- Background monitor failures should degrade status accuracy, not pointer or button responsiveness.

## Explicit Non-Goals

- no Redux migration solely for architecture appearance
- no Electron/runtime rewrite
- no global hook deployment
- no automatic paste, submit, Enter, or permission approval
- no change to provider `sessionId` identity
- no Obsidian Canvas renderer takeover
- no broad Obsidian plugin split during R0-R2
- no arbitrary small-file extraction without a clear owner

## Commit And Validation Strategy

Use one commit per phase or coherent subphase:

1. interaction stall fix
2. window platform port and batch native probe
3. managed window monitor integration
4. session runtime controller
5. Broker event/binding services

Required checks for R0-R2:

```powershell
cd overlay
npm run build
cd src-tauri
cargo test
cargo check
cd ..\..
node --test broker/lib/*.test.js
git diff --check
```

Also restart AMO and smoke continuous drag, rapid button input, managed CLI jump, offline detection, and multiple connected cards.
