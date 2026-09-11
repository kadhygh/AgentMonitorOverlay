const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createCardStore } = require("./card-store");
const { handleCardRoutes } = require("../routes/cards");
const { handleFocusPanelRoutes } = require("../routes/focus-panel");
const { sendJson } = require("./http");

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "amo-card-http-"));
  const store = createCardStore({ dataFile: path.join(directory, "cards.json"), coalesceMs: 60000 });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const context = { cardStore: store };
      if (!await handleCardRoutes(req, res, url, context) && !await handleFocusPanelRoutes(req, res, url, context)) sendJson(res, 404, {});
    } catch (error) { sendJson(res, error.statusCode || 500, { error: error.code }); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await store.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, payload, headers = {}) => fetch(`${base}${url}`, { method: "POST", headers: { origin: "http://tauri.localhost", "content-type": "application/json", ...headers }, body: JSON.stringify(payload) });
  const read = async (url) => (await fetch(`${base}${url}`)).json();
  return { base, post, read, store };
}
const planned = { operationId: "create", title: "Planned card", components: [{ componentId: "processing", type: "amo.processing", schemaVersion: 1, data: { sourceComponentId: null, state: "pending" } }] };

test("task group HTTP registry and Focus all-groups projection use protected atomic commands", async (t) => {
  const { post, read } = await fixture(t);
  assert.deepEqual(await read("/api/card-groups"), { schemaVersion: 1, revision: 0, groups: [] });
  const payload = { operationId: "group", expectedRevision: 0, commands: [{ type: "create", name: "Done", dragOnly: true }] };
  assert.equal((await post("/api/card-groups/commands", payload, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post("/api/card-groups/commands", payload, { "content-type": "text/plain" })).status, 400);
  const groups = await (await post("/api/card-groups/commands", payload)).json();
  assert.deepEqual(await (await post("/api/card-groups/commands", payload)).json(), groups);
  const groupId = groups.groups[0].groupId;
  const { card } = await (await post("/api/cards", { ...planned, components: [...planned.components, { componentId: "task-group", type: "amo.task-group", schemaVersion: 1, data: { groupId } }] })).json();
  await post(`/api/cards/${card.cardId}/commands`, { operationId: "archive", expectedRevision: card.revision, commands: [{ type: "archive" }] });
  assert.equal((await read("/api/focus-panel")).cards.length, 0);
  const all = await read("/api/focus-panel?includeArchived=1");
  assert.equal(all.cards.length, 1);
  assert.equal(all.cards[0].groupId, groupId);
  assert.ok(all.cards[0].archivedAt);
  assert.deepEqual(all.groups, groups.groups);
  assert.equal(all.groupRevision, groups.revision);
});

test("generic create/get/commands and Focus facade share materialized data and durable replay", async (t) => {
  const { post, read } = await fixture(t);
  const createdResponse = await post("/api/cards", planned);
  assert.equal(createdResponse.status, 200);
  const { card } = await createdResponse.json();
  assert.equal(card.components[0].data.attention.generation, 0);
  assert.equal((await read("/api/cards")).schemaVersion, 1);
  assert.deepEqual((await read(`/api/cards/${card.cardId}`)).card, card);
  const focus = await read("/api/focus-panel");
  assert.equal(focus.schemaVersion, 2);
  assert.equal(focus.cards[0].session, null);
  assert.equal(focus.cards[0].conversation, null);
  const request = { operationId: "focus-note", expectedRevision: card.revision, action: "set-triage", note: "Use core notes interface" };
  const saved = await (await post(`/api/focus-panel/cards/${card.cardId}`, request)).json();
  assert.equal(saved.card.triage.note, "Use core notes interface");
  assert.equal((await read(`/api/cards/${card.cardId}`)).card.components.find((c) => c.type === "amo.notes").data.text, "Use core notes interface");
  assert.deepEqual(await (await post(`/api/focus-panel/cards/${card.cardId}`, request)).json(), saved);
  assert.equal((await post(`/api/cards/${card.cardId}/commands`, { operationId: "focus-note", expectedRevision: card.revision, commands: [{ type: "archive" }] })).status, 409);
});

test("atomic interfaces rename/archive/restore and invalid batches return conflicts or validation errors", async (t) => {
  const { post, read } = await fixture(t);
  let { card } = await (await post("/api/cards", planned)).json();
  const endpoint = `/api/cards/${card.cardId}/commands`;
  const oldRevision = card.revision;
  const saved = await post(endpoint, { operationId: "batch", expectedRevision: card.revision, commands: [{ type: "set-title", title: "Renamed" }, { type: "archive" }] });
  card = (await saved.json()).card;
  assert.equal(card.title, "Renamed");
  assert.equal((await read("/api/focus-panel")).cards.length, 0);
  assert.equal((await read("/api/cards")).cards.length, 1);
  assert.equal((await post(endpoint, { operationId: "stale", expectedRevision: oldRevision, commands: [{ type: "restore" }] })).status, 409);
  assert.equal((await post(endpoint, { operationId: "invalid", expectedRevision: card.revision, commands: [{ type: "set-title", title: "Must rollback" }, { type: "set-component", component: { componentId: "chat", type: "amo.conversation", schemaVersion: 1, data: { sessionComponentId: "missing" } } }] })).status, 400);
  assert.equal((await read(`/api/cards/${card.cardId}`)).card.title, "Renamed");
  const restored = await post(endpoint, { operationId: "restore", expectedRevision: card.revision, commands: [{ type: "restore" }] });
  assert.equal(restored.status, 200);
  assert.equal((await read("/api/focus-panel")).cards.length, 1);
});

test("all Card mutation interfaces enforce JSON/origin and reject protected attention injection", async (t) => {
  const { post } = await fixture(t);
  for (const origin of ["https://evil.example", "null", "http://localhost:9999", "http://tauri.localhost.evil.example"]) assert.equal((await post("/api/cards", planned, { origin })).status, 403);
  assert.equal((await post("/api/cards", planned, { "content-type": "text/plain" })).status, 400);
  const { card } = await (await post("/api/cards", planned, { origin: "http://127.0.0.1:1420", "content-type": "application/json; charset=utf-8" })).json();
  const endpoint = `/api/cards/${card.cardId}/commands`;
  const request = { operationId: "edit", expectedRevision: card.revision, commands: [{ type: "archive" }] };
  assert.equal((await post(endpoint, request, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post(`/api/focus-panel/cards/${card.cardId}`, { operationId: "focus", expectedRevision: card.revision, action: "handle", throughGeneration: 0 }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post(endpoint, { ...request, commands: [{ type: "set-component", component: { ...planned.components[0], data: { ...planned.components[0].data, handledGeneration: 99 } } }] })).status, 400);
  for (const type of ["constructor", "toString", "__proto__"]) assert.equal((await post(endpoint, { ...request, commands: [{ type }] })).status, 400);
});
