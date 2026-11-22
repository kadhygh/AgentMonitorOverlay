import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CoworkBoard, type BoardActor, type BoardBigChange } from "./cowork-board.js";
import {
  AGENT_STALE_MS,
  AGENT_STREAK_MAX,
  COWORK_LIMITS,
  DEFAULT_COWORK_OPTIONS,
  type AgentReport,
  type AgentState,
  type BoardOpsResult,
  type Cowork,
  type CoworkAgent,
  type CoworkAskResult,
  type CoworkDelivery,
  type CoworkDetail,
  type CoworkDraft,
  type CoworkEvent,
  type CoworkEventKind,
  type CoworkGoalVersion,
  type CoworkInbox,
  type CoworkListItem,
  type CoworkOptions,
  type CoworkPatch,
  type CoworkPost,
  type CoworkPostResult,
  type CoworkSession,
  type DeliveryReason,
  type DraftDecision,
  type NewCowork,
  type NewCoworkEvent,
  type NewCoworkSession,
} from "./cowork-protocol.js";
import type { Message, Thread, Via } from "./protocol.js";
import { RelayError, checkName, checkText as cleanText, checkVia, type RelayStore } from "./store.js";

// 协作's records (2026-11-23, cowork-protocol.ts, plans/cowork.md), in the relay's database beside the threads and
// messages they reuse: the cowork (its 群聊 is a thread of kind "cowork", same id), its goal's versions, the agents brought
// in (by their session's mark), its events, the deliveries waiting for agents, the agents' drafts; 子会话 are request
// threads with `cowork_id` (store.ts). The board is cowork-board.ts. Only the service (server.ts) uses it; what is pushed
// to whom is decided there.

type Row = Record<string, unknown>;

const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;
const AGENT_STATES = new Set(["idle", "busy", "owner", "offline"]);
const BOARD_KIND_WORD: Record<string, string> = { note: "便签", session: "子会话卡", ref: "引用卡", group: "分组", link: "连线" };

function cleanMark(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new RelayError("bad_request", "要带 AI 会话的标记（via.conv）");
  const v = value.trim();
  if (v.length > COWORK_LIMITS.mark || /[\u0000-\u001f\u007f]/.test(v)) throw new RelayError("bad_request", "AI 会话的标记不对");
  return v;
}

function cleanOptions(value: unknown, base: CoworkOptions): CoworkOptions {
  if (value === undefined || value === null) return base;
  if (typeof value !== "object") throw new RelayError("bad_request", "options 要是一个对象");
  const o = value as Record<string, unknown>;
  const out = { ...base };
  if (o.aiInitiate !== undefined) {
    if (typeof o.aiInitiate !== "boolean") throw new RelayError("bad_request", "aiInitiate 要是 true 或 false");
    out.aiInitiate = o.aiInitiate;
  }
  return out;
}

function names(value: unknown, what: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new RelayError("bad_request", `${what} 要是列表`);
  return [...new Set(value.map((n) => checkName(n)))];
}

export class CoworkStore {
  readonly board: CoworkBoard;
  private readonly db: DatabaseSync;

  constructor(
    private readonly store: RelayStore,
    private readonly now: () => number = Date.now,
  ) {
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS coworks (
        id TEXT PRIMARY KEY, goal TEXT NOT NULL DEFAULT '', repo TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '',
        options TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS cowork_goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, cowork_id TEXT NOT NULL, at INTEGER NOT NULL, by_name TEXT NOT NULL, via TEXT NOT NULL, goal TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cowork_goals_cowork ON cowork_goals(cowork_id, id);
      CREATE TABLE IF NOT EXISTS cowork_agents (
        cowork_id TEXT NOT NULL, mark TEXT NOT NULL, owner TEXT NOT NULL, label TEXT NOT NULL, joined_at INTEGER NOT NULL, left_at INTEGER,
        state TEXT, reported_at INTEGER, read_seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (cowork_id, mark)
      );
      CREATE INDEX IF NOT EXISTS cowork_agents_owner ON cowork_agents(owner);
      CREATE TABLE IF NOT EXISTS cowork_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, cowork_id TEXT NOT NULL, at INTEGER NOT NULL, actor TEXT NOT NULL, via TEXT NOT NULL, agent TEXT,
        kind TEXT NOT NULL, text TEXT NOT NULL, data TEXT
      );
      CREATE INDEX IF NOT EXISTS cowork_events_cowork ON cowork_events(cowork_id, id);
      CREATE TABLE IF NOT EXISTS cowork_deliveries (
        id TEXT PRIMARY KEY, cowork_id TEXT NOT NULL, agent TEXT NOT NULL, owner TEXT NOT NULL, thread_id TEXT NOT NULL, seq INTEGER NOT NULL,
        message_id TEXT NOT NULL, from_name TEXT NOT NULL, from_agent TEXT, reason TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
        delivered_at INTEGER, replied_at INTEGER, reply_seq INTEGER
      );
      CREATE INDEX IF NOT EXISTS cowork_deliveries_owner ON cowork_deliveries(owner, state);
      CREATE INDEX IF NOT EXISTS cowork_deliveries_cowork ON cowork_deliveries(cowork_id, created_at);
      CREATE TABLE IF NOT EXISTS cowork_drafts (
        id TEXT PRIMARY KEY, cowork_id TEXT NOT NULL, agent TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL, thread_id TEXT,
        payload TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER, result_thread TEXT, result_seq INTEGER
      );
      CREATE INDEX IF NOT EXISTS cowork_drafts_owner ON cowork_drafts(cowork_id, owner, state);
    `);
    this.board = new CoworkBoard(this.db, now);
  }

  // ---- reading

  private row(id: string): Row {
    const r = this.db.prepare("SELECT * FROM coworks WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw new RelayError("not_found", `没有这个协作：${id}`);
    return r;
  }

  /** The cowork, when `name` is in it (not in it: 403, whether it exists or not is all they learn). */
  private rowFor(id: string, name: string): Row {
    const r = this.db.prepare("SELECT c.* FROM coworks c JOIN thread_members tm ON tm.thread_id = c.id AND tm.name = ? WHERE c.id = ?").get(name, id) as Row | undefined;
    if (r) return r;
    if (this.db.prepare("SELECT 1 FROM coworks WHERE id = ?").get(id)) throw new RelayError("forbidden", "你不在这个协作里");
    throw new RelayError("not_found", `没有这个协作：${id}`);
  }

  private writable(r: Row): void {
    if (r.ended_at != null) throw new RelayError("conflict", "这个协作已经结束了；要接着做，先重新打开它");
  }

  /** The cowork a thread belongs to: its 群聊, or the cowork of a 子会话; null for any other thread. */
  coworkOf(thread: Thread): string | null {
    if (thread.kind === "cowork") return thread.id;
    return thread.request?.coworkId ?? null;
  }

  /** The people in it (whom to push to). */
  people(id: string): string[] {
    return this.store.threadMembers(id);
  }

  private sessionIds(id: string): string[] {
    return (this.db.prepare("SELECT id FROM threads WHERE cowork_id = ? ORDER BY created_at, rowid").all(id) as Row[]).map((r) => String(r.id));
  }

  private nicks(): Map<string, string> {
    return new Map(this.store.members().map((m) => [m.name, m.nick || m.name]));
  }

  private agentOf(r: Row, nicks = this.nicks()): CoworkAgent {
    const reported = r.reported_at == null ? 0 : Number(r.reported_at);
    const fresh = reported > 0 && this.now() - reported <= AGENT_STALE_MS;
    const said = String(r.state ?? "offline");
    const state: AgentState = fresh && AGENT_STATES.has(said) ? (said as AgentState) : "offline";
    const queued = Number((this.db.prepare("SELECT COUNT(*) AS n FROM cowork_deliveries WHERE cowork_id = ? AND agent = ? AND state = 'queued'").get(String(r.cowork_id), String(r.mark)) as Row).n);
    const owner = String(r.owner);
    return { mark: String(r.mark), owner, label: String(r.label), name: `${nicks.get(owner) ?? owner} 的 AI · ${String(r.label)}`, state, queued, lastSeen: reported, joinedAt: Number(r.joined_at) };
  }

  /** An agent in the cowork now; null when it is not (never was, or left). */
  agent(coworkId: string, mark: string): CoworkAgent | null {
    const r = this.db.prepare("SELECT * FROM cowork_agents WHERE cowork_id = ? AND mark = ? AND left_at IS NULL").get(coworkId, mark) as Row | undefined;
    return r ? this.agentOf(r) : null;
  }

  /** Every agent in a cowork now, everywhere (the service looks for ones gone 不在线). */
  activeAgents(): Array<{ coworkId: string; agent: CoworkAgent }> {
    const nicks = this.nicks();
    return (this.db.prepare("SELECT * FROM cowork_agents WHERE left_at IS NULL").all() as Row[]).map((r) => ({ coworkId: String(r.cowork_id), agent: this.agentOf(r, nicks) }));
  }

  private sessionOf(t: Thread): CoworkSession {
    const r = t.request!;
    const agent = (this.db.prepare("SELECT cw_agent FROM threads WHERE id = ?").get(t.id) as Row | undefined)?.cw_agent;
    return { id: t.id, title: t.title, from: r.from, to: r.to, agent: agent == null ? null : String(agent), state: r.state, waitingOn: r.waitingOn, conclusion: r.conclusion ?? null, createdAt: t.createdAt, updatedAt: t.updatedAt, lastSeq: t.lastSeq };
  }

  view(id: string): Cowork {
    const r = this.row(id);
    const thread = this.store.threadById(id);
    const nicks = this.nicks();
    const agents = (this.db.prepare("SELECT * FROM cowork_agents WHERE cowork_id = ? AND left_at IS NULL ORDER BY joined_at, rowid").all(id) as Row[]).map((a) => this.agentOf(a, nicks));
    return {
      id,
      title: thread.title,
      goal: String(r.goal),
      repo: String(r.repo),
      branch: String(r.branch),
      options: { ...DEFAULT_COWORK_OPTIONS, ...(JSON.parse(String(r.options || "{}")) as Partial<CoworkOptions>) },
      createdBy: String(r.created_by),
      createdAt: Number(r.created_at),
      updatedAt: Math.max(Number(r.updated_at), thread.updatedAt),
      endedAt: r.ended_at == null ? null : Number(r.ended_at),
      members: thread.members,
      agents,
      sessions: this.sessionIds(id).map((s) => this.sessionOf(this.store.threadById(s))),
      lastSeq: thread.lastSeq,
      boardSeq: this.board.seq(id),
    };
  }

  get(id: string, me: string): Cowork {
    this.rowFor(id, me);
    return this.view(id);
  }

  /** The coworks I am in, latest first, with what I have not read of their 群聊. */
  list(me: string): CoworkListItem[] {
    const rows = this.db.prepare("SELECT c.id, tm.read_seq FROM coworks c JOIN thread_members tm ON tm.thread_id = c.id AND tm.name = ?").all(me) as Row[];
    return rows
      .map((r) => {
        const readSeq = Number(r.read_seq);
        const unread = Number((this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND seq > ? AND author <> ?").get(String(r.id), readSeq, me) as Row).n);
        return { ...this.view(String(r.id)), unread, readSeq };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  detail(id: string, me: string): CoworkDetail {
    this.rowFor(id, me);
    const events = (this.db.prepare("SELECT * FROM cowork_events WHERE cowork_id = ? ORDER BY id DESC LIMIT 200").all(id) as Row[]).map((r) => this.eventOf(r)).reverse();
    const deliveries = (this.db.prepare("SELECT * FROM cowork_deliveries WHERE cowork_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 300").all(id) as Row[]).map((r) => this.deliveryOf(r)).reverse();
    return { cowork: this.view(id), events, deliveries, drafts: this.drafts(id, me) };
  }

  goals(id: string, me: string): CoworkGoalVersion[] {
    this.rowFor(id, me);
    return (this.db.prepare("SELECT * FROM cowork_goals WHERE cowork_id = ? ORDER BY id").all(id) as Row[]).map((r) => ({ id: Number(r.id), at: Number(r.at), by: String(r.by_name), via: JSON.parse(String(r.via)) as Via, goal: String(r.goal) }));
  }

  events(id: string, me: string, after = 0): CoworkEvent[] {
    this.rowFor(id, me);
    return (this.db.prepare("SELECT * FROM cowork_events WHERE cowork_id = ? AND id > ? ORDER BY id LIMIT 1000").all(id, after) as Row[]).map((r) => this.eventOf(r));
  }

  /**
   * Messages of the 群聊 and its 子会话 after `after`, in order (an agent's cowork_read). With `agent` (one of mine): it has
   * read them — the inbox's 「N 条新的」 counts from here.
   */
  feed(id: string, me: string, after: number, agentMark?: string | null): { messages: Message[]; lastSeq: number } {
    this.rowFor(id, me);
    const threads = [id, ...this.sessionIds(id)];
    const messages = this.store.messagesIn(threads, after, 500);
    const lastSeq = messages.length ? messages[messages.length - 1]!.seq : after;
    if (agentMark) {
      this.requireAgent(id, me, agentMark);
      this.db.prepare("UPDATE cowork_agents SET read_seq = MAX(read_seq, ?) WHERE cowork_id = ? AND mark = ?").run(lastSeq, id, agentMark);
    }
    return { messages, lastSeq };
  }

  // ---- the cowork itself

  private event(coworkId: string, actor: string, via: Via, kind: CoworkEventKind, text: string, data?: CoworkEvent["data"]): CoworkEvent {
    const agent = via.kind === "ai" ? (via.conv ?? null) : null;
    const res = this.db.prepare("INSERT INTO cowork_events (cowork_id, at, actor, via, agent, kind, text, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(coworkId, this.now(), actor, JSON.stringify(via), agent, kind, text, data ? JSON.stringify(data) : null);
    this.db.prepare("UPDATE coworks SET updated_at = ? WHERE id = ?").run(this.now(), coworkId);
    return this.eventOf(this.db.prepare("SELECT * FROM cowork_events WHERE id = ?").get(Number(res.lastInsertRowid)) as Row);
  }

  private eventOf(r: Row): CoworkEvent {
    const e: CoworkEvent = { id: Number(r.id), coworkId: String(r.cowork_id), at: Number(r.at), actor: String(r.actor), via: JSON.parse(String(r.via)) as Via, agent: r.agent == null ? null : String(r.agent), kind: String(r.kind) as CoworkEventKind, text: String(r.text) };
    if (r.data) e.data = JSON.parse(String(r.data)) as CoworkEvent["data"];
    return e;
  }

  /** 发起协作: its 群聊, me and the people named in it, the goal's first version. */
  create(me: string, n: NewCowork): { cowork: Cowork; message: Message; events: CoworkEvent[] } {
    const title = cleanText(n?.title, "标题", COWORK_LIMITS.title);
    const goal = cleanText(n.goal, "目标", COWORK_LIMITS.goal, false);
    const repo = cleanText(n.repo, "仓库", COWORK_LIMITS.repo, false);
    const branch = cleanText(n.branch, "分支", COWORK_LIMITS.branch, false);
    const people = names(n.members, "members").filter((x) => x !== me);
    for (const p of people) if (!this.store.isMember(p)) throw new RelayError("not_found", `没有这个人：${p}`);
    const options = cleanOptions(n.options, DEFAULT_COWORK_OPTIONS);
    const via = checkVia(n.via);
    return this.store.tx(() => {
      const id = newId("t");
      const at = this.now();
      this.db.prepare("INSERT INTO threads (id, kind, title, created_by, created_at, updated_at) VALUES (?, 'cowork', ?, ?, ?, ?)").run(id, title, me, at, at);
      for (const p of [me, ...people]) this.db.prepare("INSERT INTO thread_members (thread_id, name) VALUES (?, ?)").run(id, p);
      this.db.prepare("INSERT INTO coworks (id, goal, repo, branch, options, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, goal, repo, branch, JSON.stringify(options), me, at, at);
      if (goal) this.db.prepare("INSERT INTO cowork_goals (cowork_id, at, by_name, via, goal) VALUES (?, ?, ?, ?, ?)").run(id, at, me, JSON.stringify(via), goal);
      const where = [repo, branch].filter(Boolean).join(" · ");
      const events = [this.event(id, me, via, "created", `发起协作「${title}」${where ? `（${where}）` : ""}`, people.length ? { names: people } : undefined)];
      const message = this.store.insertMessage(id, me, via, "event", `发起了协作「${title}」${people.length ? `，拉进了 ${people.join("、")}` : ""}`, null);
      return { cowork: this.view(id), message, events };
    });
  }

  /** 改标题、目标（留历史）、仓库分支、选项；`ended` 结束或重新打开. Anyone in it may. */
  update(id: string, me: string, patch: CoworkPatch): { cowork: Cowork; events: CoworkEvent[]; dropped: CoworkDelivery[] } {
    const r = this.rowFor(id, me);
    const via = checkVia(patch?.via);
    const reopening = patch.ended === false && r.ended_at != null;
    if (!reopening) this.writable(r);
    const title = patch.title === undefined ? undefined : cleanText(patch.title, "标题", COWORK_LIMITS.title);
    const goal = patch.goal === undefined ? undefined : cleanText(patch.goal, "目标", COWORK_LIMITS.goal, false);
    const repo = patch.repo === undefined ? undefined : cleanText(patch.repo, "仓库", COWORK_LIMITS.repo, false);
    const branch = patch.branch === undefined ? undefined : cleanText(patch.branch, "分支", COWORK_LIMITS.branch, false);
    const was = this.view(id);
    const options = patch.options === undefined ? undefined : cleanOptions(patch.options, was.options);
    return this.store.tx(() => {
      const events: CoworkEvent[] = [];
      const at = this.now();
      if (title !== undefined && title !== was.title) {
        this.db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(title, id);
        events.push(this.event(id, me, via, "goal", `改名为「${title}」`));
      }
      if (goal !== undefined && goal !== was.goal) {
        this.db.prepare("UPDATE coworks SET goal = ? WHERE id = ?").run(goal, id);
        this.db.prepare("INSERT INTO cowork_goals (cowork_id, at, by_name, via, goal) VALUES (?, ?, ?, ?, ?)").run(id, at, me, JSON.stringify(via), goal);
        events.push(this.event(id, me, via, "goal", "改了目标"));
      }
      if ((repo !== undefined && repo !== was.repo) || (branch !== undefined && branch !== was.branch)) {
        this.db.prepare("UPDATE coworks SET repo = ?, branch = ? WHERE id = ?").run(repo ?? was.repo, branch ?? was.branch, id);
        events.push(this.event(id, me, via, "goal", `仓库和分支改为 ${[repo ?? was.repo, branch ?? was.branch].filter(Boolean).join(" · ") || "（空）"}`));
      }
      if (options && options.aiInitiate !== was.options.aiInitiate) {
        this.db.prepare("UPDATE coworks SET options = ? WHERE id = ?").run(JSON.stringify(options), id);
        events.push(this.event(id, me, via, "option", options.aiInitiate ? "打开了「AI 发起 @ 和提问」：AI 的 @ 和提问直接发出" : "关上了「AI 发起 @ 和提问」：AI 的 @ 和提问先存成草稿，主人确认后发出"));
      }
      const dropped: CoworkDelivery[] = [];
      if (patch.ended === true && r.ended_at == null) {
        this.db.prepare("UPDATE coworks SET ended_at = ? WHERE id = ?").run(at, id);
        // Ended, nobody may write here: what still waited for an agent would only be refused when it answered.
        const queued = (this.db.prepare("SELECT id FROM cowork_deliveries WHERE cowork_id = ? AND state = 'queued'").all(id) as Row[]).map((q) => String(q.id));
        this.db.prepare("UPDATE cowork_deliveries SET state = 'dropped' WHERE cowork_id = ? AND state = 'queued'").run(id);
        dropped.push(...queued.map((q) => this.delivery(q)));
        events.push(this.event(id, me, via, "ended", "结束了协作"));
      }
      if (reopening) {
        this.db.prepare("UPDATE coworks SET ended_at = NULL WHERE id = ?").run(id);
        events.push(this.event(id, me, via, "reopened", "重新打开了协作"));
      }
      if (events.length) this.db.prepare("UPDATE coworks SET updated_at = ? WHERE id = ?").run(at, id);
      return { cowork: this.view(id), events, dropped };
    });
  }

  /** 拉人: into the 群聊 and every 子会话 (they see what came before). Anyone in it may. */
  addMembers(id: string, me: string, value: unknown): { cowork: Cowork; message: Message; events: CoworkEvent[]; added: string[] } {
    const r = this.rowFor(id, me);
    this.writable(r);
    const have = new Set(this.people(id));
    const added = names(value, "add").filter((n) => !have.has(n));
    for (const n of added) if (!this.store.isMember(n)) throw new RelayError("not_found", `没有这个人：${n}`);
    if (!added.length) throw new RelayError("bad_request", "要拉的人都已经在这个协作里了");
    return this.store.tx(() => {
      for (const t of [id, ...this.sessionIds(id)]) for (const n of added) this.db.prepare("INSERT OR IGNORE INTO thread_members (thread_id, name) VALUES (?, ?)").run(t, n);
      const message = this.store.insertMessage(id, me, { kind: "person" }, "event", `把 ${added.join("、")} 拉了进来（之前的记录他们也能看到）`, null);
      const events = [this.event(id, me, { kind: "person" }, "member", `拉进了 ${added.join("、")}`, { names: added })];
      return { cowork: this.view(id), message, events, added };
    });
  }

  /** 退出: out of the 群聊 and the 子会话 they neither asked nor are asked in; their agents leave with them. */
  leave(id: string, me: string): { cowork: Cowork; message: Message; events: CoworkEvent[]; dropped: CoworkDelivery[] } {
    this.rowFor(id, me);
    return this.store.tx(() => {
      const message = this.store.insertMessage(id, me, { kind: "person" }, "event", "退出了协作", null);
      this.db.prepare("DELETE FROM thread_members WHERE thread_id = ? AND name = ?").run(id, me);
      for (const t of this.sessionIds(id)) {
        const s = this.store.threadById(t).request!;
        if (s.from !== me && s.to !== me) this.db.prepare("DELETE FROM thread_members WHERE thread_id = ? AND name = ?").run(t, me);
      }
      const dropped: CoworkDelivery[] = [];
      for (const a of this.db.prepare("SELECT mark FROM cowork_agents WHERE cowork_id = ? AND owner = ? AND left_at IS NULL").all(id, me) as Row[]) dropped.push(...this.agentGone(id, String(a.mark)));
      const events = [this.event(id, me, { kind: "person" }, "member", "退出了协作", { names: [me] })];
      return { cowork: this.view(id), message, events, dropped };
    });
  }

  // ---- agents

  /** A joined agent of mine in this cowork, or 403. */
  private requireAgent(coworkId: string, me: string, mark: string): Row {
    const r = this.db.prepare("SELECT * FROM cowork_agents WHERE cowork_id = ? AND mark = ? AND left_at IS NULL").get(coworkId, mark) as Row | undefined;
    if (!r || String(r.owner) !== me) throw new RelayError("forbidden", "这个 AI 会话没有拉进这个协作（或已经离开了）：先让它的主人把它拉进来");
    return r;
  }

  /** Who does a write: the person, or (via.kind ai) one of their agents in this cowork. */
  actor(coworkId: string, me: string, via: Via): BoardActor {
    if (via.kind !== "ai") return { name: me, agent: null };
    const mark = cleanMark(via.conv);
    this.requireAgent(coworkId, me, mark);
    return { name: me, agent: mark };
  }

  /** 拉进协作: one of my sessions, by its mark, shown as 「<me> 的 AI · <label>」. Again (or again after leaving): its label
   * is updated. */
  joinAgent(id: string, me: string, markValue: unknown, labelValue: unknown): { cowork: Cowork; agent: CoworkAgent; message: Message | null; events: CoworkEvent[] } {
    const r = this.rowFor(id, me);
    this.writable(r);
    const mark = cleanMark(markValue);
    const label = cleanText(labelValue, "会话名", COWORK_LIMITS.label, false) || "会话";
    const had = this.db.prepare("SELECT * FROM cowork_agents WHERE cowork_id = ? AND mark = ?").get(id, mark) as Row | undefined;
    if (had && String(had.owner) !== me) throw new RelayError("conflict", "这个 AI 会话是别人拉进来的");
    return this.store.tx(() => {
      const at = this.now();
      const active = had && had.left_at == null;
      if (!had) this.db.prepare("INSERT INTO cowork_agents (cowork_id, mark, owner, label, joined_at) VALUES (?, ?, ?, ?, ?)").run(id, mark, me, label, at);
      else this.db.prepare("UPDATE cowork_agents SET label = ?, left_at = NULL, joined_at = CASE WHEN left_at IS NULL THEN joined_at ELSE ? END WHERE cowork_id = ? AND mark = ?").run(label, at, id, mark);
      const agent = this.agent(id, mark)!;
      if (active) return { cowork: this.view(id), agent, message: null, events: [] };
      const message = this.store.insertMessage(id, me, { kind: "person" }, "event", `把 ${agent.name} 拉了进来`, null);
      const events = [this.event(id, me, { kind: "person" }, "agent", `拉进了 ${agent.name}`, { mark })];
      return { cowork: this.view(id), agent, message, events };
    });
  }

  /** My agent leaves; what was still queued for it is dropped. */
  leaveAgent(id: string, me: string, markValue: unknown): { cowork: Cowork; message: Message; events: CoworkEvent[]; dropped: CoworkDelivery[] } {
    this.rowFor(id, me);
    const mark = cleanMark(markValue);
    const name = this.agentOf(this.requireAgent(id, me, mark)).name;
    return this.store.tx(() => {
      const dropped = this.agentGone(id, mark);
      const message = this.store.insertMessage(id, me, { kind: "person" }, "event", `让 ${name} 离开了协作`, null);
      const events = [this.event(id, me, { kind: "person" }, "agent", `${name} 离开了`, { mark })];
      return { cowork: this.view(id), message, events, dropped };
    });
  }

  private agentGone(id: string, mark: string): CoworkDelivery[] {
    this.db.prepare("UPDATE cowork_agents SET left_at = ? WHERE cowork_id = ? AND mark = ?").run(this.now(), id, mark);
    const ids = (this.db.prepare("SELECT id FROM cowork_deliveries WHERE cowork_id = ? AND agent = ? AND state = 'queued'").all(id, mark) as Row[]).map((r) => String(r.id));
    this.db.prepare("UPDATE cowork_deliveries SET state = 'dropped' WHERE cowork_id = ? AND agent = ? AND state = 'queued'").run(id, mark);
    return ids.map((d) => this.delivery(d));
  }

  /** The owner's Studio says how its agents are (all the coworks each is in): the agents it touched, as they are now. */
  reportStatus(me: string, value: unknown): Array<{ coworkId: string; agent: CoworkAgent }> {
    const list = (value && typeof value === "object" && Array.isArray((value as { agents?: unknown }).agents) ? (value as { agents: unknown[] }).agents : null) as AgentReport[] | null;
    if (!list) throw new RelayError("bad_request", "agents 要是列表");
    if (list.length > 200) throw new RelayError("bad_request", "一次最多报 200 个会话");
    const at = this.now();
    const out: Array<{ coworkId: string; agent: CoworkAgent }> = [];
    for (const a of list) {
      const mark = cleanMark(a?.mark);
      if (!AGENT_STATES.has(String(a.state))) throw new RelayError("bad_request", `不认识的状态：${String(a.state)}`);
      const rows = this.db.prepare("SELECT cowork_id FROM cowork_agents WHERE owner = ? AND mark = ? AND left_at IS NULL").all(me, mark) as Row[];
      this.db.prepare("UPDATE cowork_agents SET state = ?, reported_at = ? WHERE owner = ? AND mark = ? AND left_at IS NULL").run(String(a.state), a.state === "offline" ? null : at, me, mark);
      for (const r of rows) out.push({ coworkId: String(r.cowork_id), agent: this.agent(String(r.cowork_id), mark)! });
    }
    return out;
  }

  // ---- deliveries

  private deliveryOf(r: Row): CoworkDelivery {
    return {
      id: String(r.id),
      coworkId: String(r.cowork_id),
      agent: String(r.agent),
      owner: String(r.owner),
      threadId: String(r.thread_id),
      seq: Number(r.seq),
      messageId: String(r.message_id),
      from: String(r.from_name),
      fromAgent: r.from_agent == null ? null : String(r.from_agent),
      reason: String(r.reason) as DeliveryReason,
      state: String(r.state) as CoworkDelivery["state"],
      createdAt: Number(r.created_at),
      deliveredAt: r.delivered_at == null ? null : Number(r.delivered_at),
      repliedAt: r.replied_at == null ? null : Number(r.replied_at),
      replySeq: r.reply_seq == null ? null : Number(r.reply_seq),
    };
  }

  private delivery(id: string): CoworkDelivery {
    return this.deliveryOf(this.db.prepare("SELECT * FROM cowork_deliveries WHERE id = ?").get(id) as Row);
  }

  /**
   * A message came into a cowork's thread: the agents it wakes get a delivery — those @-ed, and the agent that started
   * the 子会话 it is in (unless it wrote it). Nothing else wakes an agent (plans/cowork.md「唤醒」). An agent's own message
   * answers what it was delivered in that thread, and the message it replies to (`replyTo`). Once agents have written
   * AGENT_STREAK_MAX messages in a row in this thread with no person's in between, an agent's message wakes nobody and a
   * "paused" event says so (once); a person's message starts the count again. Returns the deliveries made or moved on,
   * and that event.
   */
  private afterMessage(thread: Thread, message: Message): { deliveries: CoworkDelivery[]; events: CoworkEvent[] } {
    const coworkId = this.coworkOf(thread);
    if (!coworkId || message.kind === "event") return { deliveries: [], events: [] };
    const authorAgent = message.via.kind === "ai" ? (message.via.conv ?? null) : null;
    const events: CoworkEvent[] = [];
    let paused = false;
    if (message.via.kind === "ai") {
      const streak = Number(
        (
          this.db
            .prepare(
              "SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND seq <= ? AND kind <> 'event' AND json_extract(via, '$.kind') = 'ai' AND seq > COALESCE((SELECT MAX(seq) FROM messages WHERE thread_id = ? AND seq <= ? AND kind <> 'event' AND COALESCE(json_extract(via, '$.kind'), 'person') <> 'ai'), 0)",
            )
            .get(thread.id, message.seq, thread.id, message.seq) as Row
        ).n,
      );
      paused = streak >= AGENT_STREAK_MAX;
      if (streak === AGENT_STREAK_MAX)
        events.push(this.event(coworkId, message.author, message.via, "paused", `AI 之间已经连续往来 ${AGENT_STREAK_MAX} 条，等人看一下${thread.kind === "request" ? `（子会话「${thread.title}」）` : ""}：有人在这里说一句话，AI 才会再被叫醒`, { threadId: thread.id }));
    }
    const wake = new Map<string, DeliveryReason>();
    for (const m of message.agentMentions ?? []) if (m !== authorAgent) wake.set(m, "mention");
    if (thread.request) {
      const starter = (this.db.prepare("SELECT cw_agent FROM threads WHERE id = ?").get(thread.id) as Row | undefined)?.cw_agent;
      if (starter != null && String(starter) !== authorAgent && !wake.has(String(starter))) wake.set(String(starter), "reply");
    }
    if (paused) wake.clear();
    const changed: string[] = [];
    const at = this.now();
    for (const [mark, reason] of wake) {
      const a = this.db.prepare("SELECT owner FROM cowork_agents WHERE cowork_id = ? AND mark = ? AND left_at IS NULL").get(coworkId, mark) as Row | undefined;
      if (!a) continue;
      const id = newId("dl");
      this.db
        .prepare("INSERT INTO cowork_deliveries (id, cowork_id, agent, owner, thread_id, seq, message_id, from_name, from_agent, reason, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)")
        .run(id, coworkId, mark, String(a.owner), thread.id, message.seq, message.id, message.author, authorAgent, reason, at);
      changed.push(id);
    }
    if (authorAgent) {
      const answered = this.db.prepare("SELECT id FROM cowork_deliveries WHERE cowork_id = ? AND agent = ? AND state IN ('queued', 'delivered') AND ((thread_id = ? AND state = 'delivered') OR seq = ?)").all(coworkId, authorAgent, thread.id, message.replyTo ?? -1) as Row[];
      for (const r of answered) {
        this.db.prepare("UPDATE cowork_deliveries SET state = 'replied', replied_at = ?, reply_seq = ? WHERE id = ?").run(at, message.seq, String(r.id));
        changed.push(String(r.id));
      }
    }
    if (changed.length || message.agentMentions?.length) this.db.prepare("UPDATE coworks SET updated_at = ? WHERE id = ?").run(at, coworkId);
    return { deliveries: changed.map((d) => this.delivery(d)), events };
  }

  /** What my agents (marks starting with `prefix`: this Studio's) have waiting, and how much they have not read. */
  inbox(me: string, prefixValue: unknown): CoworkInbox {
    const prefix = typeof prefixValue === "string" ? prefixValue.slice(0, COWORK_LIMITS.mark) : "";
    const rows = this.db.prepare("SELECT * FROM cowork_deliveries WHERE owner = ? AND state = 'queued' AND substr(agent, 1, ?) = ? ORDER BY created_at, rowid LIMIT 200").all(me, prefix.length, prefix) as Row[];
    const coworks = new Map<string, Cowork>();
    const items = rows.flatMap((r) => {
      const d = this.deliveryOf(r);
      const message = this.store.messageBySeq(d.seq);
      if (!message) return [];
      const c = coworks.get(d.coworkId) ?? this.view(d.coworkId);
      coworks.set(d.coworkId, c);
      const t = this.store.threadById(d.threadId);
      return [{ delivery: d, cowork: { id: c.id, title: c.title, goal: c.goal, repo: c.repo, branch: c.branch }, thread: { id: t.id, kind: t.kind, title: t.title }, message }];
    });
    const unread = (this.db.prepare("SELECT cowork_id, mark, read_seq FROM cowork_agents WHERE owner = ? AND left_at IS NULL AND substr(mark, 1, ?) = ?").all(me, prefix.length, prefix) as Row[]).flatMap((a) => {
      const threads = [String(a.cowork_id), ...this.sessionIds(String(a.cowork_id))];
      // Not the ones that are deliveries for it (step 4, 2026-11-23): those reach it in full; 「N 条新的」 is the rest.
      const count = Number(
        (
          this.db
            .prepare(`SELECT COUNT(*) AS n FROM messages WHERE thread_id IN (${threads.map(() => "?").join(",")}) AND seq > ? AND kind <> 'event' AND COALESCE(json_extract(via, '$.conv'), '') <> ? AND id NOT IN (SELECT message_id FROM cowork_deliveries WHERE cowork_id = ? AND agent = ?)`)
            .get(...threads, Number(a.read_seq), String(a.mark), String(a.cowork_id), String(a.mark)) as Row
        ).n,
      );
      return count ? [{ coworkId: String(a.cowork_id), agent: String(a.mark), count }] : [];
    });
    return { items, unread };
  }

  /** Whether `me` has a queued delivery for an agent whose mark starts with `prefix` (the inbox's long poll). */
  hasQueued(me: string, prefix: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM cowork_deliveries WHERE owner = ? AND state = 'queued' AND substr(agent, 1, ?) = ? LIMIT 1").get(me, prefix.length, prefix);
  }

  /** The owner's Studio put these into their sessions: 已送达. Returns those that moved. */
  ack(me: string, value: unknown): CoworkDelivery[] {
    const ids = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, 500) : null;
    if (!ids) throw new RelayError("bad_request", "ids 要是列表");
    const at = this.now();
    const out: CoworkDelivery[] = [];
    for (const id of ids) {
      const res = this.db.prepare("UPDATE cowork_deliveries SET state = 'delivered', delivered_at = ? WHERE id = ? AND owner = ? AND state = 'queued'").run(at, id, me);
      if (Number(res.changes)) out.push(this.delivery(id));
    }
    return out;
  }

  // ---- messages, 子会话

  /** An agent's @ or question while 「AI 发起 @ 和提问」 is off: kept for its owner. */
  private draft(coworkId: string, me: string, agent: string, kind: "post" | "ask", threadId: string | null, payload: unknown): CoworkDraft {
    const id = newId("dr");
    this.db.prepare("INSERT INTO cowork_drafts (id, cowork_id, agent, owner, kind, thread_id, payload, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)").run(id, coworkId, agent, me, kind, threadId, JSON.stringify(payload), this.now());
    return this.draftOf(id);
  }

  private draftOf(id: string): CoworkDraft {
    const r = this.db.prepare("SELECT * FROM cowork_drafts WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw new RelayError("not_found", "没有这份草稿");
    const payload = JSON.parse(String(r.payload)) as unknown;
    const d: CoworkDraft = {
      id,
      coworkId: String(r.cowork_id),
      agent: String(r.agent),
      owner: String(r.owner),
      kind: String(r.kind) as CoworkDraft["kind"],
      threadId: r.thread_id == null ? null : String(r.thread_id),
      state: String(r.state) as CoworkDraft["state"],
      createdAt: Number(r.created_at),
      decidedAt: r.decided_at == null ? null : Number(r.decided_at),
      result: r.result_thread == null ? null : { threadId: String(r.result_thread), seq: Number(r.result_seq) },
    };
    if (d.kind === "post") d.post = payload as CoworkPost;
    else d.ask = payload as NewCoworkSession;
    return d;
  }

  /** My agents' drafts waiting for me in a cowork (only the owner sees them). */
  drafts(id: string, me: string): CoworkDraft[] {
    return (this.db.prepare("SELECT id FROM cowork_drafts WHERE cowork_id = ? AND owner = ? AND state = 'pending' ORDER BY created_at, rowid").all(id, me) as Row[]).map((r) => this.draftOf(String(r.id)));
  }

  private cleanAgentMentions(coworkId: string, value: unknown, self: string | null): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new RelayError("bad_request", "agentMentions 要是列表");
    const marks = [...new Set(value.map((v) => cleanMark(v)))].filter((m) => m !== self);
    for (const m of marks) if (!this.agent(coworkId, m)) throw new RelayError("bad_request", `${m} 不是这个协作里的 AI`);
    return marks;
  }

  /**
   * A message in the 群聊 or one of its 子会话 (also what the thread's own /messages does for these threads). An agent's
   * message @-ing someone waits as a draft while 「AI 发起 @ 和提问」 is off (unless its owner is sending that draft).
   */
  post(threadId: string, me: string, p: CoworkPost, approved?: { edited: boolean }): CoworkPostResult {
    const thread = this.store.thread(threadId, me);
    const coworkId = this.coworkOf(thread);
    if (!coworkId) throw new RelayError("bad_request", "这个对话不是协作里的");
    const r = this.row(coworkId);
    this.writable(r);
    const via = checkVia(p?.via);
    const agent = this.actor(coworkId, me, via).agent;
    const agentMentions = this.cleanAgentMentions(coworkId, p.agentMentions, agent);
    let replyTo: number | undefined;
    if (p.replyTo !== undefined && p.replyTo !== null) {
      const m = typeof p.replyTo === "number" ? this.store.messageBySeq(p.replyTo) : null;
      if (!m || (m.threadId !== coworkId && !this.sessionIds(coworkId).includes(m.threadId))) throw new RelayError("bad_request", "replyTo 要是这个协作里的一条消息（seq）");
      replyTo = m.seq;
    }
    const mentions = Array.isArray(p.mentions) ? p.mentions.map(String).filter((n) => n !== me) : [];
    const outside = mentions.filter((n) => !thread.members.includes(n));
    if (outside.length) throw new RelayError("bad_request", `${outside.join("、")} 不在这个协作里，先把他们拉进来`);
    const options = this.view(coworkId).options;
    if (agent && !approved && !options.aiInitiate && (mentions.length || agentMentions.length)) {
      const draft = this.draft(coworkId, me, agent, "post", threadId, { ...p, via, agentMentions, ...(replyTo ? { replyTo } : {}) });
      return { draft };
    }
    // An agent answering without saying what: the latest thing it was given in this thread.
    if (agent && replyTo === undefined) {
      const last = this.db.prepare("SELECT seq FROM cowork_deliveries WHERE cowork_id = ? AND agent = ? AND thread_id = ? AND state = 'delivered' ORDER BY seq DESC LIMIT 1").get(coworkId, agent, threadId) as Row | undefined;
      if (last) replyTo = Number(last.seq);
    }
    const more: Partial<Message> = {};
    if (agentMentions.length) more.agentMentions = agentMentions;
    if (replyTo) more.replyTo = replyTo;
    if (approved) {
      more.approvedBy = me;
      if (approved.edited) more.edited = true;
    }
    const out = this.store.addMessage(threadId, me, { ...p, via }, more);
    const { deliveries, events } = this.store.tx(() => this.afterMessage(out.thread, out.message));
    return { thread: out.thread, message: out.message, deliveries, events };
  }

  /** A new 子会话 in the cowork, asked of a person in it; its card goes into the 群聊. From an agent while 「AI 发起 @ 和提问」
   * is off: a draft for its owner. */
  ask(coworkId: string, me: string, n: NewCoworkSession, approved?: { edited: boolean }): CoworkAskResult & { card?: { thread: Thread; message: Message } } {
    const r = this.rowFor(coworkId, me);
    this.writable(r);
    const via = checkVia(n?.via);
    const agent = this.actor(coworkId, me, via).agent;
    const to = checkName(n.to);
    const people = this.people(coworkId);
    if (!people.includes(to)) throw new RelayError("bad_request", `${to} 不在这个协作里，先把他拉进来`);
    if (agent && !approved && !this.view(coworkId).options.aiInitiate) {
      // Checked now as it would be when sent, so the owner is not handed a draft that cannot go.
      cleanText(n.title, "标题", COWORK_LIMITS.title);
      cleanText(n.body, "正文", 200_000);
      return { draft: this.draft(coworkId, me, agent, "ask", null, { ...n, to, via }) };
    }
    const out = this.store.createRequest(me, { to, title: n.title, body: n.body, questions: n.questions, files: n.files, via, needsReply: true }, { id: coworkId, members: people, agent });
    const card = this.store.tx(() => {
      const extra: Partial<Message> = { session: out.thread.id };
      if (approved) {
        extra.approvedBy = me;
        if (approved.edited) extra.edited = true;
      }
      const message = this.store.insertMessage(coworkId, me, via, "event", `发起子会话「${out.thread.title}」→ ${to}`, extra);
      this.db.prepare("UPDATE coworks SET updated_at = ? WHERE id = ?").run(this.now(), coworkId);
      return { thread: this.store.threadById(coworkId), message };
    });
    return { thread: out.thread, message: out.message, card };
  }

  /** 发出 / 改一下再发 / 不发: only the owner, in person. */
  decideDraft(coworkId: string, draftId: string, me: string, d: DraftDecision & { via?: Via }): { draft: CoworkDraft; post?: CoworkPostResult; ask?: ReturnType<CoworkStore["ask"]> } {
    this.rowFor(coworkId, me);
    const draft = this.draftOf(draftId);
    if (draft.coworkId !== coworkId) throw new RelayError("not_found", "没有这份草稿");
    if (draft.owner !== me) throw new RelayError("forbidden", "只有这个 AI 的主人能决定它的草稿");
    if (checkVia(d?.via).kind === "ai") throw new RelayError("forbidden", "草稿由主人本人决定，AI 不能自己发出");
    if (draft.state !== "pending") throw new RelayError("conflict", draft.state === "sent" ? "这份草稿已经发出了" : "这份草稿已经不发了");
    const decided = (state: "sent" | "dropped", result?: { threadId: string; seq: number }) => {
      this.db.prepare("UPDATE cowork_drafts SET state = ?, decided_at = ?, result_thread = ?, result_seq = ? WHERE id = ?").run(state, this.now(), result?.threadId ?? null, result?.seq ?? null, draftId);
      return this.draftOf(draftId);
    };
    if (d.action === "drop") return { draft: decided("dropped") };
    if (d.action !== "send") throw new RelayError("bad_request", "action 要是 send 或 drop");
    const edit = d.edit && typeof d.edit === "object" ? d.edit : null;
    const edited = !!edit && Object.keys(edit).length > 0;
    if (draft.kind === "post") {
      const p: CoworkPost = { ...draft.post!, ...(edit?.body !== undefined ? { body: edit.body } : {}), ...(edit?.mentions !== undefined ? { mentions: edit.mentions } : {}), ...(edit?.agentMentions !== undefined ? { agentMentions: edit.agentMentions } : {}) };
      const post = this.post(draft.threadId!, me, p, { edited });
      return { draft: decided("sent", { threadId: post.thread!.id, seq: post.message!.seq }), post };
    }
    const n: NewCoworkSession = { ...draft.ask!, ...(edit?.title !== undefined ? { title: edit.title } : {}), ...(edit?.body !== undefined ? { body: edit.body } : {}), ...(edit?.to !== undefined ? { to: edit.to } : {}), ...(edit?.questions !== undefined ? { questions: edit.questions } : {}) };
    const ask = this.ask(coworkId, me, n, { edited });
    return { draft: decided("sent", { threadId: ask.thread!.id, seq: ask.message!.seq }), ask };
  }

  /**
   * 定下结论: the 子会话 is done with what was settled, recorded as 已定的事. Its asker or the person asked (or their agents)
   * may.
   */
  conclude(coworkId: string, threadId: string, me: string, b: { conclusion?: unknown; via?: unknown }): { thread: Thread; message: Message; event: CoworkEvent; cowork: Cowork; deliveries: CoworkDelivery[] } {
    const r = this.rowFor(coworkId, me);
    this.writable(r);
    const via = checkVia(b?.via);
    this.actor(coworkId, me, via);
    const t = this.store.thread(threadId, me);
    if (t.request?.coworkId !== coworkId) throw new RelayError("bad_request", "这不是这个协作里的子会话");
    if (me !== t.request.from && me !== t.request.to) throw new RelayError("forbidden", `结论由发起的 ${t.request.from} 或被问的 ${t.request.to} 来定`);
    const conclusion = cleanText(b.conclusion, "结论", COWORK_LIMITS.conclusion);
    return this.store.tx(() => {
      this.db.prepare("UPDATE threads SET cw_conclusion = ?, s_state = 'done', s_waiting = NULL WHERE id = ?").run(conclusion, threadId);
      const message = this.store.insertMessage(threadId, me, via, "event", `定下结论：${conclusion}`, null);
      const event = this.event(coworkId, me, via, "decision", `「${t.title}」：${conclusion}`, { threadId });
      const deliveries = this.actedIn(coworkId, threadId, me, via, message.seq);
      return { thread: this.store.threadById(threadId), message, event, cowork: this.view(coworkId), deliveries };
    });
  }

  /**
   * Someone acted in a thread with an event rather than a message of their own (定下结论, 标记完成, 交给本人…, 2026-11-23:
   * the 真模型场景 found deliveries left at 已送达 after an agent concluded): what was delivered there to the agent that did
   * it — or, done by a person in person, to their own agents — is answered by that event (已回复). Others' agents keep
   * theirs. Returns the deliveries that moved.
   */
  private actedIn(coworkId: string, threadId: string, me: string, via: Via, seq: number): CoworkDelivery[] {
    const agent = via.kind === "ai" ? (via.conv ?? null) : null;
    if (via.kind === "ai" && !agent) return [];
    const rows = (
      agent
        ? this.db.prepare("SELECT id FROM cowork_deliveries WHERE cowork_id = ? AND thread_id = ? AND owner = ? AND agent = ? AND state = 'delivered'").all(coworkId, threadId, me, agent)
        : this.db.prepare("SELECT id FROM cowork_deliveries WHERE cowork_id = ? AND thread_id = ? AND owner = ? AND state = 'delivered'").all(coworkId, threadId, me)
    ) as Row[];
    const at = this.now();
    for (const r of rows) this.db.prepare("UPDATE cowork_deliveries SET state = 'replied', replied_at = ?, reply_seq = ? WHERE id = ?").run(at, seq, String(r.id));
    return rows.map((r) => this.delivery(String(r.id)));
  }

  /**
   * After an action on a 子会话 (its event `message` written): whoever did it acted there (actedIn); marked done with a
   * note (标记完成：…), the note is its conclusion.
   */
  afterSessionAction(thread: Thread, message: Message, actor: string, action: string, note: unknown, via: unknown): { event: CoworkEvent | null; deliveries: CoworkDelivery[] } {
    const coworkId = thread.request?.coworkId;
    if (!coworkId) return { event: null, deliveries: [] };
    const n = typeof note === "string" ? note.trim().slice(0, COWORK_LIMITS.conclusion) : "";
    return this.store.tx(() => {
      const deliveries = this.actedIn(coworkId, thread.id, actor, checkVia(via), message.seq);
      if (action !== "done" || !n) return { event: null, deliveries };
      this.db.prepare("UPDATE threads SET cw_conclusion = ? WHERE id = ?").run(n, thread.id);
      return { event: this.event(coworkId, actor, checkVia(via), "decision", `「${thread.title}」：${n}`, { threadId: thread.id }), deliveries };
    });
  }

  /** What an agent (or a person) records: a commit pushed, a note. A commit's files mark reference cards 已过时. */
  addEvent(id: string, me: string, n: NewCoworkEvent): { event: CoworkEvent; board: { result: BoardOpsResult; events: CoworkEvent[] } | null } {
    const r = this.rowFor(id, me);
    this.writable(r);
    const via = checkVia(n?.via);
    const actor = this.actor(id, me, via);
    if (n.kind !== "commit" && n.kind !== "note") throw new RelayError("bad_request", "kind 要是 commit 或 note");
    const text = cleanText(n.text, "内容", COWORK_LIMITS.eventText);
    let commit: string | undefined;
    if (n.kind === "commit") {
      if (typeof n.commit !== "string" || !/^[0-9a-fA-F]{4,64}$/.test(n.commit.trim())) throw new RelayError("bad_request", "commit 要带提交号");
      commit = n.commit.trim().toLowerCase();
    }
    if (n.files !== undefined && !Array.isArray(n.files)) throw new RelayError("bad_request", "files 要是列表");
    const files = (n.files ?? []).filter((f): f is string => typeof f === "string" && !!f.trim() && f.length <= 500).map((f) => f.trim().replace(/\\/g, "/")).slice(0, COWORK_LIMITS.files);
    const event = this.event(id, me, via, n.kind, text, { ...(commit ? { commit } : {}), ...(files.length ? { files } : {}) });
    const stale = commit && files.length ? this.board.markStale(id, actor, commit, files, (t) => this.isSessionOf(id, t)) : null;
    return { event, board: stale ? { result: stale.result, events: this.bigEvents(id, actor, via, stale.big) } : null };
  }

  // ---- the board

  private isSessionOf(coworkId: string, threadId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM threads WHERE id = ? AND cowork_id = ?").get(threadId, coworkId);
  }

  private bigEvents(id: string, actor: BoardActor, via: Via, big: BoardBigChange[]): CoworkEvent[] {
    const what = (b: BoardBigChange) => {
      const named = b.item.text.split("\n")[0]!.slice(0, 40) || b.item.ref?.title || b.item.ref?.path;
      // A card with nothing written yet (a note just put up) goes by what it is, not by its kind's code (2026-11-23).
      const name = named ? `「${named}」` : `一张${BOARD_KIND_WORD[b.item.kind] ?? "卡"}`;
      return b.kind === "add" ? `在白板上加了${name}` : b.kind === "delete" ? `删了白板上的${name}` : `把白板上的${name}标成已过时`;
    };
    return big.map((b) => this.event(id, actor.name, via, "board", what(b), { cards: [b.item.id] }));
  }

  boardApply(id: string, me: string, b: { ops?: unknown; via?: unknown }): { result: BoardOpsResult; events: CoworkEvent[] } {
    const r = this.rowFor(id, me);
    this.writable(r);
    const via = checkVia(b?.via);
    const actor = this.actor(id, me, via);
    const out = this.board.apply(id, actor, b.ops, { checkSession: (t) => this.isSessionOf(id, t) });
    return { result: out.result, events: out.big.length ? this.store.tx(() => this.bigEvents(id, actor, via, out.big)) : [] };
  }

  boardSnapshot(id: string, me: string, after: unknown) {
    this.rowFor(id, me);
    return this.board.snapshot(id, after);
  }

  boardHistory(id: string, me: string, card: string) {
    this.rowFor(id, me);
    return this.board.history(id, card);
  }

  /** A person starts or stops writing a card's text (agents do not lock). */
  boardLock(id: string, me: string, b: { card?: unknown; on?: unknown; via?: unknown }) {
    const r = this.rowFor(id, me);
    if (b?.on !== false) this.writable(r);
    if (checkVia(b?.via).kind === "ai") throw new RelayError("forbidden", "AI 改卡片不用占着：直接发操作");
    return this.board.lock(id, me, b.card, b.on !== false);
  }

  boardPresence(id: string, me: string, p: { selected?: unknown; dragging?: unknown; open?: unknown }) {
    this.rowFor(id, me);
    return this.board.setPresence(id, me, p);
  }
}
