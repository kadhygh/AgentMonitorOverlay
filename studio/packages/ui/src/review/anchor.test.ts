import { describe, expect, it } from "vitest";
import { findInRendered, occurrenceInSource } from "./anchor.js";

const SOURCE = ["发现 **3** 张表：", "", "| 表 | 概率和 |", "| --- | ---: |", "| Boss_Lv20 | 0.97 |", "", "1. 先修正概率", "   - Boss_Lv20 补 0.03"].join("\n");

describe("annotation anchors in rendered text", () => {
  it("counts earlier occurrences from the first block it touches", () => {
    const table = SOURCE.indexOf("| 表");
    const inTable = SOURCE.indexOf("Boss_Lv20");
    const inList = SOURCE.lastIndexOf("Boss_Lv20");
    expect(occurrenceInSource(SOURCE, "Boss_Lv20", table, inTable)).toBe(0);
    expect(occurrenceInSource(SOURCE, "Boss_Lv20", table, inList)).toBe(1);
    expect(occurrenceInSource(SOURCE, "Boss_Lv20", inList, inList)).toBe(0);
  });

  it("finds the quote where markup and cell borders are gone", () => {
    // `**3**` renders as "3"; table cells meet without spaces.
    expect(findInRendered("发现 3 张表：", "发现 3 张表", 0)).toEqual({ start: 0, end: 7 });
    const cells = "表概率和Boss_Lv200.97";
    expect(findInRendered(cells, "Boss_Lv20", 0)).toEqual({ start: 4, end: 13 });
    // A selection across two list items reads "a\nb"; the rendered text has them back to back.
    expect(findInRendered("先修正概率Boss_Lv20 补 0.03", "先修正概率\nBoss_Lv20", 0)).toEqual({ start: 0, end: 14 });
  });

  it("picks the nth occurrence, the last when there are fewer, and null when absent", () => {
    const text = "Boss_Lv20 0.97 … Boss_Lv20 补 0.03";
    expect(findInRendered(text, "Boss_Lv20", 1)?.start).toBe(text.lastIndexOf("Boss_Lv20"));
    expect(findInRendered(text, "Boss_Lv20", 5)?.start).toBe(text.lastIndexOf("Boss_Lv20"));
    expect(findInRendered(text, "Chest", 0)).toBeNull();
    expect(findInRendered(text, "  ", 0)).toBeNull();
  });
});
