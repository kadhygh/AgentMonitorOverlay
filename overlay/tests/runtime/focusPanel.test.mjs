import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";
const vite = await createServer({ appType: "custom", configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false } });
const { mergeCard, mergeSnapshot, filterCards, commandAvailable, createOperation } = await vite.ssrLoadModule("/src/focus/model.ts");
const { updateFocusCard, loadFocusCards, FocusRequestError } = await vite.ssrLoadModule("/src/api/focusPanelClient.ts");
const { plannedCardOperation, createCard: createGenericCard } = await vite.ssrLoadModule("/src/api/cardClient.ts");
after(() => vite.close());
const card = (id = "one", revision = 1) => ({ schemaVersion: 2, cardId: id, revision, title: "Plan auth", createdAt: "2026-09-11", updatedAt: "2026-09-11", triage: { state: "pending", note: "Saved note", handledGeneration: 0 }, attention: { generation: 3, kind: "reply", hasUnseen: true, updatedAt: "2026-09-11" }, session: { componentId: "s1", sessionRef: { frameworkId: "codex", sessionId: "session" }, workspaceId: "workspace", workspacePath: "C:/Projects/Website", presence: "live", execution: "idle" }, conversation: { componentId: "c1", sessionComponentId: "s1", surface: "cli", bindingKind: "window", availability: "online", capabilities: { activate: true, resume: true } } });

test("late snapshot and replay result cannot regress a newer card", () => {
  const newest = card("one", 7), old = card("one", 4);
  assert.equal(mergeCard([newest], old)[0], newest);
  assert.equal(mergeSnapshot([newest], [old])[0], newest);
  assert.equal(mergeSnapshot([old], [newest])[0], newest);
});
test("queue filtering keeps unseen future tasks deferred and searches workspace/provider", () => {
  const future = { ...card("future"), triage: { ...card().triage, state: "future" } };
  const archived = { ...card("archived"), session: { ...card().session, presence: "archived" } };
  assert.deepEqual(filterCards([future, archived], "pending", "").map(c => c.cardId), ["archived"]);
  assert.deepEqual(filterCards([future, archived], "future", "website").map(c => c.cardId), ["future"]);
  assert.equal(filterCards([future, archived], "all", "codex").length, 2);
  assert.equal(filterCards([future, archived], "all", "unmatched").length, 0);
});
test("detached and unknown framework actions stay disabled despite capability flags", () => {
  assert.equal(commandAvailable(card(), "activate"), true);
  assert.equal(commandAvailable({ ...card(), session: { ...card().session, presence: "detached" } }, "activate"), false);
  assert.equal(commandAvailable({ ...card(), session: { ...card().session, sessionRef: { frameworkId: "unknown", sessionId: "session" } } }, "resume"), false);
  assert.equal(commandAvailable({ ...card(), conversation: { ...card().conversation, capabilities: { activate: false, resume: true } } }, "activate"), false);
});
test("independent cards need no runtime projections for searching, notes or handling", () => {
  const independent = { ...card(), session: null, conversation: null, attention: { ...card().attention, generation: 0, hasUnseen: false, kind: null } };
  assert.equal(filterCards([independent], "pending", "plan").length, 1);
  assert.equal(commandAvailable(independent, "activate"), false);
  assert.equal(createOperation(independent, "handle", "handle-plan").throughGeneration, 0);
  assert.equal(createOperation(independent, "set-triage", "later-plan", { state: "later" }).state, "later");
});
test("mismatched conversation cannot activate another related session and GUI cannot resume CLI", () => {
  const mismatched = { ...card(), conversation: { ...card().conversation, sessionComponentId: "other-session" } };
  assert.equal(commandAvailable(mismatched, "activate"), false);
  const app = { ...card(), conversation: { ...card().conversation, surface: "app" } };
  assert.equal(commandAvailable(app, "activate"), true); assert.equal(commandAvailable(app, "resume"), false);
  assert.equal(commandAvailable({ ...card(), conversation: { ...card().conversation, surface: "unbound" } }, "resume"), true);
  assert.equal(commandAvailable({ ...card(), conversation: null }, "activate"), false);
});
test("authoritative Focus snapshot removes archived cards or removed processing components", () => {
  assert.deepEqual(mergeSnapshot([card()], []), []);
});
test("planned-card creation uses independent typed components and exact replay", async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, body: options.body }); if (calls.length === 1) throw new TypeError("lost response"); return { ok: true, json: async () => ({ card: { cardId: "opaque-new-card" } }) }; };
  try {
    const operation = plannedCardOperation("create-op", "  New plan  ", "A note", "processing-id", "notes-id");
    assert.equal(operation.title, "New plan"); assert.equal(operation.components.length, 2);
    assert.deepEqual(operation.components[0].data, { sourceComponentId: null, state: "pending" });
    assert.deepEqual(operation.components[1].data, { text: "A note" });
    assert.equal(operation.components.some(c => c.type === "amo.session"), false);
    await assert.rejects(createGenericCard(operation));
    const result = await createGenericCard(operation);
    assert.equal(result.card.cardId, "opaque-new-card"); assert.equal(calls[0].body, calls[1].body);
    assert.ok(calls[0].url.endsWith("/api/cards"));
  } finally { globalThis.fetch = original; }
});
test("handle binds the displayed revision and observed generation without acknowledging later updates", () => {
  const observed = card("one", 6);
  const request = createOperation(observed, "handle", "fixed-operation");
  observed.attention.generation = 4; observed.revision = 7;
  assert.deepEqual(request, { operationId: "fixed-operation", action: "handle", expectedRevision: 6, throughGeneration: 3 });
});
test("note-only save on a handled card preserves state and immutable draft revision", () => {
  const handled = { ...card(), triage: { ...card().triage, state: "handled" } };
  const draft = { text: "My local edit", baseRevision: 2, baseNote: "Original" };
  const request = createOperation(handled, "set-triage", "note", { draft });
  draft.text = "New edit";
  assert.equal(request.note, "My local edit"); assert.equal(request.expectedRevision, 2);
  assert.equal("state" in request, false); assert.equal("throughGeneration" in request, false);
});
test("failed request can retry its exact operation body and encodes card IDs", async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, body: options.body }); if (calls.length === 1) throw new TypeError("network lost"); return { ok: true, json: async () => ({ card: card() }) }; };
  try {
    const operation = createOperation(card(), "handle", "same-id");
    await assert.rejects(updateFocusCard("id/with space", operation));
    await updateFocusCard("id/with space", operation);
    assert.equal(calls[0].body, calls[1].body); assert.ok(calls[0].url.endsWith("id%2Fwith%20space"));
  } finally { globalThis.fetch = original; }
});
test("409 is a typed conflict and preserves caller note contents", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: "conflict" }) });
  try {
    const operation = createOperation(card(), "set-triage", "id", { draft: { text: "keep me", baseRevision: 1, baseNote: "" } });
    await assert.rejects(updateFocusCard("one", operation), e => e instanceof FocusRequestError && e.status === 409);
    assert.equal(operation.note, "keep me");
  } finally { globalThis.fetch = original; }
});
test("hidden-window cancellation reaches the broker fetch", async () => {
  const original = globalThis.fetch, controller = new AbortController();
  globalThis.fetch = async (_url, options) => { assert.equal(options.signal.aborted, true); throw new DOMException("Aborted", "AbortError"); };
  try { controller.abort(); await assert.rejects(loadFocusCards(controller.signal), e => e.name === "AbortError"); }
  finally { globalThis.fetch = original; }
});
test("obsolete flat Focus payload is rejected rather than mislabeled as independent cards", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1, cards: [] }) });
  try { await assert.rejects(loadFocusCards(), /unsupported Focus view/); }
  finally { globalThis.fetch = original; }
});
