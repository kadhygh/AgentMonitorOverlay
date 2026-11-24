import type { DatabaseSync } from "node:sqlite";
import {
  GATE_LABEL,
  MATTER_LIMITS,
  MATTER_STATUSES,
  MATTER_STATUS_LABEL,
  advanceReceipt,
  agentParty,
  isParty,
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
  type MatterKind,
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

export function cleanBindings(v: unknown): Partial<MatterBindings> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object") throw new RelayError("bad_request", "绑定要是 { sessions, tasks, commits }");
  const b = v as Record<string, unknown>;
  const out: Partial<MatterBindings> = {};
  if (b.sessions !== undefined) out.sessions = cleanIds(b.sessions, "绑定的执行会话", MATTER_LIMITS.bindings);
  if (b.tasks !== undefined) out.tasks = cleanIds(b.tasks, "绑定的任务", MATTER_LIMITS.bindings);
  if (b.commits !== undefined) out.commits = cleanIds(b.commits, "绑定的提交", MATTER_LIMITS.bindings, /^[0-9a-fA-F]{4,64}$/).map((c) => c.toLowerCase());
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
  /** 事项 made in this call (they get a card on the board). */
  created: Set<string>;
  /** Who last changed each 事项 (the board's placing is done in their name). */
  by: Map<string, Party>;
  /** Message seqs whose receipts moved. */
  receipts: Set<number>;
  /** Message seqs withdrawn, rewritten or superseded. */
  messages: Set<number>;
}

export class CoworkMatters {
  private touchedNow: CoworkTouched = CoworkMatters.fresh();

  private static fresh(): CoworkTouched {
    return { coworks: new Set(), matters: new Set(), created: new Set(), by: new Map(), receipts: new Set(), messages: new Set() };
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

  /**
   * 子会话 from before 事项 (2026-11-24, the coordinator: open → 在做, concluded → 关闭): each gets its 事项, numbered in the
   * order they were made. The one who asked owns it; their side carries it.
   */
  private migrate(): void {
    const rows = this.db
      .prepare("SELECT id, cowork_id, created_at, req_from, cw_agent, cw_conclusion, s_state, s_waiting FROM threads WHERE cowork_id IS NOT NULL AND kind = 'request' AND id NOT IN (SELECT id FROM cowork_matters) ORDER BY created_at, rowid")
      .all() as Row[];
    for (const r of rows) {
      const coworkId = String(r.cowork_id);
      const status = statusFromSession((String(r.s_state ?? "open") as "open" | "returned" | "done") ?? "open", r.cw_conclusion == null ? null : String(r.cw_conclusion));
      const owner = r.cw_agent != null ? agentParty(String(r.cw_agent)) : personParty(String(r.req_from));
      const waiting = status !== "closed" && r.s_waiting != null ? [personParty(String(r.s_waiting))] : [];
      const at = Number(r.created_at);
      this.insert({
        id: String(r.id),
        coworkId,
        kind: r.cw_agent != null ? "confirm" : "work",
        owner,
        side: String(r.req_from),
        status,
        waitingOn: waiting,
        gate: null,
        blocker: null,
        dependsOn: [],
        conclusion: r.cw_conclusion == null ? null : String(r.cw_conclusion),
        history: [{ at, by: owner, from: null, to: status, note: "从子会话转成事项" }],
        at,
      });
    }
  }

  private nextNo(coworkId: string): number {
    return Number((this.db.prepare("SELECT MAX(no) AS n FROM cowork_matters WHERE cowork_id = ?").get(coworkId) as Row).n ?? 0) + 1;
  }

  /** A new 事项's row (the thread is made by the caller). */
  insert(m: { id: string; coworkId: string; kind: MatterKind; owner: Party; side: string; status: MatterStatus; waitingOn: Party[]; gate: GateKind | null; blocker: string | null; dependsOn: string[]; conclusion: string | null; history: MatterChange[]; at: number; bindings?: MatterBindings }, isNew = false): void {
    this.db
      .prepare("INSERT INTO cowork_matters (id, cowork_id, no, kind, owner, side, status, waiting, bindings, blocker, depends, gate, conclusion, history, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)")
      .run(m.id, m.coworkId, this.nextNo(m.coworkId), m.kind, m.owner, m.side, m.status, JSON.stringify(m.waitingOn), JSON.stringify(m.bindings ?? EMPTY_BINDINGS), m.blocker, JSON.stringify(m.dependsOn), m.gate, m.conclusion, JSON.stringify(m.history), m.at, m.at);
    this.touchedNow.matters.add(m.id);
    this.touchedNow.coworks.add(m.coworkId);
    this.touchedNow.by.set(m.id, m.history[0]?.by ?? m.owner);
    if (isNew) this.touchedNow.created.add(m.id);
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

  private matterOf(r: Row, leads?: Record<string, string>): Matter {
    const coworkId = String(r.cowork_id);
    const side = String(r.side);
    const l = leads ?? this.leads(coworkId);
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
      status: String(r.status) as MatterStatus,
      waitingOn: json<Party[]>(r.waiting, []),
      bindings: { ...EMPTY_BINDINGS, ...json<Partial<MatterBindings>>(r.bindings, {}) },
      blocker: r.blocker == null ? null : String(r.blocker),
      dependsOn: json<string[]>(r.depends, []),
      gate: r.gate == null ? null : (String(r.gate) as GateKind),
      conclusion: r.conclusion == null ? null : String(r.conclusion),
      history: json<MatterChange[]>(r.history, []),
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

  /** A cowork's 事项, by number. */
  list(coworkId: string): Matter[] {
    const leads = this.leads(coworkId);
    return (this.db.prepare("SELECT m.*, t.title FROM cowork_matters m JOIN threads t ON t.id = m.id WHERE m.cowork_id = ? ORDER BY m.no").all(coworkId) as Row[]).map((r) => this.matterOf(r, leads));
  }

  /** Whether this thread is a 事项. */
  isMatter(threadId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM cowork_matters WHERE id = ?").get(threadId);
  }

  // ---- changing a 事项

  /**
   * Writes the fields given and, for a new status, a line of history. Returns the 事项 as it is now and whether it was
   * closed by this (its messages are then 处理了).
   */
  write(id: string, by: Party, fields: { status?: MatterStatus; note?: string; side?: string; waitingOn?: Party[]; blocker?: string | null; dependsOn?: string[]; gate?: GateKind | null; conclusion?: string | null; bindings?: MatterBindings; kind?: MatterKind }): { matter: Matter; closed: boolean; settledBefore: boolean } {
    const before = this.get(id);
    if (!before) throw new RelayError("not_found", `没有这件事项：${id}`);
    const at = this.now();
    const set: Record<string, string | number | null> = {};
    const history = [...before.history];
    if (fields.status !== undefined && fields.status !== before.status) {
      set.status = fields.status;
      history.push({ at, by, from: before.status, to: fields.status, ...(fields.note ? { note: fields.note.slice(0, 200) } : {}) });
      set.history = JSON.stringify(history.slice(-200));
    }
    if (fields.side !== undefined && fields.side !== before.side) set.side = fields.side;
    if (fields.waitingOn !== undefined && JSON.stringify(fields.waitingOn) !== JSON.stringify(before.waitingOn)) set.waiting = JSON.stringify(fields.waitingOn);
    if (fields.blocker !== undefined && fields.blocker !== before.blocker) set.blocker = fields.blocker;
    if (fields.dependsOn !== undefined && JSON.stringify(fields.dependsOn) !== JSON.stringify(before.dependsOn)) set.depends = JSON.stringify(fields.dependsOn);
    if (fields.gate !== undefined && fields.gate !== before.gate) set.gate = fields.gate;
    if (fields.conclusion !== undefined && fields.conclusion !== before.conclusion) set.conclusion = fields.conclusion;
    if (fields.bindings !== undefined && JSON.stringify(fields.bindings) !== JSON.stringify(before.bindings)) set.bindings = JSON.stringify(fields.bindings);
    if (fields.kind !== undefined && fields.kind !== before.kind) set.kind = fields.kind;
    const settledBefore = before.status === "verified" || before.status === "closed" || before.conclusion !== null;
    if (!Object.keys(set).length) return { matter: before, closed: false, settledBefore };
    set.updated_at = at;
    const keys = Object.keys(set);
    this.db.prepare(`UPDATE cowork_matters SET ${keys.map((k) => `${k} = ?`).join(", ")}, version = version + 1 WHERE id = ?`).run(...keys.map((k) => set[k]!), id);
    this.touchedNow.matters.add(id);
    this.touchedNow.coworks.add(before.scopeId);
    this.touchedNow.by.set(id, by);
    const closed = fields.status === "closed" && before.status !== "closed";
    if (closed) this.closeReceipts(id, at);
    return { matter: this.get(id)!, closed, settledBefore };
  }

  /** Something kept elsewhere changed (its title, in the thread): a new version. */
  bump(id: string, by: Party): void {
    const m = this.get(id);
    if (!m) return;
    this.db.prepare("UPDATE cowork_matters SET version = version + 1, updated_at = ? WHERE id = ?").run(this.now(), id);
    this.touchedNow.matters.add(id);
    this.touchedNow.coworks.add(m.scopeId);
    this.touchedNow.by.set(id, by);
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
   */
  receive(coworkId: string, message: Message, people: string[]): Receipt[] {
    if (message.kind === "event") return [];
    const author = authorParty(message);
    const matter = this.get(message.threadId);
    const posters = matter ? this.posters(message.threadId, message.seq) : [];
    const mentions: Party[] = [...(message.mentions ?? []).map(personParty), ...(message.agentMentions ?? []).map(agentParty)];
    const to = messageRecipients({ author, people, leads: this.leads(coworkId), matter, posters, mentions });
    const at = this.now();
    for (const p of to) {
      const person = p.startsWith("person:");
      this.db.prepare("INSERT OR IGNORE INTO cowork_receipts (seq, party, cowork_id, thread_id, state, queued_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(message.seq, p, coworkId, message.threadId, person ? "delivered" : "queued", at, person ? at : null);
    }
    if (to.length) this.touchedNow.receipts.add(message.seq);
    this.touchedNow.coworks.add(coworkId);
    // Whoever writes in a thread has seen what came before in it.
    this.seenInThread(message.threadId, author, message.seq - 1);
    return this.receipts(message.seq);
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

  /** Marks 看过 / 处理了 by seq, or every message of a 事项 up to `upTo`: the receipts that moved. */
  mark(coworkId: string, party: Party, mark: "seen" | "handled", seqs: number[] | null, matterId: string | null, upTo: number | null): Array<{ threadId: string; seq: number; receipt: Receipt }> {
    let rows: Row[];
    if (seqs) {
      if (seqs.length > 500) throw new RelayError("bad_request", "一次最多标 500 条");
      rows = seqs.length ? (this.db.prepare(`SELECT seq, thread_id FROM cowork_receipts WHERE cowork_id = ? AND party = ? AND seq IN (${seqs.map(() => "?").join(",")})`).all(coworkId, party, ...seqs) as Row[]) : [];
    } else if (matterId) {
      this.require(coworkId, matterId);
      rows = this.db.prepare("SELECT seq, thread_id FROM cowork_receipts WHERE thread_id = ? AND party = ? AND seq <= ?").all(matterId, party, upTo ?? Number.MAX_SAFE_INTEGER) as Row[];
    } else throw new RelayError("bad_request", "要标哪几条：seqs，或者 matter（加 upTo）");
    const out: Array<{ threadId: string; seq: number; receipt: Receipt }> = [];
    for (const r of rows) {
      const moved = this.advance(Number(r.seq), party, mark);
      if (moved) out.push({ threadId: String(r.thread_id), seq: Number(r.seq), receipt: moved });
    }
    return out;
  }

  /** A 事项 closed: every message in it counts as 处理了 for everyone. */
  private closeReceipts(threadId: string, at: number): void {
    const rows = this.db.prepare("SELECT * FROM cowork_receipts WHERE thread_id = ? AND state <> 'handled'").all(threadId) as Row[];
    for (const r of rows) {
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
      if (extra.withdrawnAt !== undefined) pm.withdrawnAt = extra.withdrawnAt;
      if (extra.supersededBy !== undefined) pm.supersededBy = extra.supersededBy;
      return pm;
    });
    const items = pendingFor(party, "cowork", coworkId, matters, messages);
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
