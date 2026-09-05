import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root: fileURLToPath(new URL("../..", import.meta.url)),
  optimizeDeps: { noDiscovery: true },
  server: { hmr: { port: 24681 }, middlewareMode: true },
});
const { SessionRevisionGate, createSingleFlight } = await vite.ssrLoadModule(
  "/src/runtime/sessionRevisionGate.ts",
);
const { SessionReplica } = await vite.ssrLoadModule("/src/runtime/sessionReplica.ts");
const { loadActiveSessionSnapshot } = await vite.ssrLoadModule("/src/api/sessionSnapshot.ts");

after(async () => {
  await vite.close();
});

test("older snapshots cannot replace newer SSE state", () => {
  const gate = new SessionRevisionGate();
  assert.equal(gate.observeEvent(7).accepted, true);
  assert.equal(gate.acceptSnapshot(6).accepted, false);
  assert.equal(gate.acceptSnapshot(7).accepted, true);
});

test("event gaps and duplicate events are distinguished", () => {
  const gate = new SessionRevisionGate();
  gate.acceptSnapshot(3);
  assert.equal(gate.observeEvent(5).gap, true);
  assert.equal(gate.observeEvent(5).duplicate, true);
  assert.equal(gate.observeEvent(6).gap, false);
});

test("single-flight coalesces concurrent refreshes and permits a later refresh", async () => {
  const singleFlight = createSingleFlight();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = singleFlight.run(async () => {
    calls += 1;
    await gate;
    return calls;
  });
  const second = singleFlight.run(async () => {
    calls += 1;
    return calls;
  });
  assert.equal(first, second);
  assert.equal(calls, 1);
  release();
  await first;
  await singleFlight.run(async () => {
    calls += 1;
    return calls;
  });
  assert.equal(calls, 2);
});

test("Broker restart resets sequence space and rejects retired-instance responses", () => {
  const gate = new SessionRevisionGate();
  gate.acceptSnapshot(900, "old");
  assert.equal(gate.observeInstance("new").changed, true);
  assert.equal(gate.acceptSnapshot(0, "new").accepted, true);
  assert.equal(gate.observeEvent(1, "new").accepted, true);
  assert.equal(gate.acceptSnapshot(950, "old").accepted, false);
  assert.equal(gate.observeEvent(951, "old").accepted, false);
  assert.equal(gate.current(), 1);
});

test("an in-flight snapshot from an unseen old instance cannot undo a new ready event", () => {
  const gate = new SessionRevisionGate();
  const request = gate.requestGeneration();
  gate.observeInstance("new");
  assert.equal(gate.acceptSnapshot(900, "unseen-old", request).accepted, false);
  assert.equal(gate.instance(), "new");
});

test("complete snapshots suppress delayed commands for cards deleted while disconnected", () => {
  const replica = new SessionReplica();
  replica.beginInstance("one");
  const old = { sessionId: "a", brokerInstanceId: "one", sessionRevision: 1, state: "idle" };
  replica.replace([old]);
  assert.equal(replica.acceptsSnapshot("one", 0), false);
  replica.markMissingActive([], 2);
  replica.replace([]);
  assert.deepEqual(replica.replace([old]), []);
  assert.equal(replica.replace([{ ...old, sessionRevision: 3 }]).length, 1);
});

test("replicas preserve unchanged references and reject late commands and deletions", () => {
  const replica = new SessionReplica();
  replica.beginInstance("one");
  const old = { sessionId: "a", brokerInstanceId: "one", sessionRevision: 1, state: "idle" };
  const running = { ...old, sessionRevision: 3, state: "running" };
  const stable = { ...old, sessionId: "b" };
  replica.replace([running, stable]);
  const snapshot = replica.current();
  assert.equal(replica.replace([{ ...running }, { ...stable }]), snapshot);
  assert.equal(replica.replace([old, stable])[0], running);
  replica.remember({ ...old, sessionRevision: 2, dismissedAt: "now" });
  assert.equal(replica.replace([running, stable])[0], running);
  replica.remember({ ...running, sessionRevision: 4, dismissedAt: "now" });
  assert.deepEqual(replica.replace([running, stable]), [stable]);
  assert.deepEqual(replica.replace([old, stable]), [stable]);
  replica.beginInstance("two");
  assert.deepEqual(replica.replace([running]), []);
  assert.equal(replica.replace([{ ...old, brokerInstanceId: "two" }]).length, 1);
  assert.equal(replica.replace([running])[0].brokerInstanceId, "two");
});

test("active snapshot loader consumes legacy pagination and rejects mixed snapshots", async (t) => {
  const records = Array.from({ length: 350 }, (_, index) => ({ sessionId: String(index) }));
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(url);
    const offset = Number(new URL(url).searchParams.get("offset") || 0);
    return new Response(JSON.stringify({ sessions: records.slice(offset, offset + 200), offset, hasMore: offset === 0, revision: 3 }));
  });
  assert.equal((await loadActiveSessionSnapshot()).sessions.length, 350);
  assert.equal(requests.length, 2);
  globalThis.fetch.mock.mockImplementation(async (url) => {
    const offset = Number(new URL(url).searchParams.get("offset") || 0);
    return new Response(JSON.stringify({ sessions: records.slice(offset, offset + 200), offset, hasMore: offset === 0, revision: offset ? 4 : 3 }));
  });
  await assert.rejects(loadActiveSessionSnapshot(), /changed during paginated hydration/);
});
