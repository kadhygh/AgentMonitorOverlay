import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RelayClient, RelayClientError, clientFromSettings, readSettings, type RelaySettings } from "./client.js";
import { RELAY_VERSION, TASK_STATUSES, type Message, type TaskStatus, type Thread } from "./protocol.js";
import { notesAsText, sessionStateText, taskAsText, threadAsText, usagePrompt } from "./usage.js";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
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
}

/** The server with its tools; `instructions` from the service's member list when it answers. */
export async function createRelayMcp(opts: RelayMcpOptions = {}): Promise<McpServer> {
  const settings = opts.settings ?? (() => readSettings());
  const s = settings();
  let instructions = usagePrompt({ me: s?.name ?? "（未加入）" });
  if (s) {
    try {
      const client = clientFromSettings(s);
      const [me, members, settings] = await Promise.all([client.me(), client.members(), client.settings().catch(() => null)]);
      instructions = usagePrompt({ me: me.name, role: me.role, members, flow: settings?.flow });
    } catch {
      // The service may be down when the client starts; the tools say so when called.
    }
  }
  const server = new McpServer({ name: RELAY_MCP_NAME, version: RELAY_VERSION }, { instructions });
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

  // Sessions (stage 2a). The first names of stage 1 stay as aliases, so agents that learnt them keep working.
  const openSchema = {
    to: z.string().describe("对方的名字（relay_people 里的）"),
    taskId: z.string().optional().describe("为某个团队任务发的，填它的 taskId"),
    files: z.array(z.string()).optional().describe("一起带上的文件（fileId，先用 relay_file_put 传）"),
    title: z.string().describe("一句话说清要对方处理什么"),
    body: z.string().describe("Markdown 正文：背景、方案、要确认的点，附上关键片段"),
    questions: z
      .array(z.object({ id: z.string().optional(), text: z.string(), options: z.array(z.string()).optional() }))
      .optional()
      .describe("要对方逐条回答的问题；一个问题只问一件事"),
  };
  const openSession = async (args: { to: string; taskId?: string; files?: string[]; title: string; body: string; questions?: Array<{ id?: string; text: string; options?: string[] }> }) =>
    tool(async (client) => {
      const out = await client.ask({ ...args, via: via() });
      return `已发给 ${out.thread.request?.to}，对方要回复后返回给你。threadId: ${out.thread.id}\n之后用 relay_session_get 取回复，或 relay_session_wait 等一会儿。`;
    })();
  const openDesc =
    "给团队里的某个人发一个会话，要他处理一件事（确认方案、回答问题）。发出就返回 threadId，不会等回复；对方必须回复，结束由你这边标记。对方看不到你本机的文件和对话，正文里要写清背景并贴出关键内容。问题要逐条列出，可以带选项。";
  for (const [name, title] of [
    ["relay_session_open", "发会话"],
    ["relay_ask", "发会话（旧名，同 relay_session_open）"],
  ] as const)
    server.registerTool(name, { title, description: openDesc, inputSchema: openSchema, annotations: annotations(false) }, openSession);

  const getSchema = { threadId: z.string().optional(), after: z.number().int().optional().describe("只看这个序号（#n）之后的消息") };
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
  const getDesc = "带 threadId：这个会话（或对话）里的消息，含逐条回答、结论和状态变化；可用 after 只看某个序号之后的。不带：列出我的会话和状态。";
  for (const [name, title] of [
    ["relay_session_get", "取会话"],
    ["relay_replies", "取会话（旧名，同 relay_session_get）"],
  ] as const)
    server.registerTool(name, { title, description: getDesc, inputSchema: getSchema, annotations: annotations(true) }, getSession);

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
  const waitDesc = "等这个会话里对方的新消息（通常是对方处理完返回），最多等 minutes 分钟（默认 5，最多 10）。默认从我最后一条消息之后算，已经到了的会马上返回。只在确实没别的可做时用。";
  for (const [name, title] of [
    ["relay_session_wait", "等回复"],
    ["relay_wait", "等回复（旧名，同 relay_session_wait）"],
  ] as const)
    server.registerTool(name, { title, description: waitDesc, inputSchema: waitSchema, annotations: annotations(true) }, waitSession);

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
        '在会话里写一条：then="ask" 继续追问，会话回到对方手里——只写 body 是用话追问，对方用话回答；再带 questions 就是新一轮逐条回答的问题（之前的问题不用再答）；then="done" 问清楚了，标记完成（body 可写一句收尾）；then="note"（默认）只是补充，不换人。',
      inputSchema: {
        threadId: z.string(),
        body: z.string().optional().describe("Markdown"),
        then: z.enum(["ask", "done", "note"]).optional(),
        questions: z.array(z.object({ id: z.string().optional(), text: z.string(), options: z.array(z.string()).optional() })).optional().describe("then=ask 时可带：新一轮要对方逐条回答的问题"),
      },
      annotations: annotations(false),
    },
    reply,
  );
  server.registerTool(
    "relay_send",
    {
      title: "补充（旧名，同 relay_session_reply 的 note）",
      description: "在会话（或对话）里补充一条消息，不换人。要继续追问或结束，用 relay_session_reply。",
      inputSchema: { threadId: z.string(), body: z.string().describe("Markdown") },
      annotations: annotations(false),
    },
    async (args: { threadId: string; body: string }) => reply({ ...args, then: "note" }),
  );

  server.registerTool(
    "relay_session_handoff",
    {
      title: "交给本人",
      description: "拿不准、需要本人决定时，把这个会话交给本人处理（他的待处理里会高亮），附一句原因。之后不要再动这个会话。",
      inputSchema: { threadId: z.string(), note: z.string().describe("为什么交给本人、需要他决定什么") },
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
      description: "待我这边处理的会话：返回给我、等你接着处理的，以及别人发给我、要我本人回复的。新对话开始时先看一眼。",
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
      if (forAi.length) parts.push(`返回给我、等你接着处理（用 relay_session_get 取）：\n${forAi.map(line).join("\n")}`);
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
      description: "把本机的一个文件传到任务（taskId）或会话（threadId）里，返回 fileId；同名再传就是新版本。最大 20 MB。",
      inputSchema: { path: z.string().describe("本机文件的路径"), taskId: z.string().optional(), threadId: z.string().optional(), name: z.string().optional().describe("在中转上显示的名字，默认是文件名") },
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
    { title: "读文件", description: "读一个文件：文字类（md、html、txt、json…）返回内容（最多约 200 KB），再附上它的批注。", inputSchema: { fileId: z.string() }, annotations: annotations(true) },
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
    { title: "任务列表", description: "列出团队任务：标题、状态、在谁手里、taskId。mine=true 只看我手里的；默认不含已归档的。", inputSchema: { mine: z.boolean().optional(), status: statusEnum.optional(), archived: z.boolean().optional() }, annotations: annotations(true) },
    async (args: { mine?: boolean; status?: TaskStatus; archived?: boolean }) =>
      tool(async (client, me) => {
        const list = (await client.tasks()).filter((t) => (args.archived ? true : !t.archived) && (!args.mine || t.holder === me) && (!args.status || t.status === args.status));
        if (!list.length) return "没有符合的任务。";
        return list.map((t) => `- ${t.title} · ${t.status} · 在 ${t.holder} 手里${t.unseen ? " · 刚交给你" : ""} · taskId ${t.id}`).join("\n");
      })(),
  );
  server.registerTool(
    "relay_task_get",
    { title: "看任务", description: "一个团队任务的全部：说明、状态、持有人、记录里的决策、它下面的会话（带 threadId）。", inputSchema: { taskId: z.string() }, annotations: annotations(true) },
    async (args: { taskId: string }) =>
      tool(async (client) => {
        const { task, events } = await client.task(args.taskId);
        return taskAsText(task, events);
      })(),
  );
  server.registerTool(
    "relay_task_create",
    { title: "新建任务", description: "新建一个团队任务。holder 默认是我；status 默认 开发中。", inputSchema: { title: z.string(), description: z.string().optional().describe("Markdown"), holder: z.string().optional(), status: statusEnum.optional() }, annotations: annotations(false) },
    async (args: { title: string; description?: string; holder?: string; status?: TaskStatus }) =>
      tool(async (client) => {
        const t = await client.createTask({ ...args, via: via() });
        return `已新建任务「${t.title}」，在 ${t.holder} 手里，${t.status}。taskId: ${t.id}`;
      })(),
  );
  server.registerTool(
    "relay_task_update",
    { title: "改任务", description: "改一个任务的标题、说明（Markdown，整段替换）或状态。换人用 relay_task_transfer。", inputSchema: { taskId: z.string(), title: z.string().optional(), description: z.string().optional(), status: statusEnum.optional() }, annotations: annotations(false) },
    async (args: { taskId: string; title?: string; description?: string; status?: TaskStatus }) =>
      tool(async (client) => {
        const { taskId, ...patch } = args;
        const t = await client.updateTask(taskId, { ...patch, via: via() });
        return `已更新「${t.title}」：${t.status}，在 ${t.holder} 手里。`;
      })(),
  );
  server.registerTool(
    "relay_task_transfer",
    { title: "流转任务", description: "把任务交给某人（也可以是自己），写清新状态和原因；会记进任务记录，对方的待处理里会出现。", inputSchema: { taskId: z.string(), to: z.string(), status: statusEnum.optional(), reason: z.string() }, annotations: annotations(false) },
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
