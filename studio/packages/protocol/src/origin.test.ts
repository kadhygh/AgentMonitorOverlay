import { describe, expect, it } from "vitest";
import { messageOrigin, originLabel } from "./origin.js";

describe("who a message in a session is from", () => {
  it("leaves the person's own message alone", () => {
    expect(messageOrigin({ text: "把喷发位置改成取目标" })).toBeNull();
    expect(messageOrigin({ text: "【引用的批注】\n【批注1】针对你回复中的这段：\n> a\n我的批注：b" })).toBeNull();
  });

  it("reads the line written for the model on rows from before origin was kept", () => {
    const report = messageOrigin({ text: "【你开的会话「测首帧」（s-12ab）这一轮做完了】\n首次 18ms，之后 2ms。" });
    expect(report).toEqual({ origin: { kind: "report", from: "测首帧", sessionId: "s-12ab", state: "done" }, body: "首次 18ms，之后 2ms。" });
    expect(messageOrigin({ text: "【你开的会话「测首帧」（s-12ab）这一轮做完了，它已经用留言把结果发给你】" })?.origin.state).toBe("done");
    expect(messageOrigin({ text: "【你开的会话「测首帧」（s-12ab）被人停下了，还没有结论】它接着做完后，结果会再转给你。" })?.origin.state).toBe("stopped");
    expect(messageOrigin({ text: "【你开的会话「测首帧」（s-12ab）出错停下了】\nboom" })).toEqual({ origin: { kind: "report", from: "测首帧", sessionId: "s-12ab", state: "failed" }, body: "boom" });
    expect(messageOrigin({ text: "【开启你的会话「主会话」（s-1）发来】\n接着做第二阶段" })).toEqual({ origin: { kind: "send", from: "主会话", sessionId: "s-1" }, body: "接着做第二阶段" });
    expect(messageOrigin({ text: "【中转回复】\n\n张三：可以预热" })).toEqual({ origin: { kind: "team", from: "中转" }, body: "\n张三：可以预热" });
    expect(messageOrigin({ text: "【主控「合并」传话】\n先合 A" })).toEqual({ origin: { kind: "relay", from: "合并" }, body: "先合 A" });
    expect(messageOrigin({ text: "【由本任务的会话「主会话」开启】\n你接手界面设计" })).toEqual({ origin: { kind: "start", from: "主会话" }, body: "你接手界面设计" });
    expect(messageOrigin({ text: "【本任务的会话「主会话」应人的要求开启：人会在这里和你一起推进】\n看一下" })?.origin.kind).toBe("start");
    expect(messageOrigin({ text: "[AMO 留言] 来自任务「T」的会话「S」：\n\n做完了" })).toEqual({ origin: { kind: "mail", from: "任务「T」的会话「S」" }, body: "做完了" });
  });

  it("prefers the origin kept on the row, and still takes the line off the text", () => {
    const kept = { kind: "team" as const, from: "张三、李四", threadIds: ["t1", "t2"] };
    expect(messageOrigin({ text: "【中转回复】\n\n张三：可以", origin: kept })).toEqual({ origin: kept, body: "\n张三：可以" });
    // 值守 writes no line of its own.
    expect(messageOrigin({ text: "看看问题页", origin: { kind: "duty", from: "问题页值守" } })).toEqual({ origin: { kind: "duty", from: "问题页值守" }, body: "看看问题页" });
  });

  it("words the head of the row", () => {
    expect(originLabel({ kind: "report", from: "测首帧", state: "done" })).toBe("子会话「测首帧」回报");
    expect(originLabel({ kind: "report", from: "测首帧", state: "failed" })).toBe("子会话「测首帧」出错停下了");
    expect(originLabel({ kind: "team", from: "中转" })).toBe("中转回复");
    expect(originLabel({ kind: "team", from: "张三" })).toBe("张三 回复（中转）");
  });
});
