import { describe, expect, it } from "vitest";
import { composeRemoteReviewMessage } from "./remote.js";

// 远程 Reviewer 的批注 (2026-11-02): copied out, paths start at 任务文件夹/ and the project is named by the computer;
// sent to the task's conversation, they stay as its session reads them.
describe("composeRemoteReviewMessage", () => {
  const at = "2026-11-02T00:00:00.000Z";
  const md = { range: "file" as const, path: "docs/plan.md", side: "new" as const, line: 4, lineText: "旧的", note: "改一下", createdAt: at };
  const html = { range: "file" as const, path: "out/plan.html", side: "new" as const, line: 9, lineText: "", note: "这段太长", createdAt: at, passage: { quote: "很长的一段", prefix: "", suffix: "", source: "docs/plan.md" } };

  it("copies with 任务文件夹/ paths and the computer's name", () => {
    const text = composeRemoteReviewMessage([md, html], "台式机", true);
    expect(text).toContain("「台式机 上的任务文件夹」的文件");
    expect(text).toContain("### 任务文件夹/docs/plan.md");
    expect(text).toContain("任务文件夹/docs/plan.md:4");
    // An HTML made from Markdown names the Markdown under the folder too.
    expect(text).toContain("请改 `任务文件夹/docs/plan.md`");
    // Already under the folder, or with backslashes: named once, with slashes.
    expect(composeRemoteReviewMessage([{ ...md, path: "任务文件夹/a.md" }, { ...md, path: "b\\c.md" }], "台式机", true)).toMatch(/### 任务文件夹\/a\.md[\s\S]*### 任务文件夹\/b\/c\.md/);
  });

  it("sends with the paths the task's session reads", () => {
    const text = composeRemoteReviewMessage([md], "台式机", false);
    expect(text).toContain("「任务文件夹」的文件");
    expect(text).toContain("### docs/plan.md");
    expect(text).not.toContain("台式机");
  });
});
