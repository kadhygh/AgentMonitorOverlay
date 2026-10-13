import type { GitDiffLine } from "@amo-studio/protocol";
import type { CodeToken } from "../lib/highlight.js";
import type { DiffRow } from "./logic.js";

// S12-A: the diff's syntax colours (old and new text highlighted whole, tokens mapped back by line number) and the
// side-by-side layout ("左右对照": old on the left, new on the right, changed lines paired).

export type LineRow = Extract<DiffRow, { kind: "line" }>;

/** One side of a side-by-side row: the line and its index among the unified rows (n / p and data-row use it). */
export interface SideCell {
  row: LineRow;
  index: number;
}

export type SplitRow =
  | { kind: "hunk"; key: string; header: string; hidden: number; index: number }
  | { kind: "pair"; key: string; left: SideCell | null; right: SideCell | null };

/**
 * Side-by-side rows from the unified ones: unchanged lines on both sides; within a run of changes the deleted lines
 * pair with the added ones in order, and the shorter side gets blanks.
 */
export function splitRows(rows: readonly DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: SideCell[] = [];
  let adds: SideCell[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const left = dels[i] ?? null;
      const right = adds[i] ?? null;
      out.push({ kind: "pair", key: `${left?.row.key ?? "-"}|${right?.row.key ?? "-"}`, left, right });
    }
    dels = [];
    adds = [];
  };
  rows.forEach((r, index) => {
    if (r.kind === "hunk") {
      flush();
      out.push({ ...r, index });
    } else if (r.line.kind === "del") dels.push({ row: r, index });
    else if (r.line.kind === "add") adds.push({ row: r, index });
    else {
      flush();
      out.push({ kind: "pair", key: r.key, left: { row: r, index }, right: { row: r, index } });
    }
  });
  flush();
  return out;
}

/** Files longer than this show without colours (highlighting runs in the window, all at once). */
export const MAX_HIGHLIGHT_LINES = 5000;

/** Tokens of each line of the old and the new version, by line number. */
export interface DiffTokens {
  old: ReadonlyMap<number, readonly CodeToken[]>;
  new: ReadonlyMap<number, readonly CodeToken[]>;
}

/**
 * Colours for a full-file diff: the old text (unchanged + deleted lines) and the new one (unchanged + added) are
 * highlighted whole, so comments and strings spanning lines colour right. Null without a grammar (or while it loads),
 * for huge files, and when the tokens do not line up.
 */
export function diffTokens(lines: readonly GitDiffLine[], highlight: (code: string) => CodeToken[][] | null): DiffTokens | null {
  if (!lines.length || lines.length > MAX_HIGHLIGHT_LINES) return null;
  const side = (pick: (l: GitDiffLine) => number | null): Map<number, readonly CodeToken[]> | null => {
    const own = lines.filter((l) => pick(l) !== null);
    if (!own.length) return new Map();
    // A carriage return would split a line for the highlighter.
    const tokens = highlight(own.map((l) => l.text.replace(/\r/g, "")).join("\n"));
    if (!tokens || tokens.length !== own.length) return null;
    return new Map(own.map((l, i) => [pick(l)!, tokens[i]!]));
  };
  const oldSide = side((l) => l.oldLine);
  const newSide = side((l) => l.newLine);
  return oldSide && newSide ? { old: oldSide, new: newSide } : null;
}

/** A line's tokens: deleted lines from the old version, the rest from the new one (or the old, for the left side). */
export function tokensOf(tokens: DiffTokens | null, line: GitDiffLine, side: "old" | "new" = line.kind === "del" ? "old" : "new"): readonly CodeToken[] | undefined {
  if (!tokens) return undefined;
  const n = side === "old" ? line.oldLine : line.newLine;
  return n === null ? undefined : (side === "old" ? tokens.old : tokens.new).get(n);
}

/** The new-file line to open the editor at: the given row's, else the next row's that has one, else 1. */
export function editorLine(rows: readonly DiffRow[], at: number | null): number {
  if (at === null) return 1;
  for (let i = Math.max(0, at); i < rows.length; i++) {
    const r = rows[i]!;
    if (r.kind === "line" && r.line.newLine !== null) return r.line.newLine;
  }
  for (let i = Math.min(at, rows.length) - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind === "line" && r.line.newLine !== null) return r.line.newLine;
  }
  return 1;
}
