import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { connect, createServer } from './server.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

test('SSE handshake, authorization on GET and POST, paginated tools, image and error results', async () => {
  let stream;
  const seen = [];
  const mock = http.createServer(async (req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization });
    if (req.headers.authorization !== 'test-mcp-key') { res.writeHead(401); return res.end(); }
    if (req.url === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      stream = res; res.write('event: endpoint\ndata: /messages\n\n'); return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'test-canvas', version: '1' } };
    if (message.method === 'tools/list') result = message.params?.cursor ? { tools: [{ name: 'status', inputSchema: { type: 'object' } }] } : { tools: [{ name: 'generate_image', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } }], nextCursor: 'page2' };
    if (message.method === 'tools/call') result = message.params.arguments.fail ? { isError: true, content: [{ type: 'text', text: 'Generation failed' }] } : { content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] };
    res.writeHead(202); res.end();
    if (message.id !== undefined) stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
  });
  const url = await listen(mock);
  let client;
  try {
    const connected = await connect('test-mcp-key', `${url}/sse`); client = connected.client;
    assert.equal(connected.tools.length, 2);
    const result = await client.callTool({ name: 'generate_image', arguments: { prompt: 'cat' } });
    assert.equal(result.content[0].type, 'image');
    const failure = await client.callTool({ name: 'generate_image', arguments: { fail: true } });
    assert.equal(failure.isError, true);
    assert.ok(seen.some(item => item.path === '/sse'));
    assert.ok(seen.some(item => item.path === '/messages'));
    assert.ok(seen.every(item => item.auth === 'test-mcp-key'));
  } finally { if (client) await client.close(); await close(mock); }
});

test('invalid key fails cleanly', async () => {
  const mock = http.createServer((req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 'AUTH_REQUIRED', error: `Rejected ${req.headers.authorization}` })); });
  const url = await listen(mock);
  try {
    await assert.rejects(connect('Bearer test-secret', `${url}/sse`), error => {
      assert.equal(error.diagnostic.status, 401);
      assert.equal(error.diagnostic.phase, 'SSE 连接 GET');
      assert.equal(error.diagnostic.code, 'AUTH_REQUIRED');
      assert.equal(error.diagnostic.authorizationFormat, 'Bearer');
      assert.ok(!JSON.stringify(error).includes('test-secret'));
      assert.ok(!error.message.includes('test-secret'));
      return true;
    });
  }
  finally { await close(mock); }
});

test('local page, origin protection, JSON validation and expired session', async () => {
  const server = createServer(), url = await listen(server);
  try {
    assert.equal((await fetch(url)).status, 200);
    const post = (body, headers = {}) => fetch(`${url}/api/call`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await post({}, { Origin: 'https://foreign.example' })).status, 403);
    assert.equal((await post({ id: 'expired' })).status, 401);
    assert.equal((await fetch(`${url}/api/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"key":""}' })).status, 400);
  } finally { await close(server); }
});
