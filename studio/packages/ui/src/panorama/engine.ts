import { Deck, FlyToInterpolator, MapView, WebMercatorViewport, type Layer, type PickingInfo } from "@deck.gl/core";
import { ArcLayer, IconLayer, LineLayer, PathLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { cut, ITEM_LABEL, needsYou, type ItemStatus, type PanoramaData, type PanoramaDoc, type PanoramaItem, type PanoramaProject } from "./datalayer.js";
import { BLOCK_ZOOM, H_NODE, layoutPanorama, U, type BlockLayout, type LngLatZ, type PanoramaLayout, type RegionLayout, type WorldTopic } from "./layout.js";
import { glyphs } from "./glyphs.js";
import { shapeKey, type TopicFrame, type TopicShape, type WorldKind } from "./regions.js";
import { knownShape, requestShape } from "./shapes.js";
import { atlasTextures, forgetDevice, SharedAtlasTextLayer, sweepAtlases, type Device } from "./sharedText.js";
import type { PanoramaTheme, RGB } from "./themes.js";

// The 全景 map, drawn with deck.gl (2026-11-01). Only this module imports deck.gl, and the page loads it with a dynamic
// import, so the 1 MB or so of deck.gl stays out of the main bundle. Used imperatively (new Deck in the page's effect),
// not through @deck.gl/react, which is not checked against React 19.
//
// What it draws comes from the datalayer (datalayer.ts) and its layout (layout.ts), never from Studio's state. Looks
// come from the theme table (themes.ts). Ported from the prototype (studio/plans/userlayer/v-deck3.html, #oblivion),
// with its performance rules (README, v-deck2): layers that depend only on the data are built once per data change;
// the pulses change only opacity, sizes and angles of a handful of objects; deck's own render loop stops when nothing
// moves (and starts again on input); signs are placed once the camera has stopped; at most 1.5 device pixels; no
// CollisionFilterExtension; nothing draws while the page is hidden.
//
// P1 (2026-11-02): each task is a tree (layout.ts) and the map has two levels. 远 (the whole topic): every task's start
// beacon, its trunk (how far it came), its goal and what waits for you. 中, once zoomed in from there (and never
// before rounds are about 28 px apart): the round nodes, 第 N 轮, the branches. The map opens on 远, whatever the
// topic's size; 近 brings in the signs of every node. Lights flow into what is running and along dependency
// arcs: while anything runs the map draws at the theme's fps (only the few dozen lights are rebuilt per frame).
//
// Looks tried in the preview (themes.ts PanoramaLook, 11-02): the front column and the chevrons ahead (a wave runs along
// them while the task runs), folded runs of rounds (「×N 轮」, opened by a click — the page keeps which — or all at once
// from 中 on: the layout is redone then, nothing but the folded rounds moves), the roads' curve.
//
// 0.3 (2026-11-03, `blocks`): a block per topic and three levels — 远 the topics (each a block with its header, its
// tasks thin lines), 中 a topic's inside from T.block.inside on (projects' bands and status boards, the spine of its own
// sessions, the shelf, the board; the tasks with their bases and columns), 近 the rounds from T.block.rounds on.
//
// World (2026-11-03, looks `terrain` / `metro`): the same three levels with a region per topic (layout.ts planWorld,
// regions.ts) — 远 the regions with their header, roads as lines, the fronts and what waits; 中 a topic's inside (the
// plates' text, the books, the nodes, the lanes' names); 近 第 N 轮 and the signs (worldLayers).

export interface EngineEvents {
  /** A node (or its sign) was clicked. */
  onPick(itemId: string): void;
  /** The first frame is drawn. */
  onReady(): void;
  /** deck.gl failed (WebGL could not start, the context was lost): the page shows its list instead. */
  onError(error: Error): void;
  /** The camera moved: a line for the readout (level, zoom, tilt, heading). Called only when that line changes. */
  onView?(line: string): void;
  /** A folded run of rounds (`fold`) was clicked: the page opens or folds it again (setOpen). */
  onFold?(key: string): void;
}

interface Node {
  id: string;
  it: PanoramaItem;
  r: RegionLayout;
  /** On the ground, up at node height, and where its sign sits (raised when it had to make room). */
  g: LngLatZ;
  p: LngLatZ;
  lp: LngLatZ;
  lz: number;
  icon: string;
}

/** What the page and the e2e test can read: nodes on screen, whether the camera is still moving. */
export interface EngineProbe {
  screenOf(id: string): [number, number] | null;
  regionNameOf(laneId: string): [number, number] | null;
  readonly busy: boolean;
  /** The opening animation still plays (world looks while topics' land is worked out). */
  readonly opening: boolean;
  /** When the opening's animation started (performance.now), null before its first frame or without one. */
  readonly openingAt: number | null;
  /** What the engine did (measuring): how many times and how long (ms) — data laid out, sign placements, deck frames. */
  readonly stats: Record<string, number>;
  /** The camera's zoom now (measuring). */
  readonly zoom: number;
  /** The font atlases in use (tests and measuring). */
  readonly atlases: { sdf: boolean; w: number; h: number; glyphs: number }[];
  readonly selected: string | null;
  readonly signs: number;
  /** 远 or 中 (近 has no content of its own: the signs of every node come in); with topic blocks, `topics` before 远. */
  readonly level: "topics" | "far" | "mid";
  /** Topic blocks drawn. */
  readonly blocks: number;
  /** Topic regions drawn (world looks). */
  readonly world: number;
  /** Where to click on a topic's header (its info lines) to go into it; null without blocks. */
  blockHead(title: string): [number, number] | null;
  /** Fly close to an item (as its popup does), without selecting it. */
  flyNear(id: string): void;
  /** Paths with lights flowing (one per running session) and dependency arcs drawn. */
  readonly flows: number;
  readonly arcs: number;
  /** `fold`: the runs of rounds, whether shown spread out, and where their 「×N 轮」 is on screen. */
  readonly folds: { key: string; open: boolean; xy: [number, number] | null }[];
}

const SYM: Record<ItemStatus, string> = { needs_you: "!", working: "◐", waiting: "○", settled: "✓", parked: "–" };
const LANE_TEXT: Record<string, string> = { running: "◐ 在跑", waiting: "○ 停着", done: "✓ 完成", parked: "– 搁置" };
const COLUMN: Record<string, string> = { todo: "待办", doing: "进行中", review: "待审阅", done: "完成" };
const ICONS = ["circle", "dotring", "bracket", "selring", "ring", "glow", "beacon", "goal", "goalhalf", "goalfill"] as const;

const VIEW_LIMITS = { minZoom: 5, maxZoom: 14.2, maxPitch: 70 };
/**
 * The wheel (11-04, the user: zooming in and out fast felt like dropped frames). deck.gl's smooth scroll starts a new
 * 250 ms transition from wherever the camera is at each wheel event, so a fast spin or a trackpad's stream of small
 * events keeps restarting it: the zoom stutters and falls far short. Here each event adds to a target zoom (deck.gl's
 * curve for how much: `speed`) and every frame the camera closes `1 - e^(-dt/tau)` of the gap, the ground under the
 * pointer staying under it, never faster than `max` zoom levels a second (a fast spin's gap would otherwise be crossed
 * in a few big frame-to-frame jumps on a 60 Hz screen). Pinching a trackpad comes as a wheel with Ctrl (`pinch`: its
 * deltas are small).
 */
const WHEEL = { speed: 0.012, tau: 85, pinch: 2.5, stop: 0.002, max: 14 };
/** Folded runs open (or fold again) this long after the camera came to rest: not between two quick spins. */
const FOLD_SETTLE = 300;
/** Metres in a layout unit (0.001°) near the map's origin: ground text is sized in metres. */
const M_PER_UNIT = 111.32;
/** A point `d` layout units south of p (text hung under something on the ground). */
const south = (p: LngLatZ, d: number, east = 0): LngLatZ => [p[0] + east * U, p[1] - d * U, 0];
/**
 * Ground text big on the screen is drawn from a signed distance field atlas (glyphs.ts), sharp however close it gets;
 * below `px` pixels from the bitmap atlas (an SDF drawn small breaks thin CJK strokes into dots). deck.gl's `buffer`
 * leaves room for the field's margin and a glyph reaching left of its pen (glyphs.ts).
 */
const SDF = { px: 24, over: [22, 27] as const, fontSize: 64, radius: 8, buffer: 16, cutoff: 0.25 };
/** The SDF edge's anti-aliasing (deck.gl's `smoothing`) for text of `px` on the screen: about ±0.6 px, in a few steps. */
const sdfSmoothing = (px: number) => {
  const g = 0.6 / (SDF.radius * Math.max(0.05, px / SDF.fontSize));
  return Math.min(0.25, Math.max(0.015, 2 ** (Math.round(Math.log2(g) * 3) / 3)));
};
/** Screen pixels in a layout unit at zoom z (straight down; tilted, the far side is smaller). */
const unitPx = (z: number) => (512 * 2 ** z * U) / 360;
/** Ground text grows and shrinks with the map; once it would be under ~px pixels it fades out (the user, 11-04: hide it, do not keep it screen-sized). */
const legible = (size: number, px = 7) => (z: number) => ss(px - 1.5, px + 0.5, size * unitPx(z));
/** Smoothstep from e0 to e1: the semantic zoom fades (thresholds as in the prototype). */
const ss = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const rgba = (c: RGB | readonly number[], al: number): [number, number, number, number] => [c[0]!, c[1]!, c[2]!, Math.max(0, Math.min(255, Math.round(al)))];
const GOAL_TEXT: Record<string, string> = { open: "终点", review: "待验收", reached: "已到达" };
const easeInOut3 = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const pulse = (t: number, period: number) => 0.5 + 0.5 * Math.sin((t / (period * 1000)) * 2 * Math.PI);

type ViewState = { longitude: number; latitude: number; zoom: number; pitch: number; bearing: number };
/** deck's render loop: not in its public types, but stopping it while nothing moves is what keeps an idle map at 0 % CPU. */
type Loop = { start(): unknown; stop(): unknown; redraw(): unknown };

/** One layer and how visible it is at a zoom; recloned only when that changes. */
type RunChev = { path: LngLatZ[]; j: number; n: number; r: RegionLayout };
/** What a set of layers is built from: everything, only the map-wide things (`global`), or one world topic's. */
interface View {
  world: WorldTopic[];
  regs: RegionLayout[];
  nodes: Node[];
  fronts: Node[];
  runChev: RunChev[];
  global: boolean;
}
/** Which step of a topic's opening a layer comes in with (INTRO). */
type Phase = "coast" | "fill" | "road" | "text";

/**
 * The opening of a world map (11-04, the user: it may take a moment, as long as something plays meanwhile). A scan line
 * sweeps the ground and each topic waits as a breathing frame where it will be; once its land is worked out (shapes.ts)
 * its coast is drawn round, its parts fill in, its roads grow from their starts and their nodes light up, the printed
 * text fades in; the signs come last, after the last topic. Times in ms from a topic's start (`born`); topics start at
 * least `stagger` apart and not before `lead` after the first frame.
 */
const INTRO = { lead: 360, stagger: 170, scan: 950, coast: [0, 520], fill: [200, 700], road: [460, 1060], text: [880, 1280], signs: [1150, 1450], end: 1480, frameOut: 420 } as const;

/** A layer's id without a topic's `@k` and an SDF twin's `~sdf`. */
function baseId(id: string): string {
  return id.replace(/@\d+$/, "").replace(/~sdf$/, "");
}

/** The part of a path from its start that is `f` of its length. */
function prefix(path: readonly LngLatZ[], f: number): LngLatZ[] {
  if (f >= 1) return [...path];
  if (f <= 0 || path.length < 2) return [];
  const seg: number[] = [];
  let L = 0;
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1]);
    seg.push(d);
    L += d;
  }
  let need = L * f;
  const out: LngLatZ[] = [path[0]!];
  for (let i = 1; i < path.length; i++) {
    const d = seg[i - 1]!;
    if (need >= d) {
      out.push(path[i]!);
      need -= d;
      continue;
    }
    const a = path[i - 1]!;
    const b = path[i]!;
    const u = d ? need / d : 0;
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, 0]);
    break;
  }
  return out;
}

function phaseOf(id: string): Phase {
  const n = id.replace(/~sdf$/, "");
  if (n.startsWith("world-coast-")) return "coast";
  if (/^(world-title|world-info|world-spine-label|world-card-text|world-shelf-label|world-book-title|world-board-label|world-board-line|region-name|round|goal-text|fold-text)$/.test(n)) return "text";
  if (/^(world-road-|branch-|ahead$|chev-|front-|world-goal|world-fork|world-front|world-hub|world-tick|nodes$|node-|fold-brk)/.test(n)) return "road";
  return "fill";
}

interface Entry {
  layer: Layer;
  o: (z: number) => number;
  lastO: number;
  shown: Layer | null;
  /** Props that follow the zoom (an SDF text's smoothing), with a key that changes when they do. */
  p?: (z: number) => { k: number; props: Record<string, unknown> };
  lastK?: number;
}

export class PanoramaEngine {
  private deck: Deck<MapView>;
  private data!: PanoramaData;
  private layout!: PanoramaLayout;
  private signature = "";
  private nodes: Node[] = [];
  private byId = new Map<string, Node>();
  private need: Node[] = [];
  private flowPaths: Measured[] = [];
  private risers: Node[] = [];
  private arcPaths: Measured[] = [];
  /** `front`: each task's front node, and the chevrons ahead of the tasks that run (they move; the others are drawn still). */
  private fronts: Node[] = [];
  private runChev: RunChev[] = [];
  /** `fold`: the runs the page opened, and whether the camera is close enough (中) to open them all. */
  private openFolds: ReadonlySet<string> = new Set();
  /** `blocks`: every item, and where the ones that are not nodes stand (spine sessions, points, documents). */
  private itemById = new Map<string, PanoramaItem>();
  private spots = new Map<string, LngLatZ>();
  private roundCards: { it: PanoramaItem; p: LngLatZ }[] = [];
  /** What waits on the person from afar: the nodes, and points and spine sessions that wait. */
  private needFar: { id: string; p: LngLatZ }[] = [];
  /** Rounds in a run shown folded, with its length: no 第 N 轮, their columns dimmer the more are bunched (they add up). */
  private folded = new Map<string, number>();
  private autoOpen = false;
  private base: Entry[] = [];
  /** While the opening plays: the map-wide layers and each topic's own (by topic id), so each topic comes in on its own. */
  private parts = new Map<string, Entry[]>();
  private globalEntries: Entry[] = [];
  private intro: { t0: number; next: number; born: Map<string, number> } | null = null;
  /** World: the land a topic had last (shown while a changed topic's new land is worked out), what was asked for each. */
  private lastShape = new Map<string, TopicShape>();
  private asked = new Map<string, string>();
  private laidOnce = false;
  private labels: Entry[] = [];
  private icon: { url: string; mapping: Record<string, unknown> };
  private vs: ViewState;
  private home: ViewState;
  private sel: string | null = null;
  private inset = 0;
  private ready = false;
  private dead = false;
  private loopOn = true;
  private interacting = false;
  /** The wheel's zoom under way: where it goes, about which point (screen and ground), its last frame. */
  private wz: { target: number; at: [number, number]; ground: [number, number]; last: number; raf: number } | null = null;
  private busyFly = false;
  private labPending = true;
  private lastLabZ = -1;
  private signs = 0;
  private timers = { idle: 0, tick: 0, lab: 0, fly: 0, sweep: 0, fold: 0 };
  private resize: ResizeObserver;
  private readonly params: Record<string, unknown>;
  private readonly flat = { depthCompare: "always", depthWriteEnabled: false };
  /** Where 中 begins: just in from the whole topic, and not before rounds (18 layout units) are ~28 px apart. */
  /** Topics drawn as blocks or as regions (world): the map has a far level of topics and their insides. */
  private get grouped(): boolean {
    return this.layout.blocks.length > 0 || this.layout.world.length > 0;
  }
  private get m0(): number {
    return this.grouped ? Math.max(this.home.zoom + 0.3, BLOCK_ZOOM + this.theme.block.rounds) : Math.max(10.1, this.home.zoom + 0.3);
  }
  /** With topic blocks: how far into a topic's inside (0 from afar, 1 inside); 1 without them. */
  private inside = (z: number) => (this.grouped ? ss(BLOCK_ZOOM + this.theme.block.inside, BLOCK_ZOOM + this.theme.block.inside + 0.35, z) : 1);
  private mid = (z: number) => ss(this.m0, this.m0 + 0.5, z);
  private roundText = (z: number) => ss(this.m0 + 0.8, this.m0 + 1.3, z);
  /** 近: the signs of every node. */
  private get near(): number {
    return Math.min(this.m0 + 1.7, 13);
  }

  constructor(
    private parent: HTMLDivElement,
    private theme: PanoramaTheme,
    data: PanoramaData,
    private events: EngineEvents,
  ) {
    // Lines and nodes are drawn in order without a depth test, each kind on its own layer, so they never fight;
    // additive blending makes crossings brighter (the hologram look).
    this.params = theme.additive
      ? { ...this.flat, blend: true, blendColorOperation: "add", blendColorSrcFactor: "src-alpha", blendColorDstFactor: "one", blendAlphaOperation: "add", blendAlphaSrcFactor: "one", blendAlphaDstFactor: "one-minus-src-alpha" }
      : this.flat;
    this.icon = buildIcons();
    this.applyData(data);
    this.home = this.fit(this.layout.bounds, { pitch: 50, bearing: -12, pad: { top: 110, bottom: 80, left: 70, right: 70 } });
    this.vs = { ...this.home };
    this.deck = new Deck<MapView>({
      parent,
      views: new MapView({ repeat: false }),
      initialViewState: { ...VIEW_LIMITS, ...this.home, minZoom: this.home.zoom - 1.3 },
      controller: { doubleClickZoom: false, scrollZoom: false, inertia: 250 },
      useDevicePixels: Math.min(window.devicePixelRatio || 1, 1.5),
      pickingRadius: 5,
      onViewStateChange: ({ viewState }) => {
        this.vs = viewState as unknown as ViewState;
        this.push();
        this.ensureTick();
        // A big zoom change re-places the signs while dragging too (throttled), so they do not pile up meanwhile.
        this.scheduleLabels(Math.abs(this.vs.zoom - this.lastLabZ) > 0.45 ? 90 : 160);
        return viewState;
      },
      onInteractionStateChange: (s) => {
        this.interacting = !!(s.isDragging || s.isPanning || s.isZooming || s.isRotating || s.inTransition);
        if (!s.inTransition) this.busyFly = false;
        if (this.interacting) this.wake();
        else {
          this.scheduleLabels();
          this.push();
        }
      },
      getCursor: ({ isDragging, isHovering }) => (isDragging ? "grabbing" : isHovering ? "pointer" : "grab"),
      onClick: (info: PickingInfo) => this.click(info),
      onLoad: () => {
        this.ready = true;
        // The opening starts after the first frame (the one that sets everything up).
        if (this.intro)
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const I = this.intro;
              if (!I || this.dead) return;
              I.t0 = performance.now();
              I.next = I.t0 + INTRO.lead;
              for (const w of this.layout.world) if (!w.pending) this.start(w.id);
              this.ensureTick();
            }),
          );
        this.scheduleLabels(0);
        this.wake();
        this.ensureTick();
        this.events.onReady();
      },
      onError: (error: Error) => {
        if (!this.dead) this.events.onError(error);
      },
      layers: [],
    });
    this.resize = new ResizeObserver(() => {
      this.wake();
      this.scheduleLabels();
    });
    this.resize.observe(parent);
    for (const ev of ["pointerdown", "pointermove", "pointerup", "wheel", "contextmenu"]) parent.addEventListener(ev, this.wake, { capture: true, passive: true });
    parent.addEventListener("dblclick", this.dblclick);
    parent.addEventListener("wheel", this.onWheel, { passive: false });
    // A press stops the wheel's zoom where it is (the drag takes over).
    parent.addEventListener("pointerdown", this.stopWheel, { capture: true, passive: true });
    document.addEventListener("visibilitychange", this.visibility);
    this.push();
  }

  // ---------- data ----------

  /** New data: re-laid out and redrawn only when what the map shows changed (not on every session timestamp). */
  setData(data: PanoramaData): void {
    if (this.dead) return;
    const sig = signatureOf(data);
    this.data = data;
    if (sig === this.signature) return;
    this.applyData(data);
    if (this.sel && !this.byId.has(this.sel)) this.sel = null;
    this.scheduleLabels(0);
    this.push();
    this.wake();
    this.ensureTick();
  }

  private applyData(data: PanoramaData): void {
    this.data = data;
    this.signature = signatureOf(data);
    const look = this.theme.look;
    // World: the shapes known are used, the others asked for (shapes.ts) and put in as they come (`landed`).
    const pending: { id: string; frame: TopicFrame; kind: WorldKind }[] = [];
    const shape = (frame: TopicFrame, kind: WorldKind, id: string): TopicShape | null => {
      const s = knownShape(frame, kind);
      if (s) {
        this.lastShape.set(id, s);
        return s;
      }
      pending.push({ id, frame, kind });
      return this.lastShape.get(id) ?? null;
    };
    this.layout = layoutPanorama(data, { tight: look.plinth, curve: look.curve, span: look.span, fold: look.fold, open: this.autoOpen ? "all" : this.openFolds, front: look.front ? this.theme.front.min : null, blocks: look.blocks, world: look.world, shape });
    // The first time with land still to work out: the opening plays (started on deck's first frame).
    if (!this.laidOnce && pending.some((q) => !this.lastShape.has(q.id))) this.intro = { t0: NaN, next: 0, born: new Map() };
    this.laidOnce = true;
    for (const q of pending) {
      const key = shapeKey(q.frame, q.kind);
      if (this.asked.get(q.id) === key) continue;
      this.asked.set(q.id, key);
      requestShape(q.frame, q.kind, () => this.landed(q.id, key));
    }
    this.nodes = [];
    this.byId.clear();
    for (const r of this.layout.regions)
      r.items.forEach((it, i) => {
        const at = r.nodes[it.id]!;
        // Signs alternate between two heights, so neighbours do not sit on one line.
        // With light columns the node sits on top of its own (the front on its own in any case; in a world look the front
        // stays on the road and its column rises over it).
        const p = look.pillars || (it.id === r.front && !look.world) ? at.top : at.at;
        const lz = Math.max(look.world ? 0 : H_NODE, p[2]) + (i % 2 ? 620 : 340);
        const n: Node = { id: it.id, it, r, g: at.ground, p, lz, lp: [p[0], p[1], lz], icon: it.round === null ? "dotring" : "circle" };
        this.nodes.push(n);
        this.byId.set(n.id, n);
      });
    const order = needsYou(data).map((i) => i.id);
    this.need = order.map((id) => this.byId.get(id)).filter((n): n is Node => !!n);
    // Topic blocks: spine sessions, points and documents are picked and flown to where their block puts them; a point of
    // a round stands by that round's column (a few on one round one above the other).
    this.itemById = new Map(data.items.map((i) => [i.id, i]));
    this.spots.clear();
    for (const b of this.layout.blocks) {
      for (const n of b.spine.nodes) this.spots.set(n.id, n.at);
      for (const c of b.board.cards) this.spots.set(c.id, c.at);
      for (const d of b.shelf.docs) this.spots.set(d.doc.id, d.at);
    }
    for (const w of this.layout.world) {
      for (const n of w.spine.nodes) this.spots.set(n.id, n.at);
      for (const c of w.board.lines) this.spots.set(c.id, c.at);
      for (const b of w.shelf.books) this.spots.set(b.doc.id, b.center);
    }
    const onRound = new Map<string, number>();
    this.roundCards = [];
    for (const it of data.items) {
      const n = it.type !== "session" && it.of ? this.byId.get(it.of) : undefined;
      if (!n) continue;
      const k = onRound.get(n.id) ?? 0;
      onRound.set(n.id, k + 1);
      const p: LngLatZ = [n.p[0] + 1.4 * U, n.p[1], n.p[2] + k * 220];
      this.roundCards.push({ it, p });
      this.spots.set(it.id, p);
    }
    this.needFar = [...this.need.map((n) => ({ id: n.id, p: n.p })), ...order.filter((id) => !this.byId.has(id) && this.spots.has(id)).map((id) => ({ id, p: this.spots.get(id)! }))];
    // The ways lights flow along, measured once: into what runs, and along each dependency arc.
    this.flowPaths = this.layout.regions.flatMap((r) => r.flows).map(measure);
    // With light columns, lights also rise up the running ones into their top; and up the front of a task that runs.
    const runs = (r: RegionLayout) => r.items.some((i) => i.status === "working");
    this.fronts = this.nodes.filter((n) => n.id === n.r.front);
    this.folded = new Map(this.layout.regions.flatMap((r) => r.folds.filter((f) => !f.open).flatMap((f) => f.ids.map((id) => [id, f.ids.length] as const))));
    this.risers = [...new Set([...(look.pillars ? this.nodes.filter((n) => n.it.status === "working") : []), ...this.fronts.filter((n) => runs(n.r))])];
    this.runChev = this.layout.regions.filter(runs).flatMap((r) => r.chevrons.map((path, j) => ({ path, j, n: r.chevrons.length, r })));
    this.arcPaths = this.layout.arcs.map((a) => arcPath(a.s, a.t, this.theme.arc.height));
    this.base = this.buildBase();
    this.sweepSoon();
  }

  /** A while after the layers changed (deck.gl has updated them): textures of font atlases no layer draws from go. */
  private sweepSoon(): void {
    clearTimeout(this.timers.sweep);
    this.timers.sweep = window.setTimeout(() => {
      if (this.dead || this.intro || !this.deck.isInitialized) return;
      sweepAtlases(this.device(), this.lm()?.getLayers() ?? []);
    }, 2000);
  }

  private device(): Device | undefined {
    return (this.deck as unknown as { device?: Device }).device;
  }

  private lm(): { getLayers(): Layer[] } | undefined {
    return (this.deck as unknown as { layerManager?: { getLayers(): Layer[] } }).layerManager;
  }

  // ---------- layers ----------

  private col(st: ItemStatus | "hot"): RGB {
    return this.theme.col[st];
  }

  private regCol(r: RegionLayout): RGB {
    return r.lane.status === "done" ? this.theme.col.settled : r.lane.status === "parked" ? this.theme.col.parked : this.theme.col.working;
  }

  private path(id: string, data: unknown[], color: (d: never) => number[], width: number, extra: Record<string, unknown> = {}): Layer {
    return new PathLayer({ id, data, getPath: (d: { path: LngLatZ[] }) => d.path, getColor: color as never, getWidth: width, widthUnits: "pixels", jointRounded: true, capRounded: true, parameters: this.params as never, ...extra });
  }

  /**
   * Text printed on the ground (world looks, 11-04): lying on the map (not facing the camera), its size in layout units
   * (`getSize`), turning and shrinking with the map; distance (semantic zoom) decides when it is there at all.
   * Two layers: from the bitmap atlas while small on the screen, from the SDF atlas once big (sharp up close; `SDF`).
   */
  private ground(props: Record<string, unknown>): Layer {
    const size = props.getSize as number;
    const all = { billboard: false, sizeUnits: "meters", ...props, getSize: size * M_PER_UNIT };
    const bitmap = this.text(all);
    // Its twin from the SDF atlas, drawn instead once the text is SDF.px or more on the screen (at the view's middle).
    const { px, over: _over, ...font } = SDF;
    this.twins.set(bitmap, { size, sdf: this.text({ ...all, id: `${props.id as string}~sdf`, fontSettings: { ...font, sdf: true, smoothing: sdfSmoothing(px) } }) });
    return bitmap;
  }
  private twins = new WeakMap<Layer, { size: number; sdf: Layer }>();

  /** How far the pen moves over s at size (deck.gl lays text out by the same advances), for text set right after other text. */
  private advance(s: string, size: number): number {
    const ctx = (this.measurer ??= document.createElement("canvas").getContext("2d")!);
    ctx.font = `${this.theme.fontWeight} 64px ${this.theme.font}`;
    return (ctx.measureText(s).width / 64) * size;
  }
  private measurer: CanvasRenderingContext2D | null = null;

  private text(props: Record<string, unknown>): Layer {
    return new SharedAtlasTextLayer({ characterSet: "auto", fontFamily: this.theme.font, fontWeight: this.theme.fontWeight, parameters: this.flat as never, _getFontRenderer: glyphs, ...props } as never);
  }

  /** Layers that change only with the data (and the selection, which is cheap to rebuild with them). */
  private viewAll(): View {
    return { world: this.layout.world, regs: this.layout.regions, nodes: this.nodes, fronts: this.fronts, runChev: this.runChev, global: true };
  }

  /** The layers: all in one set, or while the opening plays the map-wide set and a set per topic (`part`). */
  private buildBase(): Entry[] {
    if (!this.intro || !this.layout.world.length) {
      this.parts.clear();
      this.globalEntries = [];
      return this.buildView(this.viewAll());
    }
    this.globalEntries = this.buildView({ world: [], regs: [], nodes: [], fronts: [], runChev: [], global: true }).map((e) => {
      const o0 = e.o;
      const id = e.layer.id;
      const f = id === "world-dots" ? () => this.scanned() : id === "alert-far" ? () => this.signsIn() : id.startsWith("arc-") ? () => this.allIn() : () => 1;
      return { ...e, o: (z: number) => o0(z) * f() };
    });
    this.globalEntries.push(...this.warmers());
    this.parts.clear();
    this.layout.world.forEach((w, k) => this.parts.set(w.id, this.part(w, k)));
    return this.assemble();
  }

  /**
   * One hidden layer of each kind the topics use, set up with the first frame (before the opening starts): deck.gl
   * compiles a kind's shaders when its first layer is set up, which blocks for a while (~1 s for all here); done then,
   * a topic coming in later does not stall the animation with it.
   */
  private warmers(): Entry[] {
    const p: LngLatZ = this.layout.world[0]?.middle ?? [0, 0, 0];
    const one = [{ p, path: [p, p], ring: [[p[0], p[1]], [p[0] + U, p[1]], [p[0], p[1] + U]] }];
    const T = this.theme;
    const ls: Layer[] = [
      new PolygonLayer({ id: "warm-poly", data: one, getPolygon: (d: { ring: number[][] }) => d.ring, getFillColor: [0, 0, 0, 0], stroked: false }),
      this.path("warm-path", one, (() => [0, 0, 0, 0]) as never, 1),
      new ScatterplotLayer({ id: "warm-dot", data: one, getPosition: (d: { p: LngLatZ }) => d.p, getRadius: 1, radiusUnits: "pixels", stroked: true, getFillColor: [0, 0, 0, 0], getLineColor: [0, 0, 0, 0] }),
      new LineLayer({ id: "warm-line", data: one, getSourcePosition: (d: { p: LngLatZ }) => d.p, getTargetPosition: (d: { p: LngLatZ }) => d.p, getColor: [0, 0, 0, 0] }),
      new IconLayer({ id: "warm-icon", data: one, iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: () => "glow", getPosition: (d: { p: LngLatZ }) => d.p, getSize: 1, getColor: [0, 0, 0, 0] }),
      this.text({ id: "warm-text", data: one, getPosition: (d: { p: LngLatZ }) => d.p, getText: () => T.look.world ?? "", getSize: 1, getColor: [0, 0, 0, 0], background: true, getBackgroundColor: [0, 0, 0, 0] }),
    ];
    // Drawn (transparent): the GPU driver may finish a shader only on its first draw (ANGLE's do).
    return ls.map((layer) => ({ layer: layer.clone({ parameters: this.params }), o: () => 1, lastO: -1, shown: null }));
  }

  private assemble(): Entry[] {
    return [...this.globalEntries, ...this.layout.world.flatMap((w) => this.parts.get(w.id) ?? [])];
  }

  /** A topic's own layers (ids ending `@k`), each coming in with its step of the opening. */
  private part(w: WorldTopic, k: number): Entry[] {
    const mine = <T extends { r: RegionLayout }>(x: T) => x.r.lane.topic === w.id;
    const v: View = { world: [w], regs: this.layout.regions.filter((r) => r.lane.topic === w.id), nodes: this.nodes.filter(mine), fronts: this.fronts.filter(mine), runChev: this.runChev.filter(mine), global: false };
    return this.buildView(v).map((e) => {
      const o0 = e.o;
      const ph = phaseOf(e.layer.id);
      return { ...e, layer: e.layer.clone({ id: `${e.layer.id}@${k}` }), o: (z: number) => o0(z) * this.reveal(w.id, ph) };
    });
  }

  /** How far a topic's layers of one step are in (1 without an opening). */
  private reveal(id: string, ph: Phase): number {
    const I = this.intro;
    if (!I) return 1;
    const b = I.born.get(id);
    if (b === undefined) return 0;
    const t = performance.now() - b;
    if (ph === "coast") return t >= INTRO.coast[1] ? 1 : 0;
    if (ph === "fill") return ss(INTRO.fill[0], INTRO.fill[1], t);
    if (ph === "road") return ss(INTRO.road[1] - 140, INTRO.road[1], t);
    return ss(INTRO.text[0], INTRO.text[1], t);
  }

  /** The opening: how far the scan line has come (0–1), from deck's first frame. */
  private scanned(): number {
    const I = this.intro;
    return !I ? 1 : Number.isNaN(I.t0) ? 0 : Math.min(1, (performance.now() - I.t0) / INTRO.scan);
  }

  /** When the last topic started (−∞ none yet; +∞ some still to come). */
  private lastBorn(): number {
    const I = this.intro;
    if (!I) return -Infinity;
    if (this.layout.world.some((w) => !I.born.has(w.id))) return Infinity;
    return Math.max(-Infinity, ...I.born.values());
  }

  /** The signs (and the far 等你 rings): after the last topic's text. */
  private signsIn(): number {
    return this.intro ? ss(INTRO.signs[0], INTRO.signs[1], performance.now() - this.lastBorn()) : 1;
  }

  /** What moves along the roads (flows, dependency arcs): once every topic's roads are in. */
  private allIn(): number {
    return this.intro ? ss(INTRO.road[1], INTRO.road[1] + 300, performance.now() - this.lastBorn()) : 1;
  }

  /** A topic's land came (shapes.ts): put in place; during the opening its part is rebuilt and it starts. */
  private landed(id: string, key: string): void {
    if (this.dead || this.asked.get(id) !== key) return;
    this.asked.delete(id);
    if (!this.layout.reshape?.(id)) return;
    const k = this.layout.world.findIndex((w) => w.id === id);
    if (this.intro && k >= 0) {
      this.parts.set(id, this.part(this.layout.world[k]!, k));
      this.base = this.assemble();
      if (!Number.isNaN(this.intro.t0)) this.start(id);
    } else this.base = this.buildBase();
    this.push();
    this.wake();
    this.ensureTick();
  }

  /** A topic starts its opening: now, but not before the scan's lead nor sooner than `stagger` after the one before. */
  private start(id: string): void {
    const I = this.intro!;
    if (I.born.has(id)) return;
    const b = Math.max(performance.now(), I.next);
    I.born.set(id, b);
    I.next = b + INTRO.stagger;
  }

  /** The opening is over: one set of layers again, laid out afresh (every land known: bounds and dots too). */
  private endIntro(): void {
    this.intro = null;
    this.applyData(this.data);
    this.scheduleLabels(0);
    this.home = this.fit(this.layout.bounds, { pitch: 50, bearing: -12, pad: { top: 110, bottom: 80, left: 70, right: 70 } });
  }

  private buildView(v: View): Entry[] {
    const T = this.theme;
    const regs = v.regs;
    const needN = new Map(regs.map((r) => [r.id, r.items.filter((i) => i.status === "needs_you").length]));
    const one = () => 1;
    const out: [Layer, (z: number) => number][] = [];
    // With topic blocks, a task's layers come in with its topic's inside (`scope`); the ground, the blocks' own and the
    // dependency arcs and far 等你 rings are seen from afar.
    let scope: (z: number) => number = one;
    const add = (o: (z: number) => number, ...ls: Layer[]) => {
      const sc = scope;
      // (A layer with nothing to draw is left out: a topic's own set has many.)
      for (const l of ls) if (!Array.isArray(l.props.data) || l.props.data.length) out.push([l, sc === one ? o : (z) => o(z) * sc(z)]);
    };
    const W = this.layout.world.length > 0;
    add(
      one,
      new LineLayer({ id: "ground", data: this.layout.grid, getSourcePosition: (d) => d.from, getTargetPosition: (d) => d.to, getColor: (d) => rgba(T.ground.col, d.a * (d.major ? T.ground.a[1] : T.ground.a[0])), getWidth: 1, widthUnits: "pixels", parameters: this.params as never }),
    );
    // Oblivion's radar on the ground and the chamfered frame around everything: faint, drawn once.
    const D = this.layout.deco;
    const DC = T.deco;
    const ground = (al: number) => (() => rgba(T.ground.col, al)) as never;
    if (!W) add(
      one,
      this.path("deco-ring", D.rings.map((path) => ({ path })), ground(DC.ring), 1),
      this.path("deco-dash", D.dashes.map((path) => ({ path })), ground(DC.dash), 1),
      this.path("deco-tick", D.ticks, ((d: { a: number }) => rgba(T.ground.col, DC.tick * d.a)) as never, 1),
      this.path("frame", [{ path: D.frame }], ground(DC.frame), 1.2),
      this.path("frame-tick", D.frameTicks.map((path) => ({ path })), ground(DC.frame), 1),
    );
    // `curve`: the shared field's lines, fainter still.
    if (this.layout.streams.length) add(one, this.path("stream", this.layout.streams.map((path) => ({ path })), ground(T.stream), 1));
    if (this.layout.blocks.length) {
      this.blockLayers(add, regs);
      scope = this.inside;
    }
    if (W) this.worldLayers(add, v);
    // Areas: a fill (it also catches clicks on the name's area) and a few outlines stacked into a glow — the big frame,
    // or (`plinth`) a capsule hugging the tree.
    const look = T.look;
    // With a base the names hang under it on plates: columns and glows of the row in front would run through them.
    const plate = look.plinth ? { background: true, getBackgroundColor: T.name.plate, backgroundPadding: [5, 2, 5, 2] } : {};
    const shape = (r: RegionLayout) => (look.plinth ? r.plinth : r.outline);
    const fillA = look.plinth ? T.plinth.fill : T.region.fill;
    if (!W) add(
      (z) => 1 - 0.5 * ss(12, 13, z),
      new PolygonLayer({ id: "region-fill", data: regs, getPolygon: (r: RegionLayout) => shape(r).map((p) => [p[0], p[1]]), getFillColor: (r: RegionLayout) => (needN.get(r.id) ? rgba(T.col.needs_you, fillA * 1.3) : rgba(this.regCol(r), fillA)), stroked: false, parameters: this.params as never }),
    );
    if (!W) (look.plinth ? T.plinth.lines : T.region.lines).forEach(([w, al], i) => add(one, this.path(`region-${i}`, regs.map((r) => ({ path: shape(r), r })), ((d: { r: RegionLayout }) => rgba(this.regCol(d.r), al)) as never, w)));
    if (!look.plinth && !W) add(one, this.path("region-in", regs.map((r) => ({ path: r.inner, r })), ((d: { r: RegionLayout }) => rgba(this.regCol(d.r), T.region.inner)) as never, 1));
    // `drafting`: a dimension line from start to goal under the base, small ticks along its far edge (no information).
    if (look.drafting) {
      const dA = T.plinth.drafting;
      add(
        one,
        this.path("draft-dim", regs.flatMap((r) => r.drafting.dim.map((path) => ({ path }))), (() => rgba(T.ground.col, dA)) as never, 1),
        this.path("draft-edge", regs.flatMap((r) => r.drafting.edge.map((path) => ({ path, r }))), ((d: { r: RegionLayout }) => rgba(this.regCol(d.r), dA * 1.3)) as never, 1),
      );
    }
    if (!W) add(
      one,
      this.path("region-ticks", regs.flatMap((r) => r.ticks.map((path) => ({ path, r }))), ((d: { r: RegionLayout }) => (needN.get(d.r.id) ? rgba(T.col.needs_you, 230) : rgba(this.regCol(d.r), T.region.ticks))) as never, 1.3),
    );
    // The tree, from afar: the trunk as far as the task came (on to the goal once 完成), dashes on to the goal.
    const laneCol = (r: RegionLayout) => (r.lane.status === "done" ? T.col.settled : r.lane.status === "parked" ? T.col.parked : T.col.working);
    if (look.track) {
      // `track`: the whole road as a band; the part walked filled and lit, its edges glowing, a tick across per round;
      // the rest only a faint outline on to the goal.
      const K = T.track;
      add(
        one,
        new PolygonLayer({ id: "band-fill", data: regs, getPolygon: (r: RegionLayout) => r.band.fill.map((p) => [p[0], p[1]]), getFillColor: (r: RegionLayout) => rgba(laneCol(r), K.fill), stroked: false, parameters: this.params as never }),
        ...K.edge.map(([w, al], i) => this.path(`band-edge-${i}`, regs.flatMap((r) => r.band.walked.map((path) => ({ path, r }))), ((d: { r: RegionLayout }) => rgba(laneCol(d.r), al)) as never, w)),
        this.path("band-ahead", regs.flatMap((r) => r.band.ahead.map((path) => ({ path }))), (() => rgba(T.col.working, K.ahead)) as never, 1),
        this.path("band-tick", regs.flatMap((r) => r.band.ticks.map((path) => ({ path, r }))), ((d: { r: RegionLayout }) => rgba(laneCol(d.r), K.tick)) as never, 1.2),
      );
    } else {
      // (World: its own roads, worldLayers.)
      if (!W) T.lane.lines.forEach(([w, al], i) => add(one, this.path(`trunk-${i}`, regs.map((r) => ({ path: r.walked, r })), ((d: { r: RegionLayout }) => rgba(laneCol(d.r), al)) as never, w)));
      add(one, this.path("ahead", regs.flatMap((r) => r.ahead.map((path) => ({ path }))), (() => rgba(T.col.working, T.lane.ahead[1])) as never, T.lane.ahead[0]));
    }
    // The start: a beam of light up from a ring on the ground, a diamond on top.
    const B = T.beacon;
    if (!W) add(
      one,
      new ScatterplotLayer({ id: "origin-ring", data: regs, getPosition: (r: RegionLayout) => r.origin.ground, getRadius: B.ring, radiusUnits: "meters", radiusMinPixels: 4, stroked: true, filled: false, getLineColor: rgba(T.col.hot, 150), lineWidthUnits: "pixels", getLineWidth: 1, parameters: this.params as never }),
      ...B.beam.map(([w, al], i) => new LineLayer({ id: `origin-beam-${i}`, data: regs, getSourcePosition: (r: RegionLayout) => r.origin.ground, getTargetPosition: (r: RegionLayout) => r.origin.top, getColor: rgba(T.col.hot, al), getWidth: w, widthUnits: "pixels", parameters: this.params as never })),
      new IconLayer({ id: "origin", data: regs, iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: () => "beacon", getPosition: (r: RegionLayout) => r.origin.top, getSize: B.px, sizeUnits: "pixels", getColor: rgba(T.col.hot, 255), billboard: true, pickable: true, parameters: this.params as never }),
    );
    // The goal: faint while the task is on its way, half lit at 待审阅 (waiting for you to accept it), lit once 完成.
    const G = T.goal;
    const goalCol = (r: RegionLayout) => (r.lane.goal.state === "reached" ? T.col.settled : T.col.working);
    const lit = regs.filter((r) => r.lane.goal.state !== "open");
    if (!W) add(
      one,
      new LineLayer({ id: "goal-stalk", data: regs, getSourcePosition: (r: RegionLayout) => r.goal.ground, getTargetPosition: (r: RegionLayout) => r.goal.at, getColor: (r: RegionLayout) => rgba(goalCol(r), G.alpha[r.lane.goal.state] * 0.35), getWidth: 1, widthUnits: "pixels", parameters: this.params as never }),
      new IconLayer({ id: "goal-halo", data: lit, iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: () => "glow", getPosition: (r: RegionLayout) => r.goal.at, getSize: G.px * 3, sizeUnits: "pixels", getColor: (r: RegionLayout) => rgba(goalCol(r), r.lane.goal.state === "reached" ? 70 : 34), billboard: true, parameters: this.params as never }),
      new IconLayer({ id: "goal", data: regs, iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: () => "goal", getPosition: (r: RegionLayout) => r.goal.at, getSize: G.px, sizeUnits: "pixels", getColor: (r: RegionLayout) => rgba(goalCol(r), G.alpha[r.lane.goal.state]), billboard: true, pickable: true, parameters: this.params as never }),
      new IconLayer({ id: "goal-fill", data: lit, iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: (r: RegionLayout) => (r.lane.goal.state === "reached" ? "goalfill" : "goalhalf"), getPosition: (r: RegionLayout) => r.goal.at, getSize: G.px, sizeUnits: "pixels", getColor: (r: RegionLayout) => rgba(goalCol(r), r.lane.goal.state === "reached" ? 220 : 170), billboard: true, parameters: this.params as never }),
    );
    // Dependencies: arcs from the goal of the task waited for to the start of the one waiting.
    const inScope = scope;
    scope = one;
    const A = T.arc;
    if (v.global && this.layout.arcs.length)
      A.lines.forEach(([w, al], i) =>
        add(
          one,
          new ArcLayer({ id: `arc-${i}`, data: this.layout.arcs, getSourcePosition: (a: Arc) => a.s, getTargetPosition: (a: Arc) => a.t, getSourceColor: rgba(T.col.working, al), getTargetColor: rgba(T.col.settled, al), getWidth: w, widthUnits: "pixels", getHeight: A.height, greatCircle: false, parameters: this.params as never }),
        ),
      );
    scope = inScope;
    // Branches, from the node that opened them; one that stopped is dim. Faint from afar: a task whose work went into
    // sessions it opened has a short trunk, and the branches show where it went (and where the lights run).
    const BR = T.branch;
    const brs = regs.flatMap((r) => r.branches.map((b) => ({ path: b.path, ended: b.ended, r })));
    const brO = W ? (z: number) => 0.45 + 0.55 * this.inside(z) : (z: number) => 0.3 + 0.7 * this.mid(z);
    const metro = this.layout.world[0]?.kind === "metro";
    const brCol = (ended: boolean, al: number, r?: RegionLayout) => rgba(ended ? T.col.parked : metro && r ? this.tint(r.tint) : T.col.working, al * (ended ? BR.ended : 1));
    if (look.track) {
      const bands = regs.flatMap((r) => r.band.branches);
      add(
        brO,
        new PolygonLayer({ id: "branch-fill", data: bands, getPolygon: (b: { fill: LngLatZ[] }) => b.fill.map((p) => [p[0], p[1]]), getFillColor: (b: { ended: boolean }) => brCol(b.ended, T.track.branchFill), stroked: false, parameters: this.params as never }),
        this.path("branch-edge", bands.flatMap((b) => b.edges.map((path) => ({ path, ended: b.ended }))), ((d: { ended: boolean }) => brCol(d.ended, 150)) as never, 1),
      );
    } else BR.lines.forEach(([w, al], i) => add(brO, this.path(`branch-${i}`, brs, ((d: { ended: boolean; r: RegionLayout }) => brCol(d.ended, al, d.r)) as never, metro ? w * 1.4 : w)));
    // `pillars`: a light column per round from the ground to its node, as tall as the work in it — from afar too, the
    // skyline is what shows where the work went. A branch's are lower; one that stopped is dim.
    const PL = T.pillar;
    if (look.pillars) {
      const pa = (n: Node) => (n.it.ended ? PL.ended : n.it.round === null ? PL.branch : 1) * (n.it.status === "parked" ? 0.6 : 1) * (this.folded.has(n.id) ? T.fold.pillar * Math.min(1, 8 / this.folded.get(n.id)!) : 1);
      add(
        one,
        ...PL.lines.map(([w, al], i) => new LineLayer({ id: `pillar-${i}`, data: v.nodes, getSourcePosition: (n: Node) => n.g, getTargetPosition: (n: Node) => n.p, getColor: (n: Node) => rgba(this.col(n.it.status), al * pa(n)), getWidth: w, widthUnits: "pixels", parameters: this.params as never })),
        new ScatterplotLayer({ id: "pillar-cap", data: v.nodes, getPosition: (n: Node) => n.p, getRadius: PL.cap / 2, radiusUnits: "pixels", billboard: true, getFillColor: (n: Node) => rgba(this.col(n.it.status), 230 * pa(n)), parameters: this.params as never }),
      );
    }
    // `front`: the node furthest on stands as a taller, brighter column with a glow on top (whatever it is doing), and
    // chevrons point on along the road to the goal — still and dimmer while the task is idle (those of a task that runs
    // are drawn each frame, animLayers).
    const FR = T.front;
    // The front's column top (in a world look the node itself stays on the road).
    const topOf = (n: Node) => n.r.nodes[n.id]!.top;
    if (look.front) {
      const still = regs.filter((r) => !this.runChev.some((c) => c.r === r)).flatMap((r) => r.chevrons.map((path) => ({ path, r })));
      add(
        one,
        ...FR.lines.map(([w, al], i) => new LineLayer({ id: `front-${i}`, data: v.fronts, getSourcePosition: (n: Node) => n.g, getTargetPosition: topOf, getColor: (n: Node) => rgba(this.col(n.it.status), al), getWidth: w, widthUnits: "pixels", parameters: this.params as never })),
        new IconLayer({ id: "front-glow", data: v.fronts, iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: () => "glow", getPosition: topOf, getSize: FR.glow, sizeUnits: "pixels", getColor: (n: Node) => rgba(this.col(n.it.status), 150), billboard: true, parameters: this.params as never }),
        ...FR.chev.map(([w, al], i) => this.path(`chev-${i}`, still, ((d: { r: RegionLayout }) => rgba(laneCol(d.r), (al * FR.idle) / 255)) as never, w)),
      );
    }
    // Nodes: a ring on the ground, a stalk, a glow, a dark disc (it keeps the hollow icon clickable) and the icon.
    const N = T.node;
    const nodes = v.nodes;
    const dim = (n: Node) => (n.it.ended ? BR.ended : n.it.status === "parked" ? 0.6 : 1);
    // World: the nodes come in with the topic's inside, flat on the road (no ring under them, no stalk).
    if (!W) add(
      this.mid,
      new ScatterplotLayer({ id: "node-shadow", data: nodes, getPosition: (n: Node) => n.g, getRadius: N.shadow[0], radiusUnits: "meters", radiusMinPixels: 3, stroked: true, filled: true, getFillColor: (n: Node) => rgba(this.col(n.it.status), N.shadow[1] * dim(n)), getLineColor: (n: Node) => rgba(this.col(n.it.status), N.shadow[2] * dim(n)), lineWidthUnits: "pixels", getLineWidth: 1, parameters: this.params as never }),
      ...(look.pillars ? [] : [new LineLayer({ id: "node-stalk", data: nodes, getSourcePosition: (n: Node) => n.g, getTargetPosition: (n: Node) => n.p, getColor: (n: Node) => rgba(this.col(n.it.status), N.stalk * dim(n)), getWidth: 1, widthUnits: "pixels", parameters: this.params as never })]),
    );
    add(
      W ? this.inside : this.mid,
      new IconLayer({ id: "node-halo", data: nodes, iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: () => "glow", getPosition: (n: Node) => n.p, getSize: N.size * N.halo[0], sizeUnits: "meters", sizeMinPixels: 12, sizeMaxPixels: 120, getColor: (n: Node) => rgba(this.col(n.it.status), N.halo[1] * dim(n)), billboard: true, parameters: this.params as never }),
      new ScatterplotLayer({ id: "node-back", data: nodes, getPosition: (n: Node) => n.p, getRadius: 64, radiusUnits: "meters", radiusMinPixels: 5, radiusMaxPixels: 15, billboard: true, getFillColor: N.back, pickable: true, parameters: this.flat as never }),
      new IconLayer({ id: "nodes", data: nodes, iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: (n: Node) => n.icon, getPosition: (n: Node) => n.p, getSize: N.size, sizeUnits: "meters", sizeMinPixels: N.min, sizeMaxPixels: N.max, getColor: (n: Node) => rgba(this.col(n.it.status), 255 * dim(n)), billboard: true, pickable: true, autoHighlight: true, highlightColor: rgba(T.col.hot, 90), parameters: this.params as never }),
    );
    // `fold`: a run folded shows 「×N 轮」 under the road and an axis-break mark across it instead of its rounds (from
    // afar; from 中 on they are all open). Clicking it opens it (and 「收起」 folds it again).
    const folds = regs.flatMap((r) => r.folds);
    const folded = this.folded;
    if (folds.length) {
      const FO = T.fold;
      add(
        (z) => 1 - this.mid(z),
        this.path("fold-brk", folds.flatMap((f) => f.brk.map((path) => ({ path }))), (() => rgba(T.col.hot, FO.brk)) as never, 1.4),
      );
      // World: 「×N 轮」 printed on the ground under the road, once the topic's inside is there.
      if (W)
        add(
          (z) => this.inside(z) * (1 - this.mid(z)),
          this.ground({ id: "fold-text", data: folds, getPosition: (f: Fold) => f.at, getText: (f: Fold) => (f.open ? `收起 ${f.ids.length} 轮` : `×${f.ids.length} 轮`), getSize: T.world.type.fold, getColor: (f: Fold) => rgba(T.col.working, f.open ? FO.text * 0.6 : FO.text), getTextAnchor: "middle", getAlignmentBaseline: "top", pickable: true }),
        );
      else add(
        (z) => 1 - this.mid(z),
        this.text({ id: "fold-text", data: folds, getPosition: (f: Fold) => f.at, getText: (f: Fold) => (f.open ? `收起 ${f.ids.length} 轮` : `×${f.ids.length} 轮`), getSize: FO.size, getColor: (f: Fold) => rgba(T.col.working, f.open ? FO.text * 0.6 : FO.text), getTextAnchor: "middle", getAlignmentBaseline: "top", getPixelOffset: [0, 4], background: true, getBackgroundColor: [20, 27, 34, 200], backgroundPadding: [4, 1, 4, 1], pickable: true }),
      );
    }
    // 第 N 轮 under the trunk's nodes (below their ring on the ground), where the goal stands, and when the task
    // started, once there is room.
    // World: 第 N 轮 and the goal's word printed on the ground under them, from a little in from the topic's inside.
    if (W) {
      const WT = T.world.type;
      add(
        (z) => ss(BLOCK_ZOOM + 0.25, BLOCK_ZOOM + 0.6, z),
        this.ground({ id: "round", data: nodes.filter((n) => n.it.round !== null && !folded.has(n.id)), getPosition: (n: Node) => south(n.g, 2.6), getText: (n: Node) => `第 ${n.it.round} 轮`, getSize: WT.round, getColor: (n: Node) => rgba(this.col(n.it.status), 175), getTextAnchor: "middle", getAlignmentBaseline: "top" }),
        this.ground({ id: "goal-text", data: regs, getPosition: (r: RegionLayout) => south(r.goal.ground, 4.8), getText: goalText, getSize: WT.round, getColor: (r: RegionLayout) => rgba(goalCol(r), Math.max(150, G.alpha[r.lane.goal.state])), getTextAnchor: "middle", getAlignmentBaseline: "top" }),
      );
    } else add(
      this.roundText,
      this.text({ id: "round", data: nodes.filter((n) => n.it.round !== null && !folded.has(n.id)), getPosition: (n: Node) => n.g, getText: (n: Node) => `第 ${n.it.round} 轮`, getSize: T.roundSize, getColor: (n: Node) => rgba(this.col(n.it.status), 175), getTextAnchor: "middle", getAlignmentBaseline: "top", getPixelOffset: [0, 11] }),
      this.text({ id: "goal-text", data: regs, getPosition: (r: RegionLayout) => r.goal.at, getText: goalText, getSize: T.roundSize, getColor: (r: RegionLayout) => rgba(goalCol(r), Math.max(150, G.alpha[r.lane.goal.state])), getTextAnchor: "middle", getAlignmentBaseline: "top", getPixelOffset: [0, G.px / 2 + 5] }),
      ...(look.drafting
        ? [
            this.text({ id: "draft-dim-text", data: regs, getPosition: (r: RegionLayout) => r.drafting.dimAt, getText: dimText, getSize: T.roundSize - 1, getColor: rgba(T.ground.col, T.plinth.drafting * 1.6), getTextAnchor: "middle", getAlignmentBaseline: "center", background: true, getBackgroundColor: [20, 27, 34, 230], backgroundPadding: [5, 1, 5, 1] }),
            // The coordinate as a third line under the name (at the base's corner it ran into long names).
            this.text({ id: "draft-coord", data: regs, getPosition: (r: RegionLayout) => r.name, getText: (r: RegionLayout) => `T${String(r.idx + 1).padStart(2, "0")}  X${sign(r.drafting.coord[0])}  Y${sign(r.drafting.coord[1])}`, getSize: 8.5, getColor: rgba(T.ground.col, T.plinth.drafting * 1.4), getTextAnchor: (r: RegionLayout) => r.nameAlign, getAlignmentBaseline: "top", getPixelOffset: (r: RegionLayout) => [0, r.nameBelow ? T.name.size * 1.35 + T.subSize * 1.5 + 5 : 4], ...plate }),
          ]
        : []),
      this.text({ id: "origin-text", data: W ? [] : regs, getPosition: (r: RegionLayout) => r.origin.ground, getText: (r: RegionLayout) => `起点 · ${shortTime(r.lane.startAt, this.data.now)}`, getSize: T.roundSize, getColor: rgba(T.col.hot, 150), getTextAnchor: "middle", getAlignmentBaseline: "top", getPixelOffset: [0, 13] }),
    );
    // Area names above their far edge (with a base: under its near edge, on a plate; an arm's past its outer end), and
    // with each a line: how it stands, its board column, how many sessions.
    const nameText = (r: RegionLayout) => (T.name.spaced && !W ? [...r.lane.short].join(" ") : r.lane.short);
    const sub = (r: RegionLayout) => {
      const n = needN.get(r.id) ?? 0;
      return `${n ? `! ${n} 件等你` : (LANE_TEXT[r.lane.status] ?? "")} · ${COLUMN[r.lane.column] ?? ""} · ${r.items.length} 个会话`;
    };
    // World: a lane's name small, just above its start (with the topic's inside).
    if (W) {
      add(
        this.inside,
        this.ground({ id: "region-name", data: regs, getPosition: (r: RegionLayout) => r.name, getText: nameText, getSize: T.world.type.lane, getColor: (r: RegionLayout) => (needN.get(r.id) ? rgba(T.col.needs_you, 230) : rgba(this.regCol(r), 160)), getTextAnchor: "start", getAlignmentBaseline: "bottom", pickable: true }),
      );
    } else add(
      one,
      this.text({ id: "region-name", data: regs, getPosition: (r: RegionLayout) => r.name, getText: nameText, getSize: T.name.size, fontWeight: T.name.weight, getColor: (r: RegionLayout) => rgba(this.regCol(r), T.name.alpha), getTextAnchor: (r: RegionLayout) => r.nameAlign, getAlignmentBaseline: (r: RegionLayout) => (r.nameBelow ? "top" : "bottom"), getPixelOffset: (r: RegionLayout) => [0, r.nameBelow ? 0 : -(T.subSize * 1.5 + 2)], pickable: true, ...plate }),
    );
    if (!W) add(
      (z) => ss(this.home.zoom - 1.0, this.home.zoom - 0.6, z),
      this.text({ id: "region-sub", data: regs, getPosition: (r: RegionLayout) => r.name, getText: sub, getSize: T.subSize, getColor: (r: RegionLayout) => (needN.get(r.id) ? rgba(T.col.needs_you, 255) : rgba(this.regCol(r), 200)), getTextAnchor: (r: RegionLayout) => r.nameAlign, getAlignmentBaseline: (r: RegionLayout) => (r.nameBelow ? "top" : "bottom"), getPixelOffset: (r: RegionLayout) => [0, r.nameBelow ? T.name.size * 1.35 + 2 : 0], pickable: true, ...plate }),
    );
    // 等你 from afar: a pulsing ring of fixed size on screen (it fades as the brackets take over closer in).
    scope = one;
    add(
      (z) => 1 - 0.75 * this.mid(z),
      new IconLayer({ id: "alert-far", data: v.global ? this.needFar : [], iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: () => "ring", getPosition: (n: { p: LngLatZ }) => n.p, getSize: T.alert.farPx, sizeUnits: "pixels", getColor: rgba(T.col.needs_you, 255), billboard: true, pickable: true, parameters: this.params as never }),
    );
    scope = inScope;
    if (!W) add(one, this.path("region-alert", regs.filter((r) => needN.get(r.id)).map((r) => ({ path: shape(r) })), (() => rgba(T.col.needs_you, 255)) as never, 2.2));
    return out.flatMap(([layer, o]): Entry[] => {
      const tw = this.twins.get(layer);
      if (!tw) return [{ layer, o, lastO: -1, shown: null }];
      // The hand-over is a stretch of zoom, not a point: the SDF text comes in over the bitmap one (drawn after it), which
      // goes only once the SDF one is whole — no swap on one frame, no flicker when the zoom rests on the line.
      const px = (z: number) => tw.size * unitPx(z);
      const [a, b] = SDF.over;
      return [
        { layer, o: (z) => (px(z) >= b ? 0 : o(z)), lastO: -1, shown: null },
        {
          layer: tw.sdf,
          o: (z) => o(z) * ss(a, b, px(z)),
          lastO: -1,
          shown: null,
          // The edge's softness follows the size on the screen: a uniform of the characters sublayer (deck.gl's
          // fontSettings would lay every glyph out again on each step).
          p: (z) => {
            const sm = sdfSmoothing(px(z));
            return { k: sm, props: { _subLayerProps: { characters: { smoothing: sm } } } };
          },
        },
      ];
    });
  }

  /**
   * `blocks` (0.3): from afar each topic's outline and header (name; goal, its projects' first fields, what waits and
   * whether it moves) and its tasks as thin lines; inside, its projects' bands with their status boards, the spine of its
   * own sessions with lines to the tasks they proposed, the shelf of documents and the board of points, and the points
   * of rounds by their columns (their text once the rounds are in).
   */
  private blockLayers(add: (o: (z: number) => number, ...ls: Layer[]) => void, regs: RegionLayout[]): void {
    const T = this.theme;
    const K = T.block;
    const BL = this.layout.blocks;
    const now = this.data.now;
    const par = this.params as never;
    const blockCol = (b: BlockLayout) => (b.topic.status === "done" ? T.col.settled : T.col.working);
    const plate = { background: true, getBackgroundColor: K.plate, backgroundPadding: [7, 5, 7, 5], getBorderWidth: 1 };
    const out = (z: number) => 1 - this.inside(z);
    add(
      () => 1,
      new PolygonLayer({ id: "block-fill", data: BL, getPolygon: (b: BlockLayout) => b.outline.map((p) => [p[0], p[1]]), getFillColor: (b: BlockLayout) => rgba(blockCol(b), K.fill), stroked: false, pickable: true, parameters: par }),
      this.path("block-line", BL.map((b) => ({ path: b.outline, b })), ((d: { b: BlockLayout }) => rgba(blockCol(d.b), K.line)) as never, 1.2),
      this.text({ id: "block-name", data: BL, getPosition: (b: BlockLayout) => b.head, getText: (b: BlockLayout) => (T.name.spaced ? [...b.topic.title].join(" ") : b.topic.title), getSize: K.head, fontWeight: T.name.weight, getColor: (b: BlockLayout) => rgba(blockCol(b), 245), getTextAnchor: "start", getAlignmentBaseline: "bottom", getPixelOffset: (b: BlockLayout) => [0, -(this.headText(b).split("\n").length * K.info * 1.3 + 6)], pickable: true }),
      this.text({ id: "block-info", data: BL, getPosition: (b: BlockLayout) => b.head, getText: (b: BlockLayout) => this.headText(b), getSize: K.info, lineHeight: 1.3, getColor: (b: BlockLayout) => (this.blockNeed(b) ? rgba(T.col.needs_you, 235) : rgba(T.col.working, 195)), getTextAnchor: "start", getAlignmentBaseline: "bottom", pickable: true }),
    );
    // From afar a task is a thin line: as far as it came, on to its goal.
    add(
      out,
      this.path("mini", regs.map((r) => ({ path: r.walked, r })), ((d: { r: RegionLayout }) => rgba(this.regCol(d.r), 215)) as never, 1.6),
      new LineLayer({ id: "mini-ahead", data: regs.filter((r) => r.lane.goal.state !== "reached"), getSourcePosition: (r: RegionLayout) => r.walked[r.walked.length - 1]!, getTargetPosition: (r: RegionLayout) => r.goal.ground, getColor: rgba(T.col.working, 80), getWidth: 1, widthUnits: "pixels", parameters: par }),
      new ScatterplotLayer({ id: "mini-goal", data: regs, getPosition: (r: RegionLayout) => r.goal.ground, getRadius: 2.4, radiusUnits: "pixels", getFillColor: (r: RegionLayout) => (r.lane.goal.state === "reached" ? rgba(T.col.settled, 255) : rgba(T.col.working, 130)), parameters: par }),
    );
    const bands = BL.flatMap((b) => b.bands);
    const docs = BL.flatMap((b) => b.shelf.docs);
    const cards = BL.flatMap((b) => b.board.cards).flatMap((c) => {
      const it = this.itemById.get(c.id);
      return it ? [{ id: c.id, at: c.at, it }] : [];
    });
    const spine = BL.flatMap((b) => b.spine.nodes).flatMap((n) => {
      const it = this.itemById.get(n.id);
      return it ? [{ id: n.id, at: n.at, it }] : [];
    });
    // From afar too: a band per project and the spine show how the topic is made.
    add(
      () => 1,
      new PolygonLayer({ id: "band-bg", data: bands, getPolygon: (x: { fill: LngLatZ[] }) => x.fill.map((p) => [p[0], p[1]]), getFillColor: rgba(T.col.working, K.band), stroked: false, parameters: par }),
      ...K.spine.map(([w, al], i) => this.path(`spine-${i}`, BL.map((b) => ({ path: b.spine.path })), (() => rgba(T.col.hot, al)) as never, w)),
    );
    const cardCol = (it: PanoramaItem) => (it.status === "needs_you" ? T.col.needs_you : it.type === "session" ? T.col.working : K.card[it.type]);
    add(
      this.inside,
      this.path("proposed", BL.flatMap((b) => b.proposed), (() => rgba(T.col.working, 120)) as never, 1),
      new ScatterplotLayer({ id: "spine-node", data: spine, getPosition: (d: { at: LngLatZ }) => d.at, getRadius: K.node / 2, radiusUnits: "pixels", stroked: true, getFillColor: (d: { it: PanoramaItem }) => rgba(this.col(d.it.status), 230), getLineColor: rgba(T.col.hot, 200), lineWidthUnits: "pixels", getLineWidth: 1, pickable: true, parameters: par }),
      this.text({ id: "spine-label", data: BL, getPosition: (b: BlockLayout) => b.spine.label, getText: (b: BlockLayout) => (b.spine.nodes.length ? `主控 · ${b.spine.nodes.length} 轮` : "主控 · 还没有"), getSize: K.text, getColor: rgba(T.col.hot, 210), getTextAnchor: "middle", getAlignmentBaseline: "bottom", getPixelOffset: [0, -4] }),
      this.text({ id: "status-board", data: bands, getPosition: (x: { board: LngLatZ }) => x.board, getText: (x: { project: PanoramaProject }) => boardText(x.project, now), getSize: K.text, lineHeight: 1.35, getColor: rgba(T.col.working, 230), getTextAnchor: "start", getAlignmentBaseline: "top", ...plate, getBorderColor: rgba(T.col.working, 80) }),
      this.text({ id: "shelf-label", data: BL, getPosition: (b: BlockLayout) => b.shelf.label, getText: (b: BlockLayout) => `资料架 · ${b.shelf.docs.length} 份`, getSize: K.text, getColor: rgba(T.col.working, 200), getTextAnchor: "start", getAlignmentBaseline: "top" }),
      this.text({ id: "doc", data: docs, getPosition: (d: { at: LngLatZ }) => d.at, getText: (d: { doc: PanoramaDoc }) => docText(d.doc, now), getSize: K.text, lineHeight: 1.3, getColor: (d: { doc: PanoramaDoc }) => rgba(d.doc.kind === "spec" ? T.col.settled : T.col.working, 235), getTextAnchor: "start", getAlignmentBaseline: "top", ...plate, getBorderColor: (d: { doc: PanoramaDoc }) => rgba(d.doc.kind === "spec" ? T.col.settled : T.col.working, 110), pickable: true }),
      this.path("board-area", BL.map((b) => ({ path: b.board.area })), (() => rgba(T.col.working, 60)) as never, 1),
      this.text({ id: "board-label", data: BL, getPosition: (b: BlockLayout) => b.board.label, getText: (b: BlockLayout) => `公告板 · ${b.board.cards.length} 条`, getSize: K.text, getColor: rgba(T.col.working, 200), getTextAnchor: "start", getAlignmentBaseline: "top" }),
      this.text({ id: "board-card", data: cards, getPosition: (c: { at: LngLatZ }) => c.at, getText: (c: { it: PanoramaItem }) => cardText(c.it), getSize: K.text, lineHeight: 1.3, getColor: (c: { it: PanoramaItem }) => rgba(cardCol(c.it), 240), getTextAnchor: "start", getAlignmentBaseline: "top", ...plate, getBorderColor: (c: { it: PanoramaItem }) => rgba(cardCol(c.it), 130), pickable: true }),
      new ScatterplotLayer({ id: "round-mark", data: this.roundCards, getPosition: (c: { p: LngLatZ }) => c.p, getRadius: 3.2, radiusUnits: "pixels", getFillColor: (c: { it: PanoramaItem }) => rgba(cardCol(c.it), 240), billboard: true, pickable: true, parameters: par }),
    );
    add(
      (z) => this.inside(z) * this.roundText(z),
      this.text({ id: "round-card", data: this.roundCards, getPosition: (c: { p: LngLatZ }) => c.p, getText: (c: { it: PanoramaItem }) => `${c.it.status === "needs_you" ? "! " : ""}${ITEM_LABEL[c.it.type]} · ${cut(c.it.title, 12)}`, getSize: K.text, getColor: (c: { it: PanoramaItem }) => rgba(cardCol(c.it), 240), getTextAnchor: "start", getAlignmentBaseline: "center", getPixelOffset: [8, 0], ...plate, backgroundPadding: [5, 2, 5, 2], getBorderColor: (c: { it: PanoramaItem }) => rgba(cardCol(c.it), 120), pickable: true }),
    );
  }

  private tint(k: number): RGB {
    const ts = this.theme.world.tints;
    return ts[((k % ts.length) + ts.length) % ts.length]!;
  }

  /**
   * World (11-03): the topics as regions. Always: the ground (island or metro zone, its parts and divides), the header,
   * the spine, the status boards, shelf and board as blank plates, the roads with their start tick (`metro`: from their
   * station), the front's bright dot, the goal's dashed ring. With the topic's inside: the text on the plates, the books,
   * the lines to the boards, sub-lane forks and merges.
   */
  private worldLayers(add: (o: (z: number) => number, ...ls: Layer[]) => void, v: View): void {
    const regs = v.regs;
    const T = this.theme;
    const WT = T.world;
    const WL = v.world;
    const par = this.params as never;
    const flat = this.flat as never;
    const metro = this.layout.world[0]!.kind === "metro";
    const one = () => 1;
    const ice = T.col.hot;
    const now = this.data.now;
    const zoneCol = (tint: number, k: number) => (tint < 0 ? rgba([230, 240, 248], metro ? WT.metro.common : WT.terrain.common) : rgba(this.tint(tint), (metro ? WT.metro.zone : WT.terrain.zone)[k % 2]!));
    const zones = WL.flatMap((w) => w.zones.flatMap((z) => z.rings.map((ring) => ({ ring, tint: z.tint }))));
    const coasts = WL.flatMap((w) => w.coast.map((path) => ({ path, w })));
    if (metro && v.global) add(one, new ScatterplotLayer({ id: "world-dots", data: this.layout.dots, getPosition: (p: LngLatZ) => p, getRadius: WT.metro.dots[1] / 2, radiusUnits: "pixels", getFillColor: rgba(T.ground.col, WT.metro.dots[0]), parameters: par }));
    add(
      one,
      new PolygonLayer({ id: "world-fill", data: WL.flatMap((w) => w.coast.map((ring) => ({ ring, w, ...w }))), getPolygon: (d: { ring: LngLatZ[] }) => d.ring.map((p) => [p[0], p[1]]), getFillColor: rgba(ice, metro ? 1 : WT.terrain.fill), stroked: false, pickable: true, parameters: par }),
      new PolygonLayer({ id: "world-zone", data: zones, getPolygon: (d: { ring: LngLatZ[] }) => d.ring.map((p) => [p[0], p[1]]), getFillColor: (d: { tint: number }) => zoneCol(d.tint, Math.max(0, d.tint)), stroked: false, parameters: par }),
    );
    if (!metro) {
      // The glow in from the coast: rings at growing depth, fainter the deeper.
      const insets = WL.flatMap((w) => w.insets.flatMap((s, k) => s.rings.map((path) => ({ path, k, n: w.insets.length }))));
      // As wide on the ground as they are apart, so they overlap into one soft band at any zoom.
      add(one, this.path("world-inset", insets, ((d: { k: number; n: number }) => rgba(ice, WT.terrain.inset * (1 - d.k / d.n) ** 1.4)) as never, 1, { widthUnits: "meters", getWidth: 190, widthMinPixels: 2 }));
    }
    add(one, this.path("world-border", WL.flatMap((w) => w.borders.map((path) => ({ path }))), (() => rgba(ice, metro ? WT.metro.cut : WT.terrain.border)) as never, metro ? 0.9 : 0.8, { capRounded: false }));
    (metro ? WT.metro.coast : WT.terrain.coast).forEach(([w, al], i) => add(one, this.path(`world-coast-${i}`, coasts, (() => rgba(ice, al)) as never, w, { jointRounded: !metro })));
    // The header: the topic's name, a line of counts (what waits in gold).
    const waitsText = (w: WorldTopic) => (w.waits ? ` · ${w.waits} 等你` : "");
    const TY = WT.type;
    const infoAt = (w: WorldTopic) => south(w.head, TY.title * 1.18 + 2);
    add(legible(TY.title), this.ground({ id: "world-title", data: WL, getPosition: (w: WorldTopic) => w.head, getText: (w: WorldTopic) => w.topic.title, getSize: TY.title, getColor: rgba(ice, 250), getTextAnchor: "start", getAlignmentBaseline: "top", pickable: true }));
    add(
      legible(TY.info, 8),
      this.ground({ id: "world-info", data: WL, getPosition: infoAt, getText: (w: WorldTopic) => w.summary, getSize: TY.info, getColor: rgba(T.col.working, 175), getTextAnchor: "start", getAlignmentBaseline: "top", pickable: true }),
      this.ground({ id: "world-info-need", data: WL.filter((w) => w.waits), getPosition: (w: WorldTopic) => south(infoAt(w), 0, this.advance(w.summary, TY.info)), getText: waitsText, getSize: TY.info, getColor: rgba(T.col.needs_you, 255), getTextAnchor: "start", getAlignmentBaseline: "top" }),
    );
    // The spine; the plates (blank from afar).
    const cards = WL.flatMap((w) => w.cards);
    const plates = [...cards.map((c) => ({ path: c.rect })), ...WL.map((w) => ({ path: w.board.rect }))];
    add(
      one,
      ...T.block.spine.map(([w, al], i) => this.path(`world-spine-${i}`, WL.map((x) => ({ path: x.spine.path })), (() => rgba(ice, al * 0.75)) as never, w * 0.7)),
      new PolygonLayer({ id: "world-plate", data: plates, getPolygon: (d: { path: LngLatZ[] }) => d.path.map((p) => [p[0], p[1]]), getFillColor: rgba([175, 200, 220], 18), stroked: false, parameters: par }),
      this.path("world-plate-line", plates, (() => rgba(ice, 78)) as never, 0.8, { jointRounded: false }),
      this.path("world-shelf-line", WL.map((w) => ({ path: w.shelf.rect })), (() => rgba(ice, 26)) as never, 0.8, { jointRounded: false }),
      // A project with something waiting: a gold edge on its board.
      this.path("world-card-need", cards.filter((c) => c.waits).map((c) => ({ path: [c.rect[0]!, c.rect[3]!] })), (() => rgba(T.col.needs_you, 255)) as never, 2.5, { capRounded: false }),
    );
    const spine = WL.flatMap((w) => w.spine.nodes).flatMap((n) => {
      const it = this.itemById.get(n.id);
      return it ? [{ id: n.id, at: n.at, it }] : [];
    });
    const books = WL.flatMap((w) => w.shelf.books);
    const boardLines = WL.flatMap((w) => w.board.lines).flatMap((c) => {
      const it = this.itemById.get(c.id);
      return it ? [{ id: c.id, at: c.at, it, w: WL.find((x) => x.board.lines.includes(c))!.board.w }] : [];
    });
    const cardCol = (it: PanoramaItem) => (it.status === "needs_you" ? T.col.needs_you : it.type === "session" ? T.col.working : T.block.card[it.type as "decision"]);
    const bookCol = (d: { doc: PanoramaDoc }) => (d.doc.kind === "spec" ? T.col.settled : T.col.working);
    const bookH = (d: { rect: LngLatZ[] }) => (d.rect[0]![1] - d.rect[3]![1]) / U;

    add(
      one,
      new PolygonLayer({ id: "world-book", data: books, getPolygon: (d: { rect: LngLatZ[] }) => d.rect.map((p) => [p[0], p[1]]), getFillColor: (d: { doc: PanoramaDoc }) => rgba(bookCol(d), 30), stroked: false, pickable: true, parameters: par }),
      this.path("world-book-line", books.map((b) => ({ path: b.rect, doc: b.doc })), ((d: { doc: PanoramaDoc }) => rgba(bookCol(d), 95)) as never, 0.8, { jointRounded: false }),
    );
    add(
      this.inside,
      this.path("world-card-link", cards.map((c) => ({ path: c.link })), (() => rgba(ice, 60)) as never, 0.8),
      new ScatterplotLayer({ id: "spine-node", data: spine, getPosition: (d: { at: LngLatZ }) => d.at, getRadius: 3.6, radiusUnits: "pixels", stroked: true, getFillColor: (d: { it: PanoramaItem }) => (d.it.status === "needs_you" ? rgba(T.col.needs_you, 240) : [26, 36, 46, 255]), getLineColor: (d: { it: PanoramaItem }) => rgba(d.it.status === "needs_you" ? T.col.needs_you : ice, 210), lineWidthUnits: "pixels", getLineWidth: 1, pickable: true, parameters: flat }),
      // Printed on the plates and beside them, on the ground.
      this.ground({ id: "world-spine-label", data: WL, getPosition: (w: WorldTopic) => w.spine.label, getText: (w: WorldTopic) => (w.spine.nodes.length ? `主控 · ${w.spine.nodes.length} 轮` : "主控"), getSize: TY.label, getColor: rgba(ice, 160), getTextAnchor: "start", getAlignmentBaseline: "bottom" }),
      this.ground({ id: "world-card-text", data: cards, getPosition: (c: { at: LngLatZ }) => c.at, getText: (c: WorldTopic["cards"][number]) => worldCardText(c.project, c.w, TY.text, now), getSize: TY.text, lineHeight: 1.3, getColor: rgba(T.col.working, 230), getTextAnchor: "start", getAlignmentBaseline: "top" }),
      this.ground({ id: "world-shelf-label", data: WL, getPosition: (w: WorldTopic) => w.shelf.label, getText: (w: WorldTopic) => (w.shelf.books.length ? `规范 · 文档  ${w.shelf.books.length}` : "规范 · 文档  还没有"), getSize: TY.label, getColor: rgba(ice, 140), getTextAnchor: "start", getAlignmentBaseline: "bottom" }),
      this.ground({ id: "world-book-title", data: books, getPosition: (d: { at: LngLatZ }) => d.at, getText: (d: { doc: PanoramaDoc; rect: LngLatZ[] }) => cut(d.doc.title, Math.max(2, Math.floor((bookH(d) - 2) / TY.label))), getSize: TY.label, getAngle: -90, getColor: (d: { doc: PanoramaDoc }) => rgba(bookCol(d), 230), getTextAnchor: "start", getAlignmentBaseline: "center" }),
      this.ground({ id: "world-board-label", data: WL, getPosition: (w: WorldTopic) => w.board.label, getText: (w: WorldTopic) => (w.board.lines.length ? `公告板 · ${w.board.lines.length + w.board.more} 条${w.board.more ? `（前 ${w.board.lines.length} 条）` : ""}` : "公告板 · 还没有"), getSize: TY.label, getColor: rgba(ice, 140), getTextAnchor: "start", getAlignmentBaseline: "bottom" }),
      this.ground({ id: "world-board-line", data: boardLines, getPosition: (c: { at: LngLatZ }) => c.at, getText: (c: { it: PanoramaItem; w: number }) => fitText(`${c.it.status === "needs_you" ? "! " : ""}${ITEM_LABEL[c.it.type]} · ${c.it.title}`, c.w, TY.text * 0.92), getSize: TY.text * 0.92, getColor: (c: { it: PanoramaItem }) => rgba(cardCol(c.it), 240), getTextAnchor: "start", getAlignmentBaseline: "top", pickable: true }),
    );
    // The roads: straight, from a tick at the start (`metro`: out of the project's station, in its colour, thicker).
    const laneCol = (r: RegionLayout) => (metro ? this.tint(r.tint) : r.lane.status === "done" ? T.col.settled : r.lane.status === "parked" ? T.col.parked : T.col.working);
    const roads = regs.map((r) => ({ path: metro ? [...r.pre.slice(0, -1), ...r.walked] : r.walked, r }));
    (metro ? WT.metro.lane : WT.lane).forEach(([w, al], i) => add(one, this.path(`world-road-${i}`, roads, ((d: { r: RegionLayout }) => rgba(laneCol(d.r), al * (d.r.lane.status === "parked" ? 0.6 : 1))) as never, w)));
    const hubs = metro ? WL.flatMap((w) => w.cards.filter((c) => c.hub).map((c) => ({ p: c.hub!, tint: c.tint }))) : [];
    if (metro) add(one, new ScatterplotLayer({ id: "world-hub", data: hubs, getPosition: (d: { p: LngLatZ }) => d.p, getRadius: 4.2, radiusUnits: "pixels", stroked: true, getFillColor: [26, 36, 46, 255], getLineColor: rgba(ice, 240), lineWidthUnits: "pixels", getLineWidth: 1.8, parameters: flat }));
    else add(one, this.path("world-tick", regs.map((r) => ({ path: r.tick })), (() => rgba(ice, WT.tick)) as never, 1.5, { capRounded: false }));
    // The goal: a dashed ring on the way, half filled at 待审阅, filled once reached.
    const open = regs.filter((r) => r.lane.goal.state !== "reached");
    const reached = regs.filter((r) => r.lane.goal.state === "reached");
    add(
      one,
      this.path("world-goal", open.flatMap((r) => r.goalRing.map((path) => ({ path, r }))), ((d: { r: RegionLayout }) => rgba(ice, d.r.lane.goal.state === "review" ? 200 : 105)) as never, 1, { capRounded: false }),
      new IconLayer({ id: "world-goal-half", data: open.filter((r) => r.lane.goal.state === "review"), iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: () => "goalhalf", getPosition: (r: RegionLayout) => r.goal.at, getSize: 11, sizeUnits: "pixels", getColor: rgba(ice, 200), billboard: true, parameters: par }),
      new ScatterplotLayer({ id: "world-goal-done", data: reached, getPosition: (r: RegionLayout) => r.goal.at, getRadius: 4, radiusUnits: "pixels", stroked: true, getFillColor: rgba(T.col.settled, 240), getLineColor: rgba(T.col.settled, 140), lineWidthUnits: "pixels", getLineWidth: 1, parameters: par }),
    );
    // Where a sub-lane forks and merges: a ring on the trunk's node.
    const forks = regs.flatMap((r) => r.branches.flatMap((b) => [b.from, b.merge].filter((id): id is string => !!id && !!r.nodes[id]).map((id) => ({ p: r.nodes[id]!.at }))));
    add(this.inside, new ScatterplotLayer({ id: "world-fork", data: forks, getPosition: (d: { p: LngLatZ }) => d.p, getRadius: 5.2, radiusUnits: "pixels", stroked: true, filled: false, getLineColor: rgba(ice, 150), lineWidthUnits: "pixels", getLineWidth: 1, parameters: par }));
    // The front: a bright dot on the road (its column rises over it, buildBase), dim while the task is still.
    const fronts = regs.filter((r) => r.front).map((r) => ({ p: r.nodes[r.front!]!.at, run: r.lane.status === "running", need: r.items.find((i) => i.id === r.front)?.status === "needs_you" }));
    add(
      one,
      new IconLayer({ id: "world-front-glow", data: fronts.filter((f) => !f.need), iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: () => "glow", getPosition: (d: { p: LngLatZ }) => d.p, getSize: WT.front * 3.2, sizeUnits: "pixels", getColor: (d: { run: boolean }) => rgba(ice, d.run ? 190 : 90), billboard: true, parameters: par }),
      new ScatterplotLayer({ id: "world-front", data: fronts.filter((f) => !f.need), getPosition: (d: { p: LngLatZ }) => d.p, getRadius: WT.front / 2, radiusUnits: "pixels", getFillColor: (d: { run: boolean }) => rgba(ice, d.run ? 250 : 200), parameters: par }),
    );
  }

  /** A block's header under its name: its goal, its projects' first fields, what waits and whether it moves. */
  private headText(b: BlockLayout): string {
    const projects = this.data.projects.filter((p) => p.topic === b.id);
    const lanes = this.data.lanes.filter((l) => l.topic === b.id);
    const n = this.blockNeed(b);
    // As wide as the block where every topic is in view, so a header never runs into the next block's.
    const px = ((b.bounds[2] - b.bounds[0]) * 512 * 2 ** this.home.zoom) / 360;
    const fit = (s: string) => fitText(s, px, this.theme.block.info);
    // A line per project: its name, then its first two fields (one off its mark says so).
    const rows = projects.slice(0, 3).map((p) => fit(`▣ ${p.title}   ${p.status.slice(0, 2).map((f) => `${f.label} ${f.value}${f.tone === "warn" || f.tone === "bad" ? " !" : ""}`).join("  ·  ")}`));
    if (projects.length > 3) rows.push(`另 ${projects.length - 3} 个项目`);
    const moving = b.topic.status === "running" ? "◐ 在动" : b.topic.status === "done" ? "✓ 完成" : "○ 停着";
    return [b.topic.goal ? fit(`目标：${b.topic.goal}`) : "", ...rows, fit(`${n ? `! ${n} 件等你` : "没有等你的事"}  ·  ${moving}  ·  ${lanes.length} 个任务`)].filter(Boolean).join("\n");
  }

  private blockNeed(b: BlockLayout): number {
    return this.data.items.filter((i) => i.topic === b.id && i.status === "needs_you").length;
  }

  /**
   * The opening (INTRO), drawn each frame while it plays: the scan line and the grid it leaves (fading), each topic's
   * breathing frame until it starts, then its coast drawn round by a pen, then its roads growing from their starts with
   * their nodes lighting as the road reaches them. The layers of the finished map come in under these (`reveal`).
   */
  private introLayers(): Layer[] {
    const I = this.intro!;
    if (Number.isNaN(I.t0)) return [];
    const T = this.theme;
    const ice = T.col.hot;
    const now = performance.now();
    const par = this.params as never;
    const out: Layer[] = [];
    const [W, S, E, N] = this.layout.bounds;
    const since = now - I.t0;
    const sx = W + (E - W) * this.scanned();
    // The grid the scan leaves behind, gone soon after it.
    const gridA = 1 - ss(INTRO.scan, INTRO.scan + 700, since);
    if (gridA > 0.01) {
      const st = 40 * U;
      const lines: { a: LngLatZ; b: LngLatZ }[] = [];
      for (let x = Math.ceil(W / st) * st; x < sx; x += st) lines.push({ a: [x, S, 0], b: [x, N, 0] });
      for (let y = Math.ceil(S / st) * st; y < N; y += st) lines.push({ a: [W, y, 0], b: [sx, y, 0] });
      out.push(new LineLayer({ id: "intro-grid", data: lines, getSourcePosition: (d: { a: LngLatZ }) => d.a, getTargetPosition: (d: { b: LngLatZ }) => d.b, getColor: rgba(T.ground.col, 34 * gridA), getWidth: 1, widthUnits: "pixels", parameters: par }));
    }
    if (since < INTRO.scan)
      out.push(
        ...([
          [9, 34],
          [1.6, 210],
        ] as const).map(([w, al], i) => new LineLayer({ id: `intro-scan-${i}`, data: [0], getSourcePosition: () => [sx, S, 0], getTargetPosition: () => [sx, N, 0], getColor: rgba(ice, al), getWidth: w, widthUnits: "pixels", parameters: par })),
      );
    // Where each topic will be: a frame and a dot breathing (once the scan has passed it), fading as it starts.
    const breath = 0.5 + 0.5 * Math.sin(now / 260);
    const waits = this.layout.world.flatMap((w) => {
      const b = I.born.get(w.id);
      const seen = ss(0, 0.06, (sx - w.middle[0]) / Math.max(1e-9, E - W));
      const a = (b === undefined || now < b ? 1 : 1 - ss(0, INTRO.frameOut, now - b)) * seen;
      return a > 0.01 ? [{ w, a }] : [];
    });
    if (waits.length)
      out.push(
        this.path("intro-box", waits.map((d) => ({ path: d.w.box, a: d.a })), ((d: { a: number }) => rgba(ice, (40 + 50 * breath) * d.a)) as never, 1, { jointRounded: false }),
        new ScatterplotLayer({ id: "intro-dot", data: waits, getPosition: (d: { w: WorldTopic }) => d.w.middle, getRadius: 4 + 3 * breath, radiusUnits: "pixels", getFillColor: (d: { a: number }) => rgba(ice, (120 + 110 * breath) * d.a), parameters: par }),
      );
    // Coasts drawn round; roads growing, nodes lighting.
    const pens: { path: LngLatZ[] }[] = [];
    const heads: LngLatZ[] = [];
    const roads: { path: LngLatZ[] }[] = [];
    const lit: LngLatZ[] = [];
    for (const w of this.layout.world) {
      const b = I.born.get(w.id);
      if (b === undefined) continue;
      const age = now - b;
      if (age >= 0 && age < INTRO.coast[1]) {
        const f = easeInOut3(age / INTRO.coast[1]);
        for (const ring of w.coast) {
          const part = prefix(ring, f);
          if (part.length > 1) {
            pens.push({ path: part });
            heads.push(part[part.length - 1]!);
          }
        }
      }
      if (age >= INTRO.road[0] && age < INTRO.road[1]) {
        const g = easeInOut3((age - INTRO.road[0]) / (INTRO.road[1] - INTRO.road[0]));
        const fade = 1 - ss(INTRO.road[1] - 140, INTRO.road[1], age);
        for (const r of this.layout.regions) {
          if (r.lane.topic !== w.id) continue;
          const road = r.pre.length ? [...r.pre.slice(0, -1), ...r.walked] : r.walked;
          roads.push({ path: prefix(road, g) }, ...r.branches.map((br) => ({ path: prefix(br.path, g) })));
          const x0 = road[0]![0];
          const x1 = road[road.length - 1]![0];
          if (fade > 0.02) for (const id of Object.keys(r.nodes)) if ((r.nodes[id]!.ground[0] - x0) / Math.max(1e-9, x1 - x0) <= g) lit.push(r.nodes[id]!.at);
        }
      }
    }
    if (pens.length)
      out.push(
        this.path("intro-coast-glow", pens, (() => rgba(ice, 60)) as never, 6),
        this.path("intro-coast", pens, (() => rgba(ice, 255)) as never, 1.6),
        new ScatterplotLayer({ id: "intro-pen", data: heads, getPosition: (p: LngLatZ) => p, getRadius: 3.2, radiusUnits: "pixels", getFillColor: rgba(ice, 255), parameters: par }),
      );
    if (roads.length) out.push(this.path("intro-road", roads.filter((d) => d.path.length > 1), (() => rgba(ice, 235)) as never, 1.8));
    if (lit.length)
      out.push(
        new ScatterplotLayer({ id: "intro-node-glow", data: lit, getPosition: (p: LngLatZ) => p, getRadius: 9, radiusUnits: "pixels", getFillColor: rgba(ice, 50), parameters: par }),
        new ScatterplotLayer({ id: "intro-node", data: lit, getPosition: (p: LngLatZ) => p, getRadius: 3.4, radiusUnits: "pixels", getFillColor: rgba(ice, 250), parameters: par }),
      );
    return out;
  }

  /**
   * What moves: lights flowing into running sessions and along dependency arcs, brackets on what waits for the person,
   * the ring of the selection. A few dozen objects, rebuilt each frame.
   */
  private animLayers(t: number, z: number): Layer[] {
    const T = this.theme;
    const out: Layer[] = this.intro ? this.introLayers() : [];
    // What moves along the roads waits for them (the opening).
    const late = this.allIn();
    if (late < 0.02) return out;
    const F = T.flow;
    const dots: { p: LngLatZ; a: number; c: RGB }[] = [];
    this.flowPaths.forEach((m, i) => {
      for (let k = 0; k < F.n; k++) {
        const r = (t / 1000 / F.speed + k / F.n + i * 0.37) % 1;
        // Brighter towards the head of the way: the light comes from behind and arrives at the session.
        dots.push({ p: m.at(r), a: 0.35 + 0.65 * r, c: T.col.hot });
      }
    });
    const riseTo = (n: Node) => (n.id === n.r.front ? n.r.nodes[n.id]!.top : n.p);
    this.risers.forEach((n, i) => {
      const top = riseTo(n);
      for (let k = 0; k < F.n; k++) {
        const r = (t / 1000 / (F.speed * 0.8) + k / F.n + i * 0.41) % 1;
        dots.push({ p: [top[0], top[1], n.g[2] + (top[2] - n.g[2]) * r], a: 0.3 + 0.7 * r, c: T.col.hot });
      }
    });
    const A = T.arc;
    if (this.runChev.length) {
      // The chevrons of a task that runs: a wave of light runs along them towards the goal, one after another.
      const FR = T.front;
      const h = (t / 1000 / FR.speed) % 1;
      const lit = (c: { j: number; n: number }) => Math.max(0, 1 - Math.abs(c.j - (h * (c.n + 2) - 1)) / 1.3);
      FR.chev.forEach(([w, al], i) =>
        out.push(this.path(`chev-run-${i}`, this.runChev, ((c: { j: number; n: number; r: RegionLayout }) => rgba(T.col.working, (al * (FR.idle + (FR.run - FR.idle) * lit(c))) / 255)) as never, w, { updateTriggers: { getColor: t } })),
      );
    }
    this.arcPaths.forEach((m, i) => {
      for (let k = 0; k < A.dotN; k++) {
        const r = (t / 1000 / A.dotSpeed + k / A.dotN + i * 0.29) % 1;
        dots.push({ p: m.at(r), a: 1, c: T.col.working.map((v, j) => v + (T.col.settled[j]! - v) * r) as RGB });
      }
    });
    if (dots.length)
      out.push(
        new ScatterplotLayer({ id: "flow-glow", data: dots, getPosition: (d: { p: LngLatZ }) => d.p, getRadius: F.glow, radiusUnits: "pixels", billboard: true, getFillColor: (d: { a: number; c: RGB }) => rgba(d.c, 70 * d.a), opacity: late, parameters: this.params as never, updateTriggers: { getPosition: t } }),
        new ScatterplotLayer({ id: "flow", data: dots, getPosition: (d: { p: LngLatZ }) => d.p, getRadius: F.r, radiusUnits: "pixels", billboard: true, getFillColor: (d: { a: number; c: RGB }) => rgba(d.c, 255 * d.a), opacity: late, parameters: this.params as never, updateTriggers: { getPosition: t } }),
      );
    if (this.risers.length) {
      // The top of a running column breathes.
      const w = pulse(t, 2.2);
      out.push(
        new IconLayer({ id: "riser-top", data: this.risers, iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: () => "glow", getPosition: riseTo, getSize: T.pillar.cap * 5, sizeUnits: "pixels", sizeScale: 0.85 + 0.35 * w, getColor: rgba(T.col.hot, 90 + 80 * w), billboard: true, parameters: this.params as never }),
      );
    }
    const o = this.mid(z);
    const sp = this.sel ? (this.byId.get(this.sel)?.p ?? this.spots.get(this.sel)) : undefined;
    if (sp)
      out.push(
        new IconLayer({ id: "sel", data: [{ p: sp }], iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: () => "selring", getPosition: (d: { p: LngLatZ }) => d.p, getSize: 520, sizeUnits: "meters", sizeMinPixels: 26, sizeMaxPixels: 86, getAngle: (t / 1000) * T.sel.spin, getColor: rgba(T.col.hot, 230), billboard: true, parameters: this.params as never, updateTriggers: { getAngle: t } }),
      );
    if (o <= 0.004) return out;
    if (this.need.length) {
      const w = pulse(t, T.alert.period);
      out.push(
        new IconLayer({ id: "alert", data: this.need, iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: () => "bracket", getPosition: (n: Node) => n.p, getSize: 560, sizeUnits: "meters", sizeMinPixels: 24, sizeMaxPixels: 82, sizeScale: 1 + 0.12 * w, getAngle: (t / 1000) * T.alert.spin, getColor: rgba(T.col.needs_you, 255), billboard: true, pickable: true, opacity: o * (0.75 + 0.25 * w) * this.signsIn(), parameters: this.params as never, updateTriggers: { getAngle: t } }),
      );
    }
    return out;
  }

  /** Pulses of layers built with the data: the far rings and the outline of an area with something waiting. */
  private pulseOf(id: string, t: number): Record<string, unknown> {
    const w = pulse(t, this.theme.alert.period);
    if (id === "alert-far") return { sizeScale: 0.7 + 0.6 * w, opacity: 1 - 0.45 * w };
    if (id === "region-alert") {
      const [lo, hi] = this.theme.region.alert;
      return { opacity: lo + (hi - lo) * w };
    }
    return {};
  }

  private composeEntries(entries: Entry[], z: number, t: number | null, f = 1): Layer[] {
    const out: Layer[] = [];
    for (const e of entries) {
      const o = Math.round(e.o(z) * f * 32) / 32;
      // While the opening plays a layer goes to deck.gl only once it is first seen: setting up one (its shaders, its own
      // copy of the font atlas on the GPU) costs, and a topic's insides are not seen yet (after it, all go, as before).
      if (this.intro && !e.shown && o <= 0.004) continue;
      const pulsing = t !== null && (e.layer.id === "alert-far" || e.layer.id === "region-alert");
      // Zoom-following props only matter while it shows.
      const zp = e.p && o > 0.004 ? e.p(z) : null;
      if (o !== e.lastO || pulsing || !e.shown || (zp && zp.k !== e.lastK)) {
        const p = pulsing ? this.pulseOf(e.layer.id, t) : {};
        const op = ((p.opacity as number | undefined) ?? 1) * o;
        delete p.opacity;
        e.shown = e.layer.clone({ opacity: op, visible: o > 0.004, ...p, ...(zp?.props ?? {}) });
        e.lastO = o;
        if (zp) e.lastK = zp.k;
      }
      out.push(e.shown!);
    }
    return out;
  }

  private lastT = 0;
  private push(t?: number): void {
    if (this.dead) return;
    if (t !== undefined) this.lastT = t;
    const z = this.vs.zoom;
    // `fold`: from 中 on every folded run opens (and folds again a little further out, so it does not flicker on the edge).
    // Laying out again is heavy (a world topic's land too): only once the camera has rested a moment, not in a zoom.
    if (this.layout.regions.some((r) => r.folds.length) && this.foldWanted(z) !== this.autoOpen) {
      // (push runs every frame while things move: a wait under way is left alone; the camera moving again ends it.)
      if (this.moving()) {
        clearTimeout(this.timers.fold);
        this.timers.fold = 0;
      } else if (!this.timers.fold)
        this.timers.fold = window.setTimeout(() => {
          this.timers.fold = 0;
          if (this.dead || this.moving() || this.foldWanted(this.vs.zoom) === this.autoOpen) return;
          this.autoOpen = !this.autoOpen;
          this.relayout();
          this.push();
          this.wake();
        }, FOLD_SETTLE);
    }
    if (this.intro && performance.now() - this.lastBorn() > INTRO.end && !this.asked.size) this.endIntro();
    const layers = [...this.composeEntries(this.base, z, t ?? null), ...this.composeEntries(this.labels, z, null, this.signsIn()), ...this.animLayers(this.lastT, z)];
    // Signs over the map, the pulsing brackets and the selection ring over the signs (they are thin, nothing is hidden).
    this.deck.setProps({ layers });
    const blocked = this.grouped;
    const level = blocked && this.inside(z) < 0.5 ? "远 · 各专题" : z > this.near ? "近 · 全部牌子" : this.mid(z) >= 0.5 ? (blocked ? "近 · 轮次和分叉" : "中 · 轮次和分叉") : blocked ? "中 · 专题里面：项目、主控、资料" : "远 · 起点、主干、终点";
    const line = `${level}  Z ${z.toFixed(1)}  倾 ${Math.round(this.vs.pitch)}°  向 ${Math.round(((this.vs.bearing % 360) + 360) % 360)}°`;
    if (line !== this.readout) {
      this.readout = line;
      this.events.onView?.(line);
    }
  }
  private readout = "";
  /** Whether folded runs should be open at zoom z (open from 中; folded again a little further out). */
  private foldWanted(z: number): boolean {
    return this.autoOpen ? this.mid(z) > 0.3 : this.mid(z) >= 0.6;
  }
  /** Counters and times for measuring (probe `stats`). */
  private stats: Record<string, number> = { layouts: 0, layoutMs: 0, labels: 0, labelMs: 0 };
  private timed<T>(k: string, f: () => T): T {
    const t = performance.now();
    try {
      return f();
    } finally {
      this.stats[k + "s"] = (this.stats[k + "s"] ?? 0) + 1;
      this.stats[k + "Ms"] = (this.stats[k + "Ms"] ?? 0) + performance.now() - t;
    }
  }

  // ---------- signs ----------

  private lineText(n: Node): string {
    const it = n.it;
    const time = shortTime(it.at, this.data.now);
    return it.status === "needs_you" ? `! ${it.summary} · ${time}` : `${SYM[it.status]} #${it.num} · ${time}`;
  }

  private scheduleLabels(ms = 160): void {
    this.labPending = true;
    clearTimeout(this.timers.lab);
    this.timers.lab = window.setTimeout(() => this.timed("label", () => this.layoutLabels()), ms);
  }

  /**
   * Signs are placed once the camera stops (no CollisionFilterExtension: it renders an extra pass every frame): the
   * 等你 ones first, lifted (a longer leader) when they would overlap; the rest by importance, left out when they would.
   */
  private layoutLabels(): void {
    if (this.dead || !this.ready || !this.deck.isInitialized) return;
    const vp = this.deck.getViewports()[0];
    if (!vp) return;
    if (this.busyFly && !this.interacting) return this.scheduleLabels(120);
    const T = this.theme;
    const z = this.vs.zoom;
    const W = this.parent.clientWidth;
    const H = this.parent.clientHeight;
    const mpp = 78271.517 / 2 ** z;
    const sp = Math.max(0.25, Math.sin((this.vs.pitch * Math.PI) / 180));
    const size = T.lab.size;
    const boxH = 2 * size * 1.3 + 8 + 2 * T.lab.border;
    const grid = new Map<string, Box[]>();
    const G = 80;
    const cells = (b: Box) => {
      const out: string[] = [];
      for (let gx = Math.floor(b.x0 / G); gx <= Math.floor(b.x1 / G); gx++) for (let gy = Math.floor(b.top / G); gy <= Math.floor(b.bot / G); gy++) out.push(gx + "," + gy);
      return out;
    };
    const hit = (b: Box) => {
      for (const c of cells(b)) for (const o of grid.get(c) ?? []) if (b.x0 < o.x1 + 4 && b.x1 > o.x0 - 4 && b.top < o.bot + 4 && b.bot > o.top - 4) return o;
      return null;
    };
    const put = (b: Box) => {
      for (const c of cells(b)) {
        const list = grid.get(c) ?? [];
        list.push(b);
        grid.set(c, list);
      }
    };
    // Area names (and the line under them) are taken first: signs never cover them.
    for (const r of this.layout.regions) {
      const [x, y] = vp.project(r.name) as [number, number];
      // World: the names are printed on the ground with the rest of it; the signs stand above, nothing to keep clear.
      if (this.layout.world.length) break;
      const h = T.name.size + T.subSize * 1.5 + 8 + (T.look.drafting ? 13 : 0);
      const w = textW([...r.lane.short].join(" "), T.name.size) + 6;
      const x0 = r.nameAlign === "start" ? x : r.nameAlign === "end" ? x - w : x - w / 2;
      if (x > -200 && x < W + 50 && y > -50 && y < H + 50) put({ x0, x1: x0 + w, top: r.nameBelow ? y - 2 : y - h, bot: r.nameBelow ? y + h : y + 2 });
    }
    const label = (n: Node) => this.lineText(n) + "\n" + cut(n.it.short || n.it.title, 14);
    const need: Node[] = [];
    for (const n of this.need) {
      const [px, py] = vp.project([n.p[0], n.p[1], n.lz]) as [number, number];
      const w = textW(label(n), size) + 18;
      let lift = 0;
      let b: Box = { x0: px - w / 2, x1: px + w / 2, top: py - 42, bot: py - 42 + boxH };
      for (let k = 0; k < 8; k++) {
        const top = py - 42 - lift;
        b = { x0: px - w / 2, x1: px + w / 2, top, bot: top + boxH };
        const o = hit(b);
        if (!o) break;
        lift += b.bot - o.top + 6;
      }
      put(b);
      n.lp = [n.p[0], n.p[1], n.lz + (lift * mpp) / sp];
      need.push(n);
    }
    const oth: Node[] = [];
    if (z > this.near - 0.4) {
      const rank = (n: Node) => (n.id === this.sel ? 3 : n.it.status === "working" ? 2 : n.it.status === "parked" ? 0 : 1);
      for (const n of this.nodes.filter((x) => x.it.status !== "needs_you").sort((a, b) => rank(b) - rank(a) || b.it.at.localeCompare(a.it.at))) {
        const [px, py] = vp.project([n.p[0], n.p[1], n.lz]) as [number, number];
        if (px < -150 || px > W + 150 || py < -100 || py > H + 150) continue;
        const w = textW(label(n), size) + 18;
        const b = { x0: px - w / 2, x1: px + w / 2, top: py - 42, bot: py - 42 + boxH };
        if (hit(b)) continue;
        put(b);
        n.lp = [n.p[0], n.p[1], n.lz];
        oth.push(n);
        if (oth.length > 220) break;
      }
    }
    this.signs = need.length + oth.length;
    this.labels = this.buildLabels(need, oth, label);
    this.lastLabZ = z;
    this.labPending = false;
    this.push();
    this.wake();
  }

  private buildLabels(need: Node[], oth: Node[], label: (n: Node) => string): Entry[] {
    const T = this.theme;
    const L = T.lab;
    const cols = (n: Node) => {
      const nd = n.it.status === "needs_you";
      return { fg: nd ? L.nfg : n.it.status === "parked" ? rgba(L.fg, 150) : L.fg, bg: nd ? L.nbg : L.bg, bd: n.id === this.sel ? rgba(T.col.hot, 255) : nd ? L.nbd : L.bd };
    };
    // Copies of the nodes with the sign's place: new objects, so deck recomputes them (it does not compare accessors).
    const snap = (list: Node[]) => list.map((n) => ({ ...n, lp: [...n.lp] as LngLatZ }));
    const lab = (id: string, data: Node[]) =>
      this.text({
        id,
        data: snap(data),
        getPosition: (n: Node) => n.lp,
        getText: label,
        getSize: L.size,
        lineHeight: 1.3,
        getColor: (n: Node) => cols(n).fg,
        getTextAnchor: "middle",
        getAlignmentBaseline: "top",
        getPixelOffset: [0, -38],
        background: true,
        getBackgroundColor: (n: Node) => cols(n).bg,
        getBorderColor: (n: Node) => cols(n).bd,
        getBorderWidth: L.border,
        backgroundPadding: [8, 4, 8, 4],
        backgroundBorderRadius: L.radius,
        pickable: true,
      });
    const leader = (id: string, data: Node[]) =>
      new LineLayer({ id, data: snap(data), getSourcePosition: (n: Node) => n.p, getTargetPosition: (n: Node) => n.lp, getColor: (n: Node) => (n.it.status === "needs_you" ? rgba(T.col.needs_you, 170) : rgba(this.col(n.it.status), 130)), getWidth: 1, widthUnits: "pixels", parameters: this.params as never });
    // With topic blocks the signs of what waits come with the topic's inside.
    const needO = (z: number) => (this.grouped ? this.inside(z) : ss(9.9, 10.5, z));
    const othO = (z: number) => ss(this.near, this.near + 0.6, z);
    return [
      { layer: leader("lead-oth", oth), o: (z) => othO(z) * 0.8, lastO: -1, shown: null },
      { layer: leader("lead-need", need), o: needO, lastO: -1, shown: null },
      { layer: lab("lab-oth", oth), o: othO, lastO: -1, shown: null },
      { layer: lab("lab-need", need), o: needO, lastO: -1, shown: null },
    ];
  }

  // ---------- camera ----------

  private size(): { W: number; H: number } {
    return { W: this.parent.clientWidth || 1200, H: this.parent.clientHeight || 800 };
  }

  private fit(b: [number, number, number, number], o: { pitch: number; bearing: number; pad: { top: number; bottom: number; left: number; right: number } }): ViewState {
    const { W, H } = this.size();
    const v: ViewState = { longitude: (b[0] + b[2]) / 2, latitude: (b[1] + b[3]) / 2, zoom: 10, pitch: o.pitch, bearing: o.bearing };
    const pts: [number, number][] = [
      [b[0], b[1]],
      [b[2], b[1]],
      [b[2], b[3]],
      [b[0], b[3]],
      [(b[0] + b[2]) / 2, b[1]],
      [(b[0] + b[2]) / 2, b[3]],
      [b[0], (b[1] + b[3]) / 2],
      [b[2], (b[1] + b[3]) / 2],
    ];
    const pad = o.pad;
    for (let k = 0; k < 10; k++) {
      const vp = new WebMercatorViewport({ width: W, height: H, ...v });
      const ps = pts.map((p) => vp.project(p));
      const x0 = Math.min(...ps.map((p) => p[0]!));
      const x1 = Math.max(...ps.map((p) => p[0]!));
      const y0 = Math.min(...ps.map((p) => p[1]!));
      const y1 = Math.max(...ps.map((p) => p[1]!));
      const aw = Math.max(50, W - pad.left - pad.right);
      const ah = Math.max(50, H - pad.top - pad.bottom);
      const c = vp.unproject([W / 2 + ((x0 + x1) / 2 - (pad.left + aw / 2)), H / 2 + ((y0 + y1) / 2 - (pad.top + ah / 2))]);
      v.longitude = c[0]!;
      v.latitude = c[1]!;
      v.zoom = Math.min(VIEW_LIMITS.maxZoom, Math.max(VIEW_LIMITS.minZoom, v.zoom + Math.log2(Math.min(aw / Math.max(1, x1 - x0), ah / Math.max(1, y1 - y0))) * 0.9));
    }
    return v;
  }

  private flyTo(v: ViewState, ms = this.theme.fly): void {
    if (this.dead) return;
    // The wheel's zoom under way gives way (the buttons are outside the map: their press does not stop it).
    if (this.wz) {
      cancelAnimationFrame(this.wz.raf);
      this.wz = null;
    }
    // A flight to where the camera already is never reports its end: clear the flag by the clock as well.
    this.busyFly = true;
    this.wake();
    clearTimeout(this.timers.fly);
    this.timers.fly = window.setTimeout(() => {
      this.busyFly = false;
      this.scheduleLabels();
      this.push();
    }, ms + 500);
    this.deck.setProps({ initialViewState: { ...VIEW_LIMITS, minZoom: this.home.zoom - 1.3, ...v, transitionDuration: ms, transitionInterpolator: new FlyToInterpolator(), transitionEasing: easeInOut3 } as never });
  }

  /** Back to the whole topic. */
  flyHome(): void {
    this.home = this.fit(this.layout.bounds, { pitch: this.vs.pitch > 5 ? this.vs.pitch : 50, bearing: -12, pad: { top: 110, bottom: 80, left: 70, right: 70 + this.inset } });
    this.flyTo(this.home);
  }

  zoomBy(d: number): void {
    this.flyTo({ ...this.vs, zoom: Math.max(this.home.zoom - 1.3, Math.min(VIEW_LIMITS.maxZoom, this.vs.zoom + d)) }, 380);
  }

  private flyRegion(r: RegionLayout): void {
    this.flyTo(this.fit(r.bounds, { pitch: Math.max(40, this.vs.pitch), bearing: this.vs.bearing, pad: { top: 140, bottom: 140, left: 110, right: 110 + this.inset } }));
  }

  private flyToItem(id: string): void {
    const p = this.byId.get(id)?.p ?? this.spots.get(id);
    if (!p) return;
    const n = { p };
    // A node: close; a document, point or spine session of a topic block: near enough to read its block (0.3).
    const close = this.byId.has(id) || this.roundCards.some((c) => c.it.id === id);
    const z = Math.min(13.7, Math.max(this.vs.zoom, close ? 13.2 : BLOCK_ZOOM + 0.3));
    const b = (this.vs.bearing * Math.PI) / 180;
    const pitch = Math.max(this.vs.pitch, 40);
    const dpp = 360 / (512 * 2 ** z);
    // The popup covers the right: the node goes to the middle of what is left; its sign is above it, so a bit forward.
    const dx = this.inset / 2;
    const dy = 70 / Math.cos((pitch * Math.PI) / 180);
    this.flyTo({ longitude: n.p[0] + (Math.cos(b) * dx + Math.sin(b) * dy) * dpp, latitude: n.p[1] + (-Math.sin(b) * dx + Math.cos(b) * dy) * dpp, zoom: z, pitch, bearing: this.vs.bearing }, Math.round(this.theme.fly * 0.85));
  }

  /** The runs of rounds the page keeps open (`fold`). */
  setOpen(keys: ReadonlySet<string>): void {
    if (this.dead || (keys.size === this.openFolds.size && [...keys].every((k) => this.openFolds.has(k)))) return;
    this.openFolds = keys;
    if (!this.autoOpen) {
      this.relayout();
      this.push();
      this.wake();
    }
  }

  /** The same data laid out again (a run opened or folded): only the folded rounds move. */
  private relayout(): void {
    this.timed("layout", () => this.applyData(this.data));
    this.scheduleLabels(0);
    this.ensureTick();
  }

  /** Width the page's popup covers on the right, kept clear when framing. */
  setInset(px: number): void {
    this.inset = px;
  }

  /** The selected node (ring and bright sign); `fly` takes the camera to it. */
  select(id: string | null, fly = false): void {
    if (this.dead) return;
    this.sel = id && (this.byId.has(id) || this.spots.has(id)) ? id : null;
    if (this.sel && fly) this.flyToItem(this.sel);
    this.scheduleLabels(0);
    this.push();
    this.wake();
    this.ensureTick();
  }

  private click(info: PickingInfo): void {
    // A ground text's SDF twin answers as the text.
    const id = baseId(info.layer?.id ?? "");
    const obj = info.object as { id?: string } | undefined;
    if (!obj) return;
    if (id === "nodes" || id === "node-back" || id === "alert" || id === "alert-far" || id.startsWith("lab-") || id === "spine-node" || id === "board-card" || id === "round-card" || id === "round-mark" || id === "world-board-line") {
      const pid = obj.id ?? (obj as { it?: PanoramaItem }).it?.id;
      if (pid) this.events.onPick(pid);
    } else if (id === "doc") this.events.onPick((obj as unknown as { doc: PanoramaDoc }).doc.id);
    else if (id === "world-book") this.events.onPick((obj as unknown as { doc: PanoramaDoc }).doc.id);
    else if ((id === "block-name" || id === "block-info" || id === "block-fill") && this.inside(this.vs.zoom) < 0.5) this.flyBlock(obj as unknown as BlockLayout);
    else if ((id === "world-title" || id === "world-info" || id === "world-fill") && this.inside(this.vs.zoom) < 0.5) this.flyBlock(obj as unknown as WorldTopic);
    else if (id === "fold-text") this.events.onFold?.((obj as unknown as Fold).key);
    else if (id === "region-name" || id === "region-sub" || id === "origin" || id === "goal") this.flyRegion(obj as unknown as RegionLayout);
  }

  /**
   * Into a topic: the whole block, flatter (its text stands up less far apart), and no further out than the zoom its
   * inside is laid out for — a block too big for that is entered at its north-west part (shelf, board, spine, the first
   * bands), the rest a drag away.
   */
  private flyBlock(b: BlockLayout | WorldTopic): void {
    const o = { pitch: 40, bearing: this.vs.bearing, pad: { top: 130, bottom: 50, left: 50, right: 50 } };
    // A block's header stands above it: room for that too (a region has its own inside).
    const world = "coast" in b;
    const [x0, y0, x1, y1] = [b.bounds[0], b.bounds[1], b.bounds[2], b.bounds[3] + (world ? 0 : 55 * U)];
    const v = this.fit([x0, y0, x1, y1], world ? { ...o, pad: { top: 70, bottom: 40, left: 40, right: 40 + this.inset } } : o);
    // A region may be framed a little further out: its inside is all in from about there.
    const lim = world ? BLOCK_ZOOM + this.theme.block.inside + 0.4 : BLOCK_ZOOM;
    if (v.zoom >= lim) return this.flyTo(v);
    const f = 2 ** (v.zoom - lim);
    this.flyTo(this.fit([x0, y1 - (y1 - y0) * f, x0 + (x1 - x0) * f, y1], o));
  }

  /** Double-click an area: frame it; anywhere else: the whole topic. */
  private dblclick = (e: MouseEvent) => {
    const rect = this.parent.getBoundingClientRect();
    const want = new Set(["region-fill", "region-name", "region-sub", "world-fill"]);
    const layerIds = this.base.map((x) => x.layer.id).filter((id) => want.has(baseId(id)));
    const hit = this.deck.pickObject({ x: e.clientX - rect.left, y: e.clientY - rect.top, radius: 2, layerIds });
    if (baseId(hit?.layer?.id ?? "") === "world-fill") this.flyBlock(hit!.object as WorldTopic);
    else if (hit?.object) this.flyRegion(hit.object as RegionLayout);
    else this.flyHome();
  };

  /** The camera moves: dragged, flying, or zooming by the wheel. */
  private moving(): boolean {
    return this.interacting || this.busyFly || !!this.wz;
  }

  private onWheel = (e: WheelEvent) => {
    if (this.dead || !this.ready || !this.deck.isInitialized) return;
    e.preventDefault();
    const vp = this.deck.getViewports()[0];
    if (!vp) return;
    const rect = this.parent.getBoundingClientRect();
    const at: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
    let d = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1) * (e.ctrlKey ? WHEEL.pinch : 1);
    d = Math.max(-600, Math.min(600, d));
    if (!d) return;
    const dz = -Math.sign(d) * Math.log2(2 / (1 + Math.exp(-Math.abs(d) * WHEEL.speed)));
    const g = vp.unproject(at);
    // Above the horizon there is no ground under the pointer: about the middle then.
    const onGround = Number.isFinite(g[0]) && Number.isFinite(g[1]) && Math.abs(g[1]! - this.vs.latitude) < 5;
    const ground: [number, number] = onGround ? [g[0]!, g[1]!] : [this.vs.longitude, this.vs.latitude];
    const target = Math.max(this.home.zoom - 1.3, Math.min(VIEW_LIMITS.maxZoom, (this.wz?.target ?? this.vs.zoom) + dz));
    // A flight in progress gives way.
    if (this.busyFly) {
      this.busyFly = false;
      clearTimeout(this.timers.fly);
    }
    const now = performance.now();
    const was = this.wz;
    this.wz = { target, at: onGround ? at : [vp.width / 2, vp.height / 2], ground, last: was?.last ?? now, raf: was?.raf ?? 0 };
    if (!this.wz.raf) {
      this.wz.last = now;
      this.wz.raf = requestAnimationFrame(this.wheelStep);
    }
    this.labPending = true;
    this.wake();
  };

  private wheelStep = (now: number) => {
    const W = this.wz;
    if (!W || this.dead) return;
    W.raf = 0;
    const dt = Math.max(0, Math.min(50, now - W.last));
    W.last = now;
    const z0 = this.vs.zoom;
    const gap = W.target - z0;
    const step = Math.min(Math.abs(gap) * (1 - Math.exp(-dt / WHEEL.tau)), (WHEEL.max * dt) / 1000);
    let z = z0 + Math.sign(gap) * step;
    const done = Math.abs(W.target - z) < WHEEL.stop;
    if (done) z = W.target;
    this.vs = this.zoomAbout({ ...this.vs, zoom: z }, W.at, W.ground);
    this.deck.setProps({ initialViewState: { ...VIEW_LIMITS, minZoom: this.home.zoom - 1.3, ...this.vs } as never });
    this.wake();
    if (done) {
      this.wz = null;
      this.push();
      this.ensureTick();
      this.scheduleLabels(60);
      return;
    }
    // The signs are placed again once it stops (new signs mean their text laid out anew: tens of ms, a dropped frame).
    this.push();
    this.ensureTick();
    W.raf = requestAnimationFrame(this.wheelStep);
  };

  /** The view at `v`'s zoom with the ground point `ground` at screen point `at`. */
  private zoomAbout(v: ViewState, at: [number, number], ground: [number, number]): ViewState {
    const { W, H } = this.size();
    const out = { ...v };
    for (let k = 0; k < 2; k++) {
      // (Size last: deck.gl's view state carries a width and height of its own, its canvas's before the first layout.)
      const g = new WebMercatorViewport({ ...out, width: W, height: H }).unproject(at);
      out.longitude += ground[0] - g[0]!;
      out.latitude += ground[1] - g[1]!;
    }
    return out;
  }

  private stopWheel = () => {
    if (!this.wz) return;
    cancelAnimationFrame(this.wz.raf);
    this.wz = null;
    this.scheduleLabels();
    this.push();
  };

  // ---------- render loop ----------

  private get loop(): Loop | null {
    return (this.deck as unknown as { animationLoop: Loop | null }).animationLoop;
  }

  /** Input or a change: deck's loop runs, and stops again 0.7 s after things are still. */
  private wake = () => {
    if (!this.ready || this.dead || document.hidden) return;
    if (!this.loopOn) {
      this.loopOn = true;
      this.loop?.start();
    }
    clearTimeout(this.timers.idle);
    this.timers.idle = window.setTimeout(() => this.sleep(), 700);
  };

  private sleep(): void {
    if (this.dead) return;
    // Not waiting for "no frame to draw": the pulse frames keep coming. The frame still owed is drawn before stopping.
    if (this.moving()) {
      this.timers.idle = window.setTimeout(() => this.sleep(), 300);
      return;
    }
    this.loop?.stop();
    this.loopOn = false;
    this.loop?.redraw();
  }

  /**
   * Frames while something moves: lights flow (a session runs, dependencies are drawn), 等你 pulses, a selection
   * spins. A topic where nothing runs or waits draws nothing at all once the camera stops.
   */
  private needsAnim(): boolean {
    return !!this.intro || this.flowPaths.length > 0 || this.arcPaths.length > 0 || this.runChev.length > 0 || this.need.length > 0 || !!this.sel;
  }

  private tick = () => {
    this.timers.tick = 0;
    if (this.dead || document.hidden || !this.ready) return;
    this.push(performance.now());
    if (!this.loopOn) this.loop?.redraw();
    // Only lights flowing: fewer frames are enough (and spare the CPU while sessions run for hours).
    if (this.needsAnim()) this.timers.tick = window.setTimeout(this.tick, this.intro ? 1000 / 60 : 1000 / (this.need.length || this.sel ? this.theme.fps : this.theme.flow.fps));
  };

  private ensureTick(): void {
    if (!this.timers.tick && this.ready && !this.dead && !document.hidden && this.needsAnim()) this.timers.tick = window.setTimeout(this.tick, 0);
  }

  private visibility = () => {
    if (document.hidden) {
      clearTimeout(this.timers.tick);
      this.timers.tick = 0;
      clearTimeout(this.timers.idle);
      if (this.loopOn && this.ready) {
        this.loop?.stop();
        this.loopOn = false;
      }
    } else {
      this.wake();
      this.ensureTick();
    }
  };

  // ---------- for the page and tests ----------

  probe(): EngineProbe {
    // The getters read the live engine.
    const self = this;
    const project = (p: LngLatZ): [number, number] | null => {
      const vp = self.deck.isInitialized ? self.deck.getViewports()[0] : undefined;
      if (!vp) return null;
      const xy = vp.project(p);
      return [Math.round(xy[0]!), Math.round(xy[1]!)];
    };
    return {
      screenOf: (id) => {
        const p = self.byId.get(id)?.p ?? self.spots.get(id);
        return p ? project(p) : null;
      },
      blockHead: (title) => {
        const b = self.layout.blocks.find((x) => x.topic.title === title);
        const w = self.layout.world.find((x) => x.topic.title === title);
        // A world topic's name lies on the ground: a point inside its first letters.
        const xy = b ? project(b.head) : w ? project(south(w.head, self.theme.world.type.title * 0.5, self.theme.world.type.title * 1.2)) : null;
        return xy ? (w ? xy : [xy[0] + 40, xy[1] - 8]) : null;
      },
      flyNear: (id) => self.flyToItem(id),
      regionNameOf: (laneId) => {
        // A point on the name itself, to click.
        const r = self.layout.regions.find((x) => x.id === laneId);
        const xy = r ? project(r.name) : null;
        return xy && r ? [xy[0] + (r.nameAlign === "start" ? 12 : r.nameAlign === "end" ? -12 : 0), xy[1] + (r.nameBelow ? 8 : -14)] : null;
      },
      get busy() {
        return self.moving() || self.labPending || !self.ready || !!self.intro || !!self.timers.fold;
      },
      get opening() {
        return !!self.intro;
      },
      get openingAt() {
        return self.intro && !Number.isNaN(self.intro.t0) ? self.intro.t0 : null;
      },
      get stats() {
        return { ...self.stats, atlasTextures: atlasTextures(self.device()) };
      },
      get zoom() {
        return self.vs.zoom;
      },
      get atlases() {
        // The font atlases in use (deck.gl's text layers keep theirs in state): size and how many glyphs.
        const seen = new Map<string, { sdf: boolean; w: number; h: number; glyphs: number }>();
        const lm = (self.deck as unknown as { layerManager?: { getLayers(): Layer[] } }).layerManager;
        for (const l of lm?.getLayers() ?? []) {
          const m = (l.state as { fontAtlasManager?: { _key?: string; props: { sdf?: boolean }; atlas?: { data: HTMLCanvasElement; mapping: object } } } | null)?.fontAtlasManager;
          if (!m?.atlas || !m._key || seen.has(m._key)) continue;
          seen.set(m._key, { sdf: !!m.props.sdf, w: m.atlas.data.width, h: m.atlas.data.height, glyphs: Object.keys(m.atlas.mapping).length });
        }
        return [...seen.values()];
      },
      get selected() {
        return self.sel;
      },
      get signs() {
        return self.signs;
      },
      get level() {
        return self.inside(self.vs.zoom) < 0.5 ? ("topics" as const) : self.mid(self.vs.zoom) >= 0.5 ? ("mid" as const) : ("far" as const);
      },
      get blocks() {
        return self.layout.blocks.length;
      },
      get world() {
        return self.layout.world.length;
      },
      get flows() {
        return self.flowPaths.length;
      },
      get arcs() {
        return self.arcPaths.length;
      },
      get folds() {
        return self.layout.regions.flatMap((r) => r.folds.map((f) => ({ key: f.key, open: f.open, xy: project(f.at) })));
      },
    };
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    for (const t of Object.values(this.timers)) clearTimeout(t);
    this.resize.disconnect();
    for (const ev of ["pointerdown", "pointermove", "pointerup", "wheel", "contextmenu"]) this.parent.removeEventListener(ev, this.wake, { capture: true });
    this.parent.removeEventListener("dblclick", this.dblclick);
    this.parent.removeEventListener("wheel", this.onWheel);
    this.parent.removeEventListener("pointerdown", this.stopWheel, { capture: true });
    if (this.wz) cancelAnimationFrame(this.wz.raf);
    this.wz = null;
    document.removeEventListener("visibilitychange", this.visibility);
    const device = this.device();
    this.deck.finalize();
    forgetDevice(device);
  }
}

interface Box {
  x0: number;
  x1: number;
  top: number;
  bot: number;
}

/** What the map shows, as a string: equal when only timestamps moved, so those do not redraw anything. */
function signatureOf(d: PanoramaData): string {
  return JSON.stringify([
    d.context.title,
    d.lanes.map((l) => [l.id, l.short, l.status, l.column, l.goal, l.project, l.proposedBy]),
    d.items.map((i) => [i.id, i.lane, i.status, i.summary, i.short, i.at, i.round, i.forkFrom, i.ended, i.type, i.of]),
    d.topics,
    d.projects,
    d.docs,
    d.links.map((l) => [l.from, l.to]),
  ]);
}

type Arc = PanoramaLayout["arcs"][number];
type Fold = RegionLayout["folds"][number];

/** A way measured once, so a light at 0–1 along it is found without walking it again. */
interface Measured {
  at(r: number): LngLatZ;
}

function measure(path: LngLatZ[]): Measured {
  const acc = [0];
  for (let i = 1; i < path.length; i++) acc.push(acc[i - 1]! + Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1], (path[i]![2] - path[i - 1]![2]) / 111_320));
  const L = acc[acc.length - 1]! || 1;
  return {
    at(r) {
      const d = r * L;
      let i = 1;
      while (i < acc.length - 1 && acc[i]! < d) i++;
      const a = path[i - 1]!;
      const b = path[Math.min(i, path.length - 1)]!;
      const f = Math.max(0, Math.min(1, (d - acc[i - 1]!) / Math.max(1e-12, acc[i]! - acc[i - 1]!)));
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    },
  };
}

/** Points along a dependency arc the way ArcLayer draws it (its paraboloid), so the lights ride on the line. */
function arcPath(s: LngLatZ, t: LngLatZ, height: number): Measured {
  const M = 111_320;
  const dist = Math.hypot((t[0] - s[0]) * M, (t[1] - s[1]) * M);
  const dz = t[2] - s[2];
  const dh = dist * height;
  const pts: LngLatZ[] = [];
  for (let k = 0; k <= 40; k++) {
    const r = k / 40;
    let z: number;
    if (!dh) z = s[2] + dz * r;
    else {
      const u = dz / dh;
      const p2 = u * u + 1;
      const down = dz <= 0;
      const rr = down ? 1 - r : r;
      z = Math.sqrt(Math.max(0, rr * (p2 - rr))) * dh + (down ? t[2] : s[2]);
    }
    pts.push([s[0] + (t[0] - s[0]) * r, s[1] + (t[1] - s[1]) * r, z]);
  }
  return measure(pts);
}

/** Cut a line to about `px` pixels at `size` (CJK a full em, the rest about 0.6). */
function fitText(s: string, px: number, size: number): string {
  let w = 0;
  const lim = px - size;
  for (let i = 0; i < s.length; i++) {
    w += (s.charCodeAt(i) >= 0x2e80 ? 1 : 0.6) * size;
    if (w > lim) return s.slice(0, i) + "…";
  }
  return s;
}

const TONE: Record<string, string> = { good: "✓", warn: "!", bad: "✕", info: "·" };

/** A project's status board: its name, the fields its topic's spec asks for, the summary, who wrote it and when. */
function boardText(p: PanoramaProject, now: string): string {
  const rows = p.status.map((f) => `${f.tone ? TONE[f.tone] : "·"} ${f.label}  ${cut(f.value, 14)}`);
  const by = p.updatedAt || p.by ? [`${p.by ?? ""}${p.by && p.updatedAt ? " · " : ""}${p.updatedAt ? shortTime(p.updatedAt, now) : ""}`] : [];
  return [`▣ ${cut(p.title, 26)}`, ...rows, ...(p.summary ? [cut(p.summary, 17)] : []), ...by].join("\n");
}

/** A document's panel on the shelf: kind and title, its first lines, when it changed. */
/** World: a status board — the project's name, then its summary and fields, three lines at most (the rest counted). */
function worldCardText(p: PanoramaProject, px: number, size: number, now: string): string {
  const rows = [...(p.summary ? [p.summary] : []), ...p.status.map((f) => `${TONE[f.tone ?? "info"] ?? "·"} ${f.label} ${f.value}`)];
  const shown = rows.length > 3 ? [...rows.slice(0, 2), `另 ${rows.length - 2} 项${p.updatedAt ? ` · ${shortTime(p.updatedAt, now)}` : ""}`] : rows;
  return [p.title, ...shown].map((s) => fitText(s, px, size)).join("\n");
}

function docText(d: PanoramaDoc, now: string): string {
  return `${d.kind === "spec" ? "规范" : "文档"} · ${cut(d.title, 14)}\n${cut(d.summary || "（快照里没带正文）", 17)}\n更新 ${shortTime(d.updatedAt, now)}`;
}

/** A point on the board: its type and title, then a line of it. */
function cardText(it: PanoramaItem): string {
  return `${it.status === "needs_you" ? "! " : ""}${ITEM_LABEL[it.type]} · ${cut(it.title, 13)}\n${cut(it.body ?? it.summary, 17)}`;
}

/** The dimension line's text: rounds, and how long the trunk's sessions ran altogether. */
function dimText(r: RegionLayout): string {
  const trunk = r.items.filter((i) => i.round !== null);
  const min = trunk.reduce((s, i) => s + i.work.minutes, 0);
  return `${trunk.length} 轮 · ${min >= 60 ? `${Math.round(min / 6) / 10} 小时` : `${min} 分钟`}`;
}

const sign = (v: number) => (v >= 0 ? `+${v}` : `−${-v}`);

function goalText(r: RegionLayout): string {
  const c = r.lane.goal.checklist;
  const st = r.lane.goal.state;
  return c && st !== "reached" ? `${GOAL_TEXT[st]} · 清单 ${c.done}/${c.total}` : GOAL_TEXT[st]!;
}

/** Rough width of a sign's text (the boxes only need to be close enough to keep signs apart). */
function textW(s: string, size: number): number {
  return Math.max(...s.split("\n").map((l) => [...l].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e80 ? size * 1.02 : size * 0.58), 0)));
}

function shortTime(iso: string, now: string): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toDateString() === new Date(now).toDateString() ? hm : `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

/** The icon atlas: thin glowing hollow shapes drawn once on a canvas (white; IconLayer tints them with `mask`). */
function buildIcons(): { url: string; mapping: Record<string, unknown> } {
  const N = 128;
  const cv = document.createElement("canvas");
  cv.width = N * ICONS.length;
  cv.height = N;
  const g = cv.getContext("2d")!;
  const mapping: Record<string, unknown> = {};
  ICONS.forEach((nm, i) => {
    const ox = i * N;
    const cx = ox + N / 2;
    const cy = N / 2;
    g.save();
    g.beginPath();
    g.rect(ox, 0, N, N);
    g.clip();
    g.beginPath();
    g.strokeStyle = g.fillStyle = "#fff";
    g.lineWidth = 3.6;
    g.shadowColor = "#fff";
    g.shadowBlur = 7;
    g.lineCap = "round";
    const r = 34;
    if (nm === "glow") {
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, N / 2);
      gr.addColorStop(0, "rgba(255,255,255,1)");
      gr.addColorStop(0.16, "rgba(255,255,255,.55)");
      gr.addColorStop(0.45, "rgba(255,255,255,.14)");
      gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr;
      g.shadowBlur = 0;
      g.fillRect(ox, 0, N, N);
    } else if (nm === "circle") {
      g.arc(cx, cy, r * 0.86, 0, 7);
      g.stroke();
    } else if (nm === "dotring") {
      g.arc(cx, cy, r * 0.82, 0, 7);
      g.stroke();
      g.beginPath();
      g.arc(cx, cy, 8, 0, 7);
      g.fill();
    } else if (nm === "bracket") {
      // Four thin arcs with inward ticks: the sight on what waits for you.
      g.lineWidth = 3;
      g.shadowBlur = 6;
      for (let k = 0; k < 4; k++) {
        const c0 = (k * Math.PI) / 2 + Math.PI / 4;
        g.beginPath();
        g.arc(cx, cy, 50, c0 - 0.5, c0 + 0.5);
        g.stroke();
      }
      g.lineWidth = 2.4;
      for (let k = 0; k < 4; k++) {
        const t = (k * Math.PI) / 2;
        g.beginPath();
        g.moveTo(cx + 56 * Math.cos(t), cy + 56 * Math.sin(t));
        g.lineTo(cx + 44 * Math.cos(t), cy + 44 * Math.sin(t));
        g.stroke();
      }
    } else if (nm === "selring") {
      g.lineWidth = 2.2;
      g.shadowBlur = 5;
      g.arc(cx, cy, 50, 0, 7);
      g.stroke();
      for (let k = 0; k < 24; k++) {
        const t = (k / 24) * 2 * Math.PI;
        const l = k % 6 ? 4 : 9;
        g.beginPath();
        g.moveTo(cx + 53 * Math.cos(t), cy + 53 * Math.sin(t));
        g.lineTo(cx + (53 + l) * Math.cos(t), cy + (53 + l) * Math.sin(t));
        g.stroke();
      }
    } else if (nm === "beacon") {
      // The start: a diamond with a dot, like a marker set on the map.
      g.lineWidth = 4;
      g.moveTo(cx, cy - 44);
      g.lineTo(cx + 30, cy);
      g.lineTo(cx, cy + 44);
      g.lineTo(cx - 30, cy);
      g.closePath();
      g.stroke();
      g.beginPath();
      g.arc(cx, cy, 9, 0, 7);
      g.fill();
    } else if (nm === "goal" || nm === "goalhalf" || nm === "goalfill") {
      // The goal: a gate of two rings with four ticks; half filled at 待审阅, filled once reached.
      if (nm === "goal") {
        g.lineWidth = 3.4;
        g.arc(cx, cy, 44, 0, 7);
        g.stroke();
        g.beginPath();
        g.lineWidth = 2.4;
        g.arc(cx, cy, 28, 0, 7);
        g.stroke();
        for (let k = 0; k < 4; k++) {
          const t = (k * Math.PI) / 2 + Math.PI / 4;
          g.beginPath();
          g.moveTo(cx + 48 * Math.cos(t), cy + 48 * Math.sin(t));
          g.lineTo(cx + 60 * Math.cos(t), cy + 60 * Math.sin(t));
          g.stroke();
        }
      } else {
        g.shadowBlur = 4;
        g.arc(cx, cy, 22, nm === "goalhalf" ? 0 : 0, nm === "goalhalf" ? Math.PI : 7);
        g.closePath();
        g.fill();
      }
    } else if (nm === "ring") {
      g.lineWidth = 3.5;
      g.shadowBlur = 6;
      g.arc(cx, cy, 40, 0, 7);
      g.stroke();
    }
    g.restore();
    mapping[nm] = { x: ox, y: 0, width: N, height: N, anchorX: N / 2, anchorY: N / 2, mask: true };
  });
  return { url: cv.toDataURL(), mapping };
}
