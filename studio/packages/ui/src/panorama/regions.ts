// 全景's regions (2026-11-03, the user): a topic is a region of the map, its shape worked out from what stands in it —
// the lanes, the status boards, the spine, the header — so it describes the parts (like an area on a map) with an
// irregular beauty of its own. Two themes the user picked from studio/plans/userlayer/sketches (gen.mjs, sketches.html):
//
// - `terrain`: an island. A distance field from what stands in it, plus noise and a domain warp, cut at 0 by marching
//   squares; no contour lines inside, a faint fill and a soft glow in from the coast; nothing outside (no islets, no
//   shoals). Between projects a bay is cut only where it can go deep (east and west in turn), else a faint dotted line;
//   none between the 主控 part and the projects, none on a single project's island.
// - `metro`: the same field on a coarse grid, cut into 0°/45°/90° steps; the parts split by level lines with 45° bevels.
//
// Pure: no deck.gl, no AMO — it takes a topic's frame (layout.ts builds it from the datalayer) in layout units, x east
// and y *down* (south), as the sketches do, and gives polygons and lines in the same frame. The algorithm runs in the
// sketches' units (a round there is 26, here 18): ported as it was, parameters and all. The seed comes from the topic's
// id, so a topic keeps its shape every time it is opened. Two things the sketches still had are mended here: the coast
// could hang out a long thin spike (an opening of the field takes them off), and an east bay's side along the lanes was
// straight as a knife cut (the land kept by the lanes now has a wobbly edge).

export type XY = [number, number];
export type WorldKind = "terrain" | "metro";

/** Something that stands in a region: a segment or a rectangle; `shape` only shapes it (not drawn), `lane` is a road. */
export interface ShapeEl {
  seg?: [number, number, number, number];
  rect?: [number, number, number, number];
  shape?: boolean;
  lane?: boolean;
}

/** A project's part (or, last, the 主控 part: header, documents, board, the top of the spine). */
export interface ShapeGroup {
  els: ShapeEl[];
  common: boolean;
  pi: number;
}

/** A topic as the region generator sees it (layout units, y down); `x0` is where its spine stands (west reference). */
export interface TopicFrame {
  seed: number;
  x0: number;
  groups: ShapeGroup[];
  /** Per project: its rows' top and bottom, how far it is shifted east (`metro`), where its lanes end, its west lobe. */
  bands: { top: number; bottom: number; shift: number; end: number; lobe: number }[];
  /** Per project: its status board. */
  cards: { x: number; y: number; w: number; h: number }[];
  /** The spine's top; the header's bottom (the 主控 part above the first band). */
  spineTop: number;
  headBottom: number;
  /** `metro`: where a band's lanes leave its station (x), the bevel of a dividing line is there. */
  hubX: number[];
  /**
   * What must lie on the land with `margin` to spare (11-04, the user: a 公告板 hung out over the metro coast): every
   * board, lane, ring and the boxes of the text printed on the ground. Made land after the noise, the bays and the
   * chamfers, so nothing of the topic is ever in the sea.
   */
  must?: ShapeEl[];
  margin?: number;
}

export interface TopicShape {
  /** The outline, closed rings (the biggest first). */
  coast: XY[][];
  /** `terrain`: rings inside the coast at growing depth (for the glow in from it), deepest last. */
  insets: { depth: number; rings: XY[][] }[];
  /** `terrain`: each group's part (index as `groups`); `metro`: the bands' parts (0 the 主控 part, then the projects). */
  zones: { g: number; common: boolean; rings: XY[][] }[];
  /** Dividing lines (open): dotted on the island, dashed on the metro map. */
  borders: XY[][];
  /** How each divide was cut (index 0 is the 主控 part's): east / west bay or none. */
  cuts: ("none" | "east" | "west")[];
}

/** Layout units to the sketches' units (a round 18 here, 26 there). */
const K = 18 / 26;

/** A stable 32-bit seed from an id (FNV-1a). */
export function seedOf(id: string): number {
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

// ---------------- random and noise (as gen.mjs) ----------------

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Noise = (x: number, y: number) => number;

function makeNoise(seed: number): Noise {
  const r = rng(seed);
  const perm = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [perm[i], perm[j]] = [perm[j]!, perm[i]!];
  }
  const p = new Uint8Array(512);
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255]!;
  const G = [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const grad = (h: number, x: number, y: number) => {
    const g = G[h & 7]!;
    return g[0]! * x + g[1]! * y;
  };
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => {
    const X = Math.floor(x);
    const Y = Math.floor(y);
    const xf = x - X;
    const yf = y - Y;
    const xi = X & 255;
    const yi = Y & 255;
    const u = fade(xf);
    const v = fade(yf);
    const aa = p[p[xi]! + yi]!;
    const ab = p[p[xi]! + yi + 1]!;
    const ba = p[p[xi + 1]! + yi]!;
    const bb = p[p[xi + 1]! + yi + 1]!;
    const x1 = grad(aa, xf, yf) + u * (grad(ba, xf - 1, yf) - grad(aa, xf, yf));
    const x2 = grad(ab, xf, yf - 1) + u * (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1));
    return x1 + v * (x2 - x1);
  };
}

/** Fractal noise, about −1 to 1. */
function fbm(n: Noise, x: number, y: number, oct = 4, gain = 0.5): number {
  let s = 0;
  let a = 1;
  let f = 1;
  let t = 0;
  for (let i = 0; i < oct; i++) {
    s += a * n(x * f + i * 17.3, y * f - i * 9.1);
    t += a;
    a *= gain;
    f *= 2.03;
  }
  return (s / t) * 1.9;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// ---------------- distance field ----------------

const smin = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};

function dist(el: ShapeEl, x: number, y: number): number {
  if (el.seg) {
    const [ax, ay, bx, by] = el.seg;
    const vx = bx - ax;
    const vy = by - ay;
    const L = vx * vx + vy * vy;
    const t = L ? clamp(((x - ax) * vx + (y - ay) * vy) / L, 0, 1) : 0;
    return Math.hypot(x - ax - t * vx, y - ay - t * vy);
  }
  const [rx, ry, rw, rh] = el.rect!;
  const dx = Math.max(rx - x, 0, x - rx - rw);
  const dy = Math.max(ry - y, 0, y - ry - rh);
  return Math.hypot(dx, dy);
}

function distGroup(els: readonly ShapeEl[], x: number, y: number, k: number): number {
  let d = 1e9;
  for (const el of els) d = smin(d, dist(el, x, y), k);
  return d;
}

/** Plain nearest distance to any of els (∞ when none). */
function distMin(els: readonly ShapeEl[], x: number, y: number): number {
  let d = 1e9;
  for (const el of els) d = Math.min(d, dist(el, x, y));
  return d;
}

interface Grid {
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  c: number;
}

interface Field extends Grid {
  e: Float32Array;
  zs: Float32Array[];
  must: ShapeEl[];
  margin: number;
}

/** The sketches' parameters of the two themes (gen.mjs DIRS.terrain / DIRS.metro). */
const PRM = {
  terrain: { R: 50, A: 20, L: 160, oct: 4, gA: 3, k: 30, seed: 6, warp: 46, LW: 190, guardA: 40, guardB: 1.5, channel: 50, chW: 26, cell: 4 },
  metro: { R: 44, A: 20, L: 190, oct: 3, gA: 8, k: 26, seed: 3, warp: 50, LW: 210, guardA: 40, guardB: 1.5, channel: 0, chW: 26, cell: 6 },
};
/** Mends: how wide a spike the opening takes off (cells), the land the lanes keep (sketch units) and how much its edge wobbles. */
const MEND = { open: 2, keep: 16, bay: 20, wobble: 8 };

/** Where bays are cut between projects (gen.mjs layoutTopic): only deep enough ones, never twice from one side in a row. */
function cutStyles(f: SFrame): TopicShape["cuts"] {
  const out: TopicShape["cuts"] = ["none"];
  const off = Math.floor(rng(f.seed * 7 + 3)() * 2);
  for (let k = 1; k < f.bands.length; k++) {
    const a = f.bands[k - 1]!;
    const b = f.bands[k]!;
    const ok = { west: Math.min(a.lobe, b.lobe) >= 62, east: Math.min(a.end, b.end) - f.x0 >= 380 };
    const prev = out[k - 1];
    const pref = prev === "east" ? "west" : prev === "west" ? "east" : (["east", "west"] as const)[(off + k) % 2]!;
    const other = pref === "east" ? "west" : "east";
    out.push(ok[pref] ? pref : prev === "none" && ok[other] ? other : "none");
  }
  return out;
}

/** The frame in the sketches' units. */
type SFrame = TopicFrame;

function toSketch(f: TopicFrame): SFrame {
  const s = (v: number) => v / K;
  const el = (e: ShapeEl): ShapeEl => ({ ...e, seg: e.seg?.map(s) as ShapeEl["seg"], rect: e.rect?.map(s) as ShapeEl["rect"] });
  return {
    seed: f.seed,
    x0: s(f.x0),
    groups: f.groups.map((g) => ({ ...g, els: g.els.map(el) })),
    bands: f.bands.map((b) => ({ top: s(b.top), bottom: s(b.bottom), shift: s(b.shift), end: s(b.end), lobe: s(b.lobe) })),
    cards: f.cards.map((c) => ({ x: s(c.x), y: s(c.y), w: s(c.w), h: s(c.h) })),
    spineTop: s(f.spineTop),
    headBottom: s(f.headBottom),
    hubX: f.hubX.map(s),
    must: f.must?.map(el),
    margin: f.margin === undefined ? undefined : s(f.margin),
  };
}

function bbox(f: SFrame): [number, number, number, number] {
  let x0 = 1e9;
  let y0 = 1e9;
  let x1 = -1e9;
  let y1 = -1e9;
  for (const e of [...f.groups.flatMap((g) => g.els), ...(f.must ?? [])]) {
    const pts = e.seg
      ? [
          [e.seg[0], e.seg[1]],
          [e.seg[2], e.seg[3]],
        ]
      : [
          [e.rect![0], e.rect![1]],
          [e.rect![0] + e.rect![2], e.rect![1] + e.rect![3]],
        ];
    for (const [px, py] of pts) {
      x0 = Math.min(x0, px!);
      y0 = Math.min(y0, py!);
      x1 = Math.max(x1, px!);
      y1 = Math.max(y1, py!);
    }
  }
  return [x0, y0, x1, y1];
}

/** gen.mjs buildGrid for one topic: e > 0 is land; zs[g] how much group g stands above the others (0 is a divide). */
function buildField(f: SFrame, kind: WorldKind, cuts: TopicShape["cuts"]): Field {
  const prm = PRM[kind];
  const cell = prm.cell;
  const [bx0, by0, bx1, by1] = bbox(f);
  const pad = prm.R + prm.A + 90;
  const x0 = bx0 - pad;
  const y0 = by0 - pad;
  const nx = Math.ceil((bx1 - bx0 + 2 * pad) / cell) + 1;
  const ny = Math.ceil((by1 - by0 + 2 * pad) / cell) + 1;
  const ng = f.groups.length;
  const N = nx * ny;
  const S = f.seed;
  const base = makeNoise(S * 31 + prm.seed);
  const gn = f.groups.map((_, g) => makeNoise(S * 131 + g * 17 + prm.seed));
  const wx = makeNoise(S * 41 + prm.seed);
  const wy = makeNoise(S * 43 + prm.seed);
  const nb = makeNoise(S * 53 + prm.seed);
  const W = prm.warp;
  const LW = prm.LW;
  const core = f.groups.map((g) => g.els.filter((e) => !e.shape));
  const lanes = f.groups.map((g) => g.els.filter((e) => e.lane));
  const e = new Float32Array(N);
  const ez = f.groups.map(() => new Float32Array(N));
  const protect = new Float32Array(N);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * cell;
      const y = y0 + j * cell;
      const k = j * nx + i;
      const b = prm.A * fbm(base, x / prm.L, y / prm.L, prm.oct);
      // The sample point warped (the coast gets bays and capes); near the lanes the land is kept all the same.
      const qx = x + W * fbm(wx, x / LW, y / LW, 3);
      const qy = y + W * fbm(wy, x / LW, y / LW, 3);
      let best = -1e9;
      let keep = -1e9;
      let zb = -1e9;
      let zbi = 0;
      let z2 = -1e9;
      let zsi = 0;
      let prot = -1e9;
      for (let g = 0; g < ng; g++) {
        const G = f.groups[g]!;
        const R = G.common ? prm.R * 0.72 : prm.R;
        let v = R - distGroup(G.els, qx, qy, prm.k) + b + prm.gA * fbm(gn[g]!, x / 70, y / 70, 2);
        const d0 = distGroup(core[g]!, x, y, prm.k);
        const dl = lanes[g]!.length ? distGroup(lanes[g]!, x, y, prm.k) : 1e9;
        const guard = prm.guardA - prm.guardB * dl;
        v = Math.max(v, guard);
        keep = Math.max(keep, MEND.keep - d0);
        prot = Math.max(prot, guard);
        const zv = (ez[g]![k] = R - d0 + 8 * fbm(gn[g]!, x / 90, y / 90, 2));
        if (zv > zb) {
          z2 = zb;
          zsi = zbi;
          zb = zv;
          zbi = g;
        } else if (zv > z2) {
          z2 = zv;
          zsi = g;
        }
        if (v > best) best = v;
      }
      protect[k] = Math.max(keep, prot);
      if (prm.channel) {
        // Bays between projects (none between the 主控 part and them): east from the east side in, west up to the spine.
        const gb = f.groups[zbi]!;
        const gs = f.groups[zsi]!;
        if (!gb.common && !gs.common) {
          const sty = cuts[1 + Math.min(gb.pi, gs.pi)] ?? "none";
          const w = prm.chW;
          const near = Math.exp(-(((zb - z2) / (sty === "west" ? w * 1.6 : w * 1.9)) ** 2));
          const lx = x - f.x0;
          if (sty === "east" || sty === "west") {
            const ramp = sty === "east" ? clamp((lx - 150) / 120, 0, 1) : clamp((4 - lx) / 26, 0, 1);
            const t = ramp * near;
            // The land the lanes keep has a wobbly edge (the sketches' was a straight cut along them).
            const keepW = keep - MEND.keep + MEND.bay + MEND.wobble * fbm(nb, x / 38, y / 38, 2);
            best = Math.max(best * (1 - t) - prm.channel * 0.5 * t, keepW);
          }
        }
      }
      e[k] = i === 0 || j === 0 || i === nx - 1 || j === ny - 1 ? -200 : best;
    }
  // Long thin spikes off the coast: an opening of the field (erode, then dilate) takes them off; then a light blur.
  const opened = blur(dilate(erode(e, nx, ny, MEND.open), nx, ny, MEND.open), nx, ny);
  for (let k = 0; k < N; k++) e[k] = Math.max(opened[k]!, Math.min(e[k]!, protect[k]!));
  // What must be on the land is, with its margin (the field rises to 0 at the margin's edge, a little past it inside).
  const must = f.must ?? [];
  const mm = f.margin ?? 0;
  const mustAt = new Float32Array(N).fill(-1e9);
  if (must.length)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const k = j * nx + i;
        const v = mm - distMin(must, x0 + i * cell, y0 + j * cell);
        if (v > -cell * 2) {
          mustAt[k] = v;
          e[k] = Math.max(e[k]!, v);
        }
      }
  for (let i = 0; i < nx; i++) e[i] = e[(ny - 1) * nx + i] = -200;
  for (let j = 0; j < ny; j++) e[j * nx] = e[j * nx + nx - 1] = -200;
  // Lakes filled: only what the grid's edge reaches is sea.
  const sea = new Uint8Array(N);
  const st: number[] = [];
  for (let i = 0; i < nx; i++) st.push(i, (ny - 1) * nx + i);
  for (let j = 0; j < ny; j++) st.push(j * nx, j * nx + nx - 1);
  while (st.length) {
    const k = st.pop()!;
    if (sea[k] || e[k]! > 0) continue;
    sea[k] = 1;
    const i = k % nx;
    const j = (k - i) / nx;
    if (i > 0) st.push(k - 1);
    if (i < nx - 1) st.push(k + 1);
    if (j > 0) st.push(k - nx);
    if (j < ny - 1) st.push(k + nx);
  }
  for (let k = 0; k < N; k++) if (!sea[k] && e[k]! <= 0) e[k] = 0.5;
  // Islets (land the main island does not reach) go: nothing outside the island (but nothing that must stay).
  dropIslets(e, nx, ny);
  for (let k = 0; k < N; k++) if (mustAt[k]! > 0) e[k] = Math.max(e[k]!, mustAt[k]!);
  const zs: Float32Array[] = [];
  for (let g = 0; g < ng; g++) {
    const a = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      let o = -1e9;
      for (let h = 0; h < ng; h++) if (h !== g) o = Math.max(o, ez[h]![k]!);
      a[k] = ez[g]![k]! - o;
    }
    zs.push(a);
  }
  return { nx, ny, x0, y0, c: cell, e, zs, must, margin: mm };
}

function minmax(f: Float32Array, nx: number, ny: number, r: number, max: boolean): Float32Array {
  const pick = max ? Math.max : Math.min;
  const a = new Float32Array(f.length);
  const b = new Float32Array(f.length);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let v = f[j * nx + i]!;
      for (let d = 1; d <= r; d++) v = pick(v, f[j * nx + Math.max(0, i - d)]!, f[j * nx + Math.min(nx - 1, i + d)]!);
      a[j * nx + i] = v;
    }
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let v = a[j * nx + i]!;
      for (let d = 1; d <= r; d++) v = pick(v, a[Math.max(0, j - d) * nx + i]!, a[Math.min(ny - 1, j + d) * nx + i]!);
      b[j * nx + i] = v;
    }
  return b;
}
const erode = (f: Float32Array, nx: number, ny: number, r: number) => minmax(f, nx, ny, r, false);
const dilate = (f: Float32Array, nx: number, ny: number, r: number) => minmax(f, nx, ny, r, true);

function blur(f: Float32Array, nx: number, ny: number): Float32Array {
  const out = new Float32Array(f.length);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let s = 0;
      let n = 0;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          s += f[jj * nx + ii]!;
          n++;
        }
      out[j * nx + i] = s / n;
    }
  return out;
}

/** Keep only the biggest piece of land. */
function dropIslets(e: Float32Array, nx: number, ny: number): void {
  const lab = new Int32Array(e.length).fill(-1);
  const sizes: number[] = [];
  for (let s = 0; s < e.length; s++) {
    if (lab[s]! >= 0 || e[s]! <= 0) continue;
    const id = sizes.length;
    let n = 0;
    const st = [s];
    lab[s] = id;
    while (st.length) {
      const k = st.pop()!;
      n++;
      const i = k % nx;
      for (const q of [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, k - nx, k + nx]) {
        if (q < 0 || q >= e.length || lab[q]! >= 0 || e[q]! <= 0) continue;
        lab[q] = id;
        st.push(q);
      }
    }
    sizes.push(n);
  }
  if (sizes.length < 2) return;
  const big = sizes.indexOf(Math.max(...sizes));
  for (let k = 0; k < e.length; k++) if (lab[k]! >= 0 && lab[k] !== big) e[k] = -1;
}

// ---------------- marching squares ----------------

interface Line {
  pts: XY[];
  closed: boolean;
}

function iso(G: Grid, f: ArrayLike<number>, level: number): Line[] {
  const { nx, ny, x0, y0, c } = G;
  const at = (i: number, j: number) => f[j * nx + i]!;
  const pts = new Map<number, XY>();
  const ept = (key: number, i0: number, j0: number, i1: number, j1: number) => {
    if (!pts.has(key)) {
      const a = at(i0, j0) - level;
      const b = at(i1, j1) - level;
      const t = a / (a - b);
      pts.set(key, [x0 + (i0 + (i1 - i0) * t) * c, y0 + (j0 + (j1 - j0) * t) * c]);
    }
    return key;
  };
  const segs: [number, number][] = [];
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = +(at(i, j) > level);
      const b = +(at(i + 1, j) > level);
      const cc = +(at(i + 1, j + 1) > level);
      const d = +(at(i, j + 1) > level);
      const idx = a * 8 + b * 4 + cc * 2 + d;
      if (idx === 0 || idx === 15) continue;
      const T = () => ept((j * nx + i) * 2, i, j, i + 1, j);
      const R = () => ept((j * nx + i + 1) * 2 + 1, i + 1, j, i + 1, j + 1);
      const B = () => ept(((j + 1) * nx + i) * 2, i, j + 1, i + 1, j + 1);
      const L = () => ept((j * nx + i) * 2 + 1, i, j, i, j + 1);
      const ctr = () => (at(i, j) + at(i + 1, j) + at(i + 1, j + 1) + at(i, j + 1)) / 4 > level;
      switch (idx) {
        case 1:
        case 14:
          segs.push([L(), B()]);
          break;
        case 2:
        case 13:
          segs.push([B(), R()]);
          break;
        case 3:
        case 12:
          segs.push([L(), R()]);
          break;
        case 4:
        case 11:
          segs.push([T(), R()]);
          break;
        case 6:
        case 9:
          segs.push([T(), B()]);
          break;
        case 7:
        case 8:
          segs.push([L(), T()]);
          break;
        case 5:
          if (ctr()) segs.push([L(), T()], [B(), R()]);
          else segs.push([L(), B()], [T(), R()]);
          break;
        case 10:
          if (ctr()) segs.push([L(), B()], [T(), R()]);
          else segs.push([L(), T()], [B(), R()]);
          break;
      }
    }
  const adj = new Map<number, number[]>();
  segs.forEach((s, k) => {
    for (const q of s) {
      if (!adj.has(q)) adj.set(q, []);
      adj.get(q)!.push(k);
    }
  });
  const used = new Uint8Array(segs.length);
  const lines: Line[] = [];
  const extend = (ch: number[]) => {
    for (;;) {
      const last = ch[ch.length - 1]!;
      const nb = adj.get(last)!.find((q) => !used[q]);
      if (nb === undefined) break;
      used[nb] = 1;
      const s = segs[nb]!;
      ch.push(s[0] === last ? s[1] : s[0]);
    }
  };
  for (let k = 0; k < segs.length; k++) {
    if (used[k]) continue;
    used[k] = 1;
    const ch = [segs[k]![0], segs[k]![1]];
    extend(ch);
    ch.reverse();
    extend(ch);
    const closed = ch.length > 2 && ch[0] === ch[ch.length - 1];
    if (closed) ch.pop();
    lines.push({ pts: ch.map((q) => pts.get(q)!), closed });
  }
  return lines;
}

function chaikin(l: Line, it = 2): Line {
  let p = l.pts;
  for (let n = 0; n < it; n++) {
    const m = p.length;
    if (m < 3) break;
    const q: XY[] = [];
    for (let i = 0; i < (l.closed ? m : m - 1); i++) {
      const a = p[i]!;
      const b = p[(i + 1) % m]!;
      q.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (!l.closed) {
      q.unshift(p[0]!);
      q.push(p[m - 1]!);
    }
    p = q;
  }
  return { pts: p, closed: l.closed };
}

/** Only the stretches where `pred` holds (a divide only inside the land). */
function clipLines(lines: Line[], pred: (p: XY) => boolean): Line[] {
  const out: Line[] = [];
  for (const l of lines) {
    const ok = l.pts.map(pred);
    if (ok.every(Boolean)) {
      out.push(l);
      continue;
    }
    let run: XY[] = [];
    const n = l.pts.length;
    const start = l.closed ? ok.indexOf(false) : 0;
    for (let s = 0; s < (l.closed ? n + 1 : n); s++) {
      const i = (start + s) % n;
      if (ok[i]) run.push(l.pts[i]!);
      else {
        if (run.length > 1) out.push({ pts: run, closed: false });
        run = [];
      }
    }
    if (run.length > 1) out.push({ pts: run, closed: false });
  }
  return out;
}

export function ringArea(pts: readonly XY[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s / 2);
}

/** Corners only (the metro outline's straight runs). */
function simplifyOcto(l: Line): Line {
  const p = l.pts;
  const n = p.length;
  const q: XY[] = [];
  for (let i = 0; i < n; i++) {
    const a = p[(i - 1 + n) % n]!;
    const b = p[i]!;
    const c = p[(i + 1) % n]!;
    if (!l.closed && (i === 0 || i === n - 1)) {
      q.push(b);
      continue;
    }
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) > 1e-3) q.push(b);
  }
  return { pts: q, closed: l.closed };
}

function sample(G: Grid, f: ArrayLike<number>, x: number, y: number): number {
  const fx = (x - G.x0) / G.c;
  const fy = (y - G.y0) / G.c;
  if (fx < 0 || fy < 0 || fx >= G.nx - 1 || fy >= G.ny - 1) return -1e9;
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const u = fx - i;
  const v = fy - j;
  const k = j * G.nx + i;
  return (f[k]! * (1 - u) + f[k + 1]! * u) * (1 - v) + (f[k + G.nx]! * (1 - u) + f[k + G.nx + 1]! * u) * v;
}

// ---------------- the two themes ----------------

const cache = new Map<string, TopicShape>();

/** What a topic's shape is cached by: the theme and everything that shapes it (its frame, to a tenth of a unit). */
export function shapeKey(frame: TopicFrame, kind: WorldKind): string {
  return kind + JSON.stringify(frame, (_, v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v));
}
/** A shape worked out before (here or, put here, by the worker: shapes.ts). */
export function cachedShape(key: string): TopicShape | undefined {
  return cache.get(key);
}
export function putShape(key: string, shape: TopicShape): void {
  if (cache.size > 64) cache.clear();
  cache.set(key, shape);
}

/** A topic's region in its own frame (layout units, y down). The same frame always gives the same shape (cached). */
export function topicShape(frame: TopicFrame, kind: WorldKind): TopicShape {
  const key = shapeKey(frame, kind);
  const hit = cache.get(key);
  if (hit) return hit;
  const f = toSketch(frame);
  const cuts = kind === "terrain" ? cutStyles(f) : f.bands.map(() => "none" as const);
  const F = buildField(f, kind, cuts);
  const back = (l: Line): XY[] => l.pts.map(([x, y]) => [x * K, y * K]);
  let shape: TopicShape;
  if (kind === "terrain") {
    const coast = iso(F, F.e, 0).filter((l) => l.closed && ringArea(l.pts) > 3000).map((l) => chaikin(l));
    // Close together (a step of 1.5): drawn wide and faint they melt into one glow, not contour lines (the user: none inside).
    const insets = Array.from({ length: 15 }, (_, k) => 1.5 * (k + 1)).map((depth) => ({ depth: depth * K, rings: iso(F, F.e, depth).filter((l) => l.closed && ringArea(l.pts) > 1500).map((l) => back(chaikin(l))) }));
    const zones = f.groups.map((g, gi) => {
      const zf = new Float32Array(F.e.length);
      for (let k = 0; k < zf.length; k++) zf[k] = Math.min(F.zs[gi]![k]!, F.e[k]!);
      return { g: gi, common: g.common, rings: iso(F, zf, 0).filter((l) => l.closed && ringArea(l.pts) > 3000).map((l) => back(chaikin(l))) };
    });
    const borders = f.groups.flatMap((_, gi) => clipLines(iso(F, F.zs[gi]!, 0), (p) => sample(F, F.e, p[0], p[1]) > 4).map((l) => back(chaikin(l))));
    shape = { coast: coast.sort((a, b) => ringArea(b.pts) - ringArea(a.pts)).map(back), insets, zones, borders: dedupe(borders), cuts };
  } else {
    // A coarse 0/1 mask of the land, its outline only 0°, 45° and 90°.
    const C = 22;
    const nx = Math.ceil((F.nx * F.c) / C) + 1;
    const ny = Math.ceil((F.ny * F.c) / C) + 1;
    const M: Grid = { nx, ny, x0: F.x0, y0: F.y0, c: C };
    const v = new Float32Array(nx * ny);
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) v[j * nx + i] = sample(F, F.e, F.x0 + i * C, F.y0 + j * C) > 0 ? 1 : 0;
    // The outline runs between a land and a sea corner and the 45° steps cut corners off: a cell whose square comes
    // within the margin of what must be on land gets all four corners land, so that stretch is wholly inside.
    if (F.must.length)
      for (let j = 0; j < ny - 1; j++)
        for (let i = 0; i < nx - 1; i++) {
          if (distMin(F.must, F.x0 + (i + 0.5) * C, F.y0 + (j + 0.5) * C) > F.margin + C * Math.SQRT1_2) continue;
          for (const k of [j * nx + i, j * nx + i + 1, (j + 1) * nx + i, (j + 1) * nx + i + 1]) {
            const ii = k % nx;
            const jj = (k - ii) / nx;
            if (ii > 0 && jj > 0 && ii < nx - 1 && jj < ny - 1) v[k] = 1;
          }
        }
    const coast = iso(M, v, 0.5)
      .map(simplifyOcto)
      .filter((l) => l.closed && ringArea(l.pts) > 900)
      .sort((a, b) => ringArea(b.pts) - ringArea(a.pts));
    const lines = headedBands(f, F);
    const bandRings = (k: number) => coast.flatMap((c) => {
      let r = c.pts;
      if (k > 0) r = clipBy(r, lines[k - 1]!.pts, 1);
      if (k < lines.length && r.length) r = clipBy(r, lines[k]!.pts, -1);
      return r.length > 2 && ringArea(r) > 200 ? [r] : [];
    });
    const zones = Array.from({ length: lines.length + 1 }, (_, k) => ({ g: k === 0 ? f.groups.length - 1 : k - 1, common: k === 0, rings: bandRings(k).map((r) => back({ pts: r, closed: true })) }));
    // The dividing lines only inside the outline (the sketch clipped them too).
    const inside = (p: XY) => coast.some((c) => pointIn(c.pts, p));
    const borders = lines.flatMap((l) => clipLines([{ pts: densify(l.pts, 6), closed: false }], inside)).map((l) => back(simplifyOcto(l)));
    shape = { coast: coast.map(back), insets: [], zones, borders, cuts };
  }
  putShape(key, shape);
  return shape;
}

/** A divide is found twice (once from each side): keep one of each. */
function dedupe(lines: XY[][]): XY[][] {
  const seen: XY[][] = [];
  const close = (a: XY[], b: XY[]) => {
    const near = (p: XY) => b.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 2);
    return a.filter(near).length > a.length * 0.8;
  };
  for (const l of lines) if (!seen.some((s) => close(l, s))) seen.push(l);
  return seen;
}

/** Points every `step` along a polyline (so clipping it keeps its ends close to the outline). */
function densify(pts: readonly XY[], step: number): XY[] {
  const out: XY[] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

function pointIn(ring: readonly XY[], p: XY): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

/** The height of an x-monotone polyline at x (it spans the whole grid, west to east). */
function lineY(l: readonly XY[], x: number): number {
  if (x <= l[0]![0]) return l[0]![1];
  for (let i = 1; i < l.length; i++) {
    const a = l[i - 1]!;
    const b = l[i]!;
    if (x <= b[0]) return b[0] === a[0] ? b[1] : a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
  }
  return l[l.length - 1]![1];
}

/**
 * A ring cut by an x-monotone line: what lies below it (`side` 1, y greater) or above it (−1). Sutherland–Hodgman
 * against one boundary, the ring's edges first split where the line bends, and the line's own bends put back between
 * where the ring leaves the side and where it comes back, so the cut follows the bevel.
 */
function clipBy(ring: readonly XY[], line: readonly XY[], side: 1 | -1): XY[] {
  const xs = line.map((p) => p[0]);
  const pts: XY[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    pts.push(a);
    const lo = Math.min(a[0], b[0]);
    const hi = Math.max(a[0], b[0]);
    const mid = xs.filter((x) => x > lo && x < hi).sort((u, v) => (a[0] < b[0] ? u - v : v - u));
    for (const x of mid) {
      const t = (x - a[0]) / (b[0] - a[0]);
      pts.push([x, a[1] + (b[1] - a[1]) * t]);
    }
  }
  const g = (p: XY) => side * (p[1] - lineY(line, p[0]));
  const start = pts.findIndex((p) => g(p) >= 0);
  if (start < 0) return [];
  if (pts.every((p) => g(p) >= 0)) return pts;
  const out: XY[] = [];
  let exit: XY | null = null;
  const n = pts.length;
  for (let s = 0; s < n; s++) {
    const a = pts[(start + s) % n]!;
    const b = pts[(start + s + 1) % n]!;
    const ga = g(a);
    const gb = g(b);
    if (ga >= 0) out.push(a);
    if (ga >= 0 !== gb >= 0) {
      const t = ga / (ga - gb);
      const q: XY = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (ga >= 0) {
        out.push(q);
        exit = q;
      } else {
        if (exit) {
          const x0 = exit[0];
          const x1 = q[0];
          const bends = line.filter((p) => p[0] > Math.min(x0, x1) && p[0] < Math.max(x0, x1)).sort((u, v) => (x0 < x1 ? u[0] - v[0] : v[0] - u[0]));
          out.push(...bends.map((p) => [p[0], p[1]] as XY));
        }
        out.push(q);
        exit = null;
      }
    }
  }
  return out;
}

/**
 * `metro`'s divides (gen.mjs headedBands): 主控 | project 1 | project 2 …, each level between the status boards on the
 * west, level between the lanes on the east, joined by a 45° bevel between the boards and the lanes.
 */
function headedBands(f: SFrame, G: Grid): Line[] {
  const xL = G.x0;
  const xR = G.x0 + G.nx * G.c;
  const cut = (l: number, r: number, xj: number): Line => {
    const h = Math.abs(r - l) / 2;
    return {
      pts: [
        [xL, l],
        [xj - h, l],
        [xj + h, r],
        [xR, r],
      ],
      closed: false,
    };
  };
  const cs = f.cards;
  const bs = f.bands;
  const cuts: Line[] = [];
  if (bs.length) cuts.push(cut((f.spineTop + 14 + cs[0]!.y) / 2, (f.headBottom + bs[0]!.top - 12) / 2, f.hubX[0]!));
  for (let i = 0; i + 1 < bs.length; i++) cuts.push(cut((cs[i]!.y + cs[i]!.h + cs[i + 1]!.y) / 2, (bs[i]!.bottom + bs[i + 1]!.top - 12) / 2, (f.hubX[i]! + f.hubX[i + 1]!) / 2));
  return cuts;
}

// ---------------- where the topics go (gen.mjs placeTopics) ----------------

/**
 * The topics on the map, scattered rather than in a grid: random starts pushed apart and drawn together, a hundred and
 * twenty tries kept by how tight they fit a 16:10 view and how little their edges and middles line up; among the best
 * few different arrangements one is picked by `seed`. Boxes in layout units (y down); returns where each box's own
 * origin goes, the whole centred on 0.
 */
export function placeTopics(boxes: readonly { x0: number; y0: number; x1: number; y1: number }[], seed: number, margin = 175 * K): XY[] {
  if (!boxes.length) return [];
  if (boxes.length === 1) return [[-(boxes[0]!.x0 + boxes[0]!.x1) / 2, -(boxes[0]!.y0 + boxes[0]!.y1) / 2]];
  const B = boxes.map((b) => ({ ...b, w: b.x1 - b.x0, h: b.y1 - b.y0 }));
  const once = (s: number) => {
    const r = rng(s);
    const pos = B.map(() => [(r() - 0.5) * 900 * K, (r() - 0.5) * 600 * K] as XY);
    for (let it = 0; it < 800; it++) {
      for (let i = 0; i < pos.length; i++)
        for (let j = i + 1; j < pos.length; j++) {
          const pi = pos[i]!;
          const pj = pos[j]!;
          const dx = pj[0] - pi[0];
          const dy = pj[1] - pi[1];
          const ox = (B[i]!.w + B[j]!.w) / 2 + margin - Math.abs(dx);
          const oy = (B[i]!.h + B[j]!.h) / 2 + margin - Math.abs(dy);
          if (ox > 0 && oy > 0) {
            if (ox < oy * 1.25) {
              const sh = (Math.sign(dx || 1) * ox) / 2;
              pi[0] -= sh;
              pj[0] += sh;
            } else {
              const sh = (Math.sign(dy || 1) * oy) / 2;
              pi[1] -= sh;
              pj[1] += sh;
            }
          }
        }
      for (const p of pos) {
        p[0] *= 0.992;
        p[1] *= 0.985;
      }
    }
    const rects = pos.map((p, i) => ({ x0: p[0] - B[i]!.w / 2, y0: p[1] - B[i]!.h / 2, x1: p[0] + B[i]!.w / 2, y1: p[1] + B[i]!.h / 2 }));
    const X0 = Math.min(...rects.map((q) => q.x0));
    const X1 = Math.max(...rects.map((q) => q.x1));
    const Y0 = Math.min(...rects.map((q) => q.y0));
    const Y1 = Math.max(...rects.map((q) => q.y1));
    let align = 0;
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        for (const [u, v] of [
          [a.x0, b.x0],
          [a.x1, b.x1],
          [a.y0, b.y0],
          [a.y1, b.y1],
          [(a.x0 + a.x1) / 2, (b.x0 + b.x1) / 2],
          [(a.y0 + a.y1) / 2, (b.y0 + b.y1) / 2],
        ] as const)
          align += Math.exp(-(((u - v) / (60 * K)) ** 2));
      }
    const W = X1 - X0;
    const H = Y1 - Y0;
    const ar = 1.6;
    const score = Math.max(W, H * ar) * Math.max(H, W / ar) * (1 + 0.5 * align);
    const cell = (q: (typeof rects)[number]) => `${Math.min(2, Math.floor((((q.x0 + q.x1) / 2 - X0) / W) * 3))}${Math.min(2, Math.floor((((q.y0 + q.y1) / 2 - Y0) / H) * 3))}`;
    const sig = rects.map(cell).join(",");
    const cx = (X0 + X1) / 2;
    const cy = (Y0 + Y1) / 2;
    return { score, sig, offs: rects.map((q, i) => [q.x0 - B[i]!.x0 - cx, q.y0 - B[i]!.y0 - cy] as XY) };
  };
  const all = Array.from({ length: 120 }, (_, t) => once(1000 + t)).sort((a, b) => a.score - b.score);
  const grid = (p: { sig: string }) => {
    const c = p.sig.split(",");
    return new Set(c.map((q) => q[0])).size <= 2 && new Set(c.map((q) => q[1])).size <= 2;
  };
  const seen = new Set<string>();
  const good = all.filter((p) => p.score < all[0]!.score * 1.4 && !seen.has(p.sig) && !!seen.add(p.sig));
  const top = (good.some((p) => !grid(p)) ? good.filter((p) => !grid(p)) : good).slice(0, 6);
  const pick = rng(seed * 7919 + 11);
  pick();
  return top[Math.floor(pick() * top.length)]!.offs;
}
