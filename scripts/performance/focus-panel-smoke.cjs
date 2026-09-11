// Real Focus UI + Broker; native window ports are simulated. All data stays in tmp.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { build } = require('../../overlay/node_modules/esbuild');
const { chromium } = require(process.env.AMO_PLAYWRIGHT_MODULE || 'playwright');
const repo = path.resolve(__dirname, '../..');
fs.mkdirSync(path.join(repo, 'tmp'), { recursive: true });
const root = fs.mkdtempSync(path.join(repo, 'tmp', 'focus-smoke-'));
const workspace = path.join(root, 'Unity-A');
const output = path.join(root, 'build');
const evidence = [];
let broker, browser, page, log = '';
const native = `
const label=new URL(location.href).searchParams.get('surface')==='main'?'main':'focus';
const listeners=window.__nativeListeners??=new Map();
const channel=window.__nativeChannel??=new BroadcastChannel('focus-smoke-native');
function deliver(event){if(event.target!==label)return; for(const fn of listeners.get(event.name)||[])fn({payload:event.payload});}
channel.onmessage=event=>deliver(event.data);
export async function listen(name,fn){const set=listeners.get(name)||new Set();set.add(fn);listeners.set(name,set);return()=>set.delete(fn);}
async function emitTo(target,name,payload){const event={target,name,payload};deliver(event);channel.postMessage(event);}
function win(name){return {label:name,listen,emitTo,async show(){localStorage.setItem('window.'+name,'visible');},async hide(){localStorage.setItem('window.'+name,'hidden');},async isVisible(){return localStorage.getItem('window.'+name)==='visible';},async unminimize(){},async setAlwaysOnTop(){},async setFocus(){},async startDragging(){},async onCloseRequested(){return()=>{};}};}
export const getCurrentWindow=()=>win(label);
export const getCurrentWebviewWindow=()=>win(label);
export const invoke=async()=>null;
export class Window {static async getByLabel(name){return localStorage.getItem('window.'+name)?win(name):null;}}
export class WebviewWindow extends Window {constructor(name,options){super();localStorage.setItem('window.'+name,options.visible?'visible':'hidden');return {...win(name),async once(event,fn){if(event==='tauri://created')queueMicrotask(fn);}};}}
window.__visibility=value=>emitTo('focus','amo-focus-visibility',value);
`;
const fixture = `
import React from 'react'; import {createRoot} from 'react-dom/client';
import './overlay/src/styles.css';
import {FocusPanelApp} from './overlay/src/windows/FocusPanelApp';
import {useFocusPanelWindow} from './overlay/src/hooks/useFocusPanelWindow';
import {useFocusPanelCommands} from './overlay/src/hooks/useFocusPanelCommands';
function Main(){const panel=useFocusPanelWindow(()=>{});useFocusPanelCommands({activate:async(session)=>{(window.__commands??=[]).push(['activate',session.sessionId]);await fetch('http://127.0.0.1:17654/api/sessions/'+encodeURIComponent(session.sessionId)+'/reviewed',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});},resume:async(session)=>{(window.__commands??=[]).push(['resume',session.sessionId]);}});return <button role="switch" aria-label="Focus Panel" aria-checked={panel.focusPanelVisible} disabled={panel.focusPanelBusy} onClick={()=>panel.toggleFocusPanel()}>Focus Panel</button>;}
createRoot(document.getElementById('root')).render(new URL(location.href).searchParams.get('surface')==='main'?<Main/>:<FocusPanelApp/>);
`;
async function start(port) {
  log='';
  broker=spawn(process.execPath,[path.join(repo,'broker/server.js')],{cwd:repo,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,AGENT_MONITOR_HOST:'127.0.0.1',AGENT_MONITOR_PORT:String(port),AGENT_MONITOR_DATA_FILE:path.join(root,'sessions.json'),AGENT_MONITOR_WORKSPACE_DATA_FILE:path.join(root,'workspaces.json'),AGENT_MONITOR_LAUNCH_DATA_FILE:path.join(root,'launches.json'),AGENT_MONITOR_TASK_CANVAS_DATA_FILE:path.join(root,'canvas.json'),AGENT_MONITOR_CARDS_DATA_FILE:path.join(root,'cards.json')}});
  broker.stderr.on('data',data=>log+=data);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(log||'Broker startup timeout')),10000);broker.on('error',error=>{clearTimeout(timer);reject(error);});broker.stdout.on('data',data=>{log+=data;if(log.includes('listening at')){clearTimeout(timer);resolve();}});});
}
async function stop() { if(broker && broker.exitCode===null){const stopped=new Promise(resolve=>broker.once('exit',resolve));broker.kill();await stopped;} }
async function main() {
  fs.mkdirSync(path.join(workspace,'.amo'),{recursive:true});
  fs.writeFileSync(path.join(workspace,'.amo/workspace.json'),JSON.stringify({workspaceId:'ws-fixture',workspacePath:workspace,vaultRoot:path.join(workspace,'.amo/vault')}));
  const time=new Date(Date.now()-60000).toISOString();
  const seed=(id,tool,state,extra={})=>({sessionId:id,tool,state,title:id,taskTitle:id,workspaceId:'ws-fixture',workspacePath:workspace,cwd:workspace,createdAt:time,updatedAt:time,lastEvent:'SessionStart',...extra});
  fs.writeFileSync(path.join(root,'sessions.json'),JSON.stringify({sessions:[seed('Framework review','codex','idle',{lastReplyAt:time,reviewRequired:true,reviewTurnId:'turn-one',lastReplyNote:'initial-reply.md'}),seed('Discuss plan','claude','waiting_user'),seed('Grok running','grok','running'),seed('Old archived','codex','idle',{archivedAt:time}),seed('Other framework','custom-tool','waiting_permission')]}));
  fs.writeFileSync(path.join(root,'focus-cards.json'),'obsolete Focus prototype fixture; intentionally not a Card snapshot');
  await build({stdin:{contents:fixture,resolveDir:repo,loader:'tsx'},bundle:true,outdir:output,entryNames:'app',platform:'browser',format:'iife',jsx:'automatic',nodePaths:[path.join(repo,'overlay/node_modules')],define:{'process.env.NODE_ENV':'"production"'},loader:{'.png':'dataurl'},plugins:[{name:'native',setup(builder){builder.onResolve({filter:/^@tauri-apps\/api/},()=>({path:'native',namespace:'native'}));builder.onLoad({filter:/.*/,namespace:'native'},()=>({contents:native,loader:'js'}));}}]});
  const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  await start(port); const url=`http://127.0.0.1:${port}`;
  const read=async()=>{const response=await fetch(url+'/api/focus-panel');assert.equal(response.status,200);const payload=await response.json();assert.equal(payload.schemaVersion,2);return payload.cards;};
  const find=async()=> (await read()).find(card=>card.session?.sessionRef.sessionId==='Framework review');
  const post=async(route,body)=>{const response=await fetch(url+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200,await response.clone().text());return response.json();};
  const reply=async(turn)=>post('/api/replies',{tool:'codex',sessionId:'Framework review',workspacePath:workspace,cwd:workspace,turnId:turn,capturedAt:new Date().toISOString(),message:'Full framework reply for '+turn});
  browser=await chromium.launch({headless:true,channel:'msedge'});
  const context=await browser.newContext({viewport:{width:440,height:760}});
  const errors=[];let gets=0,loseNext=false;
  context.on('page',p=>p.on('pageerror',error=>errors.push(error.message)));
  await context.route('http://tauri.localhost/**',route=>{const pathname=new URL(route.request().url()).pathname;return ['/app.js','/app.css'].includes(pathname)?route.fulfill({status:200,contentType:pathname.endsWith('js')?'text/javascript':'text/css',body:fs.readFileSync(path.join(output,pathname.slice(1)))}):route.fulfill({status:200,contentType:'text/html',body:'<html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'});});
  await context.route('http://127.0.0.1:17654/**',async route=>{if(route.request().method()==='GET'&&route.request().url().endsWith('/api/focus-panel'))gets++;const response=await route.fetch({url:route.request().url().replace('http://127.0.0.1:17654',url)});if(loseNext&&route.request().method()==='POST'&&route.request().url().includes('/focus-panel/cards/')){loseNext=false;return route.abort('failed');}await route.fulfill({response});});
  const mainPage=await context.newPage();await mainPage.goto('http://tauri.localhost/?surface=main');
  const toggle=mainPage.getByRole('switch',{name:'Focus Panel'});await toggle.click();assert.equal(await toggle.getAttribute('aria-checked'),'true');
  page=await context.newPage();await page.goto('http://tauri.localhost/');
  const card=()=>page.locator('.amo-focus-card').filter({hasText:'Framework review'});
  await card().locator('.amo-focus-card-toggle').click();
  const original=await find();assert.equal(original.triage.state,'pending');assert.equal(original.attention.generation,1);
  assert.match(original.cardId,/^card-/);
  const originalCore=await (await fetch(url+'/api/cards/'+original.cardId)).json();
  assert.equal(Object.hasOwn(originalCore.card,'sessionRef'),false);
  assert.deepEqual(originalCore.card.components.map(component=>component.type).sort(),['amo.conversation','amo.notes','amo.processing','amo.session']);
  await card().getByRole('button',{name:/^Open (CLI|conversation)$/}).click();
  await card().getByText(/Request delegated/).waitFor();
  assert.equal((await find()).triage.state,'pending');assert.equal((await find()).attention.hasUnseen,true);
  assert.deepEqual(await mainPage.evaluate(()=>window.__commands),[['activate','Framework review']]);
  evidence.push('Real toggle opens Focus; Open CLI reaches the existing main command owner, and legacy reviewed flags do not consume Focus attention.');
  const note=()=>page.getByRole('textbox',{name:'Review note for Framework review'});
  await note().fill('Read the complete implementation before deciding.');
  await card().getByRole('button',{name:'Save note',exact:true}).click();await page.getByText('Note saved',{exact:true}).waitFor();
  await page.getByLabel('Review queue for Framework review').selectOption('future');
  await page.getByRole('button',{name:/^Future/}).click();await card().locator('.amo-focus-card-toggle').click();
  assert.equal((await find()).triage.state,'future');
  await reply('turn-two'); await page.getByRole('button',{name:'Refresh Focus Panel'}).click();
  await card().getByText('New update · 2',{exact:true}).waitFor();assert.equal((await find()).triage.state,'future');
  await reply('turn-two');assert.equal((await find()).attention.generation,2);
  evidence.push('Notes and deferred choices persist; a new reply increments generation without moving Future, duplicate reply is deduplicated.');
  await card().getByRole('button',{name:'Handle this update',exact:true}).click();
  await page.getByRole('button',{name:/^Handled/}).click();await card().locator('.amo-focus-card-toggle').click();
  assert.equal((await find()).triage.handledGeneration,2);
  await note().fill('First note commit response will be lost.');loseNext=true;
  await card().getByRole('button',{name:'Save note',exact:true}).click();await card().getByRole('button',{name:'Retry same request'}).waitFor();
  await note().fill('A newer local draft survives retry.');
  await card().getByRole('button',{name:'Retry same request'}).click();
  await page.waitForFunction(()=>document.querySelector('.amo-focus-note-actions button')?.disabled===false);
  assert.equal(await note().inputValue(),'A newer local draft survives retry.');
  await card().getByRole('button',{name:'Save note',exact:true}).click();await page.getByText('Note saved',{exact:true}).waitFor();
  assert.equal((await find()).triage.state,'handled');
  evidence.push('Explicit handling consumes only the observed generation; uncertain note saves replay without overwriting newer drafts or changing handled state.');
  const beforeConflict=await find();await note().fill('Local conflict draft');
  await post('/api/focus-panel/cards/'+beforeConflict.cardId,{operationId:'external-note',action:'set-triage',expectedRevision:beforeConflict.revision,note:'Another window changed the note'});
  await page.getByRole('button',{name:'Refresh Focus Panel'}).click();
  await card().getByText('Saved note now:',{exact:true}).waitFor();assert.equal(await note().inputValue(),'Local conflict draft');
  await card().getByRole('button',{name:'Keep draft with latest revision'}).click();
  await card().getByRole('button',{name:'Save note',exact:true}).click();await page.getByText('Note saved',{exact:true}).waitFor();
  evidence.push('Concurrent note edits preserve the local draft and require an explicit choice before updating the newer stored version.');
  const beforeRestart=await find();await stop();await start(port);
  const afterRestart=await find();assert.equal(afterRestart.cardId,beforeRestart.cardId);assert.equal(afterRestart.triage.note,'Local conflict draft');assert.equal(afterRestart.triage.state,'handled');
  evidence.push('Actual Broker process restart preserves card identity, manual state, note and handled generation.');
  await page.getByRole('button',{name:'Hide Focus Panel'}).click();
  await mainPage.waitForFunction(()=>document.querySelector('[role="switch"]')?.getAttribute('aria-checked')==='false');
  await page.waitForTimeout(300);const hiddenGets=gets;await page.waitForTimeout(4500);assert.equal(gets,hiddenGets);
  await mainPage.getByRole('switch',{name:'Focus Panel'}).click();await page.waitForTimeout(700);assert.ok(gets>hiddenGets);
  evidence.push('Panel close synchronizes the actual toggle hook; hidden UI stops polling and reopening reconciles.');
  await reply('turn-three'); await page.getByRole('button',{name:'Refresh Focus Panel'}).click();await page.getByRole('button',{name:/^Pending/}).click();await card().locator('.amo-focus-card-toggle').click();await card().getByText('New update · 3',{exact:true}).waitFor();
  await page.screenshot({path:path.join(root,'focus-panel-dark.png')});
  await post('/api/sessions/'+encodeURIComponent('Framework review')+'/dismiss',{});await page.getByRole('button',{name:'Refresh Focus Panel'}).click();await card().getByText('Session · detached',{exact:true}).waitFor();assert.equal(await card().getByRole('button',{name:/^Open (CLI|conversation)$/}).isDisabled(),true);
  assert.equal((await find()).cardId,original.cardId);
  evidence.push('Removed sessions retain their work card and note, while stale CLI commands become unavailable.');
  await page.getByRole('button',{name:'New card',exact:true}).click();
  await page.getByRole('textbox',{name:'New card title'}).fill('Plan a future subsystem');
  await page.getByRole('textbox',{name:'New card note'}).fill('Independent planning without starting any session.');
  await page.getByRole('button',{name:'Create card',exact:true}).click();
  const manualRow=()=>page.locator('.amo-focus-card').filter({hasText:'Plan a future subsystem'});
  await manualRow().waitFor();
  let manual=(await read()).find(item=>item.title==='Plan a future subsystem');
  assert.equal(manual.session,null);assert.equal(manual.conversation,null);
  assert.equal(manual.triage.note,'Independent planning without starting any session.');
  assert.equal(await manualRow().getByRole('button',{name:/Open CLI|Open app|Resume/}).count(),0);
  const allCore=(await (await fetch(url+'/api/cards')).json()).cards;
  let core=allCore.find(item=>item.cardId===manual.cardId);
  assert.ok(core.components.every(component=>!['amo.session','amo.conversation'].includes(component.type)));
  const command=async(cardValue,commands,operationId=crypto.randomUUID())=>post('/api/cards/'+cardValue.cardId+'/commands',{operationId,expectedRevision:cardValue.revision,commands});
  const opaque={componentId:'future-extension',type:'example.planning',schemaVersion:7,data:{hypothesis:'Keep this component unchanged'}};
  core=(await command(core,[{type:'set-title',title:'Renamed independent card'},{type:'set-component',component:opaque}])).card;
  const noteComponent=core.components.find(component=>component.type==='amo.notes');
  core=(await command(core,[{type:'set-note',componentId:noteComponent.componentId,text:'Edited through the common Card interface'}])).card;
  assert.deepEqual(core.components.find(component=>component.componentId===opaque.componentId),opaque);
  await page.getByRole('button',{name:'Refresh Focus Panel'}).click();
  await page.locator('.amo-focus-card').filter({hasText:'Renamed independent card'}).waitFor();
  evidence.push('New card creates independent processing/notes components; common interfaces rename/edit data and preserve an unknown versioned component.');
  const processingComponent=core.components.find(component=>component.type==='amo.processing');
  core=(await command(core,[
    {type:'set-component',component:{componentId:'session-two',type:'amo.session',schemaVersion:1,data:{sessionRef:{frameworkId:'claude',sessionId:'Discuss plan'}}}},
    {type:'set-component',component:{componentId:'conversation-two',type:'amo.conversation',schemaVersion:1,data:{sessionComponentId:'session-two'}}},
    {type:'set-component',component:{componentId:processingComponent.componentId,type:'amo.processing',schemaVersion:1,data:{sourceComponentId:'session-two',state:'pending'}}}
  ])).card;
  manual=(await read()).find(item=>item.cardId===core.cardId);
  assert.equal(manual.session.execution,'waiting_user');assert.equal(manual.conversation.surface,'unbound');assert.equal(manual.conversation.availability,'unknown');
  const invalidBatch=await fetch(url+'/api/cards/'+core.cardId+'/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operationId:'invalid-dependency-batch',expectedRevision:core.revision,commands:[{type:'set-title',title:'Must not leak'},{type:'remove-component',componentId:'session-two'}]})});
  assert.equal(invalidBatch.status,400);
  assert.equal((await (await fetch(url+'/api/cards/'+core.cardId)).json()).card.title,'Renamed independent card');
  core=(await command(core,[{type:'remove-component',componentId:'conversation-two'}])).card;
  manual=(await read()).find(item=>item.cardId===core.cardId);assert.equal(manual.session.execution,'waiting_user');assert.equal(manual.conversation,null);
  core=(await command(core,[{type:'archive'}])).card;
  assert.equal((await read()).some(item=>item.cardId===core.cardId),false);
  core=(await command(core,[{type:'restore'}])).card;
  assert.equal((await read()).some(item=>item.cardId===core.cardId),true);
  assert.equal((await (await fetch(url+'/api/sessions/'+encodeURIComponent('Discuss plan'))).json()).session.state,'waiting_user');
  assert.match(fs.readFileSync(path.join(root,'focus-cards.json'),'utf8'),/^obsolete/);
  evidence.push('Session and conversation components attach atomically, detach independently, and preserve running tasks; invalid dependency batches roll back, Card archive/restore changes only the view. Old Focus storage is not read or deleted.');
  await page.evaluate(()=>localStorage.setItem('amo.theme','light'));await page.setViewportSize({width:360,height:560});await page.reload();await page.getByRole('button',{name:/^All tasks/}).click();await page.screenshot({path:path.join(root,'focus-panel-light.png')});
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({evidence,errors},null,2));console.log(JSON.stringify({root,evidence,errors},null,2));
}
main().catch(async error=>{console.error(error);if(page)await page.screenshot({path:path.join(root,'failure.png')}).catch(()=>{});console.error('Artifacts:',root);process.exitCode=1;}).finally(async()=>{await browser?.close();await stop();});
