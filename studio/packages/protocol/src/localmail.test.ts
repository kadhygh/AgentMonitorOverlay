import { describe, expect, it } from "vitest";
import { deliveryMode, isQueued, matterRef, messageRef, sinceLine, titleFrom } from "./localmail.js";

// 本机的事项和消息 (2026-11-25): the distance rule and the small readers the Host and the page share.

describe("deliveryMode (按距离)", () => {
  const t = (id: string, topicId: string | null, relayAuto?: boolean) => ({ id, topicId, ...(relayAuto !== undefined ? { relayAuto } : {}) });
  it("the person's go at once; the same task at once; the same topic unless 先问; farther waits unless the task takes them", () => {
    expect(deliveryMode({ fromPerson: true, fromTask: null, fromTopicId: null, toTask: t("b", null, false), toTopicId: null })).toBe("auto");
    expect(deliveryMode({ fromTask: t("a", "tp"), fromTopicId: "tp", toTask: t("a", "tp", false), toTopicId: null })).toBe("auto");
    expect(deliveryMode({ fromTask: t("a", "tp"), fromTopicId: "tp", toTask: t("b", "tp"), toTopicId: null })).toBe("auto");
    expect(deliveryMode({ fromTask: t("a", "tp"), fromTopicId: "tp", toTask: t("b", "tp", false), toTopicId: null })).toBe("ask");
    expect(deliveryMode({ fromTask: t("a", "tp"), fromTopicId: "tp", toTask: t("b", "other"), toTopicId: null })).toBe("ask");
    expect(deliveryMode({ fromTask: t("a", null), fromTopicId: null, toTask: t("b", null), toTopicId: null })).toBe("ask");
    expect(deliveryMode({ fromTask: t("a", null), fromTopicId: null, toTask: t("b", null, true), toTopicId: null })).toBe("auto");
    // A topic's own session, from a task of it.
    expect(deliveryMode({ fromTask: t("a", "tp"), fromTopicId: "tp", toTask: null, toTopicId: "tp" })).toBe("auto");
    expect(deliveryMode({ fromTask: t("a", "x"), fromTopicId: "x", toTask: null, toTopicId: "tp" })).toBe("ask");
  });
});

describe("refs and lines", () => {
  it("reads 「事项 3」 and 「#7」 as people and agents write them", () => {
    expect(matterRef("事项 3")).toEqual({ no: 3 });
    expect(matterRef(3)).toEqual({ no: 3 });
    expect(matterRef("mt-abc")).toEqual({ id: "mt-abc" });
    expect(matterRef(" ")).toBeNull();
    expect(messageRef("#7")).toBe(7);
    expect(messageRef(" 12 ")).toBe(12);
    expect(messageRef("abc")).toBeNull();
  });

  it("queued only while every receipt is", () => {
    const r = (state: "queued" | "delivered") => ({ party: "agent:s" as const, state, queuedAt: 1, deliveredAt: null, seenAt: null, handledAt: null });
    expect(isQueued({ receipts: [r("queued")], state: "forwarded" })).toBe(true);
    expect(isQueued({ receipts: [r("delivered")], state: "forwarded" })).toBe(false);
    expect(isQueued({ receipts: [r("queued")], state: "forwarded", withdrawnAt: 1 })).toBe(false);
    expect(isQueued({ receipts: [], state: "unread" })).toBe(false);
  });

  it("says when a message was sent and what was done since; nothing when no turn ran", () => {
    const at = new Date(2026, 10, 25, 9, 5).toISOString();
    expect(sinceLine(at, 0, "x")).toBeNull();
    expect(sinceLine(at, 2, "已经把表\n改好了", new Date(2026, 10, 25, 10).getTime())).toBe("（这条发出于 09:05，之后你又做了 2 轮，最后的回复开头：「已经把表 改好了」。它说的可能已经过时，按你现在的情况处理。）");
    expect(sinceLine(at, 1, null, new Date(2026, 10, 26).getTime())).toContain("发出于 11-25 09:05");
  });

  it("titles a 事项 by its first line", () => {
    expect(titleFrom("【由本任务的会话「主」开启】\n只改数值表")).toBe("由本任务的会话「主」开启");
    expect(titleFrom("## 改掉落表\n细节")).toBe("改掉落表");
    expect(titleFrom("   ", "留言")).toBe("留言");
  });
});
