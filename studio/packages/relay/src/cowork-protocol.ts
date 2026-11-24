// 协作 (cowork, 2026-11-23, plans/cowork.md): people and the agents they bring work one thing through on 中转. What the
// service (cowork.ts, cowork-board.ts), the client (relay-ui, step 3) and Studio's Host (teamrelay, step 4) share.
//
// A cowork is data on the service, not a model and no resident agent:
// - 群聊: a thread of the new kind "cowork" (its id is the cowork's id). Messages, files, 已读, /ws `message` pushes and
//   /api/wait work as for any thread; its members are the people (accounts) only.
// - agent: a Studio session someone brought in, known by its mark (Via.conv, `studio:<设备号>:<会话 id>`), shown as
//   「<主人> 的 AI · <会话名>」. Bringing it in is the owner's authority for it to post, ask, write the board and log
//   events here without asking again. Its messages are the owner's account with `via: { kind: "ai", conv: mark }`.
// - 子会话: a request thread (protocol.ts RequestState) with `coworkId`: every member of the cowork is in it (sees it,
//   may write in it — 插话); asking, waiting on, rounds and replies are a request's. Folded into one card in the 群聊
//   (an event message with `session`), its conclusion goes into 已定的事 (an event of kind "decision").
// - Waking an agent: only when someone @-s it (`agentMentions`) or someone writes in a 子会话 it started. Each such
//   message becomes a delivery for it (排队中 → 已送达 → 已回复); the owner's Studio takes them from /api/cowork-inbox
//   and puts them into the session when it is free. Other chat wakes no agent: the inbox only counts it (`unread`).
// - AI 发起 @ 和提问 (option `aiInitiate`, off by default, the user 11-23): while off, an agent's message that @-s anyone
//   (person or agent) and an agent's new 子会话 are kept as a draft only its owner sees, who sends it (as it is or
//   edited) or drops it. On: they go out at once.
// - 白板: a list of operations (cowork-board.ts), each numbered by the service; cards change field by field, the text of
//   a card under a soft lock, a conflicting text kept as 「另一版」, deletes only marked, undo only of one's own steps.
// - 目标 (with its history), 仓库和分支, 选项, 事件 (decisions, commits an agent pushed, notes, big board changes): on the
//   cowork; events are recorded and pushed to the people, never delivered to an agent (it reads them when it likes).
//
// Every call needs the caller to be a member of the cowork (403 otherwise); an agent's call is its owner's key plus its
// mark in `via.conv`, and the mark must be one of that owner's agents in this cowork.

import type { AgentRole, MarkRequest, Matter, MatterEvent, MatterPatch, MessageBasis, MessageRewrite, NewMatter, PendingList, Receipt, SupersedeResult } from "@amo-studio/protocol/matters";
import type { Message, NewMessage, Question, Thread, Via } from "./protocol.js";

// 事项、回执、角色、待我处理 (2026-11-24): the shared fields and rules, the same as the Host's local 事项 table.
export * from "@amo-studio/protocol/matters";

/** /api/health's `cowork`: this set of calls' version (missing on a service from before it). */
export const COWORK_VERSION = 2;
/** A service whose `cowork` is at least this has 事项, receipts, roles and 待我处理 (the section 「事项」 below). */
export const COWORK_MATTERS_VERSION = 2;

/** The owner's Studio reports its agents' state at least this often (and whenever it changes). */
export const AGENT_REPORT_MS = 30_000;
/** No report for this long (Studio closed, offline): the agent counts as 不在线. */
export const AGENT_STALE_MS = 90_000;
/** A card's text lock goes by itself after this long without being renewed (the user 11-23: 30 秒). */
export const BOARD_LOCK_MS = 30_000;
/** An agent's board call touches at most this many cards (the user 11-23: 一次最多 10 张，超了要人点头). */
export const BOARD_AI_MAX_CARDS = 10;
/** Operations in one board call (a client replaying what it queued while offline sends them in batches). */
export const BOARD_OPS_MAX = 200;
/** Cards (deleted ones included, they are kept until the cowork ends) on one board. */
export const BOARD_ITEMS_MAX = 3000;
/** A presence report older than this is dropped (clients repeat it while the board is open). */
export const BOARD_PRESENCE_MS = 20_000;
/**
 * AI 和 AI 连续往来的上限 (2026-11-23, the user: 30～50 合理, plans/collab-framework.md「轮数上限」): in one thread (the 群聊
 * and each 子会话 counted apart), once this many messages in a row are agents' with no person's in between, agents' messages
 * there wake no agent any more and an event of kind "paused" says so; a person's message there starts the count again.
 */
export const AGENT_STREAK_MAX = 30;
/** A long poll on /api/cowork-inbox waits at most this long. */
export const COWORK_INBOX_MAX_WAIT = 10 * 60_000;

export const COWORK_LIMITS = { title: 200, goal: 20_000, repo: 500, branch: 200, label: 60, mark: 80, eventText: 4_000, files: 50, cardText: 4_000, conclusion: 4_000 };

// ---- the cowork

export interface CoworkOptions {
  /** AI 发起 @ 和提问: an agent's message that @-s someone and its new 子会话 go out at once (true) or wait as a draft for its
   * owner (false, the default). */
  aiInitiate: boolean;
}

export const DEFAULT_COWORK_OPTIONS: CoworkOptions = { aiInitiate: false };

/** How an agent stands, as its owner's Studio reports it (offline: no report for AGENT_STALE_MS). */
export type AgentState = "idle" | "busy" | "owner" | "offline";
/** What the client shows; what an @ does then: idle 马上送进它的会话; busy 排队，这一轮跑完再送; owner 排队，主人这边空下来再送;
 * offline 留在服务上，主人的 Studio 连上后送. */
export const AGENT_STATE_LABEL: Record<AgentState, string> = { idle: "待命", busy: "处理中", owner: "等主人", offline: "不在线" };

export interface CoworkAgent {
  /** Its session's mark (Via.conv), e.g. `studio:d_…:s-…`: what @ and every agent call name it by. */
  mark: string;
  /** Who brought it in: its messages are this account's, marked as its AI's. */
  owner: string;
  /** The session's name as its owner gave it (会话名). */
  label: string;
  /** 「<owner's nickname or name> 的 AI · <label>」. */
  name: string;
  state: AgentState;
  /** Deliveries waiting for it (排队中): the client's 「前面还有 N 条」. */
  queued: number;
  /** When its owner's Studio last reported it (ms); 0 = never. The client's 「上次在线 10:42」. */
  lastSeen: number;
  joinedAt: number;
  /** 主控 or 执行 (COWORK_MATTERS_VERSION; missing on an older service: treat as lead). Its side is `owner`. */
  role?: AgentRole;
  /** An 执行's 事项 (id); null for a 主控. */
  matter?: string | null;
  /** Its 事项's number (「事项 3 的执行」), so cowork_read can say who carries what (2026-11-25). */
  matterNo?: number | null;
}

/** A 子会话 as the cowork lists it (its messages are the thread's). */
export interface CoworkSession {
  id: string;
  title: string;
  /** Who asks (an agent asks as its owner) and whom it waits for, as a request's. */
  from: string;
  to: string;
  /** The agent that started it (its mark), null when a person did: replies wake that agent. */
  agent: string | null;
  state: "open" | "returned" | "done";
  waitingOn: string | null;
  /** What was settled (结论), once someone concluded it; also an event of kind "decision". */
  conclusion: string | null;
  createdAt: number;
  updatedAt: number;
  lastSeq: number;
}

export interface Cowork {
  /** The 群聊 thread's id. */
  id: string;
  title: string;
  /** 目标说明 (Markdown): anyone in it may change it; every version is kept (GET …/goals). */
  goal: string;
  /** The repository and branch it works on (set when started; may be changed). */
  repo: string;
  branch: string;
  options: CoworkOptions;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Ended (结束): no more messages, board changes or agents until reopened. */
  endedAt: number | null;
  /** The people, in the order they came. */
  members: string[];
  /** The agents in it now (ones that left are not listed). */
  agents: CoworkAgent[];
  sessions: CoworkSession[];
  /** Its 事项 (COWORK_MATTERS_VERSION), by number: each 子会话's (same id) and those opened with POST …/matters. */
  matters?: Matter[];
  /** The 群聊's last message seq. */
  lastSeq: number;
  /** The board's last operation seq. */
  boardSeq: number;
}

/** A cowork in my list: with what I have not read of its 群聊. */
export interface CoworkListItem extends Cowork {
  unread: number;
  readSeq: number;
}

export interface NewCowork {
  title: string;
  goal?: string;
  repo?: string;
  branch?: string;
  /** People to bring in (besides me). */
  members?: string[];
  options?: Partial<CoworkOptions>;
  via?: Via;
}

/** Only what is given changes. `ended`: true ends it, false reopens it. */
export interface CoworkPatch {
  title?: string;
  goal?: string;
  repo?: string;
  branch?: string;
  options?: Partial<CoworkOptions>;
  ended?: boolean;
  via?: Via;
}

export interface CoworkGoalVersion {
  id: number;
  at: number;
  by: string;
  via: Via;
  goal: string;
}

/** created / goal / option / member / agent / ended / reopened: the cowork itself; decision: a 子会话's conclusion (已定的事);
 * commit: an agent pushed (commit, files); note: anything else worth keeping; board: a big board change (new or deleted
 * card, marked 已过时); paused: agents went AGENT_STREAK_MAX messages in a row in a thread (data.threadId) and wake no
 * agent there until a person says something. */
export type CoworkEventKind = "created" | "goal" | "option" | "member" | "agent" | "ended" | "reopened" | "decision" | "commit" | "note" | "board" | "paused";

export interface CoworkEvent {
  id: number;
  coworkId: string;
  at: number;
  actor: string;
  via: Via;
  /** The agent's mark when an agent recorded it. */
  agent: string | null;
  kind: CoworkEventKind;
  text: string;
  data?: { threadId?: string; commit?: string; files?: string[]; cards?: string[]; mark?: string; names?: string[] };
}

/** What an agent records (cowork_note): a commit it pushed (with the files it touched: board cards citing an older commit
 * of them are marked 已过时), or a note. */
export interface NewCoworkEvent {
  kind: "commit" | "note";
  text: string;
  commit?: string;
  /** The 事项 a commit is for (its "push" event); an 执行's commit goes to its own 事项 without it. */
  matter?: string;
  files?: string[];
  via?: Via;
}

/** GET /api/cowork/:id. */
export interface CoworkDetail {
  cowork: Cowork;
  /** The latest 200, oldest first. Decisions (已定的事) are those of kind "decision". */
  events: CoworkEvent[];
  /** The latest 300 deliveries of this cowork, oldest first: what the client shows under each message (去向). */
  deliveries: CoworkDelivery[];
  /** My agents' drafts waiting for me (only the owner sees them). */
  drafts: CoworkDraft[];
}

// ---- messages

/**
 * A message in the 群聊 or in a 子会话 (POST /api/cowork/:id/messages, or the thread's own /messages: both go the same
 * way). Besides a message's fields: `agentMentions`, the agents @-ed (their marks; they must be in this cowork) — each
 * gets a delivery; `replyTo`, the seq of the message it answers (an agent's answer quotes it: 「回 美术小周」).
 */
export interface CoworkPost extends NewMessage {
  /** In a 事项 or the 群聊 (default): its thread id, or 「事项 3」 (/api/cowork/:id/messages). */
  threadId?: string;
  /** Agents by mark or by name (「老李的主控」, 「事项 3 的执行」). */
  agentMentions?: string[];
  /** The message it answers: its seq, or 「#7」. */
  replyTo?: number | string;
  /** My earlier message (seq or 「#7」) this one replaces: it is marked 被 #x 取代 (COWORK_MATTERS_VERSION). */
  supersedes?: number | string;
  /** Where the answer comes from (2026-11-25, protocol/matters.ts MessageBasis). */
  basis?: MessageBasis;
  /** 知会 · 要某人看过: people (accounts or nicknames) who should look at it. */
  notice?: string[];
  /** Commits pushed (in a 事项: its "push" event → 已推送). */
  commits?: string[];
  /** A verification (in a 事项: its "verify" event → 待核对 when passed). */
  verify?: { passed: boolean; how?: string };
  /** 处理了 with this message (the user 11-24: AI 随回复标), besides what `replyTo` names (that one always is): these seqs,
   * or true for everything to me in this thread so far. */
  handled?: true | number[];
}

/** A message went out (with the deliveries it made), or an agent's message was kept as a draft for its owner. */
export type CoworkPostResult = { thread: Thread; message: Message; deliveries: CoworkDelivery[]; events: CoworkEvent[]; superseded?: SupersedeResult; draft?: undefined } | { draft: CoworkDraft; thread?: undefined; message?: undefined; deliveries?: undefined; events?: undefined };

/** A new 子会话: a request to a person in the cowork (every member is in it). From an AI it always needs a reply. */
export interface NewCoworkSession {
  to: string;
  title: string;
  body: string;
  questions?: Array<{ id?: string; text: string; options?: string[] }>;
  /** Files it takes along (ids of the asker's files). */
  files?: string[];
  via?: Via;
}

export type CoworkAskResult = { thread: Thread; message: Message; draft?: undefined } | { draft: CoworkDraft; thread?: undefined; message?: undefined };

// ---- deliveries: what goes to an agent

/** mention: someone @-ed it; reply: someone wrote in a 子会话 it started. */
export type DeliveryReason = "mention" | "reply";
/** queued 排队中 → delivered 已送达 (its owner's Studio took it) → replied 已回复 (it wrote in that thread since); dropped:
 * it left the cowork before it got it. */
export type DeliveryState = "queued" | "delivered" | "replied" | "dropped";

export interface CoworkDelivery {
  id: string;
  coworkId: string;
  /** The agent's mark. */
  agent: string;
  owner: string;
  threadId: string;
  /** The message it is about. */
  seq: number;
  messageId: string;
  /** Who wrote it (an account; with fromAgent, that account's agent). */
  from: string;
  fromAgent: string | null;
  reason: DeliveryReason;
  state: DeliveryState;
  createdAt: number;
  deliveredAt: number | null;
  repliedAt: number | null;
  /** The agent's message that answered it. */
  replySeq: number | null;
}

/** One delivery for Studio, with what it needs to put it into the session. */
export interface CoworkInboxItem {
  delivery: CoworkDelivery;
  cowork: { id: string; title: string; goal: string; repo: string; branch: string };
  thread: { id: string; kind: Thread["kind"]; title: string };
  message: Message;
}

/** GET /api/cowork-inbox: the queued deliveries of my agents (whose marks start with the prefix asked), oldest first, and
 * per agent how many messages in its coworks it has not read (no delivery: 「Cowork 里有 N 条新的」). */
export interface CoworkInbox {
  items: CoworkInboxItem[];
  unread: Array<{ coworkId: string; agent: string; count: number }>;
}

/** POST /api/cowork/agents/status: what the owner's Studio says of each of its agents (all coworks they are in). */
export interface AgentReport {
  mark: string;
  state: Exclude<AgentState, "offline"> | "offline";
}

// ---- drafts

export interface CoworkDraft {
  id: string;
  coworkId: string;
  agent: string;
  owner: string;
  /** post: a message (into `threadId`); ask: a new 子会话. */
  kind: "post" | "ask";
  threadId: string | null;
  post?: CoworkPost;
  ask?: NewCoworkSession;
  /** pending: waits for the owner; sent (as it was or edited); dropped (不发). */
  state: "pending" | "sent" | "dropped";
  createdAt: number;
  decidedAt: number | null;
  /** Where it went once sent. */
  result: { threadId: string; seq: number } | null;
}

/** 发出 / 改一下再发 (send with `edit`) / 不发. */
export interface DraftDecision {
  action: "send" | "drop";
  edit?: { body?: string; mentions?: string[]; agentMentions?: string[]; title?: string; to?: string; questions?: Question[] | Array<{ id?: string; text: string; options?: string[] }> };
}

// ---- the board (白板)

/** note 便签; session: a 子会话's card; ref: a file, commit, document version or link; group: a frame cards sit in; link: a
 * line from one card to another. 事项卡 are not cards (2026-11-25): the client draws them from the 事项 (`Matter.place`). */
export type BoardItemKind = "note" | "session" | "ref" | "group" | "link";

export interface BoardRef {
  kind: "file" | "commit" | "doc" | "url";
  /** A file in the repository (`/`-separated). */
  path?: string;
  /** The commit it was read at (a commit event touching `path` at another commit marks the card 已过时). */
  commit?: string;
  /** A document's version. */
  version?: string;
  url?: string;
  title?: string;
}

/** What operations change, field by field. */
export interface BoardFields {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  color?: string | null;
  text?: string;
  /** The group card it sits in; null = none. */
  group?: string | null;
  /** 已过时. */
  stale?: boolean;
  ref?: BoardRef | null;
  /** A link's ends (card ids). */
  from?: string | null;
  to?: string | null;
}

export interface BoardItem {
  id: string;
  kind: BoardItemKind;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string | null;
  text: string;
  group: string | null;
  /** A session card's 子会话 (thread id). */
  session: string | null;
  ref: BoardRef | null;
  from: string | null;
  to: string | null;
  stale: boolean;
  /** Goes up with every change to the card; operations name the one they were based on (`base`). */
  version: number;
  /** The version at which its text last changed: a text change based on an older one is a conflict. */
  textVersion: number;
  /** 另一版: a text that came in conflicting (written offline on an older version); the card shows 「! 有冲突，看另一版」
   * until a person picks one (`resolve`). */
  alt: { text: string; by: string; agent: string | null; at: number } | null;
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  /** The agent that made the last change (the card shows 「AI 刚改」), null when a person did. */
  updatedAgent: string | null;
  updatedAt: number;
  /** Marked deleted (最近删除, kept until the cowork ends); `restore` brings it back. */
  deleted: boolean;
  deletedBy: string | null;
  deletedAt: number | null;
}

/** A new card; `id` may be the client's own (so a card made offline can be changed before it is sent): letters, digits,
 * `_`, `-`, at most 40. */
export interface BoardNewItem extends BoardFields {
  id?: string;
  kind: BoardItemKind;
  session?: string;
}

/**
 * One operation. `opId` (the client's, unique per cowork) makes a repeat harmless: an operation already applied is
 * answered with its record again (a client replaying its queue after a break). `base` (set): the card's version the
 * change was made on — position, size, colour, group, link ends and 已过时 go in whatever it is (the later one wins, by
 * the service's order); a text change on an older textVersion becomes 另一版 for a person, and is refused for an agent
 * (read again first).
 */
export type BoardOp =
  | { op: "add"; opId?: string; item: BoardNewItem }
  | { op: "set"; opId?: string; id: string; base?: number; fields: BoardFields }
  | { op: "delete"; opId?: string; id: string }
  | { op: "restore"; opId?: string; id: string }
  /** A person picks a version of a conflicting card: keep the text it has (`current`) or take 另一版 (`alt`). */
  | { op: "resolve"; opId?: string; id: string; keep: "current" | "alt" }
  /** Undo one of my own operations (its seq): what it changed goes back where nobody changed it since; an undo is itself
   * an operation (undo it to redo). */
  | { op: "undo"; opId?: string; seq: number };

/** The fields one operation changed on one card, before and after (`deleted` too). */
export interface BoardChange {
  id: string;
  before: Partial<BoardItem>;
  after: Partial<BoardItem>;
}

/** An applied operation: the board's history (谁、什么时候、改了什么) and what /ws pushes. */
export interface BoardOpRecord {
  seq: number;
  opId: string | null;
  op: BoardOp["op"];
  actor: string;
  /** The agent's mark when an agent did it. */
  agent: string | null;
  at: number;
  /** The cards it touched, as they are after it: clients put them in place. */
  items: BoardItem[];
  changes: BoardChange[];
  /** It undid that seq. */
  undoOf: number | null;
  /** A text change that became 另一版. */
  conflict: boolean;
}

/** locked: someone else is writing the card (`by`); stale: an agent's text on an older version; deleted: the card is
 * deleted (restore it first); missing; forbidden (not yours to undo, a person's choice); nothing: an undo with nothing
 * left to undo; bad: a malformed operation. */
export type BoardRejectCode = "locked" | "stale" | "deleted" | "missing" | "forbidden" | "nothing" | "bad" | "exists";

export interface BoardOpsResult {
  seq: number;
  applied: BoardOpRecord[];
  /** By the operation's place in the call; the others still apply. */
  rejected: Array<{ index: number; opId?: string; code: BoardRejectCode; message: string; by?: string }>;
}

export interface BoardLock {
  /** A card's id, or a 事项's 「place:<id>」 / 「edit:<id>」 (protocol/matters.ts matterLockKey). */
  card: string;
  /** Who is writing it (a person: agents do not lock, their changes are single operations). */
  by: string;
  until: number;
}

/** GET …/board?after=seq: the operations since (full: false), or — after 0, or too far back — every card, deleted ones
 * too (full: true). With the text locks held now. */
export interface BoardSnapshot {
  seq: number;
  full: boolean;
  items?: BoardItem[];
  ops?: BoardOpRecord[];
  locks: BoardLock[];
}

/** Who has the board open, what they selected and what they are dragging (shown, never stored). */
export interface BoardPresence {
  name: string;
  selected: string[];
  /** A card being dragged and where it is now (the others draw its ghost there). */
  dragging: { id: string; x: number; y: number } | null;
  at: number;
}

// ---- 事项 (2026-11-24, COWORK_MATTERS_VERSION; plans/collab-framework.md「11-24」; the shared part is protocol/matters.ts)
//
// What changes on a service with 事项 (served since step 2, cowork-matters.ts; health.cowork ≥ 2 — an older service answers
// these calls 404 and leaves the fields out):
// - Every 子会话 is a 事项 (`Cowork.matters`, its id = the thread's id); old ones are migrated (statusFromSession). A 主控 or a
//   person opens one with POST …/matters (NewMatter): a request thread, numbered 「事项 N」. cowork_ask stays for the
//   agents (换底不换样): a 子会话 asked of a person = a 事项 「等人确认」 waiting on them.
// - Messages carry MatterMessageFields (protocol.ts Message): `matter`, `receipts` (one per recipient, messageRecipients),
//   `withdrawnAt`, `editedAt`, `supersededBy`. 看过 is recorded by itself when a client opens the thread (its read cursor
//   passing the message) and when an agent reads it (coworkFeed with `agent`, cowork_read); 处理了 by POST …/marks.
//   Closing a 事项 marks all of its messages 处理了 (`byClose`).
// - Roles: an agent comes in as 主控 (`lead`, one per side: a second is refused with 409 and leadTakenText) or 执行
//   (`worker`, with its 事项). An 执行 reads the goal, 已定的事, its 事项 and that 事项's card only, and posts only in its 事项;
//   the service refuses (403) the rest (roleAllows). No role (agents from before, an older Studio's join): `unassigned`
//   未分角色 — as before, several on a side, not its side's 主控 — until a person picks one (2026-11-25).
// - 「AI 发起 @ 和提问」 and drafts go: an old cowork's `options.aiInitiate` is ignored and no new drafts are made; drafts
//   kept from before are still their owner's to send or drop once. In their place, 闸门 (GATE_RULES_TEXT): a 主控 opens a
//   「等人确认」 事项.
// - Older clients (Studio 0.9.81) keep working: every call they make answers as before and the new fields are optional;
//   /api/health `cowork` (COWORK_VERSION) tells a newer Studio it may use the new tools.
// - 待我处理: GET /api/cowork/pending (PendingList per participant, with a version that goes up when it changes; a long
//   poll with `since`), and a /ws push `pending` to the person's own devices.
// - Status from events (2026-11-25, protocol/matters.ts applyMatterEvent): every message in a 事项 (发言, @/回复, 确认回复),
//   a bound 执行, a push (`commits` on a message, or a commit event with `matter`), a verification (`verify` on a message),
//   an ask, two AIs going back and forth AGENT_STREAK_MAX times (→ 等人确认, a line in the 群聊), a conclusion and a hand
//   change are its events (GET …/matters/:id/events); the 事项 carries what they add up to. 在做 with no event for
//   MATTER_QUIET_MS goes into its 主控's 待我处理 (「久没动静」).
// - AIs answer each other (2026-11-25): an 执行 may @ agents in its 事项 (not people); an answer says where it comes from
//   (`basis`: confirmed with whom / when or which of 已定的事, or inferred). A 知会 (`notice`: people) is in their 待我处理
//   until they mark it 看过了.
// - References: `threadId`, `matter`, `agentMentions`, `mentions`, `replyTo`, `supersedes`, `waitingOn` and the 事项 in a
//   path take 「事项 3」, 「#7」, a display name (「老李的主控」) or a copied line (protocol/matters.ts parseCollabRef).
// - The board (2026-11-25): 事项卡 are not stored as cards. The client draws them — group by side, 「已定 / 已验」 once
//   settled (matterGroup), status, who it waits on, dependency lines — from the 事项; the service keeps only where a person
//   dragged one (`Matter.place`, PATCH …/matters/:id `{place, placeBase}`). Notes, links and references stay cards.
// - Locks (2026-11-25): POST …/matters/:id/lock `{what: place|edit, on}` — the board's soft lock (BOARD_LOCK_MS, renewed,
//   let go on drop, disconnect or time-out), key 「place:<id>」 / 「edit:<id>」 in BoardLock.card and board-lock pushes. Someone
//   else holding it: 409 with `lock` and `matter` (as it is now) in the body (RelayClientError.data).

/** Bring an agent in with its role (POST /api/cowork/:id/agents): an 执行 names its 事项. No role: unassigned 未分角色. */
export interface CoworkAgentJoin {
  mark: string;
  label: string;
  role?: AgentRole;
  /** An 执行's 事项 (id), required for role "worker". */
  matter?: string;
}

/** Change an agent's role (POST /api/cowork/:id/agents/role): its owner, in person or through its 主控. */
export interface CoworkAgentRolePatch {
  mark: string;
  role: AgentRole;
  matter?: string | null;
  via?: Via;
}

/** POST /api/cowork/:id/matters. */
export interface NewCoworkMatter extends Omit<NewMatter, "waitingOn"> {
  /** Parties, or names of people and agents (「老李的主控」). */
  waitingOn?: string[];
  via?: Via;
}
/** POST /api/cowork/:id/matters → the 事项, its thread and its first message. */
export interface CoworkMatterResult {
  matter: Matter;
  thread: Thread;
  message: Message;
}

/** GET /api/cowork/:id/matters/:matterId/events: what happened in it, in order (deriveMatter adds them up to its state). */
export interface CoworkMatterEvents {
  matter: Matter;
  events: MatterEvent[];
}

/** PATCH /api/cowork/:id/matters/:matterId (MatterPatch): 409 `stale` with the 事项 as it is now when `base` is older. */
export interface CoworkMatterPatch extends Omit<MatterPatch, "waitingOn"> {
  /** Parties, or names of people and agents (「老李的主控」); [] waits on nobody. */
  waitingOn?: string[];
  via?: Via;
}

/** POST /api/cowork/:id/marks (看过 / 处理了 for me, or for my agent with `via`): the receipts that moved. */
export interface CoworkMarkRequest extends MarkRequest {
  via?: Via;
}
export interface CoworkMarkResult {
  changed: Array<{ threadId: string; seq: number; receipt: Receipt }>;
}

/**
 * PATCH /api/cowork/:id/messages/:seq ({ body }: 原地改) and POST …/messages/:seq/withdraw (撤回): only its author (or the
 * author's agent through `via`), only while no recipient has seen it (canRewrite; 409 `seen` otherwise — post a new
 * message with `supersedes` then). A post with `supersedes: <seq>` marks that one 被 #x 取代 and answers `superseded`:
 * the agents that had seen it, which the Host tells again.
 */
export interface CoworkMessageRewrite extends MessageRewrite {
  via?: Via;
}
export type CoworkSupersedeResult = SupersedeResult;

/** GET /api/cowork/pending?coworkId=&party=&since=&wait=: my list (person) or my agent's (party `agent:<mark>`, mine). */
export interface CoworkPendingQuery {
  coworkId?: string;
  party?: string;
  /** Answer at once when the version differs from this; otherwise wait up to `wait` ms for a change. */
  since?: number;
  wait?: number;
}
export interface CoworkPending {
  lists: Array<PendingList & { coworkId: string }>;
  /** The lists' versions added up: what `since` compares with. */
  version: number;
}

// ---- /ws (added to protocol.ts RelayEvent)

export type CoworkRelayEvent =
  /** The cowork changed (made, goal, options, members, agents joined or left, a 子会话 made or moved, ended): to its people. */
  | { type: "cowork"; cowork: Cowork }
  /** I left (or was taken out of) a cowork: to my devices. */
  | { type: "cowork-left"; coworkId: string }
  /** An agent's state or queue changed: to the cowork's people. */
  | { type: "cowork-agent"; coworkId: string; agent: CoworkAgent }
  | { type: "cowork-event"; coworkId: string; event: CoworkEvent }
  /** A delivery was made or moved on (排队中 / 已送达 / 已回复): to the cowork's people. */
  | { type: "cowork-delivery"; coworkId: string; delivery: CoworkDelivery }
  /** A draft was made or decided: to its owner only. */
  | { type: "cowork-draft"; coworkId: string; draft: CoworkDraft }
  | { type: "board"; coworkId: string; ops: BoardOpRecord[] }
  /** A text lock was taken, renewed or let go (`lock` null). */
  | { type: "board-lock"; coworkId: string; card: string; lock: BoardLock | null }
  | { type: "board-presence"; coworkId: string; presence: BoardPresence[] }
  /** A 事项 was opened or changed (COWORK_MATTERS_VERSION): to the cowork's people. */
  | { type: "matter"; coworkId: string; matter: Matter }
  /** Receipts moved (送到 / 看过 / 处理了): to the cowork's people (each client shows only those of its own messages). */
  | { type: "receipts"; coworkId: string; changed: CoworkMarkResult["changed"] }
  /** A message was withdrawn, rewritten or superseded: to everyone who sees its thread. */
  | { type: "message-changed"; coworkId: string; message: Message }
  /** A participant's 待我处理 changed: to the person's devices (theirs and their agents'). */
  | { type: "pending"; coworkId: string; party: string; version: number };

/** What a client may send over /ws (besides nothing): its board presence, as often as it likes (the service passes on at
 * most a few a second). Same as POST …/board/presence. */
export type CoworkClientFrame = { type: "board-presence"; coworkId: string; selected?: string[]; dragging?: { id: string; x: number; y: number } | null; open?: boolean };
