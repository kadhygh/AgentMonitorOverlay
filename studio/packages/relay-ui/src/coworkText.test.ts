import { describe, expect, it } from "vitest";
import { agentChip, agentRoute, agentWhat, atQuery, deliverySteps, matchTargets, mentionsIn, type MentionTarget } from "./coworkText.js";

const at = new Date(2026, 10, 23, 9, 30).getTime();

describe("协作: an agent's state, and what an @ does", () => {
  it("says each state with its mark and what follows an @", () => {
    expect(agentChip({ state: "busy", queued: 1, lastSeen: at })).toBe("◐ 处理中 · 前面 1 条");
    expect(agentChip({ state: "offline", queued: 0, lastSeen: at })).toBe("○ 不在线 · 09:30");
    expect(agentChip({ state: "idle", queued: 0, lastSeen: at })).toBe("✓ 待命");
    expect(agentWhat({ state: "idle", queued: 0, lastSeen: at })).toBe("马上送进它的会话，开一轮");
    expect(agentWhat({ state: "offline", queued: 0, lastSeen: at })).toContain("上次在线 09:30");
    expect(agentRoute({ state: "busy", queued: 1, lastSeen: at, name: "程序老李 的 AI · 加特林实现" })).toBe("程序老李 的 AI · 加特林实现 正在处理（前面 1 条），你这句会在它这一轮之后送到");
  });

  it("walks a delivery through 排队中 → 已送达 → 已回复", () => {
    expect(deliverySteps({ state: "delivered", createdAt: 1, deliveredAt: 2, repliedAt: null }).map((s) => s.done)).toEqual([true, true, false]);
    expect(deliverySteps({ state: "replied", createdAt: 1, deliveredAt: 2, repliedAt: 3 }).map((s) => s.done)).toEqual([true, true, true]);
  });
});

describe("协作: the @-s in what is typed", () => {
  const targets: MentionTarget[] = [
    { text: "程序老李", kind: "person", id: "程序老李" },
    { text: "美术小周", kind: "person", id: "美术小周" },
    { text: "程序老李 的 AI · 加特林实现", kind: "agent", id: "studio:d1:s-1" },
  ];
  it("tells the agent from its owner, and finds each once", () => {
    expect(mentionsIn("@程序老李 的 AI · 加特林实现 回落改 1.2 秒", targets)).toEqual({ mentions: [], agentMentions: ["studio:d1:s-1"] });
    expect(mentionsIn("@程序老李 看一下，@程序老李 的 AI · 加特林实现 也看 @程序老李", targets)).toEqual({ mentions: ["程序老李"], agentMentions: ["studio:d1:s-1"] });
    expect(mentionsIn("没有提到谁", targets)).toEqual({ mentions: [], agentMentions: [] });
  });

  it("finds the @ being typed, not an e-mail address or a finished line", () => {
    expect(atQuery("回落定了以后 @程序", 10)).toEqual({ start: 7, query: "程序" });
    expect(atQuery("mail a@b.com", 12)).toBeNull();
    expect(atQuery("@某人\n下一行", 7)).toBeNull();
    expect(matchTargets(targets, "加特林").map((t) => t.id)).toEqual(["studio:d1:s-1"]);
    expect(matchTargets(targets, "")).toHaveLength(3);
  });
});
