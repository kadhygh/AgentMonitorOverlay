// S4-00: Claude Agent SDK on Windows, routed to GLM, inside the sandbox. Experiments are picked by argument:
//   node spikes/s4-00-claude-sdk.mjs basic approval resume fork subagent interrupt steer cli flags
// Every model turn is counted against the GLM budget. The key only ever goes into the child environment.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { query, forkSession } from "@anthropic-ai/claude-agent-sdk";
import { countTurn, readAmoCredential, sandboxWorkspace, sleep } from "./lib.mjs";

const want = new Set(process.argv.slice(2));
const cwd = sandboxWorkspace("s4-00/workspace");
const claudeHome = sandboxWorkspace("s4-00/claude-home");
const stateFile = path.join(sandboxWorkspace("s4-00"), "state.json");
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
const saveState = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const resultsFile = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "results", "s4-00.json");
const results = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, "utf8")) : {};
const record = (name, data) => {
  results[name] = { at: new Date().toISOString(), ...data };
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  console.log(`[${name}]`, JSON.stringify(data, null, 1).slice(0, 1500));
};

// Red line 2: nothing under the person's ~/.claude may change. Record mtimes before and after.
const userFiles = [path.join(os.homedir(), ".claude.json"), path.join(os.homedir(), ".claude", "settings.json")];
const mtimes = () => Object.fromEntries(userFiles.map((f) => [f, fs.existsSync(f) ? fs.statSync(f).mtimeMs : null]));
const before = mtimes();

// Child environment: inherited variables minus anything Claude/Anthropic (this shell runs inside Claude Code),
// plus the GLM routing from old AMO's glm-5.3 preset and a sandboxed CLAUDE_CONFIG_DIR.
const key = readAmoCredential("glm-5.2");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE|CLAUDECODE)/i.test(k)));
Object.assign(env, {
  CLAUDE_CONFIG_DIR: claudeHome,
  ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
  ANTHROPIC_AUTH_TOKEN: key,
  ANTHROPIC_MODEL: "glm-5.3[1m]",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.7",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3[1m]",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3[1m]",
  CLAUDE_CODE_SUBAGENT_MODEL: "glm-4.7",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  API_TIMEOUT_MS: "600000",
});
// In-process helpers (forkSession, listSessions) read CLAUDE_CONFIG_DIR from this process, not from `env`.
process.env.CLAUDE_CONFIG_DIR = claudeHome;
const base = { cwd, env, settingSources: [], includePartialMessages: true, permissionMode: "default" };

/** Runs one query to the end and summarises what came out. */
async function run(prompt, options = {}, onMessage) {
  const kinds = {};
  const messages = [];
  let sessionId = null;
  let init = null;
  let result = null;
  let thrown = null;
  const q = query({ prompt, options: { ...base, ...options } });
  try {
  for await (const m of q) {
    const kind = m.type === "system" || m.type === "stream_event" ? `${m.type}:${m.subtype ?? m.event?.type}` : m.type;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    sessionId = m.session_id ?? sessionId;
    if (m.type === "system" && m.subtype === "init") init = m;
    if (m.type === "result") result = m;
    if (m.type !== "stream_event") messages.push(m);
    if (onMessage) await onMessage(m, q);
  }
  } catch (e) {
    // Keep only the first line: the SDK's stack embeds minified source.
    thrown = String(e?.message ?? e).split(/\r?\n/)[0].slice(0, 300);
  }
  const text = messages
    .filter((m) => m.type === "assistant" && !m.parent_tool_use_id)
    .flatMap((m) => m.message.content.filter((c) => c.type === "text").map((c) => c.text))
    .join("");
  return { kinds, sessionId, init, result, messages, text, thrown };
}

const brief = (r) => ({
  sessionId: r.sessionId,
  thrown: r.thrown,
  kinds: r.kinds,
  text: r.text.slice(0, 300),
  result: r.result && { subtype: r.result.subtype, is_error: r.result.is_error, num_turns: r.result.num_turns, permission_denials: r.result.permission_denials },
});

try {
  if (want.has("basic")) {
    countTurn("S4-00 basic", "glm");
    const r = await run("Reply with exactly: S4-OK");
    state.basic = r.sessionId;
    saveState();
    record("basic", {
      ...brief(r),
      init: r.init && { claude_code_version: r.init.claude_code_version, model: r.init.model, cwd: r.init.cwd, permissionMode: r.init.permissionMode, tools: r.init.tools?.length, mcp_servers: r.init.mcp_servers, apiKeySource: r.init.apiKeySource },
      transcripts: fs.existsSync(path.join(claudeHome, "projects")) ? fs.readdirSync(path.join(claudeHome, "projects")) : [],
    });
  }

  if (want.has("approval") || want.has("deny")) {
    const allow = want.has("approval");
    countTurn(`S4-00 ${allow ? "approval" : "deny"}`, "glm");
    const asked = [];
    const dir = allow ? "s4-allowed-dir" : "s4-denied-dir";
    fs.rmSync(path.join(cwd, dir), { recursive: true, force: true });
    const r = await run(`Use the Bash tool to run exactly \`mkdir ${dir}\` once. Do not try alternatives. Then reply DONE if it ran or DENIED if it was refused.`, {
      canUseTool: async (toolName, input, ctx) => {
        asked.push({ toolName, input, keys: Object.keys(ctx ?? {}), at: Date.now() });
        await sleep(3000); // a person thinking: the turn must wait
        return allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "The person declined this command." };
      },
    });
    record(allow ? "approval" : "deny", { ...brief(r), asked, waitedMs: 3000, dirExists: fs.existsSync(path.join(cwd, dir)) });
  }

  if (want.has("resume")) {
    countTurn("S4-00 resume", "glm");
    const r = await run("What exact text did you reply with in your first answer? Quote it.", { resume: state.basic });
    record("resume", { ...brief(r), resumedFrom: state.basic, sameSession: r.sessionId === state.basic });
  }

  if (want.has("fork")) {
    countTurn("S4-00 fork", "glm");
    const r = await run("This is a branch. Reply with exactly: S4-FORK", { resume: state.basic, forkSession: true });
    state.fork = r.sessionId;
    saveState();
    let fn = null;
    try {
      fn = await forkSession(state.basic, { dir: cwd, title: "spike fork" });
    } catch (e) {
      fn = { error: String(e?.message ?? e) };
    }
    record("fork", { ...brief(r), parent: state.basic, newSession: r.sessionId !== state.basic, forkSessionFn: fn });
  }

  if (want.has("subagent")) {
    countTurn("S4-00 subagent", "glm");
    const r = await run(
      "Use the Task (Agent) tool to start one general-purpose subagent with the prompt 'Reply with exactly: SUB-OK'. Then reply with what it returned.",
      { canUseTool: async (_n, input) => ({ behavior: "allow", updatedInput: input }) },
    );
    const sub = r.messages.filter((m) => m.parent_tool_use_id);
    const systems = r.messages.filter((m) => m.type === "system").map((m) => m.subtype);
    const toolUses = r.messages.flatMap((m) => (m.type === "assistant" ? m.message.content.filter((c) => c.type === "tool_use").map((c) => ({ id: c.id, name: c.name })) : []));
    record("subagent", {
      ...brief(r),
      toolUses,
      subMessages: sub.length,
      subParents: [...new Set(sub.map((m) => m.parent_tool_use_id))],
      subSessionIds: [...new Set(sub.map((m) => m.session_id))],
      systemSubtypes: systems,
    });
  }

  if (want.has("interrupt")) {
    countTurn("S4-00 interrupt", "glm");
    let interruptedAt = null;
    const r = await run("Count from 1 to 300, one number per line, nothing else.", {}, async (m, q) => {
      if (!interruptedAt && m.type === "stream_event" && m.event?.type === "content_block_delta") {
        interruptedAt = Date.now();
        await q.interrupt();
      }
    });
    record("interrupt", { ...brief(r), interrupted: !!interruptedAt, textLength: r.text.length });
  }

  if (want.has("steer")) {
    countTurn("S4-00 steer", "glm");
    // Streaming input: the second message is pushed while the first turn is still generating.
    let push;
    const queue = [];
    let done = false;
    async function* input() {
      yield { type: "user", message: { role: "user", content: "Count slowly from 1 to 40, one number per line." }, parent_tool_use_id: null, session_id: "" };
      while (!done) {
        if (queue.length) yield queue.shift();
        else await new Promise((r) => (push = r));
      }
    }
    let sent = false;
    let results = 0;
    const r = await run(input(), {}, async (m, q) => {
      if (!sent && m.type === "stream_event" && m.event?.type === "content_block_delta") {
        sent = true;
        queue.push({ type: "user", message: { role: "user", content: "Stop counting and reply with exactly: STEERED" }, parent_tool_use_id: null, session_id: "" });
        push?.();
      }
      if (m.type === "result" && ++results >= 2) {
        done = true;
        push?.();
        q.close?.();
      }
      if (m.type === "result" && results === 1) setTimeout(() => { if (results < 2) { done = true; push?.(); q.close?.(); } }, 60000);
    });
    record("steer", { ...brief(r), results, steeredInText: r.text.includes("STEERED") });
  }

  if (want.has("cli")) {
    // Can the real CLI, with the same CLAUDE_CONFIG_DIR, pick up the SDK's session? (print mode, no window)
    countTurn("S4-00 cli resume", "glm");
    const exe = execFileSync("where", ["claude"], { encoding: "utf8" }).split(/\r?\n/)[0];
    let out;
    try {
      out = execFileSync(exe, ["-p", "--resume", state.basic, "--output-format", "json", "What exact text did you reply with in your first answer?"], {
        cwd, env, encoding: "utf8", windowsHide: true, timeout: 300000,
      });
      const j = JSON.parse(out);
      out = { session_id: j.session_id, sameSession: j.session_id === state.basic, result: String(j.result).slice(0, 300), is_error: j.is_error };
    } catch (e) {
      out = { error: String(e?.message ?? e).slice(0, 500) };
    }
    record("cli", { exe, ...out });
  }

  if (want.has("flags")) {
    // No model call: which sharing options does the CLI offer?
    const exe = execFileSync("where", ["claude"], { encoding: "utf8" }).split(/\r?\n/)[0];
    const help = execFileSync(exe, ["--help"], { cwd, env, encoding: "utf8", windowsHide: true });
    const lines = help.split(/\r?\n/).filter((l) => /--bg|background|attach|--resume|--fork|remote|teleport|session-id/i.test(l)).map((l) => l.trim());
    record("flags", { lines });
  }
} finally {
  const after = mtimes();
  record("redline", { userClaudeFilesUnchanged: JSON.stringify(before) === JSON.stringify(after), checked: userFiles.map((f) => path.basename(f)) });
}
