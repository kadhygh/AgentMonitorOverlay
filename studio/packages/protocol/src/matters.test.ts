import { describe, expect, it } from "vitest";
import {
  advanceReceipt,
  agentParty,
  canRewrite,
  leadTakenText,
  matterSettled,
  messageRecipients,
  parseParty,
  pendingDiff,
  pendingFor,
  pendingKey,
  personParty,
  receiptSummary,
  roleAllows,
  seenByAgents,
  statusFromSession,
  type Matter,
  type PendingMessage,
  type Receipt,
} from "./matters.js";

// 事项、回执、角色、待我处理 (2026-11-24, plans/collab-framework.md「11-24」): the rules the 中转 service and the Host share.

const WANG = personParty("策划小王");
const LI = personParty("程序老李");
const W_LEAD = "studio:d_w:s-lead";
const L_LEAD = "studio:d_l:s-lead";
const L_WORKER = "studio:d_l:s-worker";
const leads = { 策划小王: W_LEAD, 程序老李: L_LEAD };
const people = ["策划小王", "程序老李"];

function matter(over: Partial<Matter> = {}): Matter {
  return {
    id: "t_m1",
    scope: "cowork",
    scopeId: "t_c",
    no: 1,
    kind: "work",
    title: "苦无改穿透",
    owner: agentParty(L_LEAD),
    side: "程序老李",
    lead: L_LEAD,
    status: "doing",
    waitingOn: [],
    bindings: { sessions: [], tasks: [], commits: [] },
    blocker: null,
    dependsOn: [],
    gate: null,
    conclusion: null,
    history: [{ at: 100, by: agentParty(L_LEAD), from: null, to: "doing" }],
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
const receipt = (party: Receipt["party"], state: Receipt["state"] = "delivered"): Receipt => ({
  party,
  state,
  queuedAt: 1,
  deliveredAt: state === "queued" ? null : 2,
  seenAt: state === "seen" || state === "handled" ? 3 : null,
  handledAt: state === "handled" ? 4 : null,
});

describe("Party", () => {
  it("person and agent, one string each", () => {
    expect(parseParty(WANG)).toEqual({ kind: "person", name: "策划小王" });
    expect(parseParty(agentParty(W_LEAD))).toEqual({ kind: "agent", mark: W_LEAD });
    expect(parseParty("person:")).toBeNull();
    expect(parseParty("策划小王")).toBeNull();
  });
});

describe("roleAllows", () => {
  it("a 主控 does everything", () => {
    for (const a of ["chat-post", "mention-person", "conclude", "matter-edit", "matter-open", "board-write", "read-all"] as const) expect(roleAllows("lead", a)).toBe(true);
  });
  it("an 执行 posts only in its own 事项 and changes nothing (the user 11-24)", () => {
    const own = { own: "t_m1", matter: "t_m1" };
    expect(roleAllows("worker", "matter-post", own)).toBe(true);
    expect(roleAllows("worker", "matter-post", { own: "t_m1", matter: "t_m2" })).toBe(false);
    expect(roleAllows("worker", "mention-agent", own)).toBe(true);
    for (const a of ["chat-post", "mention-person", "conclude", "matter-edit", "matter-open", "board-write", "read-all"] as const) expect(roleAllows("worker", a, own)).toBe(false);
    expect(roleAllows("worker", "read-own", own)).toBe(true);
    expect(roleAllows("worker", "mark", own)).toBe(true);
  });
  it("a second 主控 is refused saying who holds it", () => {
    expect(leadTakenText("程序老李", "程序老李 的 AI · 苦无")).toContain("已经有主控：程序老李 的 AI · 苦无");
  });
});

describe("事项", () => {
  it("settled once concluded, verified or closed", () => {
    expect(matterSettled(matter())).toBe(false);
    expect(matterSettled(matter({ status: "pushed" }))).toBe(false);
    expect(matterSettled(matter({ status: "verified" }))).toBe(true);
    expect(matterSettled(matter({ status: "closed" }))).toBe(true);
    expect(matterSettled(matter({ conclusion: "穿透只对小怪" }))).toBe(true);
  });
  it("old 子会话 migrate: open/returned 在做, done or concluded 关闭", () => {
    expect(statusFromSession("open", null)).toBe("doing");
    expect(statusFromSession("returned", null)).toBe("doing");
    expect(statusFromSession("done", null)).toBe("closed");
    expect(statusFromSession("open", "定了")).toBe("closed");
  });
});

describe("receipts", () => {
  it("move forward only, filling the steps skipped", () => {
    const r = receipt(agentParty(W_LEAD), "queued");
    const h = advanceReceipt(r, "handled", 50, true);
    expect(h).toMatchObject({ state: "handled", deliveredAt: 50, seenAt: 50, handledAt: 50, byClose: true });
    expect(advanceReceipt(h, "seen", 60)).toBe(h);
  });
  it("my message's one line, rewrite only before anyone saw it, who to remind", () => {
    const rs = [receipt(WANG, "seen"), receipt(agentParty(W_LEAD), "seen"), receipt(agentParty(L_LEAD), "handled"), receipt(LI, "delivered")];
    expect(receiptSummary(rs).text).toBe("1 送到 · 2 看过 · 1 处理了");
    expect(canRewrite(rs)).toBe(false);
    expect(canRewrite([receipt(LI, "delivered"), receipt(WANG, "queued")])).toBe(true);
    expect(seenByAgents(rs)).toEqual([W_LEAD, L_LEAD]);
  });
});

describe("messageRecipients", () => {
  it("群聊: the people and every 主控, not the author", () => {
    expect(messageRecipients({ author: WANG, people, leads }).sort()).toEqual([LI, agentParty(W_LEAD), agentParty(L_LEAD)].sort());
  });
  it("a 事项: the 主控 concerned and its 执行, no people", () => {
    const m = matter({ bindings: { sessions: [L_WORKER], tasks: [], commits: [] } });
    expect(messageRecipients({ author: agentParty(L_WORKER), people, leads, matter: m }).sort()).toEqual([agentParty(L_LEAD)]);
    // waiting on the other side brings in its 主控 (not the person while it is not 等人确认)
    const waiting = matter({ status: "waiting", waitingOn: [WANG], bindings: { sessions: [L_WORKER], tasks: [], commits: [] } });
    expect(messageRecipients({ author: agentParty(L_LEAD), people, leads, matter: waiting }).sort()).toEqual([agentParty(W_LEAD), agentParty(L_WORKER)].sort());
  });
  it("「等人确认」 includes the person it waits on", () => {
    const gate = matter({ status: "confirm", waitingOn: [WANG], gate: "rules", side: "策划小王", lead: W_LEAD, owner: agentParty(W_LEAD) });
    expect(messageRecipients({ author: agentParty(W_LEAD), people, leads, matter: gate }).sort()).toEqual([WANG]);
  });
  it("those who wrote in it before, and anyone @-ed", () => {
    const m = matter();
    expect(messageRecipients({ author: agentParty(L_LEAD), people, leads, matter: m, posters: [WANG] })).toEqual([agentParty(W_LEAD)]);
    expect(messageRecipients({ author: agentParty(L_LEAD), people, leads, matter: m, mentions: [WANG] })).toEqual([WANG]);
  });
});

describe("pendingFor", () => {
  const W = agentParty(W_LEAD);
  const msg = (seq: number, over: Partial<PendingMessage> = {}): PendingMessage => ({ seq, author: agentParty(L_LEAD), body: `消息 ${seq}`, createdAt: seq * 10, receipts: [receipt(W)], ...over });

  it("@ of me, 事项 waiting on me, a 事项's message to me — until 处理了", () => {
    const ms = [matter(), matter({ id: "t_m2", no: 2, title: "等小王确认", status: "confirm", waitingOn: [WANG], history: [{ at: 300, by: W, from: null, to: "confirm" }] })];
    const msgs = [
      msg(1, { mentions: [W] }), // 群聊 @ me
      msg(2), // 群聊 without @: only unread
      msg(3, { matter: "t_m1" }),
      msg(4, { matter: "t_m1", receipts: [receipt(W, "handled")] }),
      msg(5, { matter: "t_m1", supersededBy: 6 }),
      msg(7, { matter: "t_m1", withdrawnAt: 75 }),
      msg(8, { author: W, matter: "t_m1" }),
    ];
    const mine = pendingFor(W, "cowork", "t_c", ms, msgs);
    expect(mine.map((i) => [i.kind, i.seq, i.matter])).toEqual([
      ["message", 3, "t_m1"],
      ["mention", 1, null],
    ]);
    const wang = pendingFor(WANG, "cowork", "t_c", ms, msgs);
    expect(wang).toEqual([
      { kind: "waiting", scope: "cowork", scopeId: "t_c", matter: "t_m2", matterNo: 2, matterTitle: "等小王确认", matterStatus: "confirm", seq: null, seqs: [], since: 300, why: { by: null, at: 300, reason: "manual", text: "手改成在等你" }, text: "事项 2 · 等小王确认" },
    ]);
  });
  it("a closed 事项's messages are handled", () => {
    expect(pendingFor(W, "cowork", "t_c", [matter({ status: "closed" })], [msg(3, { matter: "t_m1" })])).toEqual([]);
  });
  it("key and diff: what the patrol wakes a 主控 with", () => {
    const a = pendingFor(W, "cowork", "t_c", [matter()], [msg(3, { matter: "t_m1" })]);
    const b = pendingFor(W, "cowork", "t_c", [matter()], [msg(3, { matter: "t_m1" }), msg(9, { matter: "t_m1" })]);
    expect(pendingKey(a)).toBe(pendingKey([...a]));
    expect(pendingKey(a)).not.toBe(pendingKey(b));
    expect(pendingKey([])).toBe(pendingKey([]));
    const d = pendingDiff(a, b);
    expect(d.added.map((i) => i.seq)).toEqual([9]);
    expect(d.gone).toEqual([]);
  });
});
