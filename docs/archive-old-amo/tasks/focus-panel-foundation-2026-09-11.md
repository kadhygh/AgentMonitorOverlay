# Focus Panel foundation — 2026-09-11

Historical first prototype record. The current implementation supersedes its dedicated Focus store and flat view with the shared Card/component system: see `docs/tasks/card-components-refactor-2026-09-11.md`. Prototype test counts and contracts below describe the earlier step, not the final data layout.

Status: implementation integrated and automated acceptance passed on `codex/focus-panel`, based on `717c985`. Not deployed to the running application. Actual Windows window/focus smoke remains a verification gap.

User clarification received after the first implementation: “different frameworks” means Card-based feature frameworks (existing TaskCard, Focus Panel, Canvas cards and future composite cards), not CLI providers. The implementation below records the tested single-session Focus workflow prototype. The clarified minimum Card/component architecture is now implemented; its current specification is `docs/card-framework-design-2026-09-11.md` and its execution record is the component refactor document linked above.

## Product contract

Add a visible on/off toggle beside Open Canvas. Focus Panel is a separate, nonmodal floating desktop window containing the human processing queue. All new workflow UI belongs here. Keep CLI conversation and full human review; no controller review, automatic dispatch, inline chat, or mandatory summaries.

Human triage is independent from session execution and old notification/review flags. Opening CLI never acknowledges a Focus item. Explicit handling acknowledges a particular attention generation. New replies do not override later/future/reviewing choices. Sessions can archive/disappear without deleting the durable card. Initial mapping is one stable card per canonical framework/session identity; no automatic fork merging.

## Shared implementation contract

- Native label `focus`; component `overlay/src/windows/FocusPanelApp.tsx`, named export `FocusPanelApp`.
- Window API `closeUtilityWindow('focus')`, `useUtilityWindowLifecycle('focus')`; native/user close hides, emits `amo-focus-visibility` boolean to focus and `amo-focus-window-state` boolean to main. Toggle accurately reflects visibility, survives repeated clicks without duplicate windows. No automatic restore on application startup in this version.
- Focus uses an ordinary compact always-on-top floating window; never `activeUtilityWindow`. Preserve existing modal utilities. Window hidden pauses frontend polling; Broker continues recording changes.
- GET `/api/focus-panel` -> `{schemaVersion:1,cards:FocusCard[]}`.
- POST `/api/focus-panel/cards/:cardId` body `{operationId,expectedRevision,action:'set-triage'|'handle',state?,note?,throughGeneration?}` -> `{card}`. `set-triage` accepts state (`pending|reviewing|later|future`), note (max 2000), or both; note-only changes preserve state including handled. `handle` requires observed `throughGeneration`. Conflict HTTP409; failed write must preserve prior durable state. Reuse exact operation ID for uncertain retries. No endpoint edits arbitrary provider extension data.
- FocusCard: `{schemaVersion:1,cardId,revision,sessionRef:{frameworkId,sessionId},title,workspaceId:string|null,workspacePath:string,createdAt,updatedAt,triage:{state:'pending'|'reviewing'|'later'|'future'|'handled',note:string,handledGeneration:number},attention:{generation:number,kind:'reply'|'permission'|'input'|'failure'|null,updatedAt:string|null,hasUnseen:boolean},lifecycle:{presence:'live'|'archived'|'detached',execution:string,availability:'online'|'offline'|'unknown'},capabilities:{activate:boolean,resume:boolean},extensions:Record<string,{schemaVersion:1,data:Record<string,unknown>}>}`.
- Canonical built-in framework IDs codex/claude/grok/unknown. Alias mapping and provider observation/capabilities in separate components under `broker/lib/session-frameworks/`; common record shape stays owned by core. Unknown providers remain readable and conservative. Existing AgentSession fields/routes stay compatible. New projected extensions use schemaVersion 1; persisted opaque envelopes allow positive integer schemaVersion values and are preserved when their component/version is unavailable. Frontend treats extension schemaVersion as number.
- Persist `focus-cards.json` beside sessions, override `AGENT_MONITOR_FOCUS_DATA_FILE`. Add a narrow session collection observer to capture transitions even when the panel is closed and old review flags subsequently clear. Capture set/delete/clear, seed existing sessions once, preserve identity and triage on restart. Ignore unchanged tool hooks; serialize/coalesce writes. Storage failures visible and retryable; corrupt snapshots must not be replaced silently.
- Observe new reply identity and blocking transitions without re-notifying repeated events or metadata changes. Keep bounded replay/dedup evidence; late handled generations cannot consume newer attention. Runtime running/idle never implies human completion. Archived/live/detached is distinct from offline execution availability.
- Frontend controls: Pending, In progress, Later, Future, Handled/All; task/workspace search; lifecycle and framework badges; note; open CLI; resume when supported; explicit Handle this update. At least later/future/reviewing choices persist on fresh reply while New update badge changes. Do not falsely label permission resolved because item was handled.
- Native command delegation: Focus emits to main `amo-focus-session-command` payload `{requestId,action:'activate'|'resume',sessionId,frameworkId}`. Main resolves current authoritative session and uses existing activateSession/resumeSession. Primary agent owns this wiring. Main returns to focus `amo-focus-session-command-result` `{requestId,ok,message}`; acceptance is delegation, not confirmed native focus. Missing/stale references must not act on a different session.
- UI reads through its own focused API client and emits explicit commands only; no second native-monitor/notification/clipboard owner. New updates are visible through panel counts/badges, using existing AMO notifications rather than duplicating native notifications.

## Work allocation and assessment

Previous user authorization for parallel implementation is retained: implementation agents GPT-6 Astra / medium. Backend/card lifecycle and componentized framework projection is high complexity/high risk; panel UI is medium-high complexity/medium risk. Primary handles window/toggle, native-command integration, review and isolated verification. Grades use evidence: A acceptance verified, B documented verification gap, C incomplete acceptance.

## Acceptance

Restart stable IDs/triage; explicit handle vs focus; duplicate/late replies; new reply during action; deferred choice preservation; archive/delete/reactivation; multiple frameworks and unknown extension fallback; invalid extension cannot override base data; failed/corrupt persistence; actual toggle/close synchronization; panel-to-existing-CLI command routing; no hidden UI polling/duplicate native effects; isolated browser workflow and build/runtime regressions. No real sessions are mutated for tests.

## Delivered and verification

- Added the accessible Focus Panel switch next to Open Canvas, a lazy nonmodal floating window, close/show event synchronization and native early-close protection.
- Stable Focus card identity uses canonical framework + exact session identity. A dedicated schema/store separates human triage and handled generations from legacy session state. Ordinary hooks do not acknowledge Focus work.
- Framework components cover Codex/Claude/Grok aliases and unknown providers. Whitelisted projection fields keep provider-specific data nested; opaque namespaces and independent extension versions survive hook updates and restart. This is a projection/command boundary, not a replacement for every existing provider Hook or launcher.
- UI groups, workspace/task search, notes, explicit handling, deferred-state preservation, conflict recovery, immutable retries and CLI command delegation implemented. Native command acceptance is explicitly distinguished from successful focus/resume.
- Broker full suite: **199 passed, 0 failed**. Frontend runtime full suite: **96 passed, 0 failed**. Final storage guard additionally checked with the focused store suite.
- `npm run build`: passed, including generated model-catalog freshness check. `cargo check --offline`: passed.
- `scripts/performance/focus-panel-smoke.cjs`: passed; final full run `tmp/focus-smoke-ACxE1c`. Real Focus UI + Broker, actual toggle/command hooks, simulated native ports, temporary Unity fixture. Tests real Broker restart, deferred replies, duplicate reply, explicit handling, legacy reviewed independence, response-loss replay, note conflict, hidden polling, detached references. Zero page errors.
- Dark 440px and light 360px layouts visually inspected. Test screenshots are under that run directory.

## Assessment

| Subtask | Model/effort | Complexity / risk | Grade | Evidence |
|---|---|---|---|---|
| Card lifecycle + framework components | GPT-6 Astra / medium | High / high | A | State/route/framework/collection tests plus actual Broker restart and browser flow |
| Focus Panel UI | GPT-6 Astra / medium | Medium-high / medium | A | State/API tests, browser interactions, error/draft recovery and visual inspection |
| Window/CLI integration and final review | Primary | High / high | B | Native port tests, real toggle hook and command routing, Rust compile; no real desktop focus/stacking test |

Main-project uncommitted documentation/Cargo changes were preserved by building an isolated worktree from its latest commit. Review fixes included migration of old reviewed records, actual managed availability states, alias consistency across native and Broker layers, archived action restrictions, note-only edits, preserving absent extensions, storage retry/backoff, initial-hidden window race and repeated native-request protection.

## Practical limits

One Focus card per canonical framework/session; no automatic fork merging, session orchestration, controller pre-review or automatic launch. Runtime execution remains the existing Broker's authority. Timestamp-only unknown-provider replies have weaker identity evidence than stable turn/artifact IDs. Storage writes serialize within one Broker process, with no cross-process lock; source observations are coalesced, not a full durable event log. Corrupt storage is retained and reported. New native activation capabilities need an explicit platform adapter and alias-contract coverage.

Focus visibility is a window toggle and starts off on application startup; cards keep recording in the Broker. Hiding preserves in-memory note drafts, while only saved notes survive full app restart. Native confirmation/chooser outcomes remain visible in the main overlay. Existing AMO notifications are reused; Focus adds no second native notification/monitor loop.
