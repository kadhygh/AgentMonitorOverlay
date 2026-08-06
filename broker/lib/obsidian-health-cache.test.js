const assert = require("node:assert/strict");
const test = require("node:test");
const { createObsidianPluginHealthCache } = require("./obsidian-health-cache");

test("cold health lookup schedules inspection without blocking the caller", () => {
  const scheduled = [];
  let inspections = 0;
  const cache = createObsidianPluginHealthCache({
    inspect: () => {
      inspections += 1;
      return { ok: true, checkedAt: new Date(1000).toISOString() };
    },
    now: () => 1000,
    schedule: (callback) => scheduled.push(callback),
  });

  assert.equal(cache.get("C:/vault"), null);
  assert.equal(inspections, 0);
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.equal(inspections, 1);
  assert.equal(cache.get("C:/vault").ok, true);
});

test("stale health uses stale-while-revalidate and coalesces refresh", () => {
  const scheduled = [];
  let currentTime = 10_000;
  let inspections = 0;
  const cache = createObsidianPluginHealthCache({
    inspect: () => {
      inspections += 1;
      return { ok: true, status: "ok", checkedAt: new Date(currentTime).toISOString() };
    },
    now: () => currentTime,
    ttlMs: 100,
    schedule: (callback) => scheduled.push(callback),
  });
  const fallback = { ok: true, status: "old", checkedAt: new Date(1000).toISOString() };

  assert.equal(cache.get("C:/vault", {}, fallback).status, "old");
  assert.equal(cache.get("C:/vault", {}, fallback).status, "old");
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.equal(inspections, 1);
  assert.equal(cache.get("C:/vault").status, "ok");
});

test("invalidating one vault preserves other cached entries", () => {
  const scheduled = [];
  const cache = createObsidianPluginHealthCache({
    schedule: (callback) => scheduled.push(callback),
  });
  cache.prime("C:/one", { ok: true, checkedAt: new Date().toISOString() });
  cache.prime("C:/two", { ok: false, checkedAt: new Date().toISOString() });
  cache.invalidate("C:/one");

  assert.equal(cache.get("C:/one"), null);
  assert.equal(cache.get("C:/two").ok, false);
  assert.equal(cache.status().size, 2);
});
