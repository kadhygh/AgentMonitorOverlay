const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchWorkspace } = require('./workspace-launch');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amo-cli-only-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('CLI-only DXX launch accepts an undeployed folder without creating managed state', async t => {
  const dir = fixture(t); let invocation;
  const result = await launchWorkspace({ workspacePath: dir, adapterId: 'codex-cli', launchMode: 'cli-only', codexProvider: { presetId: 'dxx', apiKey: 'test-dxx-secret' } }, {
    launchStore: { create() { throw Error('Must not create managed state'); } },
    launchCliInTerminal: async args => { invocation = args; return { pid: 123, command: args.command, args: args.args }; },
  });
  assert.equal(invocation.workspacePath, fs.realpathSync(dir));
  assert.equal(invocation.environment.DXX_API_KEY, 'test-dxx-secret');
  assert.equal(invocation.environment.AMO_LAUNCH_ID, undefined);
  assert.deepEqual(invocation.cleanupEnvironmentKeys, ['DXX_API_KEY']);
  assert.ok(invocation.args.includes('model_provider="amo-dxx"'));
  assert.equal(result.launch, null); assert.equal(result.workspaceId, null);
  assert.equal(result.windowHint, null); assert.equal(result.session, null);
  assert.ok(!JSON.stringify(result).includes('test-dxx-secret'));
  assert.deepEqual(fs.readdirSync(dir), []);
});
test('managed launch still requires workspace enrollment', async t => {
  await assert.rejects(launchWorkspace({ workspacePath: fixture(t), adapterId: 'codex-cli' }, { launchStore: {} }), e => e.code === 'workspace_not_enrolled');
});
test('CLI-only rejects nonexistent directories, App launches, resume and unknown modes', async t => {
  const dir = fixture(t);
  for (const extra of [{ adapterId: 'codex-app' }, { sessionId: 'existing-session' }]) {
    await assert.rejects(launchWorkspace({ workspacePath: dir, adapterId: 'codex-cli', launchMode: 'cli-only', ...extra }), e => e.code === 'unsupported_cli_only_launch');
  }
  await assert.rejects(launchWorkspace({ workspacePath: path.join(dir, 'missing'), adapterId: 'codex-cli', launchMode: 'cli-only' }), e => e.code === 'workspace_not_found');
  await assert.rejects(launchWorkspace({ workspacePath: dir, adapterId: 'codex-cli', launchMode: 'typo' }), e => e.code === 'invalid_launch_mode');
});
test('CLI-only Claude settings are cleaned up when terminal launch fails', async t => {
  const dir = fixture(t); let settings;
  await assert.rejects(launchWorkspace({ workspacePath: dir, adapterId: 'claude-cli', launchMode: 'cli-only', claudeProvider: { presetId: 'deepseek-v4', apiKey: 'test-claude-secret' } }, {
    launchCliInTerminal: async args => { settings = args.cleanupPaths[0]; assert.ok(fs.existsSync(settings)); throw Error('terminal unavailable'); },
  }), /terminal unavailable/);
  assert.ok(settings); assert.equal(fs.existsSync(settings), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});
test('CLI-only Grok preserves its isolated hook environment', async t => {
  let invocation;
  await launchWorkspace({ workspacePath: fixture(t), adapterId: 'grok-build', launchMode: 'cli-only' }, {
    launchCliInTerminal: async args => { invocation = args; return { pid: 124, command: args.command, args: args.args }; },
  });
  assert.equal(invocation.environment.GROK_CLAUDE_HOOKS_ENABLED, '0');
  assert.equal(invocation.environment.AMO_LAUNCH_ID, undefined);
});

test('managed launches still create a record and wait for the hook', async t => {
  const dir = fixture(t); fs.mkdirSync(path.join(dir, '.amo'));
  fs.writeFileSync(path.join(dir, '.amo/workspace.json'), JSON.stringify({ workspaceId: 'workspace-test' }));
  fs.writeFileSync(path.join(dir, '.amo/enrollment.json'), JSON.stringify({ adapters: [{ id: 'codex-cli' }] }));
  let record, invocation; const updates = [];
  const result = await launchWorkspace({ workspacePath: dir, adapterId: 'codex-cli' }, {
    launchStore: {
      create(input) { record = { ...input, launchId: 'managed-test', titleToken: '[AMO:test]' }; return record; },
      update(id, fields) { assert.equal(id, 'managed-test'); updates.push(fields.state); Object.assign(record, fields); },
      list() { return [record]; },
    },
    launchCliInTerminal: async args => { invocation = args; return { pid: 125, command: args.command, args: args.args }; },
  });
  assert.deepEqual(updates, ['spawning', 'waiting_hook']);
  assert.equal(invocation.environment.AMO_LAUNCH_ID, 'managed-test');
  assert.equal(result.workspaceId, 'workspace-test');
  assert.equal(result.launch.state, 'waiting_hook');
});
