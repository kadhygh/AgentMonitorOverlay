import { describe, expect, it } from "vitest";
import type { FileNote, Message, Thread } from "./protocol.js";
import { carriedNotes, fileNotesText, noteLine, notePlaces, notesAsText, threadAsText } from "./usage.js";

const note = (id: string, quote: string, body: string, extra: Partial<FileNote> = {}): FileNote => ({ id, fileId: "f1", version: 1, author: "程序老李", quote, prefix: "", suffix: "", body, at: 10, ...extra });

const md = "# 加特林\n\n## 射速\n\n基础射速**每秒 12 发**，过热后降到 6 发。\n\n## 过热\n\n- 连射 3 秒开始升温\n- 每秒 12 发时最快\n";

describe("noteLine (2026-11-05: 复制给 AI carries the notes with 文件:行)", () => {
  it("finds the line of the words as shown, Markdown marks and all", () => {
    expect(noteLine(md, { quote: "过热后降到 6 发" })).toBe(5);
    // The quote crosses the ** marks: its longest piece is looked for.
    expect(noteLine(md, { quote: "基础射速每秒 12 发" })).toBe(5);
    expect(noteLine(md, { quote: "连射 3 秒开始升温" })).toBe(9);
  });
  it("picks the match whose context fits, and says null when the words are gone", () => {
    expect(noteLine(md, { quote: "每秒 12 发", prefix: "- ", suffix: "时最快" })).toBe(10);
    expect(noteLine(md, { quote: "每秒 12 发", prefix: "基础射速", suffix: "，过热后" })).toBe(5);
    expect(noteLine(md, { quote: "换弹两秒" })).toBeNull();
  });
  it("reads HTML text between tags", () => {
    expect(noteLine("<html>\n<body>\n<p>原型说明：枪管发红</p>\n</body></html>", { quote: "枪管发红" })).toBe(3);
  });
});

describe("notes in copied text", () => {
  const file = { name: "designdoc.md", version: 2 };
  it("writes each note as Reviewer does: 文件:行, the words after >, what was said", () => {
    const text = notesAsText(file, [note("n1", "过热后降到 6 发", "降速曲线建议配表", { version: 2 }), note("n2", "换弹两秒", "这段删了？")], md);
    expect(text).toContain("designdoc.md:5\n> 过热后降到 6 发\n降速曲线建议配表（程序老李）");
    expect(text).toContain("designdoc.md（写在 v1 上，v2 里没找到这段原文）\n> 换弹两秒");
  });
  it("lists the notes the messages do not carry, and gives the carried ones their lines", () => {
    const files = [{ file, notes: [note("n1", "过热后降到 6 发", "降速曲线建议配表", { version: 2 }), note("n2", "连射 3 秒开始升温", "3 秒太短", { author: "策划小王" })], source: md }];
    const reply: Message = { id: "m2", threadId: "t", seq: 2, author: "程序老李", via: { kind: "person" }, kind: "reply", body: "看了", notes: [{ noteId: "n1", fileId: "f1", file: "designdoc.md", version: 2, author: "程序老李", quote: "过热后降到 6 发", body: "降速曲线建议配表" }], createdAt: 20 };
    const thread = { id: "t", kind: "request", title: "射速", members: ["策划小王", "程序老李"], request: { from: "策划小王", to: "程序老李", state: "returned", handler: "ai" } } as unknown as Thread;
    const carried = carriedNotes([reply]);
    const text = threadAsText(thread, [reply], undefined, notePlaces(files));
    expect(text).toContain("附上的批注（1 条）：\n\ndesigndoc.md:5\n> 过热后降到 6 发");
    const rest = fileNotesText(files, carried);
    expect(rest).toContain("## 附件上的批注（1 条）");
    expect(rest).toContain("designdoc.md:9（写在 v1 上，行号按 v2）\n> 连射 3 秒开始升温\n3 秒太短（策划小王）");
    expect(rest).not.toContain("降速曲线建议配表");
    expect(fileNotesText([{ file, notes: [note("n1", "x", "y")] }], new Set(["n1"]))).toBe("");
  });
});
