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
- \`${ctx.cli} ask --json <文件>\`：发请求。文件内容是 JSON：{"to":"名字","title":"…","body":"Markdown 正文","questions":[{"text":"…","options":["…"]}]}；用 \`-\` 代替文件名时从标准输入读
- \`${ctx.cli} replies [threadId]\`：看回复（不带 id 时列出我发出的请求）
- \`${ctx.cli} wait <threadId> [--minutes N]\`：等对方回复，最多 10 分钟
- \`${ctx.cli} send <threadId> --body "…"\`：在这个请求里追问或补充`
    : "";
  return `# AMO 中转：推进中需要别人确认时

我是 ${ctx.me}${ctx.role ? `（${ctx.role}）` : ""}。团队用「AMO 中转」在局域网里互相传话。推进中遇到需要别人确认的事（比如要程序确认实现方式、接口、工作量），不要停下来等我转述，你直接给对方发一条请求。对方会在自己的面板上逐条回答。

能找的人：
${people}

## 有 MCP 工具（amo-relay）时
- \`relay_people\`：看能找的人和他们负责什么。
- \`relay_ask\`：发请求。to 填对方名字；title 用一句话说清要确认什么；body 是 Markdown 正文，写背景、方案和要确认的点。**对方看不到我本机的文件和这段对话**，关键的文档片段、数据要直接贴进 body。questions 放要对方逐条回答的问题，可以带选项，一个问题只问一件事。
- 请求发出后会立刻返回。先接着做不依赖答复的部分，之后用 \`relay_replies\` 取回复（threadId 用 relay_ask 返回的那个）；确实没别的可做时，用 \`relay_wait\` 等一会儿。
- \`relay_send\`：在同一个请求里追问或补充。
- 回复里有逐条回答、补充说明和结论（同意 / 需要改 / 有疑问）。按回复调整方案，再告诉我对方是怎么答的。${cli}
`;
}

const time = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const who = (m: Message) => (m.via.kind === "ai" ? `${m.author} 的 AI${m.via.client ? `（${m.via.client}）` : ""}` : m.author);

/** One message as Markdown; a reply's answers carry their questions, so the reader needs nothing else. */
export function messageAsText(m: Message, questions: Message["questions"] = []): string {
  const head = `### ${who(m)} · ${time(m.createdAt)} · #${m.seq}${m.kind === "request" ? " · 请求" : m.kind === "reply" ? " · 回复" : ""}`;
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
    ? `## 请求：${thread.title}\n${r.from} → ${r.to} · ${r.status === "answered" ? `已回复${r.verdict ? `（${VERDICT_LABEL[r.verdict]}）` : ""}` : "等回复"} · threadId ${thread.id}`
    : thread.kind === "topic"
      ? `## 话题：${thread.title}\n${thread.members.join("、")} · threadId ${thread.id}`
      : `## 对话：${thread.members.join("、")}\nthreadId ${thread.id}`;
  return [head, ...messages.map((m) => messageAsText(m, questions))].join("\n\n");
}
