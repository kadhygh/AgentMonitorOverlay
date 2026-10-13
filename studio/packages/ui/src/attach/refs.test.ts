import { describe, expect, it } from "vitest";
import { baseName, dirName, formatBytes, formatWhen, splitFileRefs, withFileRefs } from "./refs.js";

describe("file references in a message", () => {
  it("appends the paths as a block and reads them back", () => {
    const sent = withFileRefs("看看这两个文件 ", ["C:\\work\\a.ts", "C:\\work\\src\\b.ts", "C:\\work\\a.ts"]);
    expect(sent).toBe("看看这两个文件\n\n引用文件：\n- C:\\work\\a.ts\n- C:\\work\\src\\b.ts");
    expect(splitFileRefs(sent)).toEqual({ text: "看看这两个文件", files: ["C:\\work\\a.ts", "C:\\work\\src\\b.ts"] });
  });

  it("works without text, and leaves messages without a block alone", () => {
    expect(withFileRefs("", ["D:/x.md"])).toBe("引用文件：\n- D:/x.md");
    expect(splitFileRefs("引用文件：\n- D:/x.md")).toEqual({ text: "", files: ["D:/x.md"] });
    expect(withFileRefs("hi", [])).toBe("hi");
    expect(splitFileRefs("hi")).toEqual({ text: "hi", files: [] });
  });

  it("only takes a well-formed block at the end", () => {
    // Quoting the heading mid-line, or a block followed by other text, is not a reference list.
    expect(splitFileRefs("他说 引用文件：\n- a").files).toEqual([]);
    expect(splitFileRefs("引用文件：\n- a\n然后呢").files).toEqual([]);
    expect(splitFileRefs("引用文件：\n").files).toEqual([]);
    // CRLF from a pasted message still reads back.
    expect(splitFileRefs("x\r\n\r\n引用文件：\r\n- a\r\n- b")).toEqual({ text: "x", files: ["a", "b"] });
  });
});

describe("path and size labels", () => {
  it("splits names and folders on either slash", () => {
    expect(baseName("C:\\work\\src\\b.ts")).toBe("b.ts");
    expect(baseName("src/b.ts")).toBe("b.ts");
    expect(baseName("C:\\work\\src\\")).toBe("src");
    expect(dirName("C:\\work\\src\\b.ts")).toBe("C:\\work\\src");
    expect(dirName("b.ts")).toBe("");
  });

  it("says when a file changed", () => {
    const now = new Date(2026, 9, 13, 22, 0);
    expect(formatWhen(new Date(2026, 9, 13, 21, 59, 40).toISOString(), now)).toBe("刚刚");
    expect(formatWhen(new Date(2026, 9, 13, 21, 55).toISOString(), now)).toBe("5 分钟前");
    expect(formatWhen(new Date(2026, 9, 13, 19, 0).toISOString(), now)).toBe("3 小时前");
    expect(formatWhen(new Date(2026, 9, 12, 23, 0).toISOString(), now)).toBe("昨天");
    expect(formatWhen(new Date(2026, 9, 1, 9, 0).toISOString(), now)).toBe("10-01");
    expect(formatWhen(new Date(2025, 9, 1, 9, 0).toISOString(), now)).toBe("2025-10-01");
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(12_800)).toBe("13 KB");
    expect(formatBytes(3.4 * 1024 * 1024)).toBe("3.4 MB");
    expect(formatBytes(40 * 1024 * 1024)).toBe("40 MB");
  });
});
