import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Local stand-in for an OpenAI Responses-compatible model, used as a Codex `model_provider` so integration tests run
// the real `codex app-server` without spending any model budget.

/** Codex model catalog describing `mock-model` (src/ and dist/ sit at the same depth). */
export const MOCK_MODEL_CATALOG = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "mock-model.models.json").replaceAll("\\", "/");

/** Codex provider definition pointing at a running mock (shape matches the Host's CodexProviderDef). */
export function mockCodexProvider(baseUrl: string) {
  return { name: "Mock", baseUrl, wireApi: "responses" as const, envKey: "AMO_MOCK_API_KEY", catalog: MOCK_MODEL_CATALOG };
}

/** One model reply: plain text, or a tool call that Codex will execute (and may ask approval for). */
export type MockReply =
  | { kind: "text"; text: string; chunks?: number; delayMs?: number }
  | { kind: "function_call"; name: string; arguments: Record<string, unknown>; namespace?: string };

export interface MockModelRequest {
  /** Text of the last user message, if any. */
  lastUserText: string;
  /** True when the last input item is a tool result, i.e. Codex is continuing after running a tool. */
  afterToolOutput: boolean;
  /** Set when this request is a subagent's first turn: the task name from Codex's agent_message (payload is encrypted). */
  agentTask: string | null;
  /** Names of tools Codex offered. */
  tools: string[];
  body: Record<string, unknown>;
}

export type MockScript = (req: MockModelRequest) => MockReply;

/**
 * Default script. Directives in the user text let tests pick behaviour:
 * - `[[shell: <command>]]` → call the shell tool once, then reply `MOCK-DONE`
 * - `[[spawn: task_name: message]]` → call Codex's collaboration.spawn_agent once, then reply `MOCK-DONE`;
 *   the subagent itself replies `MOCK-SUB: /root/<task_name>`
 * - `[[slow]]` → stream the reply in many small chunks with a delay (for steer/interrupt tests)
 * - anything else → `MOCK: <user text>`
 */
export const defaultScript: MockScript = (req) => {
  if (req.afterToolOutput) return { kind: "text", text: "MOCK-DONE" };
  if (req.agentTask) return { kind: "text", text: `MOCK-SUB: ${req.agentTask}` };
  const shell = /\[\[shell:\s*([^\]]+)\]\]/.exec(req.lastUserText);
  if (shell) {
    // Codex 0.161 offers exec_command { cmd }; 0.144 offered shell_command { command }; older ones shell { command: [] }.
    const command = shell[1]!.trim();
    if (req.tools.includes("exec_command")) return { kind: "function_call", name: "exec_command", arguments: { cmd: command } };
    if (req.tools.includes("shell")) return { kind: "function_call", name: "shell", arguments: { command: ["cmd", "/c", command] } };
    return { kind: "function_call", name: "shell_command", arguments: { command } };
  }
  const spawn = /\[\[spawn:\s*([a-z0-9_]+)\s*:\s*([^\]]+)\]\]/.exec(req.lastUserText);
  if (spawn && req.tools.includes("collaboration.spawn_agent")) {
    return { kind: "function_call", name: "spawn_agent", namespace: "collaboration", arguments: { task_name: spawn[1]!, message: spawn[2]!.trim(), fork_turns: "none" } };
  }
  if (req.lastUserText.includes("[[slow]]")) return { kind: "text", text: "slow ".repeat(40).trim(), chunks: 40, delayMs: 150 };
  return { kind: "text", text: `MOCK: ${req.lastUserText}` };
};

export interface MockModelServer {
  /** Base URL to put in `model_providers.<id>.base_url`. */
  baseUrl: string;
  port: number;
  requests: MockModelRequest[];
  close(): Promise<void>;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("");
}

export function parseRequest(body: Record<string, unknown>): MockModelRequest {
  const input = Array.isArray(body.input) ? (body.input as Array<Record<string, unknown>>) : [];
  // Codex injects context blocks (<environment_context>, <user_instructions>…) as user messages; skip them.
  const users = input.filter((i) => i.type === "message" && i.role === "user" && !/^\s*<[a-z_]+>/.test(textOf(i.content)));
  const last = input.at(-1);
  // Namespaced tools (e.g. Codex's "collaboration") are listed both by namespace and as "namespace.tool".
  const tools = Array.isArray(body.tools)
    ? (body.tools as Array<Record<string, unknown>>).flatMap((t) => {
        const name = String(t.name ?? (t.function as { name?: string } | undefined)?.name ?? t.type);
        const nested = Array.isArray(t.tools) ? (t.tools as Array<{ name?: string }>).map((n) => `${name}.${String(n.name)}`) : [];
        return [name, ...nested];
      })
    : [];
  const agentMessage = last?.type === "agent_message" ? textOf(last.content) : "";
  return {
    lastUserText: textOf(users.at(-1)?.content),
    afterToolOutput: last?.type === "function_call_output" || last?.type === "custom_tool_call_output",
    agentTask: /Task name:\s*(\S+)/.exec(agentMessage)?.[1] ?? null,
    tools,
    body,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function streamReply(res: ServerResponse, reply: MockReply, seq: number): Promise<void> {
  const responseId = `resp_mock_${seq}`;
  const send = (data: Record<string, unknown>) => res.write(`event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`);
  const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 };
  send({ type: "response.created", response: { id: responseId, object: "response", status: "in_progress", output: [] } });

  let item: Record<string, unknown>;
  if (reply.kind === "text") {
    const itemId = `msg_mock_${seq}`;
    send({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] } });
    const chunks = Math.max(1, reply.chunks ?? 3);
    const size = Math.ceil(reply.text.length / chunks);
    for (let i = 0; i < reply.text.length; i += size) {
      if (res.destroyed) return;
      send({ type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta: reply.text.slice(i, i + size) });
      if (reply.delayMs) await sleep(reply.delayMs);
    }
    item = { type: "message", id: itemId, role: "assistant", status: "completed", content: [{ type: "output_text", text: reply.text, annotations: [] }] };
  } else {
    item = {
      type: "function_call",
      id: `fc_mock_${seq}`,
      call_id: `call_mock_${seq}`,
      name: reply.name,
      ...(reply.namespace ? { namespace: reply.namespace } : {}),
      arguments: JSON.stringify(reply.arguments),
      status: "completed",
    };
    send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", arguments: "" } });
  }
  send({ type: "response.output_item.done", output_index: 0, item });
  send({ type: "response.completed", response: { id: responseId, object: "response", status: "completed", output: [item], usage } });
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

/** Starts the mock on 127.0.0.1. Port 0 picks a free one; tests in the Studio range use 47950–47959. */
export async function startMockModel(options: { port?: number; script?: MockScript } = {}): Promise<MockModelServer> {
  const script = options.script ?? defaultScript;
  const requests: MockModelRequest[] = [];
  let seq = 0;
  const server: Server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [] }));
        return;
      }
      if (req.method !== "POST" || !req.url?.endsWith("/responses")) {
        res.writeHead(404).end();
        return;
      }
      const parsed = parseRequest(JSON.parse(await readBody(req)) as Record<string, unknown>);
      requests.push(parsed);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      await streamReply(res, script(parsed), ++seq);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(err) } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
