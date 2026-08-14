import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root: fileURLToPath(new URL("../..", import.meta.url)),
  optimizeDeps: { noDiscovery: true },
  server: { hmr: { port: 24683 }, middlewareMode: true },
});
const { AdaptivePollController } = await vite.ssrLoadModule(
  "/src/runtime/adaptivePollController.ts",
);

after(async () => {
  await vite.close();
});

function createHost() {
  let nextId = 1;
  const timers = new Map();
  return {
    timers,
    host: {
      setTimeout(callback, delayMs) {
        const id = nextId++;
        timers.set(id, { callback, delayMs });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
  };
}

test("adaptive polling pauses while inactive and refreshes on resume", async () => {
  const harness = createHost();
  const reasons = [];
  const controller = new AdaptivePollController({
    host: harness.host,
    nextDelayMs: () => 100,
    run: async (reason) => reasons.push(reason),
  });

  controller.start();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(reasons, ["startup"]);
  assert.equal(harness.timers.size, 1);

  controller.setActive(false);
  assert.equal(harness.timers.size, 0);
  controller.setActive(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(reasons, ["startup", "resume"]);
  controller.stop();
});

test("overlapping requests coalesce into one follow-up probe", async () => {
  const harness = createHost();
  const reasons = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const controller = new AdaptivePollController({
    host: harness.host,
    nextDelayMs: () => 100,
    run: async (reason) => {
      reasons.push(reason);
      if (reason === "startup") await gate;
    },
  });

  controller.start();
  controller.request("focus");
  controller.request("manual-signal");
  assert.deepEqual(reasons, ["startup"]);
  release();
  await gate;
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(reasons, ["startup", "manual-signal"]);
  controller.stop();
});
