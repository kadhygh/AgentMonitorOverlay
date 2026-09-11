// Real Focus UI + isolated Broker. Native window ports are simulated: this does
// not validate Windows transparency, z-order, mouse passthrough or CLI focus.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { build } = require('../../overlay/node_modules/esbuild');
const { chromium } = require(process.env.AMO_PLAYWRIGHT_MODULE || 'playwright');
const repo = path.resolve(__dirname, '../..');
fs.mkdirSync(path.join(repo, 'tmp'), { recursive: true });
const root = fs.mkdtempSync(path.join(repo, 'tmp', 'focus-manual-smoke-'));
const output = path.join(root, 'build');
const syntheticWorkspace = path.join(root, 'synthetic-workspace');
const syntheticSession = { sessionId: 'focus-smoke-session', tool: 'codex', title: 'Synthetic TaskCard for Focus',
  state: 'idle', workspaceId: 'focus-smoke-workspace', workspacePath: syntheticWorkspace, cwd: syntheticWorkspace,
  archived: false, updatedAt: '2026-09-11T00:00:00.000Z', createdAt: '2026-09-11T00:00:00.000Z' };
const evidence = [], errors = [], requests = [];
let broker, browser, page, log = '';

const native = `
const label=new URL(location.href).searchParams.get('surface')==='main'?'main':'focus';
const listeners=window.__nativeListeners??=new Map();
const channel=window.__nativeChannel??=new BroadcastChannel('focus-smoke-native');
function deliver(event){if(event.target!==label)return;for(const fn of listeners.get(event.name)||[])fn({payload:event.payload});}
channel.onmessage=event=>deliver(event.data);
export async function listen(name,fn){const set=listeners.get(name)||new Set();set.add(fn);listeners.set(name,set);return()=>set.delete(fn);}
async function emitTo(target,name,payload){const event={target,name,payload};deliver(event);channel.postMessage(event);}
export const emit=(name,payload)=>emitTo(label,name,payload);
function win(name){return {label:name,listen,emitTo,async show(){localStorage.setItem('window.'+name,'visible');},async hide(){localStorage.setItem('window.'+name,'hidden');},async isVisible(){return localStorage.getItem('window.'+name)==='visible';},async unminimize(){},async setAlwaysOnTop(){},async setFocus(){},async startDragging(){},async onCloseRequested(){return()=>{};}};}
export const getCurrentWindow=()=>win(label);
export const getCurrentWebviewWindow=()=>win(label);
export const invoke=async(name,args)=>{(window.__nativeInvokes??=[]).push({name,args});return null;};
export const openUrl=async()=>{throw new Error('External URLs are forbidden in this isolated smoke');};
export const openPath=openUrl;
export const revealItemInDir=openUrl;
export class Window {static async getByLabel(name){return localStorage.getItem('window.'+name)?win(name):null;}}
export class WebviewWindow extends Window {constructor(name,options){super();localStorage.setItem('window.'+name,options.visible?'visible':'hidden');return {...win(name),async once(event,fn){if(event==='tauri://created')queueMicrotask(fn);}};}}
`;
const fixture = `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import './overlay/src/styles.css';
import {FocusPanelApp} from './overlay/src/windows/FocusPanelApp';
import {useFocusPanelWindow} from './overlay/src/hooks/useFocusPanelWindow';
import {TaskCard} from './overlay/src/components/TaskCard';
import {TaskCardFocusPicker} from './overlay/src/components/TaskCardFocusPicker';
const session=${JSON.stringify(syntheticSession)};
function Main(){const panel=useFocusPanelWindow(()=>{});const [adding,setAdding]=useState(false);const [added,setAdded]=useState('');
const forbidden=()=>{throw new Error('Unrelated TaskCard command is forbidden');};
const commands={addToFocus:()=>setAdding(true),openNote:forbidden,openVSCode:forbidden,openCanvas:forbidden,markReviewed:forbidden,unbindWindow:forbidden,archive:forbidden,dismiss:forbidden,openApp:forbidden,activate:forbidden,resume:forbidden,handleAttention:forbidden,openLaunchPanel:forbidden,openWorkspacePanel:forbidden,startWindowBindDrag:forbidden};
return <><button role="switch" aria-label="Focus Panel" aria-checked={panel.focusPanelVisible} disabled={panel.focusPanelBusy} onClick={()=>panel.toggleFocusPanel()}>Focus Panel</button>
<TaskCard session={session} commands={commands} activating={false} openingTarget={null} openingVSCode={false} unbindingWindow={false} archiving={false} reviewing={false} dismissing={false} attentionSignal={false} attentionVisualActive={false} windowBindDragging={false}/>
<output>{added}</output>{adding?<TaskCardFocusPicker session={session} focusPanelBusy={false} onOpenFocus={()=>panel.toggleFocusPanel()} onClose={()=>setAdding(false)} onAdded={name=>{setAdded('Added to '+name);setAdding(false);}}/>:null}</>;}
createRoot(document.getElementById('root')).render(new URL(location.href).searchParams.get('surface')==='main'?<Main/>:<FocusPanelApp/>);
`;

async function start(port) {
  log = '';
  broker = spawn(process.execPath, [path.join(repo, 'broker/server.js')], {
    cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_MONITOR_HOST: '127.0.0.1', AGENT_MONITOR_PORT: String(port),
      AGENT_MONITOR_DATA_FILE: path.join(root, 'sessions.json'),
      AGENT_MONITOR_WORKSPACE_DATA_FILE: path.join(root, 'workspaces.json'),
      AGENT_MONITOR_LAUNCH_DATA_FILE: path.join(root, 'launches.json'),
      AGENT_MONITOR_TASK_CANVAS_DATA_FILE: path.join(root, 'canvas.json'),
      AGENT_MONITOR_CARDS_DATA_FILE: path.join(root, 'cards.json'),
    },
  });
  broker.stderr.on('data', data => log += data);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(log || 'Broker startup timeout')), 10000);
    broker.on('error', error => { clearTimeout(timer); reject(error); });
    broker.stdout.on('data', data => { log += data; if (log.includes('listening at')) { clearTimeout(timer); resolve(); } });
  });
}
async function stop() {
  if (broker && broker.exitCode === null) {
    const stopped = new Promise(resolve => broker.once('exit', resolve));
    broker.kill(); await stopped;
  }
}
async function eventually(read, check, description) {
  const until = Date.now() + 10000;
  let value;
  do { value = await read(); if (check(value)) return value; await new Promise(resolve => setTimeout(resolve, 80)); } while (Date.now() < until);
  assert.fail(`${description}: ${JSON.stringify(value)}`);
}

async function main() {
  fs.mkdirSync(path.join(syntheticWorkspace, '.amo'), { recursive: true });
  fs.writeFileSync(path.join(syntheticWorkspace, '.amo', 'workspace.json'), JSON.stringify({ workspaceId: syntheticSession.workspaceId,
    projectName: 'Synthetic smoke only', vaultRoot: path.join(root, 'synthetic-vault') }));
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify({ sessions: [syntheticSession] }));
  fs.writeFileSync(path.join(root, 'focus-cards.json'), 'obsolete Focus fixture; do not read, migrate or delete');
  await build({ stdin: { contents: fixture, resolveDir: repo, loader: 'tsx' }, bundle: true,
    outdir: output, entryNames: 'app', platform: 'browser', format: 'iife', jsx: 'automatic',
    nodePaths: [path.join(repo, 'overlay/node_modules')], define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.png': 'dataurl', '.svg': 'dataurl' }, plugins: [{ name: 'native', setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\// }, () => ({ path: 'native', namespace: 'native' }));
      builder.onLoad({ filter: /.*/, namespace: 'native' }, () => ({ contents: native, loader: 'js' }));
    } }],
  });
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  await start(port);
  const url = `http://127.0.0.1:${port}`;
  const get = async route => { const response = await fetch(url + route); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  const post = async (route, body) => { const response = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  const read = async () => { const data = await get('/api/focus-panel?includeArchived=1'); assert.equal(data.schemaVersion, 2); return data.cards; };
  const find = async title => (await read()).find(card => card.title === title);
  const core = async id => (await get('/api/cards/' + id)).card;
  const registry = () => get('/api/card-groups');
  assert.deepEqual((await registry()).groups, []);
  const originalCards = await read();
  assert.equal(originalCards.length, 1);
  assert.equal(originalCards[0].groupId, null);

  browser = await chromium.launch({ headless: true, channel: process.env.AMO_SMOKE_BROWSER_CHANNEL || 'msedge' });
  const context = await browser.newContext({ viewport: { width: 980, height: 760 } });
  let gets = 0, loseNext = false;
  context.on('page', p => p.on('pageerror', error => errors.push(error.message)));
  // Every request is accounted for. The production port is rewritten before any
  // network I/O; no other external host, session mutation or native command runs.
  await context.route('**/*', async route => {
    const request = route.request(), parsed = new URL(request.url());
    if (parsed.origin === 'http://tauri.localhost') {
      const pathname = parsed.pathname;
      return ['/app.js', '/app.css'].includes(pathname)
        ? route.fulfill({ status: 200, contentType: pathname.endsWith('js') ? 'text/javascript' : 'text/css', body: fs.readFileSync(path.join(output, pathname.slice(1))) })
        : route.fulfill({ status: 200, contentType: 'text/html', body: '<html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>' });
    }
    if (parsed.origin !== 'http://127.0.0.1:17654') { errors.push('Unexpected request: ' + request.url()); return route.abort('blockedbyclient'); }
    requests.push({ method: request.method(), path: parsed.pathname });
    if (request.method() !== 'GET' && !/^\/api\/(cards(?:\/from-session|\/[^/]+\/commands)?|card-groups\/commands)$/.test(parsed.pathname)) {
      errors.push('Forbidden mutation: ' + parsed.pathname); return route.abort('blockedbyclient');
    }
    if (request.method() === 'GET' && parsed.pathname === '/api/focus-panel') gets++;
    const response = await route.fetch({ url: url + parsed.pathname + parsed.search });
    if (loseNext && request.method() === 'POST' && /^\/api\/cards\/[^/]+\/commands$/.test(parsed.pathname)) { loseNext = false; return route.abort('failed'); }
    await route.fulfill({ response });
  });
  const mainPage = await context.newPage(); await mainPage.goto('http://tauri.localhost/?surface=main');
  const toggle = mainPage.getByRole('switch', { name: 'Focus Panel' }); await toggle.click();
  await eventually(() => toggle.getAttribute('aria-checked'), value => value === 'true', 'main toggle opens');
  page = await context.newPage(); await page.goto('http://tauri.localhost/');
  await page.getByTestId('focus-panel').waitFor();
  assert.equal(await page.getByRole('button', { name: '新建卡片', exact: true }).count(), 0);
  const refresh = () => page.getByRole('button', { name: '刷新', exact: true }).click();
  const detail = () => page.getByRole('dialog', { name: '任务详情', exact: true });
  const settings = () => page.getByRole('dialog', { name: '分组设置', exact: true });
  const listing = () => page.getByRole('dialog', { name: '全部分组', exact: true });
  const lane = id => page.locator(`[data-testid="focus-group"][data-group-id="${id}"]`);
  const cardButton = id => page.locator(`[data-testid="focus-card"][data-card-id="${id}"]`);
  const closeDialog = async dialog => { await dialog.getByRole('button', { name: /关闭/ }).first().click(); await dialog.waitFor({ state: 'hidden' }); };
  const showSettings = () => page.getByRole('button', { name: '分组设置', exact: true }).click();
  const showList = () => page.getByRole('button', { name: '全部分组', exact: true }).click();
  await showSettings();
  for (const name of ['待我梳理', '有空处理', '已完成']) {
    await settings().getByRole('textbox', { name: '新分组名称', exact: true }).fill(name);
    await settings().getByRole('button', { name: '添加分组', exact: true }).click();
    await eventually(registry, data => data.groups.some(group => group.name === name), 'created group ' + name);
  }
  const groups = (await registry()).groups;
  const active = groups.find(group => group.name === '待我梳理'), later = groups.find(group => group.name === '有空处理'), done = groups.find(group => group.name === '已完成');
  const settingRow = id => settings().locator(`[data-testid="focus-group-setting"][data-group-id="${id}"]`);
  await settingRow(done.groupId).getByRole('textbox', { name: '分组名称', exact: true }).fill('尚未保存的名称草稿');
  await settingRow(done.groupId).getByRole('checkbox', { name: '仅拖拽时显示（立即保存）', exact: true }).check();
  await eventually(registry, data => data.groups.find(group => group.groupId === done.groupId)?.dragOnly === true, 'saved hidden group');
  assert.equal((await registry()).groups.find(group => group.groupId === done.groupId).name, done.name);
  assert.equal(await settingRow(done.groupId).getByRole('textbox', { name: '分组名称', exact: true }).inputValue(), '尚未保存的名称草稿');
  await closeDialog(settings());
  assert.equal(await lane(done.groupId).isVisible(), false);
  evidence.push('Empty registry has no prescribed status categories. Settings create stable-ID groups and persist a drag-only group.');

  const create = async (title, note, groupId) => {
    // New-card UI is deliberately disabled. Independent cards remain valid data
    // and are fixtures for the existing editing/drag/durability regressions.
    await post('/api/cards', { operationId: randomUUID(), title, components: [
      { componentId: 'processing', type: 'amo.processing', schemaVersion: 1, data: { sourceComponentId: null, state: 'pending' } },
      { componentId: 'notes', type: 'amo.notes', schemaVersion: 1, data: { text: note } },
      { componentId: 'task-group', type: 'amo.task-group', schemaVersion: 1, data: { groupId } },
    ] });
    await refresh();
    const created = await eventually(() => find(title), Boolean, 'created ' + title);
    if (await detail().isVisible()) await closeDialog(detail());
    assert.equal(created.groupId, groupId); assert.equal(created.session, null); assert.equal(created.conversation, null);
    assert.equal(created.triage.note, note);
    const saved = await core(created.cardId);
    assert.ok(saved.components.every(component => !['amo.session', 'amo.conversation'].includes(component.type)));
    return created;
  };
  const first = await create('梳理 Focus 面板基础体验', '独立测试卡：不关联任何会话。', active.groupId);
  const second = await create('检查透明底在明亮桌面上的阅读效果', '有空再处理。', later.groupId);
  const archived = await create('留存已完成的实验记录', '用于验证隐藏组与归档数据。', done.groupId);
  assert.equal(await cardButton(archived.cardId).isVisible(), false);
  assert.equal(await cardButton(first.cardId).innerText(), first.title);
  await cardButton(first.cardId).click(); await detail().waitFor();
  assert.equal((await find(first.title)).triage.state, first.triage.state);
  assert.equal((await find(first.title)).groupId, active.groupId);
  assert.equal(await detail().getByRole('button', { name: /返回对话|Open CLI|Open app|Resume|绑定/ }).count(), 0);
  await detail().getByRole('textbox', { name: '卡片标题', exact: true }).fill('梳理 Focus 的日常操作');
  await detail().getByRole('textbox', { name: '工作备注', exact: true }).fill('保存标题、备注和人工分组。');
  await detail().getByLabel('Task group', { exact: true }).selectOption(later.groupId);
  await detail().getByRole('button', { name: '保存卡片', exact: true }).click();
  const edited = await eventually(() => find('梳理 Focus 的日常操作'), card => card?.groupId === later.groupId && card.triage.note === '保存标题、备注和人工分组。', 'detail atomic save');
  assert.equal(edited.triage.state, first.triage.state);
  await closeDialog(detail());
  evidence.push('New-card UI is absent. API-only independent-card fixtures show title-only tiles and save title/note/group through real detail controls without changing processing state.');

  await cardButton(second.cardId).click({ button: 'right' });
  await page.getByRole('menu', { name: '移至分组', exact: true }).getByRole('menuitem', { name: active.name, exact: true }).click();
  await eventually(() => find(second.title), card => card?.groupId === active.groupId, 'right-click move');
  assert.equal((await find(second.title)).triage.state, second.triage.state);
  evidence.push('Right-click group menu moves a card manually without opening detail or changing its processing state.');

  // Native HTML drag is exercised with real pointer movement. The target does
  // not exist until dragstart; synthetic dispatch would miss that regression.
  const source = cardButton(first.cardId), box = await source.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 18, box.y + box.height / 2 + 12, { steps: 6 });
  await lane(done.groupId).waitFor({ state: 'visible' });
  const target = await lane(done.groupId).boundingBox();
  assert.ok(target);
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 15 });
  await page.mouse.move(target.x + target.width / 2 + 2, target.y + target.height / 2 + 2);
  await page.mouse.up();
  await eventually(() => find(edited.title), card => card?.groupId === done.groupId, 'actual drag moved group');
  await lane(done.groupId).waitFor({ state: 'hidden' });
  assert.equal(await page.getByText('分组已更新', { exact: true }).count(), 0);
  assert.equal((await find(edited.title)).triage.state, first.triage.state);
  await showList(); await listing().getByText(edited.title, { exact: true }).click(); await detail().waitFor();
  assert.equal(await detail().getByRole('textbox', { name: '工作备注', exact: true }).inputValue(), '保存标题、备注和人工分组。');
  await closeDialog(detail());
  if (await listing().isVisible()) await closeDialog(listing());
  evidence.push('Real browser drag reveals hidden lanes, drops a card into one, and hides it afterward. All-groups list retrieves the hidden card.');

  await showList(); await listing().getByText(archived.title, { exact: true }).click();
  await detail().getByRole('button', { name: '归档 Card', exact: true }).click();
  await eventually(() => find(archived.title), card => !!card?.archivedAt, 'archived card');
  if (await detail().isVisible()) await closeDialog(detail());
  if (await listing().isVisible()) await closeDialog(listing());
  await showSettings();
  await settingRow(done.groupId).getByRole('textbox', { name: '分组名称', exact: true }).fill('完成记录');
  await settingRow(done.groupId).getByRole('button', { name: '保存名称', exact: true }).click();
  await eventually(registry, data => data.groups.find(group => group.groupId === done.groupId)?.name === '完成记录', 'rename retains ID');
  assert.equal((await find(edited.title)).groupId, done.groupId);
  assert.equal((await find(archived.title)).groupId, done.groupId);
  // Both inline confirmation and a browser confirm are supported by the UI.
  page.on('dialog', dialog => dialog.accept());
  await settingRow(done.groupId).getByRole('button', { name: '删除分组', exact: true }).click();
  const confirmDelete = page.getByRole('button', { name: /^确认删除/ });
  if (await confirmDelete.isVisible()) await confirmDelete.click();
  await eventually(registry, data => !data.groups.some(group => group.groupId === done.groupId), 'delete group');
  for (const title of [edited.title, archived.title]) {
    const card = await find(title); assert.equal(card.groupId, null);
    assert.equal((await core(card.cardId)).components.find(component => component.type === 'amo.task-group')?.data.groupId, null);
  }
  assert.ok((await find(archived.title)).archivedAt);
  await closeDialog(settings());
  evidence.push('Renaming preserves group identity. Deleting clears active and archived card references while retaining cards, notes and archive state.');
  await showList();
  assert.equal(await listing().getByText(archived.title, { exact: true }).count(), 0);
  assert.equal(await listing().getByText(edited.title, { exact: true }).count(), 0);
  assert.equal(await listing().getByText('未分组', { exact: true }).count(), 0);
  await closeDialog(listing());
  assert.equal(await cardButton(first.cardId).count(), 0);
  evidence.push('Cleared group references stay stored but do not create an automatic Ungrouped lane or list.');
  // Explicit assignment through the Card API makes retained records visible again.
  for (const id of [first.cardId, archived.cardId]) {
    const saved = await core(id), membership = saved.components.find(component => component.type === 'amo.task-group');
    await post('/api/cards/' + id + '/commands', { operationId: randomUUID(), expectedRevision: saved.revision, commands: [{ type: 'set-component', component: { ...membership, data: { groupId: later.groupId } } }] });
  }
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await cardButton(first.cardId).waitFor();
  await showList(); await listing().getByText(archived.title, { exact: true }).click();
  await detail().getByRole('button', { name: '恢复 Card', exact: true }).click();
  const restored = await eventually(() => find(archived.title), card => card?.archivedAt === null, 'restore archived card');
  assert.equal(restored.groupId, later.groupId); assert.equal(restored.triage.note, archived.triage.note);
  await closeDialog(detail());
  await cardButton(archived.cardId).waitFor();
  evidence.push('All-groups list exposes archived cards only in configured groups; restoring preserves the explicit group and note.');

  await cardButton(first.cardId).click();
  const note = () => detail().getByRole('textbox', { name: '工作备注', exact: true });
  await note().fill('草稿在隐藏再显示后继续保留');
  await closeDialog(detail());
  await page.getByRole('button', { name: '关闭 Focus Panel', exact: true }).click();
  await eventually(() => toggle.getAttribute('aria-checked'), value => value === 'false', 'close updates main switch');
  await page.waitForTimeout(300); const hiddenGets = gets; await page.waitForTimeout(4500);
  assert.equal(gets, hiddenGets);
  await toggle.click(); await eventually(() => gets, count => count > hiddenGets, 'reopen resumes polling');
  await cardButton(first.cardId).click();
  assert.equal(await note().inputValue(), '草稿在隐藏再显示后继续保留');
  await detail().getByRole('button', { name: '保存卡片', exact: true }).click();
  await eventually(() => find(edited.title), card => card?.triage.note === '草稿在隐藏再显示后继续保留', 'save retained draft');
  await eventually(() => detail().getByRole('button', { name: '保存卡片', exact: true }).isDisabled(), Boolean, 'save settled');
  await note().fill('服务已保存，但第一次响应丢失');
  loseNext = true;
  await detail().getByRole('button', { name: '保存卡片', exact: true }).click();
  await detail().getByRole('button', { name: 'Retry same request', exact: true }).waitFor();
  const uncertainCore = await core(first.cardId);
  assert.equal(await note().isDisabled(), true);
  assert.equal(await note().inputValue(), '服务已保存，但第一次响应丢失');
  await detail().getByRole('button', { name: 'Retry same request', exact: true }).click();
  await eventually(() => note().isDisabled(), value => value === false, 'retry settled');
  assert.equal((await core(first.cardId)).revision, uncertainCore.revision);
  assert.equal((await find(edited.title)).triage.note, '服务已保存，但第一次响应丢失');
  await note().fill('冲突后仍保留的本地草稿');
  const conflictBase = await core(first.cardId);
  const notesComponent = conflictBase.components.find(component => component.type === 'amo.notes');
  await post('/api/cards/' + first.cardId + '/commands', { operationId: randomUUID(), expectedRevision: conflictBase.revision,
    commands: [{ type: 'set-note', componentId: notesComponent.componentId, text: '另一个窗口已更新备注' }],
  });
  // Reopening refreshes the server version without discarding the dirty draft.
  await closeDialog(detail()); await cardButton(first.cardId).click();
  await detail().getByText('最新保存内容', { exact: true }).waitFor();
  assert.equal(await note().inputValue(), '冲突后仍保留的本地草稿');
  assert.equal(await detail().getByRole('button', { name: '保存卡片', exact: true }).isDisabled(), true);
  await detail().getByRole('button', { name: '保留草稿并使用最新版本', exact: true }).click();
  await detail().getByRole('button', { name: '保存卡片', exact: true }).click();
  await eventually(() => find(edited.title), card => card?.triage.note === '冲突后仍保留的本地草稿', 'explicit conflict resolution');
  await closeDialog(detail());
  evidence.push('Simulated native visibility uses the real panel/toggle hooks: close synchronizes the switch, pauses polling, and reopening preserves drafts.');
  evidence.push('Lost save response retries the same operation without another revision. Concurrent edits keep the local draft and require explicit review before saving.');

  const sessionBeforeAdding = (await get('/api/sessions')).sessions;
  const picker = () => mainPage.getByRole('dialog', { name: '加入 Focus 分组', exact: true });
  const addFromTask = async groupId => {
    await mainPage.getByRole('button', { name: '加入 Focus 分组', exact: true }).click();
    await picker().getByRole('combobox').selectOption(groupId);
    await picker().getByRole('button', { name: '加入分组', exact: true }).click();
    await picker().waitFor({ state: 'hidden' });
    await refresh();
  };
  await addFromTask(active.groupId);
  const sessionCard = await eventually(() => find(syntheticSession.title), card => card?.groupId === active.groupId, 'TaskCard added to chosen group');
  assert.equal(sessionCard.cardId, originalCards[0].cardId);
  const countAfterAdding = (await read()).length;
  await addFromTask(later.groupId);
  assert.equal((await find(syntheticSession.title)).cardId, sessionCard.cardId);
  assert.equal((await find(syntheticSession.title)).groupId, later.groupId);
  assert.equal((await read()).length, countAfterAdding);
  assert.deepEqual((await get('/api/sessions')).sessions, sessionBeforeAdding);
  evidence.push('Real TaskCard action opens the real picker and adds its canonical Card to the chosen group. Repeating with another group reuses its UUID and does not mutate Session lifecycle.');

  const setReview = async groupId => {
    await showSettings();
    await settings().getByLabel('Review 接收分组', { exact: true }).selectOption(groupId || '');
    await eventually(registry, data => data.reviewGroupId === groupId, 'Review receiver selected');
    await closeDialog(settings());
  };
  // Reply artifacts and all Broker state are restricted to this temporary root.
  // This injects synthetic hook data, never messages to a live CLI/session.
  const reply = turn => ({ sessionId: syntheticSession.sessionId, tool: 'codex', workspacePath: syntheticWorkspace,
    title: syntheticSession.title, turnId: 'synthetic-turn-' + turn, capturedAt: `2026-09-11T00:01:${String(turn).padStart(2, '0')}.000Z`, message: 'Synthetic completed reply ' + turn });
  const sendReply = async turn => {
    const result = await post('/api/replies', reply(turn));
    for (const field of ['noteAbsolutePath', 'canvasAbsolutePath']) {
      const relative = path.relative(root, result[field]);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), field + ' remains in isolated root');
    }
  };
  await sendReply(1); // Configuring a receiver must not sweep existing Review tasks.
  await setReview(active.groupId);
  assert.equal((await find(syntheticSession.title)).groupId, later.groupId);
  await setReview(later.groupId);
  await setReview(active.groupId);
  assert.equal((await get('/api/focus-panel')).reviewGroupId, active.groupId);
  await sendReply(2); await refresh();
  await eventually(() => find(syntheticSession.title), card => card?.groupId === active.groupId, 'fresh Review routed');
  await cardButton(sessionCard.cardId).click({ button: 'right' });
  await page.getByRole('menu', { name: '移至分组', exact: true }).getByRole('menuitem', { name: later.name, exact: true }).click();
  await eventually(() => find(syntheticSession.title), card => card?.groupId === later.groupId, 'manual Review move');
  await sendReply(2);
  await post('/api/sessions/' + syntheticSession.sessionId + '/heartbeat', {});
  assert.equal((await find(syntheticSession.title)).groupId, later.groupId);
  const savedSessionCard = await core(sessionCard.cardId);
  await post('/api/cards/' + sessionCard.cardId + '/commands', { operationId: randomUUID(), expectedRevision: savedSessionCard.revision, commands: [{ type: 'archive' }] });
  await sendReply(3);
  assert.equal((await find(syntheticSession.title)).groupId, later.groupId);
  assert.ok((await find(syntheticSession.title)).archivedAt);
  evidence.push('Settings persist one Review receiver by stable group ID. Changing the receiver does not sweep historical Review tasks; a fresh synthetic completed reply routes once. Duplicate reply/heartbeat preserve manual moves, and an archived Card is not moved back.');
  await showSettings();
  await settings().getByRole('textbox', { name: '新分组名称', exact: true }).fill('临时 Review 接收');
  await settings().getByRole('button', { name: '添加分组', exact: true }).click();
  const transient = (await eventually(registry, data => data.groups.some(group => group.name === '临时 Review 接收'), 'temporary Review group')).groups.find(group => group.name === '临时 Review 接收');
  await settings().getByLabel('Review 接收分组', { exact: true }).selectOption(transient.groupId);
  await eventually(registry, data => data.reviewGroupId === transient.groupId, 'temporary receiver persisted');
  await settingRow(transient.groupId).getByRole('button', { name: '删除分组', exact: true }).click();
  if (await confirmDelete.isVisible()) await confirmDelete.click();
  await eventually(registry, data => data.reviewGroupId === null && !data.groups.some(group => group.groupId === transient.groupId), 'receiver deletion disables automatic routing');
  await closeDialog(settings());
  await setReview(active.groupId);
  evidence.push('Deleting the selected Review group clears the receiver atomically. Re-selecting a remaining group remains stable across Broker restart.');

  const beforeRestart = await read(), groupsBeforeRestart = await registry();
  await stop(); await start(port);
  assert.deepEqual(await read(), beforeRestart);
  assert.deepEqual(await registry(), groupsBeforeRestart);
  assert.deepEqual((await get('/api/sessions')).sessions.map(session => session.sessionId), [syntheticSession.sessionId]);
  assert.match(fs.readFileSync(path.join(root, 'focus-cards.json'), 'utf8'), /^obsolete/);
  await refresh();
  evidence.push('Actual isolated Broker restart preserves group IDs/Review receiver/settings and active/archived card data. Only the synthetic Session exists; obsolete Focus storage is untouched.');

  await page.screenshot({ path: path.join(root, 'focus-panel-dark-desktop.png'), fullPage: true });
  await cardButton(second.cardId).click();
  await page.screenshot({ path: path.join(root, 'focus-detail-dark-desktop.png'), fullPage: true });
  await closeDialog(detail());
  await page.evaluate(() => localStorage.setItem('amo.theme', 'light'));
  await page.reload(); await page.getByTestId('focus-panel').waitFor();
  await page.screenshot({ path: path.join(root, 'focus-panel-light-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 360, height: 560 });
  await page.screenshot({ path: path.join(root, 'focus-panel-light-narrow.png'), fullPage: true });
  await cardButton(second.cardId).click();
  await page.screenshot({ path: path.join(root, 'focus-detail-light-narrow.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'narrow viewport does not overflow horizontally');
  await closeDialog(detail());
  await showSettings();
  await page.screenshot({ path: path.join(root, 'focus-review-settings-light-narrow.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Review settings do not overflow narrow viewport');
  await mainPage.evaluate(() => localStorage.setItem('amo.theme', 'light'));
  await mainPage.setViewportSize({ width: 360, height: 560 });
  await mainPage.reload();
  await mainPage.getByRole('button', { name: '加入 Focus 分组', exact: true }).click();
  await picker().getByRole('combobox').selectOption(later.groupId);
  await mainPage.screenshot({ path: path.join(root, 'taskcard-focus-picker-light-narrow.png'), fullPage: true });
  assert.ok(await mainPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'TaskCard picker does not overflow narrow viewport');
  const invokes = [...await page.evaluate(() => window.__nativeInvokes || []), ...await mainPage.evaluate(() => window.__nativeInvokes || [])];
  assert.ok(invokes.every(call => call.name === 'set_startup_theme'), 'no native task or CLI operation');
  assert.deepEqual(errors, []);
  const result = { root, evidence, errors, requests, nativeSimulation: true, realWindowsVerified: false };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ root, evidence, errors, nativeSimulation: true, realWindowsVerified: false }, null, 2));
}
main().catch(async error => {
  console.error(error);
  if (page) await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }).catch(() => {});
  console.error('Artifacts:', root); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stop(); });
