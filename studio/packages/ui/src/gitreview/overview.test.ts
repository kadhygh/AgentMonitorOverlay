import { describe, expect, it } from "vitest";
import type { GitDiffLine } from "@amo-studio/protocol";
import { diffRows, type DiffRow } from "./logic.js";
import { changeRuns, chunkRanges, itemTop, maxColumns, pairKinds, rowKinds, rulerMarks, scrollForRuler, textColumns, viewBox, type ChunkBox } from "./overview.js";
import { splitRows } from "./splitview.js";

const line = (kind: GitDiffLine["kind"], text = "x", n = 1): GitDiffLine => ({ kind, oldLine: kind === "add" ? null : n, newLine: kind === "del" ? null : n, text });
const rows = (kinds: GitDiffLine["kind"][]): DiffRow[] => diffRows({ lines: kinds.map((k, i) => line(k, `l${i}`, i + 1)), hunks: [] }, "full");

describe("chunks", () => {
  it("slices items into chunks", () => {
    expect(chunkRanges(0)).toEqual([]);
    expect(chunkRanges(5, 2)).toEqual([
      { start: 0, count: 2 },
      { start: 2, count: 2 },
      { start: 4, count: 1 },
    ]);
    expect(chunkRanges(128)).toHaveLength(2);
  });
});

describe("columns", () => {
  it("counts tabs to the next stop and wide characters twice", () => {
    expect(textColumns("abc")).toBe(3);
    expect(textColumns("\tx")).toBe(9);
    expect(textColumns("ab\tx", 4)).toBe(5);
    expect(textColumns("掉落表")).toBe(6);
    expect(textColumns("a😀")).toBe(3);
  });
  it("finds the widest line", () => {
    expect(maxColumns(diffRows({ lines: [line("context", "short"), line("add", "\t\tdeep"), line("del", "中文")], hunks: [] }, "full"))).toBe(20);
    expect(maxColumns([])).toBe(0);
  });
});

describe("ruler runs", () => {
  it("groups changed rows: added, deleted, or both (modified)", () => {
    const kinds = rowKinds(rows(["context", "add", "add", "context", "del", "context", "del", "add", "context"]));
    expect(changeRuns(kinds)).toEqual([
      { kind: "add", from: 1, to: 3 },
      { kind: "del", from: 4, to: 5 },
      { kind: "mod", from: 6, to: 8 },
    ]);
    expect(changeRuns(rowKinds(rows(["add"])))).toEqual([{ kind: "add", from: 0, to: 1 }]);
  });
  it("reads side-by-side pairs: a deleted line beside an added one is modified", () => {
    const pairs = splitRows(rows(["context", "del", "del", "add", "context", "add"]));
    expect(pairKinds(pairs)).toEqual(["context", "mod", "del", "context", "add"]);
    expect(changeRuns(pairKinds(pairs))).toEqual([
      { kind: "mod", from: 1, to: 3 },
      { kind: "add", from: 4, to: 5 },
    ]);
  });
});

describe("ruler geometry", () => {
  // Two chunks: rows 0–9 in 200px, rows 10–14 in 400px (a long comment in there).
  const chunks: ChunkBox[] = [
    { start: 0, count: 10, top: 4, height: 200 },
    { start: 10, count: 5, top: 204, height: 400 },
  ];
  it("places items inside their chunk", () => {
    expect(itemTop(0, chunks)).toBe(4);
    expect(itemTop(5, chunks)).toBe(104);
    expect(itemTop(10, chunks)).toBe(204);
    expect(itemTop(15, chunks)).toBe(604);
    expect(itemTop(3, [])).toBe(0);
  });
  it("scales runs to the ruler, at least 2px", () => {
    expect(rulerMarks([{ kind: "add", from: 10, to: 15 }], chunks, 644, 322)).toEqual([{ kind: "add", top: 102, height: 200 }]);
    expect(rulerMarks([{ kind: "del", from: 0, to: 0 }], chunks, 644, 322)[0]).toEqual({ kind: "del", top: 2, height: 2 });
    expect(rulerMarks([{ kind: "add", from: 0, to: 1 }], chunks, 0, 322)).toEqual([]);
  });
  it("draws the visible box and maps a point back to a scroll position", () => {
    expect(viewBox(0, 300, 1200, 600)).toEqual({ top: 0, height: 150 });
    expect(viewBox(900, 300, 1200, 600)).toEqual({ top: 450, height: 150 });
    expect(viewBox(0, 300, 200, 600)).toEqual({ top: 0, height: 600 });
    expect(scrollForRuler(300, 600, 1200, 300)).toBe(450);
    expect(scrollForRuler(0, 600, 1200, 300)).toBe(0);
    expect(scrollForRuler(600, 600, 1200, 300)).toBe(900);
    expect(scrollForRuler(-20, 600, 1200, 300)).toBe(0);
  });
});
