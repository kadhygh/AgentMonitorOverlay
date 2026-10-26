import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RelayClient, RelayClientError, clientFromSettings, readSettings, type RelaySettings } from "./client.js";
import { VERDICT_LABEL, type Message, type Thread } from "./protocol.js";
import { threadAsText, usagePrompt } from "./usage.js";

// The relay as MCP tools (stdio, `amo-relay mcp`), for any AI client. It speaks as the person whose settings are on
// this machine, read again on every call, so joining after the client started works. Its instructions are the same
// usage prompt the person can copy (usage.ts).

export const RELAY_MCP_NAME = "amo-relay";

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const NOT_JOINED = "这台机器还没加入 AMO 中转。请让使用者先在 AMO Relay 客户端里登录（或运行 amo-relay login）。";

export interface RelayMcpOptions {
  /** This machine's identity; default: the settings file. */
  settings?: () => RelaySettings | null;
  /** Shown in the usage text for clients without MCP; usually left out here. */
  cli?: string;
}

/** The server with its tools; `instructions` from the service's member list when it answers. */
export async function createRelayMcp(opts: RelayMcpOptions = {}): Promise<McpServer> {
  const settings = opts.settings ?? (() => readSettings());
  const s = settings();
  let instructions = usagePrompt({ me: s?.name ?? "（未加入）" });
  if (s) {
    try {
      const client = clientFromSettings(s);
      const [me, members] = await Promise.all([client.me(), client.members()]);
      instructions = usagePrompt({ me: me.name, role: me.role, members });
    } catch {
      // The service may be down when the client starts; the tools say so when called.
    }
  }
  const server = new McpServer({ name: RELAY_MCP_NAME, version: "0.1.0" }, { instructions });
  const via = () => {
    const client = server.server.getClientVersion()?.name;
    return client ? { kind: "ai" as const, client } : { kind: "ai" as const };
  };

  const tool = (run: (client: RelayClient, me: string) => Promise<string>) => async (): Promise<ToolResult> => {
    const current = settings();
    if (!current) return fail(NOT_JOINED);
    try {
      return ok(await run(clientFromSettings(current), current.name));
    } catch (err) {
      if (err instanceof RelayClientError) return fail(err.message);
      throw err;
    }
  };
  const annotations = (readOnly: boolean) => ({ readOnlyHint: readOnly, destructiveHint: false, openWorldHint: true });

  server.registerTool(
    "relay_people",
    { title: "能找的人", description: "列出中转服务上的人：名字、负责什么、是否在线。", inputSchema: {}, annotations: annotations(true) },
    tool(async (client, me) => {
      const members = (await client.members()).filter((m) => m.name !== me);
      if (!members.length) return "还没有其他人加入。";
      return members.map((m) => `- ${m.name}${m.role ? `（${m.role}）` : ""}${m.online ? " · 在线" : ""}`).join("\n");
    }),
  );

  server.registerTool(
    "relay_ask",
    {
      title: "发请求给某人",
      description:
        "给团队里的某个人发一条要他确认的请求，发出就返回 threadId，不会等回复。对方看不到你本机的文件和对话，正文里要写清背景并贴出关键内容。问题要逐条列出，可以带选项。",
      inputSchema: {
        to: z.string().describe("对方的名字（relay_people 里的）"),
        title: z.string().describe("一句话说清要确认什么"),
        body: z.string().describe("Markdown 正文：背景、方案、要确认的点，附上关键片段"),
        questions: z
          .array(z.object({ id: z.string().optional(), text: z.string(), options: z.array(z.string()).optional() }))
          .optional()
          .describe("要对方逐条回答的问题；一个问题只问一件事"),
      },
      annotations: annotations(false),
    },
    async (args: { to: string; title: string; body: string; questions?: Array<{ id?: string; text: string; options?: string[] }> }) =>
      tool(async (client) => {
        const out = await client.ask({ ...args, via: via() });
        return `已发给 ${out.thread.request?.to}。threadId: ${out.thread.id}\n之后用 relay_replies 取回复，或 relay_wait 等一会儿。`;
      })(),
  );

  server.registerTool(
    "relay_replies",
    {
      title: "看回复",
      description: "带 threadId：这个请求（或对话）里的消息，含逐条回答和结论；可用 after 只看某个序号之后的。不带：列出我发出的请求和它们的状态。",
      inputSchema: { threadId: z.string().optional(), after: z.number().int().optional().describe("只看这个序号（#n）之后的消息") },
      annotations: annotations(true),
    },
    async (args: { threadId?: string; after?: number }) =>
      tool(async (client, me) => {
        if (args.threadId) {
          const { thread, messages } = await client.messages(args.threadId, args.after ?? 0);
          const request = args.after ? await requestOf(client, thread) : undefined;
          return messages.length ? threadAsText(thread, messages, request) : `${threadAsText(thread, [])}\n\n（#${args.after ?? 0} 之后没有新消息）`;
        }
        const mine = (await client.threads()).filter((t) => t.request?.from === me).slice(0, 20);
        if (!mine.length) return "还没有发出过请求。";
        return mine
          .map((t) => {
            const r = t.request!;
            const state = r.status === "answered" ? `已回复${r.verdict ? `（${VERDICT_LABEL[r.verdict]}）` : ""}` : "等回复";
            return `- ${t.title} → ${r.to} · ${state} · threadId ${t.id} · 最新 #${t.lastSeq}`;
          })
          .join("\n");
      })(),
  );

  server.registerTool(
    "relay_wait",
    {
      title: "等回复",
      description: "等这个请求里对方的新消息，最多等 minutes 分钟（默认 5，最多 10）。默认从我最后一条消息之后算，已经到了的会马上返回。只在确实没别的可做时用。",
      inputSchema: { threadId: z.string(), minutes: z.number().optional(), after: z.number().int().optional() },
      annotations: annotations(true),
    },
    async (args: { threadId: string; minutes?: number; after?: number }, extra: { signal: AbortSignal }) =>
      tool(async (client, me) => {
        const { thread, messages: all } = await client.messages(args.threadId);
        const after = args.after ?? lastBy(all, me);
        const minutes = Math.max(0.1, Math.min(args.minutes ?? 5, 10));
        const got = await client.wait({ threadId: args.threadId, after, timeoutMs: minutes * 60_000, signal: extra.signal });
        if (!got.length) return `等了 ${minutes} 分钟还没有新回复。可以先做别的，之后用 relay_replies 看（threadId ${thread.id}）。`;
        const { thread: now } = await client.messages(args.threadId, after);
        return threadAsText(now, got, all.find((m) => m.kind === "request"));
      })(),
  );

  server.registerTool(
    "relay_send",
    {
      title: "追问或补充",
      description: "在一个请求（或对话）里再发一条消息：追问、补充信息、告诉对方你按回复做了什么。",
      inputSchema: { threadId: z.string(), body: z.string().describe("Markdown") },
      annotations: annotations(false),
    },
    async (args: { threadId: string; body: string }) =>
      tool(async (client) => {
        const out = await client.send(args.threadId, { kind: "text", body: args.body, via: via() });
        return `已发出（#${out.message.seq}）。`;
      })(),
  );

  return server;
}

/** The seq of my last message in a thread (0 when none). */
function lastBy(messages: Message[], me: string): number {
  return messages.reduce((n, m) => (m.author === me ? Math.max(n, m.seq) : n), 0);
}

async function requestOf(client: RelayClient, thread: Thread): Promise<Message | undefined> {
  if (!thread.request) return undefined;
  const { messages } = await client.messages(thread.id, thread.request.requestSeq - 1);
  return messages.find((m) => m.kind === "request");
}
