import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const sessions = new Map();
const upstream = 'https://canvas.dxx.cn/api/mcp/sse';
const maxIdle = 30 * 60_000;
async function drop(id) {
  const session = sessions.get(id);
  sessions.delete(id);
  if (session) await session.client.close().catch(() => {});
}
setInterval(() => {
  for (const [id, session] of sessions) if (!session.busy && Date.now() - session.used > maxIdle) void drop(id);
}, 60_000).unref();

export async function connect(key, endpoint = upstream) {
  const url = new URL(endpoint);
  let httpFailure;
  const authorizedFetch = async (input, init = {}) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (target.origin !== url.origin) throw new Error('拒绝向不同站点发送密钥');
    const headers = new Headers(init.headers);
    headers.set('Authorization', key);
    const response = await fetch(input, { ...init, headers, redirect: 'error' });
    if (!response.ok) {
      const phase = init.method === 'POST' ? 'MCP 消息 POST' : 'SSE 连接 GET';
      const diagnostic = { phase, status: response.status, authorizationFormat: /^Bearer\s/i.test(key) ? 'Bearer' : '原样', authorizationSent: true };
      // Read a bounded JSON error only; never expose HTML gateway pages or headers.
      if (response.headers.get('content-type')?.includes('application/json')) {
        const reader = response.body?.getReader();
        let raw = '';
        try {
          if (reader) {
            const decoder = new TextDecoder();
            while (raw.length < 8192) {
              const { value, done } = await reader.read();
              if (done) break;
              raw += decoder.decode(value, { stream: true });
            }
            if (raw.length < 8192) {
              const payload = JSON.parse(raw);
              const redact = value => String(value).split(key).join('[密钥已隐藏]').split(key.replace(/^Bearer\s+/i, '')).join('[密钥已隐藏]').replace(/https?:\/\/\S+/g, '[URL 已隐藏]').slice(0, 500);
              if (typeof payload.code === 'string') diagnostic.code = redact(payload.code);
              const detail = typeof payload.error === 'string' ? payload.error : payload.message;
              if (typeof detail === 'string') diagnostic.message = redact(detail);
            }
          }
        } catch {} finally { await reader?.cancel().catch(() => {}); }
      }
      httpFailure = new Error(`${phase} 返回 HTTP ${response.status}${diagnostic.code ? `（${diagnostic.code}）` : ''}${diagnostic.message ? `：${diagnostic.message}` : ''}`);
      httpFailure.diagnostic = diagnostic;
      throw httpFailure;
    }
    httpFailure = undefined;
    return response;
  };
  const transport = new SSEClientTransport(url, {
    requestInit: { headers: { Authorization: key }, redirect: 'error' },
    fetch: authorizedFetch,
    eventSourceInit: { fetch: authorizedFetch },
  });
  const client = new Client({ name: 'canvas-local-tester', version: '1.0.0' }, { capabilities: {} });
  let timer;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('连接超时（30 秒），请检查网络和密钥')), 30_000); }),
    ]);
    const tools = [];
    let cursor;
    const cursors = new Set();
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('工具列表分页游标重复');
      cursors.add(cursor);
    } while (cursor);
    return { client, tools, server: client.getServerVersion() };
  } catch (error) {
    await client.close().catch(() => {});
    throw httpFailure || error;
  } finally { clearTimeout(timer); }
}

const assets = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
export function createServer() {
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https: http:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const respond = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    let submittedKey;
    try {
      const host = req.headers.host;
      const expected = `127.0.0.1:${serverPort(res)}`;
      if (host !== expected && host !== `localhost:${serverPort(res)}`) return respond(403, { error: '仅允许本机访问' });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return respond(403, { error: '拒绝跨站请求' });
      if (req.method === 'GET' && assets.has(req.url)) {
        const [name, type] = assets.get(req.url);
        const data = await readFile(new URL(`./public/${name}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(data);
      }
      if (req.method !== 'POST' || !req.url.startsWith('/api/')) return respond(404, { error: '不存在' });
      if (!req.headers['content-type']?.startsWith('application/json')) return respond(415, { error: '需要 JSON 请求' });
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 1024 * 1024) return respond(413, { error: '参数超过 1 MB' });
      }
      const body = JSON.parse(raw);
      if (req.url === '/api/connect') {
        submittedKey = body.key;
        if (typeof body.key !== 'string' || !body.key.trim() || /[\r\n]/.test(body.key)) return respond(400, { error: '请输入有效的 Authorization 密钥' });
        if (sessions.size >= 8) return respond(429, { error: '连接过多，请先断开其他测试页' });
        const connected = await connect(body.key.trim());
        const id = randomUUID();
        sessions.set(id, { ...connected, used: Date.now(), busy: false });
        return respond(200, { id, tools: connected.tools, server: connected.server });
      }
      const session = sessions.get(body.id);
      if (!session) return respond(401, { error: '连接已过期，请重新连接' });
      session.used = Date.now();
      if (req.url === '/api/disconnect') { await drop(body.id); return respond(200, { ok: true }); }
      if (req.url === '/api/call') {
        if (session.busy) return respond(409, { error: '已有调用正在进行' });
        if (!session.tools.some(tool => tool.name === body.name)) return respond(400, { error: '请选择已发现的工具' });
        if (!body.arguments || typeof body.arguments !== 'object' || Array.isArray(body.arguments)) return respond(400, { error: '参数必须是 JSON 对象' });
        session.busy = true;
        try {
          const result = await session.client.callTool({ name: body.name, arguments: body.arguments }, undefined, { timeout: 600_000 });
          return respond(200, { result });
        } finally { session.busy = false; session.used = Date.now(); }
      }
      respond(404, { error: '不存在' });
    } catch (error) {
      let message = error.message || '请求失败';
      if (submittedKey) message = message.split(submittedKey).join('[密钥已隐藏]');
      // Never return upstream URLs/query strings or transport error bodies which may contain credentials.
      if (error.diagnostic) return respond(400, { error: message, diagnostic: error.diagnostic });
      if (/401|403/.test(message)) message = `MCP 请求被拒绝：${/401/.test(message) ? 'HTTP 401' : 'HTTP 403'}。请检查凭证及权限`;
      else if (/https?:|fetch failed|SSE error/i.test(message)) message = 'MCP 网络连接失败，请检查网络、服务地址及密钥；服务也可能返回了错误状态';
      respond(400, { error: message });
    }
  });
}
function serverPort(res) { return res.socket.localPort; }
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.CANVAS_TEST_PORT || 4318);
  createServer().listen(port, '127.0.0.1', () => console.log(`Canvas MCP test: http://127.0.0.1:${port}`));
}
