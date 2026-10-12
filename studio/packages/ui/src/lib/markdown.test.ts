import { describe, expect, it } from "vitest";
import { parseBlocks, type Block } from "./markdown.js";

const kinds = (blocks: Block[]) => blocks.map((b) => b.kind);
/** The source slice a block covers must be exactly its markdown, so annotations can anchor to it. */
const slice = (src: string, b: Block) => src.slice(b.start, b.end);

describe("parseBlocks", () => {
  it("splits fenced code, headings, lists, quotes and paragraphs with source ranges", () => {
    const src = ["# 标题", "", "第一段", "继续", "", "- a", "- b", "", "> 引用", "> 第二行", "", "```ts", "const x = 1;", "```", "尾段"].join("\n");
    const blocks = parseBlocks(src);
    expect(kinds(blocks)).toEqual(["heading", "paragraph", "list", "quote", "code", "paragraph"]);
    expect(blocks.map((b) => slice(src, b))).toEqual(["# 标题", "第一段\n继续", "- a\n- b", "> 引用\n> 第二行", "```ts\nconst x = 1;\n```", "尾段"]);
    expect(blocks[3]).toMatchObject({ kind: "quote", text: "引用\n第二行" });
    expect(blocks[4]).toMatchObject({ kind: "code", lang: "ts", text: "const x = 1;" });
  });

  it("nests indented list items", () => {
    const blocks = parseBlocks(["1. 准备", "   - 读配置", "   - 读表", "2. 执行", "- 另一个列表"].join("\n"));
    expect(blocks).toHaveLength(1);
    const list = (blocks[0] as Extract<Block, { kind: "list" }>).list;
    expect(list.ordered).toBe(true);
    expect(list.items.map((i) => i.text)).toEqual(["准备", "执行", "另一个列表"]);
    expect(list.items[0]!.children).toEqual({ ordered: false, items: [{ text: "读配置", children: null }, { text: "读表", children: null }] });
  });

  it("parses pipe tables and pads short rows", () => {
    const src = ["| 表 | 概率和 |", "| --- | ---: |", "| Boss_Lv20 | 0.97 |", "| Chest_Rare |"].join("\n");
    const [table] = parseBlocks(src);
    expect(table).toMatchObject({ kind: "table", header: ["表", "概率和"], rows: [["Boss_Lv20", "0.97"], ["Chest_Rare", ""]] });
    expect(slice(src, table!)).toBe(src);
  });

  it("does not treat a lone pipe line as a table", () => {
    expect(kinds(parseBlocks("a | b\nnext line"))).toEqual(["paragraph"]);
  });

  it("keeps an unterminated fence as code (streaming replies)", () => {
    expect(parseBlocks("```\npartial")).toMatchObject([{ kind: "code", lang: "", text: "partial" }]);
  });

  it("treats html as plain text", () => {
    expect(parseBlocks("<script>alert(1)</script>")).toMatchObject([{ kind: "paragraph", text: "<script>alert(1)</script>" }]);
  });

  it("reports ranges against the LF-normalised text", () => {
    const blocks = parseBlocks("a\r\n\r\nb");
    expect(blocks.map((b) => [b.start, b.end])).toEqual([
      [0, 1],
      [3, 4],
    ]);
  });
});
