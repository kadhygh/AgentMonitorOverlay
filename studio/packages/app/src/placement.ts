// Window placement across displays. Everything here is in Electron's DIP (device-independent pixel) coordinates, the
// same space `screen.getAllDisplays()` reports work areas in, so mixed scale factors need no conversion: a display at
// 150% simply has a smaller work area in DIP. Pure functions, so placement is unit-tested without Electron.

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

export interface DisplayInfo {
  id: number;
  workArea: Rect;
  scaleFactor: number;
}

export const FOCUS_MARGIN = 12;
/** A saved main window counts as reachable when this much of its title strip lies on some display. */
const TITLE_STRIP = 40;
const MIN_VISIBLE_W = 120;

function overlap(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  return r > x && btm > y ? { x, y, width: r - x, height: btm - y } : null;
}

const area = (r: Rect | null) => (r ? r.width * r.height : 0);
const inside = (r: Rect, a: Rect) => r.x >= a.x && r.y >= a.y && r.x + r.width <= a.x + a.width && r.y + r.height <= a.y + a.height;

/** The display a rectangle mostly lies on; if it lies on none, the display whose work area is nearest its centre. */
export function displayFor(rect: Rect, displays: readonly DisplayInfo[]): DisplayInfo {
  let best = displays[0]!;
  let bestArea = -1;
  for (const d of displays) {
    const a = area(overlap(rect, d.workArea));
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
  return [...displays].sort((a, b) => distance(a) - distance(b))[0]!;
}

/** Moves (and if needed shrinks) a rectangle so it lies fully inside the area. */
export function clampInto(rect: Rect, a: Rect): Rect {
  const width = Math.min(rect.width, a.width);
  const height = Math.min(rect.height, a.height);
  const x = Math.min(Math.max(rect.x, a.x), a.x + a.width - width);
  const y = Math.min(Math.max(rect.y, a.y), a.y + a.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/** Bottom-right corner of a work area, `margin` away from its edges. */
export function cornerOf(a: Rect, size: Size, margin = FOCUS_MARGIN): Point {
  return { x: Math.round(a.x + a.width - size.width - margin), y: Math.round(a.y + a.height - size.height - margin) };
}

const primaryOf = (displays: readonly DisplayInfo[], primaryId: number) => displays.find((d) => d.id === primaryId) ?? displays[0]!;

/**
 * Where the Focus window goes: its remembered position if that still lies on a display (pulled fully inside the work
 * area it mostly sits on), otherwise the bottom-right corner of the primary display.
 */
export function placeFocus(saved: Point | null, size: Size, displays: readonly DisplayInfo[], primaryId: number): Point {
  if (saved) {
    const rect = { ...saved, ...size };
    if (displays.some((d) => overlap(rect, d.workArea))) {
      const { x, y } = clampInto(rect, displayFor(rect, displays).workArea);
      return { x, y };
    }
  }
  return cornerOf(primaryOf(displays, primaryId).workArea, size);
}

/**
 * After displays change (unplugged, rearranged, rescaled): a Focus window still fully on a work area stays; one cut
 * off is pulled inside the display it mostly sits on; one left on no display goes back to the primary's corner.
 */
export function refitFocus(current: Rect, displays: readonly DisplayInfo[], primaryId: number): Point {
  if (displays.some((d) => inside(current, d.workArea))) return { x: current.x, y: current.y };
  return placeFocus({ x: current.x, y: current.y }, current, displays, primaryId);
}

/**
 * Bounds for the workbench window: the remembered bounds if enough of the title strip lies on some display (shrunk
 * to that display if it no longer fits), otherwise the default size centred on the primary display.
 */
export function placeMain(saved: Rect | null, defaultSize: Size, displays: readonly DisplayInfo[], primaryId: number): Rect {
  if (saved) {
    const strip = { x: saved.x, y: saved.y, width: saved.width, height: TITLE_STRIP };
    const reachable = displays.some((d) => {
      const o = overlap(strip, d.workArea);
      return !!o && o.width >= Math.min(MIN_VISIBLE_W, saved.width) && o.height >= TITLE_STRIP / 2;
    });
    if (reachable) {
      const a = displayFor(saved, displays).workArea;
      return saved.width <= a.width && saved.height <= a.height ? { ...saved } : clampInto(saved, a);
    }
  }
  const a = primaryOf(displays, primaryId).workArea;
  const width = Math.min(defaultSize.width, a.width);
  const height = Math.min(defaultSize.height, a.height);
  return { x: Math.round(a.x + (a.width - width) / 2), y: Math.round(a.y + (a.height - height) / 2), width, height };
}
