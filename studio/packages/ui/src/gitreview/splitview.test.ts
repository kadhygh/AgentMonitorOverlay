import { describe, expect, it } from "vitest";
import { diffHunks, type GitDiffLine } from "@amo-studio/protocol";
import type { CodeToken } from "../lib/highlight.js";
import { diffRows } from "./logic.js";
import { diffTokens, editorLine, MAX_HIGHLIGHT_LINES, splitRows, tokensOf, type SplitRow } from "./splitview.js";

const ctx = (o: number, n: number, text = `c${n}`): GitDiffLine => ({ kind: "context", oldLine: o, newLine: n, text });
const del = (o: number, text = `old${o}`): GitDiffLine => ({ kind: "del", oldLine: o, newLine: null, text });
const add = (n: number, text = `new${n}`): GitDiffLine => ({ kind: "add", oldLine: null, newLine: n, text });

// Old: c1 old2 old3 old4 c5 … ; new: c1 new2 c… new8 ; one block replaces 3 lines with 1, another adds a line.
const lines: GitDiffLine[] = [ctx(1, 1), del(2), del(3), del(4), add(2), ctx(5, 3), ctx(6, 4), ctx(7, 5), ctx(8, 6), ctx(9, 7), add(8), ctx(10, 9)];
const diff = { lines, hunks: diffHunks(lines) };

const show = (rows: SplitRow[]) => rows.map((r) => (r.kind === "hunk" ? r.header : `${r.left?.row.key ?? "·"} | ${r.right?.row.key ?? "·"}`));

describe("左右对照 rows", () => {
  it("pairs deleted with added lines inside a change and fills the shorter side with blanks", () => {
    expect(show(splitRows(diffRows(diff, "full")))).toEqual([
      "new:1 | new:1",
      "old:2 | new:2",
      "old:3 | ·",
      "old:4 | ·",
      "new:3 | new:3",
      "new:4 | new:4",
      "new:5 | new:5",
      "new:6 | new:6",
      "new:7 | new:7",
      "· | new:8",
      "new:9 | new:9",
    ]);
  });

  it("keeps hunk headers and the unified row index of each side (n / p and scrolling use it)", () => {
    const rows = diffRows(diff, "changes");
    const split = splitRows(rows);
    expect(split.filter((r) => r.kind === "hunk")).toHaveLength(rows.filter((r) => r.kind === "hunk").length);
    for (const r of split) {
      if (r.kind === "hunk") expect(rows[r.index]!.kind).toBe("hunk");
      else for (const cell of [r.left, r.right]) if (cell) expect(rows[cell.index]).toBe(cell.row);
    }
    // More adds than deletes: the extra add gets a blank on the left.
    expect(show(splitRows(diffRows({ lines: [del(1), add(1), add(2), ctx(2, 3)], hunks: [] }, "full")))).toEqual(["old:1 | new:1", "· | new:2", "new:3 | new:3"]);
  });
});

describe("diff colours", () => {
  // A fake highlighter: one token per line, tagged with the text it was given as a whole.
  const calls: string[] = [];
  const fake = (code: string): CodeToken[][] => {
    calls.push(code);
    return code.split("\n").map((l) => [{ text: l, color: "var(--shiki-token-keyword)" }]);
  };

  it("highlights the old and the new text whole and maps tokens back by line number", () => {
    calls.length = 0;
    const t = diffTokens(lines, fake)!;
    expect(calls).toEqual(["c1\nold2\nold3\nold4\nc3\nc4\nc5\nc6\nc7\nc9", "c1\nnew2\nc3\nc4\nc5\nc6\nc7\nnew8\nc9"]);
    expect(tokensOf(t, del(3))).toEqual([{ text: "old3", color: "var(--shiki-token-keyword)" }]);
    expect(tokensOf(t, add(8))?.[0]?.text).toBe("new8");
    // An unchanged line: new numbering by default, the old one for the left side.
    expect(tokensOf(t, ctx(10, 9))?.[0]?.text).toBe("c9");
    expect(tokensOf(t, ctx(5, 3), "old")?.[0]?.text).toBe("c3");
    expect(tokensOf(null, ctx(1, 1))).toBeUndefined();
  });

  it("drops carriage returns and gives up when the highlighter is not ready or lines do not match", () => {
    calls.length = 0;
    diffTokens([ctx(1, 1, "a\r"), add(2, "b\r")], fake);
    expect(calls).toEqual(["a", "a\nb"]);
    expect(diffTokens(lines, () => null)).toBeNull();
    expect(diffTokens(lines, () => [[{ text: "x" }]])).toBeNull();
    expect(diffTokens([], fake)).toBeNull();
    const huge = Array.from({ length: MAX_HIGHLIGHT_LINES + 1 }, (_, i) => ctx(i + 1, i + 1));
    expect(diffTokens(huge, fake)).toBeNull();
  });
});

describe("open in VS Code", () => {
  it("opens at the active row's new line, the next one for a deleted line, else line 1", () => {
    const rows = diffRows(diff, "full");
    expect(editorLine(rows, null)).toBe(1);
    expect(editorLine(rows, 0)).toBe(1);
    expect(editorLine(rows, 1)).toBe(2); // old:2 deleted → new:2 follows
    expect(editorLine(rows, 10)).toBe(8);
    expect(editorLine(diffRows({ lines: [ctx(1, 1), del(2)], hunks: [] }, "full"), 1)).toBe(1);
  });
});
