// One model session per agent, driven straight through each vendor's CLI (no Studio Host), so the model sees only this
// spike's MCP server (named amo, like Studio's, but with the simulated 协作 tools) and never Studio's own cowork_*:
//   sonnet     claude -p --strict-mcp-config --mcp-config <file> (this computer's Claude Code login), --resume per turn
//   gpt6.2sol  codex exec / codex exec resume, the DXX site as a model provider (old AMO's DXX key, read only), its own CODEX_HOME
//   dxx-ds     DSH over ACP (`dsh --profile acp`), session/new with only this MCP server, its own DSH_HOME, the
//              built-in DeepSeek key (old AMO's deepseek-v4 entry, read only) — the same stand-in cowork-scenario used
// Each turn returns { text, usage: { input, cached, output }, tools: [{ name, input }], error }.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { readAmoCredential } from "../lib.mjs";
import { resolveCodexCommand } from "../../packages/host/dist/runtime/codex/command.js";

const secrets = {};
const secret = (id) => (secrets[id] ??= readAmoCredential(id));

/** The environment of a CLI we start: without the Claude Code / Studio markers this process inherits. */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC|AMO_|CODEX_)/.test(k) || k === "MCP_CONNECTION_NONBLOCKING") delete env[k];
  return { ...env, ...extra };
}

function run(command, args, { cwd, env, input, onLine, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let buf = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {}
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
      }
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buf.trim()) onLine(buf.trim());
      resolve({ code, stderr: err });
    });
    child.stdin.end(input);
  });
}

export class ClaudeRunner {
  constructor({ key, cwd, mcpUrl, dir, model = "sonnet" }) {
    Object.assign(this, { key, cwd, mcpUrl, dir, model });
    this.id = crypto.randomUUID();
    this.turns = 0;
    this.mcpFile = path.join(dir, `mcp-${key}.json`);
    writeFileSync(this.mcpFile, JSON.stringify({ mcpServers: { amo: { type: "http", url: mcpUrl } } }));
    this.raw = path.join(dir, `raw-${key}.jsonl`);
  }
  async turn(text, timeoutMs = 15 * 60_000) {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", this.model, "--permission-mode", "bypassPermissions", "--strict-mcp-config", "--mcp-config", this.mcpFile, "--setting-sources", "project", "--tools", "Bash,Read,Edit,Write,Glob,Grep,ToolSearch", this.turns === 0 ? "--session-id" : "--resume", this.id];
    this.turns++;
    const out = { text: "", usage: null, tools: [], error: null, init: null };
    const r = await run("claude", args, {
      cwd: this.cwd,
      env: cleanEnv({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }),
      input: text,
      timeoutMs,
      onLine: (line) => {
        appendFileSync(this.raw, line + "\n");
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          return;
        }
        if (e.type === "system" && e.subtype === "init") out.init = { tools: e.tools, mcp: e.mcp_servers, model: e.model };
        if (e.type === "assistant") for (const c of e.message?.content ?? []) if (c.type === "tool_use") out.tools.push({ name: c.name, input: c.input });
        if (e.type === "result") {
          out.text = e.result ?? "";
          const u = e.usage ?? {};
          out.usage = { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0, costUsd: e.total_cost_usd ?? null };
          if (e.is_error) out.error = e.result || e.subtype;
        }
      },
    });
    if (!out.usage) out.error = out.error ?? `claude exited ${r.code}: ${r.stderr.slice(-600)}`;
    return out;
  }
  async close() {}
}

export class CodexRunner {
  constructor({ key, cwd, mcpUrl, dir, codexHome }) {
    Object.assign(this, { key, cwd, mcpUrl, dir, codexHome });
    mkdirSync(codexHome, { recursive: true });
    this.thread = null;
    this.raw = path.join(dir, `raw-${key}.jsonl`);
  }
  async turn(text, timeoutMs = 15 * 60_000) {
    const cmd = resolveCodexCommand();
    const cfg = {
      model_provider: "dxx",
      "model_providers.dxx.name": "DXX",
      "model_providers.dxx.base_url": "https://gorilla-api.dxxapi.com/v1",
      "model_providers.dxx.wire_api": "responses",
      "model_providers.dxx.env_key": "DXX_API_KEY",
      model: "gpt-6.2-sol",
      "mcp_servers.amo.url": this.mcpUrl,
      "mcp_servers.amo.default_tools_approval_mode": "approve",
    };
    const c = Object.entries(cfg).flatMap(([k, v]) => ["-c", `${k}=${JSON.stringify(v)}`]);
    const common = ["--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", ...c];
    const args = this.thread ? [...cmd.prefixArgs, "exec", "resume", ...common, this.thread, "-"] : [...cmd.prefixArgs, "exec", ...common, "-C", this.cwd, "-"];
    const out = { text: "", usage: null, tools: [], error: null };
    const texts = [];
    const r = await run(cmd.command, args, {
      cwd: this.cwd,
      env: cleanEnv({ ...cmd.env, CODEX_HOME: this.codexHome, DXX_API_KEY: secret("dxx") }),
      input: text,
      timeoutMs,
      onLine: (line) => {
        appendFileSync(this.raw, line + "\n");
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          return;
        }
        if (e.type === "thread.started") this.thread = e.thread_id;
        if (e.type === "item.completed") {
          const it = e.item ?? {};
          if (it.type === "agent_message") texts.push(it.text);
          if (it.type === "mcp_tool_call") out.tools.push({ name: `mcp__${it.server}__${it.tool}`, input: it.arguments });
          if (it.type === "command_execution") out.tools.push({ name: "Bash", input: { command: it.command } });
          if (it.type === "file_change") out.tools.push({ name: "Edit", input: { changes: it.changes } });
        }
        if (e.type === "turn.completed") {
          const u = e.usage ?? {};
          out.usage = { input: u.input_tokens ?? 0, cached: u.cached_input_tokens ?? 0, output: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0) };
        }
        if (e.type === "turn.failed" || e.type === "error") out.error = JSON.stringify(e.error ?? e.message ?? e).slice(0, 600);
      },
    });
    out.text = texts.at(-1) ?? "";
    if (!out.usage && !out.error) out.error = `codex exited ${r.code}: ${r.stderr.slice(-600)}`;
    return out;
  }
  async close() {}
}

export class DshRunner {
  constructor({ key, cwd, mcpUrl, dir, dshHome, dshRoot }) {
    Object.assign(this, { key, cwd, mcpUrl, dir, dshHome, dshRoot });
    mkdirSync(dshHome, { recursive: true });
    this.raw = path.join(dir, `raw-${key}.jsonl`);
    this.nextId = 1;
    this.pending = new Map();
    this.updates = [];
    this.session = null;
  }
  entry() {
    const built = path.join(this.dshRoot, "apps", "cli", "lib", "bin.js");
    if (existsSync(built)) return [built];
    throw new Error(`no built DSH at ${built}`);
  }
  async start() {
    this.child = spawn(process.execPath, [...this.entry(), "--profile", "acp"], {
      cwd: this.cwd,
      env: cleanEnv({ DSH_HOME: this.dshHome, DEEPSEEK_API_KEY: secret("deepseek-v4"), DSH_PERMISSION_MODE: "danger-full-access" }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let buf = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.handle(line);
      }
    });
    this.child.stderr.on("data", (d) => appendFileSync(path.join(this.dir, `dsh-${this.key}.stderr.log`), d));
    await this.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, 120_000);
    const created = await this.request("session/new", { cwd: this.cwd, mcpServers: [{ type: "http", name: "amo", url: this.mcpUrl, headers: [] }] }, 120_000);
    this.session = created.sessionId;
  }
  handle(line) {
    appendFileSync(this.raw, line + "\n");
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message));
      else p?.resolve(msg.result);
      return;
    }
    if (msg.method === "session/update") return void this.updates.push(msg.params.update);
    if (msg.method === "session/request_permission") {
      const opt = msg.params.options.find((o) => o.kind === "allow_always") ?? msg.params.options.find((o) => o.kind === "allow_once");
      this.send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: opt?.optionId ?? "allow-once" } } });
      return;
    }
    if (msg.id !== undefined) this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported" } });
  }
  send(m) {
    this.child.stdin.write(JSON.stringify(m) + "\n");
  }
  request(method, params, timeoutMs) {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      this.pending.set(id, { resolve: (v) => (clearTimeout(t), resolve(v)), reject: (e) => (clearTimeout(t), reject(e)) });
    });
  }
  async turn(text, timeoutMs = 15 * 60_000) {
    const out = { text: "", usage: null, tools: [], error: null };
    try {
      if (!this.session) await this.start();
      const from = this.updates.length;
      const res = await this.request("session/prompt", { sessionId: this.session, prompt: [{ type: "text", text }] }, timeoutMs);
      const ups = this.updates.slice(from);
      out.text = ups.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content?.text ?? "").join("");
      for (const u of ups.filter((u) => u.sessionUpdate === "tool_call")) out.tools.push({ name: u.title ?? u.kind, input: u.rawInput });
      // usage_update is the session's running total: this turn = the last one minus the one before the turn.
      const before = this.updates.slice(0, from).filter((u) => u.sessionUpdate === "usage_update").at(-1);
      const after = ups.filter((u) => u.sessionUpdate === "usage_update").at(-1);
      out.usageRaw = after ?? null;
      const used = ups.filter((u) => u.sessionUpdate === "usage_update").map((u) => u.used ?? 0);
      // DSH reports only the context size after each model call: their sum is the input it read this turn (cache included).
      out.usage = { input: used.reduce((a, b) => a + b, 0) || null, cached: null, output: null, context: used.at(-1) ?? null, calls: used.length };
      out.promptResult = res;
      if (res?.stopReason && res.stopReason !== "end_turn") out.error = `stopReason ${res.stopReason}`;
    } catch (err) {
      out.error = err.message;
    }
    return out;
  }
  async close() {
    try {
      this.child?.stdin.end();
      setTimeout(() => this.child?.kill(), 5000);
    } catch {}
  }
}

function usageDelta(before, after) {
  if (!after) return null;
  const pick = (u) => ({ input: u?.used ?? u?.inputTokens ?? u?.input_tokens ?? 0, output: u?.outputTokens ?? u?.output_tokens ?? 0, cached: u?.cachedReadTokens ?? u?.cached_input_tokens ?? 0 });
  const a = pick(after);
  const b = pick(before);
  return { input: a.input - b.input, output: a.output - b.output, cached: a.cached - b.cached, raw: after };
}
