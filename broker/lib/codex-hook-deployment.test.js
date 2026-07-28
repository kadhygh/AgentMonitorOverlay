const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  CODEX_HOOK_EVENTS,
  CODEX_PROJECT_HOOK_COMMAND,
  mergeCodexHooks,
} = require("../hooks/codex");
const { AMO_DEPLOYMENT_VERSION, AMO_HOOK_PROTOCOL_VERSION } = require("./amo-constants");
const { inspectAdapterDeployment } = require("./workspace-inspect");

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amo-codex-hook-"));
  const workspacePath = path.join(root, "project with spaces");
  const amoRoot = path.join(workspacePath, ".amo");
  fs.mkdirSync(path.join(workspacePath, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(amoRoot, "adapters"), { recursive: true });
  return { root, workspacePath, amoRoot };
}

function inspectCodex(fixture) {
  return inspectAdapterDeployment(fixture.workspacePath, fixture.amoRoot, {
    adapterId: "codex-cli",
    hookConfigPath: ".codex/hooks.json",
    hookMarker: "codex-stop-message.mjs",
    expectedHookEvents: CODEX_HOOK_EVENTS,
    requiredCommandMarkers: [CODEX_PROJECT_HOOK_COMMAND],
  });
}

test("Codex deployment replaces absolute AMO hooks with the workspace locator command", () => {
  const fixture = createFixture();
  try {
    const hooksPath = path.join(fixture.workspacePath, ".codex", "hooks.json");
    const oldCommand = `node "${path.join(fixture.amoRoot, "hooks", "codex-stop-message.mjs")}"`;
    fs.writeFileSync(
      hooksPath,
      `${JSON.stringify({
        description: "Keep this metadata",
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: oldCommand, timeout: 10 }] },
            { hooks: [{ type: "command", command: "node custom-hook.mjs" }] },
          ],
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const first = mergeCodexHooks(fixture.workspacePath, fixture.amoRoot);
    const hooks = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
    const serialized = JSON.stringify(hooks);

    assert.equal(first.changed, true);
    assert.equal(hooks.description, "Keep this metadata");
    assert.equal(serialized.includes(oldCommand), false);
    assert.equal(serialized.includes("node custom-hook.mjs"), true);
    for (const eventName of CODEX_HOOK_EVENTS) {
      const commands = hooks.hooks[eventName]
        .flatMap((entry) => entry.hooks || [])
        .map((hook) => hook.command);
      assert.equal(commands.includes(CODEX_PROJECT_HOOK_COMMAND), true);
    }

    const second = mergeCodexHooks(fixture.workspacePath, fixture.amoRoot);
    assert.equal(second.changed, false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Codex inspection requires the workspace locator command", () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(
      path.join(fixture.amoRoot, "adapters", "codex-cli.json"),
      `${JSON.stringify({
        deploymentVersion: AMO_DEPLOYMENT_VERSION,
        hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
        hookEvents: CODEX_HOOK_EVENTS,
      }, null, 2)}\n`,
      "utf8",
    );
    const oldCommand = `node "${path.join(fixture.amoRoot, "hooks", "codex-stop-message.mjs")}"`;
    const hooks = Object.fromEntries(
      CODEX_HOOK_EVENTS.map((eventName) => [eventName, [{ hooks: [{ type: "command", command: oldCommand }] }]]),
    );
    fs.writeFileSync(
      path.join(fixture.workspacePath, ".codex", "hooks.json"),
      `${JSON.stringify({ hooks }, null, 2)}\n`,
      "utf8",
    );

    const before = inspectCodex(fixture);
    assert.equal(before.deploymentStatus, "needs-update");
    assert.equal(before.deploymentIssues.some((issue) => issue.includes("outdated AMO hook command")), true);

    mergeCodexHooks(fixture.workspacePath, fixture.amoRoot);

    const after = inspectCodex(fixture);
    assert.equal(after.deploymentStatus, "deployed");
    assert.deepEqual(after.deploymentIssues, []);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Codex workspace locator finds the deployed hook from a nested session cwd", () => {
  const fixture = createFixture();
  try {
    const hookDir = path.join(fixture.amoRoot, "hooks");
    const nestedCwd = path.join(fixture.workspacePath, "src", "feature");
    fs.mkdirSync(hookDir, { recursive: true });
    fs.mkdirSync(nestedCwd, { recursive: true });
    fs.writeFileSync(
      path.join(hookDir, "codex-stop-message.mjs"),
      [
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ input, script: import.meta.url })); });",
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(CODEX_PROJECT_HOOK_COMMAND, {
      cwd: nestedCwd,
      input: "hook-payload",
      encoding: "utf8",
      shell: true,
      timeout: 10_000,
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.input, "hook-payload");
    assert.equal(decodeURIComponent(output.script).includes("/.amo/hooks/codex-stop-message.mjs"), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
