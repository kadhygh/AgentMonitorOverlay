import type { AgentState, CoworkAgent, CoworkDelivery } from "./shared.js";

// 协作's words (2026-11-23, plans/cowork.md「人输入时看到的 agent 状态」): an agent's state as a mark and a word, what an @
// does to it now, where a message of mine went; and finding the @-s in what is typed. No React: tested on their own.

/** ✓ ◐ ! ○ with the word: never by colour alone. */
export const STATE_MARK: Record<AgentState, string> = { idle: "✓", busy: "◐", owner: "!", offline: "○" };
export const STATE_WORD: Record<AgentState, string> = { idle: "待命", busy: "处理中", owner: "等主人", offline: "不在线" };

const hm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** 「上次在线 09:30」, or nothing when it never was. */
export const lastSeenText = (a: Pick<CoworkAgent, "lastSeen">) => (a.lastSeen ? `上次在线 ${hm(a.lastSeen)}` : "还没上过线");

/** The chip after an agent: 「◐ 处理中 · 前面 1 条」. */
export function agentChip(a: Pick<CoworkAgent, "state" | "queued" | "lastSeen">): string {
  const base = `${STATE_MARK[a.state]} ${STATE_WORD[a.state]}`;
  if (a.state === "busy" && a.queued) return `${base} · 前面 ${a.queued} 条`;
  if (a.state === "offline" && a.lastSeen) return `${base} · ${hm(a.lastSeen)}`;
  return base;
}

/** What an @ does to it now (one line under it in the @ list). */
export function agentWhat(a: Pick<CoworkAgent, "state" | "queued" | "lastSeen">): string {
  if (a.state === "idle") return "马上送进它的会话，开一轮";
  if (a.state === "busy") return a.queued ? `这一轮跑完再送，前面还有 ${a.queued} 条` : "这一轮跑完再送";
  if (a.state === "owner") return "主人正在和它说话；主人这边空下来再送";
  return `先存在服务上，它的 Studio 连上后送（${lastSeenText(a)}）`;
}

/** The line over the box once an agent is @-ed: where this message will go. */
export function agentRoute(a: Pick<CoworkAgent, "state" | "queued" | "lastSeen" | "name">): string {
  if (a.state === "idle") return `${a.name} 待命，你这句会马上送进它的会话`;
  if (a.state === "busy") return `${a.name} 正在处理${a.queued ? `（前面 ${a.queued} 条）` : ""}，你这句会在它这一轮之后送到`;
  if (a.state === "owner") return `${a.name} 在等主人，主人这边空下来后送到`;
  return `${a.name} 不在线（${lastSeenText(a)}），它的 Studio 连上后送到`;
}

/** The legend under the members (what each state means for an @). */
export const STATE_LEGEND: Array<[AgentState, string]> = [
  ["idle", "@ 它马上送到"],
  ["busy", "这一轮跑完再送，显示前面几条"],
  ["owner", "主人在和它说话，空下来再送"],
  ["offline", "主人的 Studio 没开，连上后送"],
];

/** A delivery's three steps, each done or not, with when. */
export function deliverySteps(d: Pick<CoworkDelivery, "state" | "createdAt" | "deliveredAt" | "repliedAt">): Array<{ label: string; done: boolean; at: number | null }> {
  return [
    { label: "排队中", done: true, at: d.createdAt },
    { label: "已送达", done: d.state === "delivered" || d.state === "replied", at: d.deliveredAt },
    { label: "已回复", done: d.state === "replied", at: d.repliedAt },
  ];
}

/** Where a delivery stands now, in a word: the step it is at. */
export const deliveryNow = (d: Pick<CoworkDelivery, "state">) => ({ queued: "排队中", delivered: "已送达", replied: "已回复", dropped: "没送到" })[d.state];

export interface MentionTarget {
  /** What is typed after @ (a person's name, an agent's 「X 的 AI · 会话名」). */
  text: string;
  kind: "person" | "agent";
  /** The account (person) or the mark (agent). */
  id: string;
}

/**
 * The @-s still in the text. Longer names first and taken out once found, so 「@程序老李 的 AI · 加特林」 is the agent and
 * not also the person 程序老李.
 */
export function mentionsIn(text: string, targets: MentionTarget[]): { mentions: string[]; agentMentions: string[] } {
  let rest = text;
  const mentions: string[] = [];
  const agentMentions: string[] = [];
  for (const t of [...targets].sort((a, b) => b.text.length - a.text.length)) {
    const at = `@${t.text}`;
    if (!rest.includes(at)) continue;
    rest = rest.split(at).join(" ");
    const list = t.kind === "agent" ? agentMentions : mentions;
    if (!list.includes(t.id)) list.push(t.id);
  }
  return { mentions, agentMentions };
}

/** An @ being typed just before the caret: where it starts and what follows it (null when there is none). */
export function atQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start < 0) return null;
  const query = before.slice(start + 1);
  if (query.length > 24 || /[\n@]/.test(query)) return null;
  // An @ in the middle of a word (an e-mail address) is not one.
  if (start > 0 && /[A-Za-z0-9._-]/.test(before[start - 1]!)) return null;
  return { start, query };
}

/** The candidates matching what follows the @ (by name, nickname or session name). */
export function matchTargets<T extends { text: string; also?: string }>(targets: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return targets;
  return targets.filter((t) => t.text.toLowerCase().includes(q) || !!t.also?.toLowerCase().includes(q));
}
