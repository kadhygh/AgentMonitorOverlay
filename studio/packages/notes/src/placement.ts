// Where the 便签 window goes (pure; DIP coordinates). As Studio placed it (app/src/scratchpad-placement.ts): the
// remembered bounds when they still touch a display, otherwise just below and right of the pointer.

export interface Point {
  x: number;
  y: number;
}
export interface Rect extends Point {
  width: number;
  height: number;
}
export interface DisplayInfo {
  workArea: Rect;
}

export const PAD_SIZE = { width: 480, height: 320 };
export const PAD_MIN = { width: 320, height: 200 };
const CURSOR_OFFSET = 12;

const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** The display most of `rect` is on (the nearest one when it is on none). */
export function displayFor(rect: Rect, displays: readonly DisplayInfo[]): DisplayInfo {
  let best = displays[0]!;
  let bestArea = -1;
  for (const d of displays) {
    const a = overlap(rect, d.workArea);
    if (a > bestArea) [best, bestArea] = [d, a];
  }
  if (bestArea > 0) return best;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const distance = (d: DisplayInfo) => {
    const w = d.workArea;
    const dx = Math.max(w.x - cx, 0, cx - (w.x + w.width));
    const dy = Math.max(w.y - cy, 0, cy - (w.y + w.height));
    return dx * dx + dy * dy;
  };
  return displays.reduce((a, b) => (distance(b) < distance(a) ? b : a));
}

export function clampInto(rect: Rect, a: Rect): Rect {
  const width = Math.min(rect.width, a.width);
  const height = Math.min(rect.height, a.height);
  const x = Math.min(Math.max(rect.x, a.x), a.x + a.width - width);
  const y = Math.min(Math.max(rect.y, a.y), a.y + a.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

export function placePad(saved: Rect | null, cursor: Point, displays: readonly DisplayInfo[]): Rect {
  if (saved && displays.some((d) => overlap(saved, d.workArea) > 0)) return clampInto(saved, displayFor(saved, displays).workArea);
  const { width, height } = saved ?? PAD_SIZE;
  const area = displayFor({ ...cursor, width: 1, height: 1 }, displays).workArea;
  let x = cursor.x + CURSOR_OFFSET;
  let y = cursor.y + CURSOR_OFFSET;
  if (x + width > area.x + area.width) x = cursor.x - width - CURSOR_OFFSET;
  if (y + height > area.y + area.height) y = cursor.y - height - CURSOR_OFFSET;
  return clampInto({ x, y, width, height }, area);
}

/** A window of `size` in the middle of the display the pointer is on. */
export function centreAt(size: { width: number; height: number }, cursor: Point, displays: readonly DisplayInfo[]): Rect {
  const a = displayFor({ ...cursor, width: 1, height: 1 }, displays).workArea;
  return clampInto({ x: a.x + (a.width - size.width) / 2, y: a.y + (a.height - size.height) / 2, ...size }, a);
}
