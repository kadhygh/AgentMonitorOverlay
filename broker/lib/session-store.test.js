const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createSessionStore } = require("./session-store");

function createTestStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amo-session-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return createSessionStore({
    dataFile: path.join(root, "sessions.json"),
  });
}

test("clearing archive dismisses only archived sessions", (t) => {
  const store = createTestStore(t);
  store.sessions.set("active-codex", {
    sessionId: "active-codex",
    tool: "codex",
    title: "Active Codex",
    updatedAt: "2026-07-18T00:00:00.000Z",
  });
  store.sessions.set("archived-claude", {
    sessionId: "archived-claude",
    tool: "claude",
    title: "Archived Claude",
    archivedAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
  });
  store.sessions.set("archived-codex", {
    sessionId: "archived-codex",
    tool: "codex",
    title: "Archived Codex",
    archivedAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  });

  const result = store.dismissArchivedSessions({ reason: "test" });

  assert.equal(result.count, 2);
  assert.deepEqual(new Set(result.sessionIds), new Set(["archived-claude", "archived-codex"]));
  assert.equal(store.sessions.has("active-codex"), true);
  assert.equal(store.sessions.has("archived-claude"), false);
  assert.equal(store.sessions.has("archived-codex"), false);
});

test("priority updates persist across archive revival and snapshot reload", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amo-session-priority-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataFile = path.join(root, "sessions.json");
  const store = createSessionStore({ dataFile });
  store.sessions.set("focus-session", {
    sessionId: "focus-session",
    tool: "codex",
    title: "Focus session",
    state: "idle",
    updatedAt: "2026-07-24T00:00:00.000Z",
  });

  store.updateSessionPriorities({ sessionIds: ["focus-session"], priority: "focus" });
  store.archiveSession("focus-session", { reason: "test" });
  store.upsertSessionFromEvent({
    sessionId: "focus-session",
    tool: "codex",
    event: "UserPromptSubmit",
    state: "running",
  });
  store.persistSnapshot();

  const restored = createSessionStore({ dataFile });
  restored.loadSnapshot();
  assert.equal(restored.sessions.get("focus-session").priority, "focus");
  assert.equal(restored.sessions.get("focus-session").archivedAt, null);
});

test("priority sorting precedes persisted manual display order", (t) => {
  const store = createTestStore(t);
  for (const [sessionId, displayOrder] of [["later", 0], ["focus-b", 1], ["focus-a", 2], ["none", 3]]) {
    store.sessions.set(sessionId, {
      sessionId,
      tool: "codex",
      title: sessionId,
      displayOrder,
      priority: sessionId.startsWith("focus") ? "focus" : sessionId === "later" ? "later" : null,
      updatedAt: "2026-07-24T00:00:00.000Z",
    });
  }

  store.updateSessionDisplayOrder({ sessionIds: ["focus-a", "focus-b", "later", "none"] });
  assert.deepEqual(store.listSessions().map((session) => session.sessionId), ["focus-a", "focus-b", "later", "none"]);
});

test("batch priority update validates values and supports clearing", (t) => {
  const store = createTestStore(t);
  store.sessions.set("one", { sessionId: "one", tool: "codex", title: "One", updatedAt: "2026-07-24T00:00:00.000Z" });
  store.sessions.set("two", { sessionId: "two", tool: "claude", title: "Two", updatedAt: "2026-07-24T00:00:00.000Z" });

  assert.throws(
    () => store.updateSessionPriorities({ sessionIds: ["one"], priority: "urgent" }),
    (error) => error.code === "invalid_priority",
  );
  store.updateSessionPriorities({ sessionIds: ["one", "two"], priority: "next" });
  const result = store.updateSessionPriorities({ sessionIds: ["one", "two"], priority: null });

  assert.equal(result.count, 2);
  assert.equal(store.sessions.get("one").priority, null);
  assert.equal(store.sessions.get("two").priority, null);
});