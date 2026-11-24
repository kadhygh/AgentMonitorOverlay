import { describe, expect, it } from "vitest";
import { boundsOf, edgeArrow, layoutMatters, MATTER_CARD, splitBoard } from "./matterBoard.js";
import { basisOf, confirmParts, isQuiet, lookItems, mattersOf, myLooks, noticeOf, openLine, partyText, sideText, sinceState, waitsOnOthers } from "./matterView.js";
import type { BoardItem, CoworkAgent, CoworkSession, Matter, Message, PendingItem } from "./shared.js";

const matter = (no: number, f: Partial<Matter> = {}): Matter => ({ id: `t_${no}`, scope: "cowork", scopeId: "c", no, kind: "work", title: `事 ${no}`, owner: "person:小王", side: "小王", lead: null, status: "doing", waitingOn: [], bindings: { sessions: [], tasks: [], commits: [] }, blocker: null, dependsOn: [], gate: null, conclusion: null, history: [{ at: 1, by: "person:小王", from: null, to: "doing" }], waitingWhy: null, lastEventAt: 1, limited: false, place: null, placeVersion: 0, createdAt: 1, updatedAt: 1, version: 1, ...f });
const agent = (mark: string, f: Partial<CoworkAgent> = {}): CoworkAgent => ({ mark, owner: "小王", label: "射速曲线", name: "小王 的 AI · 射速曲线", state: "idle", queued: 0, lastSeen: 0, joinedAt: 0, ...f });
const item = (f: Partial<PendingItem>): PendingItem => ({ kind: "waiting", scope: "cowork", scopeId: "c", matter: null, seq: null, since: 1, text: "", ...f });
const card = (id: string, f: Partial<BoardItem> = {}): BoardItem => ({ id, kind: "note", x: 0, y: 0, w: 200, h: 100, color: null, text: "", group: null, session: null, ref: null, from: null, to: null, stale: false, version: 1, textVersion: 1, alt: null, createdBy: "小王", createdAt: 1, updatedBy: "小王", updatedAgent: null, updatedAt: 1, deleted: false, deletedBy: null, deletedAt: null, ...f });
const show = (n: string) => n;

describe("事项 as the 中转 client reads them", () => {
  it("takes an older service's 子会话 as 事项 the way the service migrates them", () => {
    const s = (id: string, f: Partial<CoworkSession>): CoworkSession => ({ id, title: id, from: "老李", to: "小王", agent: null, state: "open", waitingOn: "小王", conclusion: null, createdAt: 1, updatedAt: 1, lastSeq: 1, ...f });
    const list = mattersOf({ sessions: [s("b", { createdAt: 5, state: "returned", waitingOn: "老李" }), s("a", { createdAt: 2 }), s("c", { createdAt: 9, state: "done", conclusion: "定了" })] });
    expect(list.map((m) => [m.id, m.no, m.status, m.waitingOn])).toEqual([
      ["a", 1, "confirm", ["person:小王"]],
      ["b", 2, "doing", []],
      ["c", 3, "closed", []],
    ]);
    const own = [matter(1)];
    expect(mattersOf({ sessions: [], matters: own })).toBe(own);
  });

  it("names sides and parties by role", () => {
    const agents = [agent("m1", { role: "lead" }), agent("m2", { role: "worker", label: "回归测试", owner: "老李" })];
    expect(sideText(matter(1), agents, show)).toBe("小王的主控");
    expect(sideText(matter(1, { side: "老李" }), agents, show)).toBe("老李");
    expect(partyText("agent:m2", agents, show)).toBe("回归测试");
    expect(partyText("person:老李", agents, show)).toBe("老李");
    expect(partyText("agent:gone", agents, show)).toBe("AI");
  });

  it("knows since when a 事项 is in its state, and when it has gone quiet", () => {
    const m = matter(1, { status: "waiting", history: [{ at: 1, by: "person:小王", from: null, to: "doing" }, { at: 50, by: "agent:m1", from: "doing", to: "waiting", note: "等老李的数值" }], updatedAt: 50 });
    expect(sinceState(m)).toEqual({ at: 50, note: "等老李的数值", by: "agent:m1" });
    // Only 在做 goes quiet (waiting on someone is theirs to answer), counted from its last event (the service's matterQuiet).
    expect(isQuiet(m, 50 + 3 * 3600_000)).toBe(false);
    const doing = { ...m, status: "doing" as const, lastEventAt: 50 };
    expect(isQuiet(doing, 50 + 2 * 3600_000 + 1)).toBe(true);
    expect(isQuiet({ ...doing, lastEventAt: 50 + 3600_000 }, 50 + 2 * 3600_000 + 1)).toBe(false);
  });

  it("puts 待我处理 into 要你看: one row per 事项 (等你确认 first), then the 群聊's 知会", () => {
    const ms = [matter(4, { status: "confirm" }), matter(5), matter(6, { status: "closed" })];
    const rows = lookItems(
      [
        item({ kind: "message", matter: "t_5", seq: 20, since: 30, text: "#20 结果出来了" }),
        item({ kind: "mention", matter: null, seq: 12, since: 40, text: "#12 @小王 知会：实测 2.3 倍" }),
        item({ kind: "waiting", matter: "t_4", since: 10, text: "事项 4 · 事 4" }),
        item({ kind: "message", matter: "t_4", seq: 21, since: 11 }),
        item({ kind: "waiting", matter: "t_6", since: 50 }),
      ],
      ms,
    );
    expect(rows.map((r) => (r.kind === "matter" ? [r.matter.no, r.look, r.seqs] : ["知会", r.seq, r.text]))).toEqual([
      [4, "confirm", [21]],
      [5, "look", [20]],
      ["知会", 12, "@小王 知会：实测 2.3 倍"],
    ]);
    expect([...myLooks(rows)]).toEqual([
      ["t_4", "confirm"],
      ["t_5", "look"],
    ]);
  });

  it("tells what waits on others, and lists the open ones with 等人确认 first", () => {
    expect(waitsOnOthers(matter(1, { waitingOn: ["agent:x"] }), "小王")).toBe(true);
    expect(waitsOnOthers(matter(1, { waitingOn: ["person:小王"] }), "小王")).toBe(false);
    expect(waitsOnOthers(matter(1), "小王")).toBe(false);
    expect(openLine([matter(1), matter(2, { status: "confirm" }), matter(3, { status: "verified" }), matter(4, { status: "closed" })]).map((m) => m.no)).toEqual([2, 1]);
  });

  it("splits a 闸门's text into 变化 / 例子 / 不确认会怎样 / 来源", () => {
    const p = confirmParts("事项 4 里替你答了一处口径。\n\n**变化**：射程被加长时，多出来的格算进第 3 块。\n例子：射程 8 格，\n站在第 7、8 格吃 60。\n## 不确认会怎样\n回归测试照这个默认跑完。\n来源：小王的主控的判断");
    expect(p).toEqual({ change: "射程被加长时，多出来的格算进第 3 块。", example: "射程 8 格，\n站在第 7、8 格吃 60。", ifNot: "回归测试照这个默认跑完。", source: "小王的主控的判断", rest: "事项 4 里替你答了一处口径。" });
    expect(confirmParts("合进 master 吗？变化不大。")).toBeNull();
  });

  it("reads an AI's basis and a 知会 when the message carries them", () => {
    const m = { body: "" } as Message;
    expect(basisOf(m)).toBeNull();
    expect(basisOf({ ...m, basis: { kind: "inferred", person: "小王" } }, (n) => `${n}同学`)).toEqual({ kind: "inferred", person: "小王", text: "我的判断，小王同学没确认过" });
    expect(basisOf({ ...m, basis: { kind: "confirmed", person: "老李", decision: 3 } })?.text).toBe("已和老李确认（已定的事第 3 条）");
    expect(noticeOf({ ...m, notice: ["小王", "person:老李"] })).toEqual(["小王", "老李"]);
    expect(noticeOf({ ...m, notice: [] })).toBeNull();
    expect(noticeOf(m)).toBeNull();
  });
});

describe("the 事项 on the board, computed", () => {
  it("puts each side's open 事项 in its frame (等人确认 first), settled ones in 「已定 / 已验」, dragged ones where they were put", () => {
    const ms = [matter(1, { status: "closed", conclusion: "按块结算" }), matter(2, { side: "老李", status: "doing" }), matter(3, { status: "doing" }), matter(4, { status: "confirm" }), matter(5, { side: "老李", status: "verified" }), matter(6, { side: "老李", dependsOn: ["t_2"] }), matter(7, { dependsOn: ["t_9"] })];
    const l = layoutMatters(ms, ["小王", "老李", "小周"], { t_6: { x: 900.4, y: -300 } }, ["小周"]);
    expect(l.frames.map((f) => [f.side, f.matters])).toEqual([
      ["小王", ["t_4", "t_3", "t_7"]],
      ["老李", ["t_2"]],
      ["小周", []],
      [null, ["t_1", "t_5"]],
    ]);
    expect(l.cards.t_6).toEqual({ x: 900, y: -300, w: MATTER_CARD.w, h: MATTER_CARD.h, placed: true });
    // Two to a row; the next frame to the right of the first.
    expect(l.cards.t_3!.y).toBe(l.cards.t_4!.y);
    expect(l.cards.t_7!.y).toBeGreaterThan(l.cards.t_4!.y);
    expect(l.frames[1]!.x).toBeGreaterThan(l.frames[0]!.x + l.frames[0]!.w);
    expect(l.links).toEqual([{ from: "t_2", to: "t_6" }]);
  });

  it("leaves out an older service's 子会话 cards and side frames; a 事项's place is its own", () => {
    const items = [card("n1"), card("g1", { kind: "group", side: "小王" } as Partial<BoardItem>), card("g2", { kind: "group" }), card("s1", { kind: "session", session: "t_3" })];
    const s = splitBoard(items, [matter(1), matter(2, { place: { x: 70, y: 80 } })]);
    expect(s.own.map((i) => i.id)).toEqual(["n1", "g2"]);
    expect(s.placed).toEqual({ t_2: { x: 70, y: 80 } });
    expect(s.standIn).toEqual({ s1: "t_3" });
  });

  it("points at what is off screen from the edge, and bounds everything", () => {
    expect(edgeArrow({ x: 100, y: 100 }, { w: 800, h: 600 })).toBeNull();
    const a = edgeArrow({ x: -400, y: 300 }, { w: 800, h: 600 })!;
    expect(a).toEqual({ x: 24, y: 300, angle: 180 });
    expect(boundsOf([{ x: 0, y: 0, w: 10, h: 10 }, { x: -5, y: 20, w: 10, h: 10 }])).toEqual({ x: -5, y: 0, w: 15, h: 30 });
  });
});
