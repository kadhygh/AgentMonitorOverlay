const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  CLAUDE_HOOK_EVENTS,
  CLAUDE_PROJECT_HOOK_COMMAND,
  claudeMessageHookScript,
  mergeClaudeSettings,
} = require("../hooks/claude");
const { AMO_DEPLOYMENT_VERSION, AMO_HOOK_PROTOCOL_VERSION } = require("./amo-constants");
const { inspectAdapterDeployment } = require("./workspace-inspect");

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amo-claude-hook-"));
  const workspacePath = path.join(root, "project with spaces");
  const amoRoot = path.join(workspacePath, ".amo");
  fs.mkdirSync(path.join(workspacePath, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(amoRoot, "adapters"), { recursive: true });
  return { root, workspacePath, amoRoot };
}

test("Claude hook forwards the SessionStart source used by display-only automatic naming", () => {
  assert.match(claudeMessageHookScript(), /sessionStartSource: lowerEventName === 'sessionstart'/u);
});

function inspectClaude(fixture) {
  return inspectAdapterDeployment(fixture.workspacePath, fixture.amoRoot, {
    adapterId: "claude-cli",
    hookConfigPath: ".claude/settings.local.json",
    hookMarker: "claude-message.mjs",
    expectedHookEvents: CLAUDE_HOOK_EVENTS,
    requiredCommandMarkers: ["${CLAUDE_PROJECT_DIR}"],
  });
}

test("Claude deployment replaces absolute AMO hooks with the project-relative command", () => {
  const fixture = createFixture();
  try {
    const settingsPath = path.join(fixture.workspacePath, ".claude", "settings.local.json");
    const oldCommand = `node "${path.join(fixture.amoRoot, "hooks", "claude-message.mjs")}"`;
    fs.writeFileSync(
      settingsPath,
      `${JSON.stringify({
        permissions: { allow: ["Read"] },
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: oldCommand, timeout: 10 }] },
            { hooks: [{ type: "command", command: "node custom-hook.mjs" }] },
          ],
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const first = mergeClaudeSettings(fixture.workspacePath, fixture.amoRoot);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const serialized = JSON.stringify(settings);

    assert.equal(first.changed, true);
    assert.equal(settings.permissions.allow[0], "Read");
    assert.equal(serialized.includes(oldCommand), false);
    assert.equal(serialized.includes("node custom-hook.mjs"), true);
    for (const eventName of CLAUDE_HOOK_EVENTS) {
      const commands = settings.hooks[eventName]
        .flatMap((entry) => entry.hooks || [])
        .map((hook) => hook.command);
      assert.equal(commands.includes(CLAUDE_PROJECT_HOOK_COMMAND), true);
    }

    const second = mergeClaudeSettings(fixture.workspacePath, fixture.amoRoot);
    assert.equal(second.changed, false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Claude inspection requires the project-relative hook command", () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(
      path.join(fixture.amoRoot, "adapters", "claude-cli.json"),
      `${JSON.stringify({
        deploymentVersion: AMO_DEPLOYMENT_VERSION,
        hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
        hookEvents: CLAUDE_HOOK_EVENTS,
      }, null, 2)}\n`,
      "utf8",
    );
    const oldCommand = `node "${path.join(fixture.amoRoot, "hooks", "claude-message.mjs")}"`;
    const hooks = Object.fromEntries(
      CLAUDE_HOOK_EVENTS.map((eventName) => [eventName, [{ hooks: [{ type: "command", command: oldCommand }] }]]),
    );
    fs.writeFileSync(
      path.join(fixture.workspacePath, ".claude", "settings.local.json"),
      `${JSON.stringify({ hooks }, null, 2)}\n`,
      "utf8",
    );

    const before = inspectClaude(fixture);
    assert.equal(before.deploymentStatus, "needs-update");
    assert.equal(before.deploymentIssues.some((issue) => issue.includes("outdated AMO hook command")), true);

    mergeClaudeSettings(fixture.workspacePath, fixture.amoRoot);

    const after = inspectClaude(fixture);
    assert.equal(after.deploymentStatus, "deployed");
    assert.deepEqual(after.deploymentIssues, []);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
