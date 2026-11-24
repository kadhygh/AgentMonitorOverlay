// A-00: Antigravity CLI (`agy acp`) handshake: initialize + session/new (no prompt), to see authMethods and capabilities.
import { spawn } from "node:child_process";
import { sandboxWorkspace } from "../lib.mjs";

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
const init = await req("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
console.log("initialize:", JSON.stringify(init, null, 1));
const s = await req("session/new", { cwd, mcpServers: [] });
console.log("session/new:", JSON.stringify(s, null, 1).slice(0, 6000));
child.stdin.end(); setTimeout(() => child.kill(), 3000);
