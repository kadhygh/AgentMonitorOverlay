// Real Focus UI + a fresh isolated Broker, with browser-only native simulation.
// Run: node scripts/performance/focus-panel-preview.cjs
// Check startup/isolation then stop: node scripts/performance/focus-panel-preview.cjs --check
// The preview starts empty; user-created cards persist in the printed tmp folder.
// No Playwright dependency, no production Broker access, no native task commands.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { build } = require('../../overlay/node_modules/esbuild');
const repo = path.resolve(__dirname, '../..');
fs.mkdirSync(path.join(repo, 'tmp'), { recursive: true });
const root = fs.mkdtempSync(path.join(repo, 'tmp', 'focus-manual-preview-'));
let broker, server, closing = false;
let brokerLog = '';

const native = `
const listeners=new Map();let visible=true;
export async function listen(name,fn){const set=listeners.get(name)||new Set();set.add(fn);listeners.set(name,set);return()=>set.delete(fn);}
async function emitTo(target,name,payload){
  if(name==='amo-focus-session-command')throw new Error('隔离预览不执行真实 Session 或原生命令');
  if(target==='focus')for(const fn of listeners.get(name)||[])fn({payload});
}
const visibility=async value=>{visible=value;document.getElementById('root').hidden=!value;await emitTo('focus','amo-focus-visibility',value);};
const current={label:'focus',listen,emitTo,async isVisible(){return visible;},async show(){await visibility(true);},async hide(){await visibility(false);},async setFocus(){},async setAlwaysOnTop(){},async unminimize(){},async startDragging(){},async onCloseRequested(){return()=>{};}};
export const getCurrentWindow=()=>current;
export const getCurrentWebviewWindow=()=>current;
export class Window{static async getByLabel(label){return label==='focus'?current:null;}}
export class WebviewWindow extends Window{}
export const invoke=async name=>{if(name==='set_startup_theme')return;throw new Error('Native command blocked in isolated preview: '+name);};
export const openUrl=async()=>{throw new Error('External action blocked in isolated preview');};
export const openPath=openUrl;export const revealItemInDir=openUrl;
export const emit=(name,payload)=>emitTo('focus',name,payload);
window.__previewShow=()=>visibility(true);
window.__previewTheme=()=>emitTo('focus','amo-theme-changed',{theme:document.documentElement.dataset.amoTheme==='light'?'dark':'light'});
`;
const fixture = `
import React from 'react';import {createRoot} from 'react-dom/client';
import './overlay/src/styles.css';import {FocusPanelApp} from './overlay/src/windows/FocusPanelApp';
createRoot(document.getElementById('root')).render(<FocusPanelApp/>);
document.getElementById('preview-show').addEventListener('click',()=>window.__previewShow());
document.getElementById('preview-theme').addEventListener('click',()=>window.__previewTheme());
`;
const previewCss = `
body{margin:0;background:radial-gradient(ellipse at 15% 5%,#abbda9,transparent 65%),linear-gradient(130deg,#647466,#8995a2);}
html[data-amo-theme='light'] body{background:radial-gradient(ellipse at 15% 5%,#faf6e9,transparent 65%),linear-gradient(130deg,#e8ede4,#cfdae9);}
.preview-bar{height:48px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 12px;background:#ffffffea;color:#24312a;font:12px/1.4 'Segoe UI','Microsoft YaHei',sans-serif;border-bottom:1px solid #0002;box-sizing:border-box;}
.preview-bar span{display:flex;gap:6px}.preview-bar button{border:1px solid #aab8ae;border-radius:6px;background:white;color:#24312a;padding:5px 8px;cursor:pointer;font:inherit;white-space:nowrap;}
#root .amo-focus-panel{height:calc(100vh - 48px);}
[hidden]{display:none!important;}
`;
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Focus Panel · 隔离预览</title><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/preview.css"></head><body><aside class="preview-bar"><strong>隔离预览 · 仅测试 Card · 原生窗口接口为模拟</strong><span><button id="preview-theme">切换明暗</button><button id="preview-show">显示面板</button></span></aside><div id="root"></div><script src="/app.js"></script></body></html>';

async function close() {
  if (closing) return;
  closing = true;
  if (server) { server.close(); server.closeAllConnections?.(); }
  if (broker && broker.exitCode === null) {
    const stopped = new Promise(resolve => broker.once('exit', resolve));
    broker.kill(); await stopped;
  }
}
async function main() {
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify({ sessions: [] }));
  const output = path.join(root, 'build');
  await build({ stdin: { contents: fixture, resolveDir: repo, loader: 'tsx' }, bundle: true, outdir: output,
    entryNames: 'app', platform: 'browser', format: 'iife', jsx: 'automatic',
    nodePaths: [path.join(repo, 'overlay/node_modules')], define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.png': 'dataurl', '.svg': 'dataurl' }, plugins: [{ name: 'preview-native', setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\// }, () => ({ path: 'native', namespace: 'native' }));
      builder.onLoad({ filter: /.*/, namespace: 'native' }, () => ({ contents: native, loader: 'js' }));
    } }],
  });
  // Rewriting the generated bundle leaves production source configuration intact.
  // Relative API URLs are forced through the allowlisted same-origin proxy below.
  const bundlePath = path.join(output, 'app.js');
  const bundle = fs.readFileSync(bundlePath, 'utf8').replaceAll('http://127.0.0.1:17654', '');
  if (/https?:\/\/[^\s"'`]*:17654/.test(bundle)) throw new Error('Production Broker URL remained in preview bundle');
  fs.writeFileSync(bundlePath, bundle);
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const brokerPort = probe.address().port; await new Promise(resolve => probe.close(resolve));
  broker = spawn(process.execPath, [path.join(repo, 'broker/server.js')], { cwd: repo, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AGENT_MONITOR_HOST: '127.0.0.1', AGENT_MONITOR_PORT: String(brokerPort),
      AGENT_MONITOR_DATA_FILE: path.join(root, 'sessions.json'), AGENT_MONITOR_WORKSPACE_DATA_FILE: path.join(root, 'workspaces.json'),
      AGENT_MONITOR_LAUNCH_DATA_FILE: path.join(root, 'launches.json'), AGENT_MONITOR_TASK_CANVAS_DATA_FILE: path.join(root, 'canvas.json'),
      AGENT_MONITOR_CARDS_DATA_FILE: path.join(root, 'cards.json'),
    },
  });
  broker.stderr.on('data', data => brokerLog += data);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(brokerLog || 'Broker startup timeout')), 10000);
    broker.on('error', error => { clearTimeout(timer); reject(error); });
    broker.stdout.on('data', data => { brokerLog += data; if (brokerLog.includes('listening at')) { clearTimeout(timer); resolve(); } });
    broker.once('exit', code => { clearTimeout(timer); if (!closing) reject(new Error('Preview Broker exited: ' + code)); });
  });
  let origin;
  server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (req.headers.origin && req.headers.origin !== origin) { res.writeHead(403); return res.end('Cross-origin request blocked'); }
      const parsed = new URL(req.url, origin);
      if (parsed.origin !== origin) { res.writeHead(403); return res.end('External proxy target blocked'); }
      if (parsed.pathname.startsWith('/api/')) {
        const readable = req.method === 'GET' && /^\/api\/(focus-panel|card-groups|cards(?:\/[^/]+)?|sessions)$/.test(parsed.pathname);
        const writable = req.method === 'POST' && /^\/api\/(cards(?:\/[^/]+\/commands)?|card-groups\/commands)$/.test(parsed.pathname);
        if (!readable && !writable) { res.writeHead(403); return res.end('Only isolated Card and group operations are allowed'); }
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 262144) { res.writeHead(413); return res.end('Payload too large'); } chunks.push(chunk); }
        const response = await fetch(`http://127.0.0.1:${brokerPort}${parsed.pathname}${parsed.search}`, { method: req.method,
          headers: { 'Content-Type': 'application/json' }, body: writable ? Buffer.concat(chunks) : undefined,
        });
        res.writeHead(response.status, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(Buffer.from(await response.arrayBuffer()));
      }
      if (req.method !== 'GET') { res.writeHead(405); return res.end('Method not allowed'); }
      if (parsed.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      const resources = { '/': ['text/html; charset=utf-8', html], '/app.js': ['text/javascript; charset=utf-8', bundle],
        '/app.css': ['text/css; charset=utf-8', fs.readFileSync(path.join(output, 'app.css'))], '/preview.css': ['text/css; charset=utf-8', previewCss],
      };
      const resource = resources[parsed.pathname];
      if (!resource) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': resource[0] }); res.end(resource[1]);
    } catch (error) { if (!res.headersSent) res.writeHead(502); res.end('Isolated preview request failed: ' + error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const info = { url: origin + '/', dataDirectory: root, brokerPort, pid: process.pid, brokerPid: broker.pid, nativeSimulation: true, productionAccess: false };
  fs.writeFileSync(path.join(root, 'preview.json'), JSON.stringify(info, null, 2));
  console.log(JSON.stringify(info, null, 2));
  if (process.argv.includes('--check')) {
    for (const route of ['/api/focus-panel?includeArchived=1', '/api/card-groups', '/api/sessions']) {
      const response = await fetch(origin + route);
      if (!response.ok) throw new Error('Preview proxy check failed: ' + route);
      const data = await response.json();
      if ((data.cards || data.groups || data.sessions || []).length) throw new Error('Preview must start empty');
    }
    const forbidden = await fetch(origin + '/api/sessions/test/resume', { method: 'POST' });
    if (forbidden.status !== 403) throw new Error('Preview allowed a session action');
    const crossed = await fetch(origin + '/api/card-groups', { headers: { Origin: 'http://example.invalid' } });
    if (crossed.status !== 403) throw new Error('Preview allowed a cross-origin request');
    console.log('Preview startup, empty data and request isolation checks passed.'); await close();
  }
}
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
process.on('exit', () => { if (broker && broker.exitCode === null) broker.kill(); });
main().catch(async error => { console.error(error); console.error('Preview artifacts:', root); process.exitCode = 1; await close(); });
