// Isolated integration fixture. Run from studio: node scripts/android-fixture.mjs
// Requires built workspace packages and Node with node:sqlite (Node 24 recommended).
// adb reverse tcp:47970 tcp:47970; mobile uses http://127.0.0.1:47970.
// Safe readiness is printed; credentials are DPAPI protected, never printed.
import { EventEmitter } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { HostService, Store, CodexRuntime, CodexRpcClient, WindowsCredentialReader, StaticCredentialReader, RuntimeRouter } from '@amo-studio/host';
import { DshRuntime } from '../packages/host/dist/runtime/dsh/dsh-runtime.js';
import { resolveDsh } from '../packages/host/dist/runtime/dsh/install.js';
import { RelayStore, startRelayServer } from '@amo-studio/relay';
import { saveAccount, setDeviceName, dpapi } from '@amo-studio/account';
import { startFakeAppServer, reserveModelTurn, readBudget } from '@amo-studio/testkit';

const args = process.argv.slice(2);
const realDxx = args.includes('--real-dxx');
// 2026-10-31: a second task with a long, realistic session (hundreds of items: tool calls with long output, file
// diffs, Markdown with code and tables, a subagent, a pending approval and question) for the phone redesign.
const seedLong = args.includes('--seed-long');
const realTurnLimit = Number(option('--real-turn-limit', '5'));
if (!Number.isInteger(realTurnLimit) || realTurnLimit < 1 || realTurnLimit > 10) throw new Error('Real turn limit must be 1..10');
function option(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
const relayPort = Number(option('--port', '47970'));
const controlPort = Number(option('--control-port', '47971'));
for (const p of [relayPort, controlPort]) if (!Number.isInteger(p) || p < 47900 || p > 47999) throw new Error('Fixture ports must be in 47900..47999');
const parent = join(tmpdir(), 'amo-studio-sandbox');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'android-'));
const home = join(root, 'amo-home');
const workspace = join(root, 'workspace');
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, 'sample.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><h1>Android viewer fixture</h1><p>AMO remote file viewer.</p><button id="fixture-toggle" onclick="this.textContent='已切换'">切换状态</button><p><a href="nested/view.html">Nested page</a> <a href="sample.md">Markdown</a></p>`);
writeFileSync(join(workspace, 'sample.md'), '# Android viewer fixture\n\nRemote Markdown preview.\n\n![Fixture image](sample.png)\n\n[Nested Markdown](nested/readme.md)\n');
writeFileSync(join(workspace, 'sample.txt'), 'Android fixture text\n');
writeFileSync(join(workspace, 'sample.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64'));
mkdirSync(join(workspace, 'nested'), { recursive: true });
writeFileSync(join(workspace, 'nested', 'view.html'), '<!doctype html><meta charset="utf-8"><h1>Nested fixture page</h1><img src="../sample.png" alt="Nested fixture image"><p><a href="../sample.txt">Parent text</a> <a href="readme.md">Nested Markdown</a></p>');
writeFileSync(join(workspace, 'nested', 'readme.md'), '# Nested fixture Markdown\n\n![Parent image](../sample.png)\n\n[Parent text](../sample.txt)\n');
writeFileSync(join(workspace, 'large.txt'), Buffer.from('Android fixture large chunk 0123456789\n'.repeat(30000)).subarray(0, 1048600));
const fixtureFiles = Object.fromEntries(['sample.html', 'sample.md', 'sample.txt', 'sample.png', 'large.txt', 'nested/view.html', 'nested/readme.md'].map(path => {
  const bytes = readFileSync(join(workspace, path));
  return [path, { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }];
}));
// Set only this process's shared-file paths before constructing a Host; never inherit the desktop's account.
process.env.AMO_HOME = home;
process.env.AMO_LOCAL_HOME = join(root, 'amo-local');
process.env.AMO_STUDIO_DATA_DIR = join(root, 'data');
process.env.AMO_STUDIO_TEST = '1';
const env = { AMO_HOME: home, AMO_LOCAL_HOME: process.env.AMO_LOCAL_HOME, COMPUTERNAME: 'Android fixture host' };
let profiles = [{ id: 'android-mock', label: 'Android Mock', runtime: 'codex', provider: 'fixture', model: 'mock-model' }];
class FakeServers extends EventEmitter {
  handles = new Map();
  fakes = new Map();
  async ensure(profileId) {
    const known = this.handles.get(profileId);
    if (known?.client.isOpen) return known;
    let fake = this.fakes.get(profileId);
    if (!fake) { fake = await startFakeAppServer({ defaultProvider: 'fixture' }); this.fakes.set(profileId, fake); }
    const client = await CodexRpcClient.connect({ url: fake.url, token: fake.token });
    const handle = { profileId, url: fake.url, port: fake.port, token: fake.token, client };
    this.handles.set(profileId, handle); this.emit('ready', handle); return handle;
  }
  async close() { for (const h of this.handles.values()) h.client.close(); for (const f of this.fakes.values()) await f.close(); }
}
let relayStore, relay, store, service, timer, control, dsh;
let realTurns = 0;
let realBudgetProvider = null;
const servers = new FakeServers();
let closing = false;
async function close() {
  if (closing) return; closing = true; clearInterval(timer);
  service?.remote.stop();
  await dsh?.closeAll();
  await servers.close();
  await relay?.close(); relayStore?.close(); store?.close();
  control?.close();
}
process.once('SIGINT', () => void close().finally(() => process.exit(0)));
process.once('SIGTERM', () => void close().finally(() => process.exit(0)));
async function until(read, ok, label, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) { const value = read(); if (ok(value)) return value; if (Date.now() > end) throw new Error(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 50)); }
}
try {
  const account = `android-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const password = randomBytes(24).toString('base64url');
  let server = option('--server', null), key;
  if (server) {
    if (server !== 'http://172.16.8.85:47120') throw new Error('Only the explicitly supported team test server is allowed');
    const response = await fetch(`${server}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: account, password, role: 'Android integration fixture' }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Fixture account registration failed: HTTP ${response.status}`);
    key = (await response.json()).key;
    if (typeof key !== 'string') throw new Error('Registration returned no key');
  } else {
    relayStore = new RelayStore(join(root, 'relay.db'));
    relay = await startRelayServer({ store: relayStore, host: '127.0.0.1', port: relayPort, name: 'Android integration fixture' });
    server = relay.url;
    key = relayStore.register(account, password).key;
  }
  await saveAccount({ server, name: account, key }, { env });
  setDeviceName('Android fixture host', { env });
  const credentialsFile = join(root, 'credentials.dpapi');
  writeFileSync(credentialsFile, await dpapi.protect(JSON.stringify({ server, account, name: account, password, key })), { mode: 0o600 });
  store = new Store(join(root, 'data', 'studio.db'));
  let runtime;
  if (realDxx) {
    // Read the selected channel through the existing Host API; never open or write its database.
    const sourceDir = option('--source-data-dir', fileURLToPath(new URL('../.data/', import.meta.url)));
    const info = JSON.parse(readFileSync(join(sourceDir, 'host.json'), 'utf8'));
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(info.url)) throw new Error('Source Host must be loopback HTTP');
    const token = readFileSync(join(sourceDir, 'host-token'), 'utf8').trim();
    const read = async path => {
      const response = await fetch(info.url + path, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Read-only source Host metadata unavailable');
      return response.json();
    };
    const state = await read('/api/state');
    const matches = state.profiles.filter(p => p.label === 'Dxx-DS' && p.runtime === 'dsh');
    if (matches.length !== 1) throw new Error('Exactly one Dxx-DS DSH profile is required');
    const profile = matches[0];
    const channel = (await read('/api/channels')).find(c => c.id === profile.id && c.label === 'Dxx-DS' && c.kind === 'dsh');
    if (!channel || !profile.credentialId || !profile.model || profile.provider !== channel.id) throw new Error('Dxx-DS channel metadata mismatch');
    const reader = new WindowsCredentialReader();
    const secret = reader.read(profile.credentialId);
    if (!secret) throw new Error('Dxx-DS credential is unavailable');
    profiles = [{ ...profile, hidden: false }];
    const launch = resolveDsh(store);
    if ('error' in launch) throw new Error('Installed DSH is unavailable');
    dsh = new DshRuntime({ store, profiles, credentials: new StaticCredentialReader({ [profile.credentialId]: secret }), providers: { [profile.provider]: { baseUrl: channel.baseUrl, ...(channel.models?.length ? { models: channel.models } : {}) } }, dir: join(root, 'dsh'), folderAccess: null });
    // Fixture-local hooks constrain all mobile-created sessions and count the actual prompt boundary, including queues.
    const start = dsh.startSession.bind(dsh);
    dsh.startSession = input => {
      if (input.profileId !== profile.id || resolve(input.workspace.path) !== resolve(workspace)) throw new Error('Real fixture is confined to its project');
      return start({ ...input, options: { ...(input.options ?? {}), model: profile.model, permission: 'read-only', effort: 'low' } });
    };
    const setOptions = dsh.setOptions.bind(dsh);
    dsh.setOptions = (id, options) => setOptions(id, { ...options, model: profile.model, permission: 'read-only', effort: 'low' });
    const prompt = dsh.prompt.bind(dsh);
    realBudgetProvider = readBudget().providers['dsh-dxx-ds'] ? 'dsh-dxx-ds' : 'deepseek';
    dsh.prompt = (...values) => {
      if (realTurns >= realTurnLimit) throw new Error('Fixture real-model turn cap reached');
      reserveModelTurn(realBudgetProvider, 'Android fixture Dxx-DS isolated remote smoke');
      realTurns += 1;
      return prompt(...values);
    };
    runtime = new RuntimeRouter(store, profiles, { dsh });
  } else runtime = new CodexRuntime({ store, servers, profiles });
  service = new HostService(store, runtime, profiles, { commonDir: join(root, 'common'), localClaudeHome: join(root, 'claude-home') });
  const project = service.projects.addWorkspace({ path: workspace, name: 'Android fixture project' });
  service.remote.start({ env, watchMs: 100 });
  await service.remote.setEnabled(true);
  await until(() => service.remote.state(), s => s.connection.state === 'online', 'host online');
  service.remote.setAllowed({ profiles: [profiles[0].id], defaultProfile: profiles[0].id, permission: realDxx ? 'read-only' : 'write' });
  service.remote.setAllowedProjects({ workspaceIds: [project.id], common: false });
  service.remote.setSecurity({ sameAccount: 'run', otherAccount: 'confirm' });
  const { task, session } = await service.tasks.createTask({ title: 'Android integration fixture', workspaceId: project.id, firstSession: { profileId: profiles[0].id, text: realDxx ? 'Reply exactly ANDROID-DXX-OK. Do not use tools.' : 'Android fixture ready. Files: `sample.html`, `sample.md`, `sample.png`, `sample.txt`, `large.txt`, `nested/view.html`, `nested/readme.md`.' } });
  await until(() => store.listItems(session.id), items => items.some(i => i.type === 'agent' && i.markdown?.includes(realDxx ? 'ANDROID-DXX-OK' : 'FAKE: Android fixture ready')), 'initial model reply', realDxx ? 180000 : 15000);
  const long = seedLong ? seedLongTask(service, store, project.id, profiles[0].id) : null;
  const granted = new Set();
  let pairing = false;
  timer = setInterval(async () => {
    if (pairing || closing) return; pairing = true;
    try {
      for (const request of service.remote.state().incoming) if (request.account === account) await service.remote.answer(request.id, true);
      for (const peer of service.remote.state().peers) if (peer.account === account && peer.role === 'owner' && !granted.has(peer.device)) {
        service.remote.grant(task.id, peer); if (long) service.remote.grant(long.task.id, peer); granted.add(peer.device);
      }
    } catch { /* State changes race with mobile disconnect; retry on the next tick. */ }
    finally { pairing = false; }
  }, 200);
  const status = () => ({ ok: true, pid: process.pid, root, server, account, modelMode: realDxx ? 'real-dxx' : 'mock', profileId: profiles[0].id, model: profiles[0].model, realTurns, realTurnLimit: realDxx ? realTurnLimit : 0, realBudgetProvider, ...(realDxx ? { permission: 'read-only', initialReplyVerified: true, initialPrompt: 'Reply exactly ANDROID-DXX-OK. Do not use tools.', fixedModel: true, fixedWorkspace: true, mcpEnabled: false } : {}), device: service.remote.state().device, connection: service.remote.state().connection.state, peers: service.remote.state().peers, taskId: task.id, sessionId: session.id, ...(long ? { longTaskId: long.task.id, longSessionId: long.session.id, longItems: store.listItems(long.session.id).length } : {}), workspaceId: project.id, workspace, files: fixtureFiles, credentialsFile, controlUrl: `http://127.0.0.1:${controlPort}` });
  control = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/status') return res.end(JSON.stringify(status()));
      if (req.method !== 'POST') { res.statusCode = 404; return res.end('{}'); }
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 65536) throw new Error('Body too large'); }
      const body = raw ? JSON.parse(raw) : {};
      if (path === '/shutdown') { res.end('{"ok":true}'); setTimeout(() => void close().finally(() => process.exit(0)), 50); return; }
      if (path === '/reconnect') { await service.remote.setEnabled(false); setTimeout(() => void service.remote.setEnabled(true), 1200); }
      else if (path === '/revoke' || path === '/regrant') {
        for (const peer of service.remote.state().peers.filter(p => p.account === account && p.role === 'owner')) {
          if (path === '/revoke') service.remote.revoke(task.id, peer); else service.remote.grant(task.id, peer);
        }
      } else if (path === '/approval' || path === '/question' || path === '/message') {
        if (realDxx && path !== '/message') throw new Error('Synthetic controls require mock mode');
        await service.sessions.sendMessage(session.id, path === '/approval' ? '[[shell: echo Android fixture approval]]' : path === '/question' ? '[[ask]]' : String(body.text ?? 'Android fixture message'));
      } else if (path === '/stream') {
        // A long streamed reply in the long session: many small deltas, as a model sends them.
        if (!long) throw new Error('Start the fixture with --seed-long');
        void streamReply(service, store, long.session.id, Number(body.chars ?? 4000), Number(body.every ?? 30));
      } else if (path === '/assert-message') {
        if (typeof body.text !== 'string' || !body.text) throw new Error('A nonempty message is required');
        const found = store.listItems(session.id).some(i => (i.text ?? i.markdown ?? '').includes(String(body.text)));
        if (!found) res.statusCode = 409;
        return res.end(JSON.stringify({ ok: found }));
      } else { res.statusCode = 404; return res.end('{}'); }
      res.end('{"ok":true}');
    } catch { res.statusCode = 400; res.end('{"ok":false,"error":"Fixture command failed"}'); }
  });
  await new Promise((resolve, reject) => { control.once('error', reject); control.listen(controlPort, '127.0.0.1', resolve); });
  const readinessFile = join(root, 'ready.json');
  writeFileSync(readinessFile, JSON.stringify(status(), null, 2));
  console.log(JSON.stringify({ ...status(), readinessFile }));
} catch (error) {
  await close();
  console.error(`Android fixture failed: ${error instanceof Error ? error.message : 'startup error'}`);
  process.exitCode = 1;
}

function seedLongTask(service, store, workspaceId, profileId) {
  const task = store.createTask({ title: '手机端改版：长会话（模拟）', workspaceId, column: 'doing' });
  const base = { taskId: task.id, topicId: null, workspaceId, profileId, runtime: 'codex', writer: 'workbench', parentId: null, kind: 'main', status: 'awaiting-approval', runtimeRef: null, title: '重做手机端对话页' };
  const session = store.createSession(base);
  const sub = store.createSession({ ...base, parentId: session.id, kind: 'sub', status: 'completed', title: '子代理：查 Markdown 渲染' });
  const at = (n) => new Date(Date.UTC(2026, 9, 31, 8, 0, 0) + n * 1000).toISOString();
  let n = 0;
  const add = (item) => store.appendItem({ id: `long-${++n}`, sessionId: session.id, createdAt: at(n), ...item });
  const code = Array.from({ length: 18 }, (_, i) => `  const value${i} = compute(${i}, options.veryLongArgumentNameThatOverflowsAPhoneScreen);`).join('\n');
  const output = Array.from({ length: 120 }, (_, i) => `PASS packages/ui/src/chat/item-${i}.test.ts (${(i * 37) % 900} ms)`).join('\n');
  const diff = ['@@ -10,7 +10,9 @@', ' import { Item } from "./item";', '-const old = render(items);', '+const grouped = groupTurns(items);', '+const rows = grouped.map(toRow);', '+return rows;', ' export default view;'].join('\n');
  const names = { read: 'Read', search: 'Grep', command: 'Bash', edit: 'Edit', list: 'Glob' };
  for (let turn = 1; turn <= 24; turn++) {
    add({ type: 'user', text: turn === 1 ? '把手机端对话页重做一遍：工具调用收起来，Markdown 渲染完整，输入框改小。' : `第 ${turn} 步：继续，顺便检查一下第 ${turn - 1} 步的改动有没有问题。` });
    add({ type: 'reasoning', text: `先看一下现在的实现，再决定第 ${turn} 步怎么拆。`.repeat(3), streaming: false, durationMs: 4200 });
    const tools = 6 + (turn % 9);
    for (let i = 0; i < tools; i++) {
      const kind = ['read', 'search', 'command', 'edit', 'list'][i % 5];
      const failed = turn % 7 === 0 && i === 2;
      const summary = kind === 'command' ? 'npx vitest run packages/ui/src/chat --maxWorkers=6' : kind === 'edit' ? `packages/ui/src/chat/turn-${turn}.ts` : kind === 'read' ? `packages/ui/src/chat/item-${i}.ts` : kind === 'search' ? 'groupTurns' : 'packages/ui/src/**/*.ts';
      add({ type: 'tool', name: names[kind], kind, summary, status: failed ? 'failed' : 'completed', input: JSON.stringify({ path: `packages/ui/src/chat/item-${i}.ts`, pattern: 'groupTurns' }), detail: kind === 'command' ? output : kind === 'read' ? code : 'ok', ...(kind === 'command' ? { exitCode: failed ? 1 : 0, durationMs: 8123 } : {}), ...(kind === 'edit' ? { files: [{ path: `packages/ui/src/chat/turn-${turn}.ts`, change: 'update', added: 3, removed: 1, diff }] } : {}) });
    }
    add({ type: 'agent', streaming: false, markdown: [`## 第 ${turn} 步做完了`, '', '改了这些：', '', '1. **工具调用**收成一行，点开再看；', '2. 代码块整块显示，可以横向滚动；', '   - 长行不折行', '   - 用等宽字体', '3. 输入框默认一行。', '', '> 注意：`groupTurns` 只按用户消息分轮。', '', '| 文件 | 改动 | 说明 |', '|---|---|---|', `| \`turn-${turn}.ts\` | +3 −1 | 分组 |`, '| `item.ts` | +12 −4 | 条目类型 |', '', '```ts', code, '```', '', `详情见 [turn-${turn}.ts](packages/ui/src/chat/turn-${turn}.ts)，*斜体* 也要能显示。`].join('\n') });
    if (turn === 12) add({ type: 'subagent', childSessionId: sub.id, summary: '查了三种 Markdown 渲染方式，建议自己写块级解析。' });
    if (turn === 16) add({ type: 'compaction', state: 'completed', trigger: 'auto', beforeTokens: 182000, afterTokens: 41000 });
    if (turn === 18) add({ type: 'notice', level: 'warning', message: '模型额度用了 80%。' });
    add({ type: 'turn', turnId: `t-${turn}`, state: turn % 7 === 0 ? 'failed' : 'completed', startedAt: at(n), endedAt: at(n + 1), ...(turn % 7 === 0 ? { error: '有一个测试没过（模拟）。' } : {}) });
  }
  add({ type: 'user', text: '最后跑一遍全部测试，然后告诉我结果。' });
  add({ type: 'tool', name: 'Bash', kind: 'command', summary: 'npm run verify', status: 'running', input: '{"command":"npm run verify"}', detail: output.slice(0, 2000) });
  add({ type: 'approval', approvalId: 'long-approval', kind: 'command', summary: 'git push origin master', detail: 'git push origin master && npm run release -- auto --skip-tests --channel test --notes "手机端改版，第一版，带一段很长的说明，看看手机上会不会折行或者撑破卡片的宽度"', state: 'pending' });
  add({ type: 'question', source: 'claude-ask', state: 'pending', questions: [{ id: 'q1', header: '发布', question: '测试过了，要现在发测试包吗？', multiSelect: false, options: [{ label: '现在发', description: '发到测试通道' }, { label: '等一下', description: '先不发' }] }] });
  store.appendItem({ id: 'long-sub-1', sessionId: sub.id, createdAt: at(1), type: 'agent', streaming: false, markdown: '子代理的结论：**自己写块级解析**最省事。' });
  return { task, session, sub };
}

async function streamReply(service, store, sessionId, chars, every) {
  const item = store.appendItem({ id: `stream-${Date.now()}`, sessionId, createdAt: new Date().toISOString(), type: 'agent', streaming: true, markdown: '' });
  service.publish({ type: 'item.appended', item });
  const text = '这是一段模拟的流式回复，用来测手机端在模型一个字一个字回复时卡不卡。'.repeat(Math.ceil(chars / 34)).slice(0, chars);
  let markdown = '';
  for (let i = 0; i < text.length; i += 6) {
    const append = text.slice(i, i + 6);
    markdown += append;
    service.publish({ type: 'item.delta', sessionId, itemId: item.id, append });
    await new Promise((r) => setTimeout(r, every));
  }
  service.publish({ type: 'item.updated', item: store.replaceItem({ ...item, markdown, streaming: false }) });
}
