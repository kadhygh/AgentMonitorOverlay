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
  assert.deepEqual(await store.listGroups(), { schemaVersion: 1, revision: 0, groups: [] });
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
  assert.deepEqual(await restarted.listGroups(), { schemaVersion: 1, revision: 0, groups: [] });
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
