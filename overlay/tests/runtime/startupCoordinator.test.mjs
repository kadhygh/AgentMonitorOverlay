import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root: fileURLToPath(new URL("../..", import.meta.url)),
  optimizeDeps: { noDiscovery: true },
  server: { hmr: { port: 24684 }, middlewareMode: true },
});
const { StartupCoordinator } = await vite.ssrLoadModule("/src/runtime/startupCoordinator.ts");

after(async () => {
  await vite.close();
});

test("startup runtime and data hydration are ordered and single-flight", async () => {
  const phases = [];
  let releaseRuntime;
  const runtimeGate = new Promise((resolve) => {
    releaseRuntime = resolve;
  });
  const coordinator = new StartupCoordinator({
    onStart: (reason) => phases.push(`start:${reason}`),
    ensureRuntime: async () => {
      phases.push("runtime");
      await runtimeGate;
    },
    hydrateData: async () => phases.push("data"),
    onSettled: (reason) => phases.push(`settled:${reason}`),
  });

  const first = coordinator.start("startup");
  const second = coordinator.start("retry");
  assert.equal(first, second);
  assert.deepEqual(phases, ["start:startup", "runtime"]);
  releaseRuntime();
  await first;
  assert.deepEqual(phases, ["start:startup", "runtime", "data", "settled:startup"]);
});

test("data hydration is attempted even when runtime startup fails", async () => {
  let hydrationAttempts = 0;
  const coordinator = new StartupCoordinator({
    ensureRuntime: async () => {
      throw new Error("runtime unavailable");
    },
    hydrateData: async () => {
      hydrationAttempts += 1;
    },
  });

  await assert.rejects(coordinator.start(), /runtime unavailable/);
  assert.equal(hydrationAttempts, 1);
});
