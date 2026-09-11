import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const vite = await createServer({ appType: "custom", configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false } });
const { regionPayload, intersectRect } = await vite.ssrLoadModule("/src/focus/inputRegions.ts");
after(() => vite.close());
test("interactive surfaces clip to viewport without enlarging the gap between them", () => {
  const payload = regionPayload([{ x: -3, y: 4, width: 20, height: 10 }, { x: 90, y: 10, width: 30, height: 15 }], 100, 80);
  assert.equal(payload.mode, "regions");
  assert.deepEqual(payload.rects, [{ x: 0, y: 4, width: 17, height: 10 }, { x: 90, y: 10, width: 10, height: 15 }]);
  assert.equal(payload.rects.some(rect => 50 >= rect.x && 50 < rect.x + rect.width), false);
});
test("clipped scroll content never captures the viewport beyond the scroller", () => {
  assert.deepEqual(intersectRect({ x: 15, y: 65, width: 60, height: 40 }, { x: 10, y: 30, width: 80, height: 50 }), { x: 15, y: 65, width: 60, height: 15 });
  assert.equal(intersectRect({ x: 0, y: -80, width: 60, height: 40 }, { x: 10, y: 30, width: 80, height: 50 }), null);
});
test("drag or modal capture restores full window and invalid/empty geometry fails open", () => {
  const rects = [{ x: 0, y: 0, width: 30, height: 20 }];
  assert.deepEqual(regionPayload(rects, 100, 80, true), { mode: "full", viewportWidth: 100, viewportHeight: 80, rects: [] });
  assert.equal(regionPayload([{ x: NaN, y: 0, width: 20, height: 20 }], 100, 80).mode, "full");
  assert.equal(regionPayload([], 100, 80).mode, "full");
});
test("region payload bounds count and rounds outward for scaled UI edges", () => {
  assert.deepEqual(regionPayload([{ x: 0.6, y: 0.2, width: 10.6, height: 5.2 }], 100, 80).rects, [{ x: 0, y: 0, width: 12, height: 6 }]);
  assert.equal(regionPayload(Array.from({ length: 513 }, (_, i) => ({ x: i * 2, y: 1, width: 1, height: 1 })), 2000, 80).mode, "full");
});
