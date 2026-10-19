// A scripted ACP agent standing in for `dsh --profile acp` (stage 17): the same protocol subset DSH speaks
// (spikes/RESULTS.md s17-00), driven by markers in the prompt text. Run as a process: `node fake-acp-agent.js`.
//   (plain text)             thought "想一想", then the reply "MOCK-DSH: <text>"
//   [[ask: CMD]]             a pwsh call that needs permission: allowed → it runs, rejected → it fails
//   [[run: CMD]]             a pwsh call that just runs
//   [[slow]]                 a long pwsh call that ends only when cancelled
//   [[context: N]]           the usage update says N tokens in use
//   [[env]]                  the reply tells the permission mode and whether a key and a home were given
//   [[endpoint]]             the reply tells the DeepSeek address, key and model it was given (third-party channels)
//   [[mcp: TOOL]]            connects to the session's first MCP server, calls TOOL, replies its instructions and result
//   [[fail]]                 the prompt fails
// `--patch FILE` (a DSH channel's catalog, 2026-10-19): the models it lists replace the built-in ones, its `acp` model
// is the default; as in DSH, a model that is not offered cannot be picked.
// Sessions are kept in $DSH_HOME/fake-sessions.json, so another process can resume them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

interface McpServer {
  type?: string;
  name: string;
  url?: string;
  headers?: Array<{ name: string; value: string }>;
}
interface Stored {
  cwd: string;
  model: string;
  effort: string;
  turns: number;
}
interface Active {
  id: string;
  mcp: McpServer[];
  prompting: boolean;
  cancel: (() => void) | null;
}

const home = process.env.DSH_HOME ?? process.cwd();
const file = join(home, "fake-sessions.json");
const BUILTIN_MODELS = [
  { value: '["deepseek-official","deepseek-v4-flash"]', name: "deepseek-v4-flash" },
  { value: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro", description: "Stronger agentic coding" },
];
/** The models a `--patch` file lists (`- id: "<name>"` under llm-deepseek), its `acp` default first. */
function patchedModels(): Array<{ value: string; name: string; description?: string }> | null {
  const at = process.argv.indexOf("--patch");
  const path = at >= 0 ? process.argv[at + 1] : undefined;
  if (!path || !existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const ids = [...text.matchAll(/^\s*- id: (".*")\s*$/gm)].map((m) => JSON.parse(m[1]!) as string);
  if (!ids.length) return null;
  const def = /^\s*model: (".*")\s*$/m.exec(text);
  const first = def ? (JSON.parse(def[1]!) as string) : ids[0]!;
  return [first, ...ids.filter((i) => i !== first)].map((id) => ({ value: JSON.stringify(["deepseek-official", id]), name: id }));
}
const MODELS = patchedModels() ?? BUILTIN_MODELS;
const EFFORTS = ["off", "low", "high", "max"];

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
function configOptions(s: Stored) {
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: [{ group: "deepseek-official", name: "DeepSeek", options: MODELS }] },
    { id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select", currentValue: s.effort, options: EFFORTS.map((v) => ({ value: v, name: v })) },
  ];
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

async function mcpCall(server: McpServer, tool: string): Promise<{ instructions: string; result: string }> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  for (const h of server.headers ?? []) headers[h.name] = h.value;
  const post = async (body: unknown) => {
    const r = await fetch(server.url!, { method: "POST", headers, body: JSON.stringify(body) });
    return (await r.json()) as { result?: Record<string, unknown>; error?: { message: string } };
  };
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-dsh", version: "0" } } });
  const instructions = String(init.result?.instructions ?? "");
  const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const names = ((listed.result?.tools as Array<{ name: string }>) ?? []).map((t) => t.name);
  if (!names.includes(tool)) return { instructions, result: `NO TOOL ${tool} (tools: ${names.join(",")})` };
  const called = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool, arguments: {} } });
  const content = (called.result?.content as Array<{ text?: string }>) ?? [];
  return { instructions, result: content.map((c) => c.text ?? "").join("\n") || (called.error?.message ?? "") };
}

async function prompt(params: { sessionId: string; prompt: Array<{ type: string; text?: string }> }): Promise<unknown> {
  const a = active.get(params.sessionId);
  if (!a) throw new RpcError(-32602, `Invalid params: unknown session ${params.sessionId}`);
  if (a.prompting) throw new RpcError(-32602, "Invalid params: a prompt is already in flight for this session");
  const all = load();
  const s = all[a.id]!;
  const text = params.prompt.map((b) => b.text ?? "").join("");
  a.prompting = true;
  let cancelled = false;
  try {
    s.turns++;
    save(all);
    const messageId = randomUUID();
    if (/\[\[fail\]\]/.test(text)) throw new RpcError(-32603, "model request failed: fake failure");
    update(a.id, { sessionUpdate: "agent_thought_chunk", messageId, content: { type: "text", text: "想一想" } });
    const context = /\[\[context: (\d+)\]\]/.exec(text);
    update(a.id, { sessionUpdate: "usage_update", used: context ? Number(context[1]) : 1000 * s.turns, size: 1_000_000 });
    let reply = `MOCK-DSH: ${text}`;
    const ran = /\[\[(ask|run): ([^\]]+)\]\]/.exec(text);
    if (ran) {
      const callId = `call-${randomUUID()}`;
      const command = ran[2]!;
      update(a.id, { sessionUpdate: "tool_call", toolCallId: callId, title: "pwsh", kind: "other", status: "in_progress", rawInput: { command, description: "fake" } });
      let allowed = true;
      if (ran[1] === "ask") {
        const callId2 = `call-${randomUUID()}`;
        update(a.id, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed", content: [{ type: "content", content: { type: "text", text: "Access denied [sandbox]" } }] });
        update(a.id, { sessionUpdate: "tool_call", toolCallId: callId2, title: "pwsh", kind: "other", status: "in_progress", rawInput: { command, sandbox_permissions: "workspace-write", justification: "the person asked for it" } });
        const r = (await ask("session/request_permission", {
          sessionId: a.id,
          toolCall: { toolCallId: callId2 },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        })) as { outcome: { outcome: string; optionId?: string } };
        allowed = r.outcome.outcome === "selected" && r.outcome.optionId === "allow-once";
        update(a.id, allowed
          ? { sessionUpdate: "tool_call_update", toolCallId: callId2, status: "completed", content: [{ type: "content", content: { type: "text", text: `ran ${command}` } }] }
          : { sessionUpdate: "tool_call_update", toolCallId: callId2, status: "failed", content: [{ type: "content", content: { type: "text", text: "Error: the user rejected escalating this command" } }] });
      } else {
        update(a.id, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed", content: [{ type: "content", content: { type: "text", text: `ran ${command}` } }] });
      }
      reply = allowed ? `DONE ${command}` : `REJECTED ${command}`;
    }
    if (/\[\[slow\]\]/.test(text)) {
      const callId = `call-${randomUUID()}`;
      update(a.id, { sessionUpdate: "tool_call", toolCallId: callId, title: "pwsh", kind: "other", status: "in_progress", rawInput: { command: "ping -n 600 127.0.0.1" } });
      await new Promise<void>((resolve) => (a.cancel = resolve));
      a.cancel = null;
      cancelled = true;
      update(a.id, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "failed", content: [{ type: "content", content: { type: "text", text: "Error: tool call aborted" } }] });
      return { stopReason: "cancelled" };
    }
    if (/\[\[endpoint\]\]/.test(text)) reply = `ENDPOINT base=${process.env.DEEPSEEK_BASE_URL ?? ""} key=${process.env.DEEPSEEK_API_KEY ?? ""} model=${s.model}`;
    if (/\[\[env\]\]/.test(text)) reply = `ENV permission=${process.env.DSH_PERMISSION_MODE ?? ""} key=${process.env.DEEPSEEK_API_KEY ? "yes" : "no"} home=${process.env.DSH_HOME ? "yes" : "no"} model=${s.model} effort=${s.effort}`;
    const mcp = /\[\[mcp: ([a-z_]+)\]\]/.exec(text);
    if (mcp) {
      const server = a.mcp.find((m) => m.url);
      const out = server ? await mcpCall(server, mcp[1]!) : { instructions: "", result: "NO MCP" };
      update(a.id, { sessionUpdate: "tool_call", toolCallId: "mcp-1", title: `mcp__amo__${mcp[1]}`, kind: "other", status: "in_progress", rawInput: {} });
      update(a.id, { sessionUpdate: "tool_call_update", toolCallId: "mcp-1", status: "completed", content: [{ type: "content", content: { type: "text", text: out.result } }] });
      reply = `MCP RESULT ${out.result}\nINSTRUCTIONS ${out.instructions}`;
    }
    update(a.id, { sessionUpdate: "agent_message_chunk", messageId: randomUUID(), content: { type: "text", text: reply } });
    return { stopReason: "end_turn" };
  } finally {
    if (!cancelled) a.cancel = null;
    a.prompting = false;
  }
}

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "initialize":
      return { protocolVersion: 1, agentInfo: { name: "fake-dsh-acp", version: "0.0.1" }, agentCapabilities: { mcpCapabilities: { http: true }, promptCapabilities: { image: false }, sessionCapabilities: { close: {}, list: {}, resume: {} } }, authMethods: [] };
    case "session/new": {
      const id = randomUUID();
      const all = load();
      all[id] = { cwd: String(params.cwd), model: MODELS[0]!.value, effort: "high", turns: 0 };
      save(all);
      active.set(id, { id, mcp: (params.mcpServers as McpServer[]) ?? [], prompting: false, cancel: null });
      return { sessionId: id, configOptions: configOptions(all[id]!) };
    }
    case "session/resume": {
      const id = String(params.sessionId);
      const all = load();
      if (!all[id]) throw new RpcError(-32602, `Invalid params: session is not resumable: ${id}`);
      if (active.has(id)) throw new RpcError(-32602, `Invalid params: session is already active: ${id}`);
      active.set(id, { id, mcp: (params.mcpServers as McpServer[]) ?? [], prompting: false, cancel: null });
      return { configOptions: configOptions(all[id]!) };
    }
    case "session/list":
      return { sessions: Object.entries(load()).map(([sessionId, s]) => ({ sessionId, cwd: s.cwd })) };
    case "session/close":
      active.delete(String(params.sessionId));
      return {};
    case "session/set_config_option": {
      const all = load();
      const s = all[String(params.sessionId)];
      if (!s) throw new RpcError(-32602, "Invalid params: unknown session");
      if (params.configId === "model") {
        if (!MODELS.some((m) => m.value === String(params.value))) throw new RpcError(-32602, `Invalid params: model ${String(params.value)} is not offered`);
        s.model = String(params.value);
      }
      else if (params.configId === "reasoning_effort") s.effort = String(params.value);
      else throw new RpcError(-32602, `Invalid params: unknown option ${String(params.configId)}`);
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
