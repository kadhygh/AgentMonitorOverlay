import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root: fileURLToPath(new URL("../..", import.meta.url)),
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});
const { ManagedWindowMonitor } = await vite.ssrLoadModule("/src/runtime/managedWindowMonitor.ts");
const {
  activationTargetForSession,
  targetBindingForSession,
} = await vite.ssrLoadModule("/src/domain/routingModel.ts");

after(async () => {
  await vite.close();
});

function target(sessionId = "session-a", launchId = "launch-a", identity = null) {
  return {
    sessionId,
    launchId,
    request: {
      sessionId,
      tool: "codex",
      title: `[AMO:codex:${launchId}] Codex CLI - project`,
      processName: "WindowsTerminal.exe",
      titleToken: `[AMO:codex:${launchId}]`,
      titleContains: [`[AMO:codex:${launchId}]`],
      project: "project",
      cwd: "G:\\PROJECT\\project",
      pid: identity?.pid ?? null,
      hwnd: identity?.hwnd ?? null,
    },
  };
}

function resultFor(request, ok) {
  return {
    sessionId: request.sessionId,
    result: {
      ok,
      message: ok ? "alive" : "missing",
      candidates: ok ? [{
        hwnd: request.hwnd ?? 101,
        processId: request.pid ?? 202,
        processName: "WindowsTerminal.exe",
        title: request.title,
        label: request.title,
      }] : [],
    },
  };
}

test("a recovered target needs a fresh run of misses before going offline", async () => {
  const outcomes = [false, true, false, false];
  const offline = [];
  const monitor = new ManagedWindowMonitor({
    missesBeforeOffline: 2,
    probe: async (requests) => requests.map((request) => resultFor(request, outcomes.shift())),
    onOffline: async (current) => offline.push(current.launchId),
  });
  monitor.updateTargets([target()]);

  await monitor.runOnce();
  await monitor.runOnce();
  await monitor.runOnce();
  assert.deepEqual(offline, []);

  await monitor.runOnce();
  assert.deepEqual(offline, ["launch-a"]);
});

test("changing launch identity clears misses collected for the previous window", async () => {
  const offline = [];
  const monitor = new ManagedWindowMonitor({
    missesBeforeOffline: 2,
    probe: async (requests) => requests.map((request) => resultFor(request, false)),
    onOffline: async (current) => offline.push(current.launchId),
  });
  monitor.updateTargets([target("session-a", "launch-a", { hwnd: 101, pid: 202 })]);
  await monitor.runOnce();

  monitor.updateTargets([target("session-a", "launch-b", { hwnd: 303, pid: 404 })]);
  await monitor.runOnce();
  assert.deepEqual(offline, []);

  await monitor.runOnce();
  assert.deepEqual(offline, ["launch-b"]);
});

test("stopping the monitor invalidates an in-flight probe", async () => {
  let releaseProbe;
  const probeGate = new Promise((resolve) => {
    releaseProbe = resolve;
  });
  const offline = [];
  const monitor = new ManagedWindowMonitor({
    missesBeforeOffline: 1,
    probe: async (requests) => {
      await probeGate;
      return requests.map((request) => resultFor(request, false));
    },
    onOffline: async (current) => offline.push(current.launchId),
  });
  monitor.updateTargets([target()]);

  const pending = monitor.runOnce();
  monitor.stop();
  releaseProbe();
  await pending;

  assert.deepEqual(offline, []);
});

test("a newly claimed launch remains unresolved instead of being marked offline", async () => {
  let now = 1_000;
  const offline = [];
  const events = [];
  const monitor = new ManagedWindowMonitor({
    initialResolutionGraceMs: 10_000,
    now: () => now,
    probe: async (requests) => requests.map((request) => resultFor(request, false)),
    onEvent: (event) => events.push(event),
    onOffline: async (current) => offline.push(current.launchId),
  });
  monitor.updateTargets([target()]);

  await monitor.runOnce();
  now += 12_000;
  await monitor.runOnce();
  await monitor.runOnce();

  assert.deepEqual(offline, []);
  assert.ok(events.includes("managed_window.awaiting_resolution"));
  assert.equal(events.filter((event) => event === "managed_window.unresolved").length, 1);
});

test("the first title-token match persists a stable window identity", async () => {
  const resolved = [];
  const requests = [];
  const monitor = new ManagedWindowMonitor({
    probe: async ([request]) => {
      requests.push(request);
      return [resultFor(request, true)];
    },
    onResolved: async (current, candidate) => resolved.push({ current, candidate }),
    onOffline: async () => undefined,
  });
  monitor.updateTargets([target()]);

  await monitor.runOnce();
  await monitor.runOnce();

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].candidate.hwnd, 101);
  assert.equal(requests[1].hwnd, 101);
  assert.equal(requests[1].pid, 202);
});

function sessionWithTarget(targetBinding, boundBy) {
  return {
    sessionId: "session-managed",
    tool: "codex",
    targetBinding,
    windowHint: {
      hwnd: 4242,
      pid: 99,
      process: "WindowsTerminal.exe",
      boundBy,
    },
  };
}

test("managed window targets are hidden from explicit target UI", () => {
  const session = sessionWithTarget({
    type: "window",
    hwnd: 4242,
    processId: 99,
    boundBy: "managed-launch",
  }, "managed-launch");

  assert.equal(targetBindingForSession(session), null);
  const activationTarget = activationTargetForSession(session);
  assert.equal(activationTarget.type, "window");
  assert.equal(activationTarget.hwnd, 4242);
  assert.equal(activationTarget.boundBy, "managed-launch");
});

test("manual window targets remain explicit and unbindable", () => {
  const manualTarget = {
    type: "window",
    hwnd: 4242,
    processId: 99,
    boundBy: "overlay-target-menu",
  };
  const session = sessionWithTarget(manualTarget, "overlay-target-menu");

  assert.equal(targetBindingForSession(session), manualTarget);
  assert.equal(activationTargetForSession(session), manualTarget);
});
