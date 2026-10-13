import { describe, expect, it } from "vitest";
import { baseName, dirName, formatBytes, formatFileRef, formatWhen, parseFileRef, splitFileRefItems, splitFileRefs, withFileRefs } from "./refs.js";

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

describe("marked file references (S12-D)", () => {
  it("writes a mark's range and note on its line and reads them back", () => {
    const sent = withFileRefs("改这里", [{ path: "C:\\game\\drop.lua", startLine: 12, endLine: 30, note: "掉落表\n别动 boss" }, "C:\\game\\a.ts", { path: "C:\\game\\b.ts", note: "" }]);
    expect(sent).toBe("改这里\n\n引用文件：\n- C:\\game\\drop.lua:12-30（说明：掉落表 别动 boss）\n- C:\\game\\a.ts\n- C:\\game\\b.ts");
    expect(splitFileRefItems(sent)).toEqual({
      text: "改这里",
      refs: [{ path: "C:\\game\\drop.lua", startLine: 12, endLine: 30, note: "掉落表 别动 boss" }, { path: "C:\\game\\a.ts" }, { path: "C:\\game\\b.ts" }],
    });
    // Paths only, for the readers that do not show notes.
    expect(splitFileRefs(sent).files).toEqual(["C:\\game\\drop.lua", "C:\\game\\a.ts", "C:\\game\\b.ts"]);
  });

  it("formats one line, a note with brackets, and leaves drive letters alone", () => {
    expect(formatFileRef({ path: "D:/x.md", startLine: 3 })).toBe("D:/x.md:3");
    expect(parseFileRef("D:/x.md:3")).toEqual({ path: "D:/x.md", startLine: 3, endLine: null });
    expect(parseFileRef("C:\\work（说明：见（附录）里的表）")).toEqual({ path: "C:\\work", note: "见（附录）里的表" });
    expect(parseFileRef("C:\\work\\a.ts")).toEqual({ path: "C:\\work\\a.ts" });
    // The same file with the same note is listed once.
    expect(withFileRefs("", [{ path: "a", note: "x" }, { path: "a", note: "x" }])).toBe("引用文件：\n- a（说明：x）");
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
