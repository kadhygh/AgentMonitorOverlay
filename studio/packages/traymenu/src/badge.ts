// A count drawn as a small red badge (2026-10-29, the user: 中转's taskbar and tray icons blink with the number of
// what waits). Electron's main process has no canvas, so this draws the pixels itself: a pill with soft edges and the
// digits from two pixel fonts, kept on whole pixels so they stay sharp at 16 px. Pure (no Electron), so it is tested;
// badge-image.ts makes Electron images from it.
// Pixels are BGRA, premultiplied: what Electron's nativeImage.createFromBitmap takes and toBitmap gives on Windows.

/** What the badge says: nothing for none, the number up to 99, then 99+. */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  return count > 99 ? "99+" : String(Math.floor(count));
}

type Font = { w: number; h: number; glyphs: Record<string, string[]> };

const FONT7: Font = {
  w: 5,
  h: 7,
  glyphs: {
    "0": [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
    "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
    "3": [".###.", "#...#", "....#", "..##.", "....#", "#...#", ".###."],
    "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
    "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
    "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
    "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
    "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
    "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
    "+": [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
  },
};

const FONT5: Font = {
  w: 3,
  h: 5,
  glyphs: {
    "0": ["###", "#.#", "#.#", "#.#", "###"],
    "1": [".#.", "##.", ".#.", ".#.", "###"],
    "2": ["###", "..#", "###", "#..", "###"],
    "3": ["###", "..#", "###", "..#", "###"],
    "4": ["#.#", "#.#", "###", "..#", "..#"],
    "5": ["###", "#..", "###", "..#", "###"],
    "6": ["###", "#..", "###", "#.#", "###"],
    "7": ["###", "..#", "..#", ".#.", ".#."],
    "8": ["###", "#.#", "###", "#.#", "###"],
    "9": ["###", "#.#", "###", "..#", "###"],
    "+": ["...", ".#.", "###", ".#.", "..."],
  },
};

/** A font at a whole-pixel scale: how big `text` comes out. */
type Type = { font: Font; scale: number; width: number; height: number };
const typeset = (font: Font, scale: number, text: string): Type => ({ font, scale, width: (text.length * font.w + (text.length - 1)) * scale, height: font.h * scale });

/** Every font and scale, the tallest first (the 5×7 one before the 3×5 one at the same height). */
function candidates(text: string): Type[] {
  const out: Type[] = [];
  for (const scale of [6, 5, 4, 3, 2, 1]) for (const font of [FONT7, FONT5]) out.push(typeset(font, scale, text));
  return out.sort((a, b) => b.height - a.height || (b.font === FONT7 ? 1 : 0) - (a.font === FONT7 ? 1 : 0));
}

/** The badge's red and its edge: clear on a light taskbar and on a dark one, with white digits. */
const FILL = [0x2f, 0x3b, 0xe0] as const; // BGR of #e03b2f
const EDGE = [0x1c, 0x24, 0xa8] as const; // BGR of #a8241c

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How much of the pixel at (px, py) is inside the pill `box` grown by `grow` (4×4 samples). */
function coverage(box: Box, px: number, py: number, grow = 0): number {
  const w = box.w + 2 * grow;
  const h = box.h + 2 * grow;
  const r = h / 2;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  let inside = 0;
  for (let sy = 0; sy < 4; sy++)
    for (let sx = 0; sx < 4; sx++) {
      const x = px + (sx + 0.5) / 4;
      const y = py + (sy + 0.5) / 4;
      const dx = Math.max(Math.abs(x - cx) - (w / 2 - r), 0);
      const dy = Math.max(Math.abs(y - cy) - (h / 2 - r), 0);
      if (dx * dx + dy * dy <= r * r) inside++;
    }
  return inside / 16;
}

/** src over dst, premultiplied BGRA, at pixel i (src colour straight, alpha a). */
function over(px: Uint8Array, i: number, bgr: readonly number[], a: number): void {
  if (a <= 0) return;
  const keep = 1 - a;
  for (let c = 0; c < 3; c++) px[i + c] = Math.round(bgr[c]! * a + px[i + c]! * keep);
  px[i + 3] = Math.round(255 * a + px[i + 3]! * keep);
}

/**
 * The pill and the text in `box` of a `size`×`size` image (in place). `cut` px around it are cleared first, so on top
 * of an icon the badge stands apart from it. The type is the tallest that fits the pill with room around it.
 */
function paint(px: Uint8Array, size: number, box: Box, text: string, type: Type, cut: number): void {
  const edge = Math.max(1, Math.round(size / 24));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (cut > 0) {
        const hole = coverage(box, x, y, cut);
        if (hole > 0) for (let c = 0; c < 4; c++) px[i + c] = Math.round(px[i + c]! * (1 - hole));
      }
      const outer = coverage(box, x, y);
      if (outer <= 0) continue;
      over(px, i, EDGE, outer);
      over(px, i, FILL, coverage(box, x, y, -edge));
    }
  // The digits, on whole pixels.
  const x0 = Math.round(box.x + (box.w - type.width) / 2);
  const y0 = Math.round(box.y + (box.h - type.height) / 2);
  [...text].forEach((ch, n) => {
    const rows = type.font.glyphs[ch];
    if (!rows) return;
    const gx = x0 + n * (type.font.w + 1) * type.scale;
    rows.forEach((row, ry) =>
      [...row].forEach((dot, rx) => {
        if (dot !== "#") return;
        for (let sy = 0; sy < type.scale; sy++)
          for (let sx = 0; sx < type.scale; sx++) {
            const x = gx + rx * type.scale + sx;
            const y = y0 + ry * type.scale + sy;
            if (x < 0 || y < 0 || x >= size || y >= size) continue;
            const i = (y * size + x) * 4;
            px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 255;
          }
      }),
    );
  });
}

/** The type and pill for a badge `h` px tall, at most `maxW` wide: the tallest type with room around it. */
function fit(text: string, h: number, maxW: number): { type: Type; w: number } {
  const padY = Math.max(1, Math.round(h * 0.2));
  const padX = Math.max(1, Math.round(h * 0.18));
  for (const type of candidates(text)) {
    if (type.height > h - 2 * padY) continue;
    const w = Math.max(h, type.width + 2 * padX);
    if (w > maxW) continue;
    // In a round badge (as wide as tall) the text's corners must stay inside the circle too.
    if (w === h) {
      const r = h / 2 - Math.max(1, h * 0.06);
      if (Math.hypot(type.width / 2, type.height / 2) > r) continue;
    }
    return { type, w };
  }
  const type = typeset(FONT5, 1, text);
  return { type, w: Math.min(maxW, Math.max(h, type.width + 2)) };
}

/** The taskbar's overlay (setOverlayIcon): the badge alone, as big as the image. */
export function countBadge(size: number, count: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const text = badgeText(count);
  if (!text) return px;
  const { type, w } = fit(text, size, size);
  paint(px, size, { x: (size - w) / 2, y: 0, w, h: size }, text, type, 0);
  return px;
}

/** The tray icon (`icon`: its BGRA pixels, `size`×`size`) with the badge at its bottom right, standing a little apart. */
export function iconWithBadge(icon: Uint8Array, size: number, count: number): Uint8Array {
  const px = new Uint8Array(icon);
  const text = badgeText(count);
  if (!text) return px;
  const h = Math.round(size * 0.625);
  const { type, w } = fit(text, h, size);
  paint(px, size, { x: size - w, y: size - h, w, h }, text, type, Math.max(1, Math.round(size / 16)));
  return px;
}
