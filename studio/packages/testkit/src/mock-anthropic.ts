import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { listenInStudioRange } from "./ports.js";
import { MOCK_ASK_QUESTIONS, MOCK_MARKDOWN, MOCK_PLAN } from "./mock-model.js";

// Local stand-in for the Anthropic Messages API, used as ANTHROPIC_BASE_URL so the Claude Agent SDK (and the Claude
// Code CLI it runs) can be exercised end to end without spending model budget. Same directives as the Responses mock.

/** Model name to use against the mock (any name is accepted when ANTHROPIC_BASE_URL points here). */
export const MOCK_CLAUDE_MODEL = "mock-claude";

/** Environment that routes a Claude Code process to a running mock. */
export function mockClaudeEnv(baseUrl: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: "mock",
    ANTHROPIC_MODEL: MOCK_CLAUDE_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: MOCK_CLAUDE_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: MOCK_CLAUDE_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: MOCK_CLAUDE_MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: MOCK_CLAUDE_MODEL,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

export type ClaudeMockReply = (
  | { kind: "text"; text: string; chunks?: number; delayMs?: number }
  | { kind: "tool_use"; name: string; input: Record<string, unknown> }
) & { thinking?: string };

export interface ClaudeMockRequest {
  /** Text the person typed in the last user message (context blocks such as <system-reminder> are skipped). */
  lastUserText: string;
  /** Image blocks in that message. */
  images: number;
  /** Name and result text of the most recent tool call, once its result is in. */
  lastTool: { name: string; result: string } | null;
  /** True when the last user message carries a tool result, i.e. the CLI is continuing after a tool ran. */
  afterToolOutput: boolean;
  /** Set when this is a subagent's request: the name given in `[[spawn: name: …]]`. */
  subagent: string | null;
  /** Names of the tools offered. Side requests (titles, summaries) offer none. */
  tools: string[];
  stream: boolean;
  body: Record<string, unknown>;
}

export type ClaudeMockScript = (req: ClaudeMockRequest) => ClaudeMockReply;

/**
 * Default script:
 * - `[[shell: <command>]]` → one Bash tool call, then `MOCK-DONE`
 * - `[[spawn: name: message]]` → one Agent tool call run in the foreground; the subagent replies `MOCK-SUB: name`, the
 *   parent then `MOCK-DONE`
 * - `[[spawn-bg: name: message]]` → the same in the background: the CLI returns at once, and when the subagent ends it
 *   notifies the parent, which runs another turn (a second `result` in the same query)
 * - `[[spawn-mode-<mode>: name: message]]` → a foreground subagent that asks for that permission `mode`
 *   (e.g. `spawn-mode-bypassPermissions`, `spawn-mode-auto`): the Host must not let it skip the person
 * A subagent's message may itself carry `[[shell: …]]`: the subagent then runs that command before replying.
 * - `[[slow]]` → many small chunks with a delay (interrupt/queue tests)
 * - `[[markdown]]` → the same sample as the Responses mock
 * - `[[mcp: <tool> {json args}]]` → calls the AMO MCP tool `mcp__amo__<tool>`, then replies `MOCK-MCP: <start of its result>`
 * - `[[ask]]` → calls AskUserQuestion with MOCK_ASK_QUESTIONS, then replies `MOCK-ANSWERED: <the tool result>`
 * - `[[plan]]` (in plan mode) → writes MOCK_PLAN to the plan file the CLI names, calls ExitPlanMode, then replies
 *   `MOCK-PLAN: <the tool result>`
 * - anything else → `MOCK: <user text>`, plus ` [images: N]` when the message carried images
 * Tool calls are only made when the request offers that tool, so side requests always get text.
 */
export const defaultClaudeScript: ClaudeMockScript = (req) => {
  const shell = /\[\[shell:\s*([^\]]+)\]\]/.exec(req.lastUserText);
  if (req.subagent) {
    if (shell && !req.afterToolOutput && req.tools.includes("Bash")) return { kind: "tool_use", name: "Bash", input: { command: shell[1]!.trim(), description: "mock command" } };
    return { kind: "text", text: `MOCK-SUB: ${req.subagent}` };
  }
  if (req.afterToolOutput && req.lastTool?.name.startsWith("mcp__")) return { kind: "text", text: `MOCK-MCP: ${req.lastTool.result.slice(0, 200)}` };
  if (req.afterToolOutput && req.lastTool?.name === "AskUserQuestion") return { kind: "text", text: `MOCK-ANSWERED: ${req.lastTool.result}` };
  if (req.afterToolOutput && req.lastTool?.name === "Write" && req.lastUserText.includes("[[plan]]")) return { kind: "tool_use", name: "ExitPlanMode", input: {} };
  if (req.afterToolOutput && req.lastTool?.name === "ExitPlanMode") return { kind: "text", text: `MOCK-PLAN: ${req.lastTool.result.slice(0, 400)}` };
  if (req.afterToolOutput) return { kind: "text", text: "MOCK-DONE" };
  const mcp = /\[\[mcp:\s*([a-z_]+)\s*(\{.*?\})?\s*\]\]/.exec(req.lastUserText);
  if (mcp && req.tools.includes(`mcp__amo__${mcp[1]}`)) return { kind: "tool_use", name: `mcp__amo__${mcp[1]}`, input: mcp[2] ? (JSON.parse(mcp[2]) as Record<string, unknown>) : {} };
  // Spawn is checked before shell: the message may contain a nested [[shell: …]] for the subagent, so it runs up to the last "]]".
  const spawn = /\[\[spawn(-bg|-mode-[A-Za-z]+)?:\s*([a-z0-9_-]+)\s*:\s*(.+)\]\]\s*$/.exec(req.lastUserText);
  if (spawn) {
    const tool = req.tools.includes("Agent") ? "Agent" : req.tools.includes("Task") ? "Task" : null;
    if (tool) {
      return {
        kind: "tool_use",
        name: tool,
        input: {
          description: spawn[2]!,
          prompt: `[[subagent: ${spawn[2]!}]] ${spawn[3]!.trim()}`,
          subagent_type: "general-purpose",
          run_in_background: spawn[1] === "-bg",
          ...(spawn[1]?.startsWith("-mode-") ? { mode: spawn[1].slice("-mode-".length) } : {}),
        },
      };
    }
  }
  if (req.lastUserText.includes("[[ask]]") && req.tools.length > 0) return { kind: "tool_use", name: "AskUserQuestion", input: { questions: MOCK_ASK_QUESTIONS } };
  if (req.lastUserText.includes("[[plan]]") && req.tools.length > 0) {
    // The CLI reads the plan from its plan file (it hands ExitPlanMode's input the file's text).
    const file = planFile(req.body);
    return file ? { kind: "tool_use", name: "Write", input: { file_path: file, content: MOCK_PLAN } } : { kind: "tool_use", name: "ExitPlanMode", input: {} };
  }
  if (shell && req.tools.includes("Bash")) return { kind: "tool_use", name: "Bash", input: { command: shell[1]!.trim(), description: "mock command" } };
  if (req.lastUserText.includes("[[markdown]]")) return { kind: "text", text: MOCK_MARKDOWN };
  if (req.lastUserText.includes("[[think]]")) return { kind: "text", text: `MOCK: ${req.lastUserText}`, thinking: "先想一想用户要什么。\n这是一条测试消息，照原样回复即可。" };
  if (req.lastUserText.includes("[[slow]]")) return { kind: "text", text: "slow ".repeat(40).trim(), chunks: 40, delayMs: 150 };
  return { kind: "text", text: `MOCK: ${req.lastUserText}${req.images ? ` [images: ${req.images}]` : ""}` };
};

/** The plan file Claude Code names in plan mode ("create your plan at …\\plans\\x.md" / "already exists at …"). */
function planFile(body: unknown): string | null {
  const texts: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") texts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(body);
  for (const t of texts) {
    const m = /([A-Za-z]:\\[^\s"]*?\\plans\\[^\s"\\]+\.md|\/[^\s"]*?\/plans\/[^\s"/]+\.md)/.exec(t);
    if (m) return m[1]!;
  }
  return null;
}

type Block = { type?: string; text?: string };
type Message = { role?: string; content?: string | Block[] };

const blocksOf = (m: Message | undefined): Block[] => (typeof m?.content === "string" ? [{ type: "text", text: m.content }] : (m?.content ?? []));
/**
 * The person's text: text blocks that are not injected context (<system-reminder>…, "[Request interrupted by user]",
 * the "[Image: source: …]" note the CLI adds beside an image).
 */
const personText = (m: Message | undefined) =>
  blocksOf(m)
    .filter((b) => b.type === "text" && typeof b.text === "string" && !/^\s*<[a-z-]+>/.test(b.text) && !/^\s*\[(Request interrupted|Image: source:)/.test(b.text))
    .map((b) => b.text!.trim())
    .join("\n")
    .trim();

function lastToolCall(messages: Message[]): { name: string; result: string } | null {
  const calls = messages.flatMap((m) => (m.role === "assistant" ? blocksOf(m) : [])).filter((b) => b.type === "tool_use") as Array<Block & { id?: string; name?: string }>;
  const call = calls.at(-1);
  if (!call) return null;
  const result = messages
    .flatMap((m) => (m.role === "user" ? blocksOf(m) : []))
    .find((b) => b.type === "tool_result" && (b as { tool_use_id?: string }).tool_use_id === call.id) as { content?: unknown } | undefined;
  if (!result) return null;
  const text = typeof result.content === "string" ? result.content : Array.isArray(result.content) ? result.content.map((c: { text?: string }) => c.text ?? "").join("") : "";
  return { name: String(call.name), result: text };
}

export function parseClaudeRequest(body: Record<string, unknown>): ClaudeMockRequest {
  const messages = (Array.isArray(body.messages) ? body.messages : []) as Message[];
  const users = messages.filter((m) => m.role === "user");
  const hasToolResult = (m: Message) => m.role === "user" && blocksOf(m).some((b) => b.type === "tool_result");
  // A message sent while a turn runs is folded in after the next tool call: it shares the user message with the tool
  // result, and is then what the person last said (so it wins over "continuing after a tool").
  const images = (m: Message | undefined) => blocksOf(m).filter((b) => b.type === "image").length;
  const isPerson = (m: Message) => m.role === "user" && (!!personText(m) || images(m) > 0);
  // The CLI may append context messages after a tool result, so "continuing after a tool" means: a tool result came
  // after the last thing the person said, not that the very last message is one.
  const lastPersonIndex = messages.findLastIndex(isPerson);
  const lastToolIndex = messages.findLastIndex(hasToolResult);
  const lastPerson = lastPersonIndex >= 0 ? personText(messages[lastPersonIndex]) : "";
  // A subagent's conversation starts with the prompt the parent gave it.
  const first = personText(users[0]);
  return {
    lastUserText: lastPerson,
    images: lastPersonIndex >= 0 ? images(messages[lastPersonIndex]) : 0,
    afterToolOutput: lastToolIndex > lastPersonIndex,
    lastTool: lastToolCall(messages),
    subagent: /^\[\[subagent:\s*([a-z0-9_-]+)\]\]/.exec(first)?.[1] ?? null,
    tools: Array.isArray(body.tools) ? (body.tools as Array<{ name?: string }>).map((t) => String(t.name)) : [],
    stream: body.stream === true,
    body,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function messageOf(reply: ClaudeMockReply, seq: number, model: string) {
  const content = [
    ...(reply.thinking ? [{ type: "thinking", thinking: reply.thinking, signature: "mock" }] : []),
    reply.kind === "text" ? { type: "text", text: reply.text } : { type: "tool_use", id: `toolu_mock_${seq}`, name: reply.name, input: reply.input },
  ];
  return {
    id: `msg_mock_${seq}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: reply.kind === "text" ? "end_turn" : "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

async function streamReply(res: ServerResponse, reply: ClaudeMockReply, seq: number, model: string): Promise<void> {
  const send = (data: Record<string, unknown>) => res.write(`event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`);
  const full = messageOf(reply, seq, model);
  send({ type: "message_start", message: { ...full, content: [], stop_reason: null, usage: { ...full.usage, output_tokens: 1 } } });
  let index = 0;
  if (reply.thinking) {
    send({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
    for (const part of reply.thinking.match(/[\s\S]{1,12}/g) ?? []) {
      if (res.destroyed) return;
      send({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: part } });
      await sleep(15);
    }
    send({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "mock" } });
    send({ type: "content_block_stop", index });
    index++;
  }
  if (reply.kind === "text") {
    send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    const chunks = Math.max(1, reply.chunks ?? 3);
    const size = Math.ceil(reply.text.length / chunks) || 1;
    for (let i = 0; i < reply.text.length; i += size) {
      if (res.destroyed) return;
      send({ type: "content_block_delta", index, delta: { type: "text_delta", text: reply.text.slice(i, i + size) } });
      if (reply.delayMs) await sleep(reply.delayMs);
    }
  } else {
    send({ type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_mock_${seq}`, name: reply.name, input: {} } });
    send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.input) } });
  }
  send({ type: "content_block_stop", index });
  send({ type: "message_delta", delta: { stop_reason: full.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } });
  send({ type: "message_stop" });
  res.end();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export interface ClaudeMockServer {
  /** Value for ANTHROPIC_BASE_URL. */
  baseUrl: string;
  port: number;
  requests: ClaudeMockRequest[];
  close(): Promise<void>;
}

/** Starts the mock on 127.0.0.1 (port 0 picks a free one). */
export async function startMockAnthropic(options: { port?: number; script?: ClaudeMockScript } = {}): Promise<ClaudeMockServer> {
  const script = options.script ?? defaultClaudeScript;
  const requests: ClaudeMockRequest[] = [];
  let seq = 0;
  const server: Server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? "").split("?")[0]!;
      if (req.method === "POST" && path === "/v1/messages/count_tokens") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      if (req.method !== "POST" || path !== "/v1/messages") {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: path } }));
        return;
      }
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const parsed = parseClaudeRequest(body);
      requests.push(parsed);
      const reply = script(parsed);
      const model = String(body.model ?? MOCK_CLAUDE_MODEL);
      if (!parsed.stream) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(messageOf(reply, ++seq, model)));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      await streamReply(res, reply, ++seq, model);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(err) } }));
    }
  });
  if (options.port) await new Promise<void>((resolve) => server.listen(options.port, "127.0.0.1", resolve));
  else await listenInStudioRange(server);
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
