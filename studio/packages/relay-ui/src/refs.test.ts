import { describe, expect, it } from "vitest";
import { coworkRef, findRefs, matterRef, messageRef, parseOpen, parseRef, requestRef, subRef } from "./refs.js";

// 复制引用 (2026-11-23): the words copied, and how a message's text is read back for its chips.

const cw = { id: "t_0a1b2c3d4e5f6a7b", title: "加特林射速调整" };

describe("复制引用: the text", () => {
  it("names each the way Studio does", () => {
    expect(coworkRef(cw)).toBe("协作「加特林射速调整」 cowork:t_0a1b2c3d4e5f6a7b");
    expect(subRef({ id: "t_99", title: "过热从第几秒开始" }, cw.id)).toBe("子会话「过热从第几秒开始」 thread:t_99（协作 cowork:t_0a1b2c3d4e5f6a7b）");
    expect(requestRef({ id: "t_42", title: "登录页改版" })).toBe("中转会话「登录页改版」 thread:t_42");
    expect(messageRef(12, { cowork: cw })).toBe("#12（协作「加特林射速调整」 cowork:t_0a1b2c3d4e5f6a7b）");
    expect(messageRef(7, { name: "策划小王" })).toBe("#7（策划小王）");
    // a title on one line, as Studio writes its own
    expect(coworkRef({ id: "t_1", title: " 加特林\n射速  调整 " })).toBe("协作「加特林 射速 调整」 cowork:t_1");
  });
});

describe("复制引用: read back", () => {
  it("parses each kind, and nothing else", () => {
    expect(parseRef("cowork:t_1")).toEqual({ kind: "cowork", id: "t_1" });
    expect(parseRef("thread:t_2")).toEqual({ kind: "thread", id: "t_2" });
    expect(parseRef("studio:d_abcdef0123:s-3f4aa44f-c191")).toEqual({ kind: "studio", device: "d_abcdef0123", session: "s-3f4aa44f-c191" });
    expect(parseRef("studio:d_1:s-1")).toBeNull(); // a device id is at least 6
    expect(parseRef("task:t_1")).toBeNull();
    expect(parseRef("cowork:")).toBeNull();
  });

  it("takes the words copied before a ref into it", () => {
    const text = `看一下 ${coworkRef(cw)} 里的结论`;
    const [r] = findRefs(text);
    expect(r).toMatchObject({ ref: { kind: "cowork", id: cw.id }, label: "加特林射速调整" });
    expect(text.slice(r!.index, r!.index + r!.length)).toBe("协作「加特林射速调整」 cowork:t_0a1b2c3d4e5f6a7b");
  });

  it("finds both in a 子会话's and a message's text", () => {
    const sub = findRefs(subRef({ id: "t_99", title: "过热" }, cw.id));
    expect(sub.map((r) => [r.ref.kind, r.label])).toEqual([
      ["thread", "过热"],
      ["cowork", null],
    ]);
    // 「（协作 cowork:…）」: the word 协作 goes into the chip
    const s = subRef({ id: "t_99", title: "过热" }, cw.id);
    expect(s.slice(sub[1]!.index, sub[1]!.index + sub[1]!.length)).toBe("协作 cowork:t_0a1b2c3d4e5f6a7b");
    expect(findRefs(messageRef(3, { cowork: cw }))[0]!.label).toBe("加特林射速调整");
    // a 事项 (2026-11-25): its number and title go into the chip with its thread
    const m = matterRef({ id: "t_99", no: 12, title: "射程加长" }, cw.id);
    expect(m).toBe("事项 12「射程加长」 thread:t_99（协作 cowork:t_0a1b2c3d4e5f6a7b）");
    const [r] = findRefs(m);
    expect([r!.ref, r!.label, m.slice(r!.index, r!.index + r!.length)]).toEqual([{ kind: "thread", id: "t_99" }, "射程加长", "事项 12「射程加长」 thread:t_99"]);
  });

  it("a Studio session with its name", () => {
    const [r] = findRefs("Studio 会话「射速曲线」 studio:d_abcdef0123456789abcdef01:s-9（任务 k_12）");
    expect(r).toMatchObject({ ref: { kind: "studio", device: "d_abcdef0123456789abcdef01", session: "s-9" }, label: "射速曲线" });
  });

  it("a bare id too, but not inside a word, a path or a link", () => {
    expect(findRefs("就是 thread:t_5，你看").map((r) => r.raw)).toEqual(["thread:t_5"]);
    expect(findRefs("xcowork:t_1 a/thread:t_2 http://h/cowork:t_3 cowork:t_4")).toHaveLength(1);
    expect(findRefs("cowork:t_4")[0]!.raw).toBe("cowork:t_4");
  });
});

describe("what the shell asks to open", () => {
  it("cowork and thread, a 传文件 notification's thread too", () => {
    expect(parseOpen("cowork:t_1")).toEqual({ kind: "cowork", id: "t_1" });
    expect(parseOpen("thread:transfer:x_1")).toEqual({ kind: "thread", id: "transfer:x_1" });
    expect(parseOpen("studio:d:s")).toBeNull();
    expect(parseOpen("cowork:")).toBeNull();
    expect(parseOpen("t_1")).toBeNull();
  });
});
