import { AGENT_STATE_LABEL, messageAsText, sessionStateText, type BoardItem, type BoardLock, type BoardOpsResult, type BoardRejectCode, type Cowork, type CoworkDraft, type CoworkEvent, type CoworkInboxItem, type CoworkPostResult, type CoworkAskResult, type Message, type RelayFile, type Thread, sizeText } from "@amo-studio/relay/light";

// 协作 (2026-11-23, plans/cowork.md): what the agent of a session in a 协作 reads — a delivery put into its conversation,
// and the answers of its cowork_* tools (cowork-mcp.ts). Plain Markdown in Chinese, as team_*'s.

const pad = (n: number) => String(n).padStart(2, "0");
const time = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Who wrote a message: a person, or an agent by its name in the 协作 (「程序老李 的 AI · 射速实现」). */
export function authorOf(m: Message, cowork: Pick<Cowork, "agents">): string {
  if (m.via.kind !== "ai") return m.author;
  const conv = m.via.conv;
  return cowork.agents.find((a) => a.mark === conv)?.name ?? `${m.author} 的 AI`;
}

/** Where a thread is in the 协作: 群聊, or 子会话「X」. */
export function whereOf(threadId: string, cowork: Pick<Cowork, "id" | "sessions">, title?: string): string {
  if (threadId === cowork.id) return "群聊";
  return `子会话「${title ?? cowork.sessions.find((s) => s.id === threadId)?.title ?? threadId}」`;
}

/** One message, headed by who wrote it (an agent by its name), when, where and its seq (for replyTo). */
export function coworkMessageText(m: Message, cowork: Pick<Cowork, "id" | "agents" | "sessions">, questions?: Message["questions"]): string {
  const extra = [m.replyTo ? `回 #${m.replyTo}` : "", m.agentMentions?.length ? `@ ${m.agentMentions.map((mark) => cowork.agents.find((a) => a.mark === mark)?.name ?? mark).join("、")}` : "", m.mentions?.length ? `@ ${m.mentions.join("、")}` : "", m.approvedBy ? `${m.approvedBy} 确认后发出${m.edited ? "（改过）" : ""}` : ""].filter(Boolean);
  const head = `### ${authorOf(m, cowork)} · ${whereOf(m.threadId, cowork)} · ${time(m.createdAt)} · #${m.seq}${extra.length ? ` · ${extra.join(" · ")}` : ""}`;
  if (m.kind === "event") return `> （${authorOf(m, cowork)} ${m.body} · ${whereOf(m.threadId, cowork)} · ${time(m.createdAt)} · #${m.seq}）`;
  // messageAsText's head says only 「X 的 AI（AMO Studio）」: the rest (questions, answers, notes) is its.
  return messageAsText(m, questions).replace(/^### [^\n]*/, head);
}

/**
 * How much of a 协作's talk an agent reads at a time (2026-11-23, 中转迭代讨论, the user: 「可以，按你的建议改」 — 协作里给 AI
 * 看的内容要精简). An @ came with only the messages @-ing it, but cowork_read gave 40 messages in full and a 子会话 all of
 * it: a long discussion filled the context. Now the messages for the agent are whole and the rest is cut, and past a
 * budget of characters (newest first) one line each; cowork_read's seq and before open the rest. No summaries: the goal,
 * 已定的事 and the 白板 are what a long discussion comes to. Numbers to tune here.
 */
export const COWORK_BRIEF = {
  /** With an @: this many messages before it in the same place, … */
  contextBefore: 3,
  /** … they and the message it answers cut to this many characters. */
  contextChars: 300,
  /** cowork_read: the new messages, at most this many characters (newest first). */
  readChars: 6000,
  /** cowork_read: others' messages cut to this many characters. */
  clipChars: 500,
  /** A 子会话 in full: after its opening question (always whole), at most this many characters. */
  sessionChars: 6000,
  /** Past the budget, at most this many one-line entries (older ones only counted). */
  lineMax: 30,
  /** A one-line entry: how its message starts, at most this many characters. */
  lineChars: 60,
};

/** A message cut to `max` characters after its head, saying where the rest is; whole when it is short (or an event). */
export function clippedMessageText(m: Message, cowork: Pick<Cowork, "id" | "agents" | "sessions">, max: number, questions?: Message["questions"]): string {
  const whole = coworkMessageText(m, cowork, questions);
  const nl = whole.indexOf("\n");
  if (m.kind === "event" || nl < 0) return whole;
  const rest = whole.slice(nl + 1);
  if (rest.length <= max) return whole;
  return `${whole.slice(0, nl)}\n${rest.slice(0, max).trimEnd()}…\n（截到 ${max} 字，全文看 #${m.seq}：cowork_read 带 seq ${m.seq}）`;
}

/** A message in one line: #seq, who, where, how it starts. */
export function messageLine(m: Message, cowork: Pick<Cowork, "id" | "agents" | "sessions">): string {
  const flat = m.body.replace(/\s+/g, " ").trim();
  const end = flat.search(/[。！？!?]/);
  let start = end >= 0 ? flat.slice(0, end + 1) : flat;
  if (start.length > COWORK_BRIEF.lineChars) start = `${start.slice(0, COWORK_BRIEF.lineChars)}…`;
  const what = m.kind === "event" ? `（${flat.slice(0, COWORK_BRIEF.lineChars)}）` : start || (m.answers?.length ? "（回答了提问）" : "（没有文字）");
  return `- #${m.seq} ${authorOf(m, cowork)} · ${whereOf(m.threadId, cowork)} · ${what}`;
}

/** How a message is shown: whole, cut (clippedMessageText), or one line. */
export type ShownAs = "full" | "clip" | "line";

/**
 * Which messages are shown how, within `budget` characters from the newest back: `whole` ones (for this agent) always
 * whole; the rest whole or cut while they fit (`clip`: cut to that many first — cowork_read; null: whole when it fits,
 * else cut to clipChars — a 子会话), and from the first that does not, one line each, at most lineMax of them (`dropped`
 * counts the older ones past that). Oldest first.
 */
export function pickByBudget(messages: Message[], o: { budget: number; whole: (m: Message) => boolean; clip: number | null; size: (m: Message, how: ShownAs) => number }): { shown: Array<{ m: Message; how: ShownAs }>; dropped: number } {
  const out: Array<{ m: Message; how: ShownAs }> = [];
  let used = 0;
  let over = false;
  let lines = 0;
  let dropped = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    let how: ShownAs | null = null;
    if (o.whole(m)) how = "full";
    else if (!over) {
      const tries: ShownAs[] = o.clip === null ? ["full", "clip"] : ["clip"];
      how = tries.find((t) => used + o.size(m, t) <= o.budget) ?? null;
      if (!how) over = true;
    }
    if (how) {
      used += o.size(m, how);
      out.push({ m, how });
    } else if (lines < COWORK_BRIEF.lineMax) {
      lines++;
      out.push({ m, how: "line" });
    } else dropped++;
  }
  return { shown: out.reverse(), dropped };
}

/** Shown messages as text: blocks apart, runs of one-line entries together. */
function shownText(shown: Array<{ how: ShownAs; text: string }>): string {
  const parts: string[] = [];
  let lineRun = false;
  for (const s of shown) {
    if (s.how === "line" && lineRun) parts[parts.length - 1] += `\n${s.text}`;
    else parts.push(s.text);
    lineRun = s.how === "line";
  }
  return parts.join("\n\n");
}

/** cowork_read's messages (the new ones, or those before a seq): within the budget, the agent's own whole. */
export function messagesSection(messages: Message[], cowork: Pick<Cowork, "id" | "agents" | "sessions">, forMe: (m: Message) => boolean): { text: string; full: Message[]; dropped: number; oldest: number | null } {
  const B = COWORK_BRIEF;
  const render = (m: Message, how: ShownAs) => (how === "full" ? coworkMessageText(m, cowork) : how === "clip" ? clippedMessageText(m, cowork, B.clipChars) : messageLine(m, cowork));
  const { shown, dropped } = pickByBudget(messages, { budget: B.readChars, whole: forMe, clip: B.clipChars, size: (m, how) => render(m, how).length });
  const text = shownText(shown.map((s) => ({ how: s.how, text: render(s.m, s.how) })));
  return { text, full: shown.filter((s) => s.how !== "line").map((s) => s.m), dropped, oldest: backFrom(shown, dropped) };
}

/**
 * Where paging back starts: past the oldest one-line entry when some were left out (they are older than it — an older
 * message of the agent's own may still be shown whole), else the oldest shown.
 */
function backFrom(shown: Array<{ m: Message; how: ShownAs }>, dropped: number): number | null {
  if (dropped) return shown.find((s) => s.how === "line")?.m.seq ?? null;
  return shown[0]?.m.seq ?? null;
}

/** Under one-line entries: how to open them. */
const LINES_HINT = "只列一行的，要看全文用 cowork_read 带 seq（#序号）。";

/** Past what is listed: how to page back (`dropped`: how many of these were left out, when known). */
function backHint(oldest: number, dropped: number, threadId?: string): string {
  return `更早的${dropped ? `还有 ${dropped} 条没列` : "还有"}：cowork_read 带 ${threadId ? `threadId ${threadId}、` : ""}before ${oldest} 往前翻。`;
}

/** What a delivery batch is about, for the row's head: 「程序老李 在群聊里 @ 了你」, 「美术小周 回复了你发起的子会话「X」」. */
export function deliveryWhere(items: CoworkInboxItem[]): string {
  const kinds = new Set(items.map((i) => `${i.delivery.reason} ${i.thread.id}`));
  if (kinds.size > 1) return `有 ${items.length} 条给你的消息`;
  const it = items[0]!;
  const where = it.thread.kind === "cowork" ? "群聊" : `子会话「${it.thread.title}」`;
  if (it.delivery.reason === "reply") return `回复了你发起的${where}`;
  return it.thread.kind === "cowork" ? "在群聊里 @ 了你" : `在${where}里 @ 了你`;
}

/** Of a delivery: who wrote them, people or agents (「程序老李」「程序老李 的 AI · 射速实现」). */
export function deliveryFrom(items: CoworkInboxItem[], cowork: Pick<Cowork, "agents">): string {
  return [...new Set(items.map((i) => authorOf(i.message, cowork)))].join("、");
}

/** The message a delivery batch puts into the session. */
export function deliveryText(input: { items: CoworkInboxItem[]; cowork: Cowork; me: string; myName: string; mark: string; unread: number; lines: string[]; context?: Message[] }): string {
  const { items, cowork, me, myName, unread } = input;
  const head = `【协作「${cowork.title}」· ${deliveryFrom(items, cowork)} ${deliveryWhere(items)}】`;
  // What it answers and what came just before it in the same place, cut (COWORK_BRIEF), oldest first; then the @s whole.
  const given = new Set(items.map((i) => i.message.id));
  const context = (input.context ?? []).filter((m) => !given.has(m.id));
  const before = context.length ? [`前文（每条截到 ${COWORK_BRIEF.contextChars} 字，全文用 cowork_read 带 seq）：`, ...context.map((m) => clippedMessageText(m, cowork, COWORK_BRIEF.contextChars)), "给你的："] : [];
  const blocks = [...before, ...items.map((i) => coworkMessageText(i.message, cowork))];
  const last = items[items.length - 1]!;
  const replyTo = items.length === 1 ? `，replyTo ${last.message.seq}` : "（replyTo 写你回的那条的 #）";
  const how = [
    `AMO Studio 从协作「${cowork.title}」转进来的（coworkId ${cowork.id}）。你在里面是「${myName}」，替 ${me} 说话；这个对话里和你说话的是 ${me} 本人。`,
    `要回：用 cowork_post（threadId ${last.thread.id}${replyTo}）回在协作里，不要只回在这个对话里——对方看不到这里。要看前后文、目标和已定的事用 cowork_read。不需要你回的就不回。`,
    unread > 0 ? `协作里另有 ${unread} 条没 @ 你的新消息，要看再用 cowork_read。` : "",
  ].filter(Boolean);
  return [head, ...input.lines, ...blocks, `（${how.join("")}）`].join("\n\n");
}

/** What the agent is told once, after it was brought in (with the person's next message or the first delivery). */
export function joinedLine(cowork: Pick<Cowork, "id" | "title" | "goal" | "repo" | "branch">, myName: string, me: string): string {
  const goal = cowork.goal.trim() ? `目标：${cowork.goal.trim().replace(/\s+/g, " ").slice(0, 200)}${cowork.goal.trim().length > 200 ? "…" : ""}` : "";
  const repo = cowork.repo ? `仓库 ${cowork.repo}${cowork.branch ? ` · 分支 ${cowork.branch}` : ""}。` : "";
  return `【协作】${me} 把这个会话拉进了协作「${cowork.title}」（coworkId ${cowork.id}），你在里面的名字是「${myName}」，可以替 ${me} 在里面回复、提问、写白板、记事件，不用每次再问。${repo}${goal} 有人 @ 你、或回复你发起的子会话时，Studio 会把它送进这个对话；别人聊天不会叫你。工具：cowork_read（看全貌、文件和新消息；讨论长了先看目标、已定的事和白板，需要时才带 seq / before 翻原文）、cowork_post（发言）、cowork_ask（开子会话问人）、cowork_conclude（给子会话定结论）、cowork_board（白板）、cowork_note（记事件：推了提交就记一条带提交号的）。项目里的正式内容照常写进分支的文档。`;
}

const STATE_TEXT: Record<"open" | "returned" | "done", string> = { open: "开着", returned: "回到发起人", done: "已定" };

/** cowork_read without a threadId: the 协作 as a whole, then the new messages. */
export function coworkOverview(input: { cowork: Cowork; events: CoworkEvent[]; drafts: CoworkDraft[]; mark: string; section: ReturnType<typeof messagesSection>; count: number; after: number; lastSeq: number; files?: CoworkFiles }): string {
  const { cowork: c, mark } = input;
  const me = c.agents.find((a) => a.mark === mark);
  const parts: string[] = [];
  parts.push(`# 协作「${c.title}」\ncoworkId ${c.id}${c.repo ? ` · 仓库 ${c.repo}` : ""}${c.branch ? ` · 分支 ${c.branch}` : ""}${c.endedAt ? " · **已结束**（不能再发言、改白板，等人重新打开）" : ""}\n你是「${me?.name ?? mark}」。「AI 发起 @ 和提问」${c.options.aiInitiate ? "开着：你 @ 人、开子会话直接发出" : "关着：你 @ 人或别的 AI、开子会话，会先存成草稿，等你的主人确认后才发出"}。`);
  parts.push(`## 目标\n${c.goal.trim() || "（还没写）"}`);
  const agents = c.agents.map((a) => `- ${a.name}（${AGENT_STATE_LABEL[a.state]}${a.queued ? `，排队 ${a.queued} 条` : ""}）· mark ${a.mark}${a.mark === mark ? " ← 你" : ""}`);
  parts.push(`## 成员\n人：${c.members.join("、")}\n${agents.length ? `AI（@ 它们用 agentMentions 写 mark）：\n${agents.join("\n")}` : "AI：没有"}`);
  const open = c.sessions.filter((s) => s.state !== "done");
  parts.push(`## 开着的子会话\n${open.length ? open.map((s) => `- 「${s.title}」 ${s.from} → ${s.to} · ${STATE_TEXT[s.state]}${s.waitingOn ? ` · 等 ${s.waitingOn}` : ""}${s.agent === mark ? " · 你发起的" : ""} · threadId ${s.id}`).join("\n") : "（没有）"}`);
  const decided = input.events.filter((e) => e.kind === "decision");
  const done = c.sessions.filter((s) => s.state === "done" && s.conclusion);
  const decisions = decided.length ? decided.map((e) => `- ${time(e.at)} ${e.actor}：${e.text}`) : done.map((s) => `- 「${s.title}」：${s.conclusion}`);
  parts.push(`## 已定的事\n${decisions.length ? decisions.join("\n") : "（还没有）"}`);
  const others = input.events.filter((e) => e.kind === "commit" || e.kind === "note").slice(-10);
  if (others.length) parts.push(`## 最近的事件\n${others.map((e) => `- ${time(e.at)} ${e.agent ? (c.agents.find((a) => a.mark === e.agent)?.name ?? e.actor) : e.actor}：${e.kind === "commit" ? `推了 ${e.data?.commit ?? ""} ` : ""}${e.text}${e.data?.files?.length ? `（${e.data.files.join("、")}）` : ""}`).join("\n")}`);
  const files = input.files ? coworkFilesText(input.files, c) : "";
  if (files) parts.push(files);
  const mine = input.drafts.filter((d) => d.agent === mark && d.state === "pending");
  if (mine.length) parts.push(`## 你的草稿（等 ${me?.owner ?? "主人"} 确认）\n${mine.map((d) => `- ${d.kind === "ask" ? `子会话「${d.ask?.title}」问 ${d.ask?.to}` : `发言：${oneLine(d.post?.body ?? "")}`}`).join("\n")}`);
  const B = COWORK_BRIEF;
  const head = `${input.after ? `## 新消息（#${input.after} 之后，${input.count} 条）` : `## 最近的消息（${input.count} 条）`}\n给你的（@ 你、回你的）是全文；别人的截到 ${B.clipChars} 字，从新往旧约 ${B.readChars} 字，再往前的只列一行。`;
  const s = input.section;
  const body = input.count ? s.text : "（没有新的）";
  const hint = `${s.full.length < input.count ? LINES_HINT : ""}${s.dropped && s.oldest ? backHint(s.oldest, s.dropped) : ""}`;
  parts.push(`${head}\n\n${body}\n\n（读到 #${input.lastSeq}。下次不带 after 只列这之后的。${hint}讨论长了先看上面的目标、已定的事和白板（cowork_board），需要时才翻原文。）`);
  return parts.join("\n\n");
}

/** cowork_read with seq: one message in full, where it is. */
export function oneMessageText(m: Message, cowork: Cowork): string {
  return `## 协作「${cowork.title}」的 #${m.seq}（在${whereOf(m.threadId, cowork)}${m.threadId === cowork.id ? "" : ` · threadId ${m.threadId}`}）\n\n${coworkMessageText(m, cowork)}${m.replyTo ? `\n\n（它回的是 #${m.replyTo}：要看用 cowork_read 带 seq ${m.replyTo}。）` : ""}`;
}

/** cowork_read with before: the messages before a seq (of a 子会话 with threadId), within the budget. */
export function beforeText(section: ReturnType<typeof messagesSection>, cowork: Cowork, before: number, count: number, more: boolean, threadId?: string): string {
  const where = threadId ? `${whereOf(threadId, cowork)}里 ` : "";
  if (!count) return `${where}#${before} 之前没有更早的消息了。`;
  const older = (more || section.dropped) && section.oldest ? backHint(section.oldest, section.dropped, threadId) : "再往前没有了。";
  return `## ${where}#${before} 之前的消息\n\n${section.text}\n\n（${section.full.length < count ? LINES_HINT : ""}${older}）`;
}

/** The files of a 协作's threads (群聊 first, then each 子会话), as listed for cowork_read. */
export type CoworkFiles = Array<{ threadId: string; files: RelayFile[] }>;

/**
 * cowork_read's 文件 (2026-11-23, 中转迭代讨论: 把协作里的文件列出来，包括群聊和子会话里的): each with the threadId and fileId
 * team_file_get takes (everyone in a 协作 is in its 群聊 and every 子会话, so team_file_get lets them have it).
 */
export function coworkFilesText(groups: CoworkFiles, cowork: Pick<Cowork, "id" | "sessions">, max = 40): string {
  const all = groups.flatMap((g) => g.files.map((f) => ({ g, f })));
  if (!all.length) return "";
  const shown = [...all].sort((a, b) => a.f.at - b.f.at).slice(-max);
  const line = ({ g, f }: { g: { threadId: string }; f: RelayFile }) => `- ${f.name} v${f.version} · ${f.type.split(";")[0]!.trim()} · ${sizeText(f.size)} · ${f.by} ${time(f.at)} 上传 · 在${whereOf(g.threadId, cowork)} · threadId ${g.threadId} · fileId ${f.id}`;
  return `## 文件（${all.length} 个${all.length > shown.length ? `，列了最近的 ${shown.length} 个` : ""}）\n用 team_file_get（threadId, fileId）存到本机，拿到完整路径后打开看。\n${shown.map(line).join("\n")}`;
}

/** What cowork_conclude did. */
export function concludedText(title: string, conclusion: string): string {
  return `子会话「${title}」定下结论：${conclusion}\n它关上了，结论记进了协作的「已定的事」，协作里的人和 AI 读协作时都看得到。照这个结论接着做；要改结论，在群聊里说，或者开一个新的子会话。`;
}

/**
 * cowork_read with a threadId: one 子会话 — its opening question always whole, then the rest from the newest back within
 * COWORK_BRIEF.sessionChars (whole when it fits, else cut), older ones one line each; the agent's own whole. Returns the
 * messages shown whole or cut (seen, for the queued deliveries).
 */
export function sessionText(thread: Thread, messages: Message[], cowork: Cowork, mark: string, forMe: (m: Message) => boolean = () => false): { text: string; seen: Message[] } {
  const B = COWORK_BRIEF;
  const s = cowork.sessions.find((x) => x.id === thread.id);
  const r = thread.request;
  const head = `## 子会话「${thread.title}」（协作「${cowork.title}」，${messages.length} 条）\n${r ? `${r.from} → ${r.to} · ${sessionStateText(r)}` : ""}${s?.agent === mark ? " · 你发起的" : ""}${s?.conclusion ? `\n结论：${s.conclusion}` : ""} · threadId ${thread.id}`;
  // The questions each answer is to (a later round's ask brings new ones).
  const asked = new Map<string, Message["questions"]>();
  let questions: Message["questions"] = messages.find((m) => m.kind === "request")?.questions ?? [];
  for (const m of messages) {
    if (m.questions?.length) questions = m.questions;
    asked.set(m.id, questions);
  }
  const opening = messages.find((m) => m.kind === "request") ?? messages[0];
  const render = (m: Message, how: ShownAs) => (how === "full" ? coworkMessageText(m, cowork, asked.get(m.id)) : how === "clip" ? clippedMessageText(m, cowork, B.clipChars, asked.get(m.id)) : messageLine(m, cowork));
  const rest = messages.filter((m) => m !== opening);
  const { shown, dropped } = pickByBudget(rest, { budget: B.sessionChars, whole: forMe, clip: null, size: (m, how) => render(m, how).length });
  const lines = shown.some((x) => x.how === "line");
  const oldest = backFrom(shown, dropped);
  const hint = `${lines ? LINES_HINT : ""}${dropped && oldest ? backHint(oldest, dropped, thread.id) : ""}`;
  const text = [head, ...(opening ? [render(opening, "full")] : []), ...(shown.length ? [shownText(shown.map((x) => ({ how: x.how, text: render(x.m, x.how) })))] : []), `（${hint}在这里说话：cowork_post 带这个 threadId。）`].join("\n\n");
  return { text, seen: [...(opening ? [opening] : []), ...shown.filter((x) => x.how !== "line").map((x) => x.m)] };
}

/** What cowork_post / cowork_ask did: out (and whom it woke) or kept as a draft for the owner. */
export function postResultText(out: CoworkPostResult | CoworkAskResult, owner: string, what: "post" | "ask"): string {
  if (out.draft) {
    return `没有发出去：「AI 发起 @ 和提问」在这个协作里关着，你${what === "ask" ? "开的子会话" : "这条带 @ 的发言"}存成了草稿（draft ${out.draft.id}），只有 ${owner} 看得到，等 ${owner} 在 AMO 中转里点「发出」「改一下再发」或「不发」。现在不要再发一遍，也不要当它已经发出去了；接着做不依赖它的事，或者结束这一轮。`;
  }
  if (what === "ask") return `子会话「${out.thread!.title}」已开（threadId ${out.thread!.id}），协作里的人都看得到、能插话。有人在里面回复时会送进这个对话。现在结束这一轮，不要接着按没确认的方向做。`;
  // The deliveries it made (the ones it answered come back too, moved to 已回复).
  const made = "deliveries" in out ? (out.deliveries ?? []).filter((d) => d.messageId === out.message!.id).length : 0;
  const woke = made ? `，送给了 ${made} 个 AI` : "";
  return `已发出（#${out.message!.seq}${woke}）。`;
}

/** The board for the agent: every card, with its version (send it back as base when changing a card's text). */
export function boardText(items: BoardItem[], locks: BoardLock[], seq: number, cowork: Pick<Cowork, "agents" | "sessions" | "id">): string {
  const live = items.filter((it) => !it.deleted);
  const deleted = items.length - live.length;
  if (!live.length) return `白板是空的（序号 ${seq}${deleted ? `，最近删除 ${deleted} 张` : ""}）。加卡：ops [{"op":"add","item":{"kind":"note","text":"…","x":0,"y":0}}]。`;
  const lockOf = new Map(locks.map((l) => [l.card, l.by]));
  const lines = live.map((it) => {
    const marks = [it.stale ? "已过时" : "", it.alt ? `! 有冲突（另一版是 ${it.alt.by} 的）` : "", lockOf.has(it.id) ? `${lockOf.get(it.id)} 正在写` : "", it.updatedAgent ? `${cowork.agents.find((a) => a.mark === it.updatedAgent)?.name ?? "AI"} 改过` : ""].filter(Boolean);
    const where = `(${Math.round(it.x)},${Math.round(it.y)} ${Math.round(it.w)}×${Math.round(it.h)})`;
    const what =
      it.kind === "link"
        ? `${it.from} → ${it.to}${it.text ? `「${oneLine(it.text)}」` : ""}`
        : it.kind === "session"
          ? `子会话「${cowork.sessions.find((s) => s.id === it.session)?.title ?? it.session}」${it.text ? `：${oneLine(it.text)}` : ""}`
          : it.kind === "ref"
            ? `${it.ref?.kind ?? "ref"} ${it.ref?.path ?? it.ref?.url ?? it.ref?.title ?? ""}${it.ref?.commit ? ` @ ${it.ref.commit}` : ""}${it.text ? `：${oneLine(it.text)}` : ""}`
            : `「${oneLine(it.text, 200)}」`;
    return `- [${it.kind}] ${it.id} · base ${it.textVersion} · ${where}${it.group ? ` · 组 ${it.group}` : ""}${it.color ? ` · ${it.color}` : ""} · ${what}${marks.length ? ` · ${marks.join(" · ")}` : ""}`;
  });
  return `白板（序号 ${seq}，${live.length} 张${deleted ? `，最近删除 ${deleted} 张` : ""}）：\n${lines.join("\n")}\n\n改一张卡的文字时带上它的 base（上面列的），别人在你读过之后改了字会被拒，先重新读。`;
}

const REJECT_HOW: Record<BoardRejectCode, string> = {
  locked: "有人正在写这张卡：不要覆盖。等一会儿再改，或者在旁边另放一张卡、连线指过去。",
  stale: "这张卡的文字在你读过之后被人改过：先不带 ops 调 cowork_board 重新读，按新的内容和 base 再改。",
  deleted: "这张卡已经删了：真要用先 restore。",
  missing: "没有这张卡（id 写错了？）：先重新读白板。",
  forbidden: "这一步不是你能做的（只能撤销自己的操作；冲突的版本由人挑）。",
  nothing: "没有可以撤销的了。",
  bad: "这条操作写得不对，照上面的说明改。",
  exists: "这个 id 已经有卡了：换一个，或者不写 id 让服务给。",
};

/** What a cowork_board call did. */
export function boardOpsText(out: BoardOpsResult): string {
  const parts = [`做了 ${out.applied.length} 条（白板序号 ${out.seq}）。`];
  const cards = new Map<string, BoardItem>();
  for (const r of out.applied) for (const it of r.items) cards.set(it.id, it);
  if (cards.size) parts.push(`卡片现在：\n${[...cards.values()].map((it) => `- ${it.id} [${it.kind}] base ${it.textVersion}${it.deleted ? " · 已删除" : ""}${it.alt ? " · 有冲突" : ""}`).join("\n")}`);
  if (out.rejected.length) parts.push(`没做的 ${out.rejected.length} 条：\n${out.rejected.map((r) => `- 第 ${r.index + 1} 条${r.opId ? `（${r.opId}）` : ""}：${r.message}${r.by ? `（${r.by}）` : ""}。${REJECT_HOW[r.code]}`).join("\n")}`);
  return parts.join("\n\n");
}

function oneLine(text: string, max = 80): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
