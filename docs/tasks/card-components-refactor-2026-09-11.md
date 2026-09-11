# Card component refactor — implementation contract

Continuation: the later approved manual-groups iteration adds `amo.task-group` and a same-writer group registry, replaces fixed Focus triage tabs, and reuses TaskCard in a detail dialog. See [current continuation](../session-handoffs/2026-09-11-focus-manual-groups.md). The acceptance and test counts below describe the earlier `90808f8` baseline; they do not claim validation of the new native window behavior.

Status: minimum shared Card framework implemented, Focus Panel integrated, and automated acceptance passed. Latest user authorization: no old Focus/card data migration required; retain inexpensive existing runtime integration only. No live data deleted. New storage is `cards.json` (`AGENT_MONITOR_CARDS_DATA_FILE`); old `focus-cards.json` is not read, migrated, or removed.

## Ownership and scope

Session is the smallest execution unit. Card is an independent work object. Functionality is composed through typed components and interface commands. Session metadata/execution and conversation GUI/TUI/target lifecycle are separate components/projections. Focus Panel is the first consumer. Preserve underlying CLI workflow; no controller review or orchestration.

## Card core

`Card = {schemaVersion:1,cardId:string,title:string,revision:number,createdAt:string,updatedAt:string,archivedAt:string|null,components:Component[]}`.

cardId is a random opaque UUID-based ID, independent from Session. Store a default-session-card index to avoid duplicate auto-import; identity is not inferred from title/path. Non-session cards are fully valid. Components are `{componentId:string,type:string,schemaVersion:number,data:object}`; IDs unique per card, max32 components, bounded namespace/version/payload. Unknown components retained but cannot execute code. Core field changes go through validated commands; components may call such interfaces, including cross-component batches.

Built-in components:

- `amo.session`: data `{sessionRef:{frameworkId:string,sessionId:string}}`. Session identity, project, execution/presence are read from runtime projection; never store a second mutable runtime snapshot here.
- `amo.conversation`: data `{sessionComponentId:string}`. References a session component; projects CLI/App/window binding and conversation availability separately. Removal does not stop/unbind actual Session. Dependency validation occurs against final batch state.
- `amo.processing`: data `{sourceComponentId:string|null,state:'pending'|'reviewing'|'later'|'future'|'handled',handledGeneration:number,attention:{generation:number,kind:'reply'|'permission'|'input'|'failure'|null,updatedAt:string|null,hasUnseen:boolean}}`. Human state and durable source attention bookkeeping; only one processing component in current Focus projection. No source is valid for manually planned cards.
- `amo.notes`: data `{text:string}` up to2000 chars; one notes component in current Focus projection.

Session/conversation component types support distinct component IDs; multiple Session references are valid, but current processing component selects exactly one source. Switching/removing a processing source must clear its old attention cursor explicitly as part of component mutation; no stale acknowledgement applies to another source. References to missing runtime sessions remain valid.

## API

- GET `/api/cards` -> `{schemaVersion:1,cards:Card[]}` (include archived for explicit caller filtering).
- GET `/api/cards/:id` -> `{card}`.
- POST `/api/cards` body `{operationId,title,components?:Component[]}` -> `{card}`. Independent no-session creation. Built-in processing submitted through generic APIs may specify only `sourceComponentId,state`; server initializes managed attention/cursor. Unknown components may carry their bounded payload. Response is fully materialized normalized components.
- POST `/api/cards/:id/commands` body `{operationId,expectedRevision,commands:Command[]}` -> `{card}`; 1..20 commands, atomic final validation. Commands: `{type:'set-title',title}`, `{type:'archive'|'restore'}`, `{type:'set-component',component}`, `{type:'remove-component',componentId}`, `{type:'set-processing',componentId,state}`, `{type:'handle',componentId,throughGeneration}`, `{type:'set-note',componentId,text}`. Reject stale revisions, invalid dependency graphs, protected field injection, duplicate IDs/operations. Durable exact-request replay, no auto-overwrite.
- GET `/api/focus-panel` -> `{schemaVersion:2,cards:FocusCardView[]}`. Only nonarchived cards containing processing component. This is a view, never another store.
- Existing Focus POST `/api/focus-panel/cards/:id` remains a thin interface (`set-triage`, note-only, handle) translating to generic commands and returning `{card:FocusCardView}`. Reuse identical operation IDs across uncertainty. Core uses one replay ledger and writer; facade does not create another truth.

FocusCardView retains `{schemaVersion:2,cardId,revision,title,createdAt,updatedAt,triage:{state,note,handledGeneration},attention}`; removes old flat sessionRef/lifecycle/capabilities/extensions and adds:

- `session: null | {componentId,sessionRef:{frameworkId,sessionId},presence:'live'|'archived'|'detached',execution:string,workspaceId:string|null,workspacePath:string}`.
- `conversation: null | {componentId,sessionComponentId,surface:'cli'|'app'|'unbound',bindingKind:string,availability:'online'|'offline'|'unknown',capabilities:{activate:boolean,resume:boolean}}`.

Focus UI consumes these two groups separately. A card without Session can be noted/triaged/handled; no native controls. A session card without conversation component can still show execution/review data; no native conversation controls. The conversation shown corresponds to the processing source; never silently open another related Session.

## Runtime projection adapter contract

New module `broker/lib/card-components/session-runtime.js` (separate owner) exports:

- `projectSessionRuntime(session, sessionRef, componentId)` -> session shape above. For missing session pass null; always preserve exact sessionRef and componentId.
- `projectConversationRuntime(session, sessionRef, componentId, sessionComponentId)` -> conversation shape above. Missing or archived session has commands disabled; GUI App binding and CLI managed/explicit window routes distinguished; avoid inferring offline from idle. For unknown tools all native commands disabled.

These pure projections do not mutate existing runtime session data. Backend card store continues using existing provider attention normalization (`session-frameworks/common.js`) and canonical framework aliases. Mismatched framework/session raw identity counts as missing, not a binding to another runtime.

## Storage and lifecycle

Generic CardStore owns cards, default source-card index, attention evidence, replay ledger. Reuse queue/durability/dedup/backoff behavior from Focus prototype, but no legacy Focus snapshot reader. Explicit bad new-format storage is reported without reset. Broker continuously observes session collection; runtime transitions update source attention but should not churn card revision merely on unchanged tool hooks. Card archive is separate from session archive. Delete a view/component never deletes a live runtime. All APIs use the same writer and interfaces.

Storage override: `AGENT_MONITOR_CARDS_DATA_FILE`; default `cards.json` beside sessions. Source replacement is an explicit processing `set-component` mutation that resets server-owned evidence and immediately observes its new runtime source. Changing the selected Session component's reference requires this processing mutation in the same batch. A source-changing batch cannot also Handle; the caller must first observe the new source. Existing processing cannot be set to handled through generic component/state edits; use Handle. Creation can initialize handled at generation zero, but current source attention is then observed normally.

## Parallel ownership

- Backend agent: new CardStore, component registry/schema, card routes, Focus facade, server wiring, remove obsolete Focus store/tests or replace them with generic tests. Own backend except session-runtime module/test below.
- Session grouping agent: session-runtime pure projections + `broker/lib/card-session-runtime.test.js`, no shared registry/store edits.
- UI agent: Focus types/hooks/UI/client/tests update to view2, creation of no-session planned card via generic API, raw card client helper as needed. No main/window/core native router changes.
- Primary: review/inter-module alignment, native routing as needed, browser harness, docs, full tests/build verification.

## Acceptance

Create no-session card; core IDs independent; attach/remove components via API; rename/archive/restore via interfaces; batch cross-component changes validate final state; malformed edit is atomic; session and GUI/TUI projections independent; source changes cannot acknowledge old cursor; GUI/App cannot resume CLI by accident; runtime unavailable does not delete Card; unknown components survive ordinary note/triage saves; Focus uses CardStore only; all prior human-loop behavior still passes. No expensive old-data migration, no deletions of real files.

## Final verification

- Full Broker tests: **208 passed / 0 failed** after removing obsolete provider-to-Focus projections. The generic Card/runtime/HTTP subset covers independent identities, no-session creation, component commands, protected managed fields, source replacement, unknown components, archive/delete separation, failure/restart/replay, and corruption.
- Frontend runtime suite: **103 passed / 0 failed**. Focus-specific/native routing tests additionally rechecked after final cleanup: **21 passed**.
- Production build: `npm run build` passed, including catalog freshness precheck.
- Native compile: `cargo check --offline` passed against the current frontend assets.
- Final isolated real-UI/real-Broker smoke: `tmp/focus-smoke-DDM94p`, zero page errors. Actual toggle and command hooks used through simulated native ports. Tests include true Broker restart, duplicates, deferred/manual status, response-loss retry, note conflict, independent New card, generic core/unknown-component edits, atomic attachment, invalid dependency rollback, conversation-only removal, Card archive/restore, and untouched obsolete Focus file.
- Dark 440px and light 360px snapshots visually inspected. Expanded cards scroll within the panel; window controls and queue groups remain available.
- Real Windows stacking/focus and live CLI/App resume are not exercised by these simulated-port tests. Validation did not deploy or restart the active application. Source submission/mainline handoff is recorded in `docs/session-handoffs/2026-09-11-focus-panel-card-framework.md`.

## Review and implementation notes

The user's first annotation is implemented through interfaces: core title/archive plus component data can be changed via validated commands, including atomic cross-component batches. The second is implemented as separate session and conversation components and runtime projections.

Default Session-card mapping is an import convenience, not Card identity. Card titles stay independently editable. Runtime projections do not create another mutable persisted execution snapshot. Old Focus store and provider-derived Card identity/projectors were removed; only useful runtime alias/attention helpers remain.

Native requests now include cardId, sessionComponentId, and conversationComponentId as well as the exact runtime identity. Main reloads current Card and Session, rejects archived/removed/retargeted components, and refuses CLI Resume if the fresh target is App/GUI. No human-processing acknowledgement occurs in the conversation command path.

## Assessment

| Workstream | Model | Grade | Evidence |
|---|---|---|---|
| CardStore, registry, interfaces and persistence | GPT-6 Astra / medium | A | Generic store/HTTP tests plus full Broker regression and actual restart/API smoke |
| Session versus conversation lifecycle projection | GPT-6 Astra / medium | A | 12 runtime projection cases and existing target/launch tests |
| Focus view2 and independent-card UI | GPT-6 Astra / medium | A | 13 targeted state/API cases plus actual UI workflow and visual inspection |
| Native integration and overall validation | Primary | B | Command port tests and native compile passed; actual Windows focus/stacking remains to be checked |

Current limits: one processing source and one notes component per Card; multiple Session components may exist but multi-source joint acknowledgement/aggregation is future work. Existing Canvas UI has not been migrated to CardStore in this iteration. Component registration is explicit built-in code, not arbitrary dynamic plugins. Persistence serializes within one Broker process, not across multiple writers.
