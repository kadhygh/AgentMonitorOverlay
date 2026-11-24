import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CoworkBoard, type BoardActor, type BoardBigChange } from "./cowork-board.js";
import { CoworkMatters, authorParty, cleanBindings, cleanBlocker, cleanCommits, cleanConclusion, cleanGate, cleanKind, cleanStatus, cleanTitle, partyOf, type CoworkTouched } from "./cowork-matters.js";
import {
  AGENT_ROLE_LABEL,
  AGENT_STALE_MS,
  AGENT_STREAK_MAX,
  COWORK_LIMITS,
  DEFAULT_COWORK_OPTIONS,
  MATTER_EDIT_FIELDS,
  MATTER_LIMITS,
  MATTER_STATUS_LABEL,
  agentParty,
  canRewrite,
  isParty,
  leadTakenText,
  matterLockKey,
  matterLockText,
  parseCollabRef,
  parseParty,
  personParty,
  resolveAgentRef,
  roleAllows,
  seenByAgents,
  type AgentRole,
  type BoardLock,
  type CollabAction,
  type MatterLockKind,
  type CoworkMatterEvents,
  type MatterEvent,
  type MessageBasis,
  type CoworkMarkResult,
  type Matter,
  type MatterStatus,
  type NewCoworkMatter,
  type CoworkMatterPatch,
  type Party,
  type PendingList,
  type SupersedeResult,
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

/** A stored role: NULL (from before roles, or an older Studio's join) is 未分角色. */
const roleOfRow = (v: unknown): AgentRole => (v === "lead" ? "lead" : v === "worker" ? "worker" : "unassigned");
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
  /** 事项、回执、待我处理 (2026-11-24, cowork-matters.ts). */
  readonly matters: CoworkMatters;
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
    // 主控 / 执行 (2026-11-24, protocol/matters.ts): an agent's role and, for an 执行, its 事项. Agents from before (and
    // those an older Studio brings in without a role) have none: 未分角色 (NULL), doing what they did before until a person
    // picks one (2026-11-25, plans/collab-framework.md 「已有的协作、新旧版本混用」).
    const acols = (this.db.prepare("PRAGMA table_info(cowork_agents)").all() as Row[]).map((r) => String(r.name));
    if (!acols.includes("role")) this.db.exec("ALTER TABLE cowork_agents ADD COLUMN role TEXT; ALTER TABLE cowork_agents ADD COLUMN matter TEXT;");
    this.matters = new CoworkMatters(store, this.db, now);
    store.messageHook = (m) => this.decorate(m);
  }

  /** A message read anywhere: its 事项 and its receipts. */
  private decorate(m: Message): void {
    const receipts = this.matters.receipts(m.seq);
    if (receipts.length) m.receipts = receipts;
    if (this.matters.isMatter(m.threadId)) m.matter = m.threadId;
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
    return {
      mark: String(r.mark),
      owner,
      label: String(r.label),
      name: `${nicks.get(owner) ?? owner} 的 AI · ${String(r.label)}`,
      state,
      queued,
      lastSeen: reported,
      joinedAt: Number(r.joined_at),
      role: roleOfRow(r.role),
      matter: r.role === "worker" && r.matter != null ? String(r.matter) : null,
      matterNo: r.role === "worker" && r.matter != null ? (this.matters.get(String(r.matter))?.no ?? null) : null,
    };
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
      matters: this.matters.list(id),
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
    let threads = [id, ...this.sessionIds(id)];
    if (agentMark) {
      this.requireAgent(id, me, agentMark);
      // An 执行 reads its own 事项 only (the goal and 已定的事 come with the cowork and its events).
      const role = this.roleOf(id, agentMark);
      if (role.role === "worker") threads = role.matter ? [role.matter] : [];
    }
    const messages = this.store.messagesIn(threads, after, 500);
    const lastSeq = messages.length ? messages[messages.length - 1]!.seq : after;
    if (agentMark) {
      this.db.prepare("UPDATE cowork_agents SET read_seq = MAX(read_seq, ?) WHERE cowork_id = ? AND mark = ?").run(lastSeq, id, agentMark);
      this.store.tx(() => this.matters.seenSeqs(agentParty(agentMark), messages.map((m) => m.seq)));
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
    this.allow(id, via.kind === "ai" ? this.actor(id, me, via).agent : null, "matter-edit");
    const reopening = patch.ended === false && r.ended_at != null;
    if (!reopening) this.writable(r);
    const title = patch.title === undefined ? undefined : cleanText(patch.title, "标题", COWORK_LIMITS.title);
    const goal = patch.goal === undefined ? undefined : cleanText(patch.goal, "目标", COWORK_LIMITS.goal, false);
    const repo = patch.repo === undefined ? undefined : cleanText(patch.repo, "仓库", COWORK_LIMITS.repo, false);
    const branch = patch.branch === undefined ? undefined : cleanText(patch.branch, "分支", COWORK_LIMITS.branch, false);
    const was = this.view(id);
    // 「AI 发起 @ 和提问」 went (2026-11-24, 闸门 in its place): an old client's option is checked and left as it is.
    if (patch.options !== undefined) cleanOptions(patch.options, was.options);
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

  /** An agent's role in a cowork (one from before roles, or brought in by an older Studio: 未分角色). */
  private roleOf(coworkId: string, mark: string): { role: AgentRole; matter: string | null } {
    const r = this.db.prepare("SELECT role, matter FROM cowork_agents WHERE cowork_id = ? AND mark = ?").get(coworkId, mark) as Row | undefined;
    const role = roleOfRow(r?.role);
    return { role, matter: role === "worker" && r!.matter != null ? String(r!.matter) : null };
  }

  /** What an 执行 may not do (roleAllows) is refused with why; people, 主控 and 未分角色 pass. */
  private allow(coworkId: string, agent: string | null, action: CollabAction, matter?: string | null): void {
    if (!agent) return;
    const r = this.roleOf(coworkId, agent);
    if (r.role !== "worker" || roleAllows(r.role, action, { own: r.matter, matter: matter ?? null })) return;
    const own = r.matter ? this.matters.get(r.matter) : null;
    const where = own ? `事项 ${own.no}「${own.title}」` : "还没绑定事项";
    const what: Partial<Record<CollabAction, string>> = { "chat-post": "在群聊里发言", "matter-post": "在别的事项里发言", "mention-person": "@ 人", conclude: "定结论", "matter-edit": "改事项和协作", "matter-open": "开事项或发起子会话", "board-write": "改白板", "read-all": "读群聊和别的事项" };
    throw new RelayError("forbidden", `你是执行（${where}），不能${what[action] ?? "做这件事"}：执行只在自己的事项里贴事实、问 AI（@ 对方的主控或执行，不 @ 人），状态和结论由主控来改；要说什么，在事项里告诉主控`);
  }

  private cleanRole(v: unknown): AgentRole {
    if (v !== "lead" && v !== "worker") throw new RelayError("bad_request", "role 要是 lead（主控）或 worker（执行）");
    return v;
  }

  /** One 主控 per side (refused saying who holds it); an 执行 names a 事项 of this cowork. */
  private checkRole(coworkId: string, me: string, mark: string, role: AgentRole, matter: string | null): void {
    if (role === "unassigned") return;
    if (role === "lead") {
      const holder = this.db.prepare("SELECT * FROM cowork_agents WHERE cowork_id = ? AND owner = ? AND role = 'lead' AND left_at IS NULL AND mark <> ?").get(coworkId, me, mark) as Row | undefined;
      if (holder) throw new RelayError("conflict", leadTakenText(this.nicks().get(me) ?? me, this.agentOf(holder).name));
      return;
    }
    if (!matter) throw new RelayError("bad_request", "执行要绑定一件事项（matter：事项的 id）");
    this.matters.require(coworkId, matter);
  }

  private roleWord(role: AgentRole, matter: string | null): string {
    const m = matter ? this.matters.get(matter) : null;
    return role === "worker" && m ? `${AGENT_ROLE_LABEL.worker} · 事项 ${m.no}` : AGENT_ROLE_LABEL[role];
  }

  /**
   * 拉进协作: one of my sessions, by its mark, shown as 「<me> 的 AI · <label>」, as its side's 主控 (one per side) or an
   * 执行 of one 事项. Again (or again after leaving): its label, and its role when given, are updated. No role: it keeps
   * the one it has; a new one is 未分角色 — an older Studio sends none and must keep working (2026-11-25); a newer one
   * always sends one (its 拉进协作 asks which).
   */
  joinAgent(id: string, me: string, markValue: unknown, labelValue: unknown, roleValue?: unknown, matterValue?: unknown): { cowork: Cowork; agent: CoworkAgent; message: Message | null; events: CoworkEvent[] } {
    const r = this.rowFor(id, me);
    this.writable(r);
    const mark = cleanMark(markValue);
    const label = cleanText(labelValue, "会话名", COWORK_LIMITS.label, false) || "会话";
    const had = this.db.prepare("SELECT * FROM cowork_agents WHERE cowork_id = ? AND mark = ?").get(id, mark) as Row | undefined;
    if (had && String(had.owner) !== me) throw new RelayError("conflict", "这个 AI 会话是别人拉进来的");
    const active = !!had && had.left_at == null;
    const wasRole: AgentRole | null = active ? roleOfRow(had!.role) : null;
    const role: AgentRole = roleValue === undefined || roleValue === null ? (wasRole ?? "unassigned") : this.cleanRole(roleValue);
    const matter = role === "worker" ? (matterValue !== undefined && matterValue !== null && matterValue !== "" ? this.matterRef(id, matterValue).id : active && had!.matter != null ? String(had!.matter) : null) : null;
    this.checkRole(id, me, mark, role, matter);
    return this.store.tx(() => {
      const at = this.now();
      const stored = role === "unassigned" ? null : role;
      if (!had) this.db.prepare("INSERT INTO cowork_agents (cowork_id, mark, owner, label, joined_at, role, matter) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, mark, me, label, at, stored, matter);
      else this.db.prepare("UPDATE cowork_agents SET label = ?, role = ?, matter = ?, left_at = NULL, joined_at = CASE WHEN left_at IS NULL THEN joined_at ELSE ? END WHERE cowork_id = ? AND mark = ?").run(label, stored, matter, at, id, mark);
      if (matter) this.bindWorker(matter, mark, personParty(me));
      const agent = this.agent(id, mark)!;
      const changed = active && (wasRole !== role || (had!.matter == null ? null : String(had!.matter)) !== matter);
      if (active && !changed) return { cowork: this.view(id), agent, message: null, events: [] };
      const word = this.roleWord(role, matter);
      const text = active ? `把 ${agent.name} 改成了${word}` : `把 ${agent.name} 拉了进来（${word}）`;
      const message = this.store.insertMessage(id, me, { kind: "person" }, "event", text, null);
      const events = [this.event(id, me, { kind: "person" }, "agent", active ? `${agent.name} 改成了${word}` : `拉进了 ${agent.name}（${word}）`, { mark })];
      this.matters.touch(id);
      return { cowork: this.view(id), agent, message, events };
    });
  }

  /** An 执行's session is bound to its 事项. */
  private bindWorker(matterId: string, mark: string, by: Party): void {
    const m = this.matters.get(matterId);
    if (!m || m.bindings.sessions.includes(mark)) return;
    this.matters.fields(matterId, { bindings: { ...m.bindings, sessions: [...m.bindings.sessions, mark] } });
    this.matters.apply(matterId, { kind: "bind", at: this.now(), by, note: mark });
  }

  /** 改角色 (POST …/agents/role): the owner, in person or through the side's 主控 (a 未分角色 one may not: its person picks). */
  setRole(id: string, me: string, b: { mark?: unknown; role?: unknown; matter?: unknown; via?: unknown }): ReturnType<CoworkStore["joinAgent"]> {
    this.rowFor(id, me);
    const via = checkVia(b?.via);
    const by = this.actor(id, me, via).agent;
    if (by && this.roleOf(id, by).role !== "lead") throw new RelayError("forbidden", "只有主控或主人能改角色");
    const mark = cleanMark(b?.mark);
    const row = this.requireAgent(id, me, mark);
    return this.joinAgent(id, me, mark, String(row.label), b.role ?? null, b.matter);
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
  private afterMessage(thread: Thread, message: Message): { deliveries: CoworkDelivery[]; events: CoworkEvent[]; limit: string[] | null } {
    const coworkId = this.coworkOf(thread);
    if (!coworkId || message.kind === "event") return { deliveries: [], events: [], limit: null };
    let limit: string[] | null = null;
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
      // In a 事项 (2026-11-25, plans/collab-agent-spec.md 第 7 节): it turns 等人确认, waiting on the people whose AIs went on.
      if (streak === AGENT_STREAK_MAX && this.matters.isMatter(thread.id))
        limit = [
          ...new Set(
            (
              this.db
                .prepare("SELECT DISTINCT author FROM messages WHERE thread_id = ? AND seq <= ? AND kind <> 'event' AND json_extract(via, '$.kind') = 'ai' AND seq > COALESCE((SELECT MAX(seq) FROM messages WHERE thread_id = ? AND seq <= ? AND kind <> 'event' AND COALESCE(json_extract(via, '$.kind'), 'person') <> 'ai'), 0)")
                .all(thread.id, message.seq, thread.id, message.seq) as Row[]
            ).map((r) => String(r.author)),
          ),
        ];
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
    return { deliveries: changed.map((d) => this.delivery(d)), events, limit };
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
    // What the owner's Studio put into its sessions is 送到 for those agents (2026-11-24, receipts).
    if (out.length) this.store.tx(() => out.forEach((d) => this.matters.delivered(agentParty(d.agent), [d.seq])));
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
    return [...new Set(value.map((v) => this.agentRef(coworkId, v)))].filter((m) => m !== self);
  }

  /** An answer's 来源 (2026-11-25): confirmed with a person in the cowork (when, or which of 已定的事), or inferred. */
  private cleanBasis(coworkId: string, v: unknown): MessageBasis | null {
    if (v === undefined || v === null) return null;
    if (typeof v !== "object") throw new RelayError("bad_request", "basis 要是 { kind: confirmed | inferred, person, at?, decision? }");
    const b = v as Record<string, unknown>;
    const person = this.personRef(coworkId, b.person);
    if (b.kind === "inferred") return { kind: "inferred", person };
    if (b.kind !== "confirmed") throw new RelayError("bad_request", "basis.kind 要是 confirmed（和人确认过）或 inferred（我的判断）");
    const out: MessageBasis = { kind: "confirmed", person };
    if (b.at !== undefined && b.at !== null) {
      if (typeof b.at !== "number" || !Number.isFinite(b.at) || b.at <= 0) throw new RelayError("bad_request", "basis.at 要是确认的时间（毫秒）");
      out.at = b.at;
    }
    if (b.decision !== undefined && b.decision !== null) {
      if (typeof b.decision !== "number" || !Number.isInteger(b.decision) || b.decision < 1) throw new RelayError("bad_request", "basis.decision 要是已定的事的第几条（从 1 数）");
      out.decision = b.decision;
    }
    if (out.at === undefined && out.decision === undefined) throw new RelayError("bad_request", "和人确认过的，要写什么时候确认的（at）或已定的事第几条（decision）");
    return out;
  }

  private cleanVerify(v: unknown): { passed: boolean; how?: string } | null {
    if (v === undefined || v === null) return null;
    const o = v as Record<string, unknown>;
    if (typeof v !== "object" || typeof o.passed !== "boolean") throw new RelayError("bad_request", "verify 要是 { passed: true | false, how?: 怎么验的 }");
    const how = o.how === undefined || o.how === null ? "" : cleanText(o.how, "怎么验的", 500, false);
    return how ? { passed: o.passed, how } : { passed: o.passed };
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
    const inMatter = this.matters.isMatter(threadId);
    this.allow(coworkId, agent, inMatter ? "matter-post" : "chat-post", inMatter ? threadId : null);
    const agentMentions = this.cleanAgentMentions(coworkId, p.agentMentions, agent);
    let replyTo: number | undefined;
    if (p.replyTo !== undefined && p.replyTo !== null) {
      const m = this.store.messageBySeq(this.seqRef(p.replyTo, "replyTo"));
      if (!m || (m.threadId !== coworkId && !this.sessionIds(coworkId).includes(m.threadId))) throw new RelayError("bad_request", "replyTo 要是这个协作里的一条消息（seq 或「#7」）");
      replyTo = m.seq;
    }
    if (p.mentions !== undefined && p.mentions !== null && !Array.isArray(p.mentions)) throw new RelayError("bad_request", "mentions 要是列表");
    const mentions = [...new Set((p.mentions ?? []).map((n) => this.personRef(coworkId, n)))].filter((n) => n !== me);
    const outside = mentions.filter((n) => !thread.members.includes(n));
    if (outside.length) throw new RelayError("bad_request", `${outside.join("、")} 不在这个协作里，先把他们拉进来`);
    if (mentions.length) this.allow(coworkId, agent, "mention-person");
    // 知会 · 要某人看过 (2026-11-25): in their 待我处理 until they mark it 看过了.
    if (p.notice !== undefined && p.notice !== null && !Array.isArray(p.notice)) throw new RelayError("bad_request", "notice 要是人的列表");
    const notice = [...new Set((p.notice ?? []).map((n) => this.personRef(coworkId, n)))].filter((n) => n !== me);
    if (notice.length) this.allow(coworkId, agent, "mention-person");
    const basis = this.cleanBasis(coworkId, p.basis);
    const commits = p.commits === undefined || p.commits === null ? [] : cleanCommits(p.commits);
    const verify = this.cleanVerify(p.verify);
    // 被 #x 取代 (2026-11-24): my earlier message this one replaces.
    let supersedes: Message | null = null;
    if (p.supersedes !== undefined && p.supersedes !== null) {
      const old = this.store.messageBySeq(this.seqRef(p.supersedes, "supersedes"));
      if (!old || !this.inCowork(coworkId, old.threadId) || old.kind === "event") throw new RelayError("bad_request", "supersedes 要是这个协作里的一条消息（seq）");
      if (!this.mine(old, me, via)) throw new RelayError("forbidden", "只能取代自己发的消息");
      if (old.withdrawnAt || old.supersededBy) throw new RelayError("conflict", `#${old.seq} 已经撤回或被取代了`);
      supersedes = old;
    }
    // No drafts any more (2026-11-24): 「AI 发起 @ 和提问」 went; a 主控 opens a 「等人确认」 事项 before a 闸门 instead.
    // An agent answering without saying what: the latest thing it was given in this thread.
    if (agent && replyTo === undefined) {
      const last = this.db.prepare("SELECT seq FROM cowork_deliveries WHERE cowork_id = ? AND agent = ? AND thread_id = ? AND state = 'delivered' ORDER BY seq DESC LIMIT 1").get(coworkId, agent, threadId) as Row | undefined;
      if (last) replyTo = Number(last.seq);
    }
    const more: Partial<Message> = {};
    if (agentMentions.length) more.agentMentions = agentMentions;
    if (replyTo) more.replyTo = replyTo;
    if (notice.length) more.notice = notice;
    if (basis) more.basis = basis;
    if (commits.length) more.commits = commits;
    if (verify) more.verify = verify;
    if (approved) {
      more.approvedBy = me;
      if (approved.edited) more.edited = true;
    }
    const out = this.store.addMessage(threadId, me, { ...p, mentions, via }, more);
    const party = partyOf(me, via);
    const after = this.store.tx(() => {
      const res = this.afterMessage(out.thread, out.message);
      this.matters.receive(coworkId, out.message, this.people(coworkId));
      if (res.limit) this.limitReached(coworkId, out.thread, out.message, res.limit);
      // 处理了 with the reply (the user 11-24: AI 随回复标): what it answers, what it names, or (true) all to it here.
      if (replyTo) this.matters.advance(replyTo, party, "handled");
      if (Array.isArray(p.handled)) for (const s of p.handled.slice(0, 200)) if (typeof s === "number") this.matters.advance(s, party, "handled");
      if (p.handled === true) this.matters.handledInThread(threadId, party, out.message.seq - 1);
      let superseded: SupersedeResult | undefined;
      if (supersedes) {
        this.matters.setMessage(supersedes.seq, { supersededBy: out.message.seq });
        superseded = { seq: supersedes.seq, supersededBy: out.message.seq, seenByAgents: seenByAgents(this.matters.receipts(supersedes.seq)) };
      }
      this.syncFromSession(threadId, party);
      return { ...res, superseded };
    });
    const message = this.store.messageBySeq(out.message.seq)!;
    return { thread: this.store.threadById(threadId), message, deliveries: after.deliveries, events: after.events, ...(after.superseded ? { superseded: after.superseded } : {}) };
  }

  private inCowork(coworkId: string, threadId: string): boolean {
    return threadId === coworkId || this.isSessionOf(coworkId, threadId);
  }

  /** My message: written by me, and through my agent only when that agent wrote it. */
  private mine(m: Message, me: string, via: Via): boolean {
    return m.author === me && (via.kind !== "ai" || (m.via.kind === "ai" && m.via.conv === via.conv));
  }

  /**
   * A 子会话 was marked done (标记完成) or opened again: its 事项 closes (with the 子会话's conclusion, if any) or opens again
   * (2026-11-25: the rest follows from its messages, matterMessageEvent).
   */
  private syncFromSession(threadId: string, by: Party): void {
    const m = this.matters.get(threadId);
    const r = this.store.threadById(threadId).request;
    if (!m || !r) return;
    const at = this.now();
    if (r.state === "done" && m.status !== "closed") this.matters.apply(threadId, { kind: "conclude", at, by, conclusion: r.conclusion ?? null, note: "标记完成" });
    else if (r.state !== "done" && m.status === "closed") this.matters.apply(threadId, { kind: "manual", at, by, status: "doing", note: "重新打开" });
  }

  /**
   * Two AIs went back and forth AGENT_STREAK_MAX times in a 事项 with no person (2026-11-25): it turns 等人确认, waiting on
   * the people whose AIs they are (its AIs get nothing more from it until a person says something there), and the 群聊 says
   * so in a line.
   */
  private limitReached(coworkId: string, thread: Thread, message: Message, owners: string[]): void {
    const m = this.matters.get(thread.id);
    if (!m) return;
    this.matters.apply(m.id, { kind: "limit", at: this.now(), by: authorParty(message), seq: message.seq, to: owners.map(personParty) });
    const nicks = this.nicks();
    const who = owners.map((o) => nicks.get(o) ?? o).join("、");
    const line = this.store.insertMessage(coworkId, message.author, message.via, "event", `事项 ${m.no}「${m.title}」里 AI 之间来回了 ${AGENT_STREAK_MAX} 条，没有人说话：停下来等 ${who} 看一下，AI 先不再被叫醒`, null);
    this.matters.posted(line.seq);
  }

  /** A new 子会话 in the cowork, asked of a person in it; its card goes into the 群聊. From an agent while 「AI 发起 @ 和提问」
   * is off: a draft for its owner. */
  ask(coworkId: string, me: string, n: NewCoworkSession, approved?: { edited: boolean }): CoworkAskResult & { card?: { thread: Thread; message: Message } } {
    const r = this.rowFor(coworkId, me);
    this.writable(r);
    const via = checkVia(n?.via);
    const agent = this.actor(coworkId, me, via).agent;
    this.allow(coworkId, agent, "matter-open");
    const to = checkName(n.to);
    const people = this.people(coworkId);
    if (!people.includes(to)) throw new RelayError("bad_request", `${to} 不在这个协作里，先把他拉进来`);
    // A 子会话 is a 事项 (2026-11-24): asked of a person, it waits on them — 等人确认 (an agent's is a 闸门's). No drafts.
    const out = this.store.createRequest(me, { to, title: n.title, body: n.body, questions: n.questions, files: n.files, via, needsReply: true }, { id: coworkId, members: people, agent });
    const owner = partyOf(me, via);
    const card = this.store.tx(() => {
      const at = this.now();
      this.matters.insert({ id: out.thread.id, coworkId, kind: agent ? "confirm" : "work", owner, side: me, gate: null, blocker: null, dependsOn: [], at }, { kind: "open", at, by: owner, status: "confirm", to: [personParty(to)], seq: out.message.seq });
      this.matters.receive(coworkId, out.message, people);
      const extra: Partial<Message> = { session: out.thread.id };
      if (approved) {
        extra.approvedBy = me;
        if (approved.edited) extra.edited = true;
      }
      const message = this.store.insertMessage(coworkId, me, via, "event", `发起子会话「${out.thread.title}」→ ${to}`, extra);
      this.db.prepare("UPDATE coworks SET updated_at = ? WHERE id = ?").run(this.now(), coworkId);
      return { thread: this.store.threadById(coworkId), message };
    });
    return { thread: this.store.threadById(out.thread.id), message: this.store.messageBySeq(out.message.seq)!, card };
  }

  /**
   * 开事项 (POST …/matters, 2026-11-24): a 主控 or a person opens one — its thread (every person in the cowork is in it;
   * nobody is asked), its first message, its card in the 群聊. An 执行 may not.
   */
  openMatter(coworkId: string, me: string, n: NewCoworkMatter): { matter: Matter; thread: Thread; message: Message; card: { thread: Thread; message: Message } } {
    const r = this.rowFor(coworkId, me);
    this.writable(r);
    const via = checkVia(n?.via);
    const agent = this.actor(coworkId, me, via).agent;
    this.allow(coworkId, agent, "matter-open");
    const title = cleanTitle(n?.title);
    const body = cleanText(n.body, "正文", 200_000);
    const people = this.people(coworkId);
    const side = n.side === undefined || n.side === null ? me : checkName(n.side);
    if (!people.includes(side)) throw new RelayError("bad_request", `负责方 ${side} 不在这个协作里`);
    const kind = n.kind === undefined ? "work" : cleanKind(n.kind);
    const gate = cleanGate(n.gate);
    const status = n.status === undefined ? (kind === "confirm" ? "confirm" : "todo") : cleanStatus(n.status);
    const waitingOn = this.checkWaiting(coworkId, n.waitingOn);
    const dependsOn = this.checkDepends(coworkId, n.dependsOn, null);
    const blocker = cleanBlocker(n.blocker);
    const owner = partyOf(me, via);
    if (agent && side !== me) throw new RelayError("forbidden", "AI 只能给自己这一方开事项：要对方做，开在自己这一方、在等谁写对方主控");
    return this.store.tx(() => {
      const id = `t_${randomBytes(8).toString("hex")}`;
      const at = this.now();
      this.db
        .prepare("INSERT INTO threads (id, kind, title, created_by, created_at, updated_at, req_from, req_to, req_status, s_state, s_waiting, s_handler, s_needs, cowork_id, cw_agent) VALUES (?, 'request', ?, ?, ?, ?, ?, ?, 'open', 'open', NULL, ?, 0, ?, ?)")
        .run(id, title, me, at, at, me, me, agent ? "ai" : "person", coworkId, agent);
      for (const p of people) this.db.prepare("INSERT INTO thread_members (thread_id, name) VALUES (?, ?)").run(id, p);
      const message = this.store.insertMessage(id, me, via, "request", body, null);
      this.db.prepare("UPDATE threads SET req_seq = ?, s_qseq = NULL WHERE id = ?").run(message.seq, id);
      this.matters.insert({ id, coworkId, kind, owner, side, gate, blocker, dependsOn, at }, { kind: "open", at, by: owner, status, to: waitingOn, seq: message.seq });
      this.matters.receive(coworkId, message, people);
      const matter = this.matters.get(id)!;
      const cardMessage = this.store.insertMessage(coworkId, me, via, "event", `开了事项 ${matter.no}「${title}」（${MATTER_STATUS_LABEL[matter.status]}）`, { session: id });
      this.db.prepare("UPDATE coworks SET updated_at = ? WHERE id = ?").run(at, coworkId);
      return { matter, thread: this.store.threadById(id), message: this.store.messageBySeq(message.seq)!, card: { thread: this.store.threadById(coworkId), message: cardMessage } };
    });
  }

  /** 在等谁: people in the cowork or agents in it now — as parties, account names, nicknames or agents' names. */
  private checkWaiting(coworkId: string, v: unknown): Party[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new RelayError("bad_request", "在等谁要是列表");
    if (v.length > MATTER_LIMITS.waitingOn) throw new RelayError("bad_request", `在等谁最多 ${MATTER_LIMITS.waitingOn} 个`);
    return [...new Set(v.map((x) => this.partyRef(coworkId, x)))];
  }

  /** 依赖: other 事项 of this cowork (ids or 「事项 3」). */
  private checkDepends(coworkId: string, v: unknown, self: string | null): string[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > MATTER_LIMITS.dependsOn) throw new RelayError("bad_request", `依赖要是事项的列表（最多 ${MATTER_LIMITS.dependsOn} 个）`);
    const out = [...new Set(v.map((d) => this.matterRef(coworkId, d).id))];
    if (self && out.includes(self)) throw new RelayError("bad_request", "事项不能依赖自己");
    return out;
  }

  /**
   * 改事项 (PATCH …/matters/:id): a 主控 or a person (an 执行 may not). `base`: the version it was read at; an older one is
   * refused so two 主控 do not overwrite each other unseen. Status and 在等谁 are a hand change (a "manual" event, written
   * into the 事项's thread too); a conclusion closes it (a "conclude" event) and goes into 已定的事; closed, everything in
   * it is 处理了. A 子会话 asked of a person closes (标记完成) or opens again with it. `place`: a person dragged its card.
   */
  patchMatter(coworkId: string, matterRef: string, me: string, b: CoworkMatterPatch): { matter: Matter; message: Message | null; events: CoworkEvent[] } {
    const r = this.rowFor(coworkId, me);
    this.writable(r);
    const via = checkVia(b?.via);
    const agent = this.actor(coworkId, me, via).agent;
    const m = this.matterRef(coworkId, matterRef);
    const matterId = m.id;
    const onlyPlace = b.place !== undefined && Object.keys(b).every((k) => k === "place" || k === "placeBase" || k === "via" || k === "base");
    if (b.place !== undefined && agent) throw new RelayError("forbidden", "事项卡的位置只由人拖：AI 不用摆它（客户端按负责方和状态排）");
    if (!onlyPlace) this.allow(coworkId, agent, "matter-edit");
    // Locks (2026-11-25, the user: 「a 在拖拽卡 b 就不拖拽」): someone else dragging its card, or with its judgement fields
    // open, wins; an AI does not change those fields while anyone has them open. The 409 carries the 事项 as it is now.
    const nick = (n: string) => this.nicks().get(n) ?? n;
    const placeLock = this.board.lockOf(coworkId, matterLockKey("place", matterId));
    if (b.place !== undefined && placeLock && placeLock.by !== me) throw new RelayError("conflict", `${matterLockText("place", nick(placeLock.by))}这张事项卡`, { lock: placeLock, matter: m });
    if (b.place !== undefined && typeof b.placeBase === "number" && b.placeBase !== m.placeVersion) throw new RelayError("conflict", `事项 ${m.no} 的卡在你拖之前被挪过了：回到现在的位置`, { matter: m });
    const editLock = this.board.lockOf(coworkId, matterLockKey("edit", matterId));
    const judging = MATTER_EDIT_FIELDS.some((k) => b[k] !== undefined);
    if (judging && editLock && (agent || editLock.by !== me)) throw new RelayError("conflict", `${matterLockText("edit", nick(editLock.by))}事项 ${m.no}：等他改完再改`, { lock: editLock, matter: m });
    if (!onlyPlace && typeof b.base === "number" && b.base !== m.version) throw new RelayError("conflict", `事项 ${m.no} 在你读过之后改过了（你读的是第 ${b.base} 版，现在是第 ${m.version} 版）：先重新读再改`, { matter: m });
    const place = b.place === undefined ? undefined : this.cleanPlace(b.place);
    const title = b.title === undefined ? undefined : cleanTitle(b.title);
    const status = b.status === undefined ? undefined : cleanStatus(b.status);
    const note = typeof b.note === "string" ? b.note.trim().slice(0, 200) : undefined;
    const side = b.side === undefined ? undefined : this.personRef(coworkId, b.side);
    const waitingOn = b.waitingOn === undefined ? undefined : this.checkWaiting(coworkId, b.waitingOn);
    const blocker = b.blocker === undefined ? undefined : cleanBlocker(b.blocker);
    const dependsOn = b.dependsOn === undefined ? undefined : this.checkDepends(coworkId, b.dependsOn, matterId);
    const gate = b.gate === undefined ? undefined : cleanGate(b.gate);
    const conclusion = b.conclusion === undefined ? undefined : cleanConclusion(b.conclusion);
    const add = cleanBindings(b.bind);
    const drop = cleanBindings(b.unbind);
    const bindings = { ...m.bindings };
    for (const k of ["sessions", "tasks", "commits"] as const) bindings[k] = [...new Set([...bindings[k], ...(add[k] ?? [])])].filter((x) => !(drop[k] ?? []).includes(x));
    const by = partyOf(me, via);
    return this.store.tx(() => {
      const at = this.now();
      if (place !== undefined) {
        this.matters.place(matterId, place);
        // Dropped: the drag's lock goes with it.
        if (placeLock?.by === me) this.board.hold(coworkId, me, matterLockKey("place", matterId), false, () => "");
      }
      if (title !== undefined && title !== m.title) {
        this.db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(title, matterId);
        this.matters.bump(matterId);
      }
      this.matters.fields(matterId, { side, blocker, dependsOn, gate, bindings });
      for (const s of add.sessions ?? []) if (!m.bindings.sessions.includes(s)) this.matters.apply(matterId, { kind: "bind", at, by, note: s });
      if (add.commits?.length) this.matters.apply(matterId, { kind: "push", at, by, commits: add.commits });
      const events: CoworkEvent[] = [];
      let message: Message | null = null;
      const concluding = conclusion !== undefined && conclusion !== null && conclusion !== m.conclusion;
      if ((status !== undefined && !(status === "closed" && concluding)) || waitingOn !== undefined) {
        const was = this.matters.get(matterId)!.status;
        const out = this.matters.apply(matterId, { kind: "manual", at, by, ...(status !== undefined ? { status } : {}), ...(waitingOn !== undefined ? { to: waitingOn } : {}), ...(note ? { note } : {}) });
        if (out.matter.status !== was) message = this.store.insertMessage(matterId, me, via, "event", `事项 ${m.no}：${MATTER_STATUS_LABEL[was]} → ${MATTER_STATUS_LABEL[out.matter.status]}（${status !== undefined ? "手改" : "改了在等谁"}${note ? `：${note}` : ""}）`, null);
      }
      if (concluding) {
        this.matters.apply(matterId, { kind: "conclude", at, by, conclusion, ...(note ? { note } : {}) });
        this.db.prepare("UPDATE threads SET cw_conclusion = ? WHERE id = ?").run(conclusion, matterId);
        events.push(this.event(coworkId, me, via, "decision", `「${title ?? m.title}」：${conclusion}`, { threadId: matterId }));
      }
      // A 子会话 asked of a person goes with it: closed is 标记完成, opened again is back with the one asked.
      const now = this.matters.get(matterId)!;
      const t = this.store.threadById(matterId).request!;
      if (t.from !== t.to && now.status !== m.status) {
        if (now.status === "closed" && t.state !== "done") this.db.prepare("UPDATE threads SET s_state = 'done', s_waiting = NULL WHERE id = ?").run(matterId);
        else if (now.status !== "closed" && t.state === "done") this.db.prepare("UPDATE threads SET s_state = ?, s_waiting = ? WHERE id = ?").run(now.status === "confirm" ? "open" : "returned", now.status === "confirm" ? t.to : t.from, matterId);
      }
      this.db.prepare("UPDATE coworks SET updated_at = ? WHERE id = ?").run(at, coworkId);
      return { matter: this.matters.get(matterId)!, message, events };
    });
  }

  /**
   * A person starts (or goes on) dragging a 事项卡 (`place`) or has its judgement fields open (`edit`), or stops (on false).
   * Taken by someone else: 409 「小王正在移动」 / 「老李正在改」 with the lock. AIs take no locks. Pushed as board-lock
   * (card = 「place:<id>」 / 「edit:<id>」); the board's snapshot lists them with its cards' locks.
   */
  lockMatter(coworkId: string, me: string, matterRef: string, b: { what?: unknown; on?: unknown; via?: unknown }): { key: string; lock: BoardLock | null } {
    const r = this.rowFor(coworkId, me);
    if (b?.on !== false) this.writable(r);
    if (this.actor(coworkId, me, checkVia(b?.via)).agent) throw new RelayError("forbidden", "AI 不拿锁：拖事项卡、打开事项的编辑框是人的事");
    if (b?.what !== "place" && b?.what !== "edit") throw new RelayError("bad_request", "what 要是 place（拖事项卡）或 edit（改事项）");
    const m = this.matterRef(coworkId, matterRef);
    const what = b.what as MatterLockKind;
    if (b.on !== false && what === "edit" && m.status === "closed") throw new RelayError("conflict", `事项 ${m.no} 已经关了`, { matter: m });
    const key = matterLockKey(what, m.id);
    const nick = (n: string) => this.nicks().get(n) ?? n;
    try {
      return { key, lock: this.board.hold(coworkId, me, key, b.on !== false, (by) => `${matterLockText(what, nick(by))}${what === "place" ? "这张事项卡" : `事项 ${m.no}`}`) };
    } catch (e) {
      if (e instanceof RelayError && e.data) throw new RelayError(e.code, e.message, { ...e.data, matter: m });
      throw e;
    }
  }

  private cleanPlace(v: unknown): { x: number; y: number } | null {
    if (v === null) return null;
    const o = v as Record<string, unknown>;
    const ok = (n: unknown) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e7;
    if (typeof v !== "object" || !ok(o.x) || !ok(o.y)) throw new RelayError("bad_request", "place 要是 { x, y }（白板上的坐标），或 null");
    return { x: Math.round(o.x as number), y: Math.round(o.y as number) };
  }

  /** What happened in a 事项 (GET …/matters/:id/events); an 执行 reads its own only. */
  matterEvents(coworkId: string, me: string, ref: string, agent?: string | null): CoworkMatterEvents {
    this.rowFor(coworkId, me);
    const m = this.matterRef(coworkId, ref);
    if (agent) {
      this.requireAgent(coworkId, me, agent);
      const role = this.roleOf(coworkId, agent);
      if (role.role === "worker" && role.matter !== m.id) this.allow(coworkId, agent, "read-all");
    }
    return { matter: m, events: this.matters.events(m.id) };
  }

  // ---- 指代 (2026-11-25, plans/collab-agent-spec.md 第 3 节: 「事项 3」、「#7」、显示名、复制来的整行)

  /** A 事项: its id, 「事项 3」, its number, or a copied line naming its thread. */
  matterRef(coworkId: string, v: unknown): Matter {
    const byNo = (no: number) => {
      const m = this.matters.byNo(coworkId, no);
      if (!m) throw new RelayError("not_found", `这个协作里没有事项 ${no}`);
      return m;
    };
    if (typeof v === "number" && Number.isInteger(v) && v > 0) return byNo(v);
    if (typeof v !== "string" || !v.trim()) throw new RelayError("bad_request", "要说是哪件事项：「事项 3」或它的 id");
    const t = v.trim();
    if (/^\d{1,9}$/.test(t)) return byNo(Number(t));
    const r = parseCollabRef(t);
    if (r?.kind === "matter") return byNo(r.no);
    if (r?.kind === "thread") return this.matters.require(coworkId, r.id);
    throw new RelayError("bad_request", `「${t.slice(0, 60)}」不是一件事项：写「事项 3」或它的 id`);
  }

  /** Where a message goes: the 群聊 (nothing, 「群聊」 or the cowork's id), a 事项 or a 子会话 of it. */
  threadRef(coworkId: string, me: string, v: unknown): string {
    if (v === undefined || v === null || v === "" || v === coworkId || v === "群聊") return coworkId;
    if (typeof v === "string") {
      const r = parseCollabRef(v);
      if (r?.kind === "thread" && r.id === coworkId) return coworkId;
      if (r?.kind === "thread" && this.store.thread(r.id, me).request?.coworkId === coworkId) return r.id;
    }
    return this.matterRef(coworkId, v).id;
  }

  /** A message: its seq or 「#7」 (also a copied 「#7（协作…）」). */
  private seqRef(v: unknown, what: string): number {
    if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
    if (typeof v === "string") {
      const t = v.trim();
      if (/^\d{1,15}$/.test(t)) return Number(t);
      const r = parseCollabRef(t);
      if (r?.kind === "seq") return r.seq;
    }
    throw new RelayError("bad_request", `${what} 要是一条消息：seq 或「#7」`);
  }

  /** A person in the cowork: account name or nickname. */
  private personRef(coworkId: string, v: unknown): string {
    if (typeof v !== "string" || !v.trim()) throw new RelayError("bad_request", "要写人的账号或昵称");
    const t = v.trim().replace(/^@/, "").replace(/^person:/, "");
    const people = this.people(coworkId);
    if (people.includes(t)) return t;
    const nicks = this.nicks();
    const hit = people.filter((p) => nicks.get(p) === t);
    if (hit.length === 1) return hit[0]!;
    throw new RelayError("bad_request", `${t} 不在这个协作里，先把他们拉进来`);
  }

  /** An agent in the cowork now: its mark, `agent:<mark>`, or its name (「老李的主控」, 「事项 3 的执行」, its label). */
  private agentRef(coworkId: string, v: unknown): string {
    if (typeof v !== "string" || !v.trim()) throw new RelayError("bad_request", "要写 AI 的标记或名字");
    const t = v.trim().replace(/^@/, "");
    if (this.agent(coworkId, t.replace(/^agent:/, ""))) return t.replace(/^agent:/, "");
    const nicks = this.nicks();
    const agents = this.view(coworkId).agents.map((a) => ({ mark: a.mark, name: a.name, label: a.label, owner: a.owner, ownerNick: nicks.get(a.owner), role: a.role ?? "unassigned", matterNo: a.matterNo ?? null }));
    const hit = resolveAgentRef(t, agents);
    if (hit.length === 1) return hit[0]!;
    if (hit.length > 1) throw new RelayError("bad_request", `「${t}」能指好几个 AI：${hit.map((h) => agents.find((a) => a.mark === h)!.name).join("、")}；用更具体的名字或标记`);
    throw new RelayError("bad_request", `${t} 不是这个协作里的 AI`);
  }

  /** 在等谁 and the like: a party (`person:` / `agent:`), or a person's or agent's name. */
  private partyRef(coworkId: string, v: unknown): Party {
    if (isParty(v)) {
      const w = parseParty(v)!;
      if (w.kind === "person" ? !this.people(coworkId).includes(w.name) : !this.agent(coworkId, w.mark)) throw new RelayError("bad_request", `在等的 ${v} 不在这个协作里`);
      return v;
    }
    try {
      return personParty(this.personRef(coworkId, v));
    } catch {
      try {
        return agentParty(this.agentRef(coworkId, v));
      } catch {
        throw new RelayError("bad_request", `在等的「${String(v)}」不在这个协作里：人写账号或昵称，AI 写名字或标记`);
      }
    }
  }

  /** 看过 / 处理了 (POST …/marks): mine, or my agent's (`via`). */
  marks(coworkId: string, me: string, b: { mark?: unknown; seqs?: unknown; matter?: unknown; upTo?: unknown; via?: unknown }): CoworkMarkResult {
    this.rowFor(coworkId, me);
    const via = checkVia(b?.via);
    this.actor(coworkId, me, via);
    if (b.mark !== "seen" && b.mark !== "handled") throw new RelayError("bad_request", "mark 要是 seen（看过）或 handled（处理了）");
    if (b.seqs !== undefined && b.seqs !== null && !Array.isArray(b.seqs)) throw new RelayError("bad_request", "seqs 要是消息编号的列表");
    const seqs = Array.isArray(b.seqs) ? b.seqs.map((x) => this.seqRef(x, "seqs")) : null;
    const matter = b.matter === undefined || b.matter === null || b.matter === "" ? null : this.matterRef(coworkId, b.matter).id;
    const upTo = typeof b.upTo === "number" ? b.upTo : null;
    return { changed: this.store.tx(() => this.matters.mark(coworkId, partyOf(me, via), b.mark as "seen" | "handled", seqs, matter, upTo)) };
  }

  /**
   * 撤回 (`withdraw`) or 原地改 my message (2026-11-24): only while no recipient has seen it (canRewrite); after that a new
   * message with `supersedes` replaces it. A withdrawn message keeps its place without its text; what it still had queued
   * for agents is dropped.
   */
  rewrite(coworkId: string, seqValue: unknown, me: string, b: { body?: unknown; via?: unknown }, withdraw: boolean): { message: Message; dropped: CoworkDelivery[] } {
    const r = this.rowFor(coworkId, me);
    this.writable(r);
    const via = checkVia(b?.via);
    this.actor(coworkId, me, via);
    const seq = Number(seqValue);
    const m = Number.isInteger(seq) ? this.store.messageBySeq(seq) : null;
    if (!m || !this.inCowork(coworkId, m.threadId)) throw new RelayError("not_found", `这个协作里没有这条消息：#${String(seqValue)}`);
    if (m.kind === "event") throw new RelayError("bad_request", "事件不能撤回或改");
    if (!this.mine(m, me, via)) throw new RelayError("forbidden", "只能撤回或改自己发的消息");
    if (m.withdrawnAt) throw new RelayError("conflict", `#${seq} 已经撤回了`);
    if (!canRewrite(this.matters.receipts(seq))) throw new RelayError("conflict", `#${seq} 已经有人看过了，不能再撤回或原地改：发一条新的消息取代它（supersedes: ${seq}）`);
    const body = withdraw ? "" : cleanText(b.body, "内容", 200_000);
    if (!withdraw && m.kind !== "text") throw new RelayError("bad_request", "只有文字消息能原地改");
    return this.store.tx(() => {
      const at = this.now();
      this.matters.setMessage(seq, withdraw ? { withdrawnAt: at } : { editedAt: at }, body);
      const dropped: CoworkDelivery[] = [];
      if (withdraw) {
        const ids = (this.db.prepare("SELECT id FROM cowork_deliveries WHERE cowork_id = ? AND seq = ? AND state = 'queued'").all(coworkId, seq) as Row[]).map((x) => String(x.id));
        this.db.prepare("UPDATE cowork_deliveries SET state = 'dropped' WHERE cowork_id = ? AND seq = ? AND state = 'queued'").run(coworkId, seq);
        dropped.push(...ids.map((d) => this.delivery(d)));
      }
      this.matters.touch(coworkId);
      return { message: this.store.messageBySeq(seq)!, dropped };
    });
  }

  /** A person read a cowork's thread up to `readSeq` (their client opened it): 看过. */
  readBy(thread: Thread, me: string, readSeq: number): void {
    if (!this.coworkOf(thread)) return;
    this.store.tx(() => this.matters.seenInThread(thread.id, personParty(me), readSeq));
  }

  /**
   * 待我处理 (GET /api/cowork/pending): mine (default) or my agent's (`agent:<mark>`), in one cowork or all I (it) am in.
   * What an agent's list holds counts as 送到 for it: its owner's Studio has it now.
   */
  pending(me: string, q: { coworkId?: string | null; party?: string | null }): Array<PendingList & { coworkId: string }> {
    const party: Party = q.party ? (isParty(q.party) ? q.party : (() => { throw new RelayError("bad_request", "party 要是 person:<账号> 或 agent:<会话标记>"); })()) : personParty(me);
    const who = parseParty(party)!;
    let ids: string[];
    if (who.kind === "person") {
      if (who.name !== me) throw new RelayError("forbidden", "只能看自己和自己的 AI 的待我处理");
      ids = q.coworkId ? [String(this.rowFor(q.coworkId, me).id)] : (this.db.prepare("SELECT c.id FROM coworks c JOIN thread_members tm ON tm.thread_id = c.id AND tm.name = ?").all(me) as Row[]).map((r) => String(r.id));
    } else {
      const rows = this.db.prepare("SELECT cowork_id, owner FROM cowork_agents WHERE mark = ? AND left_at IS NULL").all(who.mark) as Row[];
      if (rows.some((r) => String(r.owner) !== me)) throw new RelayError("forbidden", "只能看自己和自己的 AI 的待我处理");
      ids = rows.map((r) => String(r.cowork_id));
      if (q.coworkId) {
        if (!ids.includes(q.coworkId)) throw new RelayError("forbidden", "这个 AI 会话没有拉进这个协作（或已经离开了）：先让它的主人把它拉进来");
        ids = [q.coworkId];
      }
    }
    return this.store.tx(() => {
      const lists = ids.map((id) => this.matters.pending(id, party));
      if (who.kind === "agent") this.matters.delivered(party, lists.flatMap((l) => l.items.map((i) => i.seq).filter((s): s is number => s !== null)));
      return lists;
    });
  }

  /**
   * What the last call changed, for the service to push (server.ts): the 事项, receipts, rewritten messages, lines the
   * service wrote, and the 待我处理 that changed — one entry per participant whose version went up.
   */
  drain(): { touched: CoworkTouched; pending: Array<{ coworkId: string; party: Party; version: number; owner: string }> } {
    const touched = this.matters.drain();
    const pending: Array<{ coworkId: string; party: Party; version: number; owner: string }> = [];
    for (const c of touched.coworks) {
      if (!this.db.prepare("SELECT 1 FROM coworks WHERE id = ?").get(c)) continue;
      this.store.tx(() => {
        for (const party of this.matters.parties(c, this.people(c))) {
          const before = this.matters.pendingVersion(c, party);
          const list = this.matters.pending(c, party);
          const owner = this.matters.ownerOf(c, party);
          if (list.version !== before && owner) pending.push({ coworkId: c, party, version: list.version, owner });
        }
      });
    }
    return { touched, pending };
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
  conclude(coworkId: string, threadRef: string, me: string, b: { conclusion?: unknown; via?: unknown }): { thread: Thread; message: Message; event: CoworkEvent; cowork: Cowork; deliveries: CoworkDelivery[] } {
    const r = this.rowFor(coworkId, me);
    const threadId = this.threadRef(coworkId, me, threadRef);
    this.writable(r);
    const via = checkVia(b?.via);
    const agent = this.actor(coworkId, me, via).agent;
    this.allow(coworkId, agent, "conclude");
    const t = this.store.thread(threadId, me);
    if (t.request?.coworkId !== coworkId) throw new RelayError("bad_request", "这不是这个协作里的子会话");
    const matter = this.matters.get(threadId);
    // The asker, the one asked, or (2026-11-24) the 事项's 负责方.
    if (me !== t.request.from && me !== t.request.to && me !== matter?.side) throw new RelayError("forbidden", `结论由发起的 ${t.request.from} 或被问的 ${t.request.to}${matter && matter.side !== t.request.from ? ` 或负责的 ${matter.side}` : ""} 来定`);
    const conclusion = cleanText(b.conclusion, "结论", COWORK_LIMITS.conclusion);
    return this.store.tx(() => {
      this.db.prepare("UPDATE threads SET cw_conclusion = ?, s_state = 'done', s_waiting = NULL WHERE id = ?").run(conclusion, threadId);
      const message = this.store.insertMessage(threadId, me, via, "event", `定下结论：${conclusion}`, null);
      const event = this.event(coworkId, me, via, "decision", `「${t.title}」：${conclusion}`, { threadId });
      if (matter) this.matters.apply(threadId, { kind: "conclude", at: this.now(), by: partyOf(me, via), conclusion, note: "定下结论" });
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
      if (action !== "done" || !n) {
        this.syncFromSession(thread.id, partyOf(actor, checkVia(via)));
        return { event: null, deliveries };
      }
      this.db.prepare("UPDATE threads SET cw_conclusion = ? WHERE id = ?").run(n, thread.id);
      this.syncFromSession(thread.id, partyOf(actor, checkVia(via)));
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
    // The 事项 it is for (2026-11-25): named, or an 执行's own.
    const own = actor.agent ? this.roleOf(id, actor.agent) : null;
    const matter = n.matter !== undefined && n.matter !== null && n.matter !== "" ? this.matterRef(id, n.matter) : own?.role === "worker" && own.matter ? this.matters.get(own.matter) : null;
    const event = this.event(id, me, via, n.kind, text, { ...(commit ? { commit } : {}), ...(files.length ? { files } : {}), ...(matter ? { threadId: matter.id } : {}) });
    if (commit && matter) this.store.tx(() => this.matters.apply(matter.id, { kind: "push", at: this.now(), by: partyOf(me, via), commits: [commit], note: text.slice(0, 200) }));
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
    this.allow(id, actor.agent, "board-write");
    const out = this.board.apply(id, actor, b.ops, { checkSession: (t) => this.isSessionOf(id, t) });
    return { result: out.result, events: out.big.length ? this.store.tx(() => this.bigEvents(id, actor, via, out.big)) : [] };
  }

  /** The board; read for an 执行 (`agent`): no cards (its 事项's card is drawn from the 事项 it reads, the user 11-24/25). */
  boardSnapshot(id: string, me: string, after: unknown, agent?: string | null) {
    this.rowFor(id, me);
    const snap = this.board.snapshot(id, after);
    if (!agent) return snap;
    this.requireAgent(id, me, agent);
    if (this.roleOf(id, agent).role !== "worker") return snap;
    return { seq: snap.seq, full: true, items: [], locks: [] };
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
