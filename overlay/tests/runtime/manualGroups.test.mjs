import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";
const vite = await createServer({ appType: "custom", configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false } });
const { manualLanes, cardsInGroup, groupCommand } = await vite.ssrLoadModule("/src/focus/manualGroups.ts");
const { loadFocusCards } = await vite.ssrLoadModule("/src/api/focusPanelClient.ts");
after(() => vite.close());
const groups = [{ groupId: "g1", name: "My review", dragOnly: false }, { groupId: "g2", name: "Done", dragOnly: true }];
const card = (id, groupId, extra = {}) => ({ cardId: id, groupId, archivedAt: null, createdAt: "2026-09-11T01:00:00Z", updatedAt: "2026-09-11T01:00:00Z", ...extra });
test("manual groups ignore processing state, attention, title and update recency", () => {
  const first = card("a", "g2", { triage: { state: "pending" }, attention: { hasUnseen: true } });
  const second = card("b", "g2", { updatedAt: "2099-01-01", triage: { state: "handled" } });
  assert.deepEqual(cardsInGroup([second, first], "g2", groups).map(c => c.cardId), ["a", "b"]);
  assert.deepEqual(cardsInGroup([first], "g1", groups), []);
  assert.equal(manualLanes(groups, [first])[1].dragOnly, true);
});
test("all-groups list includes archived cards and ungrouped fallback without inventing group identities", () => {
  const cards = [card("a", "g2", { archivedAt: "2026-09-11" }), card("b", null), card("c", "deleted")];
  assert.equal(cardsInGroup(cards, "g2", groups).length, 0);
  assert.equal(cardsInGroup(cards, "g2", groups, true).length, 1);
  assert.deepEqual(cardsInGroup(cards, null, groups).map(c => c.cardId), ["b", "c"]);
  assert.deepEqual(manualLanes(groups, cards).map(g => g.groupId), ["g1", "g2", null]);
});
test("manual move only updates its component; no processing or Session mutation", () => {
  const core = { components: [{ componentId: "source", type: "amo.session", schemaVersion: 1, data: { sessionRef: { frameworkId: "codex", sessionId: "s" } } }, { componentId: "membership", type: "amo.task-group", schemaVersion: 1, data: { groupId: "g1" } }] };
  const before = JSON.stringify(core);
  assert.deepEqual(groupCommand(core, "g2"), { type: "set-component", component: { componentId: "membership", type: "amo.task-group", schemaVersion: 1, data: { groupId: "g2" } } });
  assert.equal(JSON.stringify(core), before);
});
test("manual Focus requires matching group-capable broker and includes archived query", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async url => { assert.ok(url.endsWith("?includeArchived=1")); return { ok: true, json: async () => ({ schemaVersion: 2, cards: [], groups, groupRevision: 2 }) }; };
    assert.equal((await loadFocusCards()).groups[1].dragOnly, true);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 2, cards: [] }) });
    await assert.rejects(loadFocusCards(), /does not support manual Task groups/);
  } finally { globalThis.fetch = original; }
});
