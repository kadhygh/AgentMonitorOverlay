// A-01: agy acp — authenticate(oauth-personal) through ACP (the flow Studio would offer), session/new, then one tiny prompt.
import { spawn } from "node:child_process";
import { countTurn, sandboxWorkspace } from "../lib.mjs";

const exe = process.argv[2];
const cwd = sandboxWorkspace("agy/workspace");
const child = spawn(exe, ["acp"], { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let buf = "", id = 1; const pending = new Map();
child.stderr.on("data", (d) => process.stderr.write("[stderr] " + d));
child.stdout.setEncoding("utf8");
child.stdout.on("data", (c) => {
  buf += c; let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { console.log("[non-json]", line.slice(0, 300)); continue; }
    if (m.id !== undefined && !m.method) { const p = pending.get(m.id); pending.delete(m.id); p?.(m); }
    else console.log("[incoming]", JSON.stringify(m).slice(0, 2000));
  }
});
const req = (method, params, ms = 60000) => new Promise((r) => { const i = id++; pending.set(i, r); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); setTimeout(() => r({ timeout: method }), ms); });
await req("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
const t0 = Date.now();
const a = await req("authenticate", { methodId: "oauth-personal" }, 600000);
console.log("authenticate:", JSON.stringify(a), "ms", Date.now() - t0);
const s = await req("session/new", { cwd, mcpServers: [] });
console.log("session/new:", JSON.stringify(s, null, 1).slice(0, 6000));
if (s.result?.sessionId) {
  countTurn("A-01 agy acp: first tiny prompt", "gemini");
  const p = await req("session/prompt", { sessionId: s.result.sessionId, prompt: [{ type: "text", text: "Reply with the single word: ok" }] }, 180000);
  console.log("session/prompt:", JSON.stringify(p));
}
child.stdin.end(); setTimeout(() => child.kill(), 3000);
