import { describe, expect, it } from "vitest";
import { messageOrigin } from "@amo-studio/protocol";
import { originBrief } from "./originBrief.js";

describe("what a folded message from an agent shows", () => {
  // 2026-11-24 (plans/collab-agent-spec.md §2): the wake message shows who said what, not its frame.
  it("shows a 协作 wake as who said what", () => {
    const text = ["【协作「射速」· 你的角色：主控】", "", "你是「策划小王」这一方的主控。", "", "【协作 · 待你处理】「射速」（cowork:t_1）", "为什么现在叫你：程序老李 @ 了你（#12）", "待你处理（1）：", "- #12 程序老李 @ 你（在 群聊；回：cowork_post replyTo 12）：", "  ### 程序老李 · 群聊 · 11-24 10:42 · #12", "  上限放配置表行吗？", "这一轮结束前：回复过的会自动标成处理了。"].join("\n");
    expect(originBrief({ kind: "cowork", from: "程序老李", cowork: { id: "t_1", title: "射速", where: "在群聊里 @ 了你" } }, text)).toBe("程序老李：\n上限放配置表行吗？");
    // As the conversation gives it: messageOrigin took the card's 【…】 line as the row's head.
    const row = messageOrigin({ text, origin: { kind: "cowork", from: "程序老李" } })!;
    expect(row.body.startsWith("\n你是")).toBe(true);
    expect(originBrief(row.origin, row.body)).toBe("程序老李：\n上限放配置表行吗？");
  });

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
