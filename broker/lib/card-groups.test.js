const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCardStore } = require("./card-store");
const { SessionCollection } = require("./session-collection");
const { writeSnapshot } = require("./task-canvas-store");

const component = (type, componentId, data) => ({ type, componentId, schemaVersion: 1, data });
const groupComponent = (groupId) => component("amo.task-group", "task-group", { groupId });
const processing = component("amo.processing", "processing", { sourceComponentId: null, state: "pending" });
const createGroup = (name = "Review", dragOnly = false) => ({ type: "create", name, dragOnly });
const request = (operationId, expectedRevision, commands) => ({ operationId, expectedRevision, commands });
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "amo-card-groups-"));
  const dataFile = path.join(directory, "cards.json");
  const store = createCardStore({ dataFile, coalesceMs: 60000, ...options });
  t.after(async () => { await store.dispose().catch(() => {}); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, dataFile };
}
const makeCard = (store, operationId, groupId, extra = []) => store.create({ operationId, title: operationId, components: [processing, groupComponent(groupId), ...extra] });

test("manual groups have stable IDs, durable exact replay, conflicts and restart", async (t) => {
  const { store, dataFile } = fixture(t);
  assert.deepEqual(await store.listGroups(), { schemaVersion: 1, revision: 0, groups: [], reviewGroupId: null });
  const create = request("create", 0, [createGroup()]);
  const first = await store.executeGroups(create);
  const groupId = first.groups[0].groupId;
  assert.match(groupId, /^group-[0-9a-f-]{36}$/u);
  const card = await makeCard(store, "card", groupId);
  const renamed = await store.executeGroups(request("rename", 1, [{ type: "update", groupId, name: "Whenever", dragOnly: true }]));
  assert.deepEqual(renamed.groups, [{ groupId, name: "Whenever", dragOnly: true }]);
  assert.deepEqual(await store.get(card.cardId), card);
  assert.deepEqual(await store.executeGroups(create), first);
  await assert.rejects(store.executeGroups(request("create", 0, [createGroup("different")])), { code: "card_group_operation_conflict" });
  await assert.rejects(store.executeGroups(request("stale", 1, [createGroup()])), { code: "card_group_revision_conflict" });
  await store.dispose();
  const restarted = createCardStore({ dataFile });
  t.after(() => restarted.dispose());
  assert.deepEqual(await restarted.listGroups(), renamed);
  assert.deepEqual(await restarted.executeGroups(create), first);
  assert.equal((await restarted.listFocus()).cards[0].groupId, groupId);
});

test("group deletion clears active and archived references atomically without changing attention", async (t) => {
  let failWrite = false;
  const { store } = fixture(t, { write: async (file, data) => { if (failWrite) throw new Error("disk unavailable"); return writeSnapshot(file, data); } });
  const groups = await store.executeGroups(request("groups", 0, [createGroup()]));
  const groupId = groups.groups[0].groupId;
  const active = await makeCard(store, "active", groupId);
  let archived = await makeCard(store, "archived", groupId);
  archived = await store.execute(archived.cardId, request("archive", archived.revision, [{ type: "archive" }]));
  const remove = request("delete", groups.revision, [{ type: "delete", groupId }]);
  failWrite = true;
  await assert.rejects(store.executeGroups(remove), { code: "card_write_failed" });
  assert.deepEqual(await store.listGroups(), groups);
  assert.deepEqual(await store.get(active.cardId), active);
  assert.deepEqual(await store.get(archived.cardId), archived);
  failWrite = false;
  const removed = await store.executeGroups(remove);
  assert.deepEqual(removed.groups, []);
  for (const before of [active, archived]) {
    const after = await store.get(before.cardId);
    assert.equal(after.components.find((c) => c.type === "amo.task-group").data.groupId, null);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.archivedAt, before.archivedAt);
    assert.deepEqual(after.components.find((c) => c.type === "amo.processing"), before.components.find((c) => c.type === "amo.processing"));
  }
  assert.equal((await store.listFocus()).cards.length, 1);
  const all = await store.listFocus({ includeArchived: true });
  assert.equal(all.cards.length, 2);
  assert.deepEqual(all.groups, []);
  assert.equal(all.groupRevision, removed.revision);
  assert.equal(all.cards.find((c) => c.cardId === archived.cardId).archivedAt, archived.archivedAt);
  assert.deepEqual(await store.executeGroups(remove), removed);
  assert.equal((await store.get(active.cardId)).revision, active.revision + 1);
});

test("invalid group batches roll back and stale card assignment cannot resurrect deleted groups", async (t) => {
  const { store } = fixture(t);
  const groups = await store.executeGroups(request("groups", 0, [createGroup()]));
  const groupId = groups.groups[0].groupId;
  const absent = "group-00000000-0000-4000-8000-000000000000";
  await assert.rejects(store.executeGroups(request("rollback", 1, [{ type: "delete", groupId }, { type: "delete", groupId: absent }])), { code: "card_group_not_found" });
  assert.deepEqual(await store.listGroups(), groups);
  await assert.rejects(makeCard(store, "unknown", absent), { statusCode: 400 });
  await assert.rejects(store.create({ operationId: "duplicate", title: "Two groups", components: [groupComponent(groupId), { ...groupComponent(groupId), componentId: "other" }] }), { statusCode: 400 });
  const card = await makeCard(store, "card", null);
  const deletion = store.executeGroups(request("delete", 1, [{ type: "delete", groupId }]));
  const staleAssignment = store.execute(card.cardId, request("assign", card.revision, [{ type: "set-title", title: "Must rollback" }, { type: "set-component", component: groupComponent(groupId) }]));
  await deletion;
  await assert.rejects(staleAssignment, { statusCode: 400 });
  assert.deepEqual(await store.get(card.cardId), card);
  await assert.rejects(makeCard(store, "late-create", groupId), { statusCode: 400 });
});

test("Session replies, running hooks, duplicates and disconnect never move manual groups", async (t) => {
  const { store, dataFile } = fixture(t);
  const sessions = new SessionCollection();
  store.attach(sessions);
  const groups = await store.executeGroups(request("groups", 0, [createGroup("Done", true)]));
  const groupId = groups.groups[0].groupId;
  const base = { sessionId: "one", tool: "codex", title: "Session", state: "running", updatedAt: "2026-09-11T00:00:01.000Z" };
  sessions.set("one", base);
  let card = (await store.list()).cards[0];
  card = await store.execute(card.cardId, request("assign", card.revision, [{ type: "set-component", component: groupComponent(groupId) }, { type: "handle", componentId: "processing", throughGeneration: 0 }]));
  const reply = { ...base, state: "idle", lastReplyAt: "2026-09-11T00:00:02.000Z", lastReplyNote: "reply.md", reviewTurnId: "turn", reviewRequired: true, updatedAt: "2026-09-11T00:00:02.000Z" };
  sessions.set("one", reply);
  let view = (await store.listFocus()).cards[0];
  assert.equal(view.groupId, groupId);
  assert.equal(view.attention.hasUnseen, true);
  const generation = view.attention.generation;
  sessions.set("one", reply);
  sessions.set("one", { ...reply, state: "running", updatedAt: "2026-09-11T00:00:03.000Z" });
  sessions.delete("one");
  view = (await store.listFocus()).cards[0];
  assert.equal(view.groupId, groupId);
  assert.equal(view.attention.generation, generation);
  assert.equal(view.session.presence, "detached");
  await store.dispose();
  const restarted = createCardStore({ dataFile });
  t.after(() => restarted.dispose());
  assert.equal((await restarted.listFocus()).cards[0].groupId, groupId);
});

test("prior cards snapshots default only missing group registry and preserve cards", async (t) => {
  const { store, dataFile } = fixture(t);
  const card = await store.create({ operationId: "card", title: "Existing", components: [processing] });
  await store.dispose();
  const old = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  delete old.groups; delete old.groupRevision; delete old.groupOperations;
  fs.writeFileSync(dataFile, JSON.stringify(old));
  const restarted = createCardStore({ dataFile });
  t.after(() => restarted.dispose());
  assert.deepEqual(await restarted.get(card.cardId), card);
  assert.deepEqual(await restarted.listGroups(), { schemaVersion: 1, revision: 0, groups: [], reviewGroupId: null });
  await restarted.executeGroups(request("first", 0, [createGroup()]));
  assert.equal(JSON.parse(fs.readFileSync(dataFile, "utf8")).groupRevision, 1);
});

test("group replay ledger is bounded and evicted stale requests cannot create groups", async (t) => {
  const { store, dataFile } = fixture(t);
  const firstRequest = request("first", 0, [createGroup()]);
  let result = await store.executeGroups(firstRequest);
  const groupId = result.groups[0].groupId;
  let lastRequest;
  for (let i = 0; i < 129; i += 1) {
    lastRequest = request(`update-${i}`, result.revision, [{ type: "update", groupId, name: `Group ${i}`, dragOnly: i % 2 === 0 }]);
    result = await store.executeGroups(lastRequest);
  }
  assert.equal(JSON.parse(fs.readFileSync(dataFile, "utf8")).groupOperations.length, 128);
  await assert.rejects(store.executeGroups(firstRequest), { code: "card_group_revision_conflict" });
  assert.deepEqual(await store.executeGroups(lastRequest), result);
  assert.equal((await store.listGroups()).groups.length, 1);
});

test("one Review target survives rename and restart, clears on delete, and normalizes older replay snapshots", async (t) => {
  const { store, dataFile } = fixture(t);
  const initialRequest = request("groups", 0, [createGroup("Review"), createGroup("Later")]);
  let view = await store.executeGroups(initialRequest);
  const [first, second] = view.groups;
  view = await store.executeGroups(request("target", view.revision, [{ type: "set-review-group", groupId: first.groupId }]));
  assert.equal(view.reviewGroupId, first.groupId);
  view = await store.executeGroups(request("rename-target", view.revision, [{ type: "update", groupId: first.groupId, name: "Look here", dragOnly: true }]));
  assert.equal(view.reviewGroupId, first.groupId);
  assert.equal((await store.listFocus()).reviewGroupId, first.groupId);
  const missing = "group-00000000-0000-4000-8000-000000000000";
  await assert.rejects(store.executeGroups(request("bad-target", view.revision, [{ type: "set-review-group", groupId: missing }])), { code: "card_group_not_found" });
  view = await store.executeGroups(request("switch", view.revision, [{ type: "set-review-group", groupId: second.groupId }]));
  assert.equal(view.reviewGroupId, second.groupId);
  view = await store.executeGroups(request("remove-target", view.revision, [{ type: "delete", groupId: second.groupId }]));
  assert.equal(view.reviewGroupId, null);
  await store.dispose();
  const old = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  delete old.reviewGroupId;
  delete old.groupOperations[0].result.reviewGroupId;
  fs.writeFileSync(dataFile, JSON.stringify(old));
  const restarted = createCardStore({ dataFile });
  t.after(() => restarted.dispose());
  assert.equal((await restarted.listGroups()).reviewGroupId, null);
  assert.equal((await restarted.executeGroups(initialRequest)).reviewGroupId, null);
});

test("Session enrollment reuses canonical identity, preserves edits, restores Card only, and replays after restart", async (t) => {
  const { store, dataFile } = fixture(t);
  const sessions = new SessionCollection();
  store.attach(sessions);
  const runtime = { sessionId: "one", tool: "codex", title: "Task", state: "running", updatedAt: "2026-09-11T00:00:01.000Z" };
  sessions.set("one", runtime);
  const untouched = JSON.stringify(runtime);
  const groups = await store.executeGroups(request("groups", 0, [createGroup("Review"), createGroup("Later")]));
  const sessionRef = { frameworkId: "codex", sessionId: "one" };
  const add = { operationId: "enroll", sessionRef, groupId: groups.groups[0].groupId };
  const original = (await store.list()).cards[0];
  const first = await store.fromSession(add);
  assert.equal(first.cardId, original.cardId);
  assert.deepEqual(await store.fromSession(add), first);
  let card = await store.execute(first.cardId, request("note-archive", first.revision, [{ type: "set-note", componentId: "notes", text: "Keep my note" }, { type: "set-title", title: "Human title" }, { type: "archive" }]));
  const restore = { ...add, operationId: "restore-enroll", groupId: groups.groups[1].groupId };
  card = await store.fromSession(restore);
  assert.equal(card.archivedAt, null);
  assert.equal(card.cardId, original.cardId);
  assert.equal(card.title, "Human title");
  assert.equal(card.components.find((entry) => entry.type === "amo.notes").data.text, "Keep my note");
  assert.equal(card.components.find((entry) => entry.type === "amo.task-group").data.groupId, restore.groupId);
  assert.deepEqual(await store.fromSession({ ...restore, operationId: "repeated-add" }), card);
  assert.equal((await store.list()).cards.length, 1);
  assert.equal(JSON.stringify(sessions.get("one")), untouched);
  await store.dispose();
  const restarted = createCardStore({ dataFile });
  t.after(() => restarted.dispose());
  assert.deepEqual(await restarted.fromSession(add), first);
  assert.deepEqual(await restarted.fromSession(restore), card);
  await assert.rejects(restarted.fromSession({ ...add, groupId: restore.groupId }), { code: "card_operation_conflict" });
});

test("Session enrollment validates queued group/runtime state and never repairs changed sources", async (t) => {
  const { store } = fixture(t);
  const sessions = new SessionCollection();
  store.attach(sessions);
  const runtime = { sessionId: "one", tool: "codex", title: "Task", state: "running", updatedAt: "2026-09-11T00:00:01.000Z" };
  sessions.set("one", runtime);
  const groups = await store.executeGroups(request("groups", 0, [createGroup()]));
  const add = { operationId: "add", sessionRef: { frameworkId: "codex", sessionId: "one" }, groupId: groups.groups[0].groupId };
  await assert.rejects(store.fromSession({ ...add, sessionRef: { frameworkId: "claude", sessionId: "one" } }), { code: "card_session_unavailable" });
  for (const change of [{ archivedAt: "2026-09-11T00:00:02.000Z" }, { dismissedAt: "2026-09-11T00:00:02.000Z" }]) {
    sessions.set("one", { ...runtime, ...change });
    await assert.rejects(store.fromSession(add), { code: "card_session_unavailable" });
  }
  sessions.delete("one");
  await assert.rejects(store.fromSession(add), { code: "card_session_unavailable" });
  sessions.set("one", runtime);
  let card = (await store.list()).cards[0];
  card = await store.execute(card.cardId, request("detach", card.revision, [{ type: "set-component", component: processing }]));
  await assert.rejects(store.fromSession(add), { code: "card_source_changed" });
  assert.deepEqual(await store.get(card.cardId), card);
  const remove = store.executeGroups(request("remove", groups.revision, [{ type: "delete", groupId: add.groupId }]));
  const staleAdd = store.fromSession(add);
  await remove;
  await assert.rejects(staleAdd, { code: "card_group_not_found" });
});

test("Review routing enrolls new replies but retains manual moves across duplicates, late events and restart", async (t) => {
  const { store, dataFile } = fixture(t);
  const sessions = new SessionCollection();
  store.attach(sessions);
  const base = { sessionId: "one", tool: "codex", title: "Task", state: "running", updatedAt: "2026-09-11T00:00:01.000Z" };
  sessions.set("one", base);
  let groups = await store.executeGroups(request("groups", 0, [createGroup("Review"), createGroup("Later")]));
  const [review, later] = groups.groups;
  groups = await store.executeGroups(request("target", groups.revision, [{ type: "set-review-group", groupId: review.groupId }]));
  const reply = (second) => ({ ...base, state: "idle", lastReplyAt: `2026-09-11T00:00:0${second}.000Z`, lastReplyNote: `${second}.md`, reviewTurnId: `turn-${second}`, reviewRequired: true, updatedAt: `2026-09-11T00:00:0${second}.000Z` });
  sessions.set("one", reply(2));
  let card = (await store.list()).cards[0];
  assert.equal(store.focusView(card).groupId, review.groupId);
  card = await store.execute(card.cardId, request("move", card.revision, [{ type: "set-component", component: { ...groupComponent(later.groupId), componentId: card.components.find((entry) => entry.type === "amo.task-group").componentId } }]));
  for (const event of [reply(2), { ...reply(2), state: "running", reviewTurnId: null, updatedAt: "2026-09-11T00:00:04.000Z" }, reply(1), { ...reply(2), state: "waiting_permission" }]) sessions.set("one", event);
  assert.equal((await store.listFocus()).cards[0].groupId, later.groupId);
  sessions.delete("one");
  assert.equal((await store.listFocus()).cards[0].groupId, later.groupId);
  sessions.set("one", reply(2));
  await store.dispose();
  const restarted = createCardStore({ dataFile, coalesceMs: 60000 });
  t.after(() => restarted.dispose());
  restarted.attach(sessions);
  assert.equal((await restarted.listFocus()).cards[0].groupId, later.groupId);
  sessions.set("one", reply(5));
  assert.equal((await restarted.listFocus()).cards[0].groupId, review.groupId);
});

test("Review configuration and startup never sweep history, and archived Cards or Sessions remain excluded", async (t) => {
  const { store, dataFile } = fixture(t);
  const sessions = new SessionCollection();
  const base = { sessionId: "one", tool: "codex", title: "Task", state: "idle", lastReplyAt: "2026-09-11T00:00:01.000Z", lastReplyNote: "old.md", reviewTurnId: "old", reviewRequired: true, updatedAt: "2026-09-11T00:00:01.000Z" };
  sessions.set("one", base);
  store.attach(sessions);
  let groups = await store.executeGroups(request("groups", 0, [createGroup("Review")]));
  const groupId = groups.groups[0].groupId;
  await store.executeGroups(request("target", groups.revision, [{ type: "set-review-group", groupId }]));
  assert.equal((await store.listFocus()).cards[0].groupId, null);
  sessions.set("one", { ...base, state: "running" });
  assert.equal((await store.listFocus()).cards[0].groupId, null);
  let card = (await store.list()).cards[0];
  await store.execute(card.cardId, request("archive", card.revision, [{ type: "archive" }]));
  const fresh = { ...base, lastReplyAt: "2026-09-11T00:00:02.000Z", lastReplyNote: "new.md", reviewTurnId: "new", updatedAt: "2026-09-11T00:00:02.000Z" };
  sessions.set("one", fresh);
  assert.equal((await store.listFocus({ includeArchived: true })).cards[0].groupId, null);
  const restored = await store.fromSession({ operationId: "restore", sessionRef: { frameworkId: "codex", sessionId: "one" }, groupId });
  card = await store.execute(restored.cardId, request("ungroup", restored.revision, [{ type: "set-component", component: { ...groupComponent(null), componentId: restored.components.find((entry) => entry.type === "amo.task-group").componentId } }]));
  sessions.set("one", fresh);
  assert.equal((await store.listFocus()).cards[0].groupId, null);
  sessions.set("two", { ...fresh, sessionId: "two", archivedAt: "2026-09-11T00:00:03.000Z" });
  sessions.set("three", { ...fresh, sessionId: "three", dismissedAt: "2026-09-11T00:00:03.000Z" });
  assert.ok((await store.listFocus()).cards.every((entry) => entry.groupId === null));
  await store.dispose();
  // A previously unseen offline reply is baselined at startup as well.
  sessions.set("one", { ...fresh, lastReplyAt: "2026-09-11T00:00:04.000Z", lastReplyNote: "offline.md", reviewTurnId: "offline" });
  const restarted = createCardStore({ dataFile, coalesceMs: 60000 });
  t.after(() => restarted.dispose());
  restarted.attach(sessions);
  assert.ok((await restarted.listFocus()).cards.every((entry) => entry.groupId === null));
});

test("full component Cards cannot poison reply observation or partially enroll", async (t) => {
  const { store } = fixture(t);
  const sessions = new SessionCollection();
  store.attach(sessions);
  const base = { sessionId: "one", tool: "codex", title: "Task", state: "running", updatedAt: "2026-09-11T00:00:01.000Z" };
  sessions.set("one", base);
  let card = (await store.list()).cards[0];
  for (let batch = 0; batch < 2; batch += 1) card = await store.execute(card.cardId, request(`fill-${batch}`, card.revision, Array.from({ length: 14 }, (_, i) => ({ type: "set-component", component: component("test.extra", `extra-${batch}-${i}`, {}) }))));
  let groups = await store.executeGroups(request("groups", 0, [createGroup()]));
  const groupId = groups.groups[0].groupId;
  await store.executeGroups(request("target", groups.revision, [{ type: "set-review-group", groupId }]));
  sessions.set("one", { ...base, state: "idle", reviewRequired: true, lastReplyAt: "2026-09-11T00:00:02.000Z", lastReplyNote: "reply.md" });
  card = (await store.list()).cards[0];
  assert.equal(card.components.length, 32);
  assert.equal(store.focusView(card).groupId, null);
  assert.equal(store.focusView(card).attention.hasUnseen, true);
  await assert.rejects(store.fromSession({ operationId: "full-enroll", sessionRef: { frameworkId: "codex", sessionId: "one" }, groupId }), { statusCode: 400 });
  assert.deepEqual(await store.get(card.cardId), card);
});

test("reply metadata only routes when the Session actually requires Review", async (t) => {
  const { store } = fixture(t);
  const sessions = new SessionCollection();
  store.attach(sessions);
  const groups = await store.executeGroups(request("groups", 0, [createGroup()]));
  await store.executeGroups(request("target", groups.revision, [{ type: "set-review-group", groupId: groups.groups[0].groupId }]));
  const base = { tool: "codex", title: "Task", state: "running", updatedAt: "2026-09-11T00:00:01.000Z", lastReplyAt: "2026-09-11T00:00:01.000Z", lastReplyNote: "old.md" };
  for (const [sessionId, flags] of [["metadata-only", {}], ["reviewed-status", { reviewRequired: true, reviewStatus: "reviewed" }], ["reviewed-at", { reviewRequired: true, reviewedAt: "2026-09-11T00:00:02.000Z" }]]) sessions.set(sessionId, { ...base, sessionId, ...flags });
  assert.ok((await store.listFocus()).cards.every((card) => card.groupId === null && card.attention.hasUnseen));
});

test("failed enrollment and Review target changes leave durable state untouched and retry exactly", async (t) => {
  let failWrite = false;
  const { store, dataFile } = fixture(t, { write: async (file, data) => { if (failWrite) throw new Error("disk unavailable"); return writeSnapshot(file, data); } });
  const sessions = new SessionCollection();
  store.attach(sessions);
  sessions.set("one", { sessionId: "one", tool: "codex", title: "Task", state: "running", updatedAt: "2026-09-11T00:00:01.000Z" });
  let groups = await store.executeGroups(request("groups", 0, [createGroup()]));
  const groupId = groups.groups[0].groupId;
  const target = request("target", groups.revision, [{ type: "set-review-group", groupId }]);
  const bytes = fs.readFileSync(dataFile, "utf8");
  failWrite = true;
  await assert.rejects(store.executeGroups(target), { code: "card_write_failed" });
  assert.equal((await store.listGroups()).reviewGroupId, null);
  assert.equal(fs.readFileSync(dataFile, "utf8"), bytes);
  failWrite = false;
  groups = await store.executeGroups(target);
  assert.equal(groups.reviewGroupId, groupId);
  const original = (await store.list()).cards[0];
  const add = { operationId: "add", sessionRef: { frameworkId: "codex", sessionId: "one" }, groupId };
  failWrite = true;
  await assert.rejects(store.fromSession(add), { code: "card_write_failed" });
  assert.deepEqual(await store.get(original.cardId), original);
  failWrite = false;
  const card = await store.fromSession(add);
  assert.equal(card.cardId, original.cardId);
  assert.deepEqual(await store.fromSession(add), card);
});
