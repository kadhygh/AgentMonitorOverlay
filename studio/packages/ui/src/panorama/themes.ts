import type { ItemStatus } from "./datalayer.js";
import { WORLD_TYPE, type Curve } from "./layout.js";
import type { WorldKind } from "./regions.js";

// 全景's looks (2026-11-01): one table per theme, the engine and the page's panels both read it, so a new theme is a
// new entry here. The user chose 冰白全息 (oblivion) from studio/plans/userlayer/v-deck3.html; it is the only one for
// now. The name 全景 is neutral on purpose: a star map is one theme of it, the data underneath stays the same.

export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

/**
 * How a task's tree is dressed (2026-11-02, tried in the preview with #base / #a / #ab / #ad / #abd): `track` the road
 * as a band from start to goal, lit as far as it came, a tick per round; `pillars` a light column per round, as tall as
 * the work in it (the skyline); `plinth` a base hugging the tree instead of a big frame around it, with `drafting`'s
 * small engineering marks (dimension lines, edge ticks, a coordinate) on it. All off is how P1 first looked.
 *
 * Then (2026-11-02, the user, plans/userlayer/panorama.md「节点的表达」): `front` the node furthest on as a taller,
 * brighter column and chevrons on the road on to the goal, flowing while the task runs; `fold` runs of smooth rounds
 * folded into one 「×N 轮」 stretch, spread out once zoomed in or clicked; `span` a footprint about fixed (近疏远密);
 * `curve` how the roads bend (layout.ts). The preview's address picks them (lookFrom).
 *
 * 2026-11-03 (the user): roads straight (`line`) again; `blocks` a block per topic — its projects' bands with their status
 * boards, its own sessions as a spine, its documents and board (layout.ts planBlocks).
 *
 * 2026-11-03, later (the user, plans/userlayer/sketches): `world` — each topic a region of the map instead, an island
 * (`terrain`) or a metro map's zone (`metro`), lanes straight lines with a tick at the start, a node a round, the front
 * a bright dot and its column, the goal a dashed ring; the per-round columns (`pillars`) off unless asked for.
 */
export interface PanoramaLook {
  track: boolean;
  pillars: boolean;
  plinth: boolean;
  drafting: boolean;
  front: boolean;
  fold: boolean;
  span: boolean;
  curve: Curve;
  blocks: boolean;
  world: WorldKind | null;
}

const P1 = { front: false, fold: false, span: false, curve: "wave" as Curve, blocks: false, world: null };
const WORLD_LOOK = { track: false, pillars: false, plinth: false, drafting: false, front: true, fold: true, span: true, curve: "line" as Curve, blocks: false };

export const LOOKS: Record<string, PanoramaLook> = {
  base: { track: false, pillars: false, plinth: false, drafting: false, ...P1 },
  a: { track: true, pillars: false, plinth: false, drafting: false, ...P1 },
  ab: { track: true, pillars: true, plinth: false, drafting: false, ...P1 },
  ad: { track: true, pillars: false, plinth: true, drafting: true, ...P1 },
  abd: { track: true, pillars: true, plinth: true, drafting: true, ...P1 },
  terrain: { ...WORLD_LOOK, world: "terrain" },
  metro: { ...WORLD_LOOK, world: "metro" },
};

/** The look the preview opens on (11-03, later): the topics as islands. */
export const PREVIEW_LOOK = "terrain";

/**
 * A look from a name like the preview's address: one of LOOKS (abd when left out), then `-line`, `-flow`, `-spiral` or
 * `-wave` for the curve — which brings the front, folding, the fixed footprint and topic blocks along, each turned off
 * again by `-nofront`, `-nofold`, `-nospan`, `-noblocks`. A bare A/B/D name is that look as it was (P1's wave, none of
 * these). `terrain` and `metro` have the front, folding and the fixed footprint already; `-pillars` adds the per-round
 * columns to them (to compare). Null when not understood.
 */
export function lookFrom(name: string): PanoramaLook | null {
  const words = name.split("-").filter(Boolean);
  const look: PanoramaLook = { ...LOOKS[words[0] && LOOKS[words[0]] ? words.shift()! : "abd"]! };
  if (words.length && !look.world) Object.assign(look, { front: true, fold: true, span: true, blocks: true });
  for (const w of words) {
    if (w === "pillars") look.pillars = true;
    else if (look.world && (w === "flow" || w === "spiral" || w === "wave")) return null;
    else if (w === "line" || w === "flow" || w === "spiral" || w === "wave") look.curve = w;
    else if (w === "noblocks") look.blocks = false;
    else if (w === "nofront") look.front = false;
    else if (w === "nofold") look.fold = false;
    else if (w === "nospan") look.span = false;
    else return null;
  }
  return look;
}

export interface PanoramaTheme {
  id: string;
  look: PanoramaLook;
  label: string;
  /** Map text: system fonts (TextLayer builds its glyphs from them, characterSet "auto"). */
  font: string;
  fontWeight: number;
  /** Area names: size, weight, and whether they are letter-spaced. */
  /** `plate`: with a base (`plinth`) the name hangs under it on a plate of this colour, so columns and glows of the row in front do not run through it. */
  name: { size: number; weight: number; spaced: boolean; alpha: number; plate: RGBA };
  subSize: number;
  /** Billboard signs over the nodes. */
  lab: { size: number; fg: RGBA; bg: RGBA; bd: RGBA; nfg: RGBA; nbg: RGBA; nbd: RGBA; radius: number; border: number };
  /** Frames per second of the pulses (等你, the selection); the map does not draw at all while nothing moves. */
  fps: number;
  /** Additive blending: lines crossing get brighter, the glow of a hologram. */
  additive: boolean;
  col: Record<ItemStatus | "hot", RGB>;
  /** Faint grid on the ground: colour and alpha of minor and major lines. */
  ground: { col: RGB; a: [number, number] };
  /** Lines are stacks of [width px, alpha]: wider and fainter underneath is the glow. */
  region: { fill: number; lines: [number, number][]; inner: number; ticks: number; alert: [number, number] };
  lane: { lines: [number, number][]; ahead: [number, number] };
  node: { size: number; min: number; max: number; back: RGBA; halo: [number, number]; shadow: [number, number, number]; stalk: number };
  alert: { farPx: number; period: number; spin: number };
  sel: { spin: number };
  /** P1 (2026-11-02), the tree: 第 N 轮 and the goal's and start's lines; the start beacon (ring radius m, beam stack, top px). */
  roundSize: number;
  beacon: { ring: number; beam: [number, number][]; px: number };
  /** The goal's size (px) and alpha while on the way, at 待审阅, reached. */
  goal: { px: number; alpha: Record<"open" | "review" | "reached", number> };
  /** Branch lines (stack of [width px, alpha]) and how much one that stopped is dimmed. */
  branch: { lines: [number, number][]; ended: number };
  /** Lights flowing into running sessions: radius and glow (px), how many per way, seconds to run it once, frames per second while only they move. */
  flow: { r: number; glow: number; n: number; speed: number; fps: number };
  /** Dependency arcs: line stack, height (ArcLayer's), lights on them. */
  arc: { lines: [number, number][]; height: number; dotN: number; dotSpeed: number };
  /** The radar and frame on the ground: alphas. */
  deco: { ring: number; dash: number; tick: number; frame: number };
  /** `track`: the band's edges, the lit fill, the round ticks, the ahead outline (alphas); half widths are in layout.ts. */
  track: { edge: [number, number][]; fill: number; tick: number; ahead: number; branchFill: number };
  /** `pillars`: line stack of a column, its cap (px), alpha of a branch's or a stopped one's. */
  pillar: { lines: [number, number][]; cap: number; branch: number; ended: number };
  /** `plinth`: fill and outline stack (alphas); `drafting`: alpha of its marks. */
  plinth: { fill: number; lines: [number, number][]; drafting: number };
  /**
   * `front`: the front column's least height (m), line stack, glow on top (px); the chevrons ahead: line stack, alpha
   * while the task is idle, how bright the wave running along them while it runs, and seconds it takes.
   */
  front: { min: number; lines: [number, number][]; glow: number; chev: [number, number][]; idle: number; run: number; speed: number };
  /** `fold`: 「×N 轮」 (size, alpha), the axis-break mark (alpha), how bright the columns of folded rounds are. */
  fold: { size: number; text: number; brk: number; pillar: number };
  /** `curve`: alpha of the shared field's lines on the ground. */
  stream: number;
  /**
   * `blocks`: the block's outline and fill (alphas), its header (name size, info size), the status boards, documents and
   * points (text size, plate), the spine (line stack, node px), a point's colour by its type, the zooms (from the
   * one the insides are laid out for, layout.ts BLOCK_ZOOM) where a topic's inside comes in and where the rounds do.
   */
  block: { line: number; fill: number; band: number; head: number; info: number; text: number; plate: RGBA; spine: [number, number][]; node: number; card: Record<"decision" | "question" | "finding" | "note", RGB>; inside: number; rounds: number };
  /**
   * `world` (the sketches' values): the projects' tints (the metro's line colours too); `terrain`: the island's fill, the
   * parts' fills (even / odd project) and the 主控 part's, the glow in from the coast (alpha of the deepest ring), the
   * coast (line stack), the dotted divides; `metro`: the parts' fills, the outline, the dashed divides, the dot grid
   * (alpha, px), the lanes (line stack); the lanes on the island (line stack), the start tick, the front dot (px).
   * `type`: the text printed on the ground (11-04, the user: only the signs on nodes and columns face the camera), in
   * layout units, so it grows and shrinks with the map — the topic's name and its line of counts, the plates' text,
   * the labels over shelf, board and spine, a lane's name, 第 N 轮 and the goal's word, 「×N 轮」.
   */
  world: {
    tints: RGB[];
    terrain: { fill: number; zone: [number, number]; common: number; inset: number; coast: [number, number][]; border: number };
    metro: { zone: [number, number]; common: number; coast: [number, number][]; cut: number; dots: [number, number]; lane: [number, number][] };
    lane: [number, number][];
    tick: number;
    front: number;
    type: { title: number; info: number; text: number; label: number; lane: number; round: number; fold: number };
  };
  /** Camera flights, ms. */
  fly: number;
  /** The page's panels (HUD, popup): CSS custom properties set on the page. */
  css: Record<string, string>;
}

const oblivion: PanoramaTheme = {
  id: "oblivion",
  look: LOOKS.base!,
  label: "冰白全息",
  font: '"Segoe UI Variable Text", "Segoe UI", DengXian, "Microsoft YaHei UI", sans-serif',
  fontWeight: 400,
  name: { size: 14, weight: 300, spaced: true, alpha: 235, plate: [20, 27, 34, 225] },
  subSize: 10.5,
  lab: { size: 11.5, fg: [232, 244, 255, 240], bg: [24, 34, 44, 170], bd: [232, 244, 255, 60], nfg: [255, 226, 188, 255], nbg: [52, 44, 40, 170], nbd: [255, 194, 128, 200], radius: 2, border: 1 },
  fps: 30,
  additive: true,
  col: { needs_you: [255, 194, 128], working: [232, 244, 255], waiting: [162, 178, 230], settled: [122, 198, 234], parked: [126, 138, 150], hot: [255, 255, 255] },
  ground: { col: [176, 208, 232], a: [9, 24] },
  region: { fill: 6, lines: [[7, 8], [2.2, 30], [1, 185]], inner: 40, ticks: 200, alert: [0.08, 0.26] },
  lane: { lines: [[8, 11], [3, 42], [1.1, 235]], ahead: [1, 70] },
  node: { size: 210, min: 9, max: 34, back: [18, 26, 34, 225], halo: [2.4, 26], shadow: [110, 8, 70], stalk: 55 },
  alert: { farPx: 22, period: 2.6, spin: 14 },
  sel: { spin: -26 },
  roundSize: 10,
  beacon: { ring: 150, beam: [[6, 16], [1.3, 150]], px: 15 },
  goal: { px: 26, alpha: { open: 85, review: 215, reached: 255 } },
  branch: { lines: [[4, 24], [1.2, 185]], ended: 0.42 },
  flow: { r: 1.8, glow: 5.5, n: 3, speed: 2.2, fps: 20 },
  arc: { lines: [[6, 10], [2.2, 36], [0.9, 215]], height: 0.3, dotN: 3, dotSpeed: 2.8 },
  deco: { ring: 26, dash: 40, tick: 52, frame: 70 },
  track: { edge: [[4, 14], [1, 150]], fill: 46, tick: 170, ahead: 60, branchFill: 30 },
  pillar: { lines: [[7, 16], [2.4, 60], [1, 230]], cap: 7, branch: 0.6, ended: 0.4 },
  plinth: { fill: 13, lines: [[6, 8], [1, 120]], drafting: 95 },
  front: { min: 2700, lines: [[10, 22], [3.6, 80], [1.4, 255]], glow: 46, chev: [[5, 40], [1.6, 255]], idle: 110, run: 255, speed: 1.6 },
  fold: { size: 10.5, text: 215, brk: 230, pillar: 0.6 },
  stream: 16,
  block: { line: 150, fill: 7, band: 9, head: 19, info: 11, text: 10.5, plate: [20, 28, 36, 228], spine: [[6, 18], [1.6, 200]], node: 7, card: { decision: [122, 198, 234], question: [255, 194, 128], finding: [196, 170, 255], note: [190, 204, 214] }, inside: -0.55, rounds: 0.9 },
  world: {
    tints: [
      [196, 226, 252],
      [182, 236, 232],
      [214, 206, 250],
      [236, 226, 206],
    ],
    terrain: { fill: 9, zone: [15, 9], common: 5, inset: 7, coast: [[9, 26], [3, 110], [1.15, 194]], border: 66 },
    metro: { zone: [19, 13], common: 11, coast: [[9, 18], [1.3, 168]], cut: 87, dots: [31, 1.6], lane: [[6, 70], [2.6, 242]] },
    lane: [[3.2, 110], [1.4, 220]],
    tick: 230,
    front: 9,
    // Layout units; layout.ts owns them (the land is laid out round the text).
    type: WORLD_TYPE,
  },
  fly: 1300,
  css: {
    "--pn-base": "#141b22",
    "--pn-bg":
      "radial-gradient(90% 60% at 50% 4%, #3a4957 0%, rgba(42,54,66,0) 70%), radial-gradient(140% 100% at 50% 100%, #0f151b 0%, #18212a 55%, #222d37 100%)",
    "--pn-fx": "linear-gradient(180deg, rgba(215,232,245,.08) 0, rgba(215,232,245,0) 24%), radial-gradient(130% 100% at 50% 55%, rgba(8,12,16,0) 62%, rgba(8,12,16,.5) 100%)",
    "--pn-tx": "#eef5fa",
    "--pn-tx2": "rgba(222,236,246,.74)",
    "--pn-tx3": "rgba(205,222,236,.5)",
    "--pn-ln": "rgba(230,242,252,.15)",
    "--pn-ln2": "rgba(230,242,252,.36)",
    "--pn-panel": "rgba(175,200,220,.07)",
    "--pn-win": "rgba(26,36,46,.56)",
    "--pn-bar": "rgba(30,42,54,.72)",
    "--pn-need": "#ffc280",
    "--pn-need-soft": "rgba(255,198,135,.55)",
    "--pn-need-bg": "rgba(255,196,130,.06)",
    "--pn-need-tx": "rgba(255,214,170,.78)",
    "--pn-set": "#7ac6ea",
    "--pn-font": '"Segoe UI Variable Text", "Segoe UI", DengXian, "Microsoft YaHei UI", sans-serif',
  },
};

// The two world looks (11-03): 冰白全息 as it is, the topics as islands or as a metro map's zones.
const terrain: PanoramaTheme = { ...oblivion, id: "terrain", label: "冰白全息 · 地形岛", look: LOOKS.terrain! };
const metro: PanoramaTheme = { ...oblivion, id: "metro", label: "冰白全息 · 地铁", look: LOOKS.metro! };

export const THEMES: Record<string, PanoramaTheme> = { oblivion, terrain, metro };
export const DEFAULT_THEME = oblivion;
