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
