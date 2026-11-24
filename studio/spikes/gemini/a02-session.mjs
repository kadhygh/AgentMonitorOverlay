// A-02: agy acp without a model turn: session/new with an HTTP and a stdio MCP server, set_config_option (model,
// thought_level, mode), session/set_mode, session/list, session/load / resume in a fresh process, auth/logout absent here.
import { spawn } from "node:child_process";
import { sandboxWorkspace } from "../lib.mjs";

const exe = process.argv[2];
const cwd = sandboxWorkspace("agy/workspace");
function start(label) {
  const child = spawn(exe, ["acp"], { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "1" } });
  let buf = "", id = 1; const pending = new Map();
  child.stderr.on("data", (d) => process.stderr.write(`[${label} stderr] ` + d));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    buf += c; let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { console.log("[non-json]", line.slice(0, 300)); continue; }
      if (m.id !== undefined && !m.method) { const p = pending.get(m.id); pending.delete(m.id); p?.(m); }
      else if (m.params?.update?.sessionUpdate !== "available_commands_update") console.log(`[${label} incoming]`, JSON.stringify(m).slice(0, 800));
    }
  });
  const req = (method, params, ms = 60000) => new Promise((r) => { const i = id++; pending.set(i, r); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); setTimeout(() => r({ timeout: method }), ms); });
  return { child, req, close: () => { child.stdin.end(); setTimeout(() => child.kill(), 2000); } };
}
const short = (x) => JSON.stringify(x).slice(0, 1200);
const a = start("A");
await a.req("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
const mcpServers = [
  { type: "http", name: "amo-http", url: "http://127.0.0.1:47962/mcp", headers: [{ name: "Authorization", value: "Bearer test" }] },
  { name: "amo-stdio", command: process.execPath, args: ["-e", "setTimeout(()=>{},1)"], env: [] },
];
const s = await a.req("session/new", { cwd, mcpServers });
console.log("session/new (2 MCP):", short(s.error ?? { sessionId: s.result?.sessionId }));
const sid = s.result?.sessionId;
if (sid) {
  console.log("set model:", short(await a.req("session/set_config_option", { sessionId: sid, configId: "model", value: "claude-sonnet-4-6" })));
  console.log("set thought_level:", short(await a.req("session/set_config_option", { sessionId: sid, configId: "thought_level", value: "low" })));
  console.log("set mode (config):", short(await a.req("session/set_config_option", { sessionId: sid, configId: "mode", value: "accept-edits" })));
  console.log("set_mode:", short(await a.req("session/set_mode", { sessionId: sid, modeId: "plan" })));
  console.log("set_model:", short(await a.req("session/set_model", { sessionId: sid, modelId: "gemini-3.8-flash-low" })));
  console.log("list:", short(await a.req("session/list", { cwd })));
}
a.close();
await new Promise((r) => setTimeout(r, 3000));
if (sid) {
  const b = start("B");
  await b.req("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  console.log("B load:", short(await b.req("session/load", { sessionId: sid, cwd, mcpServers: [] })));
  console.log("B resume:", short(await b.req("session/resume", { sessionId: sid, cwd, mcpServers: [] })));
  console.log("B list:", short(await b.req("session/list", {})));
  b.close();
}
