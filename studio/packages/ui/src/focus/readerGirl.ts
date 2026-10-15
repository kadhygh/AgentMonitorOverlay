import type { BotMood } from "./PixelBot.js";

// 「看书的 Claude 娘」 (2026-10-15 evening), the second Focus pet: pixel art on a 44×54 grid, after a picture the person
// liked — long orange hair, an orange flower clip with a black ribbon and tassel, a cream blouse with a lace collar,
// reading a dark book. Drawn from shapes in layers, back to front; each layer gets its own one-pixel outline, so the
// parts in front (bangs over the face, the book over the blouse) are outlined against what is behind them. Frames are
// computed once per mood and frame and cached.

export const READER_W = 44;
export const READER_H = 54;

/** "mood" is painted in the mood's colour (the 「!」). */
export type Cell = string | null;

const P = {
  O: "#3a2219",
  h: "#f0883a", hs: "#cf6526", hd: "#9c4520", hl: "#ffbb85",
  s: "#ffeadb", ss: "#f6d2bf", bl: "#f7a59a", bl2: "#ef7d72",
  e: "#3a2219", i1: "#6b3416", i2: "#a35a26", i3: "#dc9446", w: "#ffffff", m: "#c98572", md: "#7a2f26", mt: "#e86a6a",
  c: "#f6efe3", cs: "#ddd0bb", lace: "#ffffff",
  f: "#f39a34", fs: "#c86b1c", g: "#d9a441", gl: "#f6d27a",
  k: "#2b2522", ks: "#4a403b", t: "#f1e6cf",
  b: "#3d2b24", bs: "#5a4033", bg: "#c99a3c", pg: "#f4e7c9", pgs: "#d9c7a3",
  red: "#e5484d",
};

type Pt = [number, number];

class Layer {
  px: Cell[] = new Array<Cell>(READER_W * READER_H).fill(null);

  set(x: number, y: number, c: Cell): this {
    x = Math.round(x);
    y = Math.round(y);
    if (x >= 0 && y >= 0 && x < READER_W && y < READER_H) this.px[y * READER_W + x] = c;
    return this;
  }

  get(x: number, y: number): Cell {
    return x >= 0 && y >= 0 && x < READER_W && y < READER_H ? (this.px[y * READER_W + x] ?? null) : null;
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, c: string): this {
    for (let y = 0; y < READER_H; y++)
      for (let x = 0; x < READER_W; x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.px[y * READER_W + x] = c;
      }
    return this;
  }

  poly(pts: Pt[], c: string): this {
    for (let y = 0; y < READER_H; y++)
      for (let x = 0; x < READER_W; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i]!;
          const [xj, yj] = pts[j]!;
          if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) this.px[y * READER_W + x] = c;
      }
    return this;
  }

  line(x0: number, y0: number, x1: number, y1: number, c: string): this {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
    return this;
  }

  /** Paints only where the layer already has paint (shading inside a shape). */
  within(fn: (l: this) => void): this {
    const mask = this.px.slice();
    fn(this);
    for (let k = 0; k < mask.length; k++) if (mask[k] === null) this.px[k] = null;
    return this;
  }

  /** A one-pixel outline around the layer's shape. */
  outline(c: string): this {
    const add: Pt[] = [];
    for (let y = 0; y < READER_H; y++)
      for (let x = 0; x < READER_W; x++) {
        if (this.get(x, y)) continue;
        if (this.get(x - 1, y) || this.get(x + 1, y) || this.get(x, y - 1) || this.get(x, y + 1)) add.push([x, y]);
      }
    for (const [x, y] of add) this.set(x, y, c);
    return this;
  }

  merge(layer: Layer): this {
    for (let k = 0; k < this.px.length; k++) if (layer.px[k]) this.px[k] = layer.px[k]!;
    return this;
  }
}

function backHair(): Layer {
  const L = new Layer().ellipse(22, 20, 18, 17.5, P.h);
  L.poly([[4, 18], [40, 18], [41.5, 32], [43.5, 44], [41, 52], [37.5, 49], [34, 52.5], [30, 48], [14, 48], [10, 52.5], [6.5, 49], [3, 52], [0.5, 44], [2.5, 32]], P.h);
  L.within((l) => {
    // Shade along the outer edge, and long strands.
    l.poly([[0, 30], [6, 30], [8, 54], [0, 54]], P.hs);
    l.poly([[38, 30], [44, 30], [44, 54], [36, 54]], P.hs);
    l.line(6, 26, 4, 46, P.hd).line(9, 30, 8, 50, P.hs);
    l.line(38, 26, 40, 46, P.hd).line(35, 30, 36, 50, P.hs);
  });
  return L.outline(P.O);
}

function body(): Layer {
  const L = new Layer();
  L.poly([[13, 33], [31, 33], [35.5, 50], [8.5, 50]], P.c);
  L.poly([[9, 49], [35, 49], [37, 54], [7, 54]], P.c);
  L.within((l) => {
    l.poly([[8, 46], [13, 40], [14, 54], [7, 54]], P.cs);
    l.poly([[36, 46], [31, 40], [30, 54], [37, 54]], P.cs);
    l.line(9, 50, 35, 50, P.cs);
    // Little orange flowers on the skirt.
    for (const [x, y] of [[13, 52], [31, 52]] as Pt[]) l.set(x, y, P.f).set(x - 1, y, P.fs).set(x + 1, y, P.fs);
  });
  L.outline(P.O);
  // The lace collar over the blouse, and a small flower brooch with a black ribbon.
  const collar = new Layer();
  collar.poly([[15, 33], [22, 36.5], [22, 39], [14, 36]], P.lace);
  collar.poly([[29, 33], [22, 36.5], [22, 39], [30, 36]], P.lace);
  L.merge(collar.outline(P.cs));
  L.line(21, 39, 20, 42, P.k).line(23, 39, 24, 42, P.k);
  L.set(22, 37, P.f).set(21, 38, P.f).set(23, 38, P.f).set(22, 39, P.f).set(22, 38, P.g);
  return L;
}

function eyes(L: Layer, mood: BotMood, frame: string): void {
  [15.5, 28.5].forEach((cx, side) => {
    const x0 = Math.round(cx - 2);
    const outer = side === 0 ? x0 - 1 : x0 + 4;
    if (mood === "calm" && frame === "blink") {
      L.line(x0 - 1, 25, x0 + 4, 25, P.e);
      return;
    }
    if (mood === "angry") {
      // Brows slanting down to the middle; narrowed eyes.
      if (side === 0) L.line(x0 - 1, 19, x0 + 4, 21, P.e).line(x0 - 1, 20, x0 + 4, 22, P.e);
      else L.line(x0 + 4, 19, x0 - 1, 21, P.e).line(x0 + 4, 20, x0 - 1, 22, P.e);
      L.line(x0 - 1, 23, x0 + 4, 23, P.e);
      for (let x = x0; x < x0 + 4; x++) L.set(x, 24, P.i1).set(x, 25, P.i2);
      L.set(side === 0 ? x0 + 2 : x0 + 1, 24, P.w);
      return;
    }
    // Open (alert, looking up) or half-lidded (reading).
    const top = mood === "alert" ? 21 : 23;
    L.line(x0 - 1, top, x0 + 4, top, P.e).set(outer, top - 1, P.e);
    if (mood === "calm") L.line(x0, top - 2, x0 + 3, top - 2, P.hs);
    else L.line(x0, top - 3, x0 + 3, top - 3, P.hd);
    for (let y = top + 1; y <= 27; y++) for (let x = x0; x < x0 + 4; x++) L.set(x, y, y === top + 1 ? P.i1 : y >= 26 ? P.i3 : P.i2);
    L.set(x0 + 2, top + 1, P.w);
    if (mood === "alert") L.set(x0 + 3, top + 2, P.w).set(x0, 26, P.w);
    L.set(x0, 28, P.ss).set(x0 + 3, 28, P.ss);
  });
}

function face(mood: BotMood, frame: string): Layer {
  const L = new Layer().ellipse(22, 23.5, 12.5, 11, P.s).outline(P.O);
  // Shadow under the bangs, and blush.
  for (let x = 10; x <= 34; x++) L.set(x, 17, P.ss);
  const blush = mood === "angry" ? P.bl2 : P.bl;
  for (const [x, y] of [[12, 28], [13, 28], [14, 28], [30, 28], [31, 28], [32, 28]] as Pt[]) L.set(x, y, blush);
  if (mood === "angry") for (const [x, y] of [[13, 29], [31, 29], [12, 27], [32, 27]] as Pt[]) L.set(x, y, blush);
  eyes(L, mood, frame);
  if (mood === "angry") {
    L.line(20, 30, 24, 30, P.md).line(20, 31, 24, 31, P.md).line(21, 31, 23, 31, P.mt).line(21, 32, 23, 32, P.md);
  } else if (mood === "alert") {
    L.set(21, 30, P.md).set(22, 30, P.md).set(21, 31, P.md).set(22, 31, P.md);
  } else {
    L.set(21, 30, P.m).set(22, 30, P.m);
  }
  return L;
}

function bangs(): Layer {
  const L = new Layer().poly(
    [[8, 23], [7.5, 14], [11, 7.5], [17, 4.5], [22, 4], [28, 4.5], [33, 7.5], [36.5, 14], [36, 23], [35.5, 33], [33.5, 30], [32.5, 23], [30.5, 17.5], [28.5, 22], [26.5, 16], [24, 21.5], [21.5, 15.5], [19, 21], [17, 16.5], [14.5, 22], [12.5, 18], [11.5, 24], [10.5, 33], [8.5, 30]],
    P.h,
  );
  L.within((l) => {
    // Gloss on top, strand lines, side locks a shade darker.
    l.line(14, 7, 18, 6, P.hl).line(13, 8, 15, 8, P.hl).line(26, 6, 29, 7, P.hl).line(25, 7, 26, 7, P.hl);
    l.line(17, 9, 15, 16, P.hs).line(22, 8, 21.5, 15, P.hs).line(27, 9, 28, 16, P.hs);
    l.line(10, 19, 10, 31, P.hs).line(34, 19, 34, 31, P.hs);
  });
  return L.outline(P.hd);
}

function clip(): Layer {
  // A black ribbon behind the flower, with a cream tassel on a gold bead.
  const L = new Layer();
  L.poly([[35, 10], [41.5, 8], [41.5, 15], [36, 13]], P.k);
  L.poly([[35, 12], [36.5, 19], [39.5, 19.5], [37.5, 12]], P.k);
  L.line(39, 12, 40, 20, P.k).line(38, 11, 41, 10, P.ks).line(37, 14, 38, 18, P.ks);
  L.set(40, 21, P.g).set(40, 22, P.gl);
  L.poly([[39, 23], [41.5, 23], [41.8, 27.5], [38.7, 27.5]], P.t);
  L.outline(P.O);
  // An eight-petal flower: pointed petals with gaps between them, so the outline shows each one.
  const F = new Layer();
  const cx = 33;
  const cy = 8.5;
  const petal = (a: number) => (a / 8) * Math.PI * 2 + 0.2;
  for (let a = 0; a < 8; a++) {
    const t = petal(a);
    F.poly([[cx, cy], [cx + Math.cos(t - 0.5) * 2.8, cy + Math.sin(t - 0.5) * 2.8], [cx + Math.cos(t) * 5.6, cy + Math.sin(t) * 5.6], [cx + Math.cos(t + 0.5) * 2.8, cy + Math.sin(t + 0.5) * 2.8]], P.f);
  }
  F.within((l) => {
    for (let a = 0; a < 8; a++) {
      const t = petal(a);
      l.line(cx + Math.cos(t) * 2.5, cy + Math.sin(t) * 2.5, cx + Math.cos(t) * 4.2, cy + Math.sin(t) * 4.2, P.fs);
    }
  });
  F.outline(P.O).ellipse(cx, cy, 1.7, 1.7, P.g).set(32, 8, P.gl);
  return L.merge(F);
}

function book(mood: BotMood, frame: string): Layer {
  const L = new Layer().poly([[6, 41.5], [22, 38.5], [38, 41.5], [37, 48.5], [22, 46.5], [7, 48.5]], P.b);
  L.within((l) => {
    l.line(8, 47, 21, 45, P.bs).line(23, 45, 36, 47, P.bs);
    l.line(8, 42.5, 8, 47, P.bg).line(36, 42.5, 36, 47, P.bg);
    // The emblems on the cover.
    l.set(29, 44, P.bg).set(28, 45, P.bg).set(30, 45, P.bg).set(29, 46, P.bg).set(29, 45, P.gl);
    l.set(15, 44, P.bg).set(14, 45, P.bg).set(16, 45, P.bg).set(15, 46, P.bg);
  });
  L.outline(P.O);
  const pages = new Layer().poly([[8, 40], [22, 37], [36, 40], [36, 42.6], [22, 40], [8, 42.6]], P.pg);
  pages.within((l) => {
    l.line(8, 42, 21, 39.5, P.pgs).line(23, 39.5, 36, 42, P.pgs);
    l.line(11, 40, 19, 38.5, P.pgs).line(25, 38.5, 33, 40, P.pgs);
  });
  pages.outline(P.O).line(22, 37, 22, 40, P.bs);
  L.merge(pages);
  if (mood === "calm" && frame === "flip") {
    // A page turning on the right.
    const turning = new Layer().poly([[24, 38.5], [29, 33.5], [34, 36.5], [33, 39.5]], P.pg);
    turning.within((l) => l.line(26, 37, 31, 35.5, P.pgs));
    L.merge(turning.outline(P.O));
  }
  return L;
}

function hands(): Layer {
  // Holding the book by its sides.
  const L = new Layer().ellipse(6.5, 44.5, 2.2, 2.4, P.s).ellipse(37.5, 44.5, 2.2, 2.4, P.s);
  L.within((l) => l.set(6, 46, P.ss).set(38, 46, P.ss));
  return L.outline(P.O);
}

function mark(mood: BotMood, frame: string): Layer {
  const L = new Layer();
  if (mood === "alert" && frame !== "off") {
    // 「!」 in the mood colour, in the free corner above the hair.
    L.poly([[1, 0], [3.6, 0], [3.2, 5.5], [1.4, 5.5]], "mood").ellipse(2.3, 8, 1.3, 1.3, "mood");
    L.outline(P.O);
  } else if (mood === "angry") {
    // A pulsing vein on the hair, and steam.
    const big = frame === "pulse";
    const vein: Pt[] = big ? [[5, 4], [6, 5], [7, 4], [5, 6], [7, 6], [4, 3], [8, 3], [4, 7], [8, 7]] : [[5, 4], [6, 5], [7, 4], [5, 6], [7, 6]];
    for (const [x, y] of vein) L.set(x, y, P.red);
    if (big) L.set(2, 1, "#ffffff").set(3, 0, "#ffffff").set(41, 1, "#ffffff").set(40, 0, "#ffffff");
  }
  return L;
}

/** Frame order per mood, and how long each frame shows. */
export const READER_FRAMES: Record<BotMood, { ms: number; list: string[] }> = {
  alert: { ms: 300, list: ["on", "off"] },
  calm: { ms: 450, list: ["read", "read", "read", "read", "flip", "flip", "read", "read", "read", "blink", "read", "read"] },
  angry: { ms: 180, list: ["pulse", "still"] },
};

const cache = new Map<string, Cell[]>();

/** One frame: colours row by row (null = clear, "mood" = the mood's colour). */
export function readerFrame(mood: BotMood, frame: string): Cell[] {
  const key = `${mood}:${frame}`;
  let px = cache.get(key);
  if (!px) {
    const out = new Layer();
    for (const layer of [backHair(), body(), face(mood, frame), bangs(), clip(), book(mood, frame), hands(), mark(mood, frame)]) out.merge(layer);
    px = out.px;
    cache.set(key, px);
  }
  return px;
}
