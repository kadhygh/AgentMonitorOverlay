// Floating windows (2026-11-23, plans/cowork.md 第 9 条): a 协作's 子会话 and its 白板 open as windows over the page —
// moved by the title bar, resized by the bottom-right corner, brought to the front by a click, maximized, closed, or
// folded into a row of small tabs above the group chat's box; several at once, each new one a step down and right of
// the last; where each was and how big is kept on this computer per window. This file is the bookkeeping (no React):
// Floats.tsx draws it.

export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface FloatSize {
  w: number;
  h: number;
}

export interface FloatWin {
  id: string;
  title: string;
  /** A short line after the title (a 子会话's state, …); shown on its tab too. */
  status?: string;
  rect: FloatRect;
  z: number;
  minimized: boolean;
  maximized: boolean;
}

export interface FloatOpen {
  id: string;
  title: string;
  status?: string;
  /** Its size when it has none kept. */
  size?: FloatSize;
  /** Where it was last time (loadRect). */
  saved?: FloatRect | null;
}

export type FloatAction =
  | ({ type: "open"; area: FloatSize } & FloatOpen)
  | { type: "close"; id: string }
  | { type: "focus"; id: string }
  | { type: "minimize"; id: string }
  | { type: "restore"; id: string }
  | { type: "toggleMax"; id: string }
  | { type: "move"; id: string; rect: FloatRect; area: FloatSize }
  | { type: "info"; id: string; title?: string; status?: string }
  | { type: "area"; area: FloatSize };

export const FLOAT_MIN: FloatSize = { w: 280, h: 180 };
export const FLOAT_DEFAULT: FloatSize = { w: 520, h: 440 };
/** How far each new window sits from the last (down and right). */
export const FLOAT_STEP = 28;
const FIRST = { x: 24, y: 16 };

/** Inside the area, no smaller than the least size (and no bigger than the area). */
export function clampRect(r: FloatRect, area: FloatSize): FloatRect {
  const w = Math.round(Math.max(Math.min(r.w, area.w), Math.min(FLOAT_MIN.w, area.w)));
  const h = Math.round(Math.max(Math.min(r.h, area.h), Math.min(FLOAT_MIN.h, area.h)));
  const x = Math.round(Math.min(Math.max(r.x, 0), Math.max(area.w - w, 0)));
  const y = Math.round(Math.min(Math.max(r.y, 0), Math.max(area.h - h, 0)));
  return { x, y, w, h };
}

/** A place for a new window: the first step down the diagonal no open one is at; back to the top once it runs out. */
export function cascade(taken: FloatRect[], size: FloatSize, area: FloatSize): FloatRect {
  const fits = (i: number) => FIRST.x + i * FLOAT_STEP + Math.min(size.w, area.w) <= area.w && FIRST.y + i * FLOAT_STEP + Math.min(size.h, area.h) <= area.h;
  for (let i = 0; i < 50 && (i === 0 || fits(i)); i++) {
    const x = FIRST.x + i * FLOAT_STEP;
    const y = FIRST.y + i * FLOAT_STEP;
    if (!taken.some((r) => Math.abs(r.x - x) < FLOAT_STEP / 2 && Math.abs(r.y - y) < FLOAT_STEP / 2)) return clampRect({ x, y, ...size }, area);
  }
  return clampRect({ ...FIRST, ...size }, area);
}

const top = (wins: FloatWin[]) => wins.reduce((z, w) => Math.max(z, w.z), 0) + 1;
const edit = (wins: FloatWin[], id: string, f: (w: FloatWin) => FloatWin) => wins.map((w) => (w.id === id ? f(w) : w));

export function floatsReduce(wins: FloatWin[], a: FloatAction): FloatWin[] {
  switch (a.type) {
    case "open": {
      const had = wins.find((w) => w.id === a.id);
      // Open again: back up, to the front, the newest title.
      if (had) return edit(wins, a.id, (w) => ({ ...w, title: a.title, status: a.status ?? w.status, minimized: false, z: top(wins) }));
      const visible = wins.filter((w) => !w.minimized).map((w) => w.rect);
      // Where it was, unless another open one is there now (then a step aside, as a new one).
      const rect = a.saved && !visible.some((r) => r.x === a.saved!.x && r.y === a.saved!.y) ? clampRect(a.saved, a.area) : cascade(visible, a.saved ? { w: a.saved.w, h: a.saved.h } : (a.size ?? FLOAT_DEFAULT), a.area);
      return [...wins, { id: a.id, title: a.title, status: a.status, rect, z: top(wins), minimized: false, maximized: false }];
    }
    case "close":
      return wins.filter((w) => w.id !== a.id);
    case "focus": {
      const w = wins.find((x) => x.id === a.id);
      // Already in front: nothing changes (a click inside would otherwise draw everything again).
      if (!w || w.z === top(wins) - 1) return wins;
      return edit(wins, a.id, (x) => ({ ...x, z: top(wins) }));
    }
    case "minimize":
      return edit(wins, a.id, (w) => ({ ...w, minimized: true }));
    case "restore":
      return edit(wins, a.id, (w) => ({ ...w, minimized: false, z: top(wins) }));
    case "toggleMax":
      return edit(wins, a.id, (w) => ({ ...w, maximized: !w.maximized, z: top(wins) }));
    case "move":
      return edit(wins, a.id, (w) => ({ ...w, rect: clampRect(a.rect, a.area), maximized: false }));
    case "info":
      return edit(wins, a.id, (w) => ({ ...w, title: a.title ?? w.title, status: a.status ?? w.status }));
    case "area": {
      // The window got smaller: the windows come back inside it.
      let changed = false;
      const out = wins.map((w) => {
        const r = clampRect(w.rect, a.area);
        if (r.x === w.rect.x && r.y === w.rect.y && r.w === w.rect.w && r.h === w.rect.h) return w;
        changed = true;
        return { ...w, rect: r };
      });
      return changed ? out : wins;
    }
  }
}

/** Where a window is kept on this computer (localStorage, per window: a 子会话's thread id, 「board:<协作>」…). */
const rectKey = (id: string) => `amo-relay.float.${id}`;

export function loadRect(id: string): FloatRect | null {
  try {
    const v = JSON.parse(localStorage.getItem(rectKey(id)) ?? "null") as FloatRect | null;
    return v && [v.x, v.y, v.w, v.h].every((n) => typeof n === "number" && Number.isFinite(n)) ? v : null;
  } catch {
    return null;
  }
}

export function saveRect(id: string, r: FloatRect): void {
  try {
    localStorage.setItem(rectKey(id), JSON.stringify(r));
  } catch {
    // storage blocked: it opens in the usual place next time
  }
}
