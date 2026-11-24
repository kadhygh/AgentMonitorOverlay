import { AGENT_ROLE_LABEL, MATTER_STATUS_LABEL, matterGroup, matterLockText, parseMatterLockKey, parseParty, SETTLED_GROUP, SETTLED_GROUP_TITLE, type BoardLock, type AgentRole, type Cowork, type CoworkAgent, type Matter, type Message, type PendingItem } from "@amo-studio/relay/light";
import { authorOf, COWORK_BRIEF, coworkMessageText, clippedMessageText, whereOf } from "./cowork-text.js";

// 协作里 AI 怎么参与 (2026-11-24, plans/collab-agent-spec.md): the texts the spec fixes — the role cards (§1), the wake message
// (§2), what cowork_read shows of roles, 事项 and 待我处理 (§3), the line after a compaction (§6). The spec is the source:
// when it is reworded after the real-model acceptance, change these to match.

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const oneLine = (text: string, max = 80) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/** null: from before roles (an old service, or not known yet) — shown as 未分角色 like the service's `unassigned`. */
export type CoworkRole = AgentRole | null;

/** 「主控」「执行（事项 3）」「未分角色」. */
export function roleLabel(role: CoworkRole, matter?: Pick<Matter, "no"> | null): string {
  if (role === "worker") return `执行${matter ? `（事项 ${matter.no}）` : ""}`;
  return AGENT_ROLE_LABEL[role ?? "unassigned"];
}

/** A party as shown: a person by name, an agent by its name in the 协作. */
export function partyName(party: string, cowork: Pick<Cowork, "agents">): string {
  const p = parseParty(party);
  if (!p) return party;
  if (p.kind === "person") return p.name;
  return cowork.agents.find((a) => a.mark === p.mark)?.name ?? p.mark;
}

/** The 主控 of each side now in the 协作. */
export function leadsOf(cowork: Pick<Cowork, "agents">): CoworkAgent[] {
  return cowork.agents.filter((a) => a.role === "lead");
}

/** §1 协作主控's card. */
export function leadCard(cowork: Pick<Cowork, "id" | "title" | "agents" | "matters">, me: string): string {
  const others = leadsOf(cowork).filter((a) => a.owner !== me).map((a) => a.name);
  const workers = cowork.agents.filter((a) => a.owner === me && a.role === "worker").map((a) => {
    const m = cowork.matters?.find((x) => x.id === a.matter);
    return `${a.name}${m ? `（事项 ${m.no}）` : ""}`;
  });
  return [
    `你是「${me}」这一方在协作「${cowork.title}」里的**主控**（cowork:${cowork.id}）。另一方的主控是 ${others.length ? others.join("、") : "（还没有）"}；你这一方的执行会话：${workers.length ? workers.join("、") : "还没有"}。`,
    "你做四件事：**理流程**（把目标拆成事项，事项要小到一个执行会话一两轮能做完）；**派活**（从事项开执行会话，`session_start` 带 `matter`）；**和人沟通**（只把要拍板的事交给人：先和对方主控对一两轮，筛出关键点）；**改事项的状态**（你负责的事项只有你改）。你自己不写代码、不改表；但**转述之前要核对**：别人的数字、字段、提交号，你转给另一方前要读 diff 或文件，抽查一两个关键数，引用带提交号。",
    "具体问题在事项里谈（`cowork_post` 带 `threadId`），群聊只发进度和 @。要对方做什么，就开一件事项、把在等谁设成对方主控，或者在已有的事项里 @ 它。",
    "你被 @、或者有事项在等你，就直接做，不用等你的人放行；只有碰到第 5 节的**闸门**才停下，开一件「等人确认」事项（`cowork_ask` 给你的人）。**你的人在会话里亲口让你做的（改口径、合并、换做法），就是人的确认**：照做，在事项里写清从什么改成什么、告诉对方主控，不要再开「等人确认」回头问他。",
    "没有新事实就不发消息：只是「收到」「继续等」「同上」的，用 `cowork_mark` 标处理了，不要回——回了会叫醒对方，两边就开始空转。",
    "每一轮结束前照第 4 节收尾。",
    GATES_AND_CLOSE_LEAD,
  ].join("\n\n");
}

/** §1 协作里的执行会话's card. */
export function workerCard(cowork: Pick<Cowork, "id" | "title" | "agents">, leadName: string, matter: Pick<Matter, "no" | "title">): string {
  return [
    `你是 ${leadName} 派出的**执行会话**，只负责协作「${cowork.title}」（cowork:${cowork.id}）里的 **事项 ${matter.no}「${matter.title}」**。你能看：协作目标、已定的事、这件事项和它的卡。`,
    `你在这件事项里直接贴技术事实：提交号、改了哪些文件、实测数字（带怎么测的）、字段名、配法；对方追问技术细节时直接回答。贴用 \`cowork_post\`（\`threadId\` 写「事项 ${matter.no}」）；\`cowork_note\` 只记一个事件，不进事项，别人看不到。你不在群聊发言、不 @ 人、不向人提问、不定结论、不改事项的状态、不改板——这些是主控的事（服务器也会拒绝）。拿不准、要取舍、要改口径的，写进你这一轮最后的回复，交回给主控。`,
    "你在自己的一份仓库里干活，别人看不到你的工作区。改了文件就提交，并**推到功能分支**（推功能分支不是闸门，不用问；不推，主控和对方都没法核对）；贴的提交号要是推上去的那个（`git ls-remote` 看得到）。不推 master、不合并。",
    "你这一轮最后的回复会自动交给主控：写清做了什么、提交号、验证结果、没验证的写「未验证」。",
    CLOSE_WORKER,
  ].join("\n\n");
}

/** 未分角色 (joined before roles): works as before, until the person picks a role. */
export function unassignedCard(cowork: Pick<Cowork, "id" | "title">, me: string): string {
  return `你在协作「${cowork.title}」（cowork:${cowork.id}）里还没有分角色（拉进来时还没有角色这回事）：权限和以前一样，可以替 ${me} 在里面发言、开事项、改事项。${me} 可以在 Studio 里把你改成这一方的主控或某件事项的执行。在那之前照主控的做法来：具体问题进事项、群聊只发进度和 @、碰到闸门开「等人确认」、每一轮结束前收尾。\n\n${GATES_AND_CLOSE_LEAD}`;
}

/** §4 and §5, short: what the 主控 does at the end of a turn, and the gates. */
export const GATES_AND_CLOSE_LEAD = [
  "**一轮结束前收尾**：1. 看过且已经处理完、不用再回的，用 `cowork_mark` 标处理了（回复过的已经自动标了；只是「收到」的不要回）。2. 碰过的事项状态对不对：执行交回了结果 → 已推送 / 已验（核对过才改；它说的提交在远端找不到 → 不改状态，写卡在哪，让它推）；要对方做 → 等对方，在等谁写对方主控；卡住 → 写卡在哪；定了 → 关掉并写结论（`cowork_matter`）。3. 有没有该开「等人确认」却没开的。4. 状态有变化时在群聊发一句进度（一两行，带事项编号）；没变化不发。5. 结束这一轮。",
  "**闸门**（碰到就停下，`cowork_ask` 给你的人开「等人确认」事项，标题「等{人}确认：{一句}」，正文只写变化、一两个例子、不确认会怎样，然后结束这一轮）：判红的改动（让已有测试或已验的行为变坏、删已验功能；修 bug 回到已定口径不算）；改已定的玩法口径（改「已定的事」里的任何一条；你的人亲口让你改的、改字段名或实现方式、补没写到的边界不算——边界在事项里写出做法、@ 定口径那一方的主控）；推送或合并到 master（推自己的功能分支不算；由负责这块代码的一方的主控问自己的人、自己合）；动别人的东西（改对方的分支、文件、表、事项字段；在对方的事项里发言不算）；对外发布（打包、发测试通道、部署）。这几道由你自己判断，Studio 拦不住你；拿不准算不算时，按算。",
].join("\n\n");

export const CLOSE_WORKER = "**一轮结束前收尾**：1. 改了文件的，已经推到功能分支；事实都用 `cowork_post` 贴进了事项（推上去的提交号、文件、实测数字、没验证的写「未验证」）。2. 最后的回复写给主控（会自动交过去）。3. 结束这一轮。";

// §6 (said before the next message after a compaction) is core/cowork.ts COMPACTED_LINE.

/** Why the wake message comes now (§2). */
export type WakeWhy = { kind: "patrol"; at: number } | { kind: "manual"; at: number; by: string } | { kind: "mention"; who: string; seq: number } | { kind: "reply"; who: string; seq: number } | { kind: "result"; name: string };

function whyText(w: WakeWhy): string {
  switch (w.kind) {
    case "patrol":
      return `巡检 ${hhmm(w.at)} 发现有变化`;
    case "manual":
      return `${w.by} 让你现在看一遍`;
    case "mention":
      return `${w.who} @ 了你（#${w.seq}）`;
    case "reply":
      return `${w.who} 回复了你（#${w.seq}）`;
    case "result":
      return `你的执行会话「${w.name}」交回了结果`;
  }
}

/** One item of 待你处理, with what the wake shows of it: its message (whole for an @ or a reply to it), its 事项. */
export interface WakeItem {
  item: PendingItem;
  message?: Message | null;
  matter?: Matter | null;
  /** The message answers one of this agent's own. */
  repliesToMe?: boolean;
}

/** The 事项's line: 「事项 3「标题」· 等对方 · 在等 你　程序老李 10:42 改成等对方：…（#12）」. */
function matterLine(m: Matter, cowork: Pick<Cowork, "agents">, mark: string, seq: number | null): string {
  const waiting = m.waitingOn.map((p) => (p === `agent:${mark}` ? "你" : partyName(p, cowork)));
  const last = [...m.history].reverse().find((h) => h.to === m.status);
  const why = last ? `${partyName(last.by, cowork)} ${hhmm(last.at)} 改成「${MATTER_STATUS_LABEL[m.status]}」${last.note ? `：${oneLine(last.note, 60)}` : ""}` : "";
  return `事项 ${m.no}「${m.title}」· ${MATTER_STATUS_LABEL[m.status]}${waiting.length ? ` · 在等 ${waiting.join("、")}` : ""}${m.blocker ? ` · 卡在 ${oneLine(m.blocker, 60)}` : ""}${why ? `　${why}` : ""}${seq ? `（#${seq}）` : ""}`;
}

/**
 * §2 the wake message: why now, 待你处理 — an @ of it or a reply to it whole, a 事项 as one line (its talk with cowork_read
 * and threadId) — the 群聊's other new messages counted, and the end-of-turn reminder.
 */
export function wakeText(input: { cowork: Pick<Cowork, "id" | "title" | "agents" | "sessions" | "matters">; mark: string; why: WakeWhy; items: WakeItem[]; unread: number; context?: Message[] }): string {
  const { cowork: c, mark } = input;
  const lines: string[] = [];
  for (const w of input.items) {
    const i = w.item;
    // Who, when and why it became mine, as the service says it (PendingItem.why; the Host puts the name in front).
    const why = i.why ? `　${i.why.by ? `${partyName(i.why.by, c)} ` : ""}${hhmm(i.why.at)} ${i.why.text}` : "";
    if ((i.kind === "waiting" || i.kind === "quiet") && w.matter) {
      lines.push(`- ${matterLine(w.matter, c, mark, i.seqs?.at(-1) ?? null)}${i.kind === "quiet" ? "　久没动静：看一眼还在不在做，卡住了就改状态或问执行" : ""}`);
      continue;
    }
    const m = w.message;
    if (!m) {
      lines.push(`- ${i.text}${why}${i.body ? `：\n${indent(i.body)}` : ""}`);
      continue;
    }
    const where = m.threadId === c.id ? "群聊" : w.matter ? `事项 ${w.matter.no}` : whereOf(m.threadId, c);
    if (i.kind === "mention" || i.kind === "reply" || i.kind === "notice" || w.repliesToMe) {
      // How to answer, since the other side cannot see this conversation (the 2026-11-23 deliveries said so too).
      const how = `回：cowork_post${m.threadId === c.id ? "" : ` threadId「${w.matter ? `事项 ${w.matter.no}` : m.threadId}」`} replyTo ${m.seq}`;
      lines.push(`- #${m.seq} ${authorOf(m, c)} ${i.kind === "mention" ? "@ 你" : i.kind === "notice" ? "知会你" : "回你"}（在 ${where}；${how}）：\n${indent(coworkMessageText(m, c))}`);
    } else {
      lines.push(`- #${m.seq} ${authorOf(m, c)}（在 ${where}）：${oneLine(m.body, 160)}${w.matter ? `　要看事项里的来回用 cowork_read 带 threadId「事项 ${w.matter.no}」` : ""}`);
    }
  }
  const context = (input.context ?? []).filter((m) => !input.items.some((w) => w.message?.id === m.id));
  return [
    `【协作 · 待你处理】「${c.title}」（cowork:${c.id}）`,
    `为什么现在叫你：${whyText(input.why)}`,
    `待你处理（${input.items.length}）：`,
    ...lines,
    ...(context.length ? [`前文（每条截到 ${COWORK_BRIEF.contextChars} 字，全文用 cowork_read 带 seq）：`, ...context.map((m) => indent(clippedMessageText(m, c, COWORK_BRIEF.contextChars)))] : []),
    ...(input.unread > 0 ? [`另有 ${input.unread} 条群聊新消息没 @ 你，只是进度；要看用 cowork_read。`] : []),
    "这一轮结束前：回复过的会自动标成处理了；没回但已经处理的用 cowork_mark 标；改好你负责的事项状态。",
  ].join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}

/** cowork_read's 「我」 line and the sections a service with 事项 adds: 开着的事项, 待你处理. */
export function mattersSection(cowork: Pick<Cowork, "agents" | "matters">, mark: string, own: string | null): string {
  const open = (cowork.matters ?? []).filter((m) => m.status !== "closed" && (!own || m.id === own));
  if (!open.length) return `## 开着的事项\n（没有）`;
  return `## 开着的事项\n${open
    .sort((a, b) => a.no - b.no)
    .map((m) => `- ${matterLine(m, cowork, mark, null)} · 负责方 ${m.side}${m.dependsOn.length ? ` · 依赖 ${m.dependsOn.map((d) => `事项 ${cowork.matters?.find((x) => x.id === d)?.no ?? d}`).join("、")}` : ""}${m.gate ? " · 闸门" : ""} · threadId ${m.id}`)
    .join("\n")}`;
}

export function pendingSection(items: WakeItem[], cowork: Pick<Cowork, "agents">, mark: string): string {
  if (!items.length) return "## 待你处理\n（没有）";
  return `## 待你处理（${items.length}）\n${items.map((w) => (w.item.kind === "waiting" && w.matter ? `- ${matterLine(w.matter, cowork, mark, null)}` : `- ${w.item.kind === "mention" ? "@ 你 · " : ""}${w.item.text}${w.matter ? `（事项 ${w.matter.no}）` : ""}`)).join("\n")}\n处理完不用回的用 cowork_mark 标处理了；回复（cowork_post 带 replyTo）会自动标。`;
}

/**
 * cowork_board's 事项卡 (2026-11-25, 中转迭代讨论: the board the AI reads is the one people see): not stored on the board —
 * drawn from each 事项 — so listed from them: 编号, title, status, whom it waits on, its group, where a person dragged it
 * (or laid out by itself), and whether someone is dragging or editing it. Read-only to AIs. An 执行 sees its own only.
 */
export function matterCardsText(cowork: Pick<Cowork, "agents" | "matters">, locks: readonly BoardLock[], mark: string, own: string | null): string {
  const list = (cowork.matters ?? []).filter((m) => !own || m.id === own).sort((a, b) => a.no - b.no);
  if (!list.length) return "";
  const held = new Map<string, string[]>();
  for (const l of locks) {
    const k = parseMatterLockKey(l.card);
    if (k) held.set(k.matter, [...(held.get(k.matter) ?? []), matterLockText(k.kind, l.by)]);
  }
  const lines = list.map((m) => {
    const waiting = m.waitingOn.map((p) => (p === `agent:${mark}` ? "你" : partyName(p, cowork)));
    const group = matterGroup(m) === SETTLED_GROUP ? SETTLED_GROUP_TITLE : `${m.side} 这一方`;
    const where = m.place ? `位置 (${Math.round(m.place.x)},${Math.round(m.place.y)})，人拖过` : "自动排";
    return `- [事项] ${m.id} · 事项 ${m.no}「${m.title}」· ${MATTER_STATUS_LABEL[m.status]}${waiting.length ? ` · 在等 ${waiting.join("、")}` : ""} · 组「${group}」· ${where}${held.get(m.id)?.length ? ` · ${held.get(m.id)!.join("、")}` : ""}`;
  });
  return `事项卡（由事项算出：状态、在等谁跟着事项走；位置只有人能拖，你只能读，要改状态用 cowork_matter；连线的 from / to 可以写事项的 id）：\n${lines.join("\n")}`;
}

/** The 成员 section with roles. */
export function membersSection(cowork: Pick<Cowork, "members" | "agents" | "matters">, mark: string, stateLabel: (a: CoworkAgent) => string): string {
  const agents = cowork.agents.map((a) => {
    const m = a.role === "worker" ? cowork.matters?.find((x) => x.id === a.matter) : null;
    return `- ${a.name} · ${roleLabel(a.role ?? null, m)} · ${a.owner} 这一方（${stateLabel(a)}）· mark ${a.mark}${a.mark === mark ? " ← 你" : ""}`;
  });
  return `## 成员\n人：${cowork.members.join("、")}\n${agents.length ? `AI（@ 它们用 agentMentions，写名字或 mark 都行）：\n${agents.join("\n")}` : "AI：没有"}`;
}
