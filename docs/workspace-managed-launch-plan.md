# Workspace And Managed Launch Plan

Updated: 2026-07-11
Status: implementation in progress; Phase 0.5 and the first Phase 1/2 backend slice are complete
Branch: `codex/tray-workspace-routing`

## Purpose

This plan combines two related product improvements without making either one depend on unreliable Windows Terminal heuristics:

1. A Workspace Center that remembers explicitly deployed AMO projects and gives the user a stable place to inspect, maintain, and launch them.
2. Managed Launch identity that lets AMO prove which CLI instance produced a hook event, bind the resulting provider session, and resume the same session after its CLI window closes.

Workspace management and launch identity are separate responsibilities. Workspace records answer "which projects does AMO know?" A `launchId` answers "which AMO-controlled CLI process instance produced this event?" They should share one implementation plan, but provider `sessionId` remains the durable conversation identity.

## Product Rules

- Deployment alone does not create a task card.
- An explicit AMO CLI launch may create a temporary placeholder card so startup and binding progress are visible.
- The first matching hook event replaces that placeholder with a real provider-session card.
- A card represents provider session history; a terminal window is only its current runtime target.
- Closing a CLI never deletes, archives, or renames its session card.
- AMO-controlled launches may bind automatically only when a valid `launchId` proves ownership.
- Directly launched external CLIs stay unbound until the user binds them manually.
- Manual bindings are never transferred or cleared by launch/session mismatch automation.
- No global hook deployment, automatic paste, automatic submit, or automatic permission approval is introduced by this work.

## Current Problems

The current launch path already supports enrolled folders and can start Codex CLI, Claude CLI, or Codex App. It cannot reliably bind a new CLI session because:

- Windows Terminal windows, tabs, and panes may share one `WindowsTerminal.exe` process id.
- `wt.exe` returns a launcher process id, not a durable CLI/window identity.
- CWD, provider name, ordinary title text, and process id are candidate filters rather than proof.
- Hook protocol v2 provides provider `sessionId`, but not the AMO launch that created the process.
- Current Codex resume routing writes a title token directly onto an existing session before a hook proves the launched instance.
- There is no broker-owned index of deployed workspaces; `.amo/workspace.json` exists only inside each selected project.

## Identity Model

Keep four identities distinct:

| Identity | Owner | Lifetime | Purpose |
| --- | --- | --- | --- |
| `workspaceId` | AMO deployment | Until project enrollment is removed | Project/vault/adapter identity |
| `launchId` | Broker | One CLI process instance | Proves an AMO-controlled launch |
| `sessionId` | Codex or Claude | Provider conversation lifetime | Notes, canvas, annotations, history |
| `targetBinding` | Broker/user | One current routing lease | Opens or focuses a window/app target |

Never use a launch label, card title, PID, HWND, or workspace path as a replacement for provider `sessionId`.

## Persistent Data

### Workspace Registry

Add broker-local `broker/data/workspaces.json`:

```json
{
  "schemaVersion": 1,
  "workspaces": [
    {
      "workspaceId": "ws_xxx",
      "workspacePath": "G:\\PROJECT\\SomeProject",
      "projectName": "SomeProject",
      "vaultRoot": "G:\\PROJECT\\SomeProject\\.amo\\AMO - SomeProject",
      "adapterIds": ["codex-cli", "claude-cli"],
      "deploymentVersion": 3,
      "hookProtocolVersion": 3,
      "registeredAt": "2026-07-11T00:00:00.000Z",
      "lastInspectedAt": "2026-07-11T00:00:00.000Z",
      "status": "ready"
    }
  ]
}
```

The registry is an index, not enrollment authority. Project-local `.amo/workspace.json` and `.amo/enrollment.json` remain authoritative. Every launch or maintenance mutation must revalidate the selected path. Missing/moved folders become `unavailable`; AMO does not scan the machine or guess a replacement path.

Registry rules:

- Successful deploy/enroll adds or updates the record.
- Inspecting an enrolled folder may repair a missing index entry.
- Removing a Workspace Center entry forgets only the broker index; it does not uninstall hooks or delete `.amo/`.
- Existing test workspaces require no migration. Selecting/deploying them again registers them.
- Workspace records survive AMO and machine restarts.

### Managed Launch Store

Add broker-local `broker/data/launches.json` with short-lived active/recent intents:

```json
{
  "schemaVersion": 1,
  "launches": [
    {
      "launchId": "launch_xxx",
      "workspaceId": "ws_xxx",
      "workspacePath": "G:\\PROJECT\\SomeProject",
      "adapterId": "codex-cli",
      "mode": "new",
      "requestedSessionId": null,
      "sourceCardSessionId": null,
      "titleToken": "[AMO:codex:7f91c2]",
      "state": "waiting_hook",
      "createdAt": "2026-07-11T00:00:00.000Z",
      "expiresAt": "2026-07-11T00:02:00.000Z",
      "claimedSessionId": null
    }
  ]
}
```

Launch state:

```text
created -> spawning -> waiting_hook -> claimed -> connected
                    -> failed
                    -> expired
connected -> offline -> spawning (new launchId for resume)
```

Persist active launch intents so a Broker restart does not immediately lose ownership proof. Prune expired and old diagnostic records; do not let this become an unbounded history database.

## Hook Protocol V3

AMO-controlled CLI wrappers set environment variables before creating the provider process:

```text
AMO_LAUNCH_ID=launch_xxx
AMO_WORKSPACE_ID=ws_xxx
AMO_WORKSPACE_PATH=G:\PROJECT\SomeProject
AMO_REQUESTED_SESSION_ID=<optional resume session id>
```

Deployed Codex and Claude hook scripts copy them into every broker payload:

```json
{
  "hookProtocolVersion": 3,
  "launchId": "launch_xxx",
  "workspaceId": "ws_xxx",
  "sessionId": "provider-session-id",
  "turnId": "provider-turn-id",
  "tool": "codex",
  "cwd": "G:\\PROJECT\\SomeProject"
}
```

Rules:

- Missing `launchId` is valid and means an unmanaged/manual provider launch.
- A launch claim requires matching `launchId`, workspace, adapter/tool, TTL, and lifecycle state.
- CWD, PID, title, and project name may reject a mismatch or rank manual candidates, but cannot claim a launch.
- Claiming must happen before the event creates/updates the final card and before reply/prompt artifacts are routed.
- Hook protocol v2 remains accepted for ordinary unbound cards during rollout, but cannot claim managed launches.
- Deploy/Update moves adapter metadata to deployment version 3 and hook protocol version 3. Installed workspaces show `needs-update` until redeployed.

## Terminal Launch Contract

Extend `broker/lib/terminal-launch.js` to accept an environment map and a stable title token.

For managed CLI launches:

- Use a dedicated Windows Terminal window during the first implementation. Do not place multiple managed launches in one AMO-owned tab/pane group.
- Include the short `launchId` token in the terminal title.
- Use Windows Terminal application-title suppression so Codex/Claude cannot replace the AMO routing token.
- Treat returned `wt.exe`/PowerShell PID as diagnostic data only.
- Keep exact title token as a post-claim activation hint, not as launch ownership proof.

## Card Lifecycle

### New Launch

```text
Workspace/Card + action
  -> broker creates LaunchIntent
  -> overlay shows launch placeholder
  -> terminal starts with AMO environment
  -> first matching hook claims LaunchIntent
  -> placeholder is replaced in-place by provider session card
```

Placeholder constraints:

- Key it as `launch:<launchId>`, never as a fake provider session id.
- Show project, adapter, `Starting`/`Waiting for hook`, cancel/retry, and elapsed time.
- Do not expose Note, Canvas, annotation, archive, or provider-target actions before claim.
- Expire after a short timeout and show a recoverable failure state instead of silently disappearing.
- Preserve list position when replacing it with `session:<sessionId>`.

### Closed CLI And Resume

Before activation, validate HWND, owning process, process start time when available, and exact title token. If the runtime target is gone:

```text
Session state: Review / Idle / Waiting
Launch state: Offline
Card action: Resume CLI
```

Resume flow:

1. Keep the existing session card and all artifacts.
2. Create a new `launchId` in `resume` mode with `requestedSessionId` set.
3. Start in the recorded workspace path.
4. Codex: `codex resume <sessionId> -C <workspacePath>`.
5. Claude: set CWD, then `claude --resume <sessionId>`.
6. Move card to `Launching`, then `Waiting for hook`.
7. Bind the new window lease only after a matching hook claim.
8. Block duplicate resume clicks while an active intent exists.

If the provider returns a different `sessionId`, do not rewrite the old card. Mark the resume intent as mismatch, preserve the old card, and create a new session card only when lifecycle evidence proves a new conversation.

### New Session In One Managed CLI

If one managed CLI starts another provider session and hooks still carry the same `launchId`:

- Preserve the old session card/history.
- Remove only the target binding owned by the old `ownerLaunchId`/`ownerSessionId` pair.
- Create or revive the new provider-session card.
- Transfer the current launch/window lease to the new card after a valid session-start claim.
- Never clear manual or Codex App bindings because of this mismatch.

## Target Binding Ownership

Extend target bindings with explicit ownership:

```ts
interface TargetBinding {
  source: "managed-launch" | "manual" | "provider";
  ownerLaunchId?: string | null;
  ownerSessionId?: string | null;
  revision: number;
  hwnd?: number | null;
  processId?: number | null;
  processStartedAt?: string | null;
  titleToken?: string | null;
  boundAt?: string | null;
  verifiedAt?: string | null;
}
```

Resolver order:

```text
valid manual HWND
  > valid managed launch lease + exact title token
  > explicit provider target (Codex App/thread)
  > unique user-confirmed candidate
  > no binding
```

Shared Terminal PID, CWD, generic title, and first-candidate selection are never final automatic proof.

## Manual CLI Adoption

An already-running process cannot safely receive new environment variables. Support two explicit paths:

1. Soft bind: drag/select the current window. This works for the current session and stays `source: manual`.
2. Resume under AMO: after the user closes the existing CLI, launch the same session through AMO with a new `launchId`.

Do not kill the external CLI automatically. Do not transfer a soft manual binding when that CLI creates a new provider session; ask the user to bind again or resume under AMO.

A future optional `amo codex` / `amo claude` wrapper may request a `launchId` from the Broker before starting a CLI in the current shell directory. It is useful but is not required for the first Workspace Center implementation.

## Workspace Center UI

Evolve the current standalone Deploy window into a Workspace Center instead of adding another top-level overlay button.

Recommended layout:

```text
+----------------------+-------------------------------------------+
| Workspaces           | project_mining                            |
| Search               | G:\PROJECT\project_mining                |
|                      | Status: Ready                             |
| * project_mining     |                                           |
|   project_mining_dev | Launch                                    |
|   AMODeptest         | [Codex CLI] [Claude CLI] [Codex App]      |
|                      |                                           |
| [+ Add workspace]    | Adapters / Vault / Plugin / Git exclude   |
|                      | [Inspect] [Update] [Open] [Clean]          |
+----------------------+-------------------------------------------+
```

Behavior:

- The existing top folder/deploy icon opens Workspace Center.
- Left side lists only explicitly enrolled/registered workspaces.
- Add Workspace reuses the existing path input and Explorer folder picker.
- Selecting a workspace automatically inspects it, but expensive maintenance details may load lazily.
- Right side reuses existing Deploy, launch, Git exclude, plugin update, folder open, and clean components.
- Missing folders remain visible with an unavailable state and `Forget`/`Locate` actions.
- Healthy workspaces do not animate. Warning/error status is visible but restrained.
- Card `+` remains a project-scoped quick launch path using the same managed launch service.
- An offline card exposes Resume in its action row or activation fallback panel.

Deploy success still creates no card. Only explicit Launch creates a placeholder.

## Broker API Direction

Keep current APIs compatible while adding registry and launch identity:

```text
GET  /api/workspaces
POST /api/workspaces/inspect
POST /api/workspaces/enroll
POST /api/workspaces/forget
POST /api/workspaces/launch
GET  /api/launches
POST /api/launches/:launchId/cancel
POST /api/sessions/:sessionId/resume
```

`POST /api/workspaces/launch` gains:

```json
{
  "workspaceId": "ws_xxx",
  "workspacePath": "G:\\PROJECT\\SomeProject",
  "adapterId": "codex-cli",
  "mode": "new",
  "sessionId": null,
  "sourceCardSessionId": null
}
```

Response gains `launch`, not a guessed bound session:

```json
{
  "ok": true,
  "launch": {
    "launchId": "launch_xxx",
    "state": "waiting_hook",
    "titleToken": "[AMO:codex:7f91c2]",
    "expiresAt": "2026-07-11T00:02:00.000Z"
  },
  "session": null
}
```

The Broker event stream publishes `launches.changed` as well as the existing `sessions.changed`. The overlay reconciles both snapshots so placeholder replacement is deterministic rather than timing-dependent.

## Implementation Sequence

Implement on one feature branch, but keep reviewable commits and validate after each phase.

### Phase 0.5: Codex Permission Provisional Gate

Codex Auto-review may emit `PermissionRequest` before the reviewer decides that no human action is needed. The initial hook payload does not contain the final Auto-review decision, so AMO must not immediately turn every Codex permission hook into user attention.

- Hold Codex `PermissionRequest` events in a broker-local provisional gate for 6 seconds.
- Return success to the hook immediately; do not publish `waiting_permission`, tray attention, or a Windows notification yet.
- Cancel the provisional request when the same session emits subsequent activity such as `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, or `Stop`.
- Promote the held event to the normal session pipeline only when no resolving activity arrives before the timeout.
- Keep Claude permission behavior immediate until its lifecycle evidence proves the same delay is useful.
- Keep provisional requests in memory only. A Broker restart may discard them because they are transient UI suppression state, not conversation history.
- Record `permission.provisional_started`, `permission.auto_resolved`, and `permission.promoted_to_attention` in debug logs.
- After Broker promotion, delay the Windows native permission notification for another 10 seconds. Cancel it if the same attention key resolves or changes first; review and failure notifications remain immediate.

Acceptance:

- Auto-reviewed Codex permission requests never flash an attention card or native notification.
- A real Codex permission prompt becomes visible after the short grace period.
- Claude permission requests remain immediate.
- Normal prompt/reply artifacts are unaffected.

### Phase 1: Workspace Registry And Center

- Add broker workspace registry store and list/forget APIs.
- Register on deploy/enroll and repair on inspect.
- Evolve Deploy window into the Workspace Center shell.
- Reuse current inspect/deploy/launch/maintenance behavior.
- Do not change hook or binding semantics yet.

Acceptance:

- Registered workspaces survive Broker/machine restart.
- Missing workspace is reported without crashing or silently removing it.
- Deploy still creates no card.
- Existing deploy, update, Git exclude, plugin update, clean, and launch smoke remain valid.

### Phase 2: Managed Launch Identity

- Add `LaunchIntent` store and launch event stream.
- Generate random launch IDs and stable title tokens.
- Inject AMO environment into Codex/Claude launch wrappers.
- Add hook protocol v3 fields and deployment version bump.
- Add atomic hook-to-launch claim before session upsert/artifact routing.

Acceptance:

- Two same-tool launches in one workspace claim the correct sessions without FIFO/path guessing.
- Direct manual CLI hooks create unbound cards.
- Hook v2 remains accepted but cannot claim a launch.

### Phase 3: Placeholder And Card Resume

- Project active LaunchIntents as placeholder cards.
- Replace placeholder in-place after claim.
- Add launch state to real cards.
- Validate target liveness on activation.
- Add Resume CLI for offline Codex/Claude cards.

Acceptance:

- New managed launch gives immediate visible feedback.
- Closing a CLI keeps the card and marks its target offline.
- Resume reopens the same session with a new launch ID.
- Repeated clicks do not spawn duplicate resumes.

### Phase 4: Ownership Transfer And Manual Adoption

- Add binding source/owner/revision fields.
- Handle same-launch new-session transfer.
- Preserve manual/provider bindings on mismatches.
- Add `Resume under AMO` after a soft manual binding.
- Add diagnostics to Card Settings and Workspace Center.

Acceptance:

- `/new` or equivalent creates a new card without mutating old history.
- Only managed-launch bindings transfer automatically.
- Manual drag binding remains stable and explicit.

### Phase 5: Hardening

- Expiry, cancellation, Broker restart recovery, stale HWND/PID validation.
- Event sequence/revision protection for launch/session snapshots.
- Codex and Claude multi-window smoke.
- Documentation and deployment maintenance update.

## Verification Matrix

| Scenario | Expected result |
| --- | --- |
| Deploy workspace only | Workspace appears; no card |
| Launch Codex from Workspace Center | Placeholder appears, then claims Codex session card |
| Launch Claude from Card `+` | Independent placeholder/session card, correct window |
| Launch two Codex CLIs in same folder | Each hook claims its own launch ID |
| Close managed CLI | Card remains, runtime target becomes offline |
| Resume offline Codex card | `codex resume <sessionId>` opens and reclaims card |
| Resume offline Claude card | `claude --resume <sessionId>` opens and reclaims card |
| Start direct manual CLI | Hook card appears unbound |
| Drag manual window to card | Current session routes correctly; binding stays manual |
| New session in managed CLI | Old card preserved; new card receives launch lease |
| New session in manual CLI | New card stays unbound |
| Broker restarts while CLI is open | Active launch intent reloads or expires explicitly; no guessed binding |
| Workspace folder removed | Registry shows unavailable; no destructive cleanup |

## Non-Goals

- Enumerating or controlling individual Windows Terminal panes.
- Automatically scanning drives for projects.
- Injecting environment variables into already-running external processes.
- Automatically terminating external CLIs.
- Replacing provider session identity with AMO card or workspace identity.
- Global hook installation.
- Full deployment history, disable, or uninstall flows.
- Automatic prompt paste, submit, or permission handling.

## Recommended First Implementation Slice

Start with Phase 1 as a separate commit, then implement Phase 2 before adding placeholder/resume UI. The Workspace Center should call one shared managed-launch service from both its Launch buttons and Card `+`; do not create a second launch path in the frontend.

The most important architectural checkpoint is the first Hook v3 claim smoke. Until `launchId -> provider sessionId` is proven with two same-tool CLIs in one workspace, do not add automatic binding transfer or hide manual fallback controls.

## 2026-07-11 Implementation Checkpoint

Completed in the first implementation slice:

- Codex provisional permission gate with a 6-second production grace period.
- Persistent `workspaces.json` registry with list, register-on-inspect/deploy, availability status, and non-destructive forget.
- Workspace Center shell in the existing Deploy utility window.
- Persistent `launches.json` intents with random `launchId`, TTL, state, and atomic provider-session claim.
- Hook/deployment protocol v3 environment fields for Codex CLI and Claude CLI.
- Windows Terminal launch environment injection and persistent exact title tokens via `--suppressApplicationTitle`.
- Managed card routing hints that do not pretend the `wt.exe` launcher PID is the CLI/window identity.
- Managed lease preservation across prompt, reply, review, Note, and Canvas state updates.
- Same-launch session lease transfer with monotonic `bindingRevision`, including A -> B -> A return.
- Card `Offline` state and explicit `Resume CLI`, which creates a new resume-mode `launchId` and blocks duplicate resume requests while waiting for a hook.

Still pending after this checkpoint:

- Projecting unclaimed LaunchIntents as placeholder cards.
- Runtime window liveness probing when a CLI is closed without another session hook.
- Full explicit binding ownership metadata for manual/provider targets and multi-runtime conflict handling.
- Two simultaneous real Codex launches and two simultaneous real Claude launches as manual acceptance smoke.
