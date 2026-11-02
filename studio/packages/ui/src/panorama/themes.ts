import type { ItemStatus } from "./datalayer.js";
import type { Curve } from "./layout.js";

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
}

const P1 = { front: false, fold: false, span: false, curve: "wave" as Curve };

export const LOOKS: Record<string, PanoramaLook> = {
  base: { track: false, pillars: false, plinth: false, drafting: false, ...P1 },
  a: { track: true, pillars: false, plinth: false, drafting: false, ...P1 },
  ab: { track: true, pillars: true, plinth: false, drafting: false, ...P1 },
  ad: { track: true, pillars: false, plinth: true, drafting: true, ...P1 },
  abd: { track: true, pillars: true, plinth: true, drafting: true, ...P1 },
};

/** The look the preview opens on: A/B/D, the front, folding, a fixed footprint, the shared flow. */
export const PREVIEW_LOOK = "abd-flow";

/**
 * A look from a name like the preview's address: one of LOOKS (abd when left out), then `-flow`, `-spiral` or `-wave`
 * for the curve — which brings the front, folding and the fixed footprint along, each turned off again by `-nofront`,
 * `-nofold`, `-nospan`. A bare A/B/D name is that look as it was (P1's wave, none of these). Null when not understood.
 */
export function lookFrom(name: string): PanoramaLook | null {
  const words = name.split("-").filter(Boolean);
  const look: PanoramaLook = { ...LOOKS[words[0] && LOOKS[words[0]] ? words.shift()! : "abd"]! };
  if (words.length) Object.assign(look, { front: true, fold: true, span: true });
  for (const w of words) {
    if (w === "flow" || w === "spiral" || w === "wave") look.curve = w;
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

export const THEMES: Record<string, PanoramaTheme> = { oblivion };
export const DEFAULT_THEME = oblivion;
