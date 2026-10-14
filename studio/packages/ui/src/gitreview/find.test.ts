import { describe, expect, it } from "vitest";
import { FIND_MAX, findMatches, firstFrom, matchLabel, stepMatch } from "./find.js";

describe("Ctrl+F (S14-A)", () => {
  const texts = ["local Drop = {}", "", "drop.rate = 0.25 -- DROP", "return Drop"];

  it("finds every match, row by row, case aside unless asked", () => {
    expect(findMatches(texts, "drop")).toEqual([
      { row: 0, start: 6, end: 10 },
      { row: 2, start: 0, end: 4 },
      { row: 2, start: 20, end: 24 },
      { row: 3, start: 7, end: 11 },
    ]);
    expect(findMatches(texts, "Drop", true).map((m) => m.row)).toEqual([0, 3]);
    expect(findMatches(texts, "")).toEqual([]);
    expect(findMatches(["aaaa"], "aa")).toEqual([
      { row: 0, start: 0, end: 2 },
      { row: 0, start: 2, end: 4 },
    ]);
  });

  it("stops counting at the limit", () => {
    expect(findMatches(["x".repeat(FIND_MAX + 10)], "x")).toHaveLength(FIND_MAX);
    expect(matchLabel(FIND_MAX, 0)).toBe(`第 1 / 共 ${FIND_MAX}+ 个`);
  });

  it("starts at the row in view and wraps around", () => {
    const m = findMatches(texts, "drop");
    expect(firstFrom(m, 1)).toBe(1);
    expect(firstFrom(m, 9)).toBe(0);
    expect(firstFrom([], 0)).toBe(-1);
    expect(stepMatch(4, 3, 1)).toBe(0);
    expect(stepMatch(4, 0, -1)).toBe(3);
    expect(stepMatch(0, 0, 1)).toBe(-1);
    expect(matchLabel(4, 1)).toBe("第 2 / 共 4 个");
    expect(matchLabel(0, -1)).toBe("无结果");
  });
});
