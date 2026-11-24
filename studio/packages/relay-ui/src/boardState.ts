import type { BoardFields, BoardItem, BoardLock, BoardOp, BoardOpRecord, BoardSnapshot } from "./shared.js";

// The 白板 of a 协作 as this client holds it (2026-11-23, plans/cowork.md「白板：多人同时改」): the cards the service has
// (each with its version), the text locks, my own operations to undo, and what I did while the service could not be
// reached (sent again, in order, when it can). No React: Board.tsx draws it, tests drive it on their own.

export interface BoardModel {
  seq: number;
  items: Record<string, BoardItem>;
  locks: Record<string, BoardLock>;
  /** My operations (seq), newest last: Ctrl+Z takes back the last one not undone yet. */
  mine: number[];
  /** Operations not yet taken by the service (offline), in order. */
  pending: BoardOp[];
}

export const emptyBoard = (): BoardModel => ({ seq: 0, items: {}, locks: {}, mine: [], pending: [] });

/** A snapshot from the service: every card (full), or the operations since what I have. */
export function fromSnapshot(m: BoardModel, s: BoardSnapshot, me: string): BoardModel {
  const locks = Object.fromEntries(s.locks.map((l) => [l.card, l]));
  if (s.full) return { ...m, seq: s.seq, items: Object.fromEntries((s.items ?? []).map((i) => [i.id, i])), locks };
  return { ...applyRecords(m, s.ops ?? [], me), seq: Math.max(m.seq, s.seq), locks };
}

/** Applied operations (pushed, or the answer to mine): each card as it is after, unless I have a newer one. */
export function applyRecords(m: BoardModel, records: BoardOpRecord[], me: string): BoardModel {
  if (!records.length) return m;
  const items = { ...m.items };
  let mine = m.mine;
  let seq = m.seq;
  for (const r of [...records].sort((a, b) => a.seq - b.seq)) {
    seq = Math.max(seq, r.seq);
    for (const it of r.items) if (!items[it.id] || items[it.id]!.version <= it.version) items[it.id] = it;
    if (r.actor === me && !r.agent && r.op !== "resolve") {
      // An undo takes its target off my list (Ctrl+Z again goes one further back); others go on it.
      if (r.op === "undo") mine = mine.filter((s) => s !== r.undoOf);
      else if (!mine.includes(r.seq)) mine = [...mine, r.seq];
    }
  }
  return { ...m, items, mine, seq };
}

export function setLock(m: BoardModel, card: string, lock: BoardLock | null): BoardModel {
  const locks = { ...m.locks };
  if (lock) locks[card] = lock;
  else delete locks[card];
  return { ...m, locks };
}

/** Someone else is writing this card's text now. */
export function lockedBy(m: BoardModel, card: string, me: string, now = Date.now()): string | null {
  const l = m.locks[card];
  return l && l.by !== me && l.until > now ? l.by : null;
}

export const live = (m: BoardModel) => Object.values(m.items).filter((i) => !i.deleted);
export const deletedItems = (m: BoardModel) => Object.values(m.items).filter((i) => i.deleted && i.kind !== "link").sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));

/** The cards in a group (not links, not groups). */
export const childrenOf = (m: BoardModel, group: string) => live(m).filter((i) => i.group === group && i.kind !== "link" && i.kind !== "group");

/** The group a card's centre falls in (the last drawn wins), other than itself. */
export function groupAt(m: BoardModel, x: number, y: number, not?: string): string | null {
  const groups = live(m).filter((i) => i.kind === "group" && i.id !== not);
  for (let k = groups.length - 1; k >= 0; k--) {
    const g = groups[k]!;
    if (x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h) return g.id;
  }
  return null;
}

/**
 * A card dropped at (x, y): its place, and the group it falls into when that changed. A group moved takes its cards
 * along (one operation per card, each on the version I have).
 */
export function moveOps(m: BoardModel, id: string, x: number, y: number, opId: () => string): BoardOp[] {
  const it = m.items[id];
  if (!it) return [];
  const fields: BoardFields = { x: Math.round(x), y: Math.round(y) };
  if (it.kind === "group") {
    const dx = fields.x! - it.x;
    const dy = fields.y! - it.y;
    return [{ op: "set", opId: opId(), id, base: it.version, fields }, ...childrenOf(m, id).map((c): BoardOp => ({ op: "set", opId: opId(), id: c.id, base: c.version, fields: { x: c.x + dx, y: c.y + dy } }))];
  }
  if (it.kind !== "link") {
    const g = groupAt(m, fields.x! + it.w / 2, fields.y! + it.h / 2, id);
    if (g !== it.group) fields.group = g;
  }
  return [{ op: "set", opId: opId(), id, base: it.version, fields }];
}

/** The last of my operations to take back (Ctrl+Z), or null. */
export const nextUndo = (m: BoardModel): number | null => m.mine.at(-1) ?? null;

/** A card's place on screen and back, for a view panned to (x, y) and zoomed by k. */
export const toScreen = (v: { x: number; y: number; k: number }, p: { x: number; y: number }) => ({ x: p.x * v.k + v.x, y: p.y * v.k + v.y });
export const toBoard = (v: { x: number; y: number; k: number }, p: { x: number; y: number }) => ({ x: (p.x - v.x) / v.k, y: (p.y - v.y) / v.k });

/** Zoom by `f` around a screen point (the wheel's), within 25 %–200 %. */
export function zoomAt(v: { x: number; y: number; k: number }, f: number, at: { x: number; y: number }) {
  const k = Math.min(2, Math.max(0.25, Math.round(v.k * f * 100) / 100));
  const p = toBoard(v, at);
  return { k, x: at.x - p.x * k, y: at.y - p.y * k };
}

/** The view that shows every card, in a box of this size (回到中间). */
export function fitView(m: BoardModel, box: { w: number; h: number }) {
  const cards = live(m).filter((i) => i.kind !== "link");
  if (!cards.length) return { x: 40, y: 40, k: 1 };
  const x0 = Math.min(...cards.map((c) => c.x));
  const y0 = Math.min(...cards.map((c) => c.y));
  const x1 = Math.max(...cards.map((c) => c.x + c.w));
  const y1 = Math.max(...cards.map((c) => c.y + c.h));
  const k = Math.min(1, Math.max(0.25, Math.min((box.w - 60) / (x1 - x0), (box.h - 60) / (y1 - y0))));
  return { k: Math.round(k * 100) / 100, x: (box.w - (x1 - x0) * k) / 2 - x0 * k, y: (box.h - (y1 - y0) * k) / 2 - y0 * k };
}

/** Where a new card goes: the middle of what is on screen, a little lower for each card already there. */
export function freeSpot(m: BoardModel, v: { x: number; y: number; k: number }, box: { w: number; h: number }, size: { w: number; h: number }, avoid: ReadonlyArray<{ x: number; y: number; w: number; h: number }> = []) {
  const c = toBoard(v, { x: box.w / 2, y: box.h / 2 });
  let x = Math.round(c.x - size.w / 2);
  let y = Math.round(c.y - size.h / 2);
  const taken = live(m);
  // Not on top of a 事项's card (2026-11-25: they are drawn from the 事项, the service's model has no card there): the free
  // spot nearest the middle of what is on screen, on a 24-unit grid; none free → the middle as before.
  const blocks = [...avoid, ...taken.filter((t) => t.kind !== "group" && t.kind !== "link")];
  const hits = (px: number, py: number) => blocks.some((b) => px < b.x + b.w && px + size.w > b.x && py < b.y + b.h && py + size.h > b.y);
  if (avoid.length && hits(x, y)) {
    const tl = toBoard(v, { x: 0, y: 0 });
    const br = toBoard(v, { x: box.w, y: box.h });
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let yy = tl.y + 12; yy + size.h <= br.y; yy += 24)
      for (let xx = tl.x + 12; xx + size.w <= br.x; xx += 24) {
        const d = (xx - x) ** 2 + (yy - y) ** 2;
        if (d < bestD && !hits(xx, yy)) [best, bestD] = [{ x: xx, y: yy }, d];
      }
    if (best) return { x: Math.round(best.x), y: Math.round(best.y) };
  }
  for (let i = 0; i < 20 && taken.some((t) => t.kind !== "group" && t.kind !== "link" && Math.abs(t.x - x) < 16 && Math.abs(t.y - y) < 16); i++) [x, y] = [x + 24, y + 24];
  return { x, y };
}
