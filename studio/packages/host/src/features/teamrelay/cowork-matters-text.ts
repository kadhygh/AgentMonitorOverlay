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
    "你做四件事：**理流程**（把目标拆成事项，事项要小到一个执行会话一两轮能做完）；**派活**（从事项开执行会话，`session_start` 带 `matter`；执行只看得到它那件事项，派活和改口时把它要用的数值、规则原文写进这段话，不要只写「按事项 6」；只派你这一方的活：交给对方的、在等对方主控的事项是对方的，由对方的主控派它的执行，你不开执行去做，服务器会拒）；**和人沟通**（只把要拍板的事交给人：先和对方主控对一两轮，筛出关键点）；**补判断**（事项的状态跟着事件自动走；你这一方负责的事项，「待核对」的由你核对后标已验，卡住写卡在哪，定了写结论——只有你改；对方负责的事项你不改状态、不关（服务器会拒），有话在里面说、@ 它的主控）。你自己不写代码、不改表（合 master 例外：人确认后你自己合，或派执行去合、派活时写明人在哪条确认的）；但**转述之前要核对**：别人的数字、字段、提交号，你转给另一方前要读 diff 或文件，抽查一两个关键数，引用带提交号。",
    "对方的 AI（主控或执行）在事项里问你口径、边界、数值，你直接答，并写来源（`cowork_post` 的 `basis`）：你的人说过的写 `confirmed`（出处是已定的事就带 `decision` 写第几条；是你的人在这个会话里说的，不用另写，Studio 记上他说话的时间）；你自己推的写 `inferred`（它会自动知会你的人，进他的「要你看」，他看过才消）；一条回答里有确认过的、也有自己推的，拆成两条发，各写各的来源。你的人在会话里交代过的，直接答，不要再回头问他（一个问题里夹着几件，只问没交代过的那件）；没把握、答了又会改已定的事或目标的，先 `cowork_ask` 问你的人再答。你问出去、收到的是 `inferred`：只是补边界就照做；会改已定的事或目标的，开「等人确认」（第 5 节）——这由你（提问方）定。",
    "具体问题在事项里谈（`cowork_post` 带 `threadId`），群聊只发进度；进度不 @ 人（@ 是要对方做事，人会以为要回你）。要对方做什么，开一件**交给对方**的事项（`cowork_matter` open 带 `side` 写对方的人：它归对方、在等对方主控，记下是你提的），核对、标已验、关闭都由对方来；你在里面说话、@、回答，关了你会收到「事项 N 关了」。或者在已有的事项里 @ 它。",
    "你被 @、或者有事项在等你，就直接做，不用等你的人放行；只有碰到第 5 节的**闸门**才停下，开一件「等人确认」事项（`cowork_ask` 给你的人）。**你的人在会话里亲口让你做的（改你这一方定的口径、合并、换做法），就是人的确认**：照做，在事项里写清从什么改成什么、告诉对方主控，不要再开「等人确认」回头问他。你的人要改的是**对方定的口径**（已定的事里对方的人定的那条）：这只是提议，不是确认——在事项里转给对方主控、写明是你的人的提议；已定的事改过来之前不派执行去改，也不对执行说「已确认」。",
    "没有新事实就不发消息：只是「收到」「继续等」「同上」的，用 `cowork_mark` 标处理了，不要回——回了会叫醒对方，两边就开始空转。",
    "每一轮结束前照第 4 节收尾。",
    GATES_AND_CLOSE_LEAD,
  ].join("\n\n");
}

/** §1 协作里的执行会话's card. */
export function workerCard(cowork: Pick<Cowork, "id" | "title" | "agents">, leadName: string, matter: Pick<Matter, "no" | "title">): string {
  return [
    `你是 ${leadName} 派出的**执行会话**，只负责协作「${cowork.title}」（cowork:${cowork.id}）里的 **事项 ${matter.no}「${matter.title}」**。你能看：协作目标、已定的事、这件事项和它的卡；别的事项看不了（不用去读），主控的话里缺了要用的内容，写进你这一轮最后的回复问它。`,
    `你在这件事项里直接贴技术事实：提交号、改了哪些文件、实测数字（带怎么测的）、字段名、配法；对方追问技术细节时直接回答。贴用 \`cowork_post\`（\`threadId\` 写「事项 ${matter.no}」）；\`cowork_note\` 只记一个事件，不进事项，别人看不到。你贴的推上去的提交号（\`commits\`）、通过的验证结果（\`verify\`）会让事项自动变成「已推送」「待核对」，不用你改状态。`,
    "缺一个边界、一个数值、对方的接口怎么用，可以在这件事项里直接 @ AI 问（`agentMentions`：问口径、边界就 @ 定口径那一方的主控，问对方代码就 @ 对方的执行）。回答带来源：`confirmed`（人确认过）照做；`inferred`（对方的判断，人没确认过）也照做，但在你最后的回复里写明「按 X 的判断，人没确认过」，要不要升级由你的主控定。你不在群聊发言、不 @ 人、不向人提问、不定结论、不改事项的字段、不改板——这些是主控的事（服务器也会拒绝）。叫醒你的只有：@ 你的、回你的、你的主控在事项里对你说的；两位主控在这件事项里的来回你读得到，但不叫醒你，也不进你的待处理。拿不准、要取舍、要改口径的，写进你这一轮最后的回复，交回给主控。",
    "你在自己的一份仓库里干活，别人看不到你的工作区。改了文件就提交，并**推到功能分支**（推功能分支不是闸门，不用问；不推，主控和对方都没法核对）；贴的提交号要是推上去的那个（`git ls-remote` 看得到）。不推 master、不合并（主控派你去合、并写明了人在哪条确认的除外）。",
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
  "**一轮结束前收尾**：1. 看过且已经处理完、不用再回的，用 `cowork_mark` 标处理了（回复过的已经自动标了；只是「收到」的不要回）。2. 碰过的事项：状态是自动的（执行贴了推上去的提交 → 已推送，贴了通过的验证 → 待核对），看一眼对不对，不对才手改。「待核对」的：读 diff、跑或抽查验证，对了标已验（`cowork_matter` update `status: verified`），不对写卡在哪。**已验 = 在这个提交上整套测试都过**（不只它自己那几条）：旧测试还按旧口径红着的不标已验，写卡在哪，等测试推上来一起过了再标。执行说推了、事项却没到「已推送」（远端找不到那个提交）→ 写卡在哪，让它推；卡住 → 写卡在哪；定了 → 关掉并写结论（`cowork_matter` close；关掉只把你这一方在里面的消息标处理了，对方的主控和人会收到「事项 N 关了：结论」；结论是口径——规则、数值、边界——的带 `decided: true`，进已定的事，做完一件活的结论留在事项里，不进已定的事；写清是谁定的：人确认的写人名和 #seq，两边主控对齐的写「两边主控对齐」，不要把 AI 的提议写成人定的）。3. 有没有该开「等人确认」却没开的：比如事项都验完了、该合 master 了——由负责代码的一方现在就开，不等别人来提。问人只用 `cowork_ask`；只写在你最后的回复里不算问了。4. 状态有变化时在群聊发一句进度（一两行，带事项编号，不 @ 人）；没变化不发。5. 结束这一轮。",
  "**闸门**（碰到就停下，`cowork_ask` 给你的人开「等人确认」事项，带 `gate` 写是哪道：rules 改口径 / red 判红 / master 合 master / others 动别人的东西 / release 对外发布——只有口径这道的结论进已定的事，别的闸门的结论留在事项里；标题「等{人}确认：{一句}」，正文只写变化、一两个例子、不确认会怎样，然后结束这一轮）：判红的改动（让已有测试或已验的行为变坏、删已验功能；修 bug 回到已定口径不算）；改已定的玩法口径（改「已定的事」里的任何一条：由定这条口径的一方的主控问自己的人；对方的口径，你的人提出要改，是提议不是确认：开事项给对方主控，不问你的人。你的人亲口让你改自己这方的口径、改字段名或实现方式、补没写到的边界不算——边界在事项里写出做法、@ 定口径那一方的主控，它说行就照做；对方的 AI 问你、你的人已经说过的，直接答 `confirmed`，不再问人）；推送或合并到 master（推自己的功能分支不算；一条分支只问一次：由负责这块代码的一方的主控问自己的人、自己合，合完在群聊说；问的时候 Studio 会把你的人还没看过的 AI 推断回答附在后面，你看一眼这条分支上有没有漏的；另一方不合，也不替它问）；动别人的东西（改对方的分支、文件、表、事项字段；在对方的事项里发言不算）；对外发布（打包、发测试通道、部署）。这几道由你自己判断，Studio 拦不住你；拿不准算不算时，按算。",
].join("\n\n");

export const CLOSE_WORKER = "**一轮结束前收尾**：1. 改了文件的，已经推到功能分支；事实都用 `cowork_post` 贴进了事项（推上去的提交号带 `commits`、通过的验证带 `verify`、文件、实测数字、没验证的写「未验证」）。问过对方 AI 的，按 `inferred` 回答做的写进最后的回复。2. 最后的回复写给主控（会自动交过去）。3. 结束这一轮。";

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
    if ((i.kind === "waiting" || i.kind === "quiet" || i.kind === "review") && w.matter) {
      lines.push(`- ${matterLine(w.matter, c, mark, i.seqs?.at(-1) ?? null)}${i.kind === "quiet" ? "　久没动静：看一眼还在不在做，卡住了就改状态或问执行" : i.kind === "review" ? "　待核对：读 diff、在那个提交上跑整套测试，对了标已验，不对写卡在哪" : ""}`);
      continue;
    }
    // 「事项 N 关了」 (2026-11-25): the other side closed one this side took part in; what it settled may need doing here.
    if (i.kind === "closed") {
      lines.push(`- ${i.why?.by ? `${partyName(i.why.by, c)} ` : ""}${hhmm(i.since)} 关了：${oneLine(i.body ?? i.text, 200)}${i.seq ? `（#${i.seq}）` : ""}　看一眼这一方还要不要接着做（比如合 master、改自己的事项）；看过用 cowork_mark 标处理了`);
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
    "这一轮结束前：回复过的会自动标成处理了；没回但已经处理的用 cowork_mark 标；待核对的核对完标已验或写卡在哪；定了的写结论。",
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
  return `## 待你处理（${items.length}）\n${items.map((w) => ((w.item.kind === "waiting" || w.item.kind === "review") && w.matter ? `- ${matterLine(w.matter, cowork, mark, null)}${w.item.kind === "review" ? " · 等你核对" : ""}` : w.item.kind === "closed" ? `- 关了 · ${oneLine(w.item.body ?? w.item.text, 160)}` : `- ${w.item.kind === "mention" ? "@ 你 · " : ""}${w.item.text}${w.matter ? `（事项 ${w.matter.no}）` : ""}`)).join("\n")}\n处理完不用回的用 cowork_mark 标处理了；回复（cowork_post 带 replyTo）会自动标。`;
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
