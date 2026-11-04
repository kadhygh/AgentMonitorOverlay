// 全景's glyphs for deck.gl's font atlas (its TextLayer `_getFontRenderer`), 2026-11-04.
//
// 1. Bitmap glyphs with the whole ink in their cell. deck.gl 9.4 sizes a glyph's cell as actualBoundingBoxRight −
//    actualBoundingBoxLeft from the pen position, but a glyph reaching left of the pen has a positive Left: a small "j"
//    (Segoe UI at 64 px: Left 6, Right 12) got a 6 px cell holding a sliver of its hook and did not show at any size.
//    Here the cell spans the ink on both sides and the pen sits `left` pixels in; deck.gl shifts the image back by that.
// 2. Signed distance field glyphs (`sdf` in the settings) for ground text that is big on the screen (the user asked
//    for text that stays sharp as it is zoomed, like Prezi): the same glyph box, a margin of `radius` round it, and the
//    distance to the edge (TinySDF's encoding: 255·(1 − d/radius − cutoff), so with cutoff 0.25 the edge is where
//    deck.gl's shader draws it, at 0.75). deck.gl's own SDF renderer (TinySDF) cuts the same "j" and clips glyphs to
//    its box; and an atlas of SDF glyphs drawn small breaks thin CJK strokes into dots — so small text stays bitmap.

export interface GlyphSettings {
  fontFamily: string;
  fontWeight: string | number;
  fontSize: number;
  sdf?: boolean;
  radius?: number;
  cutoff?: number;
}

const INF = 1e20;

/** One row or column of the squared distance transform (Felzenszwalb & Huttenlocher), in place. */
function edt1d(grid: Float64Array, offset: number, stride: number, n: number, f: Float64Array, v: Uint16Array, z: Float64Array): void {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset]!;
  for (let q = 1, k = 0, s = 0; q < n; q++) {
    f[q] = grid[offset + q * stride]!;
    const q2 = q * q;
    do {
      const r = v[k]!;
      s = (f[q]! - f[r]! + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k]! && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const r = v[k]!;
    grid[offset + q * stride] = f[r]! + (q - r) * (q - r);
  }
}

function edt(grid: Float64Array, w: number, h: number): void {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const v = new Uint16Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) edt1d(grid, x, w, h, f, v, z);
  for (let y = 0; y < h; y++) edt1d(grid, y * w, 1, w, f, v, z);
}

/**
 * A distance field from coverage (`alpha` 0–255, one per pixel): 255·(1 − d/radius − cutoff), d the signed distance
 * to the edge in pixels (inside negative); anti-aliased coverage puts the edge between pixels (as TinySDF does).
 */
export function sdfFromAlpha(alpha: ArrayLike<number>, w: number, h: number, radius: number, cutoff: number): Uint8ClampedArray {
  const N = w * h;
  const outer = new Float64Array(N).fill(INF);
  const inner = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = alpha[i]! / 255;
    if (a === 0) continue;
    if (a === 1) {
      outer[i] = 0;
      inner[i] = INF;
    } else {
      const d = 0.5 - a;
      outer[i] = d > 0 ? d * d : 0;
      inner[i] = d < 0 ? d * d : 0;
    }
  }
  edt(outer, w, h);
  edt(inner, w, h);
  const out = new Uint8ClampedArray(N);
  for (let i = 0; i < N; i++) out[i] = Math.round(255 - 255 * ((Math.sqrt(outer[i]!) - Math.sqrt(inner[i]!)) / radius + cutoff));
  return out;
}

/** deck.gl's `_getFontRenderer`: measure (the cell) and draw (the image, the pen `left`/`top` pixels in). */
export function glyphs(s: GlyphSettings) {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  const font = `${s.fontWeight} ${s.fontSize}px ${s.fontFamily}`;
  const measure = (char?: string) => {
    ctx.font = font;
    if (char === undefined) {
      const m = ctx.measureText("A");
      return m.fontBoundingBoxAscent ? { advance: 0, width: 0, left: 0, ascent: Math.ceil(m.fontBoundingBoxAscent), descent: Math.ceil(m.fontBoundingBoxDescent) } : { advance: 0, width: 0, left: 0, ascent: s.fontSize * 0.9, descent: s.fontSize * 0.3 };
    }
    const m = ctx.measureText(char);
    if (!m.actualBoundingBoxAscent && !m.actualBoundingBoxDescent) return { advance: m.width, width: Math.ceil(m.width), left: 0, ascent: s.fontSize * 0.9, descent: s.fontSize * 0.3 };
    const left = Math.max(0, Math.ceil(m.actualBoundingBoxLeft));
    return { advance: m.width, width: Math.max(1, left + Math.ceil(Math.max(0, m.actualBoundingBoxRight))), left, ascent: Math.ceil(m.actualBoundingBoxAscent), descent: Math.ceil(m.actualBoundingBoxDescent) };
  };
  // An SDF glyph has a margin of the field's reach round it (deck.gl's `buffer` must leave room for it: see engine.ts).
  const pad = s.sdf ? Math.ceil(s.radius ?? 8) + 1 : 0;
  const draw = (char: string) => {
    const g = measure(char);
    const c = ctx.canvas;
    c.width = Math.max(1, g.width + 2 * pad);
    c.height = Math.max(1, Math.ceil(g.ascent + g.descent) + 2 * pad);
    ctx.font = font;
    ctx.fillStyle = "#000";
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillText(char, pad + g.left, pad + g.ascent);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    if (s.sdf) {
      const N = c.width * c.height;
      const a = new Uint8ClampedArray(N);
      for (let i = 0; i < N; i++) a[i] = img.data[i * 4 + 3]!;
      const d = sdfFromAlpha(a, c.width, c.height, s.radius ?? 8, s.cutoff ?? 0.25);
      for (let i = 0; i < N; i++) {
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 0;
        img.data[i * 4 + 3] = d[i]!;
      }
    }
    return { data: img, left: pad + g.left, top: pad };
  };
  return { measure, draw };
}
