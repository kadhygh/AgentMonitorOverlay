// Integration smoke against a running android-fixture.mjs. Only a readiness-file path crosses the environment.
// $env:AMO_ANDROID_FIXTURE_READY='<sandbox>/ready.json'; node --test scripts/android-fixture.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { HostService, Store, CodexRuntime } from '@amo-studio/host';
import { dpapi, saveAccount, setDeviceName } from '@amo-studio/account';

async function until(read, ok, label) {
  const end = Date.now() + 15000;
  for (;;) { const value = await read(); if (ok(value)) return value; if (Date.now() > end) throw new Error(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 80)); }
}
test('same account pairs, gets a task and sends a message through real remote services', { skip: !process.env.AMO_ANDROID_FIXTURE_READY, timeout: 45000 }, async () => {
  const ready = JSON.parse(readFileSync(process.env.AMO_ANDROID_FIXTURE_READY, 'utf8'));
  assert.equal(ready.modelMode, 'mock', 'This smoke must never run against a real model');
  const credentials = JSON.parse(await dpapi.unprotect(readFileSync(ready.credentialsFile, 'utf8')));
  const root = mkdtempSync(join(ready.root, 'smoke-peer-'));
  const env = { AMO_HOME: join(root, 'home'), AMO_LOCAL_HOME: join(root, 'local'), COMPUTERNAME: 'Android fixture smoke peer' };
  await saveAccount({ server: credentials.server, name: credentials.account, key: credentials.key }, { env });
  setDeviceName('Android fixture smoke peer', { env });
  const store = new Store(join(root, 'studio.db'));
  const servers = new EventEmitter();
  servers.ensure = async () => { throw new Error('Smoke peer must never start a local model'); };
  const service = new HostService(store, new CodexRuntime({ store, servers, profiles: [] }), [], { commonDir: join(root, 'common') });
  const command = async (path, body = {}) => {
    const response = await fetch(`${ready.controlUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.ok, true, `Fixture control ${path}`);
    return response.json();
  };
  try {
    service.remote.start({ env, watchMs: 100 });
    await service.remote.setEnabled(true);
    await until(() => service.remote.state(), s => s.connection.state === 'online', 'smoke online');
    await service.remote.requestPair(credentials.account, ready.device.id);
    await until(() => store.getTask(ready.taskId), Boolean, 'task copied');
    assert.equal(store.getTask(ready.taskId).remote.device, ready.device.id);
    await until(() => store.getSession(ready.sessionId), s => s && ['idle', 'completed'].includes(s.status), 'copied session idle');
    assert.equal(ready.files['large.txt'].size, 1048600);
    for (const [path, expected] of Object.entries(ready.files)) {
      const fetched = await service.remote.fetchFile(ready.taskId, path);
      const bytes = readFileSync(fetched.path);
      assert.equal(bytes.length, expected.size, `${path} transferred size`);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, `${path} transferred SHA-256`);
    }
    const absolute = await service.remote.fetchFile(ready.taskId, join(ready.workspace, 'sample.txt'));
    assert.equal(readFileSync(absolute.path, 'utf8'), 'Android fixture text\n');
    const withCwd = await service.remote.fetchFile(ready.taskId, '../sample.txt', join(ready.workspace, 'nested'));
    assert.equal(readFileSync(withCwd.path, 'utf8'), 'Android fixture text\n');
    const text = `Android fixture smoke ${Date.now()}`;
    await service.sessions.sendMessage(ready.sessionId, text);
    await until(() => store.listItems(ready.sessionId), items => items.some(i => i.type === 'agent' && i.markdown?.includes(`FAKE: ${text}`)), 'reply reaches smoke peer');
    assert.equal((await command('/assert-message', { text })).ok, true);
    await until(() => store.getSession(ready.sessionId), s => ['idle', 'completed'].includes(s.status), 'session idle before approval');
    await command('/approval');
    const approval = await until(() => store.listItems(ready.sessionId).find(i => i.type === 'approval' && i.state === 'pending'), Boolean, 'remote approval');
    await service.sessions.respondApproval(ready.sessionId, approval.approvalId, 'accept');
    await until(() => store.listItems(ready.sessionId), items => items.some(i => i.type === 'agent' && i.markdown === 'FAKE-RAN'), 'approval reply');
    await until(() => store.getSession(ready.sessionId), s => ['idle', 'completed'].includes(s.status), 'session idle before question');
    await command('/question');
    const question = await until(() => store.listItems(ready.sessionId).find(i => i.type === 'question' && i.state === 'pending'), Boolean, 'remote question');
    await service.sessions.answerQuestion(ready.sessionId, question.id, { action: 'answer', answers: [{ id: 'target', selected: [], other: 'Android smoke' }, { id: 'token', selected: [], other: 'fixture-placeholder' }] });
    await until(() => store.listItems(ready.sessionId), items => items.some(i => i.type === 'agent' && i.markdown?.includes('FAKE-ANSWERS:')), 'question reply');
    await command('/revoke');
    await until(() => store.getTask(ready.taskId), t => t?.remote?.state === 'revoked', 'grant revoked');
    await command('/regrant');
    await until(() => store.getTask(ready.taskId), t => t?.remote?.state === 'active', 'grant restored');
  } finally {
    const peer = service.remote.state().peers.find(p => p.device === ready.device.id);
    if (peer) await service.remote.unpair(peer).catch(() => undefined);
    service.remote.stop(); store.close();
  }
});
