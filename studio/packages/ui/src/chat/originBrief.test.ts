import { describe, expect, it } from "vitest";
import { originBrief } from "./originBrief.js";

describe("what a folded message from an agent shows", () => {
  it("drops Markdown marks, keeps names with underscores", () => {
    expect(originBrief({ kind: "report", from: "数表", state: "done" }, "## 结果\n\n- **3 张**表，见 `drop_table.xlsx`\n- 用了 session_start\n\n```ts\nconst a = 1;\n```")).toBe("结果\n3 张表，见 drop_table.xlsx\n用了 session_start\n [代码]");
  });

  it("of a 中转 reply: what the other side said, not the lines for the model", () => {
    const body = [
      "",
      "程序老李 回复了你发的会话「背包上限存哪」（threadId t_1）。下面只有你上次发言之后的新内容，之前的你已经看过（要看全文，用 team_session（threadId t_1））。按回复接着推进。",
      "",
      "## 会话：背包上限存哪",
      "策划小王 → 程序老李 · 已返回给 策划小王（需要改），由 AI 接着处理 · 需要回复 · threadId t_1",
      "",
      "**程序老李 · 2026-11-15 02:04 · #4 · 回复**",
      "运营会调上限。",
      "",
      "（AMO Studio 从中转转回来的，你用的是 策划小王 的身份。要追问用 team_followup。）",
    ].join("\n");
    expect(originBrief({ kind: "team", from: "程序老李", threadIds: ["t_1"] }, body)).toBe("程序老李 · 2026-11-15 02:04 · #4 · 回复\n运营会调上限。");
  });
});
