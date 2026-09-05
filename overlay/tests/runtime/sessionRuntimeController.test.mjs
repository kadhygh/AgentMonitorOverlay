import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root: fileURLToPath(new URL("../..", import.meta.url)),
  optimizeDeps: { noDiscovery: true },
  server: { hmr: { port: 24682 }, middlewareMode: true },
});
const { SessionRuntimeController } = await vite.ssrLoadModule(
  "/src/runtime/sessionRuntimeController.ts",
);

after(async () => {
  await vite.close();
});

function createHarness() {
  let nextTimerId = 1;
  let resumeListener = null;
  const timers = new Map();
  const listeners = new Map();
  const source = {
    readyState: 0,
    onopen: null,
    onerror: null,
    closed: false,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    close() {
      this.closed = true;
    },
  };
  const state = { online: true, visible: true };
  const host = {
    createEventSource: () => source,
    isOnline: () => state.online,
    isVisible: () => state.visible,
    listenForResume(listener) {
      resumeListener = listener;
      return () => {
        resumeListener = null;
      };
    },
    setTimeout(callback, delayMs) {
      const timerId = nextTimerId++;
      timers.set(timerId, { callback, delayMs });
      return timerId;
    },
    clearTimeout(timerId) {
      timers.delete(timerId);
    },
  };
  return {
    host,
    listeners,
    source,
    state,
    timers,
    resume: () => resumeListener?.(),
    runTimerByDelay(delayMs) {
      const entry = [...timers].find(([, timer]) => timer.delayMs === delayMs);
      assert.ok(entry, `expected a ${delayMs} ms timer`);
      const [timerId, timer] = entry;
      timers.delete(timerId);
      timer.callback();
    },
  };
}

test("a healthy event stream cancels fallback snapshot polling", () => {
  const harness = createHarness();
  const health = [];
  const controller = new SessionRuntimeController({
    eventUrl: "http://127.0.0.1/events",
    host: harness.host,
    refresh: () => undefined,
    onBrokerReady: () => undefined,
    onSessionsChanged: () => undefined,
    onStreamHealthChanged: (healthy) => health.push(healthy),
  });

  controller.start();
  assert.equal(harness.timers.size, 1);
  harness.source.onopen(new Event("open"));
  assert.equal(controller.isStreamHealthy(), true);
  assert.equal(harness.timers.size, 0);
  assert.deepEqual(health, [true]);

  controller.stop();
  assert.equal(harness.source.closed, true);
  assert.deepEqual(health, [true, false]);
});

test("fallback snapshots use visibility gates and exponential backoff", async () => {
  const harness = createHarness();
  const refreshes = [];
  const controller = new SessionRuntimeController({
    eventUrl: "http://127.0.0.1/events",
    host: harness.host,
    fallbackBaseMs: 100,
    fallbackMaxMs: 400,
    refresh: async (reason) => refreshes.push(reason),
    onBrokerReady: () => undefined,
    onSessionsChanged: () => undefined,
  });

  controller.start();
  harness.state.visible = false;
  harness.runTimerByDelay(100);
  await Promise.resolve();
  assert.deepEqual(refreshes, []);
  assert.equal(harness.timers.size, 0, "hidden runtimes wait for a semantic resume event");

  harness.state.visible = true;
  harness.resume();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(refreshes, ["runtime-resume"]);
  harness.runTimerByDelay(100);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(refreshes, ["runtime-resume", "runtime-fallback"]);
  assert.ok([...harness.timers.values()].some((timer) => timer.delayMs === 200));

  controller.stop();
});

test("event reconciliation is debounced and owned by the controller", () => {
  const harness = createHarness();
  const refreshes = [];
  const scheduled = [];
  const controller = new SessionRuntimeController({
    eventUrl: "http://127.0.0.1/events",
    host: harness.host,
    reconcileDelayMs: 25,
    refresh: (reason) => refreshes.push(reason),
    onBrokerReady: () => undefined,
    onSessionsChanged: () => undefined,
    onReconcileScheduled: (details) => scheduled.push(details),
  });

  controller.start();
  controller.scheduleReconcile("first", "a");
  controller.scheduleReconcile("second", "b");
  assert.equal(scheduled.at(-1).rescheduled, true);
  harness.runTimerByDelay(25);
  assert.deepEqual(refreshes, ["sse-reconcile"]);
  controller.stop();
});

test("continuous invalidations cannot postpone reconciliation past its maximum wait", () => {
  const harness = createHarness();
  let refreshes = 0;
  const controller = new SessionRuntimeController({
    eventUrl: "http://127.0.0.1/events", host: harness.host, refresh: () => { refreshes += 1; },
    onBrokerReady() {}, onSessionsChanged() {},
  });
  controller.start();
  harness.source.onopen(new Event("open"));
  controller.scheduleReconcile("first");
  const maxTimer = [...harness.timers].find(([, timer]) => timer.delayMs === 1000)[0];
  for (let index = 0; index < 100; index += 1) controller.scheduleReconcile("burst");
  assert.ok(harness.timers.has(maxTimer));
  harness.runTimerByDelay(1000);
  assert.equal(refreshes, 1);
  assert.equal(harness.timers.size, 0);
  controller.stop();
});

test("hidden healthy views defer snapshot work and reconcile on visibility resume", () => {
  const harness = createHarness();
  let refreshes = 0;
  const controller = new SessionRuntimeController({
    eventUrl: "http://127.0.0.1/events", host: harness.host, refresh: () => { refreshes += 1; },
    onBrokerReady() {}, onSessionsChanged() {},
  });
  controller.start();
  harness.source.onopen(new Event("open"));
  harness.state.visible = false;
  controller.scheduleReconcile("hidden-change");
  assert.equal(harness.timers.size, 0);
  harness.state.visible = true;
  harness.resume();
  assert.equal(refreshes, 1);
  controller.stop();
});
