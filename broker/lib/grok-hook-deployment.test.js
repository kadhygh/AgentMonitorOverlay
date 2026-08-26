const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  GROK_HOOK_EVENTS,
  GROK_PROJECT_HOOK_COMMAND,
  GROK_PROJECT_HOOK_CONFIG_PATH,
  grokMessageHookScript,
  mergeGrokHooks,
} = require("../hooks/grok");
const { AMO_DEPLOYMENT_VERSION, AMO_HOOK_PROTOCOL_VERSION } = require("./amo-constants");
const { inspectAdapterDeployment } = require("./workspace-inspect");

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amo-grok-hook-"));
  const workspacePath = path.join(root, "project with spaces");
  const amoRoot = path.join(workspacePath, ".amo");
  fs.mkdirSync(path.join(workspacePath, ".grok", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(amoRoot, "adapters"), { recursive: true });
  fs.mkdirSync(path.join(amoRoot, "hooks"), { recursive: true });
  return { root, workspacePath, amoRoot };
}

function inspectGrok(fixture) {
  return inspectAdapterDeployment(fixture.workspacePath, fixture.amoRoot, {
    adapterId: "grok-build",
    hookConfigPath: GROK_PROJECT_HOOK_CONFIG_PATH,
    hookMarker: "grok-message.mjs",
    expectedHookEvents: GROK_HOOK_EVENTS,
    requiredCommandMarkers: [GROK_PROJECT_HOOK_COMMAND],
  });
}

test("Grok deployment merges lifecycle hooks without removing custom hooks", () => {
  const fixture = createFixture();
  try {
    const hooksPath = path.join(fixture.workspacePath, GROK_PROJECT_HOOK_CONFIG_PATH);
    fs.writeFileSync(
      hooksPath,
      `${JSON.stringify({
        description: "Keep Grok metadata",
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "node custom-grok-hook.mjs" }] }],
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const first = mergeGrokHooks(fixture.workspacePath, fixture.amoRoot);
    const hooks = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
    const serialized = JSON.stringify(hooks);
    assert.equal(first.changed, true);
    assert.equal(hooks.description, "Keep Grok metadata");
    assert.equal(serialized.includes("node custom-grok-hook.mjs"), true);
    for (const eventName of GROK_HOOK_EVENTS) {
      const commands = hooks.hooks[eventName]
        .flatMap((entry) => entry.hooks || [])
        .map((hook) => hook.command);
      assert.equal(commands.includes(GROK_PROJECT_HOOK_COMMAND), true);
    }
    assert.equal(mergeGrokHooks(fixture.workspacePath, fixture.amoRoot).changed, false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Grok inspection requires the managed project hook command", () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(
      path.join(fixture.amoRoot, "adapters", "grok-build.json"),
      `${JSON.stringify({
        deploymentVersion: AMO_DEPLOYMENT_VERSION,
        hookProtocolVersion: AMO_HOOK_PROTOCOL_VERSION,
        hookEvents: GROK_HOOK_EVENTS,
      }, null, 2)}\n`,
      "utf8",
    );
    mergeGrokHooks(fixture.workspacePath, fixture.amoRoot);
    const result = inspectGrok(fixture);
    assert.equal(result.deploymentStatus, "deployed");
    assert.deepEqual(result.deploymentIssues, []);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Grok hook normalizes the official camelCase Stop payload", () => {
  const fixture = createFixture();
  try {
    const scriptPath = path.join(fixture.amoRoot, "hooks", "grok-message.mjs");
    fs.writeFileSync(scriptPath, grokMessageHookScript(), "utf8");
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: fixture.workspacePath,
      input: JSON.stringify({
        hookEventName: "Stop",
        sessionId: "grok-session-1",
        promptId: "grok-turn-1",
        cwd: fixture.workspacePath,
        permissionMode: "default",
        lastAssistantMessage: "Grok completed the task.",
      }),
      encoding: "utf8",
      env: {
        ...process.env,
        AMO_LAUNCH_ID: "launch-grok-test",
        AMO_WORKSPACE_ID: "workspace-grok-test",
        AMO_WORKSPACE_PATH: fixture.workspacePath,
      },
      timeout: 10_000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"continue":true/u);
    const record = JSON.parse(fs.readFileSync(
      path.join(fixture.amoRoot, "logs", "grok-cache", "latest-assistant-message.json"),
      "utf8",
    ));
    assert.equal(record.tool, "grok");
    assert.equal(record.sessionId, "grok-session-1");
    assert.equal(record.turnId, "grok-turn-1");
    assert.equal(record.message, "Grok completed the task.");
    assert.equal(record.permissionMode, "default");
    assert.equal(record.launchId, "launch-grok-test");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Grok hook canonicalizes snake_case lifecycle event names", () => {
  const fixture = createFixture();
  try {
    const scriptPath = path.join(fixture.amoRoot, "hooks", "grok-message.mjs");
    fs.writeFileSync(scriptPath, grokMessageHookScript(), "utf8");
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: fixture.workspacePath,
      input: JSON.stringify({
        hookEventName: "user_prompt_submit",
        sessionId: "grok-session-2",
        promptId: "grok-turn-2",
        cwd: fixture.workspacePath,
        prompt: "Add Grok Build support.",
      }),
      encoding: "utf8",
      timeout: 10_000,
    });

    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(fs.readFileSync(
      path.join(fixture.amoRoot, "logs", "grok-cache", "latest-user-prompt.json"),
      "utf8",
    ));
    assert.equal(record.role, "user");
    assert.equal(record.hookEventName, "UserPromptSubmit");
    assert.equal(record.message, "Add Grok Build support.");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
