// A scripted ACP agent standing in for `agy acp` (Antigravity CLI, 2026-11-24, plans/agy.md): the surface agy 1.5.16
// showed (spikes/gemini/a01.log) — auth methods, a model list whose ids carry the thinking level
// (`gemini-3.8-flash-high`), the options model / thought_level / mode, `--dangerously-skip-permissions` — driven by
// markers in the prompt text. Run as a process: `node fake-agy-agent.js acp [--dangerously-skip-permissions]`.
//   (plain text)        thought "想一想", then the reply "MOCK-AGY: <text>"
//   [[env]]             the reply tells the mode, whether permissions are skipped, the model, the thinking level, the
//                       updater switch and whether a GEMINI_/GOOGLE_ variable reached it
//   [[ask: CMD]]        a command that asks first (unless skipped): allowed → it runs, rejected → it fails
//   [[edit: PATH]]      an edit of PATH: asks in mode default, runs unasked in accept-edits or when skipped; refused in plan
//   [[slow]]            a long command that ends only when cancelled
//   [[mcp-list]]        the reply names the MCP servers the session was given (session/new or resume)
//   [[mcp: TOOL]]       asks to run AMO's TOOL as agy would (title "amo/TOOL"); the reply says whether it was allowed
//   [[context: N]]      the usage update says N tokens in use
//   [[fail]]            the prompt fails
// $FAKE_AGY_HOME (default the working folder) keeps the sessions (another process can resume them) and the sign-in;
// FAKE_AGY_NEEDS_LOGIN=1 makes session/new refuse ("Authentication required") until `authenticate` was called.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

interface McpServer {
  type?: string;
  name: string;
  url?: string;
}
interface Stored {
  cwd: string;
  model: string;
  thought: string;
  mode: string;
  turns: number;
}
interface Active {
  id: string;
  mcp: McpServer[];
  cancel: (() => void) | null;
}

const home = process.env.FAKE_AGY_HOME ?? process.cwd();
const file = join(home, "fake-agy-sessions.json");
const signedInFile = join(home, "fake-agy-signed-in");
const skip = process.argv.includes("--dangerously-skip-permissions");

const MODELS = [
  { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
];
const LEVELS = ["low", "medium", "high"];
const AVAILABLE = [
  ...LEVELS.map((l) => ({ modelId: `gemini-3.8-flash-${l}`, name: `Gemini 3.8 Flash (${l})` })),
  { modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
];
const MODES = [
  { value: "default", name: "Default" },
  { value: "accept-edits", name: "Accept edits" },
  { value: "plan", name: "Plan" },
];

function load(): Record<string, Stored> {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, Stored>) : {};
  } catch {
    return {};
  }
}
function save(all: Record<string, Stored>): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(file, JSON.stringify(all, null, 2));
}
function hasLevels(model: string): boolean {
  return model.startsWith("gemini");
}
function configOptions(s: Stored) {
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: MODELS },
    ...(hasLevels(s.model) ? [{ id: "thought_level", name: "Thinking Level", category: "thought_level", type: "select", currentValue: s.thought, options: LEVELS.map((v) => ({ value: v, name: v })) }] : []),
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: s.mode, options: MODES },
  ];
}
function setup(s: Stored) {
  return { configOptions: configOptions(s), models: { availableModels: AVAILABLE, currentModelId: hasLevels(s.model) ? `${s.model}-${s.thought}` : s.model } };
}

const active = new Map<string, Active>();
let nextId = 1;
const waiting = new Map<number, (result: unknown) => void>();

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
function update(sessionId: string, u: Record<string, unknown>): void {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
}
function ask(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const PERMISSION_OPTIONS = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

/** Asks Studio; true when it chose the allow option. */
async function permitted(sessionId: string, toolCall: Record<string, unknown>): Promise<boolean> {
  const r = (await ask("session/request_permission", { sessionId, toolCall, options: PERMISSION_OPTIONS })) as { outcome?: { outcome?: string; optionId?: string } };
  return r?.outcome?.outcome === "selected" && r.outcome.optionId === "allow";
}

async function prompt(params: { sessionId: string; prompt: Array<{ type: string; text?: string }> }): Promise<unknown> {
  const a = active.get(params.sessionId);
  if (!a) throw new RpcError(-32602, "Invalid params: unknown session");
  const all = load();
  const s = all[a.id]!;
  s.turns++;
  save(all);
  const text = params.prompt.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
  const reply = (t: string) => update(a.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
  const usage = (used: number) => update(a.id, { sessionUpdate: "usage_update", used, size: 1048576 });

  if (text.includes("[[fail]]")) throw new RpcError(-32603, "Internal error: fake agy failed");
  update(a.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想一想" } });

  if (text.includes("[[env]]")) {
    const leaked = Object.keys(process.env).filter((k) => /^(GEMINI_|GOOGLE_)/i.test(k));
    reply(`mode=${s.mode} skip=${skip} model=${s.model} thought=${s.thought} update=${process.env.AGY_CLI_DISABLE_AUTO_UPDATE ?? "-"} leaked=${leaked.join(",") || "none"}`);
  } else if (text.includes("[[mcp-list]]")) {
    reply(`mcp=${a.mcp.map((m) => `${m.name}:${m.type ?? "stdio"}`).join(",") || "none"}`);
  } else if (/\[\[ask: (.+?)\]\]/.test(text)) {
    const cmd = /\[\[ask: (.+?)\]\]/.exec(text)![1]!;
    const call = { toolCallId: randomUUID(), title: cmd, kind: "execute", status: "pending", rawInput: { command: cmd } };
    update(a.id, { sessionUpdate: "tool_call", ...call });
    const ok = skip || (await permitted(a.id, call));
    update(a.id, { sessionUpdate: "tool_call_update", toolCallId: call.toolCallId, status: ok ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: ok ? `ran ${cmd}` : "rejected" } }] });
    reply(ok ? `MOCK-AGY: ran ${cmd}` : "MOCK-AGY: not allowed");
  } else if (/\[\[edit: (.+?)\]\]/.test(text)) {
    const path = /\[\[edit: (.+?)\]\]/.exec(text)![1]!;
    if (s.mode === "plan") {
      reply("MOCK-AGY: plan mode, no edits");
    } else {
      const call = { toolCallId: randomUUID(), title: `Edit ${path}`, kind: "edit", status: "pending", content: [{ type: "diff", path, oldText: "a\n", newText: "b\n" }] };
      update(a.id, { sessionUpdate: "tool_call", ...call });
      const ok = skip || s.mode === "accept-edits" || (await permitted(a.id, call));
      update(a.id, { sessionUpdate: "tool_call_update", toolCallId: call.toolCallId, status: ok ? "completed" : "failed" });
      reply(ok ? `MOCK-AGY: edited ${path}` : "MOCK-AGY: edit rejected");
    }
  } else if (/\[\[mcp: (\w+)\]\]/.test(text)) {
    const tool = /\[\[mcp: (\w+)\]\]/.exec(text)![1]!;
    const call = { toolCallId: randomUUID(), title: `amo/${tool}`, kind: "other", status: "pending", rawInput: {} };
    update(a.id, { sessionUpdate: "tool_call", ...call });
    const ok = skip || (await permitted(a.id, call));
    update(a.id, { sessionUpdate: "tool_call_update", toolCallId: call.toolCallId, status: ok ? "completed" : "failed" });
    reply(`MOCK-AGY: ${tool} ${ok ? "allowed" : "rejected"}`);
  } else if (text.includes("[[slow]]")) {
    const call = { toolCallId: randomUUID(), title: "sleep", kind: "execute", status: "in_progress", rawInput: { command: "sleep 600" } };
    update(a.id, { sessionUpdate: "tool_call", ...call });
    await new Promise<void>((resolve) => {
      a.cancel = resolve;
    });
    a.cancel = null;
    update(a.id, { sessionUpdate: "tool_call_update", toolCallId: call.toolCallId, status: "failed" });
    return { stopReason: "cancelled" };
  } else {
    reply(`MOCK-AGY: ${text}`);
  }
  const ctx = /\[\[context: (\d+)\]\]/.exec(text);
  usage(ctx ? Number(ctx[1]) : 1000 * s.turns);
  return { stopReason: "end_turn" };
}

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true } },
        authMethods: [
          { id: "oauth-personal", name: "Sign in with Google" },
          { id: "gemini-api-key", name: "Gemini API Key" },
        ],
        agentInfo: { name: "fake-agy", version: "1.5.16" },
      };
    case "authenticate":
      mkdirSync(home, { recursive: true });
      writeFileSync(signedInFile, String(params.methodId ?? ""));
      return {};
    case "session/new": {
      if (process.env.FAKE_AGY_NEEDS_LOGIN === "1" && !existsSync(signedInFile)) throw new RpcError(-32000, "Authentication required");
      const id = randomUUID();
      const all = load();
      all[id] = { cwd: String(params.cwd), model: "gemini-3.8-flash", thought: "high", mode: "default", turns: 0 };
      save(all);
      active.set(id, { id, mcp: (params.mcpServers as McpServer[]) ?? [], cancel: null });
      return { sessionId: id, ...setup(all[id]!) };
    }
    case "session/resume": {
      const id = String(params.sessionId);
      const all = load();
      if (!all[id]) throw new RpcError(-32602, `Invalid params: session not found: ${id}`);
      active.set(id, { id, mcp: (params.mcpServers as McpServer[]) ?? [], cancel: null });
      return setup(all[id]!);
    }
    case "session/close":
      active.delete(String(params.sessionId));
      return {};
    case "session/set_config_option": {
      const all = load();
      const s = all[String(params.sessionId)];
      if (!s) throw new RpcError(-32602, "Invalid params: unknown session");
      const value = String(params.value);
      if (params.configId === "model") {
        if (!MODELS.some((m) => m.value === value)) throw new RpcError(-32602, `Invalid params: model ${value} is not offered`);
        s.model = value;
      } else if (params.configId === "thought_level") {
        if (!hasLevels(s.model) || !LEVELS.includes(value)) throw new RpcError(-32602, `Invalid params: thought_level ${value}`);
        s.thought = value;
      } else if (params.configId === "mode") {
        if (!MODES.some((m) => m.value === value)) throw new RpcError(-32602, `Invalid params: mode ${value}`);
        s.mode = value;
      } else throw new RpcError(-32602, `Invalid params: unknown option ${String(params.configId)}`);
      save(all);
      return { configOptions: configOptions(s) };
    }
    case "session/prompt":
      return prompt(params as never);
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
    if (msg.method === undefined && msg.id !== undefined) {
      waiting.get(msg.id)?.(msg.result);
      waiting.delete(msg.id);
    } else if (msg.method === "session/cancel") {
      active.get(String(msg.params?.sessionId))?.cancel?.();
    } else if (msg.method !== undefined && msg.id !== undefined) {
      const id = msg.id;
      handle(msg.method, msg.params ?? {}).then(
        (result) => send({ jsonrpc: "2.0", id, result }),
        (err: unknown) => send({ jsonrpc: "2.0", id, error: { code: err instanceof RpcError ? err.code : -32603, message: String((err as Error).message ?? err) } }),
      );
    }
  }
});
process.stdin.on("end", () => process.exit(0));
