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
 * 事项, works in that one only (the user 11-24). unassigned 未分角色 (2026-11-25, plans/collab-framework.md 「已有的协作、新旧版本混用」):
 * an agent brought in before roles, or by an older Studio that does not send one — it may do what it did before (what a
 * 主控 may, several on a side), is not its side's 主控 for deliveries and 待我处理, and stays so until a person picks one. */
export type AgentRole = "lead" | "worker" | "unassigned";
export const AGENT_ROLE_LABEL: Record<AgentRole, string> = { lead: "主控", worker: "执行", unassigned: "未分角色" };

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
  if (role !== "worker") return true;
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

/**
 * 待开始 / 在做 / 等对方 / 等人确认 / 已推送 / 待核对 / 已验 / 关闭 (the user 11-24; 待核对 11-25: an 执行 posted a passing
 * verification, its 主控 checks it and marks 已验). Worked out from the 事项's events (applyMatterEvent), not set by hand —
 * a hand change is one more event.
 */
export type MatterStatus = "todo" | "doing" | "waiting" | "confirm" | "pushed" | "review" | "verified" | "closed";
export const MATTER_STATUSES: readonly MatterStatus[] = ["todo", "doing", "waiting", "confirm", "pushed", "review", "verified", "closed"];
export const MATTER_STATUS_LABEL: Record<MatterStatus, string> = { todo: "待开始", doing: "在做", waiting: "等对方", confirm: "等人确认", pushed: "已推送", review: "待核对", verified: "已验", closed: "关闭" };

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
  /** The event that moved it (MatterEventKind) and its message (#seq), if any. */
  event?: MatterEventKind;
  seq?: number | null;
  /** 手改: set by hand (PATCH status), not worked out from what happened. */
  manual?: true;
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
  /** Why it waits on whom it waits on (MatterState.waitingWhy); null when it waits on nobody. */
  waitingWhy: MatterWaitingWhy | null;
  /** When something last happened in it (any event): 「久没动静」 is counted from here (matterQuiet). */
  lastEventAt: number;
  /** Its AIs went back and forth AGENT_ROUNDS_MAX times with no person in between: 等人确认, its AIs are not woken. */
  limited: boolean;
  /** Where a person dragged its card on the 协作's board (the only board state a 事项 has, 2026-11-25); null: laid out by
   * the client (by side, 「已定 / 已验」 once settled). */
  place: { x: number; y: number } | null;
  /** Goes up each time `place` is written (2026-11-25): a drop sends the one it read as `placeBase`; an older one is
   * refused and the card goes back to where it is now. Apart from `version`, so a drag and a status change do not collide. */
  placeVersion: number;
  createdAt: number;
  updatedAt: number;
  /** Goes up when its status, who it waits on or a field changes (not with every message): a patch's `base` reads it. */
  version: number;
}

/** A 事项 counts as settled — the board draws its card in 「已定 / 已验」 — once it has a conclusion, is verified or closed. */
export const matterSettled = (m: Pick<Matter, "status" | "conclusion">): boolean => m.status === "verified" || m.status === "closed" || m.conclusion !== null;
/** The board's group for settled 事项 (one per 协作, beside one group per side). */
export const SETTLED_GROUP_TITLE = "已定 / 已验";
/**
 * The board's group a 事项卡 is drawn in (2026-11-25: 事项卡 are not stored on the board; the client lays them out from the
 * 事项): its side's (the account), or SETTLED_GROUP for a settled one. `place` (a person dragged it) overrides where.
 */
export const SETTLED_GROUP = "*settled";
export const matterGroup = (m: Pick<Matter, "status" | "conclusion" | "side">): string => (matterSettled(m) ? SETTLED_GROUP : m.side);

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
 * Change a 事项 (主控 or person). Only what is given changes. `status` / `waitingOn` are a hand change (a "manual" event,
 * 手改 in the history; later events go on moving it); `conclusion` closes it (a "conclude" event). `base`: the version it
 * was read at — a change based on an older one is refused (`stale`) so two 主控 do not overwrite each other unseen. `bind`
 * / `unbind` add or take out bindings. Closing marks all of its messages 处理了 for everyone. `place`: a person dragged its
 * card (null: back to where the client lays it out); agents may not.
 */
export interface MatterPatch {
  base?: number;
  title?: string;
  status?: MatterStatus;
  place?: { x: number; y: number } | null;
  /** The `placeVersion` the drag started from; older → 409 with the 事项 as it is now. */
  placeBase?: number;
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

// ---- a 事项's events, and its status worked out from them
//
// The user 11-25 (「有更稳定的架构吗」): a 主控 forgets to move a status, so the status follows from what happened in the
// 事项 and the 主控 only adds what takes judgement (已验 after checking, a blocker, closing with a conclusion). Each thing
// that happens is a MatterEvent; applyMatterEvent folds one into the state, deriveMatter folds them all — the service
// keeps the state as it goes, a client can work it out again from the events (GET …/matters/:id/events). A hand change
// (PATCH status / waitingOn) is one more event ("manual", 手改 in the history): it wins at that moment, and later events
// move the status on from there.

/**
 * open 开了; say 发言 (nothing asked of anyone); address @ 或回复 (waits on whom it names until they say something there);
 * answer 确认回复 (a person answering what they were asked to confirm); bind 绑了执行会话; push 推送 (commits); verify 验证结果
 * (passed or not); ask 确认请求 (cowork_ask: waits on that person); limit AI 来回到上限; conclude 结论 (closes it); manual 手改.
 */
export type MatterEventKind = "open" | "say" | "address" | "answer" | "bind" | "push" | "verify" | "ask" | "limit" | "conclude" | "manual";
export const MATTER_EVENT_LABEL: Record<MatterEventKind, string> = {
  open: "开了",
  say: "发言",
  address: "@ 或回复",
  answer: "确认回复",
  bind: "绑了执行会话",
  push: "推送",
  verify: "验证结果",
  ask: "确认请求",
  limit: "AI 来回到上限",
  conclude: "结论",
  manual: "手改",
};

export interface MatterEvent {
  kind: MatterEventKind;
  at: number;
  by: Party;
  /** The message it came with (#seq). */
  seq?: number | null;
  /** address / ask / limit: whom it waits on; manual: 在等谁 set by hand (missing: unchanged). */
  to?: Party[];
  /** push: the commits. */
  commits?: string[];
  /** verify: whether it passed. */
  passed?: boolean;
  /** open: the status it starts in (default todo); manual: the status set. */
  status?: MatterStatus;
  /** conclude: what was settled. */
  conclusion?: string | null;
  note?: string;
}

/** Why a 事项 waits on someone: address (they were @-ed or replied to and have not answered), ask (asked to confirm),
 * limit (its AIs went back and forth too long), manual (set by hand). */
export type MatterWaitReason = "address" | "ask" | "limit" | "manual";
export interface MatterWaitingWhy {
  reason: MatterWaitReason;
  by: Party;
  at: number;
  seq: number | null;
}

/** One thing asked of someone in the 事项 and not answered yet: it waits on `to` (those still owing an answer). */
export interface MatterOpenAsk extends MatterWaitingWhy {
  to: Party[];
  /** The status it puts the 事项 in while it is the latest: waiting 等对方 or confirm 等人确认. */
  status: "waiting" | "confirm";
}

/** What the events add up to. */
export interface MatterState {
  status: MatterStatus;
  waitingOn: Party[];
  waitingWhy: MatterWaitingWhy | null;
  /** Asked and not answered, oldest first: 在等谁 is the latest one's. */
  asks: MatterOpenAsk[];
  history: MatterChange[];
  lastEventAt: number;
  limited: boolean;
  commits: string[];
  conclusion: string | null;
}

/** 「久没动静」: 在做 with no event for this long — it goes into its 主控's 待我处理 (the user 11-25: 先定 2 小时). */
export const MATTER_QUIET_MS = 2 * 60 * 60_000;
export const matterQuiet = (m: Pick<Matter, "status" | "lastEventAt">, now: number): boolean => m.status === "doing" && now - m.lastEventAt >= MATTER_QUIET_MS;

/** Two AIs in one 事项 with no person in between: after this many of their messages it stops (the service's
 * AGENT_STREAK_MAX, the user 11-24 「来回 30 轮」). */
export const AGENT_ROUNDS_MAX = 30;

const WORKING: ReadonlySet<MatterStatus> = new Set(["todo", "doing", "waiting", "confirm"]);

/** Fold one event into a 事项's state (null: nothing yet — the first event should be "open"). Pure; never changes `s`. */
export function applyMatterEvent(s: MatterState | null, e: MatterEvent): MatterState {
  const prev: MatterState = s ?? { status: "todo", waitingOn: [], waitingWhy: null, asks: [], history: [], lastEventAt: e.at, limited: false, commits: [], conclusion: null };
  const next: MatterState = { ...prev, asks: prev.asks.map((a) => ({ ...a, to: [...a.to] })), history: prev.history, commits: prev.commits, lastEventAt: e.at };
  let status = prev.status;
  let manual = false;
  const person = e.by.startsWith("person:");
  // Whoever says something in it has answered what was asked of them there.
  const answered = () => {
    next.asks = next.asks.map((a) => ({ ...a, to: a.to.filter((p) => p !== e.by) })).filter((a) => a.to.length > 0);
  };
  const ask = (reason: MatterWaitReason, to: Party[], st: "waiting" | "confirm") => {
    const who = to.filter((p) => p !== e.by);
    if (who.length) next.asks.push({ reason, by: e.by, at: e.at, seq: e.seq ?? null, to: who, status: st });
  };
  // While it is being worked on, the latest open ask says what it waits for; nothing open: 在做.
  const working = () => {
    const last = next.asks.at(-1);
    return last ? last.status : "doing";
  };
  switch (e.kind) {
    case "open":
      status = e.status ?? "todo";
      next.asks = [];
      if (e.to?.length) ask(status === "confirm" ? "ask" : "address", e.to, status === "confirm" ? "confirm" : "waiting");
      if (next.asks.length && WORKING.has(status)) status = working();
      break;
    case "say":
    case "address":
    case "answer":
      if (prev.status === "closed") break;
      answered();
      if (person && next.limited) {
        next.limited = false;
        next.asks = next.asks.filter((a) => a.reason !== "limit");
      }
      if (e.kind === "address" && e.to?.length) ask("address", e.to, "waiting");
      if (WORKING.has(prev.status)) status = working();
      break;
    case "bind":
      if (prev.status === "todo") status = working();
      break;
    case "ask":
      if (prev.status === "closed") break;
      ask("ask", e.to ?? [], "confirm");
      status = working();
      break;
    case "limit":
      if (prev.status === "closed") break;
      next.limited = true;
      ask("limit", e.to ?? [], "confirm");
      status = working();
      break;
    case "push":
      next.commits = [...new Set([...prev.commits, ...(e.commits ?? [])])];
      // A person's confirmation still pending stays in front: the push does not answer it.
      if (prev.status !== "closed" && prev.status !== "confirm") status = "pushed";
      break;
    case "verify":
      if (prev.status !== "closed" && prev.status !== "confirm") status = e.passed ? "review" : "doing";
      break;
    case "conclude":
      status = "closed";
      next.asks = [];
      next.limited = false;
      if (e.conclusion !== undefined) next.conclusion = e.conclusion;
      break;
    case "manual":
      // A status given is the status; only 在等谁 given: the status follows from it as usual.
      manual = e.status !== undefined;
      status = e.status ?? prev.status;
      if (status === "closed") {
        next.asks = [];
        next.limited = false;
      } else if (e.to !== undefined) {
        next.asks = [];
        next.limited = false;
        ask("manual", e.to, status === "confirm" ? "confirm" : "waiting");
        if (e.status === undefined && WORKING.has(prev.status)) status = working();
      }
      break;
  }
  const last = next.asks.at(-1);
  next.waitingOn = last ? last.to : [];
  next.waitingWhy = last ? { reason: last.reason, by: last.by, at: last.at, seq: last.seq } : null;
  next.status = status;
  if (s === null || status !== prev.status || manual) {
    const change: MatterChange = { at: e.at, by: e.by, from: s === null ? null : prev.status, to: status, event: e.kind };
    if (e.seq != null) change.seq = e.seq;
    if (manual) change.manual = true;
    if (e.note) change.note = e.note.slice(0, 200);
    next.history = [...prev.history, change].slice(-200);
  }
  return next;
}

/** A 事项's state from all of its events, in order. */
export function deriveMatter(events: readonly MatterEvent[]): MatterState | null {
  let s: MatterState | null = null;
  for (const e of events) s = applyMatterEvent(s, e);
  return s;
}

/**
 * What a message in a 事项 is, as an event. It addresses (`to`) whom it @-s and the author of what it replies to — unless
 * that reply answers something that author asked of me there (then it only answers: otherwise every answer would set the
 * 事项 waiting on the one who asked). A person answering what they were asked to confirm is an "answer".
 */
export function matterMessageEvent(s: Pick<MatterState, "asks"> | null, m: { by: Party; seq: number; at: number; mentions?: readonly Party[]; replyToAuthor?: Party | null }): MatterEvent {
  const asks = s?.asks ?? [];
  const to = new Set<Party>(m.mentions ?? []);
  if (m.replyToAuthor && !asks.some((a) => a.by === m.replyToAuthor && a.to.includes(m.by))) to.add(m.replyToAuthor);
  to.delete(m.by);
  if (to.size) return { kind: "address", at: m.at, by: m.by, seq: m.seq, to: [...to] };
  const answers = m.by.startsWith("person:") && asks.some((a) => (a.reason === "ask" || a.reason === "limit") && a.to.includes(m.by));
  return { kind: answers ? "answer" : "say", at: m.at, by: m.by, seq: m.seq };
}

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
  /** An answer's 来源 (2026-11-25: AIs answer each other directly): confirmed with a person, or the AI's own judgement. */
  basis?: MessageBasis;
  /** 知会 · 要某人看过: people (accounts) who should look at it; it is in their 待我处理 until they mark it 看过了. */
  notice?: string[];
  /** Commits it reports pushed (a "push" event of its 事项). */
  commits?: string[];
  /** A verification it reports (a "verify" event of its 事项): passed or not, and how it was checked. */
  verify?: { passed: boolean; how?: string };
}

/**
 * 回答的来源 (the user 11-25): an AI answering another AI says where its answer comes from — confirmed with its person (when,
 * or which of 已定的事), or its own judgement the person has not confirmed. The other side decides from it whether to
 * take it to a person (等人确认); the client shows a small mark on an inferred one.
 */
export type MessageBasis =
  | { kind: "confirmed"; person: string; at?: number; decision?: number }
  | { kind: "inferred"; person: string };

/** The basis as one line: 「已和小王确认（11-24 15:02 / 已定的事第 3 条）」 or 「我的判断，小王没确认过」. `name`: how to show an
 * account (its nickname). */
export function basisText(b: MessageBasis, name: (account: string) => string = (a) => a): string {
  const who = name(b.person);
  if (b.kind === "inferred") return `我的判断，${who}没确认过`;
  const when = b.at === undefined ? null : (() => {
    const d = new Date(b.at);
    const two = (n: number) => String(n).padStart(2, "0");
    return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
  })();
  const where = [when, b.decision !== undefined ? `已定的事第 ${b.decision} 条` : null].filter(Boolean).join(" / ");
  return `已和${who}确认${where ? `（${where}）` : ""}`;
}

/** Mark messages 看过 / 处理了 (POST …/marks): by seq, or every message of a 事项 up to `upTo`. A person marking a 知会 to
 * them 看过 has handled it (that is all it asks). */
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

/**
 * mention: a message @-s me; reply: a message answers mine; waiting: a 事项 waits on me; message: a 事项's message to me;
 * notice: a 知会 asks me to look (people); quiet: a 事项 my side's 主控 carries has had no event for MATTER_QUIET_MS while
 * 在做 (its 主控 only). Each until I mark it 处理了 (a 知会: 看过了), the 事项 closes or (quiet) something happens in it.
 * The 群聊's messages without @ are only unread, never 待我处理. While a 事项 is `limited` its AIs get nothing from it.
 */
export type PendingKind = "mention" | "reply" | "waiting" | "message" | "notice" | "quiet";

/**
 * Why it is mine (the Host writes the wake-up line from it, plans/collab-agent-spec.md 第 2 节: 「谁、何时、为什么变成等我」):
 * `by` (null: nobody in particular — 久没动静), `at`, a reason code and a sentence without names (the Host puts `by`'s
 * name in front).
 */
export interface PendingWhy {
  by: Party | null;
  at: number;
  reason: PendingKind | MatterWaitReason;
  text: string;
}

export interface PendingItem {
  kind: PendingKind;
  scope: MatterScope;
  scopeId: string;
  /** The 事项 (id), null for the 群聊. */
  matter: string | null;
  /** 「事项 N」, its title and status (null for the 群聊). */
  matterNo: number | null;
  matterTitle: string | null;
  matterStatus: MatterStatus | null;
  /** The message (#seq), null for a 事项 waiting on me or 久没动静. */
  seq: number | null;
  /** The messages it is about (#seq): the message, what it replies to, the one that made the 事项 wait on me. */
  seqs: number[];
  /** When it became mine (the message's time, or when the 事项 started waiting on me). */
  since: number;
  why: PendingWhy;
  /** One line for the list: 「事项 3 · 标题」 or 「#7 开头」. */
  text: string;
  /** The whole message, for an @ of me, a reply to me and a 知会 (the wake-up message quotes them in full). */
  body?: string;
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
  /** Who wrote the message it replies to. */
  replyToAuthor?: Party | null;
  body: string;
  createdAt: number;
}

const oneLine = (t: string, max = 80) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

const WAIT_TEXT: Record<MatterWaitReason, (seq: number | null) => string> = {
  address: (seq) => `@ 或回复了你${seq != null ? `（#${seq}）` : ""}，还没回`,
  ask: () => "请你确认",
  limit: () => `这件事项里 AI 之间来回到了 ${AGENT_ROUNDS_MAX} 条，没有人说话，停下来等人`,
  manual: () => "手改成在等你",
};

/** A participant's 待我处理, newest first: what pendingFor's rules (PendingKind) find in these 事项 and messages. */
export function pendingFor(party: Party, scope: MatterScope, scopeId: string, matters: readonly Matter[], messages: readonly PendingMessage[], opts: { now?: number } = {}): PendingItem[] {
  const byId = new Map(matters.map((m) => [m.id, m]));
  const agent = party.startsWith("agent:");
  const items: PendingItem[] = [];
  const of = (m: Matter | undefined) => ({ matter: m?.id ?? null, matterNo: m?.no ?? null, matterTitle: m?.title ?? null, matterStatus: m?.status ?? null });
  for (const m of matters) {
    if (m.status === "closed" || (agent && m.limited)) continue;
    if (m.waitingOn.includes(party)) {
      const w = m.waitingWhy;
      const since = w?.at ?? [...m.history].reverse().find((h) => h.to === m.status)?.at ?? m.updatedAt;
      const reason = w?.reason ?? "manual";
      items.push({ kind: "waiting", scope, scopeId, ...of(m), seq: null, seqs: w?.seq != null ? [w.seq] : [], since, why: { by: w?.by ?? null, at: since, reason, text: WAIT_TEXT[reason](w?.seq ?? null) }, text: `事项 ${m.no} · ${oneLine(m.title)}` });
    }
    if (opts.now !== undefined && m.lead && party === agentParty(m.lead) && matterQuiet(m, opts.now)) {
      items.push({ kind: "quiet", scope, scopeId, ...of(m), seq: null, seqs: [], since: m.lastEventAt, why: { by: null, at: m.lastEventAt, reason: "quiet", text: `在做，超过 ${MATTER_QUIET_MS / 3_600_000} 小时没有动静` }, text: `事项 ${m.no} · ${oneLine(m.title)}` });
    }
  }
  for (const msg of messages) {
    if (msg.author === party || msg.withdrawnAt !== undefined || msg.supersededBy !== undefined) continue;
    const r = msg.receipts?.find((x) => x.party === party);
    if (!r || r.state === "handled") continue;
    const matter = msg.matter ? byId.get(msg.matter) : undefined;
    if (msg.matter && (!matter || matter.status === "closed" || (agent && matter.limited))) continue;
    const mentioned = !!msg.mentions?.includes(party);
    const replied = !!msg.replyToAuthor && msg.replyToAuthor === party;
    const p = parseParty(party);
    const noticed = p?.kind === "person" && !!msg.notice?.includes(p.name);
    if (!mentioned && !replied && !noticed && !msg.matter) continue;
    const kind: PendingKind = mentioned ? "mention" : replied ? "reply" : noticed ? "notice" : "message";
    const where = matter ? `事项 ${matter.no}` : "群聊";
    const text = { mention: `在${where} @ 了你`, reply: `在${where}回复了你${msg.replyTo ? `的 #${msg.replyTo}` : ""}`, notice: "知会：要你看过", message: `${where}里给你的消息` }[kind as "mention" | "reply" | "notice" | "message"];
    const item: PendingItem = { kind, scope, scopeId, ...of(matter), seq: msg.seq, seqs: [msg.seq, ...(msg.replyTo ? [msg.replyTo] : [])], since: msg.createdAt, why: { by: msg.author, at: msg.createdAt, reason: kind, text }, text: `#${msg.seq} ${oneLine(msg.body)}` };
    if (kind !== "message") item.body = msg.body;
    items.push(item);
  }
  // Newest first; at the same moment a 事项's own state (等你, 久没动静) before its messages, then by #seq, so two reads agree.
  const at = (i: PendingItem) => i.seq ?? Number.MAX_SAFE_INTEGER;
  return items.sort((a, b) => b.since - a.since || at(b) - at(a));
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

// ---- 指代 (plans/collab-agent-spec.md 第 3 节: every tool takes 「事项 3」, 「#7」, a display name such as 「老李的主控」 or a
// whole line copied from the 中转 client, without looking up a mark first)

/** What a reference names. */
export type CollabRef =
  | { kind: "matter"; no: number }
  | { kind: "thread"; id: string }
  | { kind: "seq"; seq: number }
  | { kind: "cowork"; id: string }
  | { kind: "agent"; mark: string }
  | { kind: "name"; text: string };

/**
 * Reads a reference: 「事项 3」 (also 「事项3「标题」」), 「#7」 or 「#7（协作「…」 cowork:…）」, a copied
 * 「子会话「…」 thread:t_…（协作 cowork:…）」 (the thread wins over the cowork it names), 「cowork:t_…」, an agent's mark
 * (`agent:…` or `studio:…`); anything else is a name. A bare number is left to the caller (a 事项's number where a 事项
 * is wanted, a message's #seq where a message is).
 */
export function parseCollabRef(text: string): CollabRef | null {
  const t = text.trim();
  if (!t) return null;
  const thread = /\bthread:(t_[0-9a-f]{16})\b/.exec(t);
  if (thread) return { kind: "thread", id: thread[1]! };
  const matter = /^事项\s*(\d{1,9})(?!\d)/.exec(t);
  if (matter) return { kind: "matter", no: Number(matter[1]) };
  const seq = /^#(\d{1,15})(?!\d)/.exec(t);
  if (seq) return { kind: "seq", seq: Number(seq[1]) };
  const cowork = /\bcowork:(t_[0-9a-f]{16})\b/.exec(t);
  if (cowork) return { kind: "cowork", id: cowork[1]! };
  if (/^t_[0-9a-f]{16}$/.test(t)) return { kind: "thread", id: t };
  if (t.startsWith("agent:") && t.length > 6) return { kind: "agent", mark: t.slice(6) };
  if (/^studio:\S+$/.test(t)) return { kind: "agent", mark: t };
  return { kind: "name", text: t };
}

/** An agent as resolveAgentRef sees it. */
export interface AgentRefInfo {
  mark: string;
  /** 「程序老李 的 AI · 战斗代码」. */
  name: string;
  label: string;
  owner: string;
  ownerNick?: string;
  role: AgentRole;
  /** An 执行's 事项 number. */
  matterNo?: number | null;
}

const squash = (s: string) => s.replace(/[\s「」『』"'“”·・]/g, "").toLowerCase();

/**
 * Which agent a reference means: its mark, its display name or label, 「<人>的主控」, 「<人>的 AI」 (when that person has
 * one in), 「事项 N 的执行」 (when it has one); <人> by account or nickname. Returns the marks it fits: one is the answer,
 * none or several are the caller's to explain.
 */
export function resolveAgentRef(ref: string, agents: readonly AgentRefInfo[]): string[] {
  const r = parseCollabRef(ref);
  if (r?.kind === "agent") return agents.some((a) => a.mark === r.mark) ? [r.mark] : [];
  const q = squash(ref);
  if (!q) return [];
  const exact = agents.filter((a) => a.mark === ref.trim() || squash(a.name) === q || squash(a.label) === q);
  if (exact.length) return exact.map((a) => a.mark);
  const people = (a: AgentRefInfo) => [a.owner, a.ownerNick].filter((x): x is string => !!x).map(squash);
  const lead = /^(.+?)的(?:ai)?主控$/.exec(q);
  if (lead) {
    // Its 主控; a side with none yet (agents from before roles): its 未分角色 ones, who may do what a 主控 may.
    const theirs = agents.filter((a) => people(a).includes(lead[1]!));
    const leads = theirs.filter((a) => a.role === "lead");
    return (leads.length ? leads : theirs.filter((a) => a.role === "unassigned")).map((a) => a.mark);
  }
  const worker = /^事项(\d+)的(?:ai)?执行(?:会话)?$/.exec(q);
  if (worker) return agents.filter((a) => a.role === "worker" && a.matterNo === Number(worker[1])).map((a) => a.mark);
  const theirs = /^(.+?)的ai$/.exec(q);
  if (theirs) return agents.filter((a) => people(a).includes(theirs[1]!)).map((a) => a.mark);
  return [];
}

// ---- 锁 (2026-11-25, the user: 「a 在拖拽卡 b 就不拖拽，省得出现并发出问题」)
//
// Like a 白板 card's text lock (30 s, renewed while held, let go on release, disconnect or time-out; pushed as board-lock):
// `place` while a person drags a 事项卡, `edit` while a person has its judgement fields open (卡在哪、结论、手改状态、在等谁).
// Held by someone else: a drop or a save is refused (409 with the lock and the 事项 as it is now); an AI's change of those
// fields is refused while anyone holds `edit`. Only people take them.

export type MatterLockKind = "place" | "edit";
/** The fields `edit` guards. */
export const MATTER_EDIT_FIELDS = ["status", "waitingOn", "blocker", "conclusion"] as const;
/** The lock's key in the board's locks (BoardLock.card): 「place:<事项 id>」, 「edit:<事项 id>」. */
export const matterLockKey = (kind: MatterLockKind, matterId: string): string => `${kind}:${matterId}`;
export function parseMatterLockKey(key: string): { kind: MatterLockKind; matter: string } | null {
  const m = /^(place|edit):(.+)$/.exec(key);
  return m ? { kind: m[1] as MatterLockKind, matter: m[2]! } : null;
}
/** 「小王正在移动」 / 「老李正在改」. */
export const matterLockText = (kind: MatterLockKind, by: string): string => (kind === "place" ? `${by}正在移动` : `${by}正在改`);
