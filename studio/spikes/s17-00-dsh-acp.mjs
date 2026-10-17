// S17-00: can Studio drive a DeepSeek Harness source clone over ACP (`dsh --profile acp`, stdio JSON-RPC)?
//   npm run build && node spikes/s17-00-dsh-acp.mjs [DSH clone, default G:\PROJECT\deepseek-harness]
// Real DeepSeek (deepseek-v4 key from old AMO's Credential Manager entry, passed as DEEPSEEK_API_KEY; DSH reads the
// launch environment when its own key file has none). DSH_HOME is a fresh sandbox folder, so the person's ~/.dsh is
// never touched. Checks: initialize, session/new with an HTTP MCP server, permission allow/reject, a second prompt
// while one runs, cancel, usage updates, restart + session/list + session/resume, and whether the agent's commands
// can see the key. Results in spikes/results/s17-00.json.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { countTurn, readAmoCredential, sandboxWorkspace, sleep } from "./lib.mjs";

const dshRoot = process.argv[2] ?? "G:\\PROJECT\\deepseek-harness";
const cwd = sandboxWorkspace("s17-00/workspace");
const dshHome = sandboxWorkspace("s17-00/dsh-home");
fs.rmSync(path.join(cwd, "hello.txt"), { force: true });
const key = readAmoCredential("deepseek-v4");
const out = { dshRoot, entry: null, steps: [] };
const log = (step, data) => {
  out.steps.push({ step, ...data });
  console.log(`[${step}]`, JSON.stringify(data).slice(0, 600));
};

// The entry: a built CLI if the clone has one, else the source through the clone's own tsx.
function entryArgs() {
  const built = path.join(dshRoot, "apps", "cli", "lib", "bin.js");
  if (fs.existsSync(built)) return [built];
  const tsx = path.join(dshRoot, "node_modules", "tsx", "dist", "esm", "index.mjs");
  return ["--import", new URL(`file:///${tsx.replaceAll("\\", "/")}`).href, path.join(dshRoot, "apps", "cli", "src", "bin.ts")];
}

// A tiny Streamable HTTP MCP server standing in for AMO MCP (port in Studio's 47900–47999 range).
const MCP_PORT = 47961;
const mcpHttp = http.createServer(async (req, res) => {
  const server = new McpServer({ name: "amo", version: "0.0.1" }, { instructions: "AMO test server" });
  server.registerTool("amo_whoami", { description: "Who you are in AMO Studio" }, async () => ({
    content: [{ type: "text", text: "You are task 42 「迁移装甲车」 in AMO Studio. Codeword: PELICAN-7." }],
  }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  let body = "";
  for await (const chunk of req) body += chunk;
  await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
});
await new Promise((r) => mcpHttp.listen(MCP_PORT, "127.0.0.1", r));
const mcpServers = [{ type: "http", name: "amo", url: `http://127.0.0.1:${MCP_PORT}/mcp`, headers: [{ name: "Authorization", value: "Bearer test" }] }];

class Acp {
  constructor(label) {
    const args = [...entryArgs(), "--profile", "acp"];
    out.entry = args.map((a) => a.replace(dshRoot, "<dsh>"));
    this.child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, DSH_HOME: dshHome, DEEPSEEK_API_KEY: key },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.stderr = fs.createWriteStream(path.join(sandboxWorkspace("s17-00"), `dsh-${label}.stderr.log`));
    this.child.stderr.pipe(this.stderr);
    this.nextId = 1;
    this.pending = new Map();
    this.updates = [];
    this.onPermission = async () => ({ outcome: { outcome: "selected", optionId: "allow-once" } });
    this.permissions = [];
    let buf = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.handle(JSON.parse(line));
      }
    });
    this.exited = new Promise((r) => this.child.on("exit", (code) => r(code)));
  }
  handle(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p?.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error }));
      else p?.resolve(msg.result);
      return;
    }
    if (msg.method === "session/update") {
      this.updates.push({ at: Date.now(), ...msg.params.update });
      return;
    }
    if (msg.method === "session/request_permission") {
      this.permissions.push(msg.params);
      Promise.resolve(this.onPermission(msg.params)).then((result) => this.send({ jsonrpc: "2.0", id: msg.id, result }));
      return;
    }
    if (msg.id !== undefined) {
      log("unexpected-request", { method: msg.method });
      this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported by the spike" } });
      return;
    }
    log("notification", { method: msg.method });
  }
  send(msg) {
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }
  request(method, params, timeoutMs = 240_000) {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
    });
  }
  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }
  async close() {
    this.child.stdin.end();
    const code = await Promise.race([this.exited, sleep(15_000).then(() => "timeout")]);
    if (code === "timeout") this.child.kill();
    return code;
  }
}

const summarize = (updates) => {
  const kinds = {};
  for (const u of updates) kinds[u.sessionUpdate] = (kinds[u.sessionUpdate] ?? 0) + 1;
  const text = updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content?.text ?? "").join("");
  const tools = updates.filter((u) => u.sessionUpdate === "tool_call").map((u) => ({ title: u.title, kind: u.kind, rawInput: u.rawInput }));
  const results = updates.filter((u) => u.sessionUpdate === "tool_call_update" && u.status).map((u) => ({ status: u.status, content: JSON.stringify(u.content ?? u.rawOutput ?? null).slice(0, 300) }));
  const usage = updates.filter((u) => u.sessionUpdate === "usage_update").at(-1) ?? null;
  return { kinds, text: text.slice(0, 800), tools, results, usage };
};

async function prompt(acp, sessionId, step, text, opts = {}) {
  countTurn(`S17-00 DSH ACP: ${step}`);
  const from = acp.updates.length;
  const t0 = Date.now();
  try {
    const result = await acp.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, opts.timeoutMs);
    log(step, { stopReason: result.stopReason, ms: Date.now() - t0, permissions: acp.permissions.length, ...summarize(acp.updates.slice(from)) });
    return result;
  } catch (e) {
    log(step, { error: e.message, rpc: e.rpc, ms: Date.now() - t0, ...summarize(acp.updates.slice(from)) });
    return null;
  }
}

try {
  // 1. initialize + new session with MCP
  let acp = new Acp("1");
  const init = await acp.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, 120_000);
  log("initialize", init);
  const created = await acp.request("session/new", { cwd, mcpServers });
  const sessionId = created.sessionId;
  log("session/new", { sessionId, configOptions: created.configOptions });

  // 2. allowed commands; can the agent's command see the key?
  acp.onPermission = async (p) => ({ outcome: { outcome: "selected", optionId: p.options.find((o) => o.kind === "allow_once")?.optionId ?? "allow-once" } });
  await prompt(acp, sessionId, "allow", 'Use a shell command to create a file named hello.txt in the current directory containing the single word hi. Then run exactly this command and report its output: node -e "console.log(\'key visible: \' + Boolean(process.env.DEEPSEEK_API_KEY))"');
  log("allow-check", { fileExists: fs.existsSync(path.join(cwd, "hello.txt")), permissionsSeen: acp.permissions.map((p) => ({ toolCall: p.toolCall, options: p.options })) });

  // 3. rejected command
  const before = acp.permissions.length;
  acp.onPermission = async (p) => ({ outcome: { outcome: "selected", optionId: p.options.find((o) => o.kind === "reject_once")?.optionId ?? "reject-once" } });
  await prompt(acp, sessionId, "reject", "Delete hello.txt using a shell command. If you cannot, say why in one sentence.");
  log("reject-check", { fileStillExists: fs.existsSync(path.join(cwd, "hello.txt")), newPermissions: acp.permissions.length - before });

  // 4. MCP tool
  acp.onPermission = async (p) => ({ outcome: { outcome: "selected", optionId: p.options.find((o) => o.kind === "allow_once")?.optionId ?? "allow-once" } });
  await prompt(acp, sessionId, "mcp", "Call the amo_whoami tool and repeat exactly what it returns.");

  // 5. a long command, a second prompt while it runs, then cancel
  const from = acp.updates.length;
  countTurn("S17-00 DSH ACP: cancel");
  const t0 = Date.now();
  const long = acp.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Run the shell command `ping -n 30 127.0.0.1` and then report the average time." }] });
  while (Date.now() - t0 < 60_000 && !acp.updates.slice(from).some((u) => u.sessionUpdate === "tool_call")) await sleep(200);
  await sleep(2000);
  const second = await acp.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Also say hello." }] }, 5_000).then(
    (r) => ({ accepted: true, r }),
    (e) => ({ accepted: false, error: e.message, rpc: e.rpc }),
  );
  log("second-prompt-while-running", second);
  const tCancel = Date.now();
  acp.notify("session/cancel", { sessionId });
  const longResult = await long.catch((e) => ({ error: e.message }));
  log("cancel", { result: longResult, cancelToSettleMs: Date.now() - tCancel, ...summarize(acp.updates.slice(from)) });

  // 6. close, restart the process, list + resume, does it remember?
  const closed = await acp.request("session/close", { sessionId }).catch((e) => ({ error: e.message }));
  log("session/close", { closed, exit: await acp.close() });
  acp = new Acp("2");
  await acp.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, 120_000);
  const list = await acp.request("session/list", { cwd });
  log("session/list", { count: list.sessions?.length, first: list.sessions?.[0] });
  const resumed = await acp.request("session/resume", { sessionId, cwd, mcpServers }).catch((e) => ({ error: e.message, rpc: e.rpc }));
  log("session/resume", { keys: Object.keys(resumed ?? {}), error: resumed?.error, replayedUpdates: acp.updates.length });
  await prompt(acp, sessionId, "after-resume", "What single word did you write into hello.txt earlier in this conversation? Answer with just the word.");
  log("exit", { code: await acp.close() });
} finally {
  mcpHttp.close();
  fs.mkdirSync(path.join(import.meta.dirname, "results"), { recursive: true });
  fs.writeFileSync(path.join(import.meta.dirname, "results", "s17-00.json"), JSON.stringify(out, null, 2));
}
