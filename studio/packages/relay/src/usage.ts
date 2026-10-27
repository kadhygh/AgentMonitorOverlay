import { VERDICT_LABEL, type FileNote, type Member, type Message, type RelayFile, type Task, type TaskEvent, type Thread } from "./protocol.js";

// Text for AIs: the usage prompt the person copies into any agent (「复制用法」, `amo-relay prompt`) and that the MCP
// gives as its instructions, and a thread as readable Markdown (the MCP's replies, the command line, 「复制回复」).
// One wording for all of them.

export interface UsageContext {
  me: string;
  role?: string;
  /** Everyone on the service, me included; others are listed as people to ask. */
  members?: Array<Pick<Member, "name" | "role">>;
  /** How to run the command line on this machine, e.g. `node G:\…\bin.js`; leave out when there is none. */
  cli?: string;
  /** The team's flow (TeamSettings.flow): how work moves here. */
  flow?: string;
}

export function usagePrompt(ctx: UsageContext): string {
  const others = (ctx.members ?? []).filter((m) => m.name !== ctx.me);
  const people = others.length ? others.map((m) => `- ${m.name}${m.role ? `（${m.role}）` : ""}`).join("\n") : "- （还没有其他人加入）";
  const cliMode = !!ctx.cli;
  const q = (cmd: string) => (cliMode ? `\`relay ${cmd}\`` : cmd);
  const head = `# AMO 中转：推进中需要别人确认时

我是 ${ctx.me}${ctx.role ? `（${ctx.role}）` : ""}。团队用「AMO 中转」在局域网里互相传话。推进中遇到需要别人确认的事（比如要程序确认实现方式、接口、工作量），不要停下来等我转述，你直接给对方发一个**会话**。对方在自己的面板上逐条回答，然后把会话返回给我这边，由你接着处理。

能找的人：
${people}

## 规则
- 你用的就是我（${ctx.me}）的身份：会话只能发给别人，不能发给 ${ctx.me}；要问我本人，直接在当前对话里问。
- 会话在谁手里就由谁处理。你发出的会话，对方必须回复，不能直接关掉；结束由你这边来标记。
- 对方看不到我本机的文件和这段对话：背景、方案和关键片段都要写进正文，文档作为文件传上去。
- 每次开始时先看一眼待处理（${cliMode ? q("queue") : "`relay_queue`"}），有返回给我的会话就接着处理。
- 提示「已由本人接手」时，就不要再动那个会话了。`;
  const flow = ctx.flow?.trim() ? `\n\n## 团队流程\n${ctx.flow.trim()}` : "";
  if (cliMode) {
    return `${head}

## 怎么用：命令行
下面的 \`relay\` 指本机的 \`"${ctx.cli}"\`。路径里有空格，要带引号：PowerShell 写 \`& "${ctx.cli}" people\`，cmd 和 bash 写 \`"${ctx.cli}" people\`。内容长的，用 \`--body-file <文件>\` 代替 \`--body "…"\`。

**会话**
- ${q("people")}：能找的人和他们负责什么
- ${q("queue")}：待我这边处理的会话
- ${q("ask --json <文件>")}：发会话（\`-\` 表示从标准输入读），发出就返回 threadId，不等回复。JSON：\`{"to":"名字","title":"一句话说清要确认什么","body":"Markdown 正文：背景、方案、要确认的点","questions":[{"text":"一个问题只问一件事","options":["选项1","选项2"]}],"taskId":"可选，挂在任务下","files":["可选，fileId"]}\`
- ${q("wait <threadId> [--minutes N]")}：等对方返回，最多 10 分钟；先做不依赖答复的部分，确实没别的可做再等
- ${q("replies [threadId]")}：取会话内容（逐条回答、补充说明、结论、附上的批注）；不带 id 时列出我的会话
- ${q('send <threadId> --body "…" --then ask')}：用话追问，会话回到对方手里；再加 \`--questions <文件>\`（JSON 数组，格式同上面的 questions）就是新一轮逐条回答的问题
- ${q('send <threadId> --body "…" --then done')}：问清楚了，写一句收尾并标记完成；然后按回复调整方案，告诉我对方怎么答的
- ${q('send <threadId> --body "…"')}：只补充，不换人
- ${q('handoff <threadId> --note "…"')}：拿不准、需要我来决定时，交给我本人

**团队任务**（状态只有 待处理 / 开发中 / 已完成 / 已搁置）
- ${q("tasks [--mine]")}、${q("task <taskId>")}：任务列表；一个任务的说明、决策、会话和文件
- ${q('newtask --title "…" [--desc-file <文件>] [--holder 名字] [--status 开发中]')}：新建任务
- ${q("settask <taskId> [--title …] [--desc-file <文件>] [--status …]")}：改任务
- ${q('transfer <taskId> --to 名字 --status 待处理 --reason "…"')}：流转给某人
- 为任务发的会话，在 JSON 里带上 "taskId"；对方的逐条回答和结论会自动记进任务的决策

**文件和批注**
- ${q("put <本机文件> --task <taskId>")}（或 \`--thread <threadId>\`）：传文件，返回 fileId；同名再传就是新版本
- ${q("file <fileId>")}：读文件内容和上面的批注（引文 + 意见）${flow}
`;
  }
  return `${head}

## 怎么用：MCP 工具（amo-relay）
- \`relay_people\`、\`relay_queue\`：能找的人；待我这边处理的会话。
- \`relay_session_open\`：发会话（to、title、body、questions，可带 taskId 和 files）；发出就返回 threadId，不等回复。
- \`relay_session_wait\`：等对方返回（最多 10 分钟）；\`relay_session_get\`：取会话内容。
- \`relay_session_reply\`：then="ask" 追问（带 questions 是新一轮问题），then="done" 收尾并标记完成。
- \`relay_session_handoff\`：交给我本人。
- 团队任务：\`relay_task_list\` / \`relay_task_get\` / \`relay_task_create\` / \`relay_task_update\` / \`relay_task_transfer\`；为任务发的会话带上 taskId。
- 文件：\`relay_file_put\` 传本机文件（同名是新版本），\`relay_file_get\` 读文件和批注。${flow}
`;
}

/** The MCP's instructions: short, since they sit in every conversation of a client; the rest is in the tools. */
export function mcpInstructions(ctx: UsageContext & { usageFile?: string }): string {
  return `我是 ${ctx.me}${ctx.role ? `（${ctx.role}）` : ""}。团队用 AMO 中转互相传话：要别人确认的事，用 relay_session_open 发会话给对方（不能发给我自己；问我本人就直接在对话里问），对方回复后 relay_session_get 取，relay_session_reply 追问（then="ask"）或收尾（then="done"）。开始时先 relay_queue。团队任务用 relay_task_*，文件用 relay_file_*。${ctx.usageFile ? `详细用法和团队流程在 ${ctx.usageFile}。` : ""}`;
}

/** Where a session stands, in words. */
export function sessionStateText(r: NonNullable<Thread["request"]>): string {
  if (r.state === "done") return "已完成";
  if (r.state === "open") return `在 ${r.to} 手里，等回复`;
  const verdict = r.verdict ? `（${VERDICT_LABEL[r.verdict]}）` : "";
  const side = r.handler === "ai" ? "，由 AI 接着处理" : "，由本人处理";
  return `已返回给 ${r.from}${verdict}${side}`;
}

const time = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const who = (m: Message) => (m.via.kind === "ai" ? `${m.author} 的 AI${m.via.client ? `（${m.via.client}）` : ""}` : m.author);

/** One message as Markdown; a reply's answers carry their questions, so the reader needs nothing else. */
export function messageAsText(m: Message, questions: Message["questions"] = []): string {
  if (m.kind === "event") return `> （${who(m)} ${m.body} · ${time(m.createdAt)} · #${m.seq}）`;
  const head = `### ${who(m)} · ${time(m.createdAt)} · #${m.seq}${m.kind === "request" ? " · 会话" : m.kind === "reply" ? " · 回复" : m.questions?.length ? " · 追问" : ""}`;
  const parts = [head];
  if (m.body) parts.push(m.body);
  if ((m.kind === "request" || m.kind === "text") && m.questions?.length) {
    parts.push(m.questions.map((q, i) => `${i + 1}. [${q.id}] ${q.text}${q.options?.length ? `（选项：${q.options.join(" / ")}）` : ""}`).join("\n"));
  }
  if (m.kind === "reply") {
    const byId = new Map((questions ?? []).map((q) => [q.id, q]));
    if (m.answers?.length) {
      parts.push(
        m.answers
          .map((a) => {
            const q = byId.get(a.questionId);
            const answer = [a.choice, a.text].filter(Boolean).join("：");
            return `- **${q ? q.text : a.questionId}** → ${answer}`;
          })
          .join("\n"),
      );
    }
    if (m.verdict) parts.push(`结论：**${VERDICT_LABEL[m.verdict]}**`);
    if (m.notes?.length) parts.push(`附上的批注：\n${m.notes.map((n) => `- ${n.file} v${n.version}：「${n.quote}」 → ${n.body}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

/** A thread and (some of) its messages as Markdown. */
export function threadAsText(thread: Thread, messages: Message[], requestMessage?: Message): string {
  // A reply answers the last round of questions before it (the request, or a follow-up that asked more).
  let questions = (requestMessage ?? messages.find((m) => m.kind === "request"))?.questions ?? [];
  const r = thread.request;
  const head = r
    ? `## 会话：${thread.title}\n${r.from} → ${r.to} · ${sessionStateText(r)}${r.needsReply ? " · 需要回复" : ""} · threadId ${thread.id}`
    : thread.kind === "topic"
      ? `## 话题：${thread.title}\n${thread.members.join("、")} · threadId ${thread.id}`
      : `## 对话：${thread.members.join("、")}\nthreadId ${thread.id}`;
  return [
    head,
    ...messages.map((m) => {
      if (m.questions?.length) questions = m.questions;
      return messageAsText(m, questions);
    }),
  ].join("\n\n");
}

/** A team task for an AI: what it is, where it stands, what was decided, its sessions. */
export function taskAsText(task: Task, events: TaskEvent[] = []): string {
  const parts = [`## 团队任务：${task.title}\n状态 ${task.status} · 在 ${task.holder} 手里 · ${task.creator} 创建${task.archived ? " · 已归档" : ""} · taskId ${task.id}`];
  parts.push(`### 说明\n${task.description.trim() || "（没写）"}`);
  const decisions = events.filter((e) => e.kind === "decision");
  if (decisions.length) parts.push(`### 决策\n${decisions.map((e) => `- ${e.text}`).join("\n")}`);
  if (task.files.length) parts.push(`### 文件\n${task.files.map((f) => `- ${f.name} v${f.version}${f.notes ? ` · ${f.notes} 条批注` : ""} · fileId ${f.id}`).join("\n")}`);
  if (task.sessions.length) {
    const state = (s: Task["sessions"][number]) => (s.state === "done" ? "已完成" : s.state === "open" ? `在 ${s.to} 手里` : `已返回给 ${s.from}`);
    parts.push(`### 会话\n${task.sessions.map((s) => `- ${s.title} · ${s.from} → ${s.to} · ${state(s)} · threadId ${s.id}`).join("\n")}`);
  }
  const log = events.filter((e) => e.kind !== "decision").slice(-12);
  if (log.length) parts.push(`### 最近的记录\n${log.map((e) => `- ${time(e.at)} ${e.actor} ${e.text}`).join("\n")}`);
  return parts.join("\n\n");
}

/** What 复制用法 copies when the usage text is a file on this machine: just where it is. */
export function usagePointer(file: string, cli?: string): string {
  return `请先读这个文件，按里面的说明用 AMO 中转（团队里互相传话、发会话找人确认、推进团队任务）：
${file}
（文件由 AMO 中转客户端自动更新${cli ? `；也可以运行 "${cli}" prompt 看最新的用法` : ""}）`;
}

/** 复制任务提示词: the task, then how to work with the relay (the usage prompt with the team flow, or the file it is in). */
export function taskPrompt(task: Task, events: TaskEvent[], ctx: UsageContext, usageFile?: string): string {
  return `# 接手推进团队任务「${task.title}」

先读下面的任务内容；需要更全的（附件、会话原文），用 relay_task_get（taskId ${task.id}）和 relay_session_get 取。按团队流程推进，需要别人确认的就在这个任务下发会话。

${taskAsText(task, events)}

---

${usageFile ? usagePointer(usageFile, ctx.cli) : usagePrompt(ctx)}`;
}

/** A file's notes as Markdown: what was quoted, what was said; for 复制批注 and for an AI. */
export function notesAsText(file: Pick<RelayFile, "name" | "version">, notes: FileNote[]): string {
  if (!notes.length) return `${file.name} v${file.version}：还没有批注。`;
  return [`### ${file.name} v${file.version} 的批注`, ...notes.map((n) => `> ${n.quote.replace(/\n/g, "\n> ")}\n\n${n.body}（${n.author}${n.version !== file.version ? `，写在 v${n.version} 上` : ""}）`)].join("\n\n");
}
