import { describe, expect, it } from "vitest";
import { composeAnnotationRefs, splitAnnotationRefs } from "./api.js";

describe("annotation references in a message", () => {
  it("puts the referenced annotations after the text, numbered, and reads them back", () => {
    const refs = [
      { n: 2, quote: "第二行\n第三行", note: "这里换成表驱动" },
      { n: 1, quote: "先读配置", note: "配置可能为空" },
    ];
    const message = composeAnnotationRefs("按这两条改一下", refs);
    expect(message).toBe("按这两条改一下\n\n【引用的批注】\n【批注1】针对你回复中的这段：\n> 先读配置\n我的批注：配置可能为空\n\n【批注2】针对你回复中的这段：\n> 第二行\n> 第三行\n我的批注：这里换成表驱动");
    expect(splitAnnotationRefs(message)).toEqual({ text: "按这两条改一下", refs: [refs[1], refs[0]] });
  });

  it("works with no text of the person's own, and leaves other messages alone", () => {
    const message = composeAnnotationRefs("  ", [{ n: 3, quote: "q", note: "第一行\n第二行" }]);
    expect(message.startsWith("【引用的批注】\n【批注3】")).toBe(true);
    expect(splitAnnotationRefs(message)).toEqual({ text: "", refs: [{ n: 3, quote: "q", note: "第一行\n第二行" }] });
    expect(splitAnnotationRefs("普通消息\n\n【引用的批注】\n随便写的")).toEqual({ text: "普通消息\n\n【引用的批注】\n随便写的", refs: [] });
    expect(composeAnnotationRefs("只有文字", [])).toBe("只有文字");
  });
});
