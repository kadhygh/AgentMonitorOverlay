// 图片缩放、拖拽 (2026-11-11, the user: review 的是一张图片时要能放大、缩小，放大后能拖动，像常规的图片查看器一样；打开时默认显示全图，
// 极窄或极宽的图例外): where a picture sits in its pane, as pure logic. A view is the scale against the picture's own
// size and where its top-left corner is in the pane; an axis on which the picture is smaller than the pane keeps it
// centred there, a larger one keeps it covering the pane (it can be dragged as far as its edges, no further).

export interface Size {
  w: number;
  h: number;
}

export interface ImageLayout {
  scale: number;
  x: number;
  y: number;
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 16;
/** One step of the wheel, of + and −. */
export const ZOOM_STEP = 1.2;

/**
 * Past this ratio of its long side to its short side a picture is not fitted whole (2026-11-11, the user's exception
 * for 极窄或极宽的图): a long page or chat screenshot (taller than 3 times its width) is fitted to the pane's width and
 * shown from its top, a strip (wider than 3 times its height) to the pane's height from its left — whole, it would be
 * a thin line nobody can read. 3 leaves phone screenshots (about 2.2) and ordinary pictures shown whole.
 */
export const LONG_RATIO = 3;

/** Every picture is shown at most at its own size when fitted: a small icon is not blown up. */
export function fitLayout(pane: Size, natural: Size): ImageLayout {
  const w = Math.max(1, natural.w);
  const h = Math.max(1, natural.h);
  const byWidth = pane.w / w;
  const byHeight = pane.h / h;
  let scale = Math.min(1, byWidth, byHeight);
  let top = false;
  let left = false;
  // Only when fitting it whole shrinks it more than fitting the one side would (it does not fit as it is).
  if (h / w > LONG_RATIO && Math.min(1, byWidth) > scale) {
    scale = Math.min(1, byWidth);
    top = true;
  } else if (w / h > LONG_RATIO && Math.min(1, byHeight) > scale) {
    scale = Math.min(1, byHeight);
    left = true;
  }
  scale = Math.max(MIN_SCALE, scale);
  const at = clampLayout(pane, natural, { scale, x: (pane.w - w * scale) / 2, y: (pane.h - h * scale) / 2 });
  return { scale, x: left ? 0 : at.x, y: top ? 0 : at.y };
}

/** On each axis: centred when the picture is smaller than the pane, else no gap between its edge and the pane's. */
export function clampLayout(pane: Size, natural: Size, v: ImageLayout): ImageLayout {
  const axis = (paneLen: number, len: number, at: number) => (len <= paneLen ? (paneLen - len) / 2 : Math.min(0, Math.max(paneLen - len, at)));
  return { scale: v.scale, x: axis(pane.w, natural.w * v.scale, v.x), y: axis(pane.h, natural.h * v.scale, v.y) };
}

/** `scale` changed to `next` (kept within MIN_SCALE..MAX_SCALE) with the point `at` of the pane staying where it is. */
export function zoomAt(pane: Size, natural: Size, v: ImageLayout, next: number, at: { x: number; y: number }): ImageLayout {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
  const k = scale / v.scale;
  return clampLayout(pane, natural, { scale, x: at.x - (at.x - v.x) * k, y: at.y - (at.y - v.y) * k });
}

/** Moved by (dx, dy) from `from`, as far as the edges allow. */
export function panBy(pane: Size, natural: Size, from: ImageLayout, dx: number, dy: number): ImageLayout {
  return clampLayout(pane, natural, { scale: from.scale, x: from.x + dx, y: from.y + dy });
}

/** Whether there is anything to drag: the picture larger than the pane on some axis. */
export const canPan = (pane: Size, natural: Size, v: ImageLayout) => natural.w * v.scale > pane.w + 0.5 || natural.h * v.scale > pane.h + 0.5;
