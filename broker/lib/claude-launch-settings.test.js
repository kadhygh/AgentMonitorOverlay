const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  cleanupClaudeLaunchSettings,
  cleanupStaleClaudeLaunchSettings,
  createClaudeLaunchSettings,
} = require("./claude-launch-settings");

function createRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "amo-claude-launch-settings-"));
}

test("one-launch Claude settings contain provider routing and the temporary key", (t) => {
  const rootDir = createRoot();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const result = createClaudeLaunchSettings({
    launchId: "launch-test-1",
    rootDir,
    provider: {
      id: "glm-5.2",
      environment: {
        ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
        ANTHROPIC_MODEL: "glm-5.2[1m]",
        ANTHROPIC_AUTH_TOKEN: "temporary-secret",
      },
    },
  });

  assert.ok(result);
  assert.equal(path.dirname(result.filePath), rootDir);
  const payload = JSON.parse(fs.readFileSync(result.filePath, "utf8"));
  assert.equal(payload.env.ANTHROPIC_MODEL, "glm-5.2[1m]");
  assert.equal(payload.env.ANTHROPIC_AUTH_TOKEN, "temporary-secret");
});

test("default Claude launch does not create a temporary settings file", (t) => {
  const rootDir = createRoot();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const result = createClaudeLaunchSettings({
    launchId: "launch-default",
    rootDir,
    provider: { id: "anthropic-default", environment: {} },
  });

  assert.equal(result, null);
  assert.deepEqual(fs.readdirSync(rootDir), []);
});

test("normal launch cleanup removes the temporary key file", (t) => {
  const rootDir = createRoot();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const result = createClaudeLaunchSettings({
    launchId: "launch-cleanup",
    rootDir,
    provider: {
      id: "deepseek-v4",
      environment: { ANTHROPIC_AUTH_TOKEN: "temporary-secret" },
    },
  });

  assert.equal(cleanupClaudeLaunchSettings(result.filePath, rootDir), true);
  assert.equal(fs.existsSync(result.filePath), false);
  assert.equal(cleanupClaudeLaunchSettings(result.filePath, rootDir), false);
});

test("stale cleanup removes old launch settings and preserves fresh ones", (t) => {
  const rootDir = createRoot();
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const now = Date.now();
  const stale = path.join(rootDir, "stale.settings.json");
  const fresh = path.join(rootDir, "fresh.settings.json");
  fs.writeFileSync(stale, "{}");
  fs.writeFileSync(fresh, "{}");
  fs.utimesSync(stale, new Date(now - 10_000), new Date(now - 10_000));
  fs.utimesSync(fresh, new Date(now - 1_000), new Date(now - 1_000));

  const removed = cleanupStaleClaudeLaunchSettings({
    rootDir,
    now,
    staleMs: 5_000,
  });

  assert.equal(removed, 1);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
});

test("cleanup refuses paths outside the launch settings root", (t) => {
  const rootDir = createRoot();
  const outsideDir = createRoot();
  t.after(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
  const outsideFile = path.join(outsideDir, "outside.settings.json");
  fs.writeFileSync(outsideFile, "{}");

  assert.equal(cleanupClaudeLaunchSettings(outsideFile, rootDir), false);
  assert.equal(fs.existsSync(outsideFile), true);
});