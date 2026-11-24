// 事项、消息回执、角色和「待我处理」(2026-11-24, plans/collab-framework.md「11-24：完整的交流架构，先在协作里打通」): the
// fields the 中转 service's 协作 (packages/relay, cowork.ts) and Studio's Host (its local 事项 table, later) both keep, and
// the rules both apply the same way — who a message goes to, what an 执行 may do, what is in someone's 待我处理. No
// imports: the relay service bundles this file alone (`@amo-studio/protocol/matters`).
//
// The user 11-24: all exchange lands on a 事项; AMO records who saw and who handled each message, and finds by itself who
// has something unhandled (the Host's patrol, every PATROL_MS) instead of relying on an AI remembering to look.
//
// - 事项 (Matter): one thing being worked through, in a 协作 (scope "cowork": its 子会话 IS the 事项 — the thread's id is the
//   事项's id, one to one) or in a task (scope "task", the Host's own table). Numbered per scope from 1, shown 「事项 1」;
//   messages are numbered apart, shown 「#7」 (the user 11-24).
// - Messages: those of the 群聊 (no 事项) and those of a 事项. Each has, per recipient, a receipt: 排队 → 送到 → 看过 → 处理了,
//   each with its time. 看过 is recorded by itself (a person opens it, an agent's tool reads it); 处理了 is marked (a
//   person clicks, an agent calls the tool or marks it with its reply); closing a 事项 marks all of its messages 处理了.
// - Who gets a message (recipients): see messageRecipients.
// - Roles: an agent in a 协作 is its side's 主控 (one per side) or an 执行 bound to one 事项; see roleAllows.
// - 待我处理: see pendingFor.

// ---- who

/**
 * A participant: a person (`person:<account name>`) or an agent (`agent:<its mark>`, e.g. `agent:studio:d_1:s-2`).
 * One string so lists compare as strings; personParty / agentParty / parseParty build and read it. In a task's 事项 (the
 * Host's table) the person is the logged-in account, or `person:me` when there is none.
 */
export type Party = `person:${string}` | `agent:${string}`;

export const personParty = (name: string): Party => `person:${name}`;
export const agentParty = (mark: string): Party => `agent:${mark}`;
export function parseParty(p: string): { kind: "person"; name: string } | { kind: "agent"; mark: string } | null {
  if (p.startsWith("person:") && p.length > 7) return { kind: "person", name: p.slice(7) };
  if (p.startsWith("agent:") && p.length > 6) return { kind: "agent", mark: p.slice(6) };
  return null;
}
export const isParty = (p: unknown): p is Party => typeof p === "string" && parseParty(p) !== null;

// ---- roles

/** lead 主控: runs its side's flow, hands out work, talks to its person, changes 事项; worker 执行: opened by a 主控 from one
 * 事项, works in that one only (the user 11-24). */
export type AgentRole = "lead" | "worker";
export const AGENT_ROLE_LABEL: Record<AgentRole, string> = { lead: "主控", worker: "执行" };

/** An agent's place in a 协作: its role, its side (the person who brought it in) and, for an 执行, its 事项. */
export interface AgentRoleInfo {
  role: AgentRole;
  /** The account whose side it is on (its owner). */
  side: string;
  /** An 执行's 事项 (id); null for a 主控. */
  matter: string | null;
}

/**
 * What a participant does in a 协作, for roleAllows. The service refuses an 执行's chat posts, @ of people, conclusions
 * and 事项 changes (the user 11-24: it only puts technical facts into its own 事项; 状态由主控改).
 */
export type CollabAction =
  /** Read the goal, 已定的事, its 事项 and that 事项's card: everyone. */
  | "read-own"
  /** Read the rest: the 群聊, other 事项, the whole board. */
  | "read-all"
  | "chat-post"
  /** Post in a 事项 (MatterActionContext.matter). */
  | "matter-post"
  | "mention-person"
  | "mention-agent"
  | "matter-open"
  /** Change a 事项's fields (status, waiting on, blocker, conclusion, bindings…) or conclude it. */
  | "matter-edit"
  | "conclude"
  | "board-write"
  | "mark";

/** Whether an agent of this role may do it; `matter`: the 事项 it acts in (for matter-post). A person may do everything. */
export function roleAllows(role: AgentRole, action: CollabAction, ctx: { own: string | null; matter?: string | null } = { own: null }): boolean {
  if (role === "lead") return true;
  switch (action) {
    case "read-own":
    case "mark":
      return true;
    case "matter-post":
      return !!ctx.own && ctx.matter === ctx.own;
    case "mention-agent":
      // Only inside its own 事项 (it may ask its 主控 there): the post itself is checked as matter-post.
      return !!ctx.own && ctx.matter === ctx.own;
    default:
      return false;
  }
}

/** The service's answer to a second 主控 for a side (the user 11-24: 一个协作里每方一个). */
export function leadTakenText(side: string, holder: string): string {
  return `${side} 这一方已经有主控：${holder}。先把它改成执行或请出协作，再拉新的主控。`;
}

// ---- 事项

/** 范围: a 协作's (on the 中转 service) or a task's (the Host's own table). */
export type MatterScope = "cowork" | "task";

/** 待开始 / 在做 / 等对方 / 等人确认 / 已推送 / 已验 / 关闭 (the user 11-24). */
export type MatterStatus = "todo" | "doing" | "waiting" | "confirm" | "pushed" | "verified" | "closed";
export const MATTER_STATUSES: readonly MatterStatus[] = ["todo", "doing", "waiting", "confirm", "pushed", "verified", "closed"];
export const MATTER_STATUS_LABEL: Record<MatterStatus, string> = { todo: "待开始", doing: "在做", waiting: "等对方", confirm: "等人确认", pushed: "已推送", verified: "已验", closed: "关闭" };

/**
 * work: a piece of work (the default); confirm: a 闸门 — a 主控 asks a person to confirm before it goes on (status
 * "confirm", `gate` says which); delegate / notice: what a 主控's 传话 to another task becomes (step 4, the Host's table:
 * 委派 waits for the result, 通知 only informs).
 */
export type MatterKind = "work" | "confirm" | "delegate" | "notice";

/**
 * 闸门 (the user 11-24, in place of 「等主人」 and 「AI 发起 @ 和提问」): before one of these a 主控 opens a 「等人确认」 事项;
 * otherwise it goes on. Written into the agents' instructions and judged by the AI itself — Studio cannot stop it, and
 * the person is told so. Pushing to one's own feature branch is not a gate; merging into master is.
 */
export type GateKind = "red" | "rules" | "master" | "others" | "release";
export const GATE_LABEL: Record<GateKind, string> = {
  red: "判红的改动",
  rules: "改已定的玩法口径",
  master: "推送或合并到 master",
  others: "动别人的东西",
  release: "对外发布",
};
/** For the agents' instructions (role card, cowork tools). */
export const GATE_RULES_TEXT =
  "闸门：碰到这五种先开一件「等人确认」的事项（写清改什么、为什么、带例子），等那个人确认再做：判红的改动；改已定的玩法口径；推送或合并到 master（推到自己的功能分支不算）；动别人的东西；对外发布。其他时候直接做。";

/** What a 事项 is bound to (each may be several): 执行会话 (marks), AMO tasks (ids), commits. */
export interface MatterBindings {
  sessions: string[];
  tasks: string[];
  commits: string[];
}

/** One status change: who, when, from what to what (from null: it was opened). */
export interface MatterChange {
  at: number;
  by: Party;
  from: MatterStatus | null;
  to: MatterStatus;
  /** A word on why (e.g. 「关闭：结论已定」). */
  note?: string;
}

export interface Matter {
  /** In a 协作: its 子会话's thread id. In a task: the Host's own. */
  id: string;
  scope: MatterScope;
  /** The 协作's id, or the task's. */
  scopeId: string;
  /** 「事项 <no>」: per scope, from 1. */
  no: number;
  kind: MatterKind;
  title: string;
  /** 主人: who opened it. */
  owner: Party;
  /** 负责方: the side (account) whose 主控 carries it — in a 协作, the board's group it sits in. */
  side: string;
  /** That side's 主控 (its mark), null while the side has none in. */
  lead: string | null;
  status: MatterStatus;
  /** 在等谁: people or agents (empty when nobody is waited for). */
  waitingOn: Party[];
  bindings: MatterBindings;
  /** 卡在哪: one sentence, null when nothing blocks. */
  blocker: string | null;
  /** 依赖: other 事项 (ids, same scope) that must be done first. */
  dependsOn: string[];
  /** A 闸门 事项's kind of gate. */
  gate: GateKind | null;
  /** 结论: what was settled (in a 协作 it also goes into 已定的事). */
  conclusion: string | null;
  history: MatterChange[];
  createdAt: number;
  updatedAt: number;
  /** Goes up with every change (fields or status): the board's 事项卡 and a patch's `base` read it. */
  version: number;
}

/** A 事项 counts as settled — its card moves to the board's 「已定 / 已验」 group — once it has a conclusion, is verified or
 * closed. */
export const matterSettled = (m: Pick<Matter, "status" | "conclusion">): boolean => m.status === "verified" || m.status === "closed" || m.conclusion !== null;
/** The board's group for settled 事项 (one per 协作, beside one group per side). */
export const SETTLED_GROUP_TITLE = "已定 / 已验";

/** 子会话 from before 事项 (migration): open or returned → 在做; done or concluded → 关闭. */
export function statusFromSession(state: "open" | "returned" | "done", conclusion: string | null): MatterStatus {
  return state === "done" || conclusion ? "closed" : "doing";
}

/** Open a 事项: a 主控 or a person (an 执行 may not). The first message goes in as its first message. */
export interface NewMatter {
  title: string;
  kind?: MatterKind;
  /** The first message (Markdown): what it is, what is wanted. */
  body: string;
  /** Default: the opener's side (an agent's owner). */
  side?: string;
  /** Default "todo"; a 闸门 is "confirm". */
  status?: MatterStatus;
  waitingOn?: Party[];
  gate?: GateKind;
  dependsOn?: string[];
  blocker?: string;
}

/**
 * Change a 事项 (主控 or person). Only what is given changes; `status` adds a MatterChange; `base`: the version it was read
 * at — a change based on an older one is refused (`stale`) so two 主控 do not overwrite each other unseen. `bind` /
 * `unbind` add or take out bindings. Closing marks all of its messages 处理了 for everyone.
 */
export interface MatterPatch {
  base?: number;
  title?: string;
  status?: MatterStatus;
  /** Why the status changed (kept in the history). */
  note?: string;
  side?: string;
  waitingOn?: Party[];
  blocker?: string | null;
  dependsOn?: string[];
  gate?: GateKind | null;
  conclusion?: string | null;
  bind?: Partial<MatterBindings>;
  unbind?: Partial<MatterBindings>;
}

export const MATTER_LIMITS = { title: 200, blocker: 500, conclusion: 4_000, waitingOn: 20, dependsOn: 50, bindings: 50 };

// ---- messages: receipts and marks

/** queued 排队 (not delivered yet: an agent busy in a turn, Studio offline) → delivered 送到 → seen 看过 → handled 处理了. */
export type ReceiptState = "queued" | "delivered" | "seen" | "handled";
export const RECEIPT_STATE_LABEL: Record<ReceiptState, string> = { queued: "排队", delivered: "送到", seen: "看过", handled: "处理了" };
const RECEIPT_ORDER: Record<ReceiptState, number> = { queued: 0, delivered: 1, seen: 2, handled: 3 };

/** One recipient's receipt for one message: its state and when it reached each step (a later step implies the earlier). */
export interface Receipt {
  party: Party;
  state: ReceiptState;
  queuedAt: number;
  deliveredAt: number | null;
  seenAt: number | null;
  handledAt: number | null;
  /** handled by closing the 事项 (not marked by the recipient). */
  byClose?: boolean;
}

/** Move a receipt forward (never back): to `state` at `at`, filling earlier steps it skipped. */
export function advanceReceipt(r: Receipt, state: ReceiptState, at: number, byClose = false): Receipt {
  if (RECEIPT_ORDER[state] <= RECEIPT_ORDER[r.state]) return r;
  const next: Receipt = { ...r, state };
  if (RECEIPT_ORDER[state] >= 1 && next.deliveredAt === null) next.deliveredAt = at;
  if (RECEIPT_ORDER[state] >= 2 && next.seenAt === null) next.seenAt = at;
  if (state === "handled") {
    next.handledAt = at;
    if (byClose) next.byClose = true;
  }
  return next;
}

/** What one's own message shows (the user 11-24: only on my messages, one line, 「2 看过 · 1 处理了」, hover for each). */
export function receiptSummary(receipts: readonly Receipt[]): { queued: number; delivered: number; seen: number; handled: number; text: string } {
  const n = { queued: 0, delivered: 0, seen: 0, handled: 0 };
  for (const r of receipts) n[r.state]++;
  // 看过 counts those who saw it and have not marked it 处理了 yet; together they are everyone past 送到.
  const parts: string[] = [];
  if (n.queued) parts.push(`${n.queued} 排队`);
  if (n.delivered) parts.push(`${n.delivered} 送到`);
  if (n.seen) parts.push(`${n.seen} 看过`);
  if (n.handled) parts.push(`${n.handled} 处理了`);
  return { ...n, text: parts.join(" · ") };
}

/** 撤回 and 原地改 only while no recipient has seen it (the user 11-24); after that, a new message marks it 被 #x 取代. */
export const canRewrite = (receipts: readonly Receipt[]): boolean => receipts.every((r) => r.seenAt === null);

/** The agents that had seen a message when it was superseded: the Host tells them again (「#12 被 #15 取代」). */
export const seenByAgents = (receipts: readonly Receipt[]): string[] => receipts.filter((r) => r.seenAt !== null && r.party.startsWith("agent:")).map((r) => r.party.slice(6));

/** What a message carries besides its text (the 中转's Message and the Host's local one add these). */
export interface MatterMessageFields {
  /** The 事项 it is in (id); null/missing in the 群聊. */
  matter?: string | null;
  /** The message it answers (#seq). */
  replyTo?: number;
  /** One per recipient (author not included). */
  receipts?: Receipt[];
  /** 撤回 (before anyone saw it): when; the message stays in its place as 「已撤回」, without its text. */
  withdrawnAt?: number;
  /** 原地改 (before anyone saw it): shown 「改过」. */
  editedAt?: number;
  /** 被 #x 取代: the seq of the message that replaces it. */
  supersededBy?: number;
}

/** Mark messages 看过 / 处理了 (POST …/marks): by seq, or every message of a 事项 up to `upTo`. */
export interface MarkRequest {
  mark: "seen" | "handled";
  seqs?: number[];
  matter?: string;
  upTo?: number;
}

/** 原地改: a new text (refused once someone saw it — then post a new one with `supersedes`). */
export interface MessageRewrite {
  body: string;
}

/** What superseding answers: the new message and the agents that had seen the old one (the Host reminds them). */
export interface SupersedeResult {
  seq: number;
  supersededBy: number;
  seenByAgents: string[];
}

// ---- who gets a message

export interface RecipientInput {
  author: Party;
  /** The 协作's people (accounts), in it now. */
  people: readonly string[];
  /** The 主控 now in it, by side (account → mark). */
  leads: Readonly<Record<string, string>>;
  /** The 事项 it is in; missing: the 群聊. */
  matter?: Pick<Matter, "side" | "lead" | "owner" | "status" | "waitingOn" | "bindings"> | null;
  /** Those who wrote in this 事项 before (they take part in it). */
  posters?: readonly Party[];
  /** Whom the message @-s (people and agents). */
  mentions?: readonly Party[];
}

/**
 * Who a message goes to (the user 11-24, after the prototype), the author never included:
 * - 群聊: the people in the 协作 and every 主控.
 * - A 事项: the 主控 concerned — its 负责方's, its owner when a 主控, the 主控 of each side it waits on (a person waited on
 *   brings in their side's 主控) and of each side that wrote in it — and its 执行会话. People are not recipients of a
 *   事项's messages, except while it is 「等人确认」: then the people it waits on are.
 * - Anyone @-ed (person or agent in the 协作) is a recipient as well.
 */
export function messageRecipients(input: RecipientInput): Party[] {
  const out = new Set<Party>();
  const leadOf = (side: string) => input.leads[side];
  const sideOf = (p: Party): string | null => {
    const w = parseParty(p);
    if (!w) return null;
    if (w.kind === "person") return w.name;
    for (const [side, mark] of Object.entries(input.leads)) if (mark === w.mark) return side;
    return null;
  };
  const addLeadOf = (side: string | null) => {
    const l = side === null ? undefined : leadOf(side);
    if (l) out.add(agentParty(l));
  };
  const m = input.matter;
  if (!m) {
    for (const p of input.people) out.add(personParty(p));
    for (const l of Object.values(input.leads)) out.add(agentParty(l));
  } else {
    if (m.lead) out.add(agentParty(m.lead));
    addLeadOf(m.side);
    const owner = parseParty(m.owner);
    if (owner?.kind === "agent" && Object.values(input.leads).includes(owner.mark)) out.add(m.owner);
    for (const w of m.waitingOn) {
      const who = parseParty(w);
      if (!who) continue;
      if (who.kind === "agent") out.add(w);
      else {
        addLeadOf(who.name);
        if (m.status === "confirm") out.add(w);
      }
    }
    for (const p of input.posters ?? []) {
      const who = parseParty(p);
      if (who?.kind === "agent" && Object.values(input.leads).includes(who.mark)) out.add(p);
      else addLeadOf(sideOf(p));
    }
    for (const s of m.bindings.sessions) out.add(agentParty(s));
  }
  for (const p of input.mentions ?? []) out.add(p);
  out.delete(input.author);
  return [...out];
}

// ---- 待我处理

/** mention: a message @-s me; waiting: a 事项 waits on me; message: a 事项's message to me. Each until I mark it 处理了
 * (or the 事项 closes). The 群聊's messages without @ are only unread, never 待我处理. */
export type PendingKind = "mention" | "waiting" | "message";

export interface PendingItem {
  kind: PendingKind;
  scope: MatterScope;
  scopeId: string;
  /** The 事项 (id), null for an @ in the 群聊. */
  matter: string | null;
  /** The message (#seq), null for a 事项 waiting on me. */
  seq: number | null;
  /** When it became mine (the message's time, or when the 事项 started waiting on me). */
  since: number;
  /** One line for the list: the 事项's 「事项 3 · 标题」 or the message's opening. */
  text: string;
}

/** A participant's list: GET /api/pending (the service, one 协作 or all mine) and the Host's patrol read it the same way. */
export interface PendingList {
  party: Party;
  items: PendingItem[];
  /** The service's: goes up whenever this list's content changes (pendingKey changed), so a caller compares one number. */
  version: number;
}

/** The Host's patrol (the user 11-24: 每 2 分钟, wakes a 主控 only when its list changed, with only what changed). */
export const PATROL_MS = 2 * 60_000;

/** The minimum pendingFor needs of a message. */
export interface PendingMessage extends MatterMessageFields {
  seq: number;
  author: Party;
  mentions?: readonly Party[];
  body: string;
  createdAt: number;
}

const oneLine = (t: string, max = 80) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** A participant's 待我处理, newest first: what pendingFor's rules (PendingKind) find in these 事项 and messages. */
export function pendingFor(party: Party, scope: MatterScope, scopeId: string, matters: readonly Matter[], messages: readonly PendingMessage[]): PendingItem[] {
  const byId = new Map(matters.map((m) => [m.id, m]));
  const items: PendingItem[] = [];
  for (const m of matters) {
    if (m.status === "closed" || !m.waitingOn.includes(party)) continue;
    const since = [...m.history].reverse().find((h) => h.to === m.status)?.at ?? m.updatedAt;
    items.push({ kind: "waiting", scope, scopeId, matter: m.id, seq: null, since, text: `事项 ${m.no} · ${oneLine(m.title)}` });
  }
  for (const msg of messages) {
    if (msg.author === party || msg.withdrawnAt !== undefined || msg.supersededBy !== undefined) continue;
    const r = msg.receipts?.find((x) => x.party === party);
    if (!r || r.state === "handled") continue;
    const matter = msg.matter ? byId.get(msg.matter) : undefined;
    if (msg.matter && (!matter || matter.status === "closed")) continue;
    const mentioned = !!msg.mentions?.includes(party);
    if (!mentioned && !msg.matter) continue;
    items.push({ kind: mentioned ? "mention" : "message", scope, scopeId, matter: msg.matter ?? null, seq: msg.seq, since: msg.createdAt, text: `#${msg.seq} ${oneLine(msg.body)}` });
  }
  return items.sort((a, b) => b.since - a.since);
}

/** An item's identity across two reads. */
export const pendingItemKey = (i: PendingItem): string => `${i.kind}:${i.scope}:${i.scopeId}:${i.matter ?? ""}:${i.seq ?? ""}`;

/** A list's content as one number (FNV-1a over the sorted item keys): the service bumps `version` when it changes. */
export function pendingKey(items: readonly PendingItem[]): number {
  let h = 0x811c9dc5;
  for (const k of items.map(pendingItemKey).sort()) {
    for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 0x01000193) >>> 0;
    h = Math.imul(h ^ 10, 0x01000193) >>> 0;
  }
  return h;
}

/** What is new in `after` since `before` (the patrol wakes a 主控 with only these) and what went away. */
export function pendingDiff(before: readonly PendingItem[], after: readonly PendingItem[]): { added: PendingItem[]; gone: PendingItem[] } {
  const was = new Set(before.map(pendingItemKey));
  const now = new Set(after.map(pendingItemKey));
  return { added: after.filter((i) => !was.has(pendingItemKey(i))), gone: before.filter((i) => !now.has(pendingItemKey(i))) };
}
