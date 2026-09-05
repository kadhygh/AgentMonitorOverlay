const assert = require("node:assert/strict");
const test = require("node:test");
const { createSessionSummary, querySessions } = require("./session-query");

const sessions = [
  { sessionId: "active-a", updatedAt: "3", transcriptPath: "large.jsonl", lastPromptHash: "hash" },
  { sessionId: "archived-a", updatedAt: "2", archivedAt: "2026-01-01" },
  { sessionId: "archived-b", updatedAt: "1", archivedAt: "2026-01-01" },
];

test("active scope is the default and reports archive counts without archive rows", () => {
  const result = querySessions(sessions);
  assert.deepEqual(result.sessions.map((session) => session.sessionId), ["active-a"]);
  assert.deepEqual(result.counts, { active: 1, archived: 2, total: 3 });
  assert.equal(result.sessions[0].transcriptPath, undefined);
});

test("archive scope paginates and advertises more rows", () => {
  const result = querySessions(sessions, new URLSearchParams("scope=archived&offset=0&limit=1"));
  assert.equal(result.sessions.length, 1);
  assert.equal(result.total, 2);
  assert.equal(result.hasMore, true);
});

test("detail summaries omit internal transcript fields but preserve card fields", () => {
  const summary = createSessionSummary({
    sessionId: "one",
    pendingPrompt: "copy me",
    windowHint: { hwnd: 42 },
    transcriptPath: "private.jsonl",
    hookEvents: ["Stop"],
  });
  assert.equal(summary.pendingPrompt, "copy me");
  assert.equal(summary.windowHint.hwnd, 42);
  assert.equal(summary.transcriptPath, undefined);
  assert.equal(summary.hookEvents, undefined);
});

test("complete active snapshots include hundreds of cards without changing paginated queries", () => {
  const records = Array.from({ length: 350 }, (_, index) => ({ sessionId: `session-${index}` }));
  assert.equal(querySessions(records).sessions.length, 200);
  const snapshot = querySessions(records, new URLSearchParams("scope=active&snapshot=1"));
  assert.equal(snapshot.sessions.length, 350);
  assert.equal(snapshot.hasMore, false);
  assert.equal(snapshot.counts.active, 350);
});
