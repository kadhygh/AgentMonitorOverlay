import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RelayClient, RelayClientError, clientFromSettings, readSettings, relayHome, type RelaySettings } from "./client.js";
import { RELAY_VERSION, TASK_STATUSES, type Message, type TaskStatus, type Thread } from "./protocol.js";
import { mcpInstructions, newRepliesText, notesAsText, sessionStateText, taskAsText, threadAsText } from "./usage.js";
import { takeInbox } from "./inbox.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { typeOf } from "./types.js";

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
  /** This conversation's mark (Via.conv); default a new one per process. */
  conv?: string;
}

/** The server with its tools; `instructions` from the service's member list when it answers. */
export async function createRelayMcp(opts: RelayMcpOptions = {}): Promise<McpServer> {
  const settings = opts.settings ?? (() => readSettings());
  const s = settings();
  const usageFile = join(relayHome(), "AMO中转用法.md");
  const file = existsSync(usageFile) ? usageFile : undefined;
  let instructions = mcpInstructions({ me: s?.name ?? "（未加入）", usageFile: file });
  if (s) {
    try {
      const client = clientFromSettings(s);
      const me = await client.me();
      instructions = mcpInstructions({ me: me.name, role: me.role, usageFile: file });
    } catch {
      // The service may be down when the client starts; the tools say so when called.
    }
  }
  const server = new McpServer({ name: RELAY_MCP_NAME, version: RELAY_VERSION }, { instructions });
  // One MCP process per AI conversation (its client starts it over stdio): its mark goes on everything it sends, and
  // relay_inbox takes back only those (2026-10-30, the user: not the replies another conversation of mine waits for).
  const conv = opts.conv ?? `mcp-${randomUUID().slice(0, 8)}`;
  const via = () => {
    const client = server.server.getClientVersion()?.name;
    return client ? { kind: "ai" as const, client, conv } : { kind: "ai" as const, conv };
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
    { title: "能找的人", description: "团队里的人：名字、负责什么、是否在线。", inputSchema: {}, annotations: annotations(true) },
    tool(async (client, me) => {
      const members = (await client.members()).filter((m) => m.name !== me);
      if (!members.length) return "还没有其他人加入。";
      return members.map((m) => `- ${m.name}${m.role ? `（${m.role}）` : ""}${m.online ? " · 在线" : ""}`).join("\n");
    }),
  );

  // Sessions (stage 2a). Descriptions are kept short: they sit in every conversation of a client that has this MCP.
  const openSchema = {
    to: z.string(),
    taskId: z.string().optional(),
    files: z.array(z.string()).optional().describe("fileId"),
    title: z.string(),
    body: z.string().describe("Markdown"),
    questions: z
      .array(z.object({ id: z.string().optional(), text: z.string(), options: z.array(z.string()).optional() }))
      .optional()
      .describe("逐条回答的问题"),
  };
  const openSession = async (args: { to: string; taskId?: string; files?: string[]; title: string; body: string; questions?: Array<{ id?: string; text: string; options?: string[] }> }) =>
    tool(async (client) => {
      const out = await client.ask({ ...args, via: via() });
      return `已发给 ${out.thread.request?.to}，对方要回复后返回给你。threadId: ${out.thread.id}\n之后用 relay_inbox 一次取回这个对话发出的新回复，或 relay_session_wait 等一会儿。`;
    })();
  const openDesc = "发会话请某人处理一件事，立刻返回 threadId。对方看不到本机文件和对话：正文写清背景，文档用 files 带上。";
  server.registerTool("relay_session_open", { title: "发会话", description: openDesc, inputSchema: openSchema, annotations: annotations(false) }, openSession);

  const getSchema = { threadId: z.string().optional(), after: z.number().int().optional().describe("只看 #n 之后的") };
  const getSession = async (args: { threadId?: string; after?: number }) =>
    tool(async (client, me) => {
      if (args.threadId) {
        const { thread, messages } = await client.messages(args.threadId, args.after ?? 0, { ai: true });
        const request = args.after ? await requestOf(client, thread) : undefined;
        return messages.length ? threadAsText(thread, messages, request) : `${threadAsText(thread, [])}\n\n（#${args.after ?? 0} 之后没有新消息）`;
      }
      const mine = (await client.threads()).filter((t) => t.request && (t.request.from === me || t.request.to === me)).slice(0, 30);
      if (!mine.length) return "还没有会话。";
      return mine.map((t) => `- ${t.title} · ${t.request!.from} → ${t.request!.to} · ${sessionStateText(t.request!)} · threadId ${t.id} · 最新 #${t.lastSeq}`).join("\n");
    })();
  const getDesc = "带 threadId：会话内容（逐条回答、结论、批注）；不带：我的会话列表。";
  server.registerTool("relay_session_get", { title: "取会话", description: getDesc, inputSchema: getSchema, annotations: annotations(true) }, getSession);

  const inbox = async () =>
    tool(async (client, me) => {
      const items = await takeInbox(client, me, (c) => c === conv);
      if (!items.length) return "这个对话发出的会话还没有新回复。";
      return items.map((i) => newRepliesText(i.thread, i, `用 relay_session_get（threadId ${i.thread.id}）`)).join("\n\n---\n\n");
    })();
  const inboxDesc = "一次取回这个对话发出、已经回到我这边的所有会话的新回复（每个只给上次发言之后的），取过的不再给。";
  server.registerTool("relay_inbox", { title: "取新回复", description: inboxDesc, inputSchema: {}, annotations: annotations(true) }, inbox);

  const waitSchema = { threadId: z.string(), minutes: z.number().optional(), after: z.number().int().optional() };
  const waitSession = async (args: { threadId: string; minutes?: number; after?: number }, extra: { signal: AbortSignal }) =>
    tool(async (client, me) => {
      const { thread, messages: all } = await client.messages(args.threadId);
      const after = args.after ?? lastBy(all, me);
      const minutes = Math.max(0.1, Math.min(args.minutes ?? 5, 10));
      const got = await client.wait({ threadId: args.threadId, after, timeoutMs: minutes * 60_000, signal: extra.signal, ai: true });
      if (!got.length) return `等了 ${minutes} 分钟还没有新回复。可以先做别的，之后用 relay_session_get 看（threadId ${thread.id}）。`;
      const { thread: now } = await client.messages(args.threadId, after);
      return threadAsText(now, got, all.find((m) => m.kind === "request"));
    })();
  const waitDesc = "等对方返回，最多 minutes 分钟（默认 5，最多 10）；没别的可做时再用。";
  server.registerTool("relay_session_wait", { title: "等回复", description: waitDesc, inputSchema: waitSchema, annotations: annotations(true) }, waitSession);

  const reply = async (args: { threadId: string; body?: string; then?: "ask" | "done" | "note"; questions?: Array<{ id?: string; text: string; options?: string[] }> }) =>
    tool(async (client) => {
      const then = args.then ?? "note";
      const body = args.body?.trim();
      if (then === "ask") {
        if (!body) throw new RelayClientError(400, "bad_request", "继续追问要写内容（body）");
        const out = await client.send(args.threadId, { kind: "text", body, pass: true, questions: args.questions?.length ? args.questions : undefined, via: via() });
        return `已追问（#${out.message.seq}），会话回到 ${out.thread.request?.to ?? "对方"} 手里。`;
      }
      if (then === "note" && !body) throw new RelayClientError(400, "bad_request", "补充要写内容（body）");
      if (body) await client.send(args.threadId, { kind: "text", body, via: via() });
      if (then === "done") {
        await client.session(args.threadId, "done", { via: via() });
        return "已标记完成。";
      }
      return "已发出。";
    })();
  server.registerTool(
    "relay_session_reply",
    {
      title: "处理返回的会话",
      description:
        'then="ask" 追问（带 questions 是新一轮问题），会话回到对方手里；then="done" 收尾并标记完成；默认只补充。',
      inputSchema: {
        threadId: z.string(),
        body: z.string().optional().describe("Markdown"),
        then: z.enum(["ask", "done", "note"]).optional(),
        questions: z.array(z.object({ id: z.string().optional(), text: z.string(), options: z.array(z.string()).optional() })).optional(),
      },
      annotations: annotations(false),
    },
    reply,
  );
  server.registerTool(
    "relay_session_handoff",
    {
      title: "交给本人",
      description: "拿不准时把会话交给本人，附原因；之后别再动它。",
      inputSchema: { threadId: z.string(), note: z.string() },
      annotations: annotations(false),
    },
    async (args: { threadId: string; note: string }) =>
      tool(async (client) => {
        await client.session(args.threadId, "handoff", { note: args.note, via: via() });
        return "已交给本人。";
      })(),
  );

  server.registerTool(
    "relay_queue",
    {
      title: "待处理",
      description: "待我这边处理的会话。开始时先看一眼。",
      inputSchema: {},
      annotations: annotations(true),
    },
    tool(async (client, me) => {
      const live = (await client.threads()).filter((t) => t.request && t.request.state !== "done" && t.request.waitingOn === me);
      const line = (t: Thread) => `- ${t.title} · ${t.request!.from} → ${t.request!.to} · threadId ${t.id}`;
      const forAi = live.filter((t) => t.request!.from === me && t.request!.handler === "ai");
      const taken = live.filter((t) => t.request!.from === me && t.request!.handler === "person");
      const asked = live.filter((t) => t.request!.to === me);
      const parts: string[] = [];
      if (forAi.length) parts.push(`返回给我、等你接着处理（这个对话发出的用 relay_inbox 一次取回，别的用 relay_session_get）：\n${forAi.map(line).join("\n")}`);
      if (taken.length) parts.push(`已由本人接手（不要动）：\n${taken.map(line).join("\n")}`);
      if (asked.length) parts.push(`别人发给我、等我本人回复（除非我让你帮忙，否则不用管）：\n${asked.map(line).join("\n")}`);
      return parts.join("\n\n") || "没有待处理的会话。";
    }),
  );



  // Files and notes (stages 2c, 2d).
  server.registerTool(
    "relay_file_put",
    {
      title: "传文件",
      description: "把本机文件传到任务或会话里，返回 fileId；同名是新版本。",
      inputSchema: { path: z.string(), taskId: z.string().optional(), threadId: z.string().optional(), name: z.string().optional() },
      annotations: annotations(false),
    },
    async (args: { path: string; taskId?: string; threadId?: string; name?: string }) =>
      tool(async (client) => {
        if (!args.taskId === !args.threadId) throw new RelayClientError(400, "bad_request", "taskId 和 threadId 要给一个");
        const data = await readFile(args.path);
        const name = args.name ?? basename(args.path);
        const f = await client.upload({ taskId: args.taskId, threadId: args.threadId }, name, data, typeOf(name), { ai: true });
        return `已上传 ${f.name} v${f.version}。fileId: ${f.id}`;
      })(),
  );
  server.registerTool(
    "relay_file_get",
    { title: "读文件", description: "读文件内容（文字类）和它的批注。", inputSchema: { fileId: z.string() }, annotations: annotations(true) },
    async (args: { fileId: string }) =>
      tool(async (client) => {
        const [versions, notes] = await Promise.all([client.versions(args.fileId), client.notes(args.fileId)]);
        const f = versions.find((v) => v.id === args.fileId)!;
        const head = `## ${f.name} v${f.version}（共 ${f.versions} 个版本）· ${f.type} · ${f.size} 字节 · ${f.by} 上传`;
        const textual = /^text\/|json|xml|javascript|markdown|yaml|csv/.test(f.type) || /\.(md|markdown|txt|html?|json|csv|ya?ml|xml|js|ts|lua|ini|toml)$/i.test(f.name);
        const body = textual ? (await (await client.fileData(f.id)).text()).slice(0, 200_000) : "（不是文字文件，没法在这里显示内容）";
        return `${head}\n\n${body}\n\n${notesAsText(f, notes)}`;
      })(),
  );

  // Team tasks (stage 2b).
  const statusEnum = z.enum(TASK_STATUSES);
  server.registerTool(
    "relay_task_list",
    { title: "任务列表", description: "团队任务列表；mine=true 只看我手里的。", inputSchema: { mine: z.boolean().optional(), status: statusEnum.optional(), archived: z.boolean().optional() }, annotations: annotations(true) },
    async (args: { mine?: boolean; status?: TaskStatus; archived?: boolean }) =>
      tool(async (client, me) => {
        const list = (await client.tasks()).filter((t) => (args.archived ? true : !t.archived) && (!args.mine || t.holder === me) && (!args.status || t.status === args.status));
        if (!list.length) return "没有符合的任务。";
        return list.map((t) => `- ${t.title} · ${t.status} · 在 ${t.holder} 手里${t.unseen ? " · 刚交给你" : ""} · taskId ${t.id}`).join("\n");
      })(),
  );
  server.registerTool(
    "relay_task_get",
    { title: "看任务", description: "任务的说明、状态、持有人、决策、会话和文件。", inputSchema: { taskId: z.string() }, annotations: annotations(true) },
    async (args: { taskId: string }) =>
      tool(async (client) => {
        const { task, events } = await client.task(args.taskId);
        return taskAsText(task, events);
      })(),
  );
  server.registerTool(
    "relay_task_create",
    { title: "新建任务", description: "新建团队任务（holder 默认是我，status 默认 开发中）。", inputSchema: { title: z.string(), description: z.string().optional(), holder: z.string().optional(), status: statusEnum.optional() }, annotations: annotations(false) },
    async (args: { title: string; description?: string; holder?: string; status?: TaskStatus }) =>
      tool(async (client) => {
        const t = await client.createTask({ ...args, via: via() });
        return `已新建任务「${t.title}」，在 ${t.holder} 手里，${t.status}。taskId: ${t.id}`;
      })(),
  );
  server.registerTool(
    "relay_task_update",
    { title: "改任务", description: "改标题、说明（整段替换）或状态。", inputSchema: { taskId: z.string(), title: z.string().optional(), description: z.string().optional(), status: statusEnum.optional() }, annotations: annotations(false) },
    async (args: { taskId: string; title?: string; description?: string; status?: TaskStatus }) =>
      tool(async (client) => {
        const { taskId, ...patch } = args;
        const t = await client.updateTask(taskId, { ...patch, via: via() });
        return `已更新「${t.title}」：${t.status}，在 ${t.holder} 手里。`;
      })(),
  );
  server.registerTool(
    "relay_task_transfer",
    { title: "流转任务", description: "把任务交给某人，写清新状态和原因。", inputSchema: { taskId: z.string(), to: z.string(), status: statusEnum.optional(), reason: z.string() }, annotations: annotations(false) },
    async (args: { taskId: string; to: string; status?: TaskStatus; reason: string }) =>
      tool(async (client) => {
        const { taskId, ...t } = args;
        const task = await client.transferTask(taskId, { ...t, via: via() });
        return `「${task.title}」已交给 ${task.holder}，${task.status}。`;
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
