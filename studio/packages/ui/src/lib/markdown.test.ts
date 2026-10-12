import { describe, expect, it } from "vitest";
import { parseBlocks } from "./markdown.js";

describe("parseBlocks", () => {
  it("splits fenced code, headings, lists, quotes and paragraphs", () => {
    const blocks = parseBlocks(["# 标题", "", "第一段", "继续", "", "- a", "- b", "1. one", "", "> 引用", "", "```ts", "const x = 1;", "", "```", "尾段"].join("\n"));
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "标题" },
      { kind: "paragraph", text: "第一段\n继续" },
      { kind: "list", ordered: false, items: ["a", "b"] },
      { kind: "list", ordered: true, items: ["one"] },
      { kind: "quote", text: "引用" },
      { kind: "code", lang: "ts", text: "const x = 1;\n" },
      { kind: "paragraph", text: "尾段" },
    ]);
  });

  it("keeps an unterminated fence as code (streaming replies)", () => {
    expect(parseBlocks("```\npartial")).toEqual([{ kind: "code", lang: "", text: "partial" }]);
  });

  it("treats html as plain text", () => {
    expect(parseBlocks("<script>alert(1)</script>")).toEqual([{ kind: "paragraph", text: "<script>alert(1)</script>" }]);
  });
});
