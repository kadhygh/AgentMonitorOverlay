import { matterSettled, SETTLED_GROUP_TITLE, type BoardItem, type Matter } from "./shared.js";

// The 事项 on a 协作's 白板 (2026-11-25, the user: 「白板按说能够根据会话和事项算出来吧，不用主控亲自改出来是吧」,
// plans/collab-framework.md「看过原型后定的」): computed here from the 事项, never stored as cards — one frame per side
// (负责方) and one 「已定 / 已验」 frame; a 事项's card in its side's frame, moved to 「已定 / 已验」 once settled; the lines of
// what depends on what. Only where a person dragged a card is kept (on the service); such a card stays where it was put.
// No React: Board.tsx draws it, tests drive it alone.

export const MATTER_CARD = { w: 264, h: 136 };
const PAD = 16;
const HEAD = 40;
const GAP = 16;
const COLS = 2;
const FRAME_GAP = 48;
const EMPTY_H = 72;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MatterFrame extends Rect {
  /** The side's account, or null for 「已定 / 已验」. */
  side: string | null;
  title: string;
  /** Its 事项 (ids) in the order drawn. */
  matters: string[];
}

export interface MatterLayout {
  frames: MatterFrame[];
  /** Each 事项's card; `placed`: where a person dragged it (outside the frames' order). */
  cards: Record<string, Rect & { placed: boolean }>;
  /** 依赖: `from` must finish before `to`. */
  links: Array<{ from: string; to: string }>;
}

/** Order inside a side's frame: what waits on people first, then on others, then work going on. */
const ORDER: Record<Matter["status"], number> = { confirm: 0, waiting: 1, doing: 2, review: 3, pushed: 4, todo: 5, verified: 6, closed: 7 };

/**
 * Lay the 事项 out. `sides`: the order of the sides' frames (the cowork's people); a side with no 事项 gets a frame only if
 * listed in `keepEmpty`. `placed`: positions people dragged cards to (by 事项 id).
 */
export function layoutMatters(matters: readonly Matter[], sides: readonly string[], placed: Readonly<Record<string, { x: number; y: number }>>, keepEmpty: readonly string[] = []): MatterLayout {
  const cards: MatterLayout["cards"] = {};
  const frames: MatterFrame[] = [];
  const order = [...sides, ...[...new Set(matters.map((m) => m.side))].filter((s) => !sides.includes(s))];
  let x = 0;
  const frameOf = (side: string | null, title: string, list: Matter[]) => {
    const free = list.filter((m) => !placed[m.id]);
    const rows = Math.ceil(free.length / COLS);
    const w = PAD * 2 + COLS * MATTER_CARD.w + (COLS - 1) * GAP;
    const h = HEAD + (rows ? rows * MATTER_CARD.h + (rows - 1) * GAP : EMPTY_H) + PAD;
    free.forEach((m, i) => {
      cards[m.id] = { x: x + PAD + (i % COLS) * (MATTER_CARD.w + GAP), y: HEAD + Math.floor(i / COLS) * (MATTER_CARD.h + GAP), w: MATTER_CARD.w, h: MATTER_CARD.h, placed: false };
    });
    frames.push({ side, title, x, y: 0, w, h, matters: free.map((m) => m.id) });
    x += w + FRAME_GAP;
  };
  for (const side of order) {
    const list = matters.filter((m) => m.side === side && !matterSettled(m)).sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.no - b.no);
    if (!list.length && !keepEmpty.includes(side)) continue;
    frameOf(side, side, list);
  }
  const settled = matters.filter((m) => matterSettled(m)).sort((a, b) => a.no - b.no);
  if (settled.length) frameOf(null, SETTLED_GROUP_TITLE, settled);
  for (const m of matters) {
    const p = placed[m.id];
    if (p) cards[m.id] = { x: Math.round(p.x), y: Math.round(p.y), w: MATTER_CARD.w, h: MATTER_CARD.h, placed: true };
  }
  const links = matters.flatMap((m) => m.dependsOn.filter((d) => cards[d] && cards[m.id]).map((d) => ({ from: d, to: m.id })));
  return { frames, cards, links };
}

/**
 * The board's own cards and the 事项 layer side by side. The service keeps no cards for 事项 (2026-11-25): where a person
 * dragged one is the 事项's own `place`. 子会话 cards an older service made are not drawn: a person's line to one lands on
 * its 事项's card (`standIn`), and the side frames it made are left out too.
 */
export function splitBoard(items: readonly BoardItem[], matters: readonly Pick<Matter, "id" | "place">[] = []): { own: BoardItem[]; placed: Record<string, { x: number; y: number }>; standIn: Record<string, string> } {
  const own: BoardItem[] = [];
  const placed: Record<string, { x: number; y: number }> = {};
  const standIn: Record<string, string> = {};
  for (const it of items) {
    if (it.kind === "session") {
      if (it.session) standIn[it.id] = it.session;
      continue;
    }
    if (it.kind === "group" && (it as BoardItem & { side?: unknown }).side) continue;
    own.push(it);
  }
  for (const m of matters) if (m.place) placed[m.id] = { x: m.place.x, y: m.place.y };
  return { own, placed, standIn };
}

/** Where a point off the visible box is, for the arrow on the edge pointing at it: the edge point and the direction. */
export function edgeArrow(target: { x: number; y: number }, box: { w: number; h: number }, margin = 24): { x: number; y: number; angle: number } | null {
  if (target.x >= 0 && target.x <= box.w && target.y >= 0 && target.y <= box.h) return null;
  const cx = box.w / 2;
  const cy = box.h / 2;
  const dx = target.x - cx;
  const dy = target.y - cy;
  const sx = dx === 0 ? Infinity : (cx - margin) / Math.abs(dx);
  const sy = dy === 0 ? Infinity : (cy - margin) / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s, angle: (Math.atan2(dy, dx) * 180) / Math.PI };
}

/** The box around everything (frames, cards, the board's own cards): what 看全部 fits. */
export function boundsOf(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null;
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
