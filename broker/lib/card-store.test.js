const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCardStore } = require("./card-store");
const { SessionCollection } = require("./session-collection");
const { writeSnapshot } = require("./task-canvas-store");

const at = (second) => `2026-09-11T00:00:${String(second).padStart(2, "0")}.000Z`;
const session = (overrides = {}) => ({ sessionId: "one", tool: "codex", title: "Session title", state: "running", workspaceId: "workspace", workspacePath: "C:/isolated", updatedAt: at(1), ...overrides });
const reply = (second, turn = `turn-${second}`) => ({ state: "idle", lastReplyAt: at(second), lastReplyNote: `reply-${second}.md`, reviewTurnId: turn, reviewRequired: true, updatedAt: at(second) });
const component = (type, componentId, data, schemaVersion = 1) => ({ componentId, type, schemaVersion, data });
const source = (id = "session", sessionId = "one", frameworkId = "codex") => component("amo.session", id, { sessionRef: { frameworkId, sessionId } });
const processComponent = (sourceComponentId = null, state = "pending", id = "processing") => component("amo.processing", id, { sourceComponentId, state });
const note = (text = "", id = "notes") => component("amo.notes", id, { text });
const processing = (card) => card.components.find((c) => c.type === "amo.processing" && c.schemaVersion === 1);
const batch = (card, commands, operationId = `op-${card.cardId}-${card.revision}`) => ({ operationId, expectedRevision: card.revision, commands });
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "amo-card-store-"));
  const dataFile = path.join(directory, "cards.json");
  const store = createCardStore({ dataFile, coalesceMs: 60000, ...options });
  const sessions = new SessionCollection();
  store.attach(sessions);
  t.after(async () => { await store.dispose().catch(() => {}); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, sessions, dataFile, directory };
}
async function imported(store) { return (await store.list()).cards[0]; }
async function planned(store, operationId = "planned") { return store.create({ operationId, title: "Plan", components: [processComponent(), note()] }); }

test("independent Cards have opaque UUID identities, support no Session and survive restart", async (t) => {
  const { store, dataFile } = fixture(t);
  const bare = await store.create({ operationId: "bare", title: "No components" });
  const first = await planned(store);
  const second = await planned(store, "planned-two");
  assert.match(first.cardId, /^card-[0-9a-f-]{36}$/u);
  assert.notEqual(first.cardId, second.cardId);
  assert.deepEqual(bare.components, []);
  assert.equal(processing(first).data.attention.generation, 0);
  const focus = store.focusView(first);
  assert.equal(focus.schemaVersion, 2);
  assert.equal(focus.session, null);
  assert.equal(focus.conversation, null);
  const restarted = createCardStore({ dataFile });
  t.after(() => restarted.dispose());
  assert.deepEqual(await restarted.get(first.cardId), first);
  assert.deepEqual(await restarted.create({ operationId: "planned", title: "Plan", components: [processComponent(), note()] }), first);
});

test("default Session index persists independently from Card identity and title", async (t) => {
  const { store, sessions, dataFile } = fixture(t);
  sessions.set("one", session(reply(2)));
  const first = await imported(store);
  const changed = await store.execute(first.cardId, batch(first, [{ type: "set-title", title: "Human title" }]));
  sessions.set("one", session({ ...reply(2), title: "Provider title changed" }));
  assert.equal((await store.get(first.cardId)).title, "Human title");
  await store.dispose();
  const restarted = createCardStore({ dataFile, coalesceMs: 60000 });
  t.after(() => restarted.dispose());
  restarted.attach(sessions);
  const cards = (await restarted.list()).cards;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].cardId, first.cardId);
  assert.equal(cards[0].revision, changed.revision);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(dataFile)).defaultSessionCards).length, 1);
});

test("interfaces atomically change core title and cross-component data against final dependencies", async (t) => {
  const { store } = fixture(t);
  let current = await planned(store);
  current = await store.execute(current.cardId, batch(current, [
    { type: "set-title", title: "Batch title" },
    { type: "set-component", component: component("amo.conversation", "conversation", { sessionComponentId: "session" }) },
    { type: "set-component", component: source() },
    { type: "set-component", component: processComponent("session") },
    { type: "set-note", componentId: "notes", text: "Batch note" },
  ]));
  assert.equal(current.title, "Batch title");
  assert.equal(processing(current).data.sourceComponentId, "session");
  assert.equal(store.focusView(current).session.presence, "detached");
  const before = await store.get(current.cardId);
  await assert.rejects(store.execute(current.cardId, batch(current, [{ type: "set-title", title: "Must rollback" }, { type: "remove-component", componentId: "session" }])), { statusCode: 400 });
  assert.deepEqual(await store.get(current.cardId), before);
  current = await store.execute(current.cardId, batch(current, [
    { type: "remove-component", componentId: "session" },
    { type: "remove-component", componentId: "conversation" },
    { type: "set-component", component: processComponent(null, "later") },
  ]));
  assert.equal(store.focusView(current).session, null);
  assert.equal(processing(current).data.attention.generation, 0);
});

test("source switch resets cursor explicitly and cannot consume old attention in the same batch", async (t) => {
  const { store, sessions } = fixture(t);
  sessions.set("one", session(reply(2)));
  sessions.set("two", session({ sessionId: "two", ...reply(3) }));
  let current = (await store.list()).cards.find((c) => c.title === "Session title" && c.components.some((x) => x.type === "amo.session" && x.data.sessionRef.sessionId === "one"));
  current = await store.execute(current.cardId, batch(current, [{ type: "handle", componentId: "processing", throughGeneration: 1 }]));
  const commands = [{ type: "set-component", component: source("session", "two") }];
  await assert.rejects(store.execute(current.cardId, batch(current, commands)), { statusCode: 400 });
  commands.push({ type: "set-component", component: processComponent("session", "reviewing") });
  await assert.rejects(store.execute(current.cardId, batch(current, [...commands, { type: "handle", componentId: "processing", throughGeneration: 1 }])), { code: "card_source_changed" });
  current = await store.execute(current.cardId, batch(current, commands));
  assert.equal(processing(current).data.handledGeneration, 0);
  assert.equal(processing(current).data.attention.generation, 1);
  assert.equal(processing(current).data.attention.hasUnseen, true);
  assert.equal(store.focusView(current).session.sessionRef.sessionId, "two");
});

test("generic component edits cannot inject or acknowledge managed attention", async (t) => {
  const { store } = fixture(t);
  const current = await planned(store);
  for (const bad of [
    { ...processComponent(), data: { ...processComponent().data, handledGeneration: 9 } },
    { ...processComponent(), data: { ...processComponent().data, attention: { generation: 9 } } },
    { ...processComponent(), data: { ...processComponent().data, state: "handled" } },
  ]) await assert.rejects(store.execute(current.cardId, batch(current, [{ type: "set-component", component: bad }])), { statusCode: 400 });
  await assert.rejects(store.execute(current.cardId, batch(current, [{ type: "set-processing", componentId: "processing", state: "handled" }])), { statusCode: 400 });
  assert.equal(processing(await store.get(current.cardId)).data.attention.generation, 0);
});

test("creation handled state cannot bypass current source attention", async (t) => {
  const { store, sessions } = fixture(t);
  sessions.set("one", session(reply(2)));
  const current = await store.create({ operationId: "manual-source", title: "Manual", components: [source(), processComponent("session", "handled")] });
  assert.equal(processing(current).data.state, "pending");
  assert.equal(processing(current).data.handledGeneration, 0);
  assert.equal(processing(current).data.attention.generation, 1);
});

test("Session and conversation are independent and selected-source conversation is exact", async (t) => {
  const { store, sessions } = fixture(t);
  sessions.set("one", session());
  sessions.set("two", session({ sessionId: "two", tool: "claude" }));
  let current = await store.create({ operationId: "multiple", title: "Multiple", components: [source(), source("second", "two", "claude"), processComponent("second"), component("amo.conversation", "first-chat", { sessionComponentId: "session" })] });
  let view = store.focusView(current);
  assert.equal(view.session.componentId, "second");
  assert.equal(view.conversation, null);
  current = await store.execute(current.cardId, batch(current, [{ type: "set-component", component: component("amo.conversation", "second-chat", { sessionComponentId: "second" }) }]));
  view = store.focusView(current);
  assert.equal(view.conversation.componentId, "second-chat");
  assert.equal(view.conversation.sessionComponentId, "second");
  await assert.rejects(store.execute(current.cardId, batch(current, [{ type: "set-component", component: component("amo.conversation", "ambiguous", { sessionComponentId: "second" }) }])), { statusCode: 400 });
});

test("Card archive is independent from Session archive/delete/restore and never deletes runtime", async (t) => {
  const { store, sessions } = fixture(t);
  sessions.set("one", session());
  let current = await imported(store);
  current = await store.execute(current.cardId, batch(current, [{ type: "archive" }]));
  assert.equal((await store.listFocus()).cards.length, 0);
  assert.equal((await store.list()).cards.length, 1);
  assert.equal(sessions.size, 1);
  sessions.set("one", session({ archivedAt: at(2) }));
  current = await store.execute(current.cardId, batch(current, [{ type: "restore" }]));
  assert.equal(store.focusView(current).session.presence, "archived");
  sessions.delete("one");
  assert.equal((await store.listFocus()).cards[0].session.presence, "detached");
  sessions.set("one", session());
  assert.equal((await store.listFocus()).cards[0].cardId, current.cardId);
  sessions.clear();
  assert.equal((await store.list()).cards.length, 1);
});

test("removing processing hides the Card from Focus and hooks do not reimport it", async (t) => {
  const { store, sessions } = fixture(t);
  sessions.set("one", session(reply(2)));
  let current = await imported(store);
  current = await store.execute(current.cardId, batch(current, [{ type: "remove-component", componentId: "processing" }]));
  sessions.set("one", session(reply(3)));
  assert.equal((await store.listFocus()).cards.length, 0);
  assert.equal((await store.list()).cards.length, 1);
  assert.equal(sessions.size, 1);
});

test("unknown components and unsupported versions survive notes, triage and restart", async (t) => {
  const { store, dataFile } = fixture(t);
  const unknown = component("custom.planner", "opaque", { title: "Cannot override", triage: { state: "handled" }, nested: [1, { safe: true }] }, 3);
  let current = await store.create({ operationId: "unknown", title: "Core title", components: [processComponent(), note(), unknown, component("amo.conversation", "future-chat", { unknownVersion: true }, 2)] });
  current = await store.execute(current.cardId, batch(current, [{ type: "set-note", componentId: "notes", text: "Remember" }, { type: "set-processing", componentId: "processing", state: "future" }]));
  assert.equal(current.title, "Core title");
  assert.deepEqual(current.components.find((c) => c.componentId === "opaque"), unknown);
  assert.equal(store.focusView(current).conversation, null);
  const restarted = createCardStore({ dataFile });
  t.after(() => restarted.dispose());
  assert.deepEqual(await restarted.get(current.cardId), current);
});

test("observer captures reply before legacy flags clear and ignores unchanged hooks", async (t) => {
  let writes = 0;
  const { store, sessions } = fixture(t, { write: async (...args) => { writes += 1; await writeSnapshot(...args); } });
  sessions.set("one", session(reply(2)));
  sessions.set("one", session({ ...reply(2), state: "running", reviewTurnId: null, reviewRequired: false }));
  const first = await imported(store);
  assert.equal(processing(first).data.attention.generation, 1);
  assert.equal(writes, 1);
  for (let index = 0; index < 100; index += 1) sessions.set("one", session({ ...reply(2), state: "running", reviewTurnId: null, reviewRequired: false, lastMessage: `tool ${index}`, updatedAt: at(3) }));
  assert.equal((await store.get(first.cardId)).revision, first.revision);
  assert.equal(writes, 1);
});

test("duplicate and late replies do not reopen handled state while fresh replies preserve deferrals", async (t) => {
  const { store, sessions } = fixture(t);
  sessions.set("one", session(reply(5, "same-turn")));
  let current = await imported(store);
  current = await store.execute(current.cardId, batch(current, [{ type: "handle", componentId: "processing", throughGeneration: 1 }]));
  sessions.set("one", session(reply(6, "same-turn")));
  sessions.set("one", session(reply(2)));
  current = await store.get(current.cardId);
  assert.equal(processing(current).data.state, "handled");
  assert.equal(processing(current).data.attention.generation, 1);
  for (const [index, state] of ["later", "future", "reviewing"].entries()) {
    current = await store.execute(current.cardId, batch(current, [{ type: "set-processing", componentId: "processing", state }]));
    sessions.set("one", session(reply(7 + index)));
    current = await store.get(current.cardId);
    assert.equal(processing(current).data.state, state);
    assert.equal(processing(current).data.attention.hasUnseen, true);
  }
});

test("blocking transition dedup, handled permission and stale generation protection persist", async (t) => {
  const { store, sessions } = fixture(t);
  sessions.set("one", session({ state: "waiting_permission", updatedAt: at(2) }));
  sessions.set("one", session({ state: "waiting_permission", updatedAt: at(3) }));
  let current = await imported(store);
  assert.equal(processing(current).data.attention.generation, 1);
  current = await store.execute(current.cardId, batch(current, [{ type: "handle", componentId: "processing", throughGeneration: 1 }]));
  assert.equal(store.focusView(current).session.execution, "waiting_permission");
  sessions.set("one", session({ updatedAt: at(4) }));
  sessions.set("one", session({ state: "waiting_permission", updatedAt: at(2) }));
  assert.equal(processing(await store.get(current.cardId)).data.attention.generation, 1);
  sessions.set("one", session({ state: "waiting_permission", updatedAt: at(5) }));
  await assert.rejects(store.execute(current.cardId, batch(current, [{ type: "handle", componentId: "processing", throughGeneration: 1 }])), { code: "card_revision_conflict" });
  current = await store.get(current.cardId);
  await assert.rejects(store.execute(current.cardId, batch(current, [{ type: "handle", componentId: "processing", throughGeneration: 1 }])), { code: "card_generation_conflict" });
});

test("startup seeds reviewed old replies handled and preserves persisted human choices", async (t) => {
  const { store, dataFile } = fixture(t);
  await store.dispose();
  const sessions = new SessionCollection();
  sessions.set("one", session({ ...reply(2), reviewRequired: false, reviewStatus: "reviewed" }));
  const seeded = createCardStore({ dataFile, coalesceMs: 60000 });
  seeded.attach(sessions);
  let current = await imported(seeded);
  assert.equal(processing(current).data.state, "handled");
  assert.equal(processing(current).data.attention.hasUnseen, false);
  current = await seeded.execute(current.cardId, batch(current, [{ type: "set-processing", componentId: "processing", state: "later" }]));
  await seeded.dispose();
  const restarted = createCardStore({ dataFile, coalesceMs: 60000 });
  t.after(() => restarted.dispose());
  restarted.attach(sessions);
  assert.equal(processing(await restarted.get(current.cardId)).data.state, "later");
});

test("failed human write preserves bytes and state; durable replay survives restart", async (t) => {
  let fail = false;
  const { store, dataFile } = fixture(t, { write: async (...args) => { if (fail) throw new Error("disk failure"); await writeSnapshot(...args); } });
  const current = await planned(store);
  const before = fs.readFileSync(dataFile, "utf8");
  const request = batch(current, [{ type: "set-title", title: "Durable" }]);
  fail = true;
  await assert.rejects(store.execute(current.cardId, request), { code: "card_write_failed" });
  assert.equal(fs.readFileSync(dataFile, "utf8"), before);
  assert.deepEqual(await store.get(current.cardId), current);
  fail = false;
  const saved = await store.execute(current.cardId, request);
  const restarted = createCardStore({ dataFile });
  t.after(() => restarted.dispose());
  assert.deepEqual(await restarted.execute(current.cardId, request), saved);
  await assert.rejects(restarted.execute(current.cardId, { ...request, commands: [{ type: "set-title", title: "Other" }] }), { code: "card_operation_conflict" });
});

test("fresh reply during a durable handle stays unseen after acknowledgement", async (t) => {
  let release, began;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { began = resolve; });
  const { store, sessions } = fixture(t, { write: async (file, snapshot) => { if (snapshot.operations.length === 1) { began(); await gate; } await writeSnapshot(file, snapshot); } });
  sessions.set("one", session(reply(2)));
  const current = await imported(store);
  const saving = store.execute(current.cardId, batch(current, [{ type: "handle", componentId: "processing", throughGeneration: 1 }]));
  await started;
  sessions.set("one", session(reply(3)));
  release();
  assert.equal(processing(await saving).data.handledGeneration, 1);
  const fresh = await store.get(current.cardId);
  assert.equal(processing(fresh).data.attention.generation, 2);
  assert.equal(processing(fresh).data.attention.hasUnseen, true);
});

test("background failures retry without new events and preserve observed generations", async (t) => {
  let writes = 0, complete;
  const done = new Promise((resolve) => { complete = resolve; });
  const { store, sessions } = fixture(t, { coalesceMs: 5, retryMs: 10, write: async (...args) => { writes += 1; if (writes === 1) throw new Error("temporary failure"); await writeSnapshot(...args); complete(); } });
  sessions.set("one", session(reply(2)));
  sessions.set("one", session(reply(3)));
  let timeout;
  await Promise.race([done, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Retry timeout")), 2000); })]).finally(() => clearTimeout(timeout));
  assert.equal(writes, 2);
  assert.equal(processing(await imported(store)).data.attention.generation, 2);
});

test("new storage corruption is visible, old Focus file is not read or changed", async (t) => {
  const { store, dataFile, directory } = fixture(t);
  await store.dispose();
  const oldFile = path.join(directory, "focus-cards.json");
  fs.writeFileSync(oldFile, "old data should remain");
  const fresh = createCardStore({ dataFile });
  assert.equal((await fresh.list()).cards.length, 0);
  await fresh.dispose();
  fs.writeFileSync(dataFile, "{ broken");
  const broken = createCardStore({ dataFile });
  await assert.rejects(broken.list(), { code: "card_storage_error" });
  await assert.rejects(planned(broken), { code: "card_storage_error" });
  assert.equal(fs.readFileSync(dataFile, "utf8"), "{ broken");
  assert.equal(fs.readFileSync(oldFile, "utf8"), "old data should remain");
});

test("bounded ledger and exact replay share one writer with Focus facade", async (t) => {
  const { store, dataFile } = fixture(t);
  let current = await planned(store);
  const request = { operationId: "focus-note", expectedRevision: current.revision, action: "set-triage", note: "Only note" };
  const view = await store.mutateFocus(current.cardId, request);
  assert.equal(view.session, null);
  assert.equal(view.triage.note, "Only note");
  assert.deepEqual(await store.mutateFocus(current.cardId, request), view);
  await assert.rejects(store.execute(current.cardId, { operationId: "focus-note", expectedRevision: current.revision, commands: [{ type: "set-title", title: "Wrong interface" }] }), { code: "card_operation_conflict" });
  current = await store.get(current.cardId);
  for (let index = 0; index < 130; index += 1) current = await store.execute(current.cardId, batch(current, [{ type: "set-note", componentId: "notes", text: String(index) }], `note-${index}`));
  assert.equal(JSON.parse(fs.readFileSync(dataFile)).operations.length, 128);
});

test("invalid components, duplicate commands and malformed input never partially persist", async (t) => {
  const { store } = fixture(t);
  for (const components of [null, [processComponent(), processComponent()], [source(), component("amo.conversation", "chat", { sessionComponentId: "missing" })], [component("custom.data", "large", { text: "x".repeat(33000) })], [note("x".repeat(2001))], Array.from({ length: 33 }, (_, index) => component("custom.data", String(index), {}))]) await assert.rejects(store.create({ operationId: "bad", title: "Bad", components }), { statusCode: 400 });
  const current = await planned(store);
  for (const type of ["constructor", "toString", "__proto__"]) await assert.rejects(store.execute(current.cardId, batch(current, [{ type }])), { statusCode: 400 });
  await assert.rejects(store.execute(current.cardId, batch(current, [{ type: "archive" }, { type: "archive" }])), { statusCode: 400 });
  await assert.rejects(store.execute(current.cardId, { ...batch(current, [{ type: "archive" }]), expectedRevision: 0.5 }), { statusCode: 400 });
  assert.deepEqual(await store.get(current.cardId), current);
});

test("Focus captures immutable requests and known replay succeeds despite newer failed observations", async (t) => {
  let fail = false;
  const { store, sessions } = fixture(t, { write: async (...args) => { if (fail) throw new Error("disk failure"); await writeSnapshot(...args); } });
  let current = await planned(store);
  const payload = { operationId: "immutable", expectedRevision: current.revision, action: "set-triage", note: "Original" };
  const save = store.mutateFocus(current.cardId, payload);
  payload.note = "Changed by caller";
  const result = await save;
  assert.equal(result.triage.note, "Original");
  fail = true;
  sessions.set("one", session(reply(2)));
  await assert.rejects(store.flush(), { code: "card_write_failed" });
  assert.deepEqual(await store.mutateFocus(current.cardId, { ...payload, note: "Original" }), result);
  fail = false;
  await store.flush();
});

test("canonical framework mismatch never projects a different runtime onto a Card", async (t) => {
  const { store, sessions } = fixture(t);
  sessions.set("one", session());
  const first = await imported(store);
  sessions.set("one", session({ tool: "claude" }));
  const view = store.focusView(await store.get(first.cardId));
  assert.equal(view.session.sessionRef.frameworkId, "codex");
  assert.equal(view.session.presence, "detached");
  assert.equal(view.conversation.capabilities.activate, false);
  assert.equal((await store.list()).cards.length, 2);
});

test("observation errors surface and recover without corrupting existing cards", async (t) => {
  const { store } = fixture(t);
  await planned(store);
  store.observe({ type: "set", sessionId: "one", session: { sessionId: 42 } });
  await assert.rejects(store.list(), { code: "card_observation_failed" });
  store.observe({ type: "set", sessionId: "one", session: session() });
  assert.equal((await store.list()).cards.length, 2);
  assert.equal(store.status().error, null);
});
