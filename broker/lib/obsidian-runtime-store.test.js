const assert = require("node:assert/strict");
const test = require("node:test");
const { createObsidianRuntimeStore } = require("./obsidian-runtime-store");

test("runtime heartbeat is addressable by vault root and expires", () => {
  let now = 1_000;
  const store = createObsidianRuntimeStore({ now: () => now, runtimeTtlMs: 100 });
  store.heartbeat({ vaultRoot: "G:\\Vault", pluginVersion: "2.0.0", capabilities: ["open-result-v1"] });
  assert.equal(store.getRuntime({ vaultRoot: "G:\\Vault" }).active, true);
  now += 101;
  assert.equal(store.getRuntime({ vaultRoot: "G:\\Vault" }), null);
});

test("successful open result is idempotent and cannot be downgraded", () => {
  const store = createObsidianRuntimeStore();
  const first = store.recordOpenResult({ openRequestId: "req-1", status: "opened", targetPath: "Notes/a.md" });
  const duplicate = store.recordOpenResult({ openRequestId: "req-1", status: "error", message: "late error" });
  assert.equal(first.ok, true);
  assert.equal(duplicate.status, "opened");
  assert.equal(duplicate.duplicate, true);
});

test("failure results remain explicit and queryable", () => {
  const store = createObsidianRuntimeStore();
  store.recordOpenResult({ openRequestId: "req-2", status: "not_found", message: "missing" });
  const result = store.getOpenResult("req-2");
  assert.equal(result.ok, false);
  assert.equal(result.status, "not_found");
  assert.equal(result.message, "missing");
});
