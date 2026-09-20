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
const { compareRegistryVersions, formatPublishTime } = await vite.ssrLoadModule(
  "/src/native/harnessVersioning.ts",
);

test("compareRegistryVersions orders the published dsh release history", () => {
  const ordered = [
    "0.0.1-rc.1",
    "0.1.0-rc.6",
    "0.1.2-alpha.2",
    "0.1.2-rc.1",
    "0.1.5-rc.2",
    "0.1.6-alpha.1",
    "0.1.6-alpha.2",
  ];
  for (let index = 1; index < ordered.length; index += 1) {
    const older = ordered[index - 1];
    const newer = ordered[index];
    assert.ok(compareRegistryVersions(older, newer) < 0, `${older} should be older than ${newer}`);
    assert.ok(compareRegistryVersions(newer, older) > 0, `${newer} should be newer than ${older}`);
  }
});

test("compareRegistryVersions follows semver prerelease rules", () => {
  assert.ok(compareRegistryVersions("0.1.5-rc.2", "0.1.5-rc.10") < 0);
  assert.ok(compareRegistryVersions("0.1.5-rc.1", "0.1.5") < 0);
  assert.equal(compareRegistryVersions("0.1.5-rc.2", "0.1.5-rc.2"), 0);
  assert.ok(compareRegistryVersions("0.1.5-alpha.9", "0.1.5-rc.1") < 0);
  assert.ok(compareRegistryVersions("0.1.5-rc.1.1", "0.1.5-rc.1") > 0);
});

test("compareRegistryVersions is conservative for non-semver values", () => {
  assert.equal(compareRegistryVersions("not-a-version", "0.1.5"), 0);
  assert.equal(compareRegistryVersions("", ""), 0);
});

test("formatPublishTime compacts registry ISO timestamps", () => {
  assert.equal(
    formatPublishTime("2026-09-17T13:52:10.201Z"),
    "2026-09-17 13:52 UTC",
  );
  assert.equal(formatPublishTime(""), "");
});

test("formatPublishTime passes through timestamps without a T separator", () => {
  assert.equal(formatPublishTime("20260917"), "20260917");
});

after(async () => {
  await vite.close();
});
