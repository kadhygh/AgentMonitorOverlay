// Isolated Canvas UI integration smoke. Native APIs are stubbed; Broker and UI are real.
// AMO_PLAYWRIGHT_MODULE may point to an existing Playwright installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { build } = require('../../overlay/node_modules/esbuild');
const { chromium } = require(process.env.AMO_PLAYWRIGHT_MODULE || 'playwright');
const repo = path.resolve(__dirname, '../..');
fs.mkdirSync(path.join(repo, 'tmp'), { recursive: true });
const root = fs.mkdtempSync(path.join(repo, 'tmp', 'canvas-smoke-'));
const output = path.join(root, 'build');
let broker, browser;
let brokerOutput = '';
const evidence = [];
const native = `
const handlers = window.__canvasHandlers ??= new Map();
const listen = async (name, callback) => { const set=handlers.get(name)||new Set(); set.add(callback); handlers.set(name,set); return ()=>set.delete(callback); };
const emit = async (name,payload) => { for(const callback of handlers.get(name)||[]) callback({payload}); };
const current = {label:'canvas', listen, emit, emitTo:async(label,name,payload)=>emit(name,payload), hide:async()=>emit('amo-canvas-visibility',false), show:async()=>{}, unminimize:async()=>{}, setAlwaysOnTop:async()=>{}, setFocus:async()=>{}, startDragging:async()=>{}, onCloseRequested:async()=>()=>{}, isVisible:async()=>true};
window.__canvasVisibility = (value)=>emit('amo-canvas-visibility',value);
export const getCurrentWindow = ()=>current;
export const getCurrentWebviewWindow = ()=>current;
export const invoke = async()=>null;
export const isTauri = ()=>false;
export {listen,emit};
export class Window { static async getByLabel(){return current;} }
export class WebviewWindow extends Window {}
`;
async function freePort() {
  const probe=http.createServer();
  await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));
  return port;
}
async function startBroker(port) {
  broker=spawn(process.execPath,[path.join(repo,'broker/server.js')],{
    cwd:repo, windowsHide:true, stdio:['ignore','pipe','pipe'],
    env:{...process.env, AGENT_MONITOR_HOST:'127.0.0.1', AGENT_MONITOR_PORT:String(port), AGENT_MONITOR_DATA_FILE:path.join(root,'sessions.json'), AGENT_MONITOR_WORKSPACE_DATA_FILE:path.join(root,'workspaces.json'), AGENT_MONITOR_LAUNCH_DATA_FILE:path.join(root,'launches.json'), AGENT_MONITOR_TASK_CANVAS_DATA_FILE:path.join(root,'task-canvas.json')},
  });
  broker.stdout.on('data',chunk=>brokerOutput+=chunk);
  broker.stderr.on('data',chunk=>brokerOutput+=chunk);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Broker startup timed out: '+brokerOutput)),10000);
    broker.once('error',error=>{clearTimeout(timer);reject(error);});
    broker.stdout.on('data',()=>{if(brokerOutput.includes('listening at')){clearTimeout(timer);resolve();}});
  });
}
async function main() {
  const now=new Date().toISOString();
  fs.writeFileSync(path.join(root,'sessions.json'),JSON.stringify({sessions:Array.from({length:205},(_,i)=>({sessionId:`canvas-fixture-${i}`,tool:'codex-cli',cwd:root,title:`Canvas fixture ${i}`,taskTitle:`Canvas fixture ${i}`,state:i===0?'running':'idle',lastEvent:'SessionStart',lastMessage:'Isolated task',needsAttention:false,updatedAt:now}))}));
  await build({stdin:{contents:`import React from 'react'; import {createRoot} from 'react-dom/client'; import './overlay/src/styles.css'; import {CanvasWorkbenchApp} from './overlay/src/windows/CanvasWorkbenchApp'; createRoot(document.getElementById('root')).render(<CanvasWorkbenchApp/>);`,resolveDir:repo,loader:'tsx'},bundle:true,outdir:output,entryNames:'app',platform:'browser',format:'iife',jsx:'automatic',nodePaths:[path.join(repo,'overlay/node_modules')],define:{'process.env.NODE_ENV':'"production"'},loader:{'.png':'dataurl'},plugins:[{name:'native-stub',setup(build){build.onResolve({filter:/^@tauri-apps\/api/},args=>({path:args.path,namespace:'native-stub'}));build.onLoad({filter:/.*/,namespace:'native-stub'},()=>({contents:native,loader:'js'}));}}]});
  const port=await freePort();
  await startBroker(port);
  const brokerUrl=`http://127.0.0.1:${port}`;
  browser=await chromium.launch({headless:true,channel:'msedge'});
  const context=await browser.newContext({viewport:{width:1440,height:960}});
  const errors=[];
  await context.route('http://tauri.localhost/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/app.js'||url.pathname==='/app.css')return route.fulfill({status:200,contentType:url.pathname.endsWith('.js')?'text/javascript':'text/css',body:fs.readFileSync(path.join(output,url.pathname.slice(1)))});
    return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'});
  });
  let referenceRequests=0, loseNextSave=false;
  await context.route('http://127.0.0.1:17654/**',async route=>{
    if(route.request().url().includes('/task-canvas/sessions'))referenceRequests++;
    const response=await route.fetch({url:route.request().url().replace('http://127.0.0.1:17654',brokerUrl)});
    if(loseNextSave && route.request().method()==='POST' && route.request().url().endsWith('/api/task-canvas')) { loseNextSave=false; await route.abort('failed'); return; }
    await route.fulfill({response});
  });
  const page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://tauri.localhost/');
  await page.waitForFunction(()=>document.body.innerText.includes('Canvas fixture'));
  await page.getByLabel('Search tasks').fill('Canvas fixture 204');
  await page.locator('.amo-canvas-candidate').filter({hasText:'Canvas fixture 204'}).click();
  await page.locator('.amo-canvas-node.is-task h2').filter({hasText:'Canvas fixture 204'}).waitFor();
  evidence.push('Complete active hydration: task 204 can be found and added as a reference.');
  const drag = async (locator, dx, dy) => {
    const box=await locator.boundingBox(); assert.ok(box);
    await page.mouse.move(box.x+30,box.y+15); await page.mouse.down();
    await page.mouse.move(box.x+30+dx,box.y+15+dy,{steps:8}); await page.mouse.up();
  };
  await drag(page.locator('.amo-canvas-node.is-task .amo-canvas-node-heading'),-230,-100);
  await page.getByRole('button',{name:'Add note',exact:true}).click();
  await page.getByLabel('Note text',{exact:true}).fill('Canvas foundation review: preserve task identity and layout.');
  await drag(page.locator('.amo-canvas-node.is-note .amo-canvas-node-heading'),190,90);
  await page.getByRole('button',{name:'Connect from Canvas fixture 204',exact:true}).click();
  await page.locator('.amo-canvas-node.is-note .amo-canvas-node-heading').click({position:{x:30,y:15}});
  assert.equal(await page.locator('.amo-canvas-edge').count(),1);
  await page.getByRole('button',{name:'Zoom out',exact:true}).click();
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Saved · r1',{exact:true}).waitFor();
  let stored=await (await fetch(`${brokerUrl}/api/task-canvas`)).json();
  assert.equal(stored.board.document.nodes.length,2); assert.equal(stored.board.document.edges.length,1);
  assert.ok(stored.board.document.viewport.zoom<1);
  assert.equal(stored.board.document.nodes.find(n=>n.kind==='task').sessionId,'canvas-fixture-204');
  evidence.push('Add task/note, edit, drag, connect, zoom, and explicit Save persist the actual graph.');
  await page.screenshot({path:path.join(root,'canvas-board.png')});
  await page.reload();
  await page.getByText('Saved · r1',{exact:true}).waitFor();
  assert.equal(await page.locator('.amo-canvas-node').count(),2);
  assert.equal(await page.getByLabel('Note text',{exact:true}).inputValue(),'Canvas foundation review: preserve task identity and layout.');
  evidence.push('A fresh UI instance restores nodes, note text, edges and viewport from Broker storage.');
  // A competing writer commits while this editor has unsaved changes.
  await page.getByLabel('Note text',{exact:true}).fill('Keep this local draft on conflict.');
  const concurrent=structuredClone(stored.board.document);
  concurrent.nodes.find(n=>n.kind==='note').text='Another editor committed this.';
  const writeResponse=await fetch(`${brokerUrl}/api/task-canvas`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operationId:'smoke-competing-writer',expectedRevision:1,document:concurrent})});
  assert.equal(writeResponse.status,200);
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'changed elsewhere'}).waitFor();
  assert.equal(await page.getByLabel('Note text',{exact:true}).inputValue(),'Keep this local draft on conflict.');
  await page.getByRole('button',{name:'Reload',exact:true}).click();
  await page.getByRole('button',{name:'Keep editing',exact:true}).click();
  assert.equal(await page.getByLabel('Note text',{exact:true}).inputValue(),'Keep this local draft on conflict.');
  await page.getByRole('button',{name:'Reload',exact:true}).click();
  await page.getByRole('button',{name:'Discard and reload',exact:true}).click();
  await page.getByText('Saved · r2',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Note text',{exact:true}).inputValue(),'Another editor committed this.');
  evidence.push('Concurrent revision conflict preserves edits; dirty Reload offers explicit keep/discard choices.');
  // Simulate a successful disk commit whose response is lost before reaching the editor.
  await page.getByLabel('Note text',{exact:true}).fill('Committed response will be lost.');
  loseNextSave=true;
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByRole('button',{name:'Retry save',exact:true}).waitFor();
  stored=await (await fetch(`${brokerUrl}/api/task-canvas`)).json();
  assert.equal(stored.board.revision,3);
  await page.getByLabel('Note text',{exact:true}).fill('Newer draft must survive retry.');
  await page.getByRole('button',{name:'Retry save',exact:true}).click();
  await page.getByRole('button',{name:'Save',exact:true}).waitFor();
  assert.equal(await page.getByLabel('Note text',{exact:true}).inputValue(),'Newer draft must survive retry.');
  assert.ok(await page.getByText('Unsaved changes',{exact:true}).isVisible());
  stored=await (await fetch(`${brokerUrl}/api/task-canvas`)).json();
  assert.equal(stored.board.revision,3);
  await page.getByLabel('Note text',{exact:true}).press('Control+s');
  await page.getByText('Saved · r4',{exact:true}).waitFor();
  stored=await (await fetch(`${brokerUrl}/api/task-canvas`)).json();
  assert.equal(stored.board.document.nodes.find(n=>n.kind==='note').text,'Newer draft must survive retry.');
  evidence.push('Lost response retries the same durable operation without duplicate commit; newer draft survives and Ctrl+S saves inside the note editor.');
  // Session lifecycle can change independently without removing the graph node.
  await fetch(`${brokerUrl}/api/sessions/canvas-fixture-204/archive`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  await page.evaluate(()=>window.__canvasVisibility(false));
  await page.evaluate(()=>window.__canvasVisibility(true));
  await page.locator('.amo-canvas-node.is-task .amo-canvas-node-heading').filter({hasText:'Archived'}).waitFor();
  await fetch(`${brokerUrl}/api/sessions/canvas-fixture-204/dismiss`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  await page.evaluate(()=>window.__canvasVisibility(false));
  await page.evaluate(()=>window.__canvasVisibility(true));
  await page.locator('.amo-canvas-node.is-task .amo-canvas-node-heading').filter({hasText:'Missing reference'}).waitFor();
  assert.equal(await page.locator('.amo-canvas-edge').count(),1);
  evidence.push('Archived and subsequently missing session references retain graph geometry and connections.');
  await page.evaluate(()=>window.__canvasVisibility(false));
  await page.waitForTimeout(250);
  const beforeHidden=referenceRequests;
  await page.waitForTimeout(5300);
  assert.equal(referenceRequests,beforeHidden);
  await page.evaluate(()=>window.__canvasVisibility(true));
  await page.waitForTimeout(500);
  assert.ok(referenceRequests>beforeHidden);
  evidence.push('Native hide visibility suspends task polling and show reconciles again.');
  await page.locator('.amo-canvas-node.is-task .amo-canvas-node-heading').click({position:{x:30,y:15}});
  await page.getByRole('button',{name:'Remove',exact:true}).click();
  assert.equal(await page.locator('.amo-canvas-node.is-task').count(),0);
  assert.equal(await page.locator('.amo-canvas-edge').count(),0);
  evidence.push('Removing a node also removes its incident edge.');
  await page.setViewportSize({width:800,height:560});
  await page.evaluate(()=>{localStorage.setItem('amo.theme','light');});
  await page.reload();
  await page.getByText('Saved · r4',{exact:true}).waitFor({state:'attached'});
  await page.getByRole('button',{name:'Fit board',exact:true}).click();
  await page.screenshot({path:path.join(root,'canvas-light-minimum.png')});
  assert.ok(await page.getByRole('button',{name:'Save',exact:true}).isVisible());
  evidence.push('Light theme renders at the minimum 800×560 window size.');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({evidence,errors,referenceRequests},null,2));
  console.log(JSON.stringify({root,evidence,errors,referenceRequests},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  await browser?.close();
  if(broker && broker.exitCode===null){broker.kill();await new Promise(resolve=>{broker.once('exit',resolve);setTimeout(resolve,5000).unref();});}
});
