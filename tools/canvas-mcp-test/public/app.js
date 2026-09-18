const $ = id => document.getElementById(id);
let session = null, tools = [], busy = false;
const status = text => { $('status').textContent = text; };
function controls() {
  $('connect').disabled = busy || !!session;
  $('disconnect').disabled = busy || !session;
  $('key').disabled = busy || !!session;
  $('authMode').disabled = busy || !!session;
  $('tool').disabled = busy || !tools.length;
  $('args').disabled = busy || !tools.length;
  $('run').disabled = busy || !tools.length || !session;
}
async function api(path, body) {
  const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || `HTTP ${response.status}`); error.diagnostic = data.diagnostic; throw error; }
  return data;
}
function sample(schema) {
  if (schema.default !== undefined) return schema.default;
  if (schema.examples?.length) return schema.examples[0];
  if (schema.enum?.length) return schema.enum[0];
  if (schema.type === 'object' || schema.properties) return Object.fromEntries(Object.entries(schema.properties || {}).filter(([key]) => schema.required?.includes(key) || /prompt/i.test(key)).map(([key, value]) => [key, /prompt/i.test(key) && value.type === 'string' ? '一只坐在窗边的橘猫，柔和自然光，细节丰富' : sample(value)]));
  if (schema.type === 'array') return [];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'integer' || schema.type === 'number') return schema.minimum ?? 1;
  return '';
}
function selectTool() {
  const tool = tools.find(tool => tool.name === $('tool').value);
  if (!tool) return;
  $('description').textContent = tool.description || '该工具未提供说明';
  $('schema').textContent = JSON.stringify(tool.inputSchema, null, 2);
  $('args').value = JSON.stringify(sample(tool.inputSchema), null, 2);
}
$('tool').addEventListener('change', selectTool);
$('show').onclick = () => { const show = $('key').type === 'password'; $('key').type = show ? 'text' : 'password'; $('show').textContent = show ? '隐藏' : '显示'; };
$('connect').onclick = async () => {
  if (!$('key').value.trim()) return status('请先输入 MCP 密钥');
  busy = true; controls(); status('正在建立 SSE 连接并读取工具…');
  try {
    let key = $('key').value.trim();
    if ($('authMode').value === 'bearer' && !/^Bearer\s/i.test(key)) key = `Bearer ${key}`;
    const data = await api('connect', { key });
    session = data.id; tools = data.tools;
    $('key').value = ''; $('key').type = 'password'; $('show').textContent = '显示';
    $('badge').textContent = '已连接'; $('count').textContent = `${tools.length} 个工具`;
    $('tool').replaceChildren(...tools.map(tool => new Option(tool.name, tool.name)));
    const preferred = tools.find(tool => /generat|image|draw|生图/i.test(tool.name));
    if (preferred) $('tool').value = preferred.name;
    selectTool();
    status(tools.length ? '连接成功。检查工具说明与参数后，点击执行。' : '连接成功，但服务未返回可用工具。');
    $('raw').textContent = JSON.stringify({ server: data.server, tools: tools.map(t => t.name) }, null, 2);
  } catch (error) { status(error.message); $('raw').textContent = JSON.stringify({ error: error.message, diagnostic: error.diagnostic }, null, 2); $('raw').parentElement.open = true; }
  finally { busy = false; controls(); }
};
$('disconnect').onclick = async () => {
  busy = true; controls();
  try { await api('disconnect', { id: session }); }
  catch (error) { $('raw').textContent = error.message; }
  finally { session = null; tools = []; $('key').value = ''; $('badge').textContent = '未连接'; $('count').textContent = '等待连接'; $('tool').replaceChildren(new Option('连接后显示工具列表', '')); $('args').value = ''; $('schema').textContent = ''; status('已断开，密钥已清除'); busy = false; controls(); }
};
function renderResult(result) {
  $('raw').textContent = JSON.stringify(result, null, 2);
  const gallery = $('gallery'); gallery.replaceChildren();
  const urls = new Set();
  function add(url) {
    if (typeof url === 'string' && (/^https?:\/\//i.test(url) || /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(url))) urls.add(url);
  }
  function walk(value, depth = 0) {
    if (depth > 20 || value == null) return;
    if (typeof value === 'string') {
      if (/^(https?:\/\/|data:image\/)/.test(value)) add(value);
      try { walk(JSON.parse(value), depth + 1); } catch {}
      for (const match of value.matchAll(/https?:\/\/[^\s<>"'\)\]]+/g)) add(match[0]);
    } else if (Array.isArray(value)) value.forEach(item => walk(item, depth + 1));
    else if (typeof value === 'object') {
      if (value.type === 'image' && value.data && /^image\/(png|jpeg|jpg|webp|gif)$/.test(value.mimeType)) add(`data:${value.mimeType};base64,${value.data}`);
      if (value.b64_json) add(`data:image/png;base64,${value.b64_json}`);
      for (const [key, item] of Object.entries(value)) if (key !== 'data' || typeof item !== 'string') walk(item, depth + 1);
    }
  }
  walk(result);
  for (const url of [...urls].slice(0, 30)) {
    const figure = document.createElement('figure'), img = document.createElement('img'), caption = document.createElement('figcaption'), link = document.createElement('a');
    img.alt = '工具返回的图片'; img.referrerPolicy = 'no-referrer'; img.src = url;
    link.href = url; link.textContent = '打开图片 / 返回链接 ↗'; link.target = '_blank'; link.rel = 'noopener noreferrer';
    img.onerror = () => { img.remove(); link.textContent = '预览不可用，打开返回链接 ↗'; };
    caption.append(link); figure.append(img, caption); gallery.append(figure);
  }
  if (!urls.size) { const note = document.createElement('p'); note.className = 'hint'; note.textContent = '本次返回没有可预览图片。展开原始返回查看文字或任务 ID；如为异步任务，选择查询工具并填入任务 ID 再执行。'; gallery.append(note); }
}
$('run').onclick = async () => {
  let args;
  try { args = JSON.parse($('args').value); if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须是 JSON 对象'); }
  catch (error) { return status(`参数错误：${error.message}`); }
  busy = true; controls(); status(`正在执行 ${$('tool').value}，请勿重复提交…`);
  $('raw').textContent = '等待当前调用返回…'; $('gallery').replaceChildren();
  const start = Date.now();
  const tick = setInterval(() => { $('elapsed').textContent = `${Math.floor((Date.now() - start) / 1000)} 秒`; }, 1000);
  try {
    const { result } = await api('call', { id: session, name: $('tool').value, arguments: args });
    renderResult(result); status(result.isError ? '工具返回错误，请展开原始返回查看原因。' : '调用完成，请查看结果。');
  } catch (error) { status(`${error.message}。如调用超时，后台任务可能仍在运行，请先查询再决定是否重试。`); $('raw').textContent = error.message; }
  finally { clearInterval(tick); $('elapsed').textContent = `${((Date.now() - start) / 1000).toFixed(1)} 秒`; busy = false; controls(); }
};
window.addEventListener('pagehide', () => { if (session) void fetch('/api/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: session }), keepalive: true }).catch(() => {}); });
if (document.modelContext?.registerTool) {
  const lifetime = new AbortController();
  Promise.resolve(document.modelContext.registerTool({ name: 'stage_canvas_parameters', description: '把 JSON 参数填入当前所选 MCP 工具的编辑框，供用户检查并手动执行；不提交调用。', inputSchema: { type: 'object', properties: { arguments: { type: 'object' } }, required: ['arguments'], additionalProperties: false }, execute(input) { if (busy || !session || !tools.length) throw new Error('请先连接并选择工具'); if (!input?.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) throw new Error('参数必须是对象'); $('args').value = JSON.stringify(input.arguments, null, 2); return { staged: true, tool: $('tool').value }; } }, { signal: lifetime.signal })).catch(() => {});
  window.addEventListener('pagehide', () => lifetime.abort(), { once: true });
}
