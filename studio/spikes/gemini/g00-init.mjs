// G-00: Gemini CLI over ACP, handshake only (no model call): initialize + session/new, to see authMethods,
// capabilities and what session/new says before anyone has signed in. Runs in a sandbox cwd; uses the person's ~/.gemini.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { execSync } from "node:child_process";
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
const req = (method, params) => new Promise((r) => { const i = id++; pending.set(i, r); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); setTimeout(() => r({ timeout: method }), 60000); });
const init = await req("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
console.log("initialize:", JSON.stringify(init, null, 1));
const s = await req("session/new", { cwd, mcpServers: [] });
console.log("session/new:", JSON.stringify(s, null, 1).slice(0, 4000));
child.stdin.end(); setTimeout(() => child.kill(), 3000);
