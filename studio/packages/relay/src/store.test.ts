import { afterEach, describe, expect, it } from "vitest";
import { RelayError, RelayStore } from "./store.js";

let store: RelayStore;
afterEach(() => store?.close());

function team() {
  store = new RelayStore(":memory:");
  const a = store.join("策划小王", "策划");
  const b = store.join("程序老李", "程序 · 战斗");
  return { a, b };
}

describe("RelayStore", () => {
  it("joins with unique names and finds members by key", () => {
    const { a } = team();
    expect(store.memberByKey(a.key)).toBe("策划小王");
    expect(store.memberByKey("nope")).toBeNull();
    expect(() => store.join("策划小王")).toThrow(RelayError);
    expect(() => store.join("a\nb")).toThrow(/控制字符/);
    expect(store.members().map((m) => m.name)).toEqual(["策划小王", "程序老李"]);
  });

  it("keeps one direct chat per pair and counts unread", () => {
    team();
    const t1 = store.direct("策划小王", "程序老李");
    const t2 = store.direct("程序老李", "策划小王");
    expect(t2.id).toBe(t1.id);
    expect(() => store.direct("策划小王", "策划小王")).toThrow(/自己/);
    store.addMessage(t1.id, "策划小王", { body: "在吗" });
    store.addMessage(t1.id, "策划小王", { body: "看下这个" });
    const [li] = store.threadsFor("程序老李");
    expect(li?.unread).toBe(2);
    expect(li?.last?.body).toBe("看下这个");
    expect(store.threadsFor("策划小王")[0]?.unread).toBe(0);
    store.markRead(t1.id, "程序老李");
    expect(store.threadsFor("程序老李")[0]?.unread).toBe(0);
  });

  it("opens a request thread and takes a reply only from the person asked", () => {
    team();
    const { thread, message } = store.createRequest("策划小王", {
      to: "程序老李",
      title: "技能冷却能按等级变吗",
      body: "方案见下",
      questions: [{ text: "能做吗", options: ["能", "不能"] }, { id: "cost", text: "要几天" }],
      via: { kind: "ai", client: "claude-code" },
    });
    expect(thread.request).toMatchObject({ from: "策划小王", to: "程序老李", status: "open", requestSeq: message.seq });
    expect(message.questions?.map((q) => q.id)).toEqual(["q1", "cost"]);
    expect(message.via).toEqual({ kind: "ai", client: "claude-code" });

    expect(() => store.addMessage(thread.id, "策划小王", { kind: "reply", verdict: "agree" })).toThrow(/发给 程序老李/);
    expect(() => store.addMessage(thread.id, "程序老李", { kind: "reply", answers: [{ questionId: "q1", choice: "也许" }] })).toThrow(/没有选项/);
    expect(() => store.addMessage(thread.id, "程序老李", { kind: "reply", answers: [{ questionId: "zz", text: "x" }] })).toThrow(/没有这个问题/);
    expect(() => store.addMessage(thread.id, "程序老李", { kind: "reply" })).toThrow(/空/);

    const out = store.addMessage(thread.id, "程序老李", {
      kind: "reply",
      body: "表要加一列",
      answers: [{ questionId: "q1", choice: "能" }, { questionId: "cost", text: "两天" }],
      verdict: "change",
    });
    expect(out.thread.request).toMatchObject({ status: "answered", verdict: "change" });
    expect(out.message.answers).toHaveLength(2);
    // A later follow-up without a verdict keeps the last one.
    const again = store.addMessage(thread.id, "程序老李", { kind: "reply", body: "补充：配置表在 skill.xlsx" });
    expect(again.thread.request?.verdict).toBe("change");
    expect(store.messages(thread.id, "策划小王").map((m) => m.kind)).toEqual(["request", "reply", "reply"]);
  });

  it("keeps people out of threads they are not in", () => {
    team();
    store.join("美术小张");
    const { thread } = store.createRequest("策划小王", { to: "程序老李", title: "t", body: "b" });
    expect(() => store.messages(thread.id, "美术小张")).toThrow(/不在这个对话/);
    expect(() => store.addMessage(thread.id, "美术小张", { body: "hi" })).toThrow(/不在这个对话/);
    expect(store.threadsFor("美术小张")).toEqual([]);
    expect(() => store.createRequest("策划小王", { to: "没这人", title: "t", body: "b" })).toThrow(/没有这个人/);
  });
});
