const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const { createSessionStore } = require("./session-store");
const { handleSessionRoutes } = require("../routes/sessions");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amo-consistency-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const store = createSessionStore({ dataFile: path.join(root, "sessions.json"), refreshTitle: (session) => session });
  store.sessions.set("one", { sessionId: "one", tool: "codex", state: "idle", reviewRequired: true });
  return store;
}

test("mutation freshness survives out-of-order persistence and route completion", async (t) => {
  const store = fixture(t);
  let startFlush;
  let finishFlush;
  const started = new Promise((resolve) => { startFlush = resolve; });
  const finished = new Promise((resolve) => { finishFlush = resolve; });
  const req = Readable.from([Buffer.from("{}")]);
  req.method = "POST";
  let response;
  const request = handleSessionRoutes(req, { writeHead() {}, end(body) { response = JSON.parse(body); } },
    new URL("http://localhost/api/sessions/one/reviewed"), {
      ...store, persistSnapshot: () => { startFlush(); return finished; }, publishSessionChanged() {},
    });
  await started;
  const newer = store.updateHeartbeat("one", { state: "running", event: "UserPromptSubmit" });
  finishFlush();
  await request;
  assert.equal(response.session.state, "idle");
  assert.equal(newer.state, "running");
  assert.ok(response.session.sessionRevision < newer.sessionRevision);
  assert.equal(response.session.brokerInstanceId, newer.brokerInstanceId);
});

test("deletions carry freshness and later hooks receive a newer version", (t) => {
  const store = fixture(t);
  const previous = store.sessions.get("one");
  assert.deepEqual(store.sessions.counts, { active: 1, archived: 0, total: 1 });
  const removed = store.dismissSession("one").session;
  store.sessions.set("one", { sessionId: "one", state: "running" });
  assert.ok(previous.sessionRevision < removed.sessionRevision);
  assert.ok(removed.sessionRevision < store.sessions.get("one").sessionRevision);
  store.archiveSession("one");
  assert.deepEqual(store.sessions.counts, { active: 0, archived: 1, total: 1 });
  const cleared = store.dismissAllSessions();
  assert.equal(cleared.sessions.length, 1);
  assert.ok(cleared.sessions[0].dismissedAt);
  assert.deepEqual(store.sessions.counts, { active: 0, archived: 0, total: 0 });
});

test("runtime versions are excluded from disk snapshots and change across instances", async (t) => {
  const store = fixture(t);
  const raw = store.rawSessionsForSnapshot()[0];
  assert.equal(raw.sessionRevision, undefined);
  assert.equal(raw.brokerInstanceId, undefined);
  const another = fixture(t);
  assert.notEqual(store.sessions.brokerInstanceId, another.sessions.brokerInstanceId);
});
