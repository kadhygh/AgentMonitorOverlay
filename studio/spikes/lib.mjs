// Shared helpers for the S1-00 protocol spikes. Secrets stay in memory and child-process env only.
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reserveModelTurn } from "../packages/testkit/dist/budget.js";
import { resolveCodexCommand } from "../packages/host/dist/runtime/codex/command.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export const SANDBOX_ROOT = path.join(os.tmpdir(), "amo-studio-sandbox");

export function sandboxWorkspace(name) {
  const dir = path.join(SANDBOX_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Read-only access to the Windows Credential Manager entry written by old AMO (UTF-8 blob).
export function readAmoCredential(providerId) {
  const target = `AgentMonitorOverlay/model-provider/${providerId}`;
  const ps = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class C {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CRED { public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredReadW(string t, int type, int f, out IntPtr c);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);
  public static string Read(string t) { IntPtr p; if (!CredReadW(t, 1, 0, out p)) return "";
    var c = (CRED)Marshal.PtrToStructure(p, typeof(CRED));
    var b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
    CredFree(p); return System.Text.Encoding.UTF8.GetString(b); }
}
"@
[Console]::Out.Write([C]::Read('${target}'))`;
  const secret = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim();
  if (!secret) throw new Error(`credential ${providerId} not found`);
  return secret;
}

// DeepSeek Flash provider overrides, same values as old AMO's deepseek-profile-v41-flash-flash-all
// minus agents.default_subagent_* (rejected by Codex 0.161).
export function deepseekConfigArgs() {
  const catalog = path.join(here, "assets", "deepseek-profile-v41-flash-flash-all.models.json").replaceAll("\\", "/");
  const kv = {
    model: "deepseek-flash",
    model_provider: "amo-deepseek",
    model_reasoning_effort: "low",
    model_catalog_json: catalog,
    "model_providers.amo-deepseek.name": "DeepSeek · Flash 全部 · V4.1 Flash",
    "model_providers.amo-deepseek.base_url": "https://api.deepseek.com/",
    "model_providers.amo-deepseek.wire_api": "responses",
    "model_providers.amo-deepseek.env_key": "DEEPSEEK_API_KEY",
    review_model: "deepseek-flash",
  };
  return Object.entries(kv).flatMap(([k, v]) => ["-c", `${k}=${JSON.stringify(v)}`]);
}

// Provider definition passed at app-server launch (S1-00c: definitions passed per thread do not survive a restart).
export function deepseekProviderArgs(id = "amo-deepseek") {
  const catalog = path.join(here, "assets", "deepseek-profile-v41-flash-flash-all.models.json").replaceAll("\\", "/");
  const def = { name: "DeepSeek Flash", base_url: "https://api.deepseek.com/", wire_api: "responses", env_key: "DEEPSEEK_API_KEY" };
  return [
    ...Object.entries(def).flatMap(([k, v]) => ["-c", `model_providers.${id}.${k}=${JSON.stringify(v)}`]),
    "-c", `model_catalog_json=${JSON.stringify(catalog)}`,
  ];
}

export function countTurn(note) {
  const r = reserveModelTurn("deepseek", note);
  console.log(`[budget] deepseek ${r.used}/${r.limit}${r.low ? " LOW" : ""} (${note})`);
}

// Starts `codex app-server` on a WS port with a capability token. Returns { url, token, stop, stderr }.
export async function startAppServer({ port, cwd, configArgs = [], env = {}, token = crypto.randomBytes(24).toString("hex") }) {
  if (port < 47900 || port > 47999) throw new Error(`port ${port} outside the Studio range`);
  const tokenFile = path.join(cwd, `.ws-token-${port}`);
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const url = `ws://127.0.0.1:${port}`;
  // A bare spawn("codex") picks the desktop app's bundled 0.144 binary; use the npm CLI the terminal uses (S1-06b).
  const cmd = resolveCodexCommand();
  const child = spawn(cmd.command, [...cmd.prefixArgs, "app-server", ...configArgs, "--listen", url, "--ws-auth", "capability-token", "--ws-token-file", tokenFile],
    { cwd, env: { ...process.env, ...cmd.env, ...env }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  const state = { stderr: "" };
  child.stderr.on("data", (d) => { state.stderr += d; });
  for (let i = 0; i < 60; i++) {
    try { const probe = new RpcClient("probe", url, token); await probe.connect(); probe.close(); break; }
    catch { if (i === 59) throw new Error(`app-server did not start: ${state.stderr.slice(-800)}`); await sleep(500); }
  }
  const stop = async () => {
    if (child.exitCode === null) {
      // codex spawns via a .cmd shim on Windows; kill the whole tree.
      try { execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
      await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
    }
    // The node launcher exits before codex.exe releases the socket; wait until the port refuses connections.
    for (let i = 0; i < 50; i++) {
      const open = await new Promise((r) => { const s = net.connect({ port, host: "127.0.0.1" }); s.once("connect", () => { s.destroy(); r(true); }); s.once("error", () => r(false)); });
      if (!open) break;
      await sleep(100);
    }
    fs.rmSync(tokenFile, { force: true });
  };
  return { url, token, child, stop, state };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal JSON-RPC client over WebSocket. Server requests go to `onServerRequest`, which may answer later.
export class RpcClient {
  constructor(name, url, token, { onServerRequest } = {}) {
    this.name = name; this.url = url; this.token = token; this.onServerRequest = onServerRequest;
    this.nextId = 1; this.pending = new Map(); this.events = []; this.waiters = [];
  }
  async connect() {
    this.ws = new WebSocket(this.url, { headers: { Authorization: `Bearer ${this.token}` } });
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error(`${this.name} ws error`)); });
    this.ws.onmessage = (ev) => this.#onMessage(JSON.parse(ev.data));
    this.ws.onclose = () => this.#push({ kind: "closed" });
    await this.request("initialize", { clientInfo: { name: `amo-studio-spike-${this.name}`, version: "0.0.1" } });
    this.notify("initialized", {});
  }
  #push(e) {
    e.at = Date.now();
    this.events.push(e);
    this.waiters = this.waiters.filter((w) => !(w.pred(e) && (w.res(e), true)));
  }
  #onMessage(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id); this.pending.delete(msg.id);
      if (p) msg.error ? p.rej(Object.assign(new Error(`${p.method}: ${JSON.stringify(msg.error)}`), { rpc: msg.error })) : p.res(msg.result);
    } else if (msg.id !== undefined && msg.method) {
      const e = { kind: "request", id: msg.id, method: msg.method, params: msg.params };
      this.#push(e);
      this.onServerRequest?.(e, this);
    } else if (msg.method) {
      this.#push({ kind: "notification", method: msg.method, params: msg.params });
    }
  }
  respond(id, result) { this.ws.send(JSON.stringify({ id, result })); }
  request(method, params) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej, method }));
  }
  notify(method, params) { this.ws.send(JSON.stringify({ method, params })); }
  waitFor(pred, timeoutMs = 180000) {
    const hit = this.events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${this.name}: timeout waiting`)), timeoutMs);
      this.waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } });
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

export const isTurnDone = (turnId) => (e) => e.method === "turn/completed" && e.params?.turn?.id === turnId;

export function agentText(events, turnId) {
  return events
    .filter((e) => e.method === "item/completed" && e.params?.turnId === turnId && e.params.item?.type === "agentMessage")
    .map((e) => e.params.item.text).join("\n");
}
