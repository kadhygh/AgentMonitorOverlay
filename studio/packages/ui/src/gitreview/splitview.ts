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
 * What a diff's colours need: the old text (unchanged + deleted lines) and the new one (unchanged + added), each
 * highlighted whole so comments and strings spanning lines colour right. A side whose only lines are unchanged ones
 * (nothing deleted, or nothing added) borrows the other side's colours instead of being highlighted again.
 */
function tokenPlan(lines: readonly GitDiffLine[]): { texts: string[]; build(result: readonly (CodeToken[][] | null)[]): DiffTokens | null } | null {
  if (!lines.length || lines.length > MAX_HIGHLIGHT_LINES) return null;
  const oldOwn = lines.filter((l) => l.oldLine !== null);
  const newOwn = lines.filter((l) => l.newLine !== null);
  const needOld = oldOwn.length > 0 && lines.some((l) => l.kind === "del");
  const needNew = newOwn.length > 0 && (!needOld || lines.some((l) => l.kind === "add"));
  // A carriage return would split a line for the highlighter.
  const text = (own: readonly GitDiffLine[]) => own.map((l) => l.text.replace(/\r/g, "")).join("\n");
  const texts = [...(needOld ? [text(oldOwn)] : []), ...(needNew ? [text(newOwn)] : [])];
  const side = (own: readonly GitDiffLine[], pick: (l: GitDiffLine) => number | null, tokens: CodeToken[][] | null | undefined) =>
    tokens && tokens.length === own.length ? new Map<number, readonly CodeToken[]>(own.map((l, i) => [pick(l)!, tokens[i]!])) : null;
  /** The other side's colours for unchanged lines, by this side's numbers. */
  const borrow = (own: readonly GitDiffLine[], pick: (l: GitDiffLine) => number | null, from: ReadonlyMap<number, readonly CodeToken[]>, other: (l: GitDiffLine) => number | null) =>
    new Map<number, readonly CodeToken[]>(own.flatMap((l) => (from.has(other(l)!) ? [[pick(l)!, from.get(other(l)!)!] as const] : [])));
  const oldNo = (l: GitDiffLine) => l.oldLine;
  const newNo = (l: GitDiffLine) => l.newLine;
  return {
    texts,
    build(result) {
      let oldSide = needOld ? side(oldOwn, oldNo, result[0]) : null;
      let newSide = needNew ? side(newOwn, newNo, result[needOld ? 1 : 0]) : null;
      if (needOld && !oldSide) return null;
      if (needNew && !newSide) return null;
      oldSide ??= newSide ? borrow(oldOwn, oldNo, newSide, newNo) : new Map();
      newSide ??= borrow(newOwn, newNo, oldSide, oldNo);
      return { old: oldSide, new: newSide };
    },
  };
}

/** Colours for a full-file diff (see tokenPlan). Null without a grammar, for huge files, and when tokens do not line up. */
export function diffTokens(lines: readonly GitDiffLine[], highlight: (code: string) => CodeToken[][] | null): DiffTokens | null {
  const plan = tokenPlan(lines);
  return plan && plan.build(plan.texts.map(highlight));
}

/** diffTokens with the highlighting done elsewhere (the highlight worker), all texts in one go. */
export async function diffTokensAsync(lines: readonly GitDiffLine[], highlight: (texts: string[]) => Promise<readonly (CodeToken[][] | null)[]>): Promise<DiffTokens | null> {
  const plan = tokenPlan(lines);
  return plan && plan.build(plan.texts.length ? await highlight(plan.texts) : []);
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
