import { Deck, FlyToInterpolator, MapView, WebMercatorViewport, type Layer, type PickingInfo } from "@deck.gl/core";
import { ArcLayer, IconLayer, LineLayer, PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { cut, needsYou, type ItemStatus, type PanoramaData, type PanoramaItem } from "./datalayer.js";
import { H_NODE, layoutPanorama, type LngLatZ, type PanoramaLayout, type RegionLayout } from "./layout.js";
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
  readonly selected: string | null;
  readonly signs: number;
  /** 远 or 中 (近 has no content of its own: the signs of every node come in). */
  readonly level: "far" | "mid";
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
interface Entry {
  layer: Layer;
  o: (z: number) => number;
  lastO: number;
  shown: Layer | null;
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
  private runChev: { path: LngLatZ[]; j: number; n: number; r: RegionLayout }[] = [];
  /** `fold`: the runs the page opened, and whether the camera is close enough (中) to open them all. */
  private openFolds: ReadonlySet<string> = new Set();
  /** Rounds in a run shown folded, with its length: no 第 N 轮, their columns dimmer the more are bunched (they add up). */
  private folded = new Map<string, number>();
  private autoOpen = false;
  private base: Entry[] = [];
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
  private busyFly = false;
  private labPending = true;
  private lastLabZ = -1;
  private signs = 0;
  private timers = { idle: 0, tick: 0, lab: 0, fly: 0 };
  private resize: ResizeObserver;
  private readonly params: Record<string, unknown>;
  private readonly flat = { depthCompare: "always", depthWriteEnabled: false };
  /** Where 中 begins: just in from the whole topic, and not before rounds (18 layout units) are ~28 px apart. */
  private get m0(): number {
    return Math.max(10.1, this.home.zoom + 0.3);
  }
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
      controller: { doubleClickZoom: false, scrollZoom: { smooth: true, speed: 0.012 }, inertia: 250 },
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
        else this.scheduleLabels();
      },
      getCursor: ({ isDragging, isHovering }) => (isDragging ? "grabbing" : isHovering ? "pointer" : "grab"),
      onClick: (info: PickingInfo) => this.click(info),
      onLoad: () => {
        this.ready = true;
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
    this.layout = layoutPanorama(data, { tight: look.plinth, curve: look.curve, span: look.span, fold: look.fold, open: this.autoOpen ? "all" : this.openFolds, front: look.front ? this.theme.front.min : null });
    this.nodes = [];
    this.byId.clear();
    for (const r of this.layout.regions)
      r.items.forEach((it, i) => {
        const at = r.nodes[it.id]!;
        // Signs alternate between two heights, so neighbours do not sit on one line.
        // With light columns the node sits on top of its own (the front on its own in any case).
        const p = look.pillars || it.id === r.front ? at.top : at.at;
        const lz = Math.max(H_NODE, p[2]) + (i % 2 ? 720 : 400);
        const n: Node = { id: it.id, it, r, g: at.ground, p, lz, lp: [p[0], p[1], lz], icon: it.round === null ? "dotring" : "circle" };
        this.nodes.push(n);
        this.byId.set(n.id, n);
      });
    const order = needsYou(data).map((i) => i.id);
    this.need = order.map((id) => this.byId.get(id)).filter((n): n is Node => !!n);
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

  private text(props: Record<string, unknown>): Layer {
    return new TextLayer({ characterSet: "auto", fontFamily: this.theme.font, fontWeight: this.theme.fontWeight, parameters: this.flat as never, ...props } as never);
  }

  /** Layers that change only with the data (and the selection, which is cheap to rebuild with them). */
  private buildBase(): Entry[] {
    const T = this.theme;
    const regs = this.layout.regions;
    const needN = new Map(regs.map((r) => [r.id, r.items.filter((i) => i.status === "needs_you").length]));
    const one = () => 1;
    const out: [Layer, (z: number) => number][] = [];
    const add = (o: (z: number) => number, ...ls: Layer[]) => ls.forEach((l) => out.push([l, o]));
    add(
      one,
      new LineLayer({ id: "ground", data: this.layout.grid, getSourcePosition: (d) => d.from, getTargetPosition: (d) => d.to, getColor: (d) => rgba(T.ground.col, d.a * (d.major ? T.ground.a[1] : T.ground.a[0])), getWidth: 1, widthUnits: "pixels", parameters: this.params as never }),
    );
    // Oblivion's radar on the ground and the chamfered frame around everything: faint, drawn once.
    const D = this.layout.deco;
    const DC = T.deco;
    const ground = (al: number) => (() => rgba(T.ground.col, al)) as never;
    add(
      one,
      this.path("deco-ring", D.rings.map((path) => ({ path })), ground(DC.ring), 1),
      this.path("deco-dash", D.dashes.map((path) => ({ path })), ground(DC.dash), 1),
      this.path("deco-tick", D.ticks, ((d: { a: number }) => rgba(T.ground.col, DC.tick * d.a)) as never, 1),
      this.path("frame", [{ path: D.frame }], ground(DC.frame), 1.2),
      this.path("frame-tick", D.frameTicks.map((path) => ({ path })), ground(DC.frame), 1),
    );
    // `curve`: the shared field's lines, fainter still.
    if (this.layout.streams.length) add(one, this.path("stream", this.layout.streams.map((path) => ({ path })), ground(T.stream), 1));
    // Areas: a fill (it also catches clicks on the name's area) and a few outlines stacked into a glow — the big frame,
    // or (`plinth`) a capsule hugging the tree.
    const look = T.look;
    // With a base the names hang under it on plates: columns and glows of the row in front would run through them.
    const plate = look.plinth ? { background: true, getBackgroundColor: T.name.plate, backgroundPadding: [5, 2, 5, 2] } : {};
    const shape = (r: RegionLayout) => (look.plinth ? r.plinth : r.outline);
    const fillA = look.plinth ? T.plinth.fill : T.region.fill;
    add(
      (z) => 1 - 0.5 * ss(12, 13, z),
      new PolygonLayer({ id: "region-fill", data: regs, getPolygon: (r: RegionLayout) => shape(r).map((p) => [p[0], p[1]]), getFillColor: (r: RegionLayout) => (needN.get(r.id) ? rgba(T.col.needs_you, fillA * 1.3) : rgba(this.regCol(r), fillA)), stroked: false, parameters: this.params as never }),
    );
    (look.plinth ? T.plinth.lines : T.region.lines).forEach(([w, al], i) => add(one, this.path(`region-${i}`, regs.map((r) => ({ path: shape(r), r })), ((d: { r: RegionLayout }) => rgba(this.regCol(d.r), al)) as never, w)));
    if (!look.plinth) add(one, this.path("region-in", regs.map((r) => ({ path: r.inner, r })), ((d: { r: RegionLayout }) => rgba(this.regCol(d.r), T.region.inner)) as never, 1));
    // `drafting`: a dimension line from start to goal under the base, small ticks along its far edge (no information).
    if (look.drafting) {
      const dA = T.plinth.drafting;
      add(
        one,
        this.path("draft-dim", regs.flatMap((r) => r.drafting.dim.map((path) => ({ path }))), (() => rgba(T.ground.col, dA)) as never, 1),
        this.path("draft-edge", regs.flatMap((r) => r.drafting.edge.map((path) => ({ path, r }))), ((d: { r: RegionLayout }) => rgba(this.regCol(d.r), dA * 1.3)) as never, 1),
      );
    }
    add(
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
      T.lane.lines.forEach(([w, al], i) => add(one, this.path(`trunk-${i}`, regs.map((r) => ({ path: r.walked, r })), ((d: { r: RegionLayout }) => rgba(laneCol(d.r), al)) as never, w)));
      add(one, this.path("ahead", regs.flatMap((r) => r.ahead.map((path) => ({ path }))), (() => rgba(T.col.working, T.lane.ahead[1])) as never, T.lane.ahead[0]));
    }
    // The start: a beam of light up from a ring on the ground, a diamond on top.
    const B = T.beacon;
    add(
      one,
      new ScatterplotLayer({ id: "origin-ring", data: regs, getPosition: (r: RegionLayout) => r.origin.ground, getRadius: B.ring, radiusUnits: "meters", radiusMinPixels: 4, stroked: true, filled: false, getLineColor: rgba(T.col.hot, 150), lineWidthUnits: "pixels", getLineWidth: 1, parameters: this.params as never }),
      ...B.beam.map(([w, al], i) => new LineLayer({ id: `origin-beam-${i}`, data: regs, getSourcePosition: (r: RegionLayout) => r.origin.ground, getTargetPosition: (r: RegionLayout) => r.origin.top, getColor: rgba(T.col.hot, al), getWidth: w, widthUnits: "pixels", parameters: this.params as never })),
      new IconLayer({ id: "origin", data: regs, iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: () => "beacon", getPosition: (r: RegionLayout) => r.origin.top, getSize: B.px, sizeUnits: "pixels", getColor: rgba(T.col.hot, 255), billboard: true, pickable: true, parameters: this.params as never }),
    );
    // The goal: faint while the task is on its way, half lit at 待审阅 (waiting for you to accept it), lit once 完成.
    const G = T.goal;
    const goalCol = (r: RegionLayout) => (r.lane.goal.state === "reached" ? T.col.settled : T.col.working);
    const lit = regs.filter((r) => r.lane.goal.state !== "open");
    add(
      one,
      new LineLayer({ id: "goal-stalk", data: regs, getSourcePosition: (r: RegionLayout) => r.goal.ground, getTargetPosition: (r: RegionLayout) => r.goal.at, getColor: (r: RegionLayout) => rgba(goalCol(r), G.alpha[r.lane.goal.state] * 0.35), getWidth: 1, widthUnits: "pixels", parameters: this.params as never }),
      new IconLayer({ id: "goal-halo", data: lit, iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: () => "glow", getPosition: (r: RegionLayout) => r.goal.at, getSize: G.px * 3, sizeUnits: "pixels", getColor: (r: RegionLayout) => rgba(goalCol(r), r.lane.goal.state === "reached" ? 70 : 34), billboard: true, parameters: this.params as never }),
      new IconLayer({ id: "goal", data: regs, iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: () => "goal", getPosition: (r: RegionLayout) => r.goal.at, getSize: G.px, sizeUnits: "pixels", getColor: (r: RegionLayout) => rgba(goalCol(r), G.alpha[r.lane.goal.state]), billboard: true, pickable: true, parameters: this.params as never }),
      new IconLayer({ id: "goal-fill", data: lit, iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: (r: RegionLayout) => (r.lane.goal.state === "reached" ? "goalfill" : "goalhalf"), getPosition: (r: RegionLayout) => r.goal.at, getSize: G.px, sizeUnits: "pixels", getColor: (r: RegionLayout) => rgba(goalCol(r), r.lane.goal.state === "reached" ? 220 : 170), billboard: true, parameters: this.params as never }),
    );
    // Dependencies: arcs from the goal of the task waited for to the start of the one waiting.
    const A = T.arc;
    if (this.layout.arcs.length)
      A.lines.forEach(([w, al], i) =>
        add(
          one,
          new ArcLayer({ id: `arc-${i}`, data: this.layout.arcs, getSourcePosition: (a: Arc) => a.s, getTargetPosition: (a: Arc) => a.t, getSourceColor: rgba(T.col.working, al), getTargetColor: rgba(T.col.settled, al), getWidth: w, widthUnits: "pixels", getHeight: A.height, greatCircle: false, parameters: this.params as never }),
        ),
      );
    // Branches, from the node that opened them; one that stopped is dim. Faint from afar: a task whose work went into
    // sessions it opened has a short trunk, and the branches show where it went (and where the lights run).
    const BR = T.branch;
    const brs = regs.flatMap((r) => r.branches.map((b) => ({ path: b.path, ended: b.ended })));
    const brO = (z: number) => 0.3 + 0.7 * this.mid(z);
    const brCol = (ended: boolean, al: number) => rgba(ended ? T.col.parked : T.col.working, al * (ended ? BR.ended : 1));
    if (look.track) {
      const bands = regs.flatMap((r) => r.band.branches);
      add(
        brO,
        new PolygonLayer({ id: "branch-fill", data: bands, getPolygon: (b: { fill: LngLatZ[] }) => b.fill.map((p) => [p[0], p[1]]), getFillColor: (b: { ended: boolean }) => brCol(b.ended, T.track.branchFill), stroked: false, parameters: this.params as never }),
        this.path("branch-edge", bands.flatMap((b) => b.edges.map((path) => ({ path, ended: b.ended }))), ((d: { ended: boolean }) => brCol(d.ended, 150)) as never, 1),
      );
    } else BR.lines.forEach(([w, al], i) => add(brO, this.path(`branch-${i}`, brs, ((d: { ended: boolean }) => brCol(d.ended, al)) as never, w)));
    // `pillars`: a light column per round from the ground to its node, as tall as the work in it — from afar too, the
    // skyline is what shows where the work went. A branch's are lower; one that stopped is dim.
    const PL = T.pillar;
    if (look.pillars) {
      const pa = (n: Node) => (n.it.ended ? PL.ended : n.it.round === null ? PL.branch : 1) * (n.it.status === "parked" ? 0.6 : 1) * (this.folded.has(n.id) ? T.fold.pillar * Math.min(1, 8 / this.folded.get(n.id)!) : 1);
      add(
        one,
        ...PL.lines.map(([w, al], i) => new LineLayer({ id: `pillar-${i}`, data: this.nodes, getSourcePosition: (n: Node) => n.g, getTargetPosition: (n: Node) => n.p, getColor: (n: Node) => rgba(this.col(n.it.status), al * pa(n)), getWidth: w, widthUnits: "pixels", parameters: this.params as never })),
        new ScatterplotLayer({ id: "pillar-cap", data: this.nodes, getPosition: (n: Node) => n.p, getRadius: PL.cap / 2, radiusUnits: "pixels", billboard: true, getFillColor: (n: Node) => rgba(this.col(n.it.status), 230 * pa(n)), parameters: this.params as never }),
      );
    }
    // `front`: the node furthest on stands as a taller, brighter column with a glow on top (whatever it is doing), and
    // chevrons point on along the road to the goal — still and dimmer while the task is idle (those of a task that runs
    // are drawn each frame, animLayers).
    const FR = T.front;
    if (look.front) {
      const still = regs.filter((r) => !this.runChev.some((c) => c.r === r)).flatMap((r) => r.chevrons.map((path) => ({ path, r })));
      add(
        one,
        ...FR.lines.map(([w, al], i) => new LineLayer({ id: `front-${i}`, data: this.fronts, getSourcePosition: (n: Node) => n.g, getTargetPosition: (n: Node) => n.p, getColor: (n: Node) => rgba(this.col(n.it.status), al), getWidth: w, widthUnits: "pixels", parameters: this.params as never })),
        new IconLayer({ id: "front-glow", data: this.fronts, iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: () => "glow", getPosition: (n: Node) => n.p, getSize: FR.glow, sizeUnits: "pixels", getColor: (n: Node) => rgba(this.col(n.it.status), 150), billboard: true, parameters: this.params as never }),
        ...FR.chev.map(([w, al], i) => this.path(`chev-${i}`, still, ((d: { r: RegionLayout }) => rgba(laneCol(d.r), (al * FR.idle) / 255)) as never, w)),
      );
    }
    // Nodes: a ring on the ground, a stalk, a glow, a dark disc (it keeps the hollow icon clickable) and the icon.
    const N = T.node;
    const nodes = this.nodes;
    const dim = (n: Node) => (n.it.ended ? BR.ended : n.it.status === "parked" ? 0.6 : 1);
    add(
      this.mid,
      new ScatterplotLayer({ id: "node-shadow", data: nodes, getPosition: (n: Node) => n.g, getRadius: N.shadow[0], radiusUnits: "meters", radiusMinPixels: 3, stroked: true, filled: true, getFillColor: (n: Node) => rgba(this.col(n.it.status), N.shadow[1] * dim(n)), getLineColor: (n: Node) => rgba(this.col(n.it.status), N.shadow[2] * dim(n)), lineWidthUnits: "pixels", getLineWidth: 1, parameters: this.params as never }),
      ...(look.pillars ? [] : [new LineLayer({ id: "node-stalk", data: nodes, getSourcePosition: (n: Node) => n.g, getTargetPosition: (n: Node) => n.p, getColor: (n: Node) => rgba(this.col(n.it.status), N.stalk * dim(n)), getWidth: 1, widthUnits: "pixels", parameters: this.params as never })]),
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
        this.text({ id: "fold-text", data: folds, getPosition: (f: Fold) => f.at, getText: (f: Fold) => (f.open ? `收起 ${f.ids.length} 轮` : `×${f.ids.length} 轮`), getSize: FO.size, getColor: (f: Fold) => rgba(T.col.working, f.open ? FO.text * 0.6 : FO.text), getTextAnchor: "middle", getAlignmentBaseline: "top", getPixelOffset: [0, 4], background: true, getBackgroundColor: [20, 27, 34, 200], backgroundPadding: [4, 1, 4, 1], pickable: true }),
      );
    }
    // 第 N 轮 under the trunk's nodes (below their ring on the ground), where the goal stands, and when the task
    // started, once there is room.
    add(
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
      this.text({ id: "origin-text", data: regs, getPosition: (r: RegionLayout) => r.origin.ground, getText: (r: RegionLayout) => `起点 · ${shortTime(r.lane.startAt, this.data.now)}`, getSize: T.roundSize, getColor: rgba(T.col.hot, 150), getTextAnchor: "middle", getAlignmentBaseline: "top", getPixelOffset: [0, 13] }),
    );
    // Area names above their far edge (with a base: under its near edge, on a plate; an arm's past its outer end), and
    // with each a line: how it stands, its board column, how many sessions.
    const nameText = (r: RegionLayout) => (T.name.spaced ? [...r.lane.short].join(" ") : r.lane.short);
    const sub = (r: RegionLayout) => {
      const n = needN.get(r.id) ?? 0;
      return `${n ? `! ${n} 件等你` : (LANE_TEXT[r.lane.status] ?? "")} · ${COLUMN[r.lane.column] ?? ""} · ${r.items.length} 个会话`;
    };
    add(
      one,
      this.text({ id: "region-name", data: regs, getPosition: (r: RegionLayout) => r.name, getText: nameText, getSize: T.name.size, fontWeight: T.name.weight, getColor: (r: RegionLayout) => rgba(this.regCol(r), T.name.alpha), getTextAnchor: (r: RegionLayout) => r.nameAlign, getAlignmentBaseline: (r: RegionLayout) => (r.nameBelow ? "top" : "bottom"), getPixelOffset: (r: RegionLayout) => [0, r.nameBelow ? 0 : -(T.subSize * 1.5 + 2)], pickable: true, ...plate }),
    );
    add(
      (z) => ss(this.home.zoom - 1.0, this.home.zoom - 0.6, z),
      this.text({ id: "region-sub", data: regs, getPosition: (r: RegionLayout) => r.name, getText: sub, getSize: T.subSize, getColor: (r: RegionLayout) => (needN.get(r.id) ? rgba(T.col.needs_you, 255) : rgba(this.regCol(r), 200)), getTextAnchor: (r: RegionLayout) => r.nameAlign, getAlignmentBaseline: (r: RegionLayout) => (r.nameBelow ? "top" : "bottom"), getPixelOffset: (r: RegionLayout) => [0, r.nameBelow ? T.name.size * 1.35 + 2 : 0], pickable: true, ...plate }),
    );
    // 等你 from afar: a pulsing ring of fixed size on screen (it fades as the brackets take over closer in).
    add(
      (z) => 1 - 0.75 * this.mid(z),
      new IconLayer({ id: "alert-far", data: this.need, iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: () => "ring", getPosition: (n: Node) => n.p, getSize: T.alert.farPx, sizeUnits: "pixels", getColor: rgba(T.col.needs_you, 255), billboard: true, pickable: true, parameters: this.params as never }),
    );
    add(one, this.path("region-alert", regs.filter((r) => needN.get(r.id)).map((r) => ({ path: shape(r) })), (() => rgba(T.col.needs_you, 255)) as never, 2.2));
    return out.map(([layer, o]) => ({ layer, o, lastO: -1, shown: null }));
  }

  /**
   * What moves: lights flowing into running sessions and along dependency arcs, brackets on what waits for the person,
   * the ring of the selection. A few dozen objects, rebuilt each frame.
   */
  private animLayers(t: number, z: number): Layer[] {
    const T = this.theme;
    const out: Layer[] = [];
    const F = T.flow;
    const dots: { p: LngLatZ; a: number; c: RGB }[] = [];
    this.flowPaths.forEach((m, i) => {
      for (let k = 0; k < F.n; k++) {
        const r = (t / 1000 / F.speed + k / F.n + i * 0.37) % 1;
        // Brighter towards the head of the way: the light comes from behind and arrives at the session.
        dots.push({ p: m.at(r), a: 0.35 + 0.65 * r, c: T.col.hot });
      }
    });
    this.risers.forEach((n, i) => {
      for (let k = 0; k < F.n; k++) {
        const r = (t / 1000 / (F.speed * 0.8) + k / F.n + i * 0.41) % 1;
        dots.push({ p: [n.p[0], n.p[1], n.g[2] + (n.p[2] - n.g[2]) * r], a: 0.3 + 0.7 * r, c: T.col.hot });
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
        new ScatterplotLayer({ id: "flow-glow", data: dots, getPosition: (d: { p: LngLatZ }) => d.p, getRadius: F.glow, radiusUnits: "pixels", billboard: true, getFillColor: (d: { a: number; c: RGB }) => rgba(d.c, 70 * d.a), parameters: this.params as never, updateTriggers: { getPosition: t } }),
        new ScatterplotLayer({ id: "flow", data: dots, getPosition: (d: { p: LngLatZ }) => d.p, getRadius: F.r, radiusUnits: "pixels", billboard: true, getFillColor: (d: { a: number; c: RGB }) => rgba(d.c, 255 * d.a), parameters: this.params as never, updateTriggers: { getPosition: t } }),
      );
    if (this.risers.length) {
      // The top of a running column breathes.
      const w = pulse(t, 2.2);
      out.push(
        new IconLayer({ id: "riser-top", data: this.risers, iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: () => "glow", getPosition: (d: Node) => d.p, getSize: T.pillar.cap * 5, sizeUnits: "pixels", sizeScale: 0.85 + 0.35 * w, getColor: rgba(T.col.hot, 90 + 80 * w), billboard: true, parameters: this.params as never }),
      );
    }
    const o = this.mid(z);
    const n = this.sel ? this.byId.get(this.sel) : undefined;
    if (n)
      out.push(
        new IconLayer({ id: "sel", data: [n], iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: () => "selring", getPosition: (d: Node) => d.p, getSize: 520, sizeUnits: "meters", sizeMinPixels: 26, sizeMaxPixels: 86, getAngle: (t / 1000) * T.sel.spin, getColor: rgba(T.col.hot, 230), billboard: true, parameters: this.params as never, updateTriggers: { getAngle: t } }),
      );
    if (o <= 0.004) return out;
    if (this.need.length) {
      const w = pulse(t, T.alert.period);
      out.push(
        new IconLayer({ id: "alert", data: this.need, iconAtlas: this.icon.url, iconMapping: this.icon.mapping as never, getIcon: () => "bracket", getPosition: (n: Node) => n.p, getSize: 560, sizeUnits: "meters", sizeMinPixels: 24, sizeMaxPixels: 82, sizeScale: 1 + 0.12 * w, getAngle: (t / 1000) * T.alert.spin, getColor: rgba(T.col.needs_you, 255), billboard: true, pickable: true, opacity: o * (0.75 + 0.25 * w), parameters: this.params as never, updateTriggers: { getAngle: t } }),
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

  private composeEntries(entries: Entry[], z: number, t: number | null): Layer[] {
    const out: Layer[] = [];
    for (const e of entries) {
      const o = Math.round(e.o(z) * 32) / 32;
      const pulsing = t !== null && (e.layer.id === "alert-far" || e.layer.id === "region-alert");
      if (o !== e.lastO || pulsing || !e.shown) {
        const p = pulsing ? this.pulseOf(e.layer.id, t) : {};
        const op = ((p.opacity as number | undefined) ?? 1) * o;
        delete p.opacity;
        e.shown = e.layer.clone({ opacity: op, visible: o > 0.004, ...p });
        e.lastO = o;
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
    if (this.layout.regions.some((r) => r.folds.length)) {
      const open = this.autoOpen ? this.mid(z) > 0.3 : this.mid(z) >= 0.6;
      if (open !== this.autoOpen) {
        this.autoOpen = open;
        this.relayout();
      }
    }
    const layers = [...this.composeEntries(this.base, z, t ?? null), ...this.composeEntries(this.labels, z, null), ...this.animLayers(this.lastT, z)];
    // Signs over the map, the pulsing brackets and the selection ring over the signs (they are thin, nothing is hidden).
    this.deck.setProps({ layers });
    const line = `${z > this.near ? "近 · 全部牌子" : this.mid(z) >= 0.5 ? "中 · 轮次和分叉" : "远 · 起点、主干、终点"}  Z ${z.toFixed(1)}  倾 ${Math.round(this.vs.pitch)}°  向 ${Math.round(((this.vs.bearing % 360) + 360) % 360)}°`;
    if (line !== this.readout) {
      this.readout = line;
      this.events.onView?.(line);
    }
  }
  private readout = "";

  // ---------- signs ----------

  private lineText(n: Node): string {
    const it = n.it;
    const time = shortTime(it.at, this.data.now);
    return it.status === "needs_you" ? `! ${it.summary} · ${time}` : `${SYM[it.status]} #${it.num} · ${time}`;
  }

  private scheduleLabels(ms = 160): void {
    this.labPending = true;
    clearTimeout(this.timers.lab);
    this.timers.lab = window.setTimeout(() => this.layoutLabels(), ms);
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
    const needO = (z: number) => ss(9.9, 10.5, z);
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
    // A flight to where the camera already is never reports its end: clear the flag by the clock as well.
    this.busyFly = true;
    this.wake();
    clearTimeout(this.timers.fly);
    this.timers.fly = window.setTimeout(() => {
      this.busyFly = false;
      this.scheduleLabels();
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
    const n = this.byId.get(id);
    if (!n) return;
    const z = Math.min(13.7, Math.max(this.vs.zoom, 13.2));
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
    this.applyData(this.data);
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
    this.sel = id && this.byId.has(id) ? id : null;
    if (this.sel && fly) this.flyToItem(this.sel);
    this.scheduleLabels(0);
    this.push();
    this.wake();
    this.ensureTick();
  }

  private click(info: PickingInfo): void {
    const id = info.layer?.id ?? "";
    const obj = info.object as { id?: string } | undefined;
    if (!obj) return;
    if (id === "nodes" || id === "node-back" || id === "alert" || id === "alert-far" || id.startsWith("lab-")) {
      if (obj.id) this.events.onPick(obj.id);
    } else if (id === "fold-text") this.events.onFold?.((obj as unknown as Fold).key);
    else if (id === "region-name" || id === "region-sub" || id === "origin" || id === "goal") this.flyRegion(obj as unknown as RegionLayout);
  }

  /** Double-click an area: frame it; anywhere else: the whole topic. */
  private dblclick = (e: MouseEvent) => {
    const rect = this.parent.getBoundingClientRect();
    const hit = this.deck.pickObject({ x: e.clientX - rect.left, y: e.clientY - rect.top, radius: 2, layerIds: ["region-fill", "region-name", "region-sub"] });
    if (hit?.object) this.flyRegion(hit.object as RegionLayout);
    else this.flyHome();
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
    if (this.interacting || this.busyFly) {
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
    return this.flowPaths.length > 0 || this.arcPaths.length > 0 || this.runChev.length > 0 || this.need.length > 0 || !!this.sel;
  }

  private tick = () => {
    this.timers.tick = 0;
    if (this.dead || document.hidden || !this.ready) return;
    this.push(performance.now());
    if (!this.loopOn) this.loop?.redraw();
    // Only lights flowing: fewer frames are enough (and spare the CPU while sessions run for hours).
    if (this.needsAnim()) this.timers.tick = window.setTimeout(this.tick, 1000 / (this.need.length || this.sel ? this.theme.fps : this.theme.flow.fps));
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
        const n = self.byId.get(id);
        return n ? project(n.p) : null;
      },
      regionNameOf: (laneId) => {
        // A point on the name itself, to click.
        const r = self.layout.regions.find((x) => x.id === laneId);
        const xy = r ? project(r.name) : null;
        return xy && r ? [xy[0] + (r.nameAlign === "start" ? 12 : r.nameAlign === "end" ? -12 : 0), xy[1] + (r.nameBelow ? 8 : -14)] : null;
      },
      get busy() {
        return self.busyFly || self.interacting || self.labPending || !self.ready;
      },
      get selected() {
        return self.sel;
      },
      get signs() {
        return self.signs;
      },
      get level() {
        return self.mid(self.vs.zoom) >= 0.5 ? ("mid" as const) : ("far" as const);
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
    document.removeEventListener("visibilitychange", this.visibility);
    this.deck.finalize();
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
    d.lanes.map((l) => [l.id, l.short, l.status, l.column, l.goal]),
    d.items.map((i) => [i.id, i.lane, i.status, i.summary, i.short, i.at, i.round, i.forkFrom, i.ended]),
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
