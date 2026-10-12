import { describe, expect, it } from "vitest";
import { anchorInSource, contextAround } from "./selection.js";

const SRC = ["## 校验结果", "", "发现 **3** 张表的概率之和不为 1：", "", "1. 先修正概率", "2. 再跑一次 `ValidateDropTables`"].join("\n");

describe("anchorInSource", () => {
  it("finds plain text inside the touched blocks", () => {
    const blockStart = SRC.indexOf("1. 先修正");
    const { start, end } = anchorInSource(SRC, "先修正概率", blockStart, SRC.length);
    expect(SRC.slice(start, end)).toBe("先修正概率");
  });

  it("matches rendered text that dropped markdown syntax", () => {
    const blockStart = SRC.indexOf("发现");
    const { start, end } = anchorInSource(SRC, "发现 3 张表", blockStart, SRC.indexOf("：") + 1);
    expect(SRC.slice(start, end)).toBe("发现 **3** 张表");
  });

  it("prefers the occurrence inside the touched blocks", () => {
    const src = "概率\n\n第二段也有概率";
    const second = src.indexOf("第二段");
    expect(anchorInSource(src, "概率", second, src.length).start).toBe(src.lastIndexOf("概率"));
  });

  it("falls back to the block span when nothing matches", () => {
    expect(anchorInSource(SRC, "完全不在里面", 5, 20)).toEqual({ start: 5, end: 20 });
  });
});

describe("contextAround", () => {
  it("returns up to 24 characters on each side", () => {
    const src = "a".repeat(40) + "QUOTE" + "b".repeat(40);
    const { prefix, suffix } = contextAround(src, 40, 45);
    expect(prefix).toBe("a".repeat(24));
    expect(suffix).toBe("b".repeat(24));
    expect(contextAround("QUOTE", 0, 5)).toEqual({ prefix: "", suffix: "" });
  });
});
