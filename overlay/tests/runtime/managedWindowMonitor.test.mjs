import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root: fileURLToPath(new URL("../..", import.meta.url)),
  server: { middlewareMode: true },
});
const { ManagedWindowMonitor } = await vite.ssrLoadModule("/src/runtime/managedWindowMonitor.ts");

after(async () => {
  await vite.close();
});

function target(sessionId = "session-a", launchId = "launch-a") {
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
      pid: null,
      hwnd: null,
    },
  };
}

function resultFor(request, ok) {
  return {
    sessionId: request.sessionId,
    result: {
      ok,
      message: ok ? "alive" : "missing",
      candidates: [],
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
  monitor.updateTargets([target("session-a", "launch-a")]);
  await monitor.runOnce();

  monitor.updateTargets([target("session-a", "launch-b")]);
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
