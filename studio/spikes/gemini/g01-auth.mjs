// G-01: sign in with Google through ACP's authenticate (oauth-personal) — the flow Studio would offer — then session/new.
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { sandboxWorkspace } from "../lib.mjs";

const root = execSync("npm root -g").toString().trim();
const entry = path.join(root, "@google", "gemini-cli", "bundle", "gemini.js");
const cwd = sandboxWorkspace("gemini/workspace");
const child = spawn(process.execPath, [entry, "--acp"], { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
    else console.log("[incoming]", JSON.stringify(m).slice(0, 1500));
  }
});
const req = (method, params, ms = 60000) => new Promise((r) => { const i = id++; pending.set(i, r); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); setTimeout(() => r({ timeout: method }), ms); });
await req("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
const t0 = Date.now();
const a = await req("authenticate", { methodId: "oauth-personal" }, 600000);
console.log("authenticate:", JSON.stringify(a), "ms", Date.now() - t0);
const s = await req("session/new", { cwd, mcpServers: [] });
console.log("session/new:", JSON.stringify(s, null, 1).slice(0, 5000));
child.stdin.end(); setTimeout(() => child.kill(), 3000);
