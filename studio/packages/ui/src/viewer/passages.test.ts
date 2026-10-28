import { describe, expect, it } from "vitest";
import { composeGitReviewMessage } from "@amo-studio/protocol";
import { passageKit } from "./passageKit.js";
import { frameDoc, sourceCandidates, sourceLine } from "./passages.js";

// 渲染批注 (2026-10-28): passages of rendered Markdown and HTML.

describe("passages of a rendered file", () => {
  it("finds a passage again by its words, the context choosing between repeats", () => {
    const { locate } = passageKit();
    const text = "数值 A 偏高。 数值 B 偏高。 结论：数值 B 偏高，下调。";
    expect(locate(text, { quote: "数值 B 偏高", prefix: "", suffix: "，下调" })?.start).toBe(text.lastIndexOf("数值 B 偏高"));
    expect(locate(text, { quote: "数值 B 偏高", prefix: "偏高。 ", suffix: "。 结论" })?.start).toBe(text.indexOf("数值 B 偏高"));
    // Re-wrapped words still match, a space gained or lost too; gone ones do not.
    expect(locate(text, { quote: "数值   A\n偏高", prefix: "", suffix: "" })).toEqual({ start: 0, end: 7 });
    expect(locate("先看 数据。", { quote: "先看数据", prefix: "", suffix: "。" })).toEqual({ start: 0, end: 5 });
    expect(locate(text, { quote: "数值 C", prefix: "", suffix: "" })).toBeNull();
  });

  it("guesses the source line a passage starts on, through Markdown marks and HTML tags", () => {
    const md = "# 标题\n\n第一段。\n\n这里有 **加粗的** 词和 `代码`。\n";
    expect(sourceLine(md, "第一段。", false)).toBe(3);
    expect(sourceLine(md, "这里有 加粗的 词和 代码。", false)).toBe(5);
    const html = "<!doctype html>\n<body>\n<h1>结论</h1>\n<p>掉率 <b>0.15</b> 比较合适，\n见下表。</p>\n</body>";
    expect(sourceLine(html, "掉率 0.15 比较合适， 见下表。", true)).toBe(4);
    expect(sourceLine(html, "完全不在文件里", true)).toBe(1);
  });

  it("looks for an HTML file's Markdown in its meta, beside it, then in its footer", () => {
    const html = `<html><head><meta name="amo-source" content="../plans/a.md"></head><body>…<footer>取材：plans/b.md、G:\\docs\\c.md</footer></body></html>`;
    expect(sourceCandidates(html, "out/html/a.html")).toEqual(["out/plans/a.md", "out/html/a.md", "out/html/plans/b.md", "plans/b.md", "G:/docs/c.md"]);
    // No footer element: the end of the page.
    expect(sourceCandidates("<p>源文件 notes.md</p>", "x.html")).toEqual(["x.md", "notes.md"]);
  });

  it("puts its script first in the page, whole", () => {
    const page = frameDoc("<!doctype html><html><head><title>t</title><script>window.mine=1</script></head><body>x</body></html>");
    expect(page.indexOf("amoPassage")).toBeLessThan(page.indexOf("window.mine"));
    expect(page.startsWith("<!doctype html><html><head><script>(")).toBe(true);
    const ours = page.slice(page.indexOf("<script>") + 8, page.indexOf("</script>"));
    expect(() => new Function(ours)).not.toThrow();
    expect(frameDoc("<p>bare</p>")).toMatch(/^<script>[\s\S]*<\/script><p>bare<\/p>$/);
  });

  it("names the passage and, for HTML made from Markdown, the Markdown to change", () => {
    const at = "2026-10-28T00:00:00.000Z";
    const text = composeGitReviewMessage(
      [
        { path: "out/a.html", side: "new", line: 4, lineText: "掉率 0.15 比较合适", note: "再低一点", createdAt: at, range: "file", passage: { quote: "掉率 0.15 比较合适", prefix: "", suffix: "", source: "plans/a.md" } },
        { path: "out/a.html", side: "new", line: 9, lineText: "<td>x</td>", note: "这行的标签", createdAt: at, range: "file" },
      ],
      "game",
    );
    expect(text).toBe(
      "文件批注：我看了「game」的文件，有 2 条批注。\n\n### out/a.html\n\n这份 HTML 由 `plans/a.md` 生成：请改 `plans/a.md`，再重新生成这份 HTML。\n\nout/a.html（渲染后的段落，源码约第 4 行）\n> 掉率 0.15 比较合适\n再低一点\n\nout/a.html:9\n> <td>x</td>\n这行的标签",
    );
  });
});
