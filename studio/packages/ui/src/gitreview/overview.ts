import type { DiffRow } from "./logic.js";
import type { SplitRow } from "./splitview.js";

// Stage 13 (S13-B), as pure functions: the diff drawn in chunks (so a window being resized only lays out and paints
// what is on screen), the width of the longest line, and the overview ruler beside the scrollbar (where the changes
// are in the file, and which part is on screen).

/** Rows per chunk. Each chunk is `content-visibility: auto`: off screen, the browser skips its layout and paint. */
export const CHUNK_ROWS = 64;

/** `[start, start + count)` slices of `total` items, `size` at a time. */
export function chunkRanges(total: number, size = CHUNK_ROWS): { start: number; count: number }[] {
  const out: { start: number; count: number }[] = [];
  for (let start = 0; start < total; start += size) out.push({ start, count: Math.min(size, total - start) });
  return out;
}

/** Characters that take two columns in a monospaced font (CJK, full-width forms, most emoji). */
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\ud800-\udbff][\udc00-\udfff]/;

/** Columns a line takes on screen: tabs to the next multiple of `tab`, wide characters two. */
export function textColumns(text: string, tab = 8): number {
  let col = 0;
  for (const ch of text) {
    if (ch === "\t") col += tab - (col % tab);
    else col += WIDE.test(ch) ? 2 : 1;
  }
  return col;
}

/** The widest of the lines, in columns: the single-column view's width, so off-screen chunks still count. */
export function maxColumns(rows: readonly DiffRow[], tab = 8): number {
  let max = 0;
  for (const r of rows) {
    if (r.kind !== "line") continue;
    const t = r.line.text;
    // Plain ASCII without tabs (most code): one column a character.
    max = Math.max(max, /^[\x20-\x7e]*$/.test(t) ? t.length : textColumns(t, tab));
  }
  return max;
}

/** What one shown item (a row, or a side-by-side pair) is, for the ruler. */
export type RulerKind = "context" | "add" | "del" | "mod";

export const rowKinds = (rows: readonly DiffRow[]): RulerKind[] => rows.map((r) => (r.kind === "line" && r.line.kind !== "context" ? r.line.kind : "context"));

export const pairKinds = (pairs: readonly SplitRow[]): RulerKind[] =>
  pairs.map((p) => {
    if (p.kind === "hunk") return "context";
    const del = p.left?.row.line.kind === "del";
    const add = p.right?.row.line.kind === "add";
    return del && add ? "mod" : add ? "add" : del ? "del" : "context";
  });

/**
 * A run of items, `[from, to)`: changed — added only, deleted only, or both (modified) — or marked (2026-10-23):
 * `hl` an agent's 重点, `note` a comment.
 */
export interface ChangeRun {
  kind: "add" | "del" | "mod" | "hl" | "note";
  from: number;
  to: number;
}

/**
 * Runs of the items holding a marked line, for the ruler: `keysOf(i)` are the row keys item `i` shows (a row, or a
 * side-by-side pair's two), `marked` the keys that carry the mark.
 */
export function markRuns(count: number, keysOf: (i: number) => readonly string[], marked: ReadonlySet<string>, kind: "hl" | "note"): ChangeRun[] {
  const runs: ChangeRun[] = [];
  if (!marked.size) return runs;
  let from = -1;
  for (let i = 0; i <= count; i++) {
    const on = i < count && keysOf(i).some((k) => marked.has(k));
    if (on && from < 0) from = i;
    if (!on && from >= 0) {
      runs.push({ kind, from, to: i });
      from = -1;
    }
  }
  return runs;
}

export function changeRuns(kinds: readonly RulerKind[]): ChangeRun[] {
  const runs: ChangeRun[] = [];
  let from = -1;
  let add = false;
  let del = false;
  const close = (to: number) => {
    if (from >= 0) runs.push({ kind: add && del ? "mod" : add ? "add" : "del", from, to });
    from = -1;
    add = del = false;
  };
  kinds.forEach((k, i) => {
    if (k === "context") return close(i);
    if (from < 0) from = i;
    if (k === "add" || k === "mod") add = true;
    if (k === "del" || k === "mod") del = true;
  });
  close(kinds.length);
  return runs;
}

/** A chunk as drawn: its items and where it sits in the scrolled content. */
export interface ChunkBox {
  start: number;
  count: number;
  top: number;
  height: number;
}

/** Where item `index` starts in the scrolled content: inside its chunk, spread evenly (rows are about equal). */
export function itemTop(index: number, chunks: readonly ChunkBox[]): number {
  if (!chunks.length) return 0;
  let lo = 0;
  let hi = chunks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (chunks[mid]!.start <= index) lo = mid;
    else hi = mid - 1;
  }
  const c = chunks[lo]!;
  const at = Math.min(Math.max(index - c.start, 0), c.count);
  return c.top + (c.count ? (at / c.count) * c.height : 0);
}

/** One mark on the ruler, in the ruler's pixels. */
export interface RulerMark {
  kind: ChangeRun["kind"];
  top: number;
  height: number;
}

/** Marks for the runs on a ruler `rulerHeight` tall that stands for `contentHeight` of scrolled content; at least `min` px each (3: a one-line change stays visible). */
export function rulerMarks(runs: readonly ChangeRun[], chunks: readonly ChunkBox[], contentHeight: number, rulerHeight: number, min = 3): RulerMark[] {
  if (contentHeight <= 0 || rulerHeight <= 0) return [];
  const scale = rulerHeight / contentHeight;
  return runs.map((r) => {
    const top = itemTop(r.from, chunks) * scale;
    const bottom = itemTop(r.to, chunks) * scale;
    const height = Math.max(min, bottom - top);
    return { kind: r.kind, top: Math.min(top, Math.max(0, rulerHeight - height)), height };
  });
}

/** The box for what is on screen, in the ruler's pixels. */
export function viewBox(scrollTop: number, clientHeight: number, contentHeight: number, rulerHeight: number): { top: number; height: number } {
  if (contentHeight <= 0 || rulerHeight <= 0) return { top: 0, height: rulerHeight };
  const scale = rulerHeight / contentHeight;
  const height = Math.min(rulerHeight, Math.max(6, clientHeight * scale));
  return { top: Math.min(Math.max(0, scrollTop * scale), rulerHeight - height), height };
}

/** The scroll position that centres the point `y` px down a ruler `rulerHeight` tall. */
export function scrollForRuler(y: number, rulerHeight: number, contentHeight: number, clientHeight: number): number {
  if (rulerHeight <= 0) return 0;
  const at = (Math.min(Math.max(y, 0), rulerHeight) / rulerHeight) * contentHeight;
  return Math.round(Math.min(Math.max(0, at - clientHeight / 2), Math.max(0, contentHeight - clientHeight)));
}
