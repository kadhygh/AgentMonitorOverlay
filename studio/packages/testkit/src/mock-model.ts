import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { listenInStudioRange } from "./ports.js";
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

/** A 1×1 PNG (base64), for tests that attach an image. */
export const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Sample reply used by `[[markdown]]`. */
export const MOCK_MARKDOWN = [
  "## 校验结果",
  "",
  "发现 **3** 张表的概率之和不为 1：",
  "",
  "| 表 | 概率和 |",
  "| --- | ---: |",
  "| Boss_Lv20 | 0.97 |",
  "| Chest_Rare | 1.04 |",
  "",
  "1. 先修正概率",
  "   - Boss_Lv20 补 0.03",
  "   - Chest_Rare 减 0.04",
  "2. 再跑一次 `ValidateDropTables`",
  "",
  "```csharp",
  "DropTable.Normalize(table);",
  "```",
  "",
  "参考 [掉落表规范](https://example.com/drop-tables)。",
].join("\n");

/** File the `[[demo]]` turn reads and edits (tests create it in the workspace first). */
export const DEMO_FILE = "importer.py";
export const DEMO_FILE_TEXT = ["import requests", "", "", "def fetch(url):", "    response = requests.get(url, timeout=10)", "    response.raise_for_status()", "    return response.json()", ""].join("\n");
const DEMO_PATCH = [
  "*** Begin Patch",
  `*** Update File: ${DEMO_FILE}`,
  "@@",
  "-import requests",
  "+import time",
  "+",
  "+import requests",
  "@@",
  "-def fetch(url):",
  "-    response = requests.get(url, timeout=10)",
  "-    response.raise_for_status()",
  "-    return response.json()",
  "+def fetch(url, retries=3, backoff=0.5):",
  "+    for attempt in range(retries):",
  "+        try:",
  "+            response = requests.get(url, timeout=10)",
  "+            response.raise_for_status()",
  "+            return response.json()",
  "+        except requests.RequestException:",
  "+            if attempt == retries - 1:",
  "+                raise",
  "+            time.sleep(backoff * 2 ** attempt)",
  "*** End Patch",
].join("\n");
/** Final answer of the `[[demo]]` turn. */
export const DEMO_ANSWER = [
  "已经给 `fetch` 加上了失败重试：",
  "",
  "| 参数 | 默认值 | 说明 |",
  "| --- | ---: | --- |",
  "| `retries` | 3 | 最多尝试次数 |",
  "| `backoff` | 0.5 | 退避基数（秒），每次翻倍 |",
  "",
  "- 只重试 `requests.RequestException`，其他异常照常抛出",
  "- 最后一次仍失败时把原异常抛给调用方",
  "",
  "```python",
  "data = fetch(url, retries=5)",
  "```",
].join("\n");

/** Questions of the `[[ask]]` turn (Claude's AskUserQuestion shape): one single choice, one multi-select. */
export const MOCK_ASK_QUESTIONS = [
  {
    header: "重试策略",
    question: "导入失败时要怎么重试？",
    multiSelect: false,
    options: [
      { label: "指数退避（推荐）", description: "每次等待时间翻倍，最多 3 次" },
      { label: "固定间隔", description: "每 2 秒重试一次，最多 5 次" },
      { label: "不重试", description: "失败直接报错，由调用方处理" },
    ],
  },
  {
    header: "日志",
    question: "重试时要记录哪些信息？",
    multiSelect: true,
    options: [
      { label: "失败原因", description: "异常类型和消息" },
      { label: "重试次数", description: "第几次尝试" },
      { label: "等待时长", description: "下一次重试前等了多久" },
    ],
  },
];

/** Plan of the `[[plan]]` turn (Claude's ExitPlanMode). */
export const MOCK_PLAN = [
  "# 给导入器加上失败重试",
  "",
  "导入器现在只请求一次，网络抖动就会整批失败。计划在 `fetch` 里加上带指数退避的重试。",
  "",
  "## 步骤",
  "",
  "1. 在 `importer.py` 的 `fetch` 加 `retries` 和 `backoff` 两个参数",
  "2. 只重试 `requests.RequestException`，其他异常照常抛出",
  "3. 每次等待 `backoff * 2 ** attempt` 秒",
  "4. 最后一次仍失败时把原异常抛给调用方",
  "5. 补充单元测试：成功、重试后成功、全部失败",
  "",
  "## 影响",
  "",
  "| 文件 | 改动 |",
  "| --- | --- |",
  "| `importer.py` | 重试循环 |",
  "| `tests/test_importer.py` | 三个新用例 |",
  "",
  "## 风险",
  "",
  "- 重试会让失败的导入变慢，最多多等 3.5 秒",
  "- 调用方如果自己也重试，次数会叠加",
].join("\n");

/** One model reply: plain text, or a tool call that Codex will execute (and may ask approval for); `reasoning` comes first. */
export type MockReply = (
  | { kind: "text"; text: string; chunks?: number; delayMs?: number }
  | { kind: "function_call"; name: string; arguments: Record<string, unknown>; namespace?: string }
  | { kind: "custom_tool_call"; name: string; input: string }
) & { reasoning?: string };

export interface MockModelRequest {
  /** Text of the last user message, if any. */
  lastUserText: string;
  /** Images in the last user message. */
  images: number;
  /** True when the last input item is a tool result, i.e. Codex is continuing after running a tool. */
  afterToolOutput: boolean;
  /** Set when this request is a subagent's first turn: the task name from Codex's agent_message (payload is encrypted). */
  agentTask: string | null;
  /** Names of tools Codex offered. */
  tools: string[];
  /** Name and output of the most recent tool call, once its output is in. */
  lastTool: { name: string; output: string } | null;
  /** Tool outputs since the person's last message: how far a multi-step turn has got. */
  toolOutputsSinceUser: number;
  body: Record<string, unknown>;
}

export type MockScript = (req: MockModelRequest) => MockReply;

/**
 * Default script. Directives in the user text let tests pick behaviour:
 * - `[[shell: <command>]]` → call the shell tool once, then reply `MOCK-DONE`
 * - `[[spawn: task_name: message]]` → call Codex's collaboration.spawn_agent once, then reply `MOCK-DONE`;
 *   the subagent itself replies `MOCK-SUB: /root/<task_name>`
 * - `[[slow]]` → stream the reply in many small chunks with a delay (for steer/interrupt tests)
 * - `[[markdown]]` → a reply with a table, a nested list, a code block and a link (rendering tests)
 * - `[[mcp: <tool> {json args}]]` → calls the AMO MCP tool of that name (as Codex exposes it), then replies
 *   `MOCK-MCP: <start of its output>`
 * - `[[think]]` → thinks first, then replies `MOCK: <user text>`
 * - `[[demo]]` → a whole working turn: think, read `importer.py`, patch it, run a check, answer with a table
 * - `[[ask]]` → calls request_user_input with MOCK_ASK_QUESTIONS in Codex's shape (ids `retry`, `logging`),
 *   then replies `MOCK-ANSWERED: <the tool output>`
 * - anything else → `MOCK: <user text>`, plus ` [images: N]` when the message carried images
 */
export const defaultScript: MockScript = (req) => {
  if (req.lastUserText.includes("[[demo]]")) return demoStep(req);
  if (req.afterToolOutput && req.lastTool && /amo/.test(req.lastTool.name)) return { kind: "text", text: `MOCK-MCP: ${req.lastTool.output.slice(0, 200)}` };
  if (req.afterToolOutput && req.lastTool?.name === "request_user_input") return { kind: "text", text: `MOCK-ANSWERED: ${req.lastTool.output}` };
  if (req.afterToolOutput) return { kind: "text", text: "MOCK-DONE" };
  if (req.lastUserText.includes("[[ask]]") && req.tools.includes("request_user_input")) {
    const ids = ["retry", "logging"];
    const questions = MOCK_ASK_QUESTIONS.map((q, i) => ({ id: ids[i]!, header: q.header, question: q.question, options: q.options }));
    return { kind: "function_call", name: "request_user_input", arguments: { questions } };
  }
  const mcp = /\[\[mcp:\s*([a-z_]+)\s*(\{.*?\})?\s*\]\]/.exec(req.lastUserText);
  if (mcp) {
    const name = req.tools.find((t) => /amo/.test(t) && (t.endsWith(`.${mcp[1]}`) || t.endsWith(`__${mcp[1]}`)));
    if (name) {
      const args = mcp[2] ? (JSON.parse(mcp[2]) as Record<string, unknown>) : {};
      const dot = name.lastIndexOf(".");
      return dot > 0
        ? { kind: "function_call", name: name.slice(dot + 1), namespace: name.slice(0, dot), arguments: args }
        : { kind: "function_call", name, arguments: args };
    }
  }
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
  if (req.lastUserText.includes("[[markdown]]")) return { kind: "text", text: MOCK_MARKDOWN };
  if (req.lastUserText.includes("[[slow]]")) return { kind: "text", text: "slow ".repeat(40).trim(), chunks: 40, delayMs: 150 };
  if (req.lastUserText.includes("[[think]]")) return { kind: "text", text: `MOCK: ${req.lastUserText}`, reasoning: "先想一想用户要什么。\n这是一条测试消息，照原样回复即可。" };
  return { kind: "text", text: `MOCK: ${req.lastUserText}${req.images ? ` [images: ${req.images}]` : ""}` };
};

function demoStep(req: MockModelRequest): MockReply {
  const shell = (command: string): MockReply =>
    req.tools.includes("exec_command") ? { kind: "function_call", name: "exec_command", arguments: { cmd: command } } : { kind: "function_call", name: "shell_command", arguments: { command } };
  switch (req.toolOutputsSinceUser) {
    case 0:
      return { ...shell(`cat ${DEMO_FILE}`), reasoning: "用户想给导入器加上失败重试。\n先读一下 importer.py，看看现在的请求是怎么发的。" };
    case 1:
      return req.tools.includes("apply_patch")
        ? { kind: "custom_tool_call", name: "apply_patch", input: DEMO_PATCH, reasoning: "fetch 只请求一次，失败直接抛出。\n加一个带指数退避的循环，只重试网络错误。" }
        : { ...shell("cmd /c echo patched"), reasoning: "加一个带指数退避的循环。" };
    case 2:
      return { ...shell("cmd /c echo 3 passed in 0.12s"), reasoning: "改好了，跑一下检查，确认原有行为没有被破坏。" };
    default:
      return { kind: "text", text: DEMO_ANSWER, chunks: 8, reasoning: "检查通过，整理一下改动给用户。" };
  }
}

export interface MockModelServer {
  /** Base URL to put in `model_providers.<id>.base_url`. */
  baseUrl: string;
  port: number;
  requests: MockModelRequest[];
  close(): Promise<void>;
}

/** Text of a message; the tags Codex puts around an image (`<image name=…>`, `</image>`) are not the person's text. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
    .filter((t) => !/^\s*<\/?image\b[^>]*>\s*$/.test(t))
    .join("");
}

const imageCount = (content: unknown) => (Array.isArray(content) ? content.filter((p) => p && typeof p === "object" && (p as { type?: unknown }).type === "input_image").length : 0);

function lastToolCall(input: Array<Record<string, unknown>>): { name: string; output: string } | null {
  const call = [...input].reverse().find((i) => i.type === "function_call");
  if (!call) return null;
  const out = input.find((i) => (i.type === "function_call_output" || i.type === "custom_tool_call_output") && i.call_id === call.call_id);
  if (!out) return null;
  const output = typeof out.output === "string" ? out.output : JSON.stringify(out.output ?? "");
  return { name: [call.namespace, call.name].filter(Boolean).join("."), output };
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
  const lastUser = input.lastIndexOf(users.at(-1)!);
  const outputs = input.slice(lastUser + 1).filter((i) => i.type === "function_call_output" || i.type === "custom_tool_call_output").length;
  return {
    lastUserText: textOf(users.at(-1)?.content),
    images: imageCount(users.at(-1)?.content),
    afterToolOutput: last?.type === "function_call_output" || last?.type === "custom_tool_call_output",
    lastTool: lastToolCall(input),
    toolOutputsSinceUser: outputs,
    agentTask: /Task name:\s*(\S+)/.exec(agentMessage)?.[1] ?? null,
    tools,
    body,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function streamReply(res: ServerResponse, reply: MockReply, seq: number): Promise<void> {
  const responseId = `resp_mock_${seq}`;
  const send = (data: Record<string, unknown>) => res.write(`event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`);
  const usage = { input_tokens: 1200 + seq * 300, input_tokens_details: { cached_tokens: 800 + seq * 250 }, output_tokens: 160, output_tokens_details: { reasoning_tokens: reply.reasoning ? 60 : 0 }, total_tokens: 1360 + seq * 300 };
  send({ type: "response.created", response: { id: responseId, object: "response", status: "in_progress", output: [] } });

  const output: Array<Record<string, unknown>> = [];
  if (reply.reasoning) {
    // Raw reasoning content, the way DeepSeek-style models stream their thinking.
    const id = `rs_mock_${seq}`;
    send({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id, summary: [], content: [] } });
    const parts = reply.reasoning.match(/[\s\S]{1,12}/g) ?? [];
    for (const delta of parts) {
      if (res.destroyed) return;
      send({ type: "response.reasoning_text.delta", item_id: id, output_index: 0, content_index: 0, delta });
      await sleep(15);
    }
    const item = { type: "reasoning", id, summary: [], content: [{ type: "reasoning_text", text: reply.reasoning }], encrypted_content: null };
    send({ type: "response.output_item.done", output_index: 0, item });
    output.push(item);
  }
  const index = output.length;

  let item: Record<string, unknown>;
  if (reply.kind === "text") {
    const itemId = `msg_mock_${seq}`;
    send({ type: "response.output_item.added", output_index: index, item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] } });
    const chunks = Math.max(1, reply.chunks ?? 3);
    const size = Math.ceil(reply.text.length / chunks);
    for (let i = 0; i < reply.text.length; i += size) {
      if (res.destroyed) return;
      send({ type: "response.output_text.delta", item_id: itemId, output_index: index, content_index: 0, delta: reply.text.slice(i, i + size) });
      if (reply.delayMs) await sleep(reply.delayMs);
    }
    item = { type: "message", id: itemId, role: "assistant", status: "completed", content: [{ type: "output_text", text: reply.text, annotations: [] }] };
  } else if (reply.kind === "custom_tool_call") {
    item = { type: "custom_tool_call", id: `ctc_mock_${seq}`, call_id: `call_mock_${seq}`, name: reply.name, input: reply.input, status: "completed" };
    send({ type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress", input: "" } });
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
    send({ type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress", arguments: "" } });
  }
  send({ type: "response.output_item.done", output_index: index, item });
  output.push(item);
  send({ type: "response.completed", response: { id: responseId, object: "response", status: "completed", output, usage } });
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
  if (options.port) await new Promise<void>((resolve) => server.listen(options.port, "127.0.0.1", resolve));
  else await listenInStudioRange(server);
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
