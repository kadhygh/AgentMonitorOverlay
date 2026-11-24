import { basisText, MATTER_STATUS_LABEL, matterQuiet, parseParty, personParty, type CoworkAgent, type CoworkSession, type Matter, type MatterStatus, type Message, type MessageBasis, type Party, type PendingItem } from "./shared.js";

// 事项 in the 中转 client (2026-11-25, plans/collab-framework.md「11-24」「看过原型后定的」; prototype
// studio/out/cowork-flow/board.html): how a 事项 reads — its state as a mark and a word, whose it is, whom it waits on and
// why — and what of it is mine to look at (「要你看」: 等你确认 / 叫你来看, and the 群聊's 知会). No React: tested alone.

/** ✓ ◐ ! ○ with the word (never by colour alone). */
export const MATTER_MARK: Record<MatterStatus, string> = { todo: "○", doing: "◐", waiting: "!", confirm: "!", pushed: "◐", review: "◐", verified: "✓", closed: "✓" };
export const MATTER_WORD: Record<MatterStatus, string> = MATTER_STATUS_LABEL;
/** The class a state is drawn with. */
export const MATTER_CLS: Record<MatterStatus, string> = { todo: "todo", doing: "doing", waiting: "wait", confirm: "confirm", pushed: "pushed", review: "pushed", verified: "done", closed: "done" };
export const matterChip = (s: MatterStatus) => `${MATTER_MARK[s]} ${MATTER_WORD[s]}`;

/**
 * A cowork's 事项. An older service has only 子会话: each is taken as the 事项 the new one would have made of it (open and
 * with the one asked → 等人确认, open otherwise → 在做, done or concluded → 关闭), numbered in the order they were made.
 */
export function mattersOf(c: { sessions: CoworkSession[]; matters?: Matter[] }): Matter[] {
  if (c.matters) return c.matters;
  return [...c.sessions]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((s, i): Matter => {
      const status: MatterStatus = s.state === "done" || s.conclusion ? "closed" : s.state === "open" && s.waitingOn === s.to ? "confirm" : "doing";
      const owner: Party = s.agent ? `agent:${s.agent}` : personParty(s.from);
      return {
        id: s.id,
        scope: "cowork",
        scopeId: "",
        no: i + 1,
        kind: "work",
        title: s.title,
        owner,
        side: s.from,
        lead: null,
        status,
        waitingOn: status === "confirm" ? [personParty(s.to)] : [],
        bindings: { sessions: [], tasks: [], commits: [] },
        blocker: null,
        dependsOn: [],
        gate: null,
        conclusion: s.conclusion,
        history: [{ at: s.createdAt, by: owner, from: null, to: status }],
        waitingWhy: null,
        lastEventAt: s.updatedAt,
        limited: false,
        place: null,
        placeVersion: 0,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        version: 0,
      };
    });
}

export const matterLabel = (m: Pick<Matter, "no">) => `事项 ${m.no}`;

/** How an agent is called on a card: 「小王的主控」 for a 主控, its session's name for an 执行, 「X 的 AI」 otherwise. */
export function agentShort(a: Pick<CoworkAgent, "owner" | "label" | "role" | "name"> | null, show: (n: string) => string): string {
  if (!a) return "AI";
  if (a.role === "lead") return `${show(a.owner)}的主控`;
  if (a.role === "worker") return a.label;
  return a.name;
}

/** A participant in words (a person by name, an agent as agentShort). */
export function partyText(p: string, agents: CoworkAgent[], show: (n: string) => string): string {
  const w = parseParty(p);
  if (!w) return p;
  if (w.kind === "person") return show(w.name);
  return agentShort(agents.find((a) => a.mark === w.mark) ?? null, show);
}

/** 「负责 小王的主控」: its side's 主控, or the side's person while it has none in. */
export function sideText(m: Pick<Matter, "side" | "lead">, agents: CoworkAgent[], show: (n: string) => string): string {
  const lead = (m.lead && agents.find((a) => a.mark === m.lead)) || agents.find((a) => a.owner === m.side && a.role === "lead");
  return lead ? `${show(m.side)}的主控` : show(m.side);
}

/** Since when it is in the state it is in, and the word given for it (the last change into it). */
export function sinceState(m: Pick<Matter, "status" | "history" | "updatedAt">): { at: number; note: string | null; by: Party | null } {
  const h = [...m.history].reverse().find((x) => x.to === m.status);
  return { at: h?.at ?? m.updatedAt, note: h?.note ?? null, by: h?.by ?? null };
}

/** 在做 with nothing happening for 2 hours: 「久没动静」 on its card (the service's rule, matterQuiet). */
export const isQuiet = (m: Pick<Matter, "status" | "updatedAt"> & { lastEventAt?: number }, now: number) => matterQuiet({ status: m.status, lastEventAt: m.lastEventAt ?? m.updatedAt }, now);

// ---- what is mine to look at (「要你看」)

/** 等你确认: a 事项 waits on me as a 闸门 (等人确认); 叫你来看: it waits on me otherwise, or something in it is to me. */
export type LookKind = "confirm" | "look";
export const LOOK_WORD: Record<LookKind, string> = { confirm: "等你确认", look: "叫你来看" };

export type LookItem =
  /** `why`: the service's sentence for the latest of its items (「等你确认」「@ 了你」…). */
  | { kind: "matter"; look: LookKind; matter: Matter; since: number; seqs: number[]; why: string | null }
  /**
   * 群聊里的知会: a 群聊 message to me not dealt with yet — an @ or a reply (「看过了」 marks it 处理了) or one marked 知会
   * (「看过了」 marks it 看过, which is all a 知会 asks, the service 2026-11-25). `text`: the whole message when the service sends it.
   * Also, one row each (2026-11-25, 「v6 之后定的」): an AI's answer in a 事项 that was its own judgement (「! 我的判断」), and
   * 「事项 N 关了」 when the other side closed one I took part in — `matter` and `where` say which.
   */
  | { kind: "notice"; seq: number; since: number; text: string; mark: "seen" | "handled"; why: string | null; word: string; where: string; matter?: string };

/** What a 群聊 row of 「要你看」 is, in a word. */
export const NOTICE_WORD: Partial<Record<PendingItem["kind"], string>> = { notice: "知会", mention: "@ 你", reply: "回你", message: "给你", closed: "关了" };
/** The word for an AI's answer that was its own judgement, 知会'd to me (pendingFor's why starts with 「!」). */
export const JUDGED_WORD = "! 我的判断";

/** My 待我处理 as the 「要你看」 list: one row per 事项 (its own and its messages' items together), then the 群聊's 知会. */
export function lookItems(items: readonly PendingItem[], matters: readonly Matter[]): LookItem[] {
  const byId = new Map(matters.map((m) => [m.id, m]));
  const per = new Map<string, Extract<LookItem, { kind: "matter" }>>();
  const notices: LookItem[] = [];
  for (const i of items) {
    const why = i.why?.text ?? null;
    if (!i.matter) {
      if (i.seq !== null) notices.push({ kind: "notice", seq: i.seq, since: i.since, text: i.body ?? i.text.replace(/^#\d+\s*/, ""), mark: i.kind === "notice" ? "seen" : "handled", why, word: NOTICE_WORD[i.kind] ?? "叫你", where: "群聊" });
      continue;
    }
    // 「事项 N 关了」 and a 知会 in a 事项 (an AI's answer of its own judgement): a row each, 看过了 is all they ask.
    if ((i.kind === "closed" || i.kind === "notice") && i.seq !== null) {
      const judged = i.kind === "notice" && !!why?.startsWith("!");
      notices.push({ kind: "notice", seq: i.seq, since: i.since, text: i.body ?? i.text.replace(/^#\d+\s*/, ""), mark: "seen", why, word: judged ? JUDGED_WORD : (NOTICE_WORD[i.kind] ?? "叫你"), where: i.matterNo ? `事项 ${i.matterNo}` : "事项", matter: i.matter });
      continue;
    }
    const m = byId.get(i.matter);
    if (!m || m.status === "closed") continue;
    const row = per.get(m.id) ?? { kind: "matter" as const, look: "look" as LookKind, matter: m, since: i.since, seqs: [], why };
    if (i.kind === "waiting" && m.status === "confirm") row.look = "confirm";
    if (i.seq !== null && !row.seqs.includes(i.seq)) row.seqs.push(i.seq);
    if (i.since >= row.since) row.why = why ?? row.why;
    row.since = Math.max(row.since, i.since);
    per.set(m.id, row);
  }
  const rows = [...per.values()].sort((a, b) => (a.look === b.look ? b.since - a.since : a.look === "confirm" ? -1 : 1));
  return [...rows, ...notices.sort((a, b) => b.since - a.since)];
}

/** The 事项 that wait on me (for the board's thick outline and 「要我看的」), with which kind. */
export function myLooks(items: readonly LookItem[]): Map<string, LookKind> {
  const out = new Map<string, LookKind>();
  for (const i of items) if (i.kind === "matter") out.set(i.matter.id, i.look);
  return out;
}

/** The seqs of messages that are mine to mark 处理了 (in 待我处理 with a message). */
export const pendingSeqs = (items: readonly PendingItem[]) => new Set(items.filter((i) => i.seq !== null).map((i) => i.seq!));

/** Waits on someone other than me (the board's 「在等别人的」). */
export const waitsOnOthers = (m: Pick<Matter, "waitingOn" | "status">, me: string) => m.status !== "closed" && m.waitingOn.length > 0 && !m.waitingOn.includes(personParty(me));

// ---- a 闸门's question, as the drawer shows it

export interface ConfirmParts {
  change: string | null;
  example: string | null;
  ifNot: string | null;
  source: string | null;
  /** What is left of the text besides those. */
  rest: string;
}

const PART_KEYS: Array<[keyof Omit<ConfirmParts, "rest">, RegExp]> = [
  ["change", /^(?:变化|改动|改什么)$/],
  ["example", /^(?:例子|举例|例如)$/],
  ["ifNot", /^(?:不确认会怎样|不确认会怎么样|如果不确认)$/],
  ["source", /^(?:来源|依据)$/],
];

/**
 * A 闸门's text in its parts (the agents write 变化 / 例子 / 不确认会怎样, plans/collab-agent-spec.md 第 5 节): a line
 * starting with one of them as 「变化：…」, 「**变化**：…」 or a heading 「## 变化」 starts that part. null when none is there
 * (the drawer then shows the text as it is).
 */
export function confirmParts(body: string): ConfirmParts | null {
  const out: ConfirmParts = { change: null, example: null, ifNot: null, source: null, rest: "" };
  let cur: keyof Omit<ConfirmParts, "rest"> | null = null;
  const rest: string[] = [];
  let found = false;
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*(?:#{1,4}\s*)?(?:[-*]\s*)?(?:\*\*)?([^：:*#\n]{1,8})(?:\*\*)?\s*(?:[：:]\s*(.*)|$)/.exec(line);
    const key = m ? PART_KEYS.find(([, re]) => re.test(m[1]!.trim()))?.[0] : undefined;
    if (m && key && (m[2] !== undefined || /^\s*#/.test(line))) {
      cur = key;
      found = true;
      out[key] = (m[2] ?? "").trim();
      continue;
    }
    if (cur) out[cur] = `${out[cur] ? `${out[cur]}\n` : ""}${line}`.trim();
    else rest.push(line);
  }
  if (!found) return null;
  out.rest = rest.join("\n").trim();
  return out;
}

// ---- messages

/** Where an AI's answer comes from (2026-11-25, the user: AIs answer each other with a basis): confirmed with someone, or
 * its own judgement (「我的判断」), with its line (basisText: 「我的判断，小王没确认过」「已和小王确认（11-25 10:30）」). */
export function basisOf(m: Pick<Message, "basis">, show: (n: string) => string = (n) => n): (MessageBasis & { text: string }) | null {
  const b = m.basis;
  if (!b || (b.kind !== "confirmed" && b.kind !== "inferred")) return null;
  return { ...b, text: basisText(b, show) };
}

/** 知会 (2026-11-25, 放法 A): a message the people named only need to have seen. */
export function noticeOf(m: Pick<Message, "notice">): string[] | null {
  const n = m.notice;
  return Array.isArray(n) && n.length ? n.filter((x): x is string => typeof x === "string").map((x) => (x.startsWith("person:") ? x.slice(7) : x)) : null;
}

/** How many messages in a 事项 are an AI's own judgement (「用了 N 条『我的判断』」 on its card). */
export const inferredCount = (messages: readonly Message[]) => messages.filter((m) => !m.withdrawnAt && basisOf(m)?.kind === "inferred").length;

/** The 事项's open ones and whom they wait on, for the line over the 群聊 (「开着的事 · 等谁确认」). */
export function openLine(matters: readonly Matter[]): Matter[] {
  return matters.filter((m) => m.status !== "closed" && m.status !== "verified").sort((a, b) => (a.status === "confirm" ? 0 : 1) - (b.status === "confirm" ? 0 : 1) || a.no - b.no);
}
