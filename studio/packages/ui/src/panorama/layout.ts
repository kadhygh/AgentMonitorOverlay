import type { PanoramaData, PanoramaItem, PanoramaLane } from "./datalayer.js";

// Where everything sits on the 全景 map, from the datalayer alone (no deck.gl here, so it is plain to test). Layout as
// in the prototype (studio/plans/userlayer/v-deck3.html: areas in rows, oldest far away, a gently waving lane).
//
// P1 (2026-11-02, plans/userlayer/panorama.md「节点的表达」): each task is a tree growing east from its start (a
// beacon) towards its goal. The trunk is its rounds, evenly spaced. What one session opened (branch sessions, sessions
// it started with session_start) leaves it as one branch on a track of its own above or below, its sessions along it in
// the order they started — a 值守 session that opened ten others is one branch with ten nodes, not a broom of ten
// crossing curves (tried first on the real AMO迭代 data). The goal stands a stretch ahead of the newest node
// (further while checklist steps are open) and the road reaches it once the task is 完成. Positions depend only on the
// order of lanes and items and on the goal's distance, so a session changing status moves nothing.
//
// Tried in the preview (2026-11-02, the user; switches in the theme's look, Studio keeps P1's): `fold` folds runs of
// rounds that went smoothly into one 「×N 轮」 stretch (foldRuns), `span` keeps a task's footprint about the same however
// many rounds it has (the newest wide apart, the older crowding towards the start), `front` marks the node furthest on
// and the road ahead, `curve` bends the roads — `flow` all along one topic-wide field (neighbours stay parallel and
// never cross), `spiral` as arms curling out of the middle. Each task is laid out in its own straight frame first (x
// along its road, y across) and then mapped onto the map, so its base and branches bend with its road.

/** One layout unit = 0.001° (about 111 m near 0,0): the map is drawn in a Web Mercator view around the origin. */
export const U = 0.001;
/** Spacing of neighbouring rounds, and how far the lane swings, in layout units. */
const S = 18;
const WAVE = 5;
/** Where the start beacon stands, before the first round. */
const OX = -16;
/** Height of the nodes above the ground, and of the start beacon's top (metres). */
export const H_NODE = 260;
export const H_BEACON = 760;
/** Half widths of the road as a band (`track`), on the trunk and on a branch, in layout units. */
const W_TRUNK = 2.4;
const W_BRANCH = 1.3;

/** A round's light column (`pillars`): as tall as the work in it, a branch's lower (metres). */
export function pillarHeight(it: PanoramaItem): number {
  return (220 + it.work.weight * 1900) * (it.round === null ? 0.6 : 1);
}

export type LngLatZ = [number, number, number];

export interface RegionLayout {
  id: string;
  lane: PanoramaLane;
  items: PanoramaItem[];
  /** Areas are numbered in drawing order (oldest task first). */
  idx: number;
  /** Whether the task is still on its way (not 完成). */
  active: boolean;
  /** [west, south, east, north] in degrees. */
  bounds: [number, number, number, number];
  /** The area's outline, closed, and a slightly smaller one inside it. */
  outline: LngLatZ[];
  inner: LngLatZ[];
  /** Four corner marks outside the outline. */
  ticks: LngLatZ[][];
  /**
   * The task's name: just outside the area's far (north) edge, at its left (inside it would cover the first node); under
   * its near edge with a base (`nameBelow`: the name hangs down from there, else stands on it). As an arm (`spiral`)
   * beyond its outer end, on the side the arm points to (`nameAlign`).
   */
  name: LngLatZ;
  nameBelow: boolean;
  nameAlign: "start" | "middle" | "end";
  /** The start beacon: its foot and its top. */
  origin: { ground: LngLatZ; top: LngLatZ };
  /** The goal: its foot, the gate at node height, and how far it is from the newest node (layout units). */
  goal: { ground: LngLatZ; at: LngLatZ; gap: number };
  /** The trunk from the start to its last round (on to the goal once 完成). */
  walked: LngLatZ[];
  /** Dashes from the last round to the goal while it is not reached. */
  ahead: LngLatZ[][];
  /** Each branch: what one node opened — the curve from that node on along its track, the sessions on it in order. */
  branches: { from: string | null; itemIds: string[]; path: LngLatZ[]; ended: boolean }[];
  /** Paths leading into the sessions that are running: the moving lights flow along them. */
  flows: LngLatZ[][];
  /** Each item: on the ground, up at node height, and on top of its light column (`pillars`). */
  nodes: Record<string, { ground: LngLatZ; at: LngLatZ; top: LngLatZ }>;
  /** `plinth`: a capsule hugging the tree (the area is tight around it then). */
  plinth: LngLatZ[];
  /**
   * `track`: the road as a band — its edges as far as it came and on to the goal, the lit fill of the part walked, a
   * tick across it per round; each branch a narrower band.
   */
  band: { walked: LngLatZ[][]; ahead: LngLatZ[][]; fill: LngLatZ[]; ticks: LngLatZ[][]; branches: { edges: LngLatZ[][]; fill: LngLatZ[]; ended: boolean }[] };
  /** `drafting`: a dimension line from start to goal under the base (its text sits at `dimAt`), ticks along the base's far edge, a coordinate at its corner. */
  drafting: { dim: LngLatZ[][]; dimAt: LngLatZ; edge: LngLatZ[][]; coord: [number, number] };
  /** `front`: the node furthest on (its column taller, see `nodes`), null without it; chevrons on the road on to the goal. */
  front: string | null;
  chevrons: LngLatZ[][];
  /**
   * `fold`: each folded run of rounds — its key (the page keeps which are open), its rounds, whether spread out, where its
   * 「×N 轮」 goes, an axis-break mark across the road while folded.
   */
  folds: { key: string; ids: string[]; open: boolean; at: LngLatZ; brk: LngLatZ[][] }[];
}

export interface PanoramaLayout {
  regions: RegionLayout[];
  byItem: Record<string, RegionLayout>;
  /** Everything, [west, south, east, north] in degrees. */
  bounds: [number, number, number, number];
  /** The grid on the ground (faded towards the edges): segments with an alpha 0–1, every fifth line marked. */
  grid: { from: LngLatZ; to: LngLatZ; a: number; major: boolean }[];
  /** Dependencies: from the goal of the task waited for to the start of the one waiting. */
  arcs: { from: string; to: string; s: LngLatZ; t: LngLatZ }[];
  /** Radar rings on the ground around the middle and a chamfered frame around everything (oblivion's decoration). */
  deco: { rings: LngLatZ[][]; dashes: LngLatZ[][]; ticks: { path: LngLatZ[]; a: number }[]; frame: LngLatZ[]; frameTicks: LngLatZ[][] };
  /** `flow` / `spiral`: faint lines of the shared field on the ground. */
  streams: LngLatZ[][];
}

/** FNV-1a to 0–1: a stable "random" per id, so the same task always gets the same swing and offset. */
export function hash01(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) / 4294967296;
}

/** How far ahead of the newest node the goal stands: just there once 完成; with a checklist, a stretch per open step. */
export function goalGap(lane: PanoramaLane): number {
  if (lane.goal.state === "reached") return 10;
  const c = lane.goal.checklist;
  if (c) return 12 + Math.min(15, c.total - c.done) * S * 0.6;
  return 24;
}

type XY = [number, number];

/** How the roads run (`curve`): each its own gentle swing (P1), all along one topic-wide field, or as arms out of the middle. */
export type Curve = "wave" | "flow" | "spiral";

/** What the theme's look asks of the layout (2026-11-02, all off is P1's layout). */
export interface LayoutOptions {
  /** `plinth`: areas hug their trees; otherwise the big frames P1 started with. */
  tight?: boolean;
  curve?: Curve;
  /** `span`: a task's footprint stays about the same however many rounds it has (see SPAN). */
  span?: boolean;
  /** `fold`: runs of rounds that went smoothly fold into one stretch (foldRuns); `open` those shown spread out ("all" when zoomed in). */
  fold?: boolean;
  open?: ReadonlySet<string> | "all";
  /** `front`: the least height of the front node's column (m); its top is at least a quarter above its own. Left out: no front. */
  front?: number | null;
}

type Opts = Required<LayoutOptions>;

/**
 * `span`: the trunk keeps its natural spacing while it is up to `free` long; beyond, its length grows ever slower towards
 * `max`, the newest rounds stay about `near` × S apart and the older ones crowd towards the start (近疏远密). The goal
 * stands at most `gap` ahead.
 */
const SPAN = { free: 10 * S, max: 15 * S, near: 1.1, gap: 54 };
/** `fold`: a run of n rounds takes `1 + k·log2(n)` rounds' room, open or not; folded, its nodes stand `step` apart and their columns are `h` as tall (a closed bellows). */
const FOLD = { k: 0.5, step: 0.07, min: 3, h: 0.55 };
/** With a base, how far under its near edge the name hangs (its corner marks reach 4 out). */
const NAME_GAP = 7.5;
/** `front`: chevrons on the road ahead (half width, depth, spacing). */
const CHEV = { w: 3.4, d: 2.4, step: 6.5 };
/** `flow`: the topic-wide field — two swells along x (amplitude, wavelength), drifting slowly across y so rows far apart bend a little differently; rows staggered along it. */
const FLOW = { a: 20, len: 280, a2: 6, len2: 120, drift: 0.002, stagger: 80 };
/** `spiral`: arms leave a circle round the middle (at least `minR`, room for every arm's width plus `gap`), turning by a radian every `c` units outwards. */
const SPIRAL = { c: 170, gap: 18, minR: 50 };

/**
 * Which of a task's rounds fold into one 「×N 轮」 stretch (look `fold`, the user 11-02): a run of three or more in a row
 * that went smoothly. Kept apart: the first round, the latest two, one that opened a branch, one waiting on the person
 * or running. Points (要点) to come are one more condition here.
 */
export function foldRuns(trunk: readonly PanoramaItem[], items: readonly PanoramaItem[]): PanoramaItem[][] {
  const opened = new Set(items.map((i) => i.forkFrom));
  const keep = (it: PanoramaItem, i: number) => i === 0 || i >= trunk.length - 2 || opened.has(it.id) || it.status === "needs_you" || it.status === "working";
  const runs: PanoramaItem[][] = [];
  let run: PanoramaItem[] = [];
  trunk.forEach((it, i) => {
    if (!keep(it, i)) return void run.push(it);
    if (run.length >= FOLD.min) runs.push(run);
    run = [];
  });
  return runs;
}

/**
 * From a place along the trunk in rounds (0 the first, X the last) to the distance along the road: S apart while it
 * fits (always without `span`); beyond, the length saturates and g(t) = (e^κt − 1)/(e^κ − 1) crowds the older part
 * towards the start, κ such that the newest rounds stay about `near` × S apart.
 */
function spacing(X: number, span: boolean): (x: number) => number {
  const L0 = X * S;
  if (!span || L0 <= SPAN.free) return (x) => x * S;
  const room = SPAN.max - SPAN.free;
  const L = SPAN.free + room * (1 - Math.exp(-(L0 - SPAN.free) / room));
  // g's slope at the end, against the mean spacing, is κ / (1 − e^−κ).
  const want = Math.min(8, (SPAN.near * S * X) / L);
  let lo = 1e-6;
  let hi = 12;
  for (let k = 0; k < 40; k++) {
    const m = (lo + hi) / 2;
    if (m / (1 - Math.exp(-m)) < want) lo = m;
    else hi = m;
  }
  return (x) => (L * Math.expm1((lo * x) / X)) / Math.expm1(lo);
}

interface Region {
  lane: PanoramaLane;
  items: PanoramaItem[];
  pos: Record<string, XY>;
  wave(x: number): number;
  trunkEnd: number;
  goalX: number;
  gap: number;
  branches: { from: string | null; itemIds: string[]; pts: XY[]; ended: boolean }[];
  flows: XY[][];
  front: string | null;
  folds: { key: string; ids: string[]; open: boolean; c: number }[];
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  w: number;
  /** Room it takes in its row: its width, or (with a base) its name's when that is wider. */
  fw: number;
  h: number;
  ox: number;
  oy: number;
  /** From the task's own frame (x along its road, y across) to the map's layout units; set once the areas are placed. */
  W(x: number, y: number): XY;
}

/** A cubic curve from a to b leaving and arriving level, as the prototype's branches. */
function bez(a: XY, b: XY, n = 14): XY[] {
  const dx = (b[0] - a[0]) * 0.55;
  const out: XY[] = [];
  for (let s = 0; s <= n; s++) {
    const t = s / n;
    const m = 1 - t;
    out.push([m * m * m * a[0] + 3 * m * m * t * (a[0] + dx) + 3 * m * t * t * (b[0] - dx) + t * t * t * b[0], m * m * m * a[1] + 3 * m * m * t * a[1] + 3 * m * t * t * b[1] + t * t * t * b[1]]);
  }
  return out;
}

function region(lane: PanoramaLane, all: readonly PanoramaItem[], o: Opts): Region {
  const items = all.filter((i) => i.lane === lane.id).sort((a, b) => a.at.localeCompare(b.at) || a.num - b.num);
  const phase = hash01(lane.id) * 6.283;
  // Along a shared field (`flow`) or as an arm (`spiral`) the road's own frame is straight: the bends come from the map.
  const amp = o.curve === "wave" ? WAVE : 0;
  const wave = (x: number) => amp * Math.sin(x / 38 + phase);
  const along = (a: number, b: number): XY[] => {
    const out: XY[] = [];
    for (let x = a; x < b; x += 2) out.push([x, wave(x)]);
    out.push([b, wave(b)]);
    return out;
  };
  const pos: Record<string, XY> = {};
  const trunk = items.filter((i) => i.round !== null);
  // Rounds in round units, 1 apart; a folded run (`fold`) takes the same room open or not, so opening it moves nothing
  // else: open, its rounds spread evenly over it; folded, bunched at its middle like a closed accordion.
  const runs = o.fold ? foldRuns(trunk, items) : [];
  const runAt = new Map(runs.map((r, k) => [r[0]!.id, k]));
  const uOpen: number[] = [];
  const uShut: number[] = [];
  const uDrawn: number[] = [];
  const segs: Region["folds"] = [];
  let b = 0;
  for (let i = 0; i < trunk.length; ) {
    const k = runAt.get(trunk[i]!.id);
    if (k === undefined) {
      uOpen.push(b);
      uShut.push(b);
      uDrawn.push(b);
      b += 1;
      i++;
      continue;
    }
    const run = runs[k]!;
    const n = run.length;
    const w = 1 + FOLD.k * Math.log2(n);
    const c = b - 0.5 + w / 2;
    const key = `${lane.id}:${run[0]!.id}`;
    const open = o.open === "all" || o.open.has(key);
    for (let j = 0; j < n; j++) {
      const u = b - 0.5 + ((j + 0.5) * w) / n;
      const shut = c + (j - (n - 1) / 2) * Math.min(FOLD.step, (w * 0.5) / n);
      uOpen.push(u);
      uShut.push(shut);
      uDrawn.push(open ? u : shut);
    }
    segs.push({ key, ids: run.map((r) => r.id), open, c });
    b += w;
    i += n;
  }
  const X = Math.max(0, b - 1);
  const sOf = spacing(X, o.span);
  // How much the trunk was squeezed: branch sessions keep apart by as much less.
  const shrink = X > 0 ? sOf(X) / (X * S) : 1;
  trunk.forEach((it, i) => {
    const x = sOf(uDrawn[i]!);
    pos[it.id] = [x, wave(x)];
  });
  const trunkEnd = trunk.length ? sOf(X) : OX;
  // Time to x along the trunk: between two rounds in proportion (as they stand open), before the first at the start,
  // after the last a bit on.
  const openX = uOpen.map(sOf);
  const times = trunk.map((t) => Date.parse(t.at));
  const timeX = (iso: string) => {
    const t = Date.parse(iso);
    if (!times.length || t <= times[0]!) return times.length ? 0 : OX + 6;
    for (let i = 1; i < times.length; i++) if (t <= times[i]!) return openX[i - 1]! + ((openX[i]! - openX[i - 1]!) * (t - times[i - 1]!)) / Math.max(1, times[i]! - times[i - 1]!);
    return trunkEnd + S * 0.5 * shrink;
  };
  // Branches on tracks, alternately above and below, each track free over the x it spans: one per node that opened
  // some, in the order their first session started (so a branch's opener, itself on a branch, is placed before it).
  const groups = new Map<string, PanoramaItem[]>();
  for (const it of items) if (it.round === null) groups.set(it.forkFrom ?? "", [...(groups.get(it.forkFrom ?? "") ?? []), it]);
  const used: { k: number; a: number; b: number }[] = [];
  const branches: Region["branches"] = [];
  const flows: XY[][] = [];
  for (const [from, list] of [...groups].sort((a, b) => a[1][0]!.at.localeCompare(b[1][0]!.at))) {
    const fp = (from && pos[from]) || ([OX, wave(OX)] as XY);
    const xs: number[] = [];
    let x = fp[0];
    for (const it of list) xs.push((x = Math.max(x + S * 0.6 * shrink, timeX(it.at))));
    const last = xs[xs.length - 1]!;
    let k = 1;
    while (used.some((u) => u.k === k && !(last + 4 < u.a || fp[0] - 2 > u.b))) k++;
    used.push({ k, a: fp[0] - 2, b: last + 4 });
    const off = (k % 2 ? 1 : -1) * (11 + 9 * Math.floor((k - 1) / 2));
    const track = (a: number, b: number): XY[] => along(a, b).map(([x, y]) => [x, y + off]);
    list.forEach((it, j) => (pos[it.id] = [xs[j]!, wave(xs[j]!) + off]));
    const lead = bez(fp, pos[list[0]!.id]!);
    branches.push({ from: from || null, itemIds: list.map((i) => i.id), pts: [...lead, ...track(xs[0]!, last).slice(1)], ended: list.every((i) => i.ended) });
    // Lights flow into a running session on it from the one before (or from the node that opened the branch).
    list.forEach((it, j) => it.status === "working" && flows.push(j ? track(xs[j - 1]!, xs[j]!) : lead));
  }
  // The front: the node furthest on (the later of two level with each other).
  let front: string | null = null;
  for (const it of items) if (front === null || pos[it.id]![0] >= pos[front]![0] - 1e-6) front = it.id;
  const frontX = Math.max(OX, ...Object.values(pos).map((p) => p[0]));
  const gap = o.span ? Math.min(goalGap(lane), SPAN.gap) : goalGap(lane);
  const goalX = frontX + gap;
  // And into a running round along the trunk from the round before (or from the start).
  trunk.forEach((it, i) => it.status === "working" && flows.push(along(i > 0 ? pos[trunk[i - 1]!.id]![0] : OX, pos[it.id]![0])));
  // (Where the trunk's rounds would be open and folded both count, so opening a run never changes the area.)
  const ys = [0, ...Object.values(pos).map((p) => p[1]), ...[...uOpen, ...uShut].map((u) => wave(sOf(u)))];
  // A base hugging the tree (`plinth`) leaves little room around it; the big frame keeps its margins and minimum size.
  const tight = o.tight;
  const y0 = tight ? Math.min(-11, Math.min(...ys) - 9) : Math.min(-26, Math.min(...ys) - 20);
  const y1 = tight ? Math.max(11, Math.max(...ys) + 9) : Math.max(26, Math.max(...ys) + 20);
  const x0 = OX - (tight ? 8 : 12);
  const x1 = tight ? goalX + 8 : Math.max(goalX + 12, x0 + 80);
  return {
    lane,
    items,
    pos,
    wave,
    trunkEnd,
    goalX,
    gap,
    branches,
    flows,
    front: o.front !== null ? front : null,
    folds: segs.map((f) => ({ ...f, c: sOf(f.c) })),
    x0,
    x1,
    y0,
    y1,
    w: x1 - x0,
    fw: tight ? Math.max(x1 - x0, nameRoom(lane)) : x1 - x0,
    h: y1 - y0,
    ox: 0,
    oy: 0,
    W: (x, y) => [x, y],
  };
}

/** `flow`: the field every road follows (layout units in, layout units out): it only moves points across, never along, so it never folds. */
function warp(x: number, y: number): XY {
  const d = y * FLOW.drift;
  return [x, y + FLOW.a * Math.sin((2 * Math.PI * x) / FLOW.len + d) + FLOW.a2 * Math.sin((2 * Math.PI * x) / FLOW.len2 + 1.7 + d * 0.6)];
}

/** Rows: the oldest far away (north), the newest in front; then everything centred on the origin. */
function pack(regs: Region[], o: Opts): void {
  const MAX_W = 640;
  const GAP = o.tight ? 30 : 34;
  // Bases leave the rows lower; a little more between them, so the light columns of the row in front stay clear of
  // the names under the bases behind.
  const ROW_GAP = o.tight ? 70 : 46;
  const rows: Region[][] = [];
  let row: Region[] = [];
  let w = 0;
  for (const r of regs) {
    if (row.length && w + GAP + r.fw > MAX_W) {
      rows.push(row);
      row = [];
      w = 0;
    }
    w += (row.length ? GAP : 0) + r.fw;
    row.push(r);
  }
  if (row.length) rows.push(row);
  let yc = 0;
  let prevH = 0;
  rows.forEach((rw, ri) => {
    const rh = Math.max(...rw.map((r) => r.h));
    yc -= ri ? prevH / 2 + ROW_GAP + rh / 2 : 0;
    prevH = rh;
    const tw = rw.reduce((s, r) => s + r.fw, 0) + GAP * (rw.length - 1);
    let x = -tw / 2 + (hash01(String(ri)) - 0.5) * (o.curve === "flow" ? FLOW.stagger : 30);
    for (const r of rw) {
      r.ox = x - r.x0;
      r.oy = yc - (r.y0 + r.y1) / 2 + (hash01(r.lane.id + "y") - 0.5) * 10;
      x += r.fw + GAP;
    }
  });
  const bx0 = regs.length ? Math.min(...regs.map((r) => r.ox + r.x0)) : -50;
  const bx1 = regs.length ? Math.max(...regs.map((r) => r.ox + r.x1)) : 50;
  const by0 = regs.length ? Math.min(...regs.map((r) => r.oy + r.y0)) : -30;
  const by1 = regs.length ? Math.max(...regs.map((r) => r.oy + r.y1)) : 30;
  const dx = -(bx0 + bx1) / 2;
  const dy = -(by0 + by1) / 2;
  for (const r of regs) {
    const ox = (r.ox += dx);
    const oy = (r.oy += dy);
    r.W = o.curve === "flow" ? (x, y) => warp(ox + x, oy + y) : (x, y) => [ox + x, oy + y];
  }
}

/** One arm's centreline from radius r0 outwards, a point per unit of its length, and its point and left normal at s. */
function armCurve(r0: number, len: number): (s: number) => { p: XY; n: XY } {
  const pts: XY[] = [];
  let r = r0;
  let s = 0;
  while (pts.length <= len + 2) {
    if (s >= pts.length) {
      const th = (r - r0) / SPIRAL.c;
      pts.push([r * Math.cos(th), r * Math.sin(th)]);
    }
    const dr = 0.05;
    s += Math.hypot(1, r / SPIRAL.c) * dr;
    r += dr;
  }
  const last = pts.length - 1;
  return (t) => {
    const i = Math.max(0, Math.min(last - 1, Math.floor(t)));
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const f = t - i;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const tx = (b[0] - a[0]) / l;
    const ty = (b[1] - a[1]) / l;
    return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], n: [-ty, tx] };
  };
}

/** `spiral`: each task an arm out of a circle round the middle, all turning the same way, each given an angle as wide as it is. */
function arms(regs: Region[]): ((s: number) => { p: XY; n: XY }) | null {
  if (!regs.length) return null;
  const hs = regs.map((r) => r.h + SPIRAL.gap);
  const tot = hs.reduce((a, b) => a + b, 0);
  const r0 = Math.max(SPIRAL.minR, tot / (2 * Math.PI));
  const arm = armCurve(r0, Math.max(...regs.map((r) => r.x1 - r.x0)) * 2.5 + 200);
  let acc = 0;
  regs.forEach((r, k) => {
    const th = (2 * Math.PI * (acc + hs[k]! / 2)) / tot;
    acc += hs[k]!;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const x0 = r.x0;
    r.W = (x, y) => {
      const { p, n } = arm(x - x0);
      const px = p[0] + n[0] * y;
      const py = p[1] + n[1] * y;
      return [px * c - py * s, px * s + py * c];
    };
  });
  return arm;
}

/** Points every `step` along a polyline with long straight stretches, so a bent map bends them too. */
function dense(pts: XY[], step = 3): XY[] {
  const out: XY[] = [];
  pts.forEach((p, i) => {
    const a = pts[i - 1];
    if (a) {
      const n = Math.floor(Math.hypot(p[0] - a[0], p[1] - a[1]) / step);
      for (let k = 1; k < n; k++) out.push([a[0] + ((p[0] - a[0]) * k) / n, a[1] + ((p[1] - a[1]) * k) / n]);
    }
    out.push(p);
  });
  return out;
}

/** The look's layout (LayoutOptions; all off is how P1 laid it out). */
export function layoutPanorama(data: PanoramaData, opts: LayoutOptions = {}): PanoramaLayout {
  const o: Opts = { tight: !!opts.tight, curve: opts.curve ?? "wave", span: !!opts.span, fold: !!opts.fold, open: opts.open ?? new Set(), front: opts.front ?? null };
  const tight = o.tight;
  const regs = data.lanes.map((l) => region(l, data.items, o));
  const arm = o.curve === "spiral" ? arms(regs) : null;
  if (!arm) pack(regs, o);
  const regions: RegionLayout[] = [];
  const byItem: Record<string, RegionLayout> = {};
  regs.forEach((r, idx) => {
    const P = (x: number, y: number, z = 0): LngLatZ => {
      const [X, Y] = r.W(x, y);
      return [X * U, Y * U, z];
    };
    const Q = (pts: XY[]) => pts.map(([x, y]) => P(x, y));
    // Shapes with long straight sides (outlines, dimension lines) get points along them first.
    const QD = (pts: XY[]) => Q(dense(pts));
    const road = (a: number, b: number): XY[] => {
      const out: XY[] = [];
      for (let x = a; x < b; x += 2) out.push([x, r.wave(x)]);
      out.push([b, r.wave(b)]);
      return out;
    };
    const reached = r.lane.goal.state === "reached";
    const roadEnd = reached ? r.goalX : r.trunkEnd;
    const ahead: LngLatZ[][] = [];
    if (!reached) for (let x = r.trunkEnd + 2; x < r.goalX - 1; x += 5.5) ahead.push(Q(road(x, Math.min(x + 3, r.goalX - 1))));
    const nodes: RegionLayout["nodes"] = {};
    const folded = new Set(r.folds.filter((f) => !f.open).flatMap((f) => f.ids));
    for (const it of r.items) {
      const [x, y] = r.pos[it.id]!;
      // The front's column stands out above its own height (and above the theme's least).
      const top = it.id === r.front ? Math.max(pillarHeight(it) * 1.25, o.front ?? 0) : pillarHeight(it) * (folded.has(it.id) ? FOLD.h : 1);
      nodes[it.id] = { ground: P(x, y), at: P(x, y, H_NODE), top: P(x, y, top) };
    }
    const walkedPts = road(OX, Math.max(roadEnd, OX + 0.5));
    const aheadPts = reached ? null : road(roadEnd, r.goalX);
    const trunkX = r.items.filter((i) => i.round !== null).map((i) => r.pos[i.id]![0]);
    const across = (x: number, d: number): XY[] => [
      [x, r.wave(x) - d],
      [x, r.wave(x) + d],
    ];
    const band: RegionLayout["band"] = {
      walked: [Q(offset(walkedPts, W_TRUNK)), Q(offset(walkedPts, -W_TRUNK))],
      ahead: aheadPts ? [Q(offset(aheadPts, W_TRUNK)), Q(offset(aheadPts, -W_TRUNK))] : [],
      fill: Q([...offset(walkedPts, W_TRUNK), ...offset(walkedPts, -W_TRUNK).reverse()]),
      // Across the band at each round, a little past its edges, like a ruler (the lane swings gently: straight across is close enough).
      ticks: trunkX.map((x) => Q(across(x, W_TRUNK + 1.4))),
      branches: r.branches.map((b) => ({ edges: [Q(offset(b.pts, W_BRANCH)), Q(offset(b.pts, -W_BRANCH))], fill: Q([...offset(b.pts, W_BRANCH), ...offset(b.pts, -W_BRANCH).reverse()]), ended: b.ended })),
    };
    // With a base (tight), the name goes under its near edge (tall light columns at the far edge would rise into it on
    // a tilted map) and the dimension line along the far edge; with the big frame the other way round.
    const dimY = tight ? r.y1 + 3.5 : r.y0 - 3.5;
    const edge: LngLatZ[][] = [];
    for (let x = r.x0 + 6, k = 0; x < r.x1 - 4; x += 4, k++) edge.push(Q([[x, r.y1], [x, r.y1 - (k % 5 ? 1 : 2.2)]]));
    const [cx, cy] = r.W(OX, 0);
    const drafting: RegionLayout["drafting"] = {
      dim: [QD([[OX, dimY], [r.goalX, dimY]]), Q([[OX, dimY - 1.6], [OX, dimY + 1.6]]), Q([[r.goalX, dimY - 1.6], [r.goalX, dimY + 1.6]]), ...trunkX.map((x) => Q([[x, dimY], [x, dimY + 0.9]]))],
      dimAt: P((OX + r.goalX) / 2, dimY),
      edge,
      coord: [Math.round(cx), Math.round(cy)],
    };
    // `front`: chevrons on the road from the front on to the goal.
    const chevrons: LngLatZ[][] = [];
    if (r.front && !reached) for (let x = Math.max(r.trunkEnd, r.goalX - r.gap) + 5; x < r.goalX - 3; x += CHEV.step) chevrons.push(Q([[x - CHEV.d, r.wave(x) + CHEV.w], [x, r.wave(x)], [x - CHEV.d, r.wave(x) - CHEV.w]]));
    const rect = QD(roundRect(r.x0, r.y0, r.x1, r.y1, 0, 0));
    const nameAt = (): Pick<RegionLayout, "name" | "nameBelow" | "nameAlign"> => {
      if (o.curve === "spiral") {
        // Arms start crowded round the middle and end apart: the name goes past the outer end, away from the arm.
        const [ax, ay] = r.W(r.x1 - 2, 0);
        const [bx, by] = r.W(r.x1 + 3, 0);
        const flat = Math.abs(bx - ax) >= Math.abs(by - ay);
        return { name: P(r.x1 + 3, 0), nameBelow: flat || by < ay, nameAlign: !flat ? "middle" : bx > ax ? "start" : "end" };
      }
      if (!tight) return { name: P(r.x0 + 10, r.y1 + 5), nameBelow: false, nameAlign: "start" };
      // Under the base's near edge, clear of its corner marks (4 out), below wherever that edge runs under the name (a
      // bent road takes the edge with it).
      const a = P(r.x0 + 4, r.y0 - NAME_GAP);
      const low = Math.min(...dense([[r.x0, r.y0 - NAME_GAP], [r.x0 + nameRoom(r.lane), r.y0 - NAME_GAP]]).map(([x, y]) => r.W(x, y)[1] * U));
      return { name: [a[0], Math.min(a[1], low), 0], nameBelow: true, nameAlign: "start" };
    };
    const out: RegionLayout = {
      id: r.lane.id,
      lane: r.lane,
      items: r.items,
      idx,
      active: !reached,
      bounds: [Math.min(...rect.map((p) => p[0])), Math.min(...rect.map((p) => p[1])), Math.max(...rect.map((p) => p[0])), Math.max(...rect.map((p) => p[1]))],
      outline: QD(roundRect(r.x0, r.y0, r.x1, r.y1, 0, 7)),
      plinth: QD(roundRect(r.x0, r.y0, r.x1, r.y1, 0, Math.min(r.h / 2, 12))),
      band,
      drafting,
      inner: QD(roundRect(r.x0, r.y0, r.x1, r.y1, -3.2, 5)),
      ticks: cornerTicks(r.x0, r.y0, r.x1, r.y1).map((t) => Q(t)),
      ...nameAt(),
      origin: { ground: P(OX, r.wave(OX)), top: P(OX, r.wave(OX), H_BEACON) },
      goal: { ground: P(r.goalX, r.wave(r.goalX)), at: P(r.goalX, r.wave(r.goalX), H_NODE), gap: r.gap },
      walked: Q(walkedPts),
      ahead,
      branches: r.branches.map((b) => ({ from: b.from, itemIds: b.itemIds, path: Q(b.pts), ended: b.ended })),
      flows: r.flows.map(Q),
      nodes,
      front: r.front,
      chevrons,
      folds: r.folds.map((f) => ({
        key: f.key,
        ids: f.ids,
        open: f.open,
        at: P(f.c, r.wave(f.c) - W_TRUNK - 2.5),
        // An axis-break mark across the road (⫽) while folded.
        brk: f.open ? [] : [-1, 1].map((k) => Q([[f.c + k * 0.9 - 1.1, r.wave(f.c) - W_TRUNK - 1.8], [f.c + k * 0.9 + 1.1, r.wave(f.c) + W_TRUNK + 1.8]])),
      })),
    };
    regions.push(out);
    for (const it of r.items) byItem[it.id] = out;
  });
  const bx0 = regions.length ? Math.min(...regions.map((r) => r.bounds[0])) / U : -50;
  const by0 = regions.length ? Math.min(...regions.map((r) => r.bounds[1])) / U : -30;
  const bx1 = regions.length ? Math.max(...regions.map((r) => r.bounds[2])) / U : 50;
  const by1 = regions.length ? Math.max(...regions.map((r) => r.bounds[3])) / U : 30;
  const X0 = bx0 - 40;
  const X1 = bx1 + 40;
  const Y0 = by0 - 40;
  const Y1 = by1 + 40;
  const reg = new Map(regions.map((r) => [r.id, r]));
  const arcs = data.links.map((l) => ({ from: l.from, to: l.to, s: reg.get(l.from)!.goal.at, t: reg.get(l.to)!.origin.top })).filter((a) => a.s && a.t);
  return { regions, byItem, bounds: [X0 * U, Y0 * U, X1 * U, Y1 * U], grid: grid(X0, X1, Y0, Y1), arcs, deco: deco(X0, X1, Y0, Y1), streams: streams(o.curve, X0, X1, Y0, Y1, regs.length, arm) };
}

/** Faint lines of the shared field under everything: along `flow`, or arms between the tasks' arms (`spiral`). */
function streams(curve: Curve, X0: number, X1: number, Y0: number, Y1: number, n: number, arm: ((s: number) => { p: XY; n: XY }) | null): LngLatZ[][] {
  const out: LngLatZ[][] = [];
  if (curve === "flow")
    for (let y = Y0 + 20; y < Y1; y += 36) {
      const line: LngLatZ[] = [];
      for (let x = X0; x <= X1; x += 6) {
        const [px, py] = warp(x, y);
        line.push([px * U, py * U, 0]);
      }
      out.push(line);
    }
  if (curve === "spiral" && arm) {
    const R = Math.max(X1 - X0, Y1 - Y0) * 0.55;
    for (let k = 0; k < Math.max(6, n * 2); k++) {
      const th = (2 * Math.PI * (k + 0.5)) / Math.max(6, n * 2);
      const line: LngLatZ[] = [];
      for (let s = 0; s < R; s += 4) {
        const p = arm(s).p;
        line.push([(p[0] * Math.cos(th) - p[1] * Math.sin(th)) * U, (p[0] * Math.sin(th) + p[1] * Math.cos(th)) * U, 0]);
      }
      out.push(line);
    }
  }
  return out;
}

/**
 * Roughly how wide a task's name is in layout units at the zoom the whole topic opens on (letter-spaced, about 2 px a
 * unit there): a base shorter than its name still gets that much room in its row.
 */
function nameRoom(lane: PanoramaLane): number {
  return [...lane.short].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e80 ? 8.5 : 5), 0) + 8;
}

/** A line moved sideways by d (to its left for d > 0), point by point along the normal. */
function offset(pts: XY[], d: number): XY[] {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    return [p[0] - (ty / l) * d, p[1] + (tx / l) * d];
  });
}

/** A rounded rectangle, closed; `q` grows (or shrinks, negative) it by that much. */
function roundRect(x0: number, y0: number, x1: number, y1: number, q: number, R: number): XY[] {
  const pts: XY[] = [];
  const corners: [number, number, number][] = [
    [x1 - R + q, y0 + R - q, -90],
    [x1 - R + q, y1 - R + q, 0],
    [x0 + R - q, y1 - R + q, 90],
    [x0 + R - q, y0 + R - q, 180],
  ];
  for (const [cx, cy, a0] of corners)
    for (let k = 0; k <= 6; k++) {
      const t = ((a0 + k * 15) * Math.PI) / 180;
      pts.push([cx + R * Math.cos(t), cy + R * Math.sin(t)]);
    }
  pts.push(pts[0]!);
  return pts;
}

function cornerTicks(x0: number, y0: number, x1: number, y1: number): XY[][] {
  const o = 4;
  const L = 8;
  const at: [number, number, number, number][] = [
    [x0 - o, y1 + o, 1, -1],
    [x1 + o, y1 + o, -1, -1],
    [x1 + o, y0 - o, -1, 1],
    [x0 - o, y0 - o, 1, 1],
  ];
  return at.map(([x, y, sx, sy]) => [
    [x + sx * L, y],
    [x, y],
    [x, y + sy * L],
  ]);
}

const Q = (x: number, y: number): LngLatZ => [x * U, y * U, 0];

/** A grid every 20 units over the map and a margin around it, fading out away from the middle. */
function grid(X0: number, X1: number, Y0: number, Y1: number): PanoramaLayout["grid"] {
  const out: PanoramaLayout["grid"] = [];
  const R = Math.max(X1 - X0, Y1 - Y0) * 0.75;
  const alphaAt = (x: number, y: number) => Math.max(0, 1 - Math.hypot(x, y * 1.2) / R) ** 1.4;
  const g = 20;
  const seg = g * 2;
  const GX0 = X0 - 200;
  const GX1 = X1 + 200;
  const GY0 = Y0 - 200;
  const GY1 = Y1 + 200;
  for (let x = Math.ceil(GX0 / g) * g; x <= GX1; x += g)
    for (let y = GY0; y < GY1; y += seg) {
      const a = alphaAt(x, y + seg / 2);
      if (a > 0.02) out.push({ from: Q(x, y), to: Q(x, y + seg), a, major: x % (g * 5) === 0 });
    }
  for (let y = Math.ceil(GY0 / g) * g; y <= GY1; y += g)
    for (let x = GX0; x < GX1; x += seg) {
      const a = alphaAt(x + seg / 2, y);
      if (a > 0.02) out.push({ from: Q(x, y), to: Q(x + seg, y), a, major: y % (g * 5) === 0 });
    }
  return out;
}

/** The prototype's radar (concentric rings, a dashed ring, a tick ring, a crosshair) and the chamfered frame. */
function deco(X0: number, X1: number, Y0: number, Y1: number): PanoramaLayout["deco"] {
  const Rr = Math.max(X1 - X0, Y1 - Y0) / 2;
  const circle = (R: number, n = 160): LngLatZ[] => {
    const p: LngLatZ[] = [];
    for (let k = 0; k <= n; k++) {
      const t = (k / n) * 2 * Math.PI;
      p.push(Q(R * Math.cos(t), R * Math.sin(t)));
    }
    return p;
  };
  const dashes: LngLatZ[][] = [];
  const dashR = Rr * 0.62;
  for (let k = 0; k < 90; k++) {
    const t0 = (k / 90) * 2 * Math.PI;
    const t1 = t0 + (2 * Math.PI) / 90 / 3;
    dashes.push([Q(dashR * Math.cos(t0), dashR * Math.sin(t0)), Q(dashR * Math.cos(t1), dashR * Math.sin(t1))]);
  }
  const ticks: { path: LngLatZ[]; a: number }[] = [];
  for (let k = 0; k < 120; k++) {
    const t = (k / 120) * 2 * Math.PI;
    const R = Rr * 0.92;
    const l = k % 10 === 0 ? Rr * 0.05 : k % 5 === 0 ? Rr * 0.028 : Rr * 0.014;
    ticks.push({ path: [Q(R * Math.cos(t), R * Math.sin(t)), Q((R + l) * Math.cos(t), (R + l) * Math.sin(t))], a: k % 10 === 0 ? 1 : 0.55 });
  }
  const g = Rr * 0.06;
  const E = Rr * 1.08;
  for (const [sx, sy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const)
    ticks.push({ path: [Q(sx * g, sy * g), Q(sx * E, sy * E)], a: 0.5 });
  const cc = 26;
  const frame = (
    [
      [X0 + cc, Y1],
      [X1 - cc, Y1],
      [X1, Y1 - cc],
      [X1, Y0 + cc],
      [X1 - cc, Y0],
      [X0 + cc, Y0],
      [X0, Y0 + cc],
      [X0, Y1 - cc],
      [X0 + cc, Y1],
    ] as XY[]
  ).map(([x, y]) => Q(x, y));
  const frameTicks: LngLatZ[][] = [];
  for (let x = X0 + cc + 20, k = 1; x < X1 - cc; x += 20, k++) {
    const l = k % 5 === 0 ? 7 : 3.5;
    frameTicks.push([Q(x, Y1), Q(x, Y1 - l)], [Q(x, Y0), Q(x, Y0 + l)]);
  }
  return { rings: [circle(Rr * 0.92), circle(Rr * 0.3)], dashes, ticks, frame, frameTicks };
}
