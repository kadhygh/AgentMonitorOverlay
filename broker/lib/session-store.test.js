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