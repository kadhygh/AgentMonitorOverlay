import { VERDICT_LABEL, type Member, type Message, type Thread } from "./protocol.js";

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
}

export function usagePrompt(ctx: UsageContext): string {
  const others = (ctx.members ?? []).filter((m) => m.name !== ctx.me);
  const people = others.length ? others.map((m) => `- ${m.name}${m.role ? `（${m.role}）` : ""}`).join("\n") : "- （还没有其他人加入，用 relay_people 再看）";
  const cli = ctx.cli
    ? `

## 没有 MCP 工具时：命令行
- \`${ctx.cli} people\`：能找的人
- \`${ctx.cli} queue\`：待我这边处理的会话
- \`${ctx.cli} ask --json <文件>\`：发会话。文件内容是 JSON：{"to":"名字","title":"…","body":"Markdown 正文","questions":[{"text":"…","options":["…"]}]}；用 \`-\` 代替文件名时从标准输入读
- \`${ctx.cli} replies [threadId]\`：取会话内容（不带 id 时列出我的会话）
- \`${ctx.cli} wait <threadId> [--minutes N]\`：等对方返回，最多 10 分钟
- \`${ctx.cli} send <threadId> --body "…" [--then ask|done]\`：补充；\`--then ask\` 继续追问（会话回到对方手里），\`--then done\` 收尾并标记完成
- \`${ctx.cli} handoff <threadId> --note "…"\`：交给我本人处理`
    : "";
  return `# AMO 中转：推进中需要别人确认时

我是 ${ctx.me}${ctx.role ? `（${ctx.role}）` : ""}。团队用「AMO 中转」在局域网里互相传话。推进中遇到需要别人确认的事（比如要程序确认实现方式、接口、工作量），不要停下来等我转述，你直接给对方发一个**会话**。对方在自己的面板上逐条回答，然后把会话返回给我这边，由你接着处理。

能找的人：
${people}

## 规则
- 会话在谁手里就由谁处理。你发出的会话，对方必须回复，不能直接关掉；结束由你这边来标记。
- 对方看不到我本机的文件和这段对话：背景、方案和关键片段都要写进正文。
- 每次新对话开始时，先用 \`relay_queue\` 看有没有返回给我、等你接着处理的会话。
- 工具提示「已由本人接手」时，就不要再动这个会话了。

## 有 MCP 工具（amo-relay）时
- \`relay_people\`：看能找的人和他们负责什么。
- \`relay_session_open\`：发会话。to 填对方名字；title 用一句话说清要确认什么；body 是 Markdown 正文，写背景、方案和要确认的点；questions 放要对方逐条回答的问题，可以带选项，一个问题只问一件事。发出后立刻返回 threadId，不会等回复。
- 先接着做不依赖答复的部分；确实没别的可做时，用 \`relay_session_wait\` 等对方返回（最多 10 分钟）。
- \`relay_session_get\`：取会话内容，包括逐条回答、补充说明和结论（同意 / 需要改 / 有疑问）；不带 threadId 时列出我的会话和它们的状态。
- 拿到回复后：
  - 还有要问的：\`relay_session_reply\`，then 填 "ask"，会话回到对方手里；
  - 已经问清楚：\`relay_session_reply\`，then 填 "done"，可以写一句收尾。然后按回复调整方案，再告诉我对方是怎么答的。
- 拿不准、需要我来决定时：\`relay_session_handoff\`，把会话交给我本人，附一句原因。
- \`relay_queue\`：待我这边处理的会话，包括返回给我的和别人发给我的。${cli}
`;
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
  const head = `### ${who(m)} · ${time(m.createdAt)} · #${m.seq}${m.kind === "request" ? " · 会话" : m.kind === "reply" ? " · 回复" : ""}`;
  const parts = [head];
  if (m.body) parts.push(m.body);
  if (m.kind === "request" && m.questions?.length) {
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
  }
  return parts.join("\n\n");
}

/** A thread and (some of) its messages as Markdown. */
export function threadAsText(thread: Thread, messages: Message[], requestMessage?: Message): string {
  const questions = (requestMessage ?? messages.find((m) => m.kind === "request"))?.questions ?? [];
  const r = thread.request;
  const head = r
    ? `## 会话：${thread.title}\n${r.from} → ${r.to} · ${sessionStateText(r)}${r.needsReply ? " · 需要回复" : ""} · threadId ${thread.id}`
    : thread.kind === "topic"
      ? `## 话题：${thread.title}\n${thread.members.join("、")} · threadId ${thread.id}`
      : `## 对话：${thread.members.join("、")}\nthreadId ${thread.id}`;
  return [head, ...messages.map((m) => messageAsText(m, questions))].join("\n\n");
}
