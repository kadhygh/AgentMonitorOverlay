// A scripted ACP agent standing in for `dsh --profile acp` (stage 17): the same protocol subset DSH speaks
// (spikes/RESULTS.md s17-00), driven by markers in the prompt text. Run as a process: `node fake-acp-agent.js`.
//   (plain text)             thought "想一想", then the reply "MOCK-DSH: <text>"
//   [[ask: CMD]]             a pwsh call that needs permission: allowed → it runs, rejected → it fails
//   [[run: CMD]]             a pwsh call that just runs
//   [[slow]]                 a long pwsh call that ends only when cancelled
//   [[context: N]]           the usage update says N tokens in use
//   [[env]]                  the reply tells the permission mode and whether a key and a home were given
//   [[endpoint]]             the reply tells the DeepSeek address, key and model it was given (third-party channels)
//   [[auth]]                 the reply tells whether a key was given, the credentials file of the account patch and the model
//   [[mcp: TOOL {ARGS}]]     connects to the session's first MCP server, calls TOOL (optional JSON args), replies its instructions and result
//   [[mcp-list]]             the reply names the MCP servers the session was given (session/new or resume)
//   [[fail]]                 the prompt fails
//   [[fail-after: MS]]       a pwsh call, then the prompt fails MS later (a turn that errors while messages wait)
//   [[stuck]]                a pwsh call that never ends, session/cancel or not (停止's fallback)
//   [[nosandbox]]            a pwsh call that fails as DSH's does when it cannot set its sandbox up on the session's folder
//   [[subagent: MS]]         DSH's `subagent` tool: the call returns the agent's id at once; the agent's own log is
//                            written frame by frame over MS (a command, its reply sent back with send_message), and
//                            the prompt waits for it, as DSH's does (2026-11-06). ACP says nothing of the agent.
//                            `[[subagent: MS fail]]`: its turn ends with the error of a stream cut off (2026-11-07)
//   [[goal: N]]              after the prompt has ended, N rounds by itself as a DSH goal does (no prompt, no turn
//                            signal): thought, a pwsh call, a reply each; `[[goal: N slow]]`: the last round's call
//                            runs until session/cancel
// `--patch FILE` (a DSH channel's catalog, 2026-10-19): the models it lists replace the built-in ones, its `acp` model
// is the default; as in DSH, a model that is not offered cannot be picked. Images (2026-10-26): as DSH does, initialize
// offers them only when the agent's default model takes them (deepseek-flash here); a prompt's images are counted in
// the reply, and a prompt with images is refused when they were not offered.
// Sessions are kept in $DSH_HOME/fake-sessions.json, so another process can resume them.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

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
  { value: '["deepseek-official","deepseek-flash"]', name: "DeepSeek-V4.1-Flash" },
  { value: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro", description: "Stronger agentic coding" },
];
/** The models that take images, as DSH's catalog declares them. */
const IMAGE_MODELS = new Set(["deepseek-flash"]);
/** The `acp` model a `--patch` file names: the agent's default. */
function patchedDefault(): string | null {
  const at = process.argv.indexOf("--patch");
  const path = at >= 0 ? process.argv[at + 1] : undefined;
  if (!path || !existsSync(path)) return null;
  const def = /^\s*model: (".*")\s*$/m.exec(readFileSync(path, "utf8"));
  return def ? (JSON.parse(def[1]!) as string) : null;
}
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
/**
 * Studio's account patch (2026-11-03): the credentials file it points the store at, and the `acp` provider. Like DSH,
 * the account's route offers its models when that file holds the desktop app's sign-in (the key's route stays).
 */
function patchText(): string {
  const at = process.argv.indexOf("--patch");
  const path = at >= 0 ? process.argv[at + 1] : undefined;
  return path && existsSync(path) ? readFileSync(path, "utf8") : "";
}
const CREDENTIALS_FILE = /^- id: credentials\s+config:\s+path: (".*")\s*$/m.exec(patchText())?.[1];
const CREDENTIALS = CREDENTIALS_FILE ? (JSON.parse(CREDENTIALS_FILE) as string) : null;
const PROVIDER = /^\s*provider: "?([\w-]+)"?\s*$/m.exec(patchText())?.[1] ?? "deepseek-official";
const SIGNED_IN = !!CREDENTIALS && existsSync(CREDENTIALS) && readFileSync(CREDENTIALS, "utf8").includes("deepseek-account-platform/default:");
const ACCOUNT_MODELS = SIGNED_IN
  ? [
      { value: '["deepseek-account","deepseek-flash"]', name: "账号 Flash" },
      { value: '["deepseek-account","deepseek-v4-pro"]', name: "账号 Pro" },
    ]
  : [];
const MODELS = patchedModels() ?? [...BUILTIN_MODELS, ...ACCOUNT_MODELS];
const DEFAULT_NAME = patchedDefault();
const DEFAULT_MODEL = MODELS.find((m) => JSON.stringify([PROVIDER, DEFAULT_NAME]) === m.value) ?? MODELS[0]!;
const TAKES_IMAGES = IMAGE_MODELS.has((JSON.parse(DEFAULT_MODEL.value) as string[])[1]!);
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

async function mcpCall(server: McpServer, tool: string, args: Record<string, unknown> = {}): Promise<{ instructions: string; result: string }> {
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
  const called = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool, arguments: args } });
  const content = (called.result?.content as Array<{ text?: string }>) ?? [];
  return { instructions, result: content.map((c) => c.text ?? "").join("\n") || (called.error?.message ?? "") };
}

/**
 * DSH's own session log, as DSH 0.2 keeps it ($DSH_HOME/sessions/<cwd>/<id>/session.v4.jsonl.zstd): each turn one
 * model call of 400 output tokens generated over 2 s (200 tok/s), for Studio's speed reading (2026-10-22).
 */
function writeLog(id: string, turn: number, startedAt: number): void {
  const dir = join(home, "sessions", "--fake-cwd--", id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.v4.jsonl.zstd");
  const before = existsSync(file) ? zstdDecompressSync(readFileSync(file)).toString("utf8") : "";
  const line = (type: string, time: number, data: Record<string, unknown>) => JSON.stringify({ type, seq: 0, time, data });
  const lines = [
    line("turn/start", startedAt, { turn }),
    line("step/start", startedAt, { turn, step: 0 }),
    line("assistant/message", startedAt + 2100, { turn, step: 0, usage: { inputTokens: 300, outputTokens: 400, cacheReadTokens: 1000, cacheWriteTokens: 0 }, stream: [{ type: "reasoning-chunks", time0: startedAt + 100, index: 0, dt: [], texts: ["想"] }] }),
    line("turn/end", startedAt + 2100, { turn }),
  ];
  writeFileSync(file, zstdCompressSync(Buffer.from(`${before}${lines.join("\n")}\n`)));
}

async function prompt(params: { sessionId: string; prompt: Array<{ type: string; text?: string; mimeType?: string }> }): Promise<unknown> {
  const a = active.get(params.sessionId);
  if (!a) throw new RpcError(-32602, `Invalid params: unknown session ${params.sessionId}`);
  if (a.prompting) throw new RpcError(-32602, "Invalid params: a prompt is already in flight for this session");
  const all = load();
  const s = all[a.id]!;
  const text = params.prompt.map((b) => b.text ?? "").join("");
  const images = params.prompt.filter((b) => b.type === "image");
  if (images.length && !TAKES_IMAGES) throw new RpcError(-32602, "Invalid params: inline image prompts were not advertised by this connection");
  a.prompting = true;
  let cancelled = false;
  const startedAt = Date.now();
  try {
    s.turns++;
    save(all);
    const messageId = randomUUID();
    if (/\[\[fail\]\]/.test(text)) throw new RpcError(-32603, "model request failed: fake failure");
    const failAfter = /\[\[fail-after: (\d+)\]\]/.exec(text);
    const stuck = /\[\[stuck\]\]/.test(text);
    if (failAfter || stuck) {
      update(a.id, { sessionUpdate: "tool_call", toolCallId: `call-${randomUUID()}`, title: "pwsh", kind: "other", status: "in_progress", rawInput: { command: "ping -n 600 127.0.0.1" } });
      await new Promise((resolve) => (failAfter ? setTimeout(resolve, Number(failAfter[1])) : undefined));
      throw new RpcError(-32603, "model request failed: fake failure");
    }
    update(a.id, { sessionUpdate: "agent_thought_chunk", messageId, content: { type: "text", text: "想一想" } });
    const context = /\[\[context: (\d+)\]\]/.exec(text);
    update(a.id, { sessionUpdate: "usage_update", used: context ? Number(context[1]) : 1000 * s.turns, size: 1_000_000 });
    let reply = `MOCK-DSH: ${text}${images.length ? ` [${images.length} 张图 ${images.map((i) => i.mimeType).join(",")}]` : ""}`;
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
    if (/\[\[nosandbox\]\]/.test(text)) {
      const callId = `call-${randomUUID()}`;
      update(a.id, { sessionUpdate: "tool_call", toolCallId: callId, title: "pwsh", kind: "other", status: "in_progress", rawInput: { command: "git status" } });
      update(a.id, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "failed", content: [{ type: "content", content: { type: "text", text: `Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(${s.cwd})` } }] });
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
    const sub = /\[\[subagent: (\d+)( fail)?\]\]/.exec(text);
    if (sub) {
      const callId = `call-${randomUUID()}`;
      const childId = randomUUID();
      update(a.id, { sessionUpdate: "tool_call", toolCallId: callId, title: "subagent", kind: "other", status: "in_progress", rawInput: { description: "数文件", prompt: "数一数 src 下的文件" } });
      update(a.id, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed", content: [{ type: "content", content: { type: "text", text: `started subagent ${childId}` } }] });
      await subagentRun(a.id, childId, Number(sub[1]), !!sub[2]);
      reply = `SUB DONE ${childId}`;
    }
    if (/\[\[endpoint\]\]/.test(text)) reply = `ENDPOINT base=${process.env.DEEPSEEK_BASE_URL ?? ""} key=${process.env.DEEPSEEK_API_KEY ?? ""} model=${s.model}`;
    if (/\[\[auth\]\]/.test(text)) reply = `AUTH key=${process.env.DEEPSEEK_API_KEY ? "yes" : "no"} credentials=${CREDENTIALS ?? ""} model=${s.model}`;
    if (/\[\[mcp-list\]\]/.test(text)) reply = `MCP-LIST ${a.mcp.map((m) => `${m.name}:${m.url ? "http" : "stdio"}`).join(",")}`;
    if (/\[\[env\]\]/.test(text)) reply = `ENV permission=${process.env.DSH_PERMISSION_MODE ?? ""} key=${process.env.DEEPSEEK_API_KEY ? "yes" : "no"} home=${process.env.DSH_HOME ? "yes" : "no"} model=${s.model} effort=${s.effort}`;
    const mcp = /\[\[mcp: ([a-z_]+)(?: (.*?))?\]\]/s.exec(text);
    if (mcp) {
      const args = mcp[2] ? JSON.parse(mcp[2]) as Record<string, unknown> : {};
      const server = a.mcp.find((m) => m.url);
      const out = server ? await mcpCall(server, mcp[1]!, args) : { instructions: "", result: "NO MCP" };
      update(a.id, { sessionUpdate: "tool_call", toolCallId: "mcp-1", title: `mcp__amo__${mcp[1]}`, kind: "other", status: "in_progress", rawInput: args });
      update(a.id, { sessionUpdate: "tool_call_update", toolCallId: "mcp-1", status: "completed", content: [{ type: "content", content: { type: "text", text: out.result } }] });
      reply = `MCP RESULT ${out.result}\nINSTRUCTIONS ${out.instructions}`;
    }
    update(a.id, { sessionUpdate: "agent_message_chunk", messageId: randomUUID(), content: { type: "text", text: reply } });
    writeLog(a.id, s.turns, startedAt);
    const goal = /\[\[goal: (\d+)( slow)?\]\]/.exec(text);
    if (goal) setTimeout(() => void goalRounds(a, Number(goal[1]), !!goal[2]), 50);
    return { stopReason: "end_turn" };
  } finally {
    if (!cancelled) a.cancel = null;
    a.prompting = false;
  }
}

/** A DSH subagent's run as its log shows it: one zstd frame per event, appended as DSH does, over `ms`. */
async function subagentRun(parentId: string, childId: string, ms: number, fail = false): Promise<void> {
  const dir = join(home, "sessions", "--fake-cwd--", childId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.v4.jsonl.zstd");
  const put = (type: string, data: Record<string, unknown>) => appendFileSync(file, zstdCompressSync(Buffer.from(`${JSON.stringify({ type, seq: 0, time: Date.now(), data })}\n`)));
  const wait = (f: number) => new Promise((r) => setTimeout(r, ms * f));
  appendFileSync(file, zstdCompressSync(Buffer.from(`${JSON.stringify({ type: "session", version: 4, id: childId, parentSession: parentId, origin: "subagent" })}\n`)));
  put("agent/inbox/spliced", { target: "next-turn", start: 0, inserted: [{ content: [{ type: "text", text: "数一数 src 下的文件" }, { type: "text", text: `Your parent agent id is "${parentId}". Before you finish, send your result with send_message.` }], source: { kind: "user" }, role: "user" }] });
  put("turn/start", { turn: 1 });
  put("assistant/message", { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "reasoning", text: "先列文件" }] }, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  put("tool/call", { turn: 1, step: 1, callId: "c-1", name: "pwsh", arguments: JSON.stringify({ command: "Get-ChildItem src" }) });
  await wait(0.5);
  put("tool/result", { turn: 1, step: 1, message: { role: "tool", toolCallId: "c-1", content: [{ type: "text", text: "a.ts\nb.ts" }], isError: false } });
  put("tool/call", { turn: 1, step: 2, callId: "c-2", name: "send_message", arguments: JSON.stringify({ agent_id: parentId, message: "共 2 个文件" }) });
  put("tool/result", { turn: 1, step: 2, message: { role: "tool", toolCallId: "c-2", content: [{ type: "text", text: "sent" }], isError: false } });
  await wait(0.5);
  put("turn/end", { turn: 1, reason: fail ? { kind: "error", error: { message: "DeepSeek Messages stream ended before message_stop", code: "STREAM_CLOSED" } } : { kind: "completed" } });
}

/** A goal's rounds after the prompt (DSH's goal-round-driver): ACP updates only, outside any prompt. */
async function goalRounds(a: Active, n: number, slow: boolean): Promise<void> {
  for (let round = 1; round <= n; round++) {
    await new Promise((r) => setTimeout(r, 80));
    const messageId = randomUUID();
    update(a.id, { sessionUpdate: "agent_thought_chunk", messageId, content: { type: "text", text: `Round ${round}` } });
    const callId = `call-${randomUUID()}`;
    update(a.id, { sessionUpdate: "tool_call", toolCallId: callId, title: "pwsh", kind: "other", status: "in_progress", rawInput: { command: `echo round ${round}` } });
    if (slow && round === n) {
      await new Promise<void>((resolve) => (a.cancel = resolve));
      a.cancel = null;
      update(a.id, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "failed", content: [{ type: "content", content: { type: "text", text: "Error: tool call aborted" } }] });
      return;
    }
    update(a.id, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed", content: [{ type: "content", content: { type: "text", text: `round ${round}` } }] });
    update(a.id, { sessionUpdate: "agent_message_chunk", messageId: randomUUID(), content: { type: "text", text: `ROUND ${round} DONE` } });
  }
}

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "initialize":
      return { protocolVersion: 1, agentInfo: { name: "fake-dsh-acp", version: "0.0.1" }, agentCapabilities: { mcpCapabilities: { http: true }, promptCapabilities: { image: TAKES_IMAGES }, sessionCapabilities: { close: {}, list: {}, resume: {} } }, authMethods: [] };
    case "session/new": {
      const id = randomUUID();
      const all = load();
      all[id] = { cwd: String(params.cwd), model: DEFAULT_MODEL.value, effort: "high", turns: 0 };
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
