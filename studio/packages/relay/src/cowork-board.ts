import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RelayError } from "./store.js";
import {
  BOARD_AI_MAX_CARDS,
  BOARD_ITEMS_MAX,
  BOARD_LOCK_MS,
  BOARD_OPS_MAX,
  BOARD_PRESENCE_MS,
  COWORK_LIMITS,
  type BoardChange,
  type BoardFields,
  type BoardItem,
  type BoardItemKind,
  type BoardLock,
  type BoardOp,
  type BoardOpRecord,
  type BoardOpsResult,
  type BoardPresence,
  type BoardRef,
  type BoardRejectCode,
  type BoardSnapshot,
} from "./cowork-protocol.js";

// 协作的白板 (2026-11-23, plans/cowork.md「白板：多人同时改」): several people and agents change it at once, so it is not
// saved whole (Studio's canvas is one person's) but as a list of operations, like 待办 (todo.ts): the service numbers
// each one per cowork, writes it into the cards and keeps it as history; every card has a version. Position, size,
// colour, group, link ends and 已过时 go in whatever came between (the later one wins); a card's text is under a soft
// lock while someone writes it (in memory, BOARD_LOCK_MS, let go when they disconnect); an agent's text change on a
// locked card or an older version is refused, a person's (replayed after being offline) is kept as 「另一版」 for a
// person to pick. Deleting only marks; undo reverts one's own operation where nobody changed it since. No CRDT in this
// first version (card texts are short; the user 11-23 took the suggestion).

type Row = Record<string, unknown>;

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const KINDS: ReadonlySet<BoardItemKind> = new Set(["note", "session", "ref", "group", "link"]);
const REF_KINDS = new Set(["file", "commit", "doc", "url"]);
const COLOR_RE = /^[A-Za-z0-9#-]{1,24}$/;
const SIZE: Record<BoardItemKind, [number, number]> = { note: [220, 140], session: [260, 120], ref: [240, 90], group: [480, 320], link: [0, 0], matter: [260, 130] };
/** The fields an operation changes and an undo puts back. */
const FIELDS = ["x", "y", "w", "h", "color", "text", "group", "stale", "ref", "from", "to", "deleted", "alt"] as const;
type Field = (typeof FIELDS)[number];

/** Who does it: a person, or (agent set) their agent. */
export interface BoardActor {
  name: string;
  agent: string | null;
}

class Reject extends Error {
  constructor(
    readonly code: BoardRejectCode,
    message: string,
    readonly by?: string,
  ) {
    super(message);
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function num(v: unknown, what: string, min = -1e7): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > 1e7) throw new Reject("bad", `${what} 要是数字`);
  return Math.round(v * 10) / 10;
}

function cleanText(v: unknown): string {
  if (typeof v !== "string") throw new Reject("bad", "卡片的文字要是文字");
  const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (t.length > COWORK_LIMITS.cardText) throw new Reject("bad", `卡片的文字太长（最多 ${COWORK_LIMITS.cardText} 字）`);
  return t;
}

function cleanRef(v: unknown): BoardRef | null {
  if (v === null) return null;
  if (!v || typeof v !== "object") throw new Reject("bad", "引用的格式不对");
  const r = v as Record<string, unknown>;
  if (!REF_KINDS.has(String(r.kind))) throw new Reject("bad", "引用要是 file、commit、doc 或 url");
  const out: BoardRef = { kind: r.kind as BoardRef["kind"] };
  const str = (k: string, max: number) => {
    if (r[k] === undefined || r[k] === null || r[k] === "") return undefined;
    if (typeof r[k] !== "string" || (r[k] as string).length > max) throw new Reject("bad", `引用的 ${k} 不对`);
    return (r[k] as string).trim();
  };
  const path = str("path", 500);
  const commit = str("commit", 64);
  const version = str("version", 100);
  const url = str("url", 2000);
  const title = str("title", 200);
  if (commit && !/^[0-9a-fA-F]{4,64}$/.test(commit)) throw new Reject("bad", "提交号要是十六进制");
  if (url && !/^https?:\/\//i.test(url)) throw new Reject("bad", "链接要以 http:// 或 https:// 开头");
  if (path) out.path = path.replace(/\\/g, "/");
  if (commit) out.commit = commit.toLowerCase();
  if (version) out.version = version;
  if (url) out.url = url;
  if (title) out.title = title;
  return out;
}

const idOrNull = (v: unknown, what: string): string | null => {
  if (v === null) return null;
  if (typeof v !== "string" || !ID_RE.test(v)) throw new Reject("bad", `${what} 不对`);
  return v;
};

/** An operation's fields, checked (what is not given stays out). */
function cleanFields(raw: unknown): BoardFields {
  if (!raw || typeof raw !== "object") throw new Reject("bad", "fields 要是一个对象");
  const f = raw as Record<string, unknown>;
  const out: BoardFields = {};
  if (f.x !== undefined) out.x = num(f.x, "x");
  if (f.y !== undefined) out.y = num(f.y, "y");
  if (f.w !== undefined) out.w = num(f.w, "w", 0);
  if (f.h !== undefined) out.h = num(f.h, "h", 0);
  if (f.color !== undefined) {
    if (f.color !== null && (typeof f.color !== "string" || !COLOR_RE.test(f.color))) throw new Reject("bad", "颜色不对");
    out.color = f.color as string | null;
  }
  if (f.text !== undefined) out.text = cleanText(f.text);
  if (f.group !== undefined) out.group = idOrNull(f.group, "分组");
  if (f.stale !== undefined) {
    if (typeof f.stale !== "boolean") throw new Reject("bad", "stale 要是 true 或 false");
    out.stale = f.stale;
  }
  if (f.ref !== undefined) out.ref = cleanRef(f.ref);
  if (f.from !== undefined) out.from = idOrNull(f.from, "连线的起点");
  if (f.to !== undefined) out.to = idOrNull(f.to, "连线的终点");
  return out;
}

function itemOf(r: Row): BoardItem {
  return {
    id: String(r.id),
    kind: String(r.kind) as BoardItemKind,
    x: Number(r.x),
    y: Number(r.y),
    w: Number(r.w),
    h: Number(r.h),
    color: r.color == null ? null : String(r.color),
    text: String(r.text),
    group: r.grp == null ? null : String(r.grp),
    session: r.session == null ? null : String(r.session),
    ref: r.ref == null ? null : (JSON.parse(String(r.ref)) as BoardRef),
    from: r.src == null ? null : String(r.src),
    to: r.dst == null ? null : String(r.dst),
    stale: Number(r.stale) === 1,
    version: Number(r.version),
    textVersion: Number(r.text_version),
    alt: r.alt == null ? null : (JSON.parse(String(r.alt)) as BoardItem["alt"]),
    createdBy: String(r.created_by),
    createdAt: Number(r.created_at),
    updatedBy: String(r.updated_by),
    updatedAgent: r.updated_agent == null ? null : String(r.updated_agent),
    updatedAt: Number(r.updated_at),
    deleted: r.deleted_at != null,
    deletedBy: r.deleted_by == null ? null : String(r.deleted_by),
    deletedAt: r.deleted_at == null ? null : Number(r.deleted_at),
  };
}

/** What a big change was (an event of the cowork's): a new card, a deleted one, one marked 已过时. */
export interface BoardBigChange {
  kind: "add" | "delete" | "stale";
  item: BoardItem;
  record: BoardOpRecord;
}

export class CoworkBoard {
  /** cowork → card → who writes its text and until when. */
  private readonly locks = new Map<string, Map<string, { by: string; until: number }>>();
  /** cowork → person → what they show. */
  private readonly presences = new Map<string, Map<string, BoardPresence>>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cowork_board_items (
        cowork_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
        color TEXT, text TEXT NOT NULL DEFAULT '', grp TEXT, session TEXT, ref TEXT, src TEXT, dst TEXT, stale INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL, text_version INTEGER NOT NULL, alt TEXT,
        created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_agent TEXT, updated_at INTEGER NOT NULL,
        deleted_by TEXT, deleted_at INTEGER,
        PRIMARY KEY (cowork_id, id)
      );
      CREATE TABLE IF NOT EXISTS cowork_board_ops (
        cowork_id TEXT NOT NULL, seq INTEGER NOT NULL, op_id TEXT, actor TEXT NOT NULL, agent TEXT, at INTEGER NOT NULL,
        op TEXT NOT NULL, changes TEXT NOT NULL, items TEXT NOT NULL, cards TEXT NOT NULL, undo_of INTEGER, undone_by INTEGER,
        conflict INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (cowork_id, seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS cowork_board_ops_id ON cowork_board_ops(cowork_id, op_id) WHERE op_id IS NOT NULL;
    `);
  }

  seq(coworkId: string): number {
    return Number((this.db.prepare("SELECT MAX(seq) AS s FROM cowork_board_ops WHERE cowork_id = ?").get(coworkId) as Row).s ?? 0);
  }

  private item(coworkId: string, id: string): BoardItem | null {
    const r = this.db.prepare("SELECT * FROM cowork_board_items WHERE cowork_id = ? AND id = ?").get(coworkId, id) as Row | undefined;
    return r ? itemOf(r) : null;
  }

  private write(coworkId: string, it: BoardItem): void {
    this.db
      .prepare(
        `INSERT INTO cowork_board_items (cowork_id, id, kind, x, y, w, h, color, text, grp, session, ref, src, dst, stale, version, text_version, alt, created_by, created_at, updated_by, updated_agent, updated_at, deleted_by, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (cowork_id, id) DO UPDATE SET x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h, color = excluded.color, text = excluded.text,
           grp = excluded.grp, ref = excluded.ref, src = excluded.src, dst = excluded.dst, stale = excluded.stale, version = excluded.version, text_version = excluded.text_version,
           alt = excluded.alt, updated_by = excluded.updated_by, updated_agent = excluded.updated_agent, updated_at = excluded.updated_at, deleted_by = excluded.deleted_by, deleted_at = excluded.deleted_at`,
      )
      .run(
        coworkId,
        it.id,
        it.kind,
        it.x,
        it.y,
        it.w,
        it.h,
        it.color,
        it.text,
        it.group,
        it.session,
        it.ref ? JSON.stringify(it.ref) : null,
        it.from,
        it.to,
        it.stale ? 1 : 0,
        it.version,
        it.textVersion,
        it.alt ? JSON.stringify(it.alt) : null,
        it.createdBy,
        it.createdAt,
        it.updatedBy,
        it.updatedAgent,
        it.updatedAt,
        it.deletedBy,
        it.deletedAt,
      );
  }

  private recordOf(r: Row): BoardOpRecord {
    return {
      seq: Number(r.seq),
      opId: r.op_id == null ? null : String(r.op_id),
      op: (JSON.parse(String(r.op)) as BoardOp).op,
      actor: String(r.actor),
      agent: r.agent == null ? null : String(r.agent),
      at: Number(r.at),
      items: JSON.parse(String(r.items)) as BoardItem[],
      changes: JSON.parse(String(r.changes)) as BoardChange[],
      undoOf: r.undo_of == null ? null : Number(r.undo_of),
      conflict: Number(r.conflict) === 1,
    };
  }

  // ---- text locks

  /** Who writes this card's text now (an expired lock is gone). */
  lockOf(coworkId: string, card: string): BoardLock | null {
    const m = this.locks.get(coworkId);
    const l = m?.get(card);
    if (!l) return null;
    if (l.until <= this.now()) {
      m!.delete(card);
      return null;
    }
    return { card, by: l.by, until: l.until };
  }

  locksOf(coworkId: string): BoardLock[] {
    return [...(this.locks.get(coworkId)?.keys() ?? [])].map((c) => this.lockOf(coworkId, c)).filter((l): l is BoardLock => !!l);
  }

  /**
   * A person starts (or goes on) writing a card's text (`on`), or stops. Taken by someone else: refused (409, who). Each
   * call while writing renews it for BOARD_LOCK_MS. Returns the lock now (null = free).
   */
  lock(coworkId: string, name: string, card: unknown, on: boolean): BoardLock | null {
    if (typeof card !== "string" || !ID_RE.test(card)) throw new RelayError("bad_request", "卡片编号不对");
    const it = this.item(coworkId, card);
    if (!it) throw new RelayError("not_found", "没有这张卡");
    const held = this.lockOf(coworkId, card);
    if (!on) {
      if (held?.by === name) this.locks.get(coworkId)?.delete(card);
      return this.lockOf(coworkId, card);
    }
    if (it.deleted) throw new RelayError("conflict", "这张卡已经删了");
    if (held && held.by !== name) throw new RelayError("conflict", `${held.by} 正在写这张卡`);
    const m = this.locks.get(coworkId) ?? new Map();
    m.set(card, { by: name, until: this.now() + BOARD_LOCK_MS });
    this.locks.set(coworkId, m);
    return this.lockOf(coworkId, card);
  }

  /** Locks that ran out (each let go once): the service pushes them. */
  sweepLocks(): Array<{ coworkId: string; card: string }> {
    const out: Array<{ coworkId: string; card: string }> = [];
    const at = this.now();
    for (const [coworkId, m] of this.locks)
      for (const [card, l] of m)
        if (l.until <= at) {
          m.delete(card);
          out.push({ coworkId, card });
        }
    return out;
  }

  /** Someone went offline (their last connection closed) or left: their locks go. */
  releaseAll(name: string, coworkId?: string): Array<{ coworkId: string; card: string }> {
    const out: Array<{ coworkId: string; card: string }> = [];
    for (const [cw, m] of this.locks) {
      if (coworkId && cw !== coworkId) continue;
      for (const [card, l] of m)
        if (l.by === name) {
          m.delete(card);
          out.push({ coworkId: cw, card });
        }
    }
    return out;
  }

  // ---- presence (in memory)

  /** What `name` shows on the board (open: false, or null, = closed it). Returns everyone's now. */
  setPresence(coworkId: string, name: string, p: { selected?: unknown; dragging?: unknown; open?: unknown } | null): BoardPresence[] {
    const m = this.presences.get(coworkId) ?? new Map<string, BoardPresence>();
    this.presences.set(coworkId, m);
    if (!p || p.open === false) m.delete(name);
    else {
      const selected = Array.isArray(p.selected) ? p.selected.filter((s): s is string => typeof s === "string" && ID_RE.test(s)).slice(0, 50) : [];
      const d = p.dragging as { id?: unknown; x?: unknown; y?: unknown } | null | undefined;
      const dragging = d && typeof d.id === "string" && ID_RE.test(d.id) && typeof d.x === "number" && Number.isFinite(d.x) && typeof d.y === "number" && Number.isFinite(d.y) ? { id: d.id, x: d.x, y: d.y } : null;
      m.set(name, { name, selected, dragging, at: this.now() });
    }
    return this.presenceOf(coworkId);
  }

  presenceOf(coworkId: string): BoardPresence[] {
    const m = this.presences.get(coworkId);
    if (!m) return [];
    const at = this.now();
    for (const [n, p] of m) if (at - p.at > BOARD_PRESENCE_MS) m.delete(n);
    return [...m.values()];
  }

  /** `name` went offline: the coworks whose presence changed. */
  dropPresence(name: string): string[] {
    const out: string[] = [];
    for (const [cw, m] of this.presences) if (m.delete(name)) out.push(cw);
    return out;
  }

  /** Presence reports that ran out: the coworks whose list changed. */
  sweepPresence(): string[] {
    const out: string[] = [];
    const at = this.now();
    for (const [cw, m] of this.presences) {
      let changed = false;
      for (const [n, p] of m) if (at - p.at > BOARD_PRESENCE_MS) changed = m.delete(n) || changed;
      if (changed) out.push(cw);
    }
    return out;
  }

  // ---- reading

  snapshot(coworkId: string, afterValue: unknown): BoardSnapshot {
    const seq = this.seq(coworkId);
    const after = typeof afterValue === "number" && Number.isFinite(afterValue) && afterValue > 0 ? Math.floor(afterValue) : 0;
    const locks = this.locksOf(coworkId);
    if (after > 0 && after <= seq) {
      const rows = this.db.prepare("SELECT * FROM cowork_board_ops WHERE cowork_id = ? AND seq > ? ORDER BY seq LIMIT 1001").all(coworkId, after) as Row[];
      if (rows.length <= 1000) return { seq, full: false, ops: rows.map((r) => this.recordOf(r)), locks };
    }
    return { seq, full: true, items: this.items(coworkId), locks };
  }

  /** Every card, deleted ones too (最近删除). */
  items(coworkId: string): BoardItem[] {
    return (this.db.prepare("SELECT * FROM cowork_board_items WHERE cowork_id = ? ORDER BY created_at, rowid").all(coworkId) as Row[]).map(itemOf);
  }

  /** A card's history, newest first (谁、什么时候、改了什么). */
  history(coworkId: string, card: string, limit = 200): BoardOpRecord[] {
    return (this.db.prepare("SELECT * FROM cowork_board_ops WHERE cowork_id = ? AND cards LIKE ? ORDER BY seq DESC LIMIT ?").all(coworkId, `%,${card},%`, Math.max(1, Math.min(limit, 1000))) as Row[]).map((r) => this.recordOf(r));
  }

  // ---- changing

  /**
   * Applies operations in order, in one transaction. `checkSession` says whether a thread is a 子会话 of this cowork (a
   * session card names one). An agent's call touching more than BOARD_AI_MAX_CARDS cards is refused whole; otherwise an
   * operation that cannot apply is reported by its place and the rest still apply.
   */
  apply(coworkId: string, actor: BoardActor, opsValue: unknown, opts: { checkSession: (threadId: string) => boolean; noLimit?: boolean }): { result: BoardOpsResult; big: BoardBigChange[] } {
    if (!Array.isArray(opsValue)) throw new RelayError("bad_request", "ops 要是一个列表");
    if (opsValue.length > BOARD_OPS_MAX) throw new RelayError("bad_request", `一次最多 ${BOARD_OPS_MAX} 条操作`);
    if (actor.agent && !opts.noLimit) {
      const touched = new Set<string>();
      opsValue.forEach((raw: unknown, i) => {
        const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        if (o.op === "add") touched.add(typeof (o.item as Record<string, unknown> | undefined)?.id === "string" ? String((o.item as Record<string, unknown>).id) : `#new${i}`);
        else if (o.op === "undo" && typeof o.seq === "number") {
          const r = this.db.prepare("SELECT cards FROM cowork_board_ops WHERE cowork_id = ? AND seq = ?").get(coworkId, o.seq) as Row | undefined;
          for (const c of String(r?.cards ?? "").split(",").filter(Boolean)) touched.add(c);
        } else if (typeof o.id === "string") touched.add(o.id);
      });
      if (touched.size > BOARD_AI_MAX_CARDS)
        throw new RelayError("forbidden", `一次最多改 ${BOARD_AI_MAX_CARDS} 张卡（这次是 ${touched.size} 张）。要一次改这么多，先问你的主人，他点头后再分几次改`);
    }
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      let seq = this.seq(coworkId);
      const applied: BoardOpRecord[] = [];
      const rejected: BoardOpsResult["rejected"] = [];
      const big: BoardBigChange[] = [];
      opsValue.forEach((raw: unknown, index) => {
        const o = (raw && typeof raw === "object" ? raw : {}) as BoardOp & Record<string, unknown>;
        const opId = typeof o.opId === "string" && o.opId ? o.opId.slice(0, 80) : null;
        try {
          if (opId) {
            const seen = db.prepare("SELECT * FROM cowork_board_ops WHERE cowork_id = ? AND op_id = ?").get(coworkId, opId) as Row | undefined;
            if (seen) {
              applied.push(this.recordOf(seen));
              return;
            }
          }
          const out = this.applyOne(coworkId, actor, o, opts.checkSession);
          if (!out) return;
          seq += 1;
          const at = this.now();
          const items = out.items.map((it) => this.item(coworkId, it)!);
          const record: BoardOpRecord = { seq, opId, op: o.op, actor: actor.name, agent: actor.agent, at, items, changes: out.changes, undoOf: out.undoOf ?? null, conflict: !!out.conflict };
          db.prepare("INSERT INTO cowork_board_ops (cowork_id, seq, op_id, actor, agent, at, op, changes, items, cards, undo_of, conflict) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
            coworkId,
            seq,
            opId,
            actor.name,
            actor.agent,
            at,
            JSON.stringify(o),
            JSON.stringify(out.changes),
            JSON.stringify(items),
            `,${out.items.join(",")},`,
            out.undoOf ?? null,
            out.conflict ? 1 : 0,
          );
          if (out.undoOf) db.prepare("UPDATE cowork_board_ops SET undone_by = ? WHERE cowork_id = ? AND seq = ?").run(seq, coworkId, out.undoOf);
          applied.push(record);
          for (const b of out.big ?? []) big.push({ kind: b, item: items[0]!, record });
        } catch (err) {
          if (err instanceof Reject) rejected.push({ index, ...(opId ? { opId } : {}), code: err.code, message: err.message, ...(err.by ? { by: err.by } : {}) });
          else throw err;
        }
      });
      db.exec("COMMIT");
      return { result: { seq, applied, rejected }, big };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** One operation: the cards it touched (written already) and its changes; null when it changed nothing. */
  private applyOne(
    coworkId: string,
    actor: BoardActor,
    o: BoardOp & Record<string, unknown>,
    checkSession: (threadId: string) => boolean,
  ): { items: string[]; changes: BoardChange[]; undoOf?: number; conflict?: boolean; big?: Array<BoardBigChange["kind"]> } | null {
    const at = this.now();
    const live = (id: unknown, what = "这张卡"): BoardItem => {
      if (typeof id !== "string" || !ID_RE.test(id)) throw new Reject("bad", "卡片编号不对");
      const it = this.item(coworkId, id);
      if (!it) throw new Reject("missing", `没有${what}：${id}`);
      if (it.deleted) throw new Reject("deleted", `${what}已经删了（可以在「最近删除」里找回）`);
      return it;
    };
    /** Someone else writes its text: an agent never may, a person may not while another person does. */
    const lockedFor = (card: string): BoardLock | null => {
      const l = this.lockOf(coworkId, card);
      return l && (actor.agent || l.by !== actor.name) ? l : null;
    };
    const checkLinks = (kind: BoardItemKind, f: BoardFields, self: string | null) => {
      if (f.group) {
        const g = live(f.group, "这个分组");
        if (g.kind !== "group" || g.id === self) throw new Reject("bad", "group 要是一个分组卡");
      }
      if ((f.from !== undefined || f.to !== undefined) && kind !== "link") throw new Reject("bad", "只有连线有起点和终点");
      if (f.from) live(f.from, "连线的起点");
      if (f.to) live(f.to, "连线的终点");
    };
    const stamp = (it: BoardItem) => {
      it.version += 1;
      it.updatedBy = actor.name;
      it.updatedAgent = actor.agent;
      it.updatedAt = at;
    };
    switch (o.op) {
      case "add": {
        const raw = (o.item && typeof o.item === "object" ? o.item : null) as (Record<string, unknown> & { kind?: unknown }) | null;
        if (!raw) throw new Reject("bad", "add 要带 item");
        const kind = raw.kind as BoardItemKind;
        if (!KINDS.has(kind)) throw new Reject("bad", "卡片的种类要是 note、session、ref、group 或 link");
        const id = raw.id === undefined ? `b_${randomBytes(6).toString("hex")}` : idOrNull(raw.id, "卡片编号");
        if (!id) throw new Reject("bad", "卡片编号不对");
        if (this.item(coworkId, id)) throw new Reject("exists", `已经有这张卡了：${id}`);
        const count = Number((this.db.prepare("SELECT COUNT(*) AS n FROM cowork_board_items WHERE cowork_id = ?").get(coworkId) as Row).n);
        if (count >= BOARD_ITEMS_MAX) throw new Reject("bad", `白板上的卡太多了（最多 ${BOARD_ITEMS_MAX} 张）`);
        const f = cleanFields(raw);
        checkLinks(kind, f, null);
        let session: string | null = null;
        if (kind === "session") {
          if (typeof raw.session !== "string" || !checkSession(raw.session)) throw new Reject("bad", "子会话卡要指向这个协作里的一个子会话");
          session = raw.session;
        }
        if (kind === "link" && (!f.from || !f.to)) throw new Reject("bad", "连线要有起点和终点");
        if (kind === "ref" && !f.ref) throw new Reject("bad", "引用卡要带 ref");
        const [w, h] = SIZE[kind];
        const it: BoardItem = {
          id,
          kind,
          x: f.x ?? 0,
          y: f.y ?? 0,
          w: f.w ?? w,
          h: f.h ?? h,
          color: f.color ?? null,
          text: f.text ?? "",
          group: f.group ?? null,
          session,
          ref: f.ref ?? null,
          from: f.from ?? null,
          to: f.to ?? null,
          stale: f.stale ?? false,
          version: 1,
          textVersion: 1,
          alt: null,
          createdBy: actor.name,
          createdAt: at,
          updatedBy: actor.name,
          updatedAgent: actor.agent,
          updatedAt: at,
          deleted: false,
          deletedBy: null,
          deletedAt: null,
        };
        this.write(coworkId, it);
        return { items: [id], changes: [{ id, before: { deleted: true }, after: { deleted: false } }], big: ["add"] };
      }
      case "set": {
        const it = live(o.id);
        const f = cleanFields(o.fields);
        checkLinks(it.kind, f, it.id);
        if (f.ref !== undefined && it.kind !== "ref") throw new Reject("bad", "只有引用卡有 ref");
        const before: Partial<BoardItem> = {};
        const after: Partial<BoardItem> = {};
        let conflict = false;
        if (f.text !== undefined && f.text !== it.text) {
          const lock = lockedFor(it.id);
          const base = typeof o.base === "number" ? o.base : undefined;
          const older = base !== undefined && it.textVersion > base;
          if (actor.agent && lock) throw new Reject("locked", `${lock.by} 正在写这张卡。等一会再改，或者在旁边另放一张卡、连线指过去`, lock.by);
          if (actor.agent && older) throw new Reject("stale", `这张卡的文字在你读过之后被 ${it.updatedBy} 改过了：先重新读白板再改`, it.updatedBy);
          if (lock || older) {
            // Not over someone else's words: kept beside them for a person to pick (「! 有冲突，看另一版」).
            const alt = { text: f.text, by: actor.name, agent: actor.agent, at };
            before.alt = it.alt;
            after.alt = alt;
            it.alt = alt;
            conflict = true;
            delete f.text;
          }
        }
        for (const k of Object.keys(f) as Array<keyof BoardFields>) {
          if (same(it[k], f[k])) continue;
          (before as Record<string, unknown>)[k] = it[k];
          (after as Record<string, unknown>)[k] = f[k];
          (it as unknown as Record<string, unknown>)[k] = f[k];
        }
        if (!Object.keys(after).length) return null;
        stamp(it);
        if (after.text !== undefined) it.textVersion = it.version;
        this.write(coworkId, it);
        return { items: [it.id], changes: [{ id: it.id, before, after }], conflict, big: after.stale === true ? ["stale"] : [] };
      }
      case "delete": {
        if (typeof o.id !== "string" || !ID_RE.test(o.id)) throw new Reject("bad", "卡片编号不对");
        const it = this.item(coworkId, o.id);
        if (!it) throw new Reject("missing", `没有这张卡：${o.id}`);
        if (it.deleted) return null;
        const lock = lockedFor(it.id);
        if (lock) throw new Reject("locked", `${lock.by} 正在写这张卡，等他写完再删`, lock.by);
        Object.assign(it, { deleted: true, deletedBy: actor.name, deletedAt: at });
        stamp(it);
        this.write(coworkId, it);
        return { items: [it.id], changes: [{ id: it.id, before: { deleted: false }, after: { deleted: true } }], big: ["delete"] };
      }
      case "restore": {
        if (typeof o.id !== "string" || !ID_RE.test(o.id)) throw new Reject("bad", "卡片编号不对");
        const it = this.item(coworkId, o.id);
        if (!it) throw new Reject("missing", `没有这张卡：${o.id}`);
        if (!it.deleted) return null;
        Object.assign(it, { deleted: false, deletedBy: null, deletedAt: null });
        stamp(it);
        this.write(coworkId, it);
        return { items: [it.id], changes: [{ id: it.id, before: { deleted: true }, after: { deleted: false } }] };
      }
      case "resolve": {
        if (actor.agent) throw new Reject("forbidden", "有冲突的卡由人来挑一版");
        const it = live(o.id);
        if (!it.alt) return null;
        const lock = lockedFor(it.id);
        if (lock) throw new Reject("locked", `${lock.by} 正在写这张卡`, lock.by);
        if (o.keep !== "current" && o.keep !== "alt") throw new Reject("bad", "keep 要是 current 或 alt");
        const before: Partial<BoardItem> = { alt: it.alt };
        const after: Partial<BoardItem> = { alt: null };
        if (o.keep === "alt" && it.alt.text !== it.text) {
          before.text = it.text;
          after.text = it.alt.text;
          it.text = it.alt.text;
        }
        it.alt = null;
        stamp(it);
        if (after.text !== undefined) it.textVersion = it.version;
        this.write(coworkId, it);
        return { items: [it.id], changes: [{ id: it.id, before, after }] };
      }
      case "undo": {
        if (typeof o.seq !== "number") throw new Reject("bad", "undo 要带 seq");
        const r = this.db.prepare("SELECT * FROM cowork_board_ops WHERE cowork_id = ? AND seq = ?").get(coworkId, o.seq) as Row | undefined;
        if (!r) throw new Reject("missing", `没有这一步：${o.seq}`);
        const rec = this.recordOf(r);
        if (rec.actor !== actor.name || rec.agent !== actor.agent) throw new Reject("forbidden", "只能撤销自己的操作");
        if (r.undone_by != null) throw new Reject("nothing", "这一步已经撤销过了");
        const changes: BoardChange[] = [];
        const items: string[] = [];
        const big: Array<BoardBigChange["kind"]> = [];
        for (const c of rec.changes) {
          const it = this.item(coworkId, c.id);
          if (!it) continue;
          const before: Partial<BoardItem> = {};
          const after: Partial<BoardItem> = {};
          for (const k of Object.keys(c.after) as Field[]) {
            if (!FIELDS.includes(k)) continue;
            // Only where it still is what that step made it: someone's later change stays.
            if (!same(it[k], c.after[k])) continue;
            if (k === "text" && lockedFor(it.id)) continue;
            (before as Record<string, unknown>)[k] = it[k];
            (after as Record<string, unknown>)[k] = c.before[k] ?? (k === "deleted" || k === "stale" ? false : null);
          }
          if (!Object.keys(after).length) continue;
          for (const [k, v] of Object.entries(after)) (it as unknown as Record<string, unknown>)[k] = v;
          if (after.deleted === true) Object.assign(it, { deletedBy: actor.name, deletedAt: at });
          if (after.deleted === false) Object.assign(it, { deletedBy: null, deletedAt: null });
          stamp(it);
          if (after.text !== undefined) it.textVersion = it.version;
          this.write(coworkId, it);
          changes.push({ id: it.id, before, after });
          items.push(it.id);
          if (after.deleted === true) big.push("delete");
        }
        if (!changes.length) throw new Reject("nothing", "这一步改的地方后来都被别人改过了，没有可撤销的");
        return { items, changes, undoOf: rec.seq, big };
      }
      default:
        throw new Reject("bad", `没有这种操作：${String((o as { op?: unknown }).op)}`);
    }
  }

  /**
   * An agent recorded a commit touching `files`: reference cards citing one of them at another commit are marked 已过时
   * (as the agent's operations, so they show in the history). Returns what it did.
   */
  markStale(coworkId: string, actor: BoardActor, commit: string, files: string[], checkSession: (threadId: string) => boolean): { result: BoardOpsResult; big: BoardBigChange[] } | null {
    const paths = new Set(files.map((f) => f.replace(/\\/g, "/")));
    const c = commit.toLowerCase();
    const hit = this.items(coworkId).filter((it) => it.kind === "ref" && !it.deleted && !it.stale && it.ref?.path && paths.has(it.ref.path) && it.ref.commit && !c.startsWith(it.ref.commit) && !it.ref.commit.startsWith(c));
    if (!hit.length) return null;
    return this.apply(coworkId, actor, hit.map((it) => ({ op: "set", id: it.id, fields: { stale: true } })), { checkSession, noLimit: true });
  }
}
