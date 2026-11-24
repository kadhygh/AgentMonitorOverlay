import { describe, expect, it } from "vitest";
import {
  MATTER_QUIET_MS,
  SETTLED_GROUP,
  agentParty,
  applyMatterEvent,
  basisText,
  deriveMatter,
  matterGroup,
  matterMessageEvent,
  matterQuiet,
  parseCollabRef,
  pendingFor,
  personParty,
  resolveAgentRef,
  type Matter,
  type MatterEvent,
  type MatterState,
  type PendingMessage,
  type Receipt,
} from "./matters.js";

// 2026-11-25 (the user, after 11-24): a 事项's status follows from its events (applyMatterEvent / deriveMatter), 待我处理
// carries what the Host needs for the wake-up line, AIs answer each other saying where the answer comes from (basis), and
// every tool takes 「事项 3」, 「#7」, display names and copied lines (parseCollabRef / resolveAgentRef).

const WANG = personParty("策划小王");
const LI = personParty("程序老李");
const W_LEAD = "studio:d_w:s-lead";
const L_LEAD = "studio:d_l:s-lead";
const L_WORKER = "studio:d_l:s-worker";
const W = agentParty(W_LEAD);
const L = agentParty(L_LEAD);
const LW = agentParty(L_WORKER);

function matter(over: Partial<Matter> = {}): Matter {
  return {
    id: "t_m1",
    scope: "cowork",
    scopeId: "t_c",
    no: 1,
    kind: "work",
    title: "苦无改穿透",
    owner: L,
    side: "程序老李",
    lead: L_LEAD,
    status: "doing",
    waitingOn: [],
    bindings: { sessions: [], tasks: [], commits: [] },
    blocker: null,
    dependsOn: [],
    gate: null,
    conclusion: null,
    history: [],
    waitingWhy: null,
    lastEventAt: 100,
    limited: false,
    place: null,
    placeVersion: 0,
    createdAt: 100,
    updatedAt: 100,
    version: 1,
    ...over,
  };
}
const receipt = (party: Receipt["party"]): Receipt => ({ party, state: "delivered", queuedAt: 1, deliveredAt: 2, seenAt: null, handledAt: null });

describe("status from events", () => {
  const run = (...events: MatterEvent[]) => deriveMatter(events)!;
  const open: MatterEvent = { kind: "open", at: 1, by: L };

  it("待开始 → 在做 when an 执行 is bound or someone starts in it", () => {
    expect(run(open).status).toBe("todo");
    expect(run(open, { kind: "bind", at: 2, by: L }).status).toBe("doing");
    expect(run(open, { kind: "say", at: 2, by: LW, seq: 5 }).status).toBe("doing");
  });

  it("an @ or a reply not answered yet: 等对方 on whom it names (the latest one's); answered, back to 在做", () => {
    const asked = run(open, { kind: "address", at: 2, by: LW, seq: 5, to: [W] });
    expect(asked).toMatchObject({ status: "waiting", waitingOn: [W], waitingWhy: { reason: "address", by: LW, seq: 5, at: 2 } });
    const two = applyMatterEvent(asked, { kind: "address", at: 3, by: L, seq: 6, to: [LW] });
    expect(two).toMatchObject({ status: "waiting", waitingOn: [LW] });
    const one = applyMatterEvent(two, { kind: "say", at: 4, by: LW, seq: 7 });
    expect(one).toMatchObject({ status: "waiting", waitingOn: [W] });
    expect(applyMatterEvent(one, { kind: "say", at: 5, by: W, seq: 8 })).toMatchObject({ status: "doing", waitingOn: [], waitingWhy: null });
  });

  it("a reply to what was asked of me answers it; a reply to anything else waits on its author; never on oneself", () => {
    const asked = run(open, { kind: "address", at: 2, by: LW, seq: 5, to: [W] });
    expect(matterMessageEvent(asked, { by: W, seq: 6, at: 3, replyToAuthor: LW })).toEqual({ kind: "say", at: 3, by: W, seq: 6 });
    expect(matterMessageEvent(run(open), { by: W, seq: 6, at: 3, replyToAuthor: LW })).toEqual({ kind: "address", at: 3, by: W, seq: 6, to: [LW] });
    expect(matterMessageEvent(run(open), { by: W, seq: 6, at: 3, mentions: [W, L] })).toMatchObject({ kind: "address", to: [L] });
  });

  it("cowork_ask: 等人确认 on that person; their answer → 在做 (their AI's does not count)", () => {
    const s = run({ kind: "open", at: 1, by: W, status: "confirm", to: [LI] });
    expect(s).toMatchObject({ status: "confirm", waitingOn: [LI], waitingWhy: { reason: "ask" } });
    const ev = matterMessageEvent(s, { by: LI, seq: 9, at: 2 });
    expect(ev.kind).toBe("answer");
    expect(applyMatterEvent(s, ev)).toMatchObject({ status: "doing", waitingOn: [] });
    expect(applyMatterEvent(s, matterMessageEvent(s, { by: L, seq: 9, at: 2 }))).toMatchObject({ status: "confirm", waitingOn: [LI] });
  });

  it("推送 → 已推送; passing verification → 待核对, failing → 在做; 已验 by hand; 结论 → 关闭, and it stays closed", () => {
    const pushed = run(open, { kind: "bind", at: 2, by: L }, { kind: "push", at: 3, by: LW, commits: ["3f2a91c"] });
    expect(pushed).toMatchObject({ status: "pushed", commits: ["3f2a91c"] });
    const review = applyMatterEvent(pushed, { kind: "verify", at: 4, by: LW, passed: true });
    expect(review.status).toBe("review");
    expect(applyMatterEvent(pushed, { kind: "verify", at: 4, by: LW, passed: false }).status).toBe("doing");
    const verified = applyMatterEvent(review, { kind: "manual", at: 5, by: L, status: "verified", note: "核对过" });
    expect(verified.history.at(-1)).toEqual({ at: 5, by: L, from: "review", to: "verified", event: "manual", manual: true, note: "核对过" });
    const closed = applyMatterEvent(verified, { kind: "conclude", at: 6, by: L, conclusion: "穿透 2 个" });
    expect(closed).toMatchObject({ status: "closed", conclusion: "穿透 2 个", waitingOn: [] });
    expect(applyMatterEvent(closed, { kind: "say", at: 7, by: W, seq: 30 }).status).toBe("closed");
  });

  it("a push does not answer a person's confirmation still pending", () => {
    const s = run({ kind: "open", at: 1, by: W, status: "confirm", to: [LI] }, { kind: "push", at: 2, by: L, commits: ["abcd"] });
    expect(s).toMatchObject({ status: "confirm", commits: ["abcd"] });
  });

  it("a hand change wins at that moment, and later events move on from it", () => {
    const hand = run(open, { kind: "manual", at: 2, by: L, status: "waiting", to: [W], note: "等策划给表" });
    expect(hand).toMatchObject({ status: "waiting", waitingOn: [W], waitingWhy: { reason: "manual" } });
    expect(applyMatterEvent(hand, { kind: "say", at: 3, by: W, seq: 4 })).toMatchObject({ status: "doing", waitingOn: [] });
    expect(applyMatterEvent(hand, { kind: "push", at: 3, by: LW, commits: ["abcd"] }).status).toBe("pushed");
  });

  it("two AIs too long with no person: 等人确认 on both people; only a person speaking lets it go on", () => {
    const limited = run(open, { kind: "bind", at: 2, by: L }, { kind: "limit", at: 3, by: W, seq: 40, to: [WANG, LI] });
    expect(limited).toMatchObject({ status: "confirm", limited: true, waitingOn: [WANG, LI], waitingWhy: { reason: "limit" } });
    expect(applyMatterEvent(limited, { kind: "say", at: 4, by: L, seq: 41 })).toMatchObject({ limited: true, status: "confirm" });
    expect(applyMatterEvent(limited, { kind: "say", at: 4, by: WANG, seq: 41 })).toMatchObject({ limited: false, status: "doing", waitingOn: [] });
  });

  it("kept as it goes = worked out again from all the events; the history names the event", () => {
    const events: MatterEvent[] = [open, { kind: "bind", at: 2, by: L }, { kind: "address", at: 3, by: LW, seq: 5, to: [W] }, { kind: "say", at: 4, by: W, seq: 6 }, { kind: "push", at: 5, by: LW, seq: 7, commits: ["aa11"] }];
    let s: MatterState | null = null;
    for (const e of events) s = applyMatterEvent(s, e);
    expect(s).toEqual(deriveMatter(events));
    expect(s!.history.map((h) => [h.from, h.to, h.event])).toEqual([
      [null, "todo", "open"],
      ["todo", "doing", "bind"],
      ["doing", "waiting", "address"],
      ["waiting", "doing", "say"],
      ["doing", "pushed", "push"],
    ]);
    expect(s!.lastEventAt).toBe(5);
  });

  it("久没动静: 在做 with no event for 2 hours", () => {
    expect(matterQuiet(matter({ status: "doing", lastEventAt: 0 }), MATTER_QUIET_MS)).toBe(true);
    expect(matterQuiet(matter({ status: "doing", lastEventAt: 1 }), MATTER_QUIET_MS)).toBe(false);
    expect(matterQuiet(matter({ status: "waiting", lastEventAt: 0 }), MATTER_QUIET_MS)).toBe(false);
  });

  it("the board draws a 事项卡 in its side's group, a settled one in 「已定 / 已验」", () => {
    expect(matterGroup(matter())).toBe("程序老李");
    expect(matterGroup(matter({ status: "verified" }))).toBe(SETTLED_GROUP);
  });
});

describe("pendingFor", () => {
  const msg = (seq: number, over: Partial<PendingMessage> = {}): PendingMessage => ({ seq, author: L, body: `消息 ${seq}`, createdAt: seq * 10, receipts: [receipt(W), receipt(WANG)], ...over });

  it("an @ and a reply to mine carry the whole message; a waiting 事项 says who made it wait, when and why", () => {
    const ms = [matter({ status: "waiting", waitingOn: [W], waitingWhy: { reason: "address", by: L, at: 70, seq: 7 } })];
    const items = pendingFor(W, "cowork", "t_c", ms, [msg(7, { matter: "t_m1", mentions: [W] }), msg(9, { replyTo: 4, replyToAuthor: W })]);
    expect(items.map((i) => [i.kind, i.seq, i.matterNo, i.why.reason, i.why.by, i.seqs, i.body ?? null])).toEqual([
      ["reply", 9, null, "reply", L, [9, 4], "消息 9"],
      ["waiting", null, 1, "address", L, [7], null],
      ["mention", 7, 1, "mention", L, [7], "消息 7"],
    ]);
    expect(items[1]!.why.text).toBe("@ 或回复了你（#7），还没回");
    expect(items[1]!).toMatchObject({ matterTitle: "苦无改穿透", matterStatus: "waiting" });
  });

  it("a 知会 is the person's until handled; nothing of a limited 事项 for its AIs", () => {
    expect(pendingFor(WANG, "cowork", "t_c", [], [msg(3, { notice: ["策划小王"] })]).map((i) => [i.kind, i.body])).toEqual([["notice", "消息 3"]]);
    const limited = matter({ status: "confirm", limited: true, waitingOn: [WANG, W] });
    expect(pendingFor(W, "cowork", "t_c", [limited], [msg(3, { matter: "t_m1" })])).toEqual([]);
    expect(pendingFor(WANG, "cowork", "t_c", [limited], []).map((i) => i.kind)).toEqual(["waiting"]);
  });

  it("久没动静 goes to its side's 主控 only", () => {
    const quiet = matter({ status: "doing", lastEventAt: 0 });
    expect(pendingFor(L, "cowork", "t_c", [quiet], [], { now: MATTER_QUIET_MS }).map((i) => [i.kind, i.why.by, i.why.text])).toEqual([["quiet", null, "在做，超过 2 小时没有动静"]]);
    expect(pendingFor(W, "cowork", "t_c", [quiet], [], { now: MATTER_QUIET_MS })).toEqual([]);
    expect(pendingFor(L, "cowork", "t_c", [quiet], [])).toEqual([]);
  });
});

describe("回答的来源", () => {
  it("confirmed with whom, when or which of 已定的事; or inferred", () => {
    const at = new Date(2026, 10, 24, 15, 2).getTime();
    expect(basisText({ kind: "confirmed", person: "策划小王", at, decision: 3 }, (a) => (a === "策划小王" ? "小王" : a))).toBe("已和小王确认（11-24 15:02 / 已定的事第 3 条）");
    expect(basisText({ kind: "confirmed", person: "策划小王", decision: 1 })).toBe("已和策划小王确认（已定的事第 1 条）");
    expect(basisText({ kind: "inferred", person: "策划小王" })).toBe("我的判断，策划小王没确认过");
  });
});

describe("指代", () => {
  it("reads 「事项 3」, 「#7」, copied lines and marks", () => {
    expect(parseCollabRef("事项 3")).toEqual({ kind: "matter", no: 3 });
    expect(parseCollabRef("事项3「穿透判定」")).toEqual({ kind: "matter", no: 3 });
    expect(parseCollabRef("#12（协作「加特林」 cowork:t_0123456789abcdef）")).toEqual({ kind: "seq", seq: 12 });
    expect(parseCollabRef("子会话「过热」 thread:t_aaaaaaaaaaaaaaaa（协作 cowork:t_0123456789abcdef）")).toEqual({ kind: "thread", id: "t_aaaaaaaaaaaaaaaa" });
    expect(parseCollabRef("协作「加特林」 cowork:t_0123456789abcdef")).toEqual({ kind: "cowork", id: "t_0123456789abcdef" });
    expect(parseCollabRef("agent:studio:d_l:s-lead")).toEqual({ kind: "agent", mark: "studio:d_l:s-lead" });
    expect(parseCollabRef("studio:d_l:s-lead")).toEqual({ kind: "agent", mark: "studio:d_l:s-lead" });
    expect(parseCollabRef("老李的主控")).toEqual({ kind: "name", text: "老李的主控" });
    expect(parseCollabRef("  ")).toBeNull();
  });

  it("finds an agent by its name, 「<人>的主控」, 「<人>的 AI」 or 「事项 N 的执行」", () => {
    const agents = [
      { mark: L_LEAD, name: "程序老李 的 AI · 战斗代码", label: "战斗代码", owner: "程序老李", ownerNick: "老李", role: "lead" as const },
      { mark: L_WORKER, name: "程序老李 的 AI · 写代码", label: "写代码", owner: "程序老李", ownerNick: "老李", role: "worker" as const, matterNo: 3 },
      { mark: W_LEAD, name: "策划小王 的 AI · 文档", label: "文档", owner: "策划小王", ownerNick: "小王", role: "lead" as const },
    ];
    expect(resolveAgentRef("老李的主控", agents)).toEqual([L_LEAD]);
    expect(resolveAgentRef("程序老李 的主控", agents)).toEqual([L_LEAD]);
    expect(resolveAgentRef("事项 3 的执行", agents)).toEqual([L_WORKER]);
    expect(resolveAgentRef("「程序老李 的 AI · 写代码」", agents)).toEqual([L_WORKER]);
    expect(resolveAgentRef("文档", agents)).toEqual([W_LEAD]);
    expect(resolveAgentRef("小王的 AI", agents)).toEqual([W_LEAD]);
    expect(resolveAgentRef("老李的AI", agents).sort()).toEqual([L_LEAD, L_WORKER].sort());
    expect(resolveAgentRef("美术的主控", agents)).toEqual([]);
    expect(resolveAgentRef(`agent:${W_LEAD}`, agents)).toEqual([W_LEAD]);
  });
});
