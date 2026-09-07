const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { handleTaskCanvasRoutes } = require("../routes/task-canvas");
const { createTaskCanvasStore } = require("./task-canvas-store");
const { sendJson } = require("./http");

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "amo-canvas-http-"));
  const sessions = new Map([["live exact", { sessionId: "live exact", state: "working" }], ["archived", { sessionId: "archived", archivedAt: "2026-01-01" }], ["live exact suffix", { sessionId: "live exact suffix" }]]);
  const context = { taskCanvasStore: createTaskCanvasStore({ dataFile: path.join(directory, "board.json") }), sessions, decorateSession: (session) => ({ ...session, decorated: true }) };
  const server = http.createServer(async (req, res) => {
    try {
      if (!await handleTaskCanvasRoutes(req, res, new URL(req.url, "http://localhost"), context)) sendJson(res, 404, {});
    } catch (error) { sendJson(res, error.statusCode || 500, { error: error.code }); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${server.address().port}`, context };
}
const payload = { operationId: "http-save", expectedRevision: 0, document: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } };
test("HTTP save/read/replay and stale or reused-operation conflicts", async (t) => {
  const { base } = await fixture(t);
  const save = (value) => fetch(`${base}/api/task-canvas`, { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:1420" }, body: JSON.stringify(value) });
  assert.equal((await (await fetch(`${base}/api/task-canvas`)).json()).board.revision, 0);
  const committed = await (await save(payload)).json();
  assert.equal(committed.board.revision, 1);
  assert.deepEqual(await (await save(payload)).json(), committed);
  assert.equal((await save({ ...payload, operationId: "stale" })).status, 409);
  assert.equal((await save({ ...payload, expectedRevision: 1 })).status, 409);
  assert.equal((await save({ ...payload, document: null })).status, 400);
});
test("write origin and JSON checks block browser form and foreign-origin writes", async (t) => {
  const { base, context } = await fixture(t);
  for (const origin of ["https://attacker.example", "null", "http://localhost:9999", "http://127.0.0.1:1420.attacker.example"]) {
    const response = await fetch(`${base}/api/task-canvas`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(payload) });
    assert.equal(response.status, 403);
  }
  assert.equal((await fetch(`${base}/api/task-canvas`, { method: "POST", body: JSON.stringify(payload) })).status, 400);
  assert.equal(context.taskCanvasStore.getBoard().revision, 0);
  assert.equal((await fetch(`${base}/api/task-canvas`, { method: "POST", headers: { origin: "http://tauri.localhost", "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(payload) })).status, 200);
});
test("exact decorated session references include archived and omit missing without mutation", async (t) => {
  const { base, context } = await fixture(t);
  const response = await fetch(`${base}/api/task-canvas/sessions?ids=live%20exact,archived,missing,archived`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.sessions.map((s) => s.sessionId), ["live exact", "archived"]);
  assert.ok(body.sessions.every((s) => s.decorated));
  assert.equal(context.sessions.size, 3);
  context.sessions.set("comma,id+plus", { sessionId: "comma,id+plus" });
  const encoded = await (await fetch(`${base}/api/task-canvas/sessions?ids=comma%2Cid%2Bplus,live+exact`)).json();
  assert.deepEqual(encoded.sessions.map((s) => s.sessionId), ["comma,id+plus", "live exact"]);
  assert.equal((await fetch(`${base}/api/task-canvas/sessions?ids=%ZZ`)).status, 400);
  assert.equal((await fetch(`${base}/api/task-canvas/sessions?ids=${Array(501).fill("a").join(",")}`)).status, 400);
  assert.equal((await fetch(`${base}/api/task-canvas/sessions?ids=a&ids=b`)).status, 400);
  assert.deepEqual(await (await fetch(`${base}/api/task-canvas/sessions?ids=`)).json(), { sessions: [] });
});
