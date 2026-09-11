const test = require("node:test");
const assert = require("node:assert/strict");
const { SessionCollection } = require("./session-collection");

test("observer sees set/delete/clear while preserving Map returns, stamps and counts", () => {
  const sessions = new SessionCollection();
  const events = [];
  const stop = sessions.observe((event) => events.push(event));
  const one = { sessionId: "one" };
  assert.equal(sessions.set("one", one), sessions);
  assert.equal(one.sessionRevision, 1);
  assert.equal(one.brokerInstanceId, sessions.brokerInstanceId);
  const archived = { sessionId: "one", archivedAt: "date" };
  sessions.set("one", archived);
  assert.equal(events[1].previous, one);
  assert.deepEqual(sessions.counts, { active: 0, archived: 1, total: 1 });
  assert.equal(sessions.delete("missing"), false);
  assert.equal(sessions.delete("one"), true);
  sessions.set("two", { sessionId: "two" });
  assert.equal(sessions.clear(), undefined);
  assert.deepEqual(events.map((event) => event.type), ["set", "set", "delete", "set", "clear"]);
  assert.equal(events.at(-1).sessions[0].sessionId, "two");
  assert.deepEqual(sessions.counts, { active: 0, archived: 0, total: 0 });
  stop();
  sessions.set("three", { sessionId: "three" });
  assert.equal(events.length, 5);
});

test("failing observer cannot break legacy writers or later observers", () => {
  const sessions = new SessionCollection();
  let observed = 0;
  sessions.observe(() => { throw new Error("observer failure"); });
  sessions.observe(() => { observed += 1; });
  assert.doesNotThrow(() => sessions.set("one", { sessionId: "one" }));
  assert.equal(observed, 1);
  assert.equal(sessions.size, 1);
});
