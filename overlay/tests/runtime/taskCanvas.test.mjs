import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({ appType: "custom", configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false } });
const { zoomAt, worldPoint, visibleNode, removeNode, connectNodes, emptyDocument } = await vite.ssrLoadModule("/src/canvas/model.ts");
const { loadCanvasSessions, saveCanvas, CanvasRequestError } = await vite.ssrLoadModule("/src/api/taskCanvasClient.ts");
after(() => vite.close());
const node = (id, sessionId = "shared") => ({ id, kind: "task", sessionId, x: 0, y: 0, width: 280, height: 180 });

test("zoom preserves the world point under the cursor, including clamp bounds", () => {
  const initial = { x: -100, y: 45, zoom: .8 };
  for (const zoom of [.01, .6, 1.5, 8]) {
    const next = zoomAt(initial, 349, 201, zoom);
    const before = worldPoint(349, 201, initial), after = worldPoint(349, 201, next);
    assert.ok(Math.abs(before.x - after.x) < 1e-9); assert.ok(Math.abs(before.y - after.y) < 1e-9);
    assert.ok(next.zoom >= .2 && next.zoom <= 2);
  }
});
test("viewport culling includes partially visible cards at negative coordinates", () => {
  assert.equal(visibleNode({ ...node("a"), x: -250 }, { x: 0, y: 0, zoom: 1 }, 800, 600), true);
  assert.equal(visibleNode({ ...node("a"), x: -600 }, { x: 0, y: 0, zoom: 1 }, 800, 600), false);
  assert.equal(visibleNode({ ...node("a"), x: 1200 }, { x: -600, y: 0, zoom: .5 }, 800, 600), true);
});
test("duplicate references have independent geometry and remove only their own incident edges", () => {
  const doc = { ...emptyDocument(), nodes: [node("a"), node("b"), node("c", "other")] };
  const linked = connectNodes(connectNodes(doc, "a", "c", "ac"), "b", "c", "bc");
  const result = removeNode(linked, "a");
  assert.deepEqual(result.nodes.map(n => n.id), ["b", "c"]); assert.deepEqual(result.edges.map(e => e.id), ["bc"]);
  assert.equal(doc.nodes.length, 3); assert.equal(linked.edges.length, 2);
});
test("directed links reject self links, nonexistent endpoints and duplicate pairs", () => {
  const doc = { ...emptyDocument(), nodes: [node("a"), node("b")] };
  const linked = connectNodes(doc, "a", "b", "ab");
  assert.equal(connectNodes(linked, "a", "b", "duplicate"), linked);
  assert.equal(connectNodes(doc, "a", "a", "self"), doc);
  assert.equal(connectNodes(doc, "a", "missing", "dangling"), doc);
  assert.equal(connectNodes(linked, "b", "a", "reverse").edges.length, 2);
  const full = { ...doc, edges: Array.from({ length: 1000 }, (_, i) => ({ id: String(i), source: "a", target: "b" })) };
  assert.equal(connectNodes(full, "b", "a", "extra"), full);
});
test("exact reference requests split large URLs and encode comma IDs", async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async url => { calls.push(url); return { ok: true, json: async () => ({ sessions: [{ sessionId: String(calls.length) }] }) }; };
  try {
    const ids = ["comma,id", ...Array.from({ length: 500 }, (_, i) => `${i}-${"x".repeat(80)}`)];
    const result = await loadCanvasSessions(ids);
    assert.ok(calls.length > 1); assert.ok(calls.every(url => url.length < 6100));
    assert.ok(calls[0].includes("comma%2Cid")); assert.equal(result.sessions.length, calls.length);
  } finally { globalThis.fetch = original; }
});
test("save reports revision conflict without modifying the caller's draft", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ message: "conflict" }) });
  try {
    const doc = { ...emptyDocument(), nodes: [node("a")] }, before = JSON.stringify(doc);
    await assert.rejects(saveCanvas("operation", 3, doc), error => error instanceof CanvasRequestError && error.status === 409);
    assert.equal(JSON.stringify(doc), before);
  } finally { globalThis.fetch = original; }
});
