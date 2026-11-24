import type { DatabaseSync } from "node:sqlite";
import {
  GATE_LABEL,
  MATTER_LIMITS,
  MATTER_QUIET_MS,
  MATTER_STATUSES,
  MATTER_STATUS_LABEL,
  advanceReceipt,
  agentParty,
  applyMatterEvent,
  isParty,
  matterMessageEvent,
  messageRecipients,
  parseParty,
  pendingFor,
  pendingKey,
  personParty,
  statusFromSession,
  type GateKind,
  type Matter,
  type MatterBindings,
  type MatterChange,
  type MatterEvent,
  type MatterKind,
  type MatterState,
  type MatterStatus,
  type Party,
  type PendingList,
  type PendingMessage,
  type Receipt,
  type ReceiptState,
} from "@amo-studio/protocol/matters";
import type { Message, Via } from "./protocol.js";
import { RelayError, type RelayStore } from "./store.js";

// 协作的事项、回执、待我处理 (2026-11-24, protocol/matters.ts, plans/collab-framework.md「11-24」): the records beside the
// cowork's (cowork.ts). A 事项 is a 子会话: its id is the request thread's, its title the thread's; the rest is here. Each
// message in a cowork's thread gets one receipt per recipient (messageRecipients); 待我处理 is computed from the 事项 and
// the receipts not yet 处理了, with a version per participant that goes up when the list changes.
//
// Status from events (2026-11-25, the user: 有更稳定的架构吗): what happens in a 事项 is kept as its events
// (cowork_matter_events); its status, who it waits on and why, its history are what applyMatterEvent adds them up to —
// kept in the row (`derived`) as they go, so reading never replays. A hand change is one more event.
//
// What changed in a call is noted (`touched`) and read again by the service afterwards to push it (server.ts
// coworkFlush): ids only, so a rolled-back change pushes the state as it is, never a state that was not kept.

type Row = Record<string, unknown>;

const KINDS = new Set<MatterKind>(["work", "confirm", "delegate", "notice"]);
const GATES = new Set<GateKind>(["red", "rules", "master", "others", "release"]);
const EMPTY_BINDINGS: MatterBindings = { sessions: [], tasks: [], commits: [] };

/** Who did something, as a participant: a person, or their agent (via ai with its mark). */
export const partyOf = (name: string, via: Via): Party => (via.kind === "ai" && via.conv ? agentParty(via.conv) : personParty(name));

/** A message's author as a participant. */
export const authorParty = (m: Pick<Message, "author" | "via">): Party => partyOf(m.author, m.via);

function json<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
}

function oneText(v: unknown, what: string, max: number): string {
  if (typeof v !== "string") throw new RelayError("bad_request", `${what} 要是文字`);
  const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (t.length > max) throw new RelayError("bad_request", `${what} 太长（最多 ${max} 字）`);
  return t;
}

export function cleanStatus(v: unknown): MatterStatus {
  if (typeof v !== "string" || !(MATTER_STATUSES as readonly string[]).includes(v)) throw new RelayError("bad_request", `状态要是 ${MATTER_STATUSES.join("、")} 之一`);
  return v as MatterStatus;
}

export function cleanKind(v: unknown): MatterKind {
  if (typeof v !== "string" || !KINDS.has(v as MatterKind)) throw new RelayError("bad_request", "kind 要是 work、confirm、delegate 或 notice");
  return v as MatterKind;
}

export function cleanGate(v: unknown): GateKind | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || !GATES.has(v as GateKind)) throw new RelayError("bad_request", `闸门要是 ${[...GATES].map((g) => `${g}（${GATE_LABEL[g]}）`).join("、")} 之一`);
  return v as GateKind;
}

export function cleanParties(v: unknown, what: string, max: number): Party[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new RelayError("bad_request", `${what} 要是列表`);
  if (v.length > max) throw new RelayError("bad_request", `${what} 最多 ${max} 个`);
  const out: Party[] = [];
  for (const p of v) {
    if (!isParty(p) || p.length > 120) throw new RelayError("bad_request", `${what} 里的「${String(p)}」不对：人写 person:<账号>，AI 写 agent:<会话标记>`);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

function cleanIds(v: unknown, what: string, max: number, re = /^[A-Za-z0-9_:.-]{1,120}$/): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new RelayError("bad_request", `${what} 要是列表`);
  const out = [...new Set(v.map((x) => (typeof x === "string" ? x.trim() : "")))];
  if (out.length > max) throw new RelayError("bad_request", `${what} 最多 ${max} 个`);
  for (const x of out) if (!re.test(x)) throw new RelayError("bad_request", `${what} 里的「${x}」不对`);
  return out;
}

/** Commit ids (4–64 hex), lower case. */
export const cleanCommits = (v: unknown, what = "提交号"): string[] => cleanIds(v, what, MATTER_LIMITS.bindings, /^[0-9a-fA-F]{4,64}$/).map((c) => c.toLowerCase());

export function cleanBindings(v: unknown): Partial<MatterBindings> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object") throw new RelayError("bad_request", "绑定要是 { sessions, tasks, commits }");
  const b = v as Record<string, unknown>;
  const out: Partial<MatterBindings> = {};
  if (b.sessions !== undefined) out.sessions = cleanIds(b.sessions, "绑定的执行会话", MATTER_LIMITS.bindings);
  if (b.tasks !== undefined) out.tasks = cleanIds(b.tasks, "绑定的任务", MATTER_LIMITS.bindings);
  if (b.commits !== undefined) out.commits = cleanCommits(b.commits, "绑定的提交");
  return out;
}

export function cleanBlocker(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return oneText(v, "卡在哪", MATTER_LIMITS.blocker) || null;
}

export function cleanConclusion(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return oneText(v, "结论", MATTER_LIMITS.conclusion) || null;
}

export function cleanTitle(v: unknown): string {
  const t = oneText(v, "标题", MATTER_LIMITS.title);
  if (!t) throw new RelayError("bad_request", "事项要有标题");
  return t;
}

/** What one call changed, for the service to push (read again then). */
export interface CoworkTouched {
  coworks: Set<string>;
  matters: Set<string>;
  /** Message seqs whose receipts moved. */
  receipts: Set<number>;
  /** Message seqs withdrawn, rewritten or superseded. */
  messages: Set<number>;
  /** Lines the service wrote itself (e.g. a 事项 reaching its AI limit, in the 群聊): announced like any message. */
  posted: Set<number>;
}

/** The plain fields of a 事项 (not worked out from events). */
export interface MatterFields {
  side?: string;
  blocker?: string | null;
  dependsOn?: string[];
  gate?: GateKind | null;
  bindings?: MatterBindings;
  kind?: MatterKind;
}

export class CoworkMatters {
  private touchedNow: CoworkTouched = CoworkMatters.fresh();

  private static fresh(): CoworkTouched {
    return { coworks: new Set(), matters: new Set(), receipts: new Set(), messages: new Set(), posted: new Set() };
  }

  constructor(
    private readonly store: RelayStore,
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cowork_matters (
        id TEXT PRIMARY KEY, cowork_id TEXT NOT NULL, no INTEGER NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL, side TEXT NOT NULL,
        status TEXT NOT NULL, waiting TEXT NOT NULL DEFAULT '[]', bindings TEXT, blocker TEXT, depends TEXT NOT NULL DEFAULT '[]',
        gate TEXT, conclusion TEXT, history TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS cowork_matters_cowork ON cowork_matters(cowork_id, no);
      CREATE TABLE IF NOT EXISTS cowork_matter_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, matter_id TEXT NOT NULL, at INTEGER NOT NULL, event TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cowork_matter_events_matter ON cowork_matter_events(matter_id, id);
      CREATE TABLE IF NOT EXISTS cowork_receipts (
        seq INTEGER NOT NULL, party TEXT NOT NULL, cowork_id TEXT NOT NULL, thread_id TEXT NOT NULL, state TEXT NOT NULL,
        queued_at INTEGER NOT NULL, delivered_at INTEGER, seen_at INTEGER, handled_at INTEGER, by_close INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (seq, party)
      );
      CREATE INDEX IF NOT EXISTS cowork_receipts_party ON cowork_receipts(cowork_id, party, state);
      CREATE INDEX IF NOT EXISTS cowork_receipts_thread ON cowork_receipts(thread_id, party);
      CREATE TABLE IF NOT EXISTS cowork_pending (
        cowork_id TEXT NOT NULL, party TEXT NOT NULL, key INTEGER NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (cowork_id, party)
      );
    `);
    // 2026-11-25: the state the events add up to, and where a person dragged its card.
    const cols = (db.prepare("PRAGMA table_info(cowork_matters)").all() as Row[]).map((r) => String(r.name));
    if (!cols.includes("derived")) db.exec("ALTER TABLE cowork_matters ADD COLUMN derived TEXT; ALTER TABLE cowork_matters ADD COLUMN place TEXT;");
    if (!cols.includes("place_version")) db.exec("ALTER TABLE cowork_matters ADD COLUMN place_version INTEGER NOT NULL DEFAULT 0;");
    // 2026-11-25 「事项归做的那一方」: the side that handed it to the other (a 「交给对方」 事项).
    if (!cols.includes("from_side")) db.exec("ALTER TABLE cowork_matters ADD COLUMN from_side TEXT;");
    this.migrate();
  }

  /** What changed since the last call (and forget it). */
  drain(): CoworkTouched {
    const t = this.touchedNow;
    this.touchedNow = CoworkMatters.fresh();
    return t;
  }

  touch(coworkId: string): void {
    this.touchedNow.coworks.add(coworkId);
  }

  /** A message the service wrote (announced afterwards). */
  posted(seq: number): void {
    this.touchedNow.posted.add(seq);
  }

  /**
   * Coworks with a 事项 that went 「久没动静」 between `since` and `now` (MATTER_QUIET_MS with no event while 在做): the
   * service's sweep looks again at their 待我处理 so the 主控's list changes (and is pushed) when it happens.
   */
  quietDue(since: number, now: number): string[] {
    return (
      this.db
        .prepare("SELECT DISTINCT cowork_id FROM cowork_matters WHERE status = 'doing' AND json_extract(derived, '$.lastEventAt') > ? AND json_extract(derived, '$.lastEventAt') <= ?")
        .all(since - MATTER_QUIET_MS, now - MATTER_QUIET_MS) as Row[]
    ).map((r) => String(r.cowork_id));
  }

  /**
   * 子会话 from before 事项 (2026-11-24/25, plans/collab-framework.md 「已有的协作」: open → 在做, concluded → 关闭, from
   * then on moved by events): each gets its 事项, numbered in the order they were made. The one who asked owns it; their
   * side carries it.
   * 事项 from before events (step 2, never deployed): an "open" event standing for what they had.
   */
  private migrate(): void {
    const rows = this.db
      .prepare("SELECT id, cowork_id, created_at, req_from, cw_agent, cw_conclusion, s_state, s_waiting FROM threads WHERE cowork_id IS NOT NULL AND kind = 'request' AND id NOT IN (SELECT id FROM cowork_matters) ORDER BY created_at, rowid")
      .all() as Row[];
    for (const r of rows) {
      const coworkId = String(r.cowork_id);
      const conclusion = r.cw_conclusion == null ? null : String(r.cw_conclusion);
      const status = statusFromSession((String(r.s_state ?? "open") as "open" | "returned" | "done") ?? "open", conclusion);
      const owner = r.cw_agent != null ? agentParty(String(r.cw_agent)) : personParty(String(r.req_from));
      const at = Number(r.created_at);
      const open: MatterEvent = { kind: "open", at, by: owner, status: "doing", note: "从子会话转成事项" };
      this.insert({ id: String(r.id), coworkId, kind: r.cw_agent != null ? "confirm" : "work", owner, side: String(r.req_from), gate: null, blocker: null, dependsOn: [], at }, open);
      if (status === "closed") this.apply(String(r.id), { kind: "conclude", at, by: owner, conclusion, note: "从子会话转成事项" }, { migrating: true });
    }
    for (const r of this.db.prepare("SELECT * FROM cowork_matters WHERE derived IS NULL").all() as Row[]) {
      const at = Number(r.updated_at);
      const status = String(r.status) as MatterStatus;
      const waiting = json<Party[]>(r.waiting, []);
      const open: MatterEvent = { kind: "open", at, by: String(r.owner) as Party, status: status === "closed" ? "doing" : status, to: waiting, note: "从旧的事项转来" };
      let s = applyMatterEvent(null, open);
      const events = [open];
      if (status === "closed") {
        const close: MatterEvent = { kind: "conclude", at, by: String(r.owner) as Party, conclusion: r.conclusion == null ? null : String(r.conclusion) };
        s = applyMatterEvent(s, close);
        events.push(close);
      }
      for (const e of events) this.db.prepare("INSERT INTO cowork_matter_events (matter_id, at, event) VALUES (?, ?, ?)").run(String(r.id), e.at, JSON.stringify(e));
      this.db.prepare("UPDATE cowork_matters SET derived = ?, status = ?, waiting = ?, history = ? WHERE id = ?").run(JSON.stringify(s), s.status, JSON.stringify(s.waitingOn), JSON.stringify(s.history), String(r.id));
    }
  }

  private nextNo(coworkId: string): number {
    return Number((this.db.prepare("SELECT MAX(no) AS n FROM cowork_matters WHERE cowork_id = ?").get(coworkId) as Row).n ?? 0) + 1;
  }

  /** A new 事项's row (the thread is made by the caller), from its "open" event. */
  insert(m: { id: string; coworkId: string; kind: MatterKind; owner: Party; side: string; from?: string | null; gate: GateKind | null; blocker: string | null; dependsOn: string[]; at: number; bindings?: MatterBindings }, open: MatterEvent): void {
    const s = applyMatterEvent(null, open);
    this.db
      .prepare("INSERT INTO cowork_matters (id, cowork_id, no, kind, owner, side, from_side, status, waiting, bindings, blocker, depends, gate, conclusion, history, created_at, updated_at, version, derived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)")
      .run(m.id, m.coworkId, this.nextNo(m.coworkId), m.kind, m.owner, m.side, m.from && m.from !== m.side ? m.from : null, s.status, JSON.stringify(s.waitingOn), JSON.stringify(m.bindings ?? EMPTY_BINDINGS), m.blocker, JSON.stringify(m.dependsOn), m.gate, s.conclusion, JSON.stringify(s.history), m.at, m.at, JSON.stringify(s));
    this.db.prepare("INSERT INTO cowork_matter_events (matter_id, at, event) VALUES (?, ?, ?)").run(m.id, open.at, JSON.stringify(open));
    this.touchedNow.matters.add(m.id);
    this.touchedNow.coworks.add(m.coworkId);
  }

  // ---- reading

  private row(id: string): Row | null {
    return (this.db.prepare("SELECT m.*, t.title FROM cowork_matters m JOIN threads t ON t.id = m.id WHERE m.id = ?").get(id) as Row | undefined) ?? null;
  }

  /** The 主控 now in a cowork, by side (account → mark). */
  leads(coworkId: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.db.prepare("SELECT owner, mark FROM cowork_agents WHERE cowork_id = ? AND left_at IS NULL AND role = 'lead' ORDER BY joined_at, rowid").all(coworkId) as Row[]) out[String(r.owner)] ??= String(r.mark);
    return out;
  }

  private state(r: Row): MatterState {
    return json<MatterState>(r.derived, { status: String(r.status) as MatterStatus, waitingOn: json<Party[]>(r.waiting, []), waitingWhy: null, asks: [], history: json<MatterChange[]>(r.history, []), lastEventAt: Number(r.updated_at), limited: false, commits: [], conclusion: r.conclusion == null ? null : String(r.conclusion) });
  }

  private matterOf(r: Row, leads?: Record<string, string>): Matter {
    const coworkId = String(r.cowork_id);
    const side = String(r.side);
    const l = leads ?? this.leads(coworkId);
    const s = this.state(r);
    return {
      id: String(r.id),
      scope: "cowork",
      scopeId: coworkId,
      no: Number(r.no),
      kind: String(r.kind) as MatterKind,
      title: String(r.title ?? ""),
      owner: String(r.owner) as Party,
      side,
      lead: l[side] ?? null,
      ...(r.from_side != null ? { from: String(r.from_side) } : {}),
      status: s.status,
      waitingOn: s.waitingOn,
      bindings: { ...EMPTY_BINDINGS, ...json<Partial<MatterBindings>>(r.bindings, {}) },
      blocker: r.blocker == null ? null : String(r.blocker),
      dependsOn: json<string[]>(r.depends, []),
      gate: r.gate == null ? null : (String(r.gate) as GateKind),
      conclusion: s.conclusion,
      history: s.history,
      waitingWhy: s.waitingWhy,
      lastEventAt: s.lastEventAt,
      limited: s.limited,
      ...(s.decided !== undefined ? { decided: s.decided } : {}),
      place: json<{ x: number; y: number } | null>(r.place, null),
      placeVersion: Number(r.place_version ?? 0),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      version: Number(r.version),
    };
  }

  /** A 事项, or null when the thread is none. */
  get(id: string): Matter | null {
    const r = this.row(id);
    return r ? this.matterOf(r) : null;
  }

  require(coworkId: string, id: string): Matter {
    const m = this.get(id);
    if (!m || m.scopeId !== coworkId) throw new RelayError("not_found", `这个协作里没有这件事项：${id}`);
    return m;
  }

  /** A cowork's 事项 by its number (「事项 3」). */
  byNo(coworkId: string, no: number): Matter | null {
    const r = this.db.prepare("SELECT id FROM cowork_matters WHERE cowork_id = ? AND no = ?").get(coworkId, no) as Row | undefined;
    return r ? this.get(String(r.id)) : null;
  }

  /** A cowork's 事项, by number. */
  list(coworkId: string): Matter[] {
    const leads = this.leads(coworkId);
    return (this.db.prepare("SELECT m.*, t.title FROM cowork_matters m JOIN threads t ON t.id = m.id WHERE m.cowork_id = ? ORDER BY m.no").all(coworkId) as Row[]).map((r) => this.matterOf(r, leads));
  }

  /** Whether this thread is a 事项. */
  isMatter(threadId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM cowork_matters WHERE id = ?").get(threadId);
  }

  /** What happened in a 事项, in order. */
  events(id: string): MatterEvent[] {
    return (this.db.prepare("SELECT event FROM cowork_matter_events WHERE matter_id = ? ORDER BY id").all(id) as Row[]).map((r) => json<MatterEvent>(r.event, { kind: "say", at: 0, by: "person:?" }));
  }

  // ---- changing a 事项

  /**
   * Something happened in it: kept, and folded into its state (applyMatterEvent). Its version goes up when its status or
   * who it waits on changed; closed by this, everything in it is 处理了. Returns the 事项 now and what moved.
   */
  apply(id: string, e: MatterEvent, opts: { migrating?: boolean } = {}): { matter: Matter; closed: boolean; changed: boolean; before: MatterStatus } {
    const r = this.row(id);
    if (!r) throw new RelayError("not_found", `没有这件事项：${id}`);
    const prev = this.state(r);
    const s = applyMatterEvent(prev, e);
    this.db.prepare("INSERT INTO cowork_matter_events (matter_id, at, event) VALUES (?, ?, ?)").run(id, e.at, JSON.stringify(e));
    const changed = s.status !== prev.status || JSON.stringify(s.waitingOn) !== JSON.stringify(prev.waitingOn) || s.conclusion !== prev.conclusion || s.limited !== prev.limited || s.decided !== prev.decided;
    this.db
      .prepare(`UPDATE cowork_matters SET derived = ?, status = ?, waiting = ?, history = ?, conclusion = ?, updated_at = ?${changed ? ", version = version + 1" : ""} WHERE id = ?`)
      .run(JSON.stringify(s), s.status, JSON.stringify(s.waitingOn), JSON.stringify(s.history), s.conclusion, e.at, id);
    this.touchedNow.matters.add(id);
    this.touchedNow.coworks.add(String(r.cowork_id));
    // A push's commits are the 事项's bound commits too.
    if (e.kind === "push" && e.commits?.length) {
      const b = { ...EMPTY_BINDINGS, ...json<Partial<MatterBindings>>(r.bindings, {}) };
      const commits = [...new Set([...b.commits, ...e.commits])];
      if (commits.length !== b.commits.length) this.db.prepare("UPDATE cowork_matters SET bindings = ? WHERE id = ?").run(JSON.stringify({ ...b, commits }), id);
    }
    const closed = s.status === "closed" && prev.status !== "closed";
    if (closed && opts.migrating) this.closeReceipts(id, e.at, null);
    else if (closed) this.closedBy(String(r.cowork_id), id, e);
    return { matter: this.get(id)!, closed, changed, before: prev.status };
  }

  /**
   * A 事项 closed (2026-11-25, plans/collab-agent-spec.md 「v6 之后定的」: closing marked everything in it 处理了, so the other
   * side's AI never heard of what it had not read — 12 of 14 acceptance runs, once nobody started the merge): the closing
   * side's messages in it are 处理了; the other sides' unseen ones stay as they are, and their 主控 and people each get a
   * 「事项 N 关了：结论 …」 line (MatterMessageFields `closed`, pendingFor "closed") until they have seen it.
   */
  private closedBy(coworkId: string, id: string, e: MatterEvent): void {
    const mine = this.ownerOf(coworkId, e.by);
    this.closeReceipts(id, e.at, mine === null ? null : (p) => this.ownerOf(coworkId, p) === mine);
    const m = this.get(id)!;
    // The 提出方 of a 「交给对方」 事项 is told too (2026-11-25), whether or not it wrote in it.
    const sides = new Set<string>([m.side, ...(m.from ? [m.from] : [])]);
    for (const r of this.db.prepare("SELECT DISTINCT party FROM cowork_receipts WHERE thread_id = ?").all(id) as Row[]) {
      const s = this.ownerOf(coworkId, String(r.party) as Party);
      if (s) sides.add(s);
    }
    for (const r of this.db.prepare("SELECT author, via FROM messages WHERE thread_id = ? AND kind <> 'event'").all(id) as Row[]) {
      const s = this.ownerOf(coworkId, partyOf(String(r.author), json<Via>(r.via, { kind: "person" })));
      if (s) sides.add(s);
    }
    const people = new Set(this.store.threadMembers(coworkId));
    const leads = this.leads(coworkId);
    const to: Party[] = [];
    for (const s of sides) {
      if (s === mine) continue;
      if (leads[s]) to.push(agentParty(leads[s]!));
      if (people.has(s)) to.push(personParty(s));
    }
    if (!to.length) return;
    const who = parseParty(e.by);
    const author = mine ?? (who?.kind === "person" ? who.name : m.side);
    const via: Via = who?.kind === "agent" ? { kind: "ai", conv: who.mark } : { kind: "person" };
    const body = `事项 ${m.no}「${m.title}」关了：${m.conclusion ? m.conclusion : "（没写结论）"}`;
    const message = this.store.insertMessage(id, author, via, "event", body, { closed: true });
    for (const p of to) {
      const person = p.startsWith("person:");
      this.db.prepare("INSERT OR IGNORE INTO cowork_receipts (seq, party, cowork_id, thread_id, state, queued_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(message.seq, p, coworkId, id, person ? "delivered" : "queued", e.at, person ? e.at : null);
    }
    this.touchedNow.receipts.add(message.seq);
    this.touchedNow.coworks.add(coworkId);
  }

  /** Writes the plain fields given (not its status: that comes from events). */
  fields(id: string, f: MatterFields): Matter {
    const before = this.get(id);
    if (!before) throw new RelayError("not_found", `没有这件事项：${id}`);
    const set: Record<string, string | number | null> = {};
    if (f.side !== undefined && f.side !== before.side) set.side = f.side;
    if (f.blocker !== undefined && f.blocker !== before.blocker) set.blocker = f.blocker;
    if (f.dependsOn !== undefined && JSON.stringify(f.dependsOn) !== JSON.stringify(before.dependsOn)) set.depends = JSON.stringify(f.dependsOn);
    if (f.gate !== undefined && f.gate !== before.gate) set.gate = f.gate;
    if (f.bindings !== undefined && JSON.stringify(f.bindings) !== JSON.stringify(before.bindings)) set.bindings = JSON.stringify(f.bindings);
    if (f.kind !== undefined && f.kind !== before.kind) set.kind = f.kind;
    if (!Object.keys(set).length) return before;
    set.updated_at = this.now();
    const keys = Object.keys(set);
    this.db.prepare(`UPDATE cowork_matters SET ${keys.map((k) => `${k} = ?`).join(", ")}, version = version + 1 WHERE id = ?`).run(...keys.map((k) => set[k]!), id);
    this.touchedNow.matters.add(id);
    this.touchedNow.coworks.add(before.scopeId);
    return this.get(id)!;
  }

  /** Where a person dragged its card (null: laid out by the client again). Not a change of the 事项 (its version stays);
   * its placeVersion goes up. */
  place(id: string, at: { x: number; y: number } | null): Matter {
    const m = this.get(id);
    if (!m) throw new RelayError("not_found", `没有这件事项：${id}`);
    this.db.prepare("UPDATE cowork_matters SET place = ?, place_version = place_version + 1 WHERE id = ?").run(at ? JSON.stringify(at) : null, id);
    this.touchedNow.matters.add(id);
    return this.get(id)!;
  }

  /** Something kept elsewhere changed (its title, in the thread): a new version. */
  bump(id: string): void {
    const m = this.get(id);
    if (!m) return;
    this.db.prepare("UPDATE cowork_matters SET version = version + 1, updated_at = ? WHERE id = ?").run(this.now(), id);
    this.touchedNow.matters.add(id);
    this.touchedNow.coworks.add(m.scopeId);
  }

  // ---- receipts

  private receiptOf(r: Row): Receipt {
    const out: Receipt = {
      party: String(r.party) as Party,
      state: String(r.state) as ReceiptState,
      queuedAt: Number(r.queued_at),
      deliveredAt: r.delivered_at == null ? null : Number(r.delivered_at),
      seenAt: r.seen_at == null ? null : Number(r.seen_at),
      handledAt: r.handled_at == null ? null : Number(r.handled_at),
    };
    if (Number(r.by_close) === 1) out.byClose = true;
    return out;
  }

  /** A message's receipts (none outside a cowork or before 事项). */
  receipts(seq: number): Receipt[] {
    return (this.db.prepare("SELECT * FROM cowork_receipts WHERE seq = ? ORDER BY rowid").all(seq) as Row[]).map((r) => this.receiptOf(r));
  }

  private writeReceipt(seq: number, r: Receipt): void {
    this.db.prepare("UPDATE cowork_receipts SET state = ?, delivered_at = ?, seen_at = ?, handled_at = ?, by_close = ? WHERE seq = ? AND party = ?").run(r.state, r.deliveredAt, r.seenAt, r.handledAt, r.byClose ? 1 : 0, seq, r.party);
    this.touchedNow.receipts.add(seq);
  }

  /** Moves one receipt forward; returns it when it moved. */
  advance(seq: number, party: Party, state: ReceiptState, byClose = false): Receipt | null {
    const row = this.db.prepare("SELECT * FROM cowork_receipts WHERE seq = ? AND party = ?").get(seq, party) as Row | undefined;
    if (!row) return null;
    const was = this.receiptOf(row);
    const next = advanceReceipt(was, state, this.now(), byClose);
    if (next === was) return null;
    this.writeReceipt(seq, next);
    this.touchedNow.coworks.add(String(row.cowork_id));
    return next;
  }

  /**
   * A message came into a cowork's thread: one receipt per recipient. People's are 送到 at once (the service holds it for
   * them); agents' wait 排队 until their owner's Studio takes them (a delivery acked, its 待我处理 read) or the agent reads.
   * In a 事项 it is also an event (matterMessageEvent: 发言, @/回复, 确认回复 — not the 事项's opening message), and so are
   * the commits (推送) and the verification (验证结果) it reports.
   */
  receive(coworkId: string, message: Message, people: string[]): Receipt[] {
    if (message.kind === "event") return [];
    const author = authorParty(message);
    const matter = this.get(message.threadId);
    const posters = matter ? this.posters(message.threadId, message.seq) : [];
    const mentions: Party[] = [...(message.mentions ?? []).map(personParty), ...(message.agentMentions ?? []).map(agentParty)];
    // Those it 知会s read it too (in a 事项, people are not otherwise its recipients).
    const noticed = (message.notice ?? []).map(personParty);
    const replied = message.replyTo ? this.store.messageBySeq(message.replyTo) : null;
    const to = messageRecipients({ author, people, leads: this.leads(coworkId), matter, posters, mentions: [...mentions, ...noticed], replyToAuthor: replied ? authorParty(replied) : null, workerSides: matter ? this.workerSides(coworkId, matter.bindings.sessions) : {} });
    const at = this.now();
    for (const p of to) {
      const person = p.startsWith("person:");
      this.db.prepare("INSERT OR IGNORE INTO cowork_receipts (seq, party, cowork_id, thread_id, state, queued_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(message.seq, p, coworkId, message.threadId, person ? "delivered" : "queued", at, person ? at : null);
    }
    if (to.length) this.touchedNow.receipts.add(message.seq);
    this.touchedNow.coworks.add(coworkId);
    // Whoever writes in a thread has seen what came before in it.
    this.seenInThread(message.threadId, author, message.seq - 1);
    if (matter && message.kind !== "request") {
      const r = this.row(matter.id)!;
      this.apply(matter.id, matterMessageEvent(this.state(r), { by: author, seq: message.seq, at, mentions, replyToAuthor: replied ? authorParty(replied) : null }));
      if (message.commits?.length) this.apply(matter.id, { kind: "push", at, by: author, seq: message.seq, commits: message.commits });
      if (message.verify) this.apply(matter.id, { kind: "verify", at, by: author, seq: message.seq, passed: message.verify.passed, ...(message.verify.how ? { note: message.verify.how } : {}) });
    }
    return this.receipts(message.seq);
  }

  /** The 执行 bound to a 事项, by mark → their owner's account (whose 主控 hands them work). */
  private workerSides(coworkId: string, marks: readonly string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const mark of marks) {
      const r = this.db.prepare("SELECT owner FROM cowork_agents WHERE cowork_id = ? AND mark = ?").get(coworkId, mark) as Row | undefined;
      if (r) out[mark] = String(r.owner);
    }
    return out;
  }

  /** Those who wrote in this thread before (as participants). */
  private posters(threadId: string, beforeSeq: number): Party[] {
    const rows = this.db.prepare("SELECT author, via FROM messages WHERE thread_id = ? AND seq < ? AND kind <> 'event'").all(threadId, beforeSeq) as Row[];
    return [...new Set(rows.map((r) => partyOf(String(r.author), json<Via>(r.via, { kind: "person" }))))];
  }

  /** `party` has seen this thread up to `upTo` (a client opened it; an agent read it; they wrote in it). */
  seenInThread(threadId: string, party: Party, upTo: number): number[] {
    const rows = this.db.prepare("SELECT seq FROM cowork_receipts WHERE thread_id = ? AND party = ? AND seq <= ? AND state IN ('queued', 'delivered')").all(threadId, party, upTo) as Row[];
    const out: number[] = [];
    for (const r of rows) if (this.advance(Number(r.seq), party, "seen")) out.push(Number(r.seq));
    return out;
  }

  /** `party` handled everything to it in this thread up to `upTo` (its reply said so). */
  handledInThread(threadId: string, party: Party, upTo: number): void {
    const rows = this.db.prepare("SELECT seq FROM cowork_receipts WHERE thread_id = ? AND party = ? AND seq <= ? AND state <> 'handled'").all(threadId, party, upTo) as Row[];
    for (const r of rows) this.advance(Number(r.seq), party, "handled");
  }

  /** `party` has seen these messages (an agent's read of the feed). */
  seenSeqs(party: Party, seqs: number[]): void {
    for (const s of seqs) this.advance(s, party, "seen");
  }

  /** The owner's Studio took these for its agent (a delivery acked, a 待我处理 read). */
  delivered(party: Party, seqs: number[]): void {
    for (const s of seqs) this.advance(s, party, "delivered");
  }

  /**
   * Marks 看过 / 处理了 by seq, or every message of a 事项 up to `upTo`: the receipts that moved. A person marking a 知会 to
   * them 看过 has handled it (2026-11-25: 「要你看」 asks only that).
   */
  mark(coworkId: string, party: Party, mark: "seen" | "handled", seqs: number[] | null, matterId: string | null, upTo: number | null): Array<{ threadId: string; seq: number; receipt: Receipt }> {
    let rows: Row[];
    if (seqs) {
      if (seqs.length > 500) throw new RelayError("bad_request", "一次最多标 500 条");
      rows = seqs.length ? (this.db.prepare(`SELECT seq, thread_id FROM cowork_receipts WHERE cowork_id = ? AND party = ? AND seq IN (${seqs.map(() => "?").join(",")})`).all(coworkId, party, ...seqs) as Row[]) : [];
    } else if (matterId) {
      this.require(coworkId, matterId);
      rows = this.db.prepare("SELECT seq, thread_id FROM cowork_receipts WHERE thread_id = ? AND party = ? AND seq <= ?").all(matterId, party, upTo ?? Number.MAX_SAFE_INTEGER) as Row[];
    } else throw new RelayError("bad_request", "要标哪几条：seqs，或者 matter（加 upTo）");
    const who = parseParty(party);
    const out: Array<{ threadId: string; seq: number; receipt: Receipt }> = [];
    for (const r of rows) {
      const seq = Number(r.seq);
      const msg = mark === "seen" && who?.kind === "person" ? this.store.messageBySeq(seq) : null;
      // A 知会 or a 「事项 N 关了」 line asks only that it is seen.
      const noticed = !!msg && who?.kind === "person" && (!!msg.notice?.includes(who.name) || !!msg.closed);
      const moved = this.advance(seq, party, noticed ? "handled" : mark);
      if (moved) out.push({ threadId: String(r.thread_id), seq, receipt: moved });
    }
    return out;
  }

  /** A 事项 closed: its messages count as 处理了 (byClose) for those `whose` takes — the closing side; null: everyone (a
   * 子会话 closed before 事项, migrated). */
  private closeReceipts(threadId: string, at: number, whose: ((p: Party) => boolean) | null): void {
    const rows = this.db.prepare("SELECT * FROM cowork_receipts WHERE thread_id = ? AND state <> 'handled'").all(threadId) as Row[];
    for (const r of rows) {
      if (whose && !whose(String(r.party) as Party)) continue;
      const next = advanceReceipt(this.receiptOf(r), "handled", at, true);
      this.writeReceipt(Number(r.seq), next);
    }
  }

  /** Changes a message's extra fields (撤回, 原地改, 被取代) and, for a rewrite or withdrawal, its text. */
  setMessage(seq: number, extra: Record<string, unknown>, body?: string): void {
    const row = this.db.prepare("SELECT extra FROM messages WHERE seq = ?").get(seq) as Row | undefined;
    if (!row) throw new RelayError("not_found", `没有这条消息：#${seq}`);
    const next = { ...json<Record<string, unknown>>(row.extra, {}), ...extra };
    if (body === undefined) this.db.prepare("UPDATE messages SET extra = ? WHERE seq = ?").run(JSON.stringify(next), seq);
    else this.db.prepare("UPDATE messages SET extra = ?, body = ? WHERE seq = ?").run(JSON.stringify(next), body, seq);
    this.touchedNow.messages.add(seq);
  }

  // ---- 待我处理

  /** The parties to keep a 待我处理 for in a cowork: its people and the agents in it now. */
  parties(coworkId: string, people: string[]): Party[] {
    const agents = (this.db.prepare("SELECT mark FROM cowork_agents WHERE cowork_id = ? AND left_at IS NULL").all(coworkId) as Row[]).map((r) => agentParty(String(r.mark)));
    return [...people.map(personParty), ...agents];
  }

  /** A participant's 待我处理 in a cowork, with its version (bumped here when the list changed). */
  pending(coworkId: string, party: Party): PendingList & { coworkId: string } {
    const matters = this.list(coworkId);
    const rows = this.db.prepare("SELECT r.*, m.thread_id AS m_thread, m.author, m.via, m.body, m.extra, m.created_at AS m_at FROM cowork_receipts r JOIN messages m ON m.seq = r.seq WHERE r.cowork_id = ? AND r.party = ? AND r.state <> 'handled' ORDER BY r.seq").all(coworkId, party) as Row[];
    const matterIds = new Set(matters.map((m) => m.id));
    const messages: PendingMessage[] = rows.map((r) => {
      const extra = json<Partial<Message>>(r.extra, {});
      const via = json<Via>(r.via, { kind: "person" });
      const pm: PendingMessage = {
        seq: Number(r.seq),
        author: partyOf(String(r.author), via),
        mentions: [...(extra.mentions ?? []).map(personParty), ...(extra.agentMentions ?? []).map(agentParty)],
        body: String(r.body),
        createdAt: Number(r.m_at),
        receipts: [this.receiptOf(r)],
      };
      if (matterIds.has(String(r.m_thread))) pm.matter = String(r.m_thread);
      if (extra.replyTo) {
        pm.replyTo = extra.replyTo;
        const replied = this.store.messageBySeq(extra.replyTo);
        if (replied) pm.replyToAuthor = authorParty(replied);
      }
      if (extra.notice) pm.notice = extra.notice;
      if (extra.basis) pm.basis = extra.basis;
      if (extra.closed) pm.closed = true;
      if (extra.withdrawnAt !== undefined) pm.withdrawnAt = extra.withdrawnAt;
      if (extra.supersededBy !== undefined) pm.supersededBy = extra.supersededBy;
      return pm;
    });
    const items = pendingFor(party, "cowork", coworkId, matters, messages, { now: this.now() });
    const key = pendingKey(items);
    const had = this.db.prepare("SELECT key, version FROM cowork_pending WHERE cowork_id = ? AND party = ?").get(coworkId, party) as Row | undefined;
    let version = had ? Number(had.version) : 1;
    if (!had) this.db.prepare("INSERT INTO cowork_pending (cowork_id, party, key, version) VALUES (?, ?, ?, 1)").run(coworkId, party, key);
    else if (Number(had.key) !== key) {
      version += 1;
      this.db.prepare("UPDATE cowork_pending SET key = ?, version = ? WHERE cowork_id = ? AND party = ?").run(key, version, coworkId, party);
    }
    return { coworkId, party, items, version };
  }

  /** The version a participant's list had when last computed (0: never). */
  pendingVersion(coworkId: string, party: Party): number {
    return Number((this.db.prepare("SELECT version FROM cowork_pending WHERE cowork_id = ? AND party = ?").get(coworkId, party) as Row | undefined)?.version ?? 0);
  }

  /** The person a party's pushes go to: the person, or the agent's owner. */
  ownerOf(coworkId: string, party: Party): string | null {
    const p = parseParty(party);
    if (!p) return null;
    if (p.kind === "person") return p.name;
    const r = this.db.prepare("SELECT owner FROM cowork_agents WHERE cowork_id = ? AND mark = ?").get(coworkId, p.mark) as Row | undefined;
    return r ? String(r.owner) : null;
  }

  statusText(s: MatterStatus): string {
    return MATTER_STATUS_LABEL[s];
  }
}
