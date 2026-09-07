const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createTaskCanvasStore, validateDocument, writeSnapshot } = require("./task-canvas-store");

const document = () => ({ nodes: [{ id: "note-1", kind: "note", text: "Draft", x: 10, y: 20, width: 200, height: 100 }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "amo-canvas-store-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "task-canvas.json");
}
const request = (operationId, expectedRevision) => ({ operationId, expectedRevision, document: document() });

test("durable board and historical operation replay survive restart without aliasing", async (t) => {
  const dataFile = fixture(t);
  const store = createTaskCanvasStore({ dataFile });
  assert.equal(store.getBoard().revision, 0);
  const first = await store.commit(request("first", 0));
  await store.commit(request("second", 1));
  first.document.nodes[0].text = "Modified by caller";
  const restarted = createTaskCanvasStore({ dataFile });
  assert.equal(restarted.getBoard().revision, 2);
  const replay = await restarted.commit(request("first", 0));
  assert.equal(replay.revision, 1);
  assert.equal(replay.document.nodes[0].text, "Draft");
  assert.equal(restarted.getBoard().revision, 2);
  await assert.rejects(restarted.commit(request("first", 2)), { statusCode: 409, code: "task_canvas_operation_conflict" });
});

test("concurrent commits serialize, conflict, and identical requests replay", async (t) => {
  const store = createTaskCanvasStore({ dataFile: fixture(t) });
  const results = await Promise.allSettled([store.commit(request("a", 0)), store.commit(request("b", 0)), store.commit(request("a", 0))]);
  assert.equal(results[0].value.revision, 1);
  assert.equal(results[1].reason.statusCode, 409);
  assert.deepEqual(results[2].value, results[0].value);
  assert.equal(store.getBoard().revision, 1);
});

test("failed persistence exposes no uncommitted state and retry survives restart", async (t) => {
  const dataFile = fixture(t);
  let fail = false;
  const store = createTaskCanvasStore({ dataFile, write: async (file, snapshot) => {
    if (fail) throw new Error("injected disk failure");
    await writeSnapshot(file, snapshot);
  } });
  await store.commit(request("a", 0));
  const before = fs.readFileSync(dataFile, "utf8");
  fail = true;
  await assert.rejects(store.commit(request("b", 1)), { code: "task_canvas_write_failed" });
  assert.equal(store.getBoard().revision, 1);
  assert.equal(fs.readFileSync(dataFile, "utf8"), before);
  assert.equal(createTaskCanvasStore({ dataFile }).getBoard().revision, 1);
  fail = false;
  assert.equal((await store.commit(request("b", 1))).revision, 2);
});

test("pending disk acknowledgement leaves reads on last committed board", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const store = createTaskCanvasStore({ dataFile: fixture(t), write: async (file, snapshot) => { await gate; await writeSnapshot(file, snapshot); } });
  const payload = request("a", 0);
  const pending = store.commit(payload);
  payload.document.nodes[0].text = "outside mutation";
  await Promise.resolve();
  assert.equal(store.getBoard().revision, 0);
  release();
  assert.equal((await pending).document.nodes[0].text, "Draft");
});

test("atomic replacement failure cleans the flushed temporary file", async (t) => {
  const dataFile = fixture(t);
  fs.mkdirSync(dataFile);
  fs.writeFileSync(path.join(dataFile, "preserved"), "original");
  await assert.rejects(writeSnapshot(dataFile, { value: "replacement" }));
  assert.equal(fs.readFileSync(path.join(dataFile, "preserved"), "utf8"), "original");
  assert.deepEqual(fs.readdirSync(path.dirname(dataFile)), ["task-canvas.json"]);
});

test("stored ledger fingerprint corruption blocks subsequent writes", async (t) => {
  const dataFile = fixture(t);
  await createTaskCanvasStore({ dataFile }).commit(request("a", 0));
  const snapshot = JSON.parse(fs.readFileSync(dataFile));
  snapshot.operations[0].fingerprint = "0".repeat(64);
  fs.writeFileSync(dataFile, JSON.stringify(snapshot));
  const restarted = createTaskCanvasStore({ dataFile });
  assert.throws(() => restarted.getBoard(), { code: "task_canvas_storage_error" });
  await assert.rejects(restarted.commit(request("b", 1)), { code: "task_canvas_storage_error" });
});

test("operation ledger is bounded and evicted old requests cannot overwrite", async (t) => {
  const dataFile = fixture(t);
  const store = createTaskCanvasStore({ dataFile });
  for (let revision = 0; revision < 35; revision += 1) await store.commit(request(`op-${revision}`, revision));
  assert.equal(JSON.parse(fs.readFileSync(dataFile)).operations.length, 32);
  const restarted = createTaskCanvasStore({ dataFile });
  await assert.rejects(restarted.commit(request("op-0", 0)), { code: "task_canvas_revision_conflict" });
  assert.equal((await restarted.commit(request("op-34", 34))).revision, 35);
});

test("corrupt storage is visible and cannot be overwritten", async (t) => {
  const dataFile = fixture(t);
  for (const contents of ["{bad", JSON.stringify({ board: {}, operations: [] })]) {
    fs.writeFileSync(dataFile, contents);
    const store = createTaskCanvasStore({ dataFile });
    assert.throws(() => store.getBoard(), { code: "task_canvas_storage_error" });
    await assert.rejects(store.commit(request("a", 0)), { code: "task_canvas_storage_error" });
    assert.equal(fs.readFileSync(dataFile, "utf8"), contents);
  }
});

test("strict graph validation rejects malformed shapes, bounds, and relationships", () => {
  const cases = [
    (d) => { d.extra = true; },
    (d) => { d.nodes[0].x = Infinity; },
    (d) => { d.nodes[0].height = 0; },
    (d) => { d.nodes[0].x = 1000001; },
    (d) => { d.nodes[0].id = ""; },
    (d) => { d.nodes[0].text = "x".repeat(4001); },
    (d) => { d.nodes[0].sessionId = "session"; },
    (d) => { d.nodes[0].kind = "task"; delete d.nodes[0].text; },
    (d) => { d.nodes.push({ ...d.nodes[0] }); },
    (d) => { d.nodes = Array.from({ length: 501 }, (_, id) => ({ ...d.nodes[0], id: String(id) })); },
    (d) => { d.viewport.zoom = 2.1; },
    (d) => { d.edges.push({ id: "e", source: "note-1", target: "missing" }); },
    (d) => { d.edges.push({ id: "e", source: "note-1", target: "note-1" }); },
    (d) => { d.nodes.push({ ...d.nodes[0], id: "two" }); d.edges = [{ id: "a", source: "note-1", target: "two" }, { id: "b", source: "note-1", target: "two" }]; },
  ];
  for (const mutate of cases) {
    const value = document();
    mutate(value);
    assert.throws(() => validateDocument(value), { statusCode: 400 });
  }
  const valid = document();
  valid.nodes.push({ id: "task-1", kind: "task", sessionId: "archived-session", x: -10, y: 0, width: 100, height: 200 });
  valid.edges.push({ id: "edge-1", source: "note-1", target: "task-1" });
  assert.deepEqual(validateDocument(valid), valid);
});

test("malformed commit metadata never writes", async (t) => {
  const store = createTaskCanvasStore({ dataFile: fixture(t), write: () => { assert.fail("must not write"); } });
  for (const payload of [null, {}, { ...request("a", 0), expectedRevision: 0.5 }, { ...request("a", 0), extra: true }, request("", 0)]) await assert.rejects(store.commit(payload), { statusCode: 400 });
});
