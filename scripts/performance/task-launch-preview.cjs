// Real launcher React UI + real Broker task service/CardStore. ONLY terminal transport
// and native window APIs are simulated. No CLI process, message, or production API.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {randomUUID} = require('node:crypto');
const {build} = require('../../overlay/node_modules/esbuild');
const {createCardStore} = require('../../broker/lib/card-store');
const {createLaunchStore} = require('../../broker/lib/launch-store');
const {SessionCollection} = require('../../broker/lib/session-collection');
const {createTaskLauncher} = require('../../broker/lib/task-launch');
const {launchWorkspace} = require('../../broker/lib/workspace-launch');
const {handleTaskLaunchRoutes} = require('../../broker/routes/task-launches');
const {handleFocusPanelRoutes}=require('../../broker/routes/focus-panel');
const {handleCardRoutes}=require('../../broker/routes/cards');
const {readJsonBody,sendJson} = require('../../broker/lib/http');
const repo=path.resolve(__dirname,'../..');
async function createPreview(){
 fs.mkdirSync(path.join(repo,'tmp'),{recursive:true});
 const root=fs.mkdtempSync(path.join(repo,'tmp','task-launch-preview-'));
 const workspaces=['Unity A','Unity B','Unity Reserve'].map((label,i)=>{
  const workspacePath=path.join(root,'copies',label);fs.mkdirSync(path.join(workspacePath,'.amo'),{recursive:true});
  fs.mkdirSync(path.join(workspacePath,'.git','objects'),{recursive:true});fs.mkdirSync(path.join(workspacePath,'.git','refs','heads'),{recursive:true});fs.writeFileSync(path.join(workspacePath,'.git','HEAD'),'ref: refs/heads/'+['feature/ui','feature/runtime','reserve'][i]+'\n');
  const workspaceId='preview-copy-'+i;
  fs.writeFileSync(path.join(workspacePath,'.amo/workspace.json'),JSON.stringify({workspaceId,projectName:label}));
  fs.writeFileSync(path.join(workspacePath,'.amo/enrollment.json'),JSON.stringify({adapters:[{id:'codex-cli'}]}));
  return {workspaceId,workspacePath,workspaceLabel:label};
 });
 const cardStore=createCardStore({dataFile:path.join(root,'cards.json')});
 const launchStore=createLaunchStore({dataFile:path.join(root,'launches.json')});
 const sessions=new SessionCollection();cardStore.attach(sessions);
 await cardStore.executeGroups({operationId:randomUUID(),expectedRevision:0,commands:[{type:'create',name:'Work',dragOnly:false},{type:'create',name:'Review',dragOnly:false}]});
 const calls=[],timers=new Set();let scenario='normal';
 async function connect(options){
  const event={event:'SessionStart',sessionId:'preview-'+randomUUID(),tool:'codex',workspaceId:options.environment.AMO_WORKSPACE_ID,cwd:options.workspacePath,launchId:options.environment.AMO_LAUNCH_ID};
  launchStore.claim(event,{sessions});
  sessions.set(event.sessionId,{...event,workspacePath:options.workspacePath,title:'Simulated CLI session',state:'running',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  await cardStore.flush();
 }
 const taskLauncher=createTaskLauncher({cardStore,launchStore,sessions,workspaceRegistry:{list:()=>workspaces},launchWorkspace,
  launchCliInTerminal:async options=>{
   calls.push({workspacePath:options.workspacePath,args:options.args,launchId:options.environment.AMO_LAUNCH_ID,scenario});
   if(scenario==='not-started')throw Object.assign(new Error('Simulated confirmed not spawned'),{spawnOutcome:'not-spawned'});
   if(scenario==='failure')throw new Error('Simulated terminal outcome uncertainty');
   if(scenario==='early')await connect(options);
   if(scenario==='normal'){const timer=setTimeout(()=>{timers.delete(timer);void connect(options);},700);timers.add(timer);}
   return {pid:null,command:'SIMULATED ONLY',args:[],shell:'simulated',launchEnvironment:'windows-powershell'};
  }});
 const native=`
 const listeners=new Map(); export async function listen(name,fn){const set=listeners.get(name)||new Set();set.add(fn);listeners.set(name,set);return()=>set.delete(fn)};window.__previewDeliver=(name,payload)=>{for(const fn of listeners.get(name)||[])fn({payload})};
 const win={listen,label:'task-launch',async onCloseRequested(){return()=>{}},async isVisible(){return true},async startDragging(){},async startResizeDragging(){},async hide(){document.getElementById('native-status').textContent='模拟：隐藏窗口（预览仍保持可见）'},async setSize(){},async setAlwaysOnTop(){},async setFocus(){},async emitTo(target,name,payload){document.getElementById('native-status').textContent='模拟原生动作：'+name;window.__nativeEvents.push({target,name,payload});if(name==='task-launch-open-focus')window.dispatchEvent(new CustomEvent('preview-focus'));if(name==='amo-focus-session-command')window.__previewDeliver('amo-focus-session-command-result',{requestId:payload.requestId,ok:false,message:'隔离预览：真实 Session / CLI 操作已阻止'});}};
 export class LogicalSize{constructor(width,height){this.width=width;this.height=height}};export class Window{static async getByLabel(){return null}};export const getCurrentWindow=()=>win;export const getCurrentWebviewWindow=()=>win;
 export async function invoke(name){if(name==='set_startup_theme'||name==='set_focus_input_regions')return;if(name.includes('credential'))return {ok:true,apiKey:'preview-only-not-a-real-key',configured:true,providerId:'preview'};throw new Error('Native blocked: '+name)};
 window.__nativeEvents=[];`;
 const fixture=`import React,{useState,useEffect} from 'react';import{createRoot}from'react-dom/client';import './overlay/src/styles.css';import{TaskLaunchApp}from'./overlay/src/windows/TaskLaunchApp';import{FocusPanelApp}from'./overlay/src/windows/FocusPanelApp';function Preview(){const [focus,setFocus]=useState(false);const [visited,setVisited]=useState(false);useEffect(()=>{const show=()=>{setVisited(true);setFocus(true);window.__previewDeliver('amo-task-launch-visibility',false);window.__previewDeliver('amo-focus-visibility',true);document.getElementById('preview-back').hidden=false};const back=()=>{setFocus(false);window.__previewDeliver('amo-focus-visibility',false);window.__previewDeliver('amo-task-launch-visibility',true);document.getElementById('preview-back').hidden=true};window.addEventListener('preview-focus',show);document.getElementById('preview-back').onclick=back;return()=>window.removeEventListener('preview-focus',show)},[]);return <><div hidden={focus}><TaskLaunchApp/></div>{visited&&<div hidden={!focus}><FocusPanelApp/></div>}</>};createRoot(document.getElementById('root')).render(<Preview/>);document.getElementById('scenario').onchange=e=>fetch('/preview/scenario',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scenario:e.target.value})});`;
 const themeFixture=`const themeButton=document.createElement('button');themeButton.id='preview-theme';themeButton.textContent='切换明暗';themeButton.onclick=()=>window.__previewDeliver('amo-theme-changed',{theme:document.documentElement.dataset.amoTheme==='light'?'dark':'light'});document.querySelector('.preview-bar').insertBefore(themeButton,document.getElementById('preview-back'));`;
 const output=path.join(root,'build');
 await build({stdin:{contents:fixture+themeFixture,resolveDir:repo,loader:'tsx'},bundle:true,outdir:output,entryNames:'app',platform:'browser',format:'iife',jsx:'automatic',nodePaths:[path.join(repo,'overlay/node_modules')],define:{'process.env.NODE_ENV':'"production"'},loader:{'.svg':'dataurl','.png':'dataurl'},plugins:[{name:'native-isolation',setup(b){b.onResolve({filter:/^@tauri-apps\//},()=>({path:'native',namespace:'native'}));b.onLoad({filter:/.*/,namespace:'native'},()=>({contents:native,loader:'js'}));}}]});
 const js=fs.readFileSync(path.join(output,'app.js'),'utf8').replaceAll('http://127.0.0.1:17654','');
 if(/https?:\/\/[^\s"'`]*:17654/.test(js))throw new Error('Production Broker URL remained');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AMO 新任务 · 隔离实现预览</title><link rel="stylesheet" href="/app.css"><style>body{margin:0}.preview-bar{font:12px/1.5 sans-serif;background:#e5eee8;color:#24382e;padding:8px 12px;display:flex;gap:8px;flex-wrap:wrap}.preview-bar select{max-width:100%}.task-launch{min-height:calc(100vh - 80px)!important}#native-status{flex-basis:100%}[hidden]{display:none!important}.amo-focus-panel{height:calc(100vh - 90px)}</style><aside class="preview-bar"><strong>真实入口与临时数据 · 凭据 / CLI / 窗口均模拟</strong><select id="scenario" aria-label="模拟场景"><option value="normal">正常接入</option><option value="delayed">等待接入</option><option value="early">Hook 早于启动返回</option><option value="failure">启动结果不确定</option><option value="not-started">确认未启动（可重试）</option></select><button id="preview-back" hidden>返回启动入口</button><span id="native-status">请勿输入真实凭据 · 不会启动真实 CLI 或发送任务</span></aside><div id="root"></div><script src="/app.js"></script></html>`;
 let origin;const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  try{
   if(req.headers.origin&&req.headers.origin!==origin){res.writeHead(403);return res.end('Cross-origin request blocked');}
   const url=new URL(req.url,origin);if(url.origin!==origin){res.writeHead(403);return res.end();}
   // Same-origin was checked above; act as a trusted local proxy to Broker routes.
   delete req.headers.origin;
   if(await handleTaskLaunchRoutes(req,res,url,{taskLauncher}))return;
   if(await handleFocusPanelRoutes(req,res,url,{cardStore}))return;
   if(await handleCardRoutes(req,res,url,{cardStore}))return;
   if(req.method==='GET'&&/^\/api\/sessions\/[^/]+$/.test(url.pathname)){const session=sessions.get(decodeURIComponent(url.pathname.split('/').pop()));return sendJson(res,session?200:404,{session:session||null});}
   if(req.method==='POST'&&url.pathname==='/preview/scenario'){const data=await readJsonBody(req);if(!['normal','early','delayed','failure','not-started'].includes(data.scenario))throw new Error('Invalid scenario');scenario=data.scenario;return sendJson(res,200,{ok:true});}
   if(req.method==='GET'&&url.pathname==='/preview/state')return sendJson(res,200,{cards:(await cardStore.list()).cards,launches:launchStore.list(),calls,sessions:[...sessions.values()]});
   if(url.pathname.startsWith('/api/')){res.writeHead(403);return res.end('API blocked in isolated preview');}
   if(req.method!=='GET'){res.writeHead(405);return res.end();}
   const resource={'/':['text/html',html],'/app.js':['text/javascript',js],'/app.css':['text/css',fs.readFileSync(path.join(output,'app.css'))],'/favicon.ico':['image/x-icon','']}[url.pathname];
   if(!resource){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':resource[0]+'; charset=utf-8','Cache-Control':'no-store'});res.end(resource[1]);
  }catch(e){sendJson(res,e.statusCode||500,{ok:false,error:e.code||'preview_error',message:e.message});}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 const info={url:origin+'/',root,pid:process.pid,nativeSimulation:true,terminalSimulation:true,productionAccess:false};fs.writeFileSync(path.join(root,'preview.json'),JSON.stringify(info,null,2));
 return {info,origin,cardStore,launchStore,sessions,workspaces,calls,taskLauncher,setScenario:value=>scenario=value,async close(){for(const timer of timers)clearTimeout(timer);server.closeAllConnections();await new Promise(r=>server.close(r));await cardStore.dispose();}};
}
module.exports={createPreview};
if(require.main===module)(async()=>{const preview=await createPreview();console.log(JSON.stringify(preview.info,null,2));process.on('SIGINT',()=>void preview.close());process.on('SIGTERM',()=>void preview.close());if(process.argv.includes('--check')){const context=await fetch(preview.origin+'/api/task-launch-context').then(r=>r.json());if(context.workspaces.length!==3||context.groups.length!==2)throw new Error('Fixture context invalid');if((await fetch(preview.origin+'/api/sessions/x/resume',{method:'POST'})).status!==403)throw new Error('Native route leaked');await preview.close();console.log('Isolated preview checks passed.');}})().catch(e=>{console.error(e);process.exitCode=1});
