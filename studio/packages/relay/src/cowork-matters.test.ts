import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RelayClient } from "./api.js";
import { AGENT_STREAK_MAX, COWORK_VERSION, MATTER_QUIET_MS, agentParty, deriveMatter, matterLockKey, personParty, type CoworkRelayEvent, type Matter } from "./cowork-protocol.js";
import { CoworkStore } from "./cowork.js";
import type { RelayEvent, Via } from "./protocol.js";
import { startRelayServer, type RelayServer } from "./server.js";
import { RelayStore } from "./store.js";

// 协作的事项 (2026-11-24, plans/collab-framework.md「11-24」 step 2, the service's side): 子会话 are 事项 (old ones migrated),
// 主控 one per side and 执行 bound to one 事项 (and refused the rest), receipts per recipient (送到 → 看过 → 处理了, closing
// handles all), 撤回 / 原地改 before anyone saw it and 被 #x 取代 after, 待我处理 with a version (pushed, long poll), and
// (2026-11-25) a 事项's status from its events, AIs answering each other with a basis, 知会, references, and the board
// keeping only where a person dragged a 事项卡.

let server: RelayServer | null = null;
let store: RelayStore | null = null;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.close();
  store?.close();
  server = store = null;
});

const WANG_AI = "studio:d_wang0000000000000000000:s-doc";
const LI_AI = "studio:d_li00000000000000000000000:s-lead";
const LI_W = "studio:d_li00000000000000000000000:s-work";
const ai = (conv: string): Via => ({ kind: "ai", client: "amo-studio", conv });

async function team() {
  store = new RelayStore(":memory:");
  server = await startRelayServer({ store, host: "127.0.0.1", port: 0, name: "测试组", coworkSweepMs: 30 });
  const anon = new RelayClient(server.url);
  const wang = new RelayClient(server.url, (await anon.register("策划小王", "pw-wang")).key);
  const li = new RelayClient(server.url, (await anon.register("程序老李", "pw-li")).key);
  const zhou = new RelayClient(server.url, (await anon.register("美术小周", "pw-zhou")).key);
  const cw = await wang.createCowork({ title: "苦无改穿透", goal: "苦无穿透 2 个敌人", members: ["程序老李"] });
  await wang.joinCoworkAgent(cw.id, WANG_AI, "策划文档", { role: "lead" });
  await li.joinCoworkAgent(cw.id, LI_AI, "战斗代码", { role: "lead" });
  return { wang, li, zhou, id: cw.id };
}

async function listen(client: RelayClient): Promise<RelayEvent[]> {
  const events: RelayEvent[] = [];
  const ws = new WebSocket(`${server!.url.replace(/^http/, "ws")}/ws?key=${encodeURIComponent(client.key!)}`);
  sockets.push(ws);
  ws.on("message", (d) => events.push(JSON.parse(String(d)) as RelayEvent));
  await new Promise((ok, fail) => (ws.once("open", ok), ws.once("error", fail)));
  await expect.poll(() => events.some((e) => e.type === "hello")).toBe(true);
  return events;
}
const of = <T extends CoworkRelayEvent["type"]>(events: RelayEvent[], type: T) => events.filter((e): e is Extract<CoworkRelayEvent, { type: T }> => e.type === type);

describe("事项", () => {
  it("is opened by a 主控 or a person, numbered per cowork, with its card in the 群聊; nothing on the board (the client draws it)", async () => {
    const { wang, li, id } = await team();
    const events = await listen(wang);
    const one = await li.openMatter(id, { title: "穿透判定", body: "先改碰撞层", via: ai(LI_AI) });
    expect(one.matter).toMatchObject({ no: 1, title: "穿透判定", kind: "work", status: "todo", side: "程序老李", lead: LI_AI, owner: agentParty(LI_AI), scope: "cowork", scopeId: id, place: null, limited: false });
    expect(one.thread.request).toMatchObject({ coworkId: id, from: "程序老李", to: "程序老李" });
    expect(one.message).toMatchObject({ kind: "request", matter: one.matter.id });
    // An ask is a 事项 too (等人确认, waiting on the one asked), numbered after it.
    const two = await wang.askCowork(id, { to: "程序老李", title: "穿透几个", body: "2 个够吗？", via: ai(WANG_AI) });
    const m2 = (await wang.cowork(id)).cowork.matters!.find((m) => m.id === two.thread!.id)!;
    expect(m2).toMatchObject({ no: 2, kind: "confirm", status: "confirm", waitingOn: [personParty("程序老李")], waitingWhy: { reason: "ask", by: agentParty(WANG_AI) }, side: "策划小王" });
    expect((await li.messages(id)).messages.at(-2)).toMatchObject({ kind: "event", body: "开了事项 1「穿透判定」（待开始）", session: one.matter.id });
    await expect.poll(() => of(events, "matter").map((e) => e.matter.no)).toEqual(expect.arrayContaining([1, 2]));
    expect((await wang.coworkBoard(id)).items).toEqual([]);
    // An AI opens 事项 for its own side only.
    await expect(li.openMatter(id, { title: "给策划的", body: "x", side: "策划小王", via: ai(LI_AI) })).rejects.toMatchObject({ status: 403 });
  });

  it("moves by its events — bound, @, answered, pushed, verified — with a hand change on top; the events add up to it again", async () => {
    const { wang, li, id } = await team();
    const m = (await li.openMatter(id, { title: "穿透判定", body: "改碰撞层", via: ai(LI_AI) })).matter;
    const now = async () => (await wang.cowork(id)).cowork.matters!.find((x) => x.id === m.id)!;
    await li.joinCoworkAgent(id, LI_W, "写代码", { role: "worker", matter: "事项 1" });
    expect(await now()).toMatchObject({ status: "doing" });
    // The 执行 asks the other side's 主控 directly (by name); unanswered, it waits on it.
    const q = await li.postCowork(id, { threadId: "事项 1", body: "穿透要不要打穿护盾？", agentMentions: ["策划小王的主控"], via: ai(LI_W) });
    expect(await now()).toMatchObject({ status: "waiting", waitingOn: [agentParty(WANG_AI)], waitingWhy: { reason: "address", by: agentParty(LI_W), seq: q.message!.seq } });
    // Answered (a reply to what it was asked: no new wait), saying it is its own judgement.
    const a = await wang.postCowork(id, { threadId: m.id, body: "不打穿护盾", replyTo: `#${q.message!.seq}`, basis: { kind: "inferred", person: "策划小王" }, via: ai(WANG_AI) });
    expect(a.message).toMatchObject({ replyTo: q.message!.seq, basis: { kind: "inferred", person: "策划小王" } });
    expect(await now()).toMatchObject({ status: "doing", waitingOn: [] });
    await expect(wang.postCowork(id, { threadId: m.id, body: "x", basis: { kind: "confirmed", person: "策划小王" }, via: ai(WANG_AI) })).rejects.toMatchObject({ status: 400 });
    // Pushed, then a passing verification: 已推送, 待核对; its 主控 checks and marks 已验 by hand.
    await li.postCowork(id, { threadId: m.id, body: "推了 3f2a91c", commits: ["3F2A91C"], via: ai(LI_W) });
    expect(await now()).toMatchObject({ status: "pushed", bindings: { commits: ["3f2a91c"] } });
    await li.postCowork(id, { threadId: m.id, body: "3 个敌人穿 2 个，测了 10 次", verify: { passed: true, how: "关卡 3 实测" }, via: ai(LI_W) });
    const review = await now();
    expect(review.status).toBe("review");
    await expect(wang.patchMatter(id, m.id, { base: review.version - 1, status: "verified" })).rejects.toMatchObject({ status: 409 });
    const verified = await li.patchMatter(id, "事项 1", { base: review.version, status: "verified", note: "核对过提交", via: ai(LI_AI) });
    expect(verified.history.map((h) => [h.from, h.to, h.event, h.manual ?? false])).toEqual([
      [null, "todo", "open", false],
      ["todo", "doing", "bind", false],
      ["doing", "waiting", "address", false],
      ["waiting", "doing", "say", false],
      ["doing", "pushed", "push", false],
      ["pushed", "review", "verify", false],
      ["review", "verified", "manual", true],
    ]);
    expect((await li.messages(m.id)).messages.at(-1)?.body).toBe("事项 1：待核对 → 已验（手改：核对过提交）");
    // What happened, in order — and it adds up to the 事项 as kept.
    const ev = await li.matterEvents(id, "事项 1");
    expect(ev.events.map((e) => e.kind)).toEqual(["open", "bind", "address", "say", "say", "push", "say", "verify", "manual"]);
    expect(deriveMatter(ev.events)).toMatchObject({ status: ev.matter.status, waitingOn: ev.matter.waitingOn, history: ev.matter.history });
    // An 执行 reads its own 事项's events only.
    const other = (await li.openMatter(id, { title: "命中特效", body: "特效", via: ai(LI_AI) })).matter;
    await expect(li.matterEvents(id, other.id, LI_W)).rejects.toMatchObject({ status: 403 });
    expect((await li.matterEvents(id, m.id, LI_W)).events.length).toBe(9);
  });

  it("changes field by field; a conclusion said to be a 口径 closes it into 已定的事; a person drags its card (an AI may not); refs and wrong ones", async () => {
    const { wang, li, id } = await team();
    const a = (await li.openMatter(id, { title: "穿透判定", body: "改碰撞层", via: ai(LI_AI) })).matter;
    const b = (await li.openMatter(id, { title: "命中特效", body: "穿透时特效", via: ai(LI_AI) })).matter;
    const set = await li.patchMatter(id, a.id, { base: a.version, blocker: "等碰撞层的提交", bind: { tasks: ["task-1"] }, waitingOn: ["策划小王的 AI"], via: ai(LI_AI) });
    expect(set).toMatchObject({ status: "waiting", waitingOn: [agentParty(WANG_AI)], waitingWhy: { reason: "manual" }, blocker: "等碰撞层的提交", bindings: { tasks: ["task-1"] } });
    expect((await li.messages(a.id)).messages.at(-1)?.body).toBe("事项 1：待开始 → 等对方（改了在等谁）");
    expect((await li.patchMatter(id, a.id, { waitingOn: [], via: ai(LI_AI) })).status).toBe("doing");
    const placed = await wang.patchMatter(id, b.id, { place: { x: 2000, y: 1500.4 } });
    expect(placed).toMatchObject({ place: { x: 2000, y: 1500 }, version: b.version });
    await expect(li.patchMatter(id, b.id, { place: { x: 1, y: 1 }, via: ai(LI_AI) })).rejects.toMatchObject({ status: 403 });
    expect((await wang.patchMatter(id, b.id, { place: null })).place).toBeNull();
    const closed = await li.patchMatter(id, "事项 2", { conclusion: "穿透时只播一次特效", decided: true, via: ai(LI_AI) });
    expect(closed).toMatchObject({ status: "closed", conclusion: "穿透时只播一次特效", decided: true });
    expect((await wang.coworkEvents(id)).filter((e) => e.kind === "decision").map((e) => e.text)).toEqual(["「命中特效」：穿透时只播一次特效"]);
    // Waiting on someone not in it, a dependency on itself, a 事项 that is not there: refused.
    await expect(li.patchMatter(id, a.id, { waitingOn: [personParty("美术小周")] })).rejects.toMatchObject({ status: 400 });
    await expect(li.patchMatter(id, a.id, { dependsOn: ["事项 1"] })).rejects.toMatchObject({ status: 400 });
    await expect(li.patchMatter(id, "事项 9", { blocker: "x" })).rejects.toMatchObject({ status: 404 });
    await expect(li.postCowork(id, { threadId: "事项 9", body: "x" })).rejects.toMatchObject({ status: 404 });
    await expect(li.postCowork(id, { body: "x", agentMentions: ["美术的主控"] })).rejects.toMatchObject({ status: 400 });
    expect((await li.patchMatter(id, b.id, { dependsOn: ["事项 1"] })).dependsOn).toEqual([a.id]);
  });

  it("follows the 子会话 asked of a person: 等人确认 while with them, 在做 once answered, 关闭 when done or concluded", async () => {
    const { wang, li, id } = await team();
    const sub = await wang.askCowork(id, { to: "程序老李", title: "穿透几个", body: "2 个够吗？" });
    const tid = sub.thread!.id;
    const matter = async () => (await wang.cowork(id)).cowork.matters!.find((m) => m.id === tid)!;
    expect(await matter()).toMatchObject({ status: "confirm", kind: "work", waitingOn: [personParty("程序老李")] });
    await li.send(tid, { kind: "reply", body: "够" });
    expect(await matter()).toMatchObject({ status: "doing", waitingOn: [] });
    await wang.concludeCowork(id, tid, "穿透 2 个");
    expect(await matter()).toMatchObject({ status: "closed", conclusion: "穿透 2 个" });
    expect((await matter()).history.map((h) => [h.to, h.event])).toEqual([
      ["confirm", "open"],
      ["doing", "answer"],
      ["closed", "conclude"],
    ]);
  });
});

describe("主控和执行", () => {
  it("has one 主控 per side (a second is refused saying who); an 执行 is bound to one 事项 and refused everything else", async () => {
    const { wang, li, id } = await team();
    await expect(li.joinCoworkAgent(id, LI_W, "写代码", { role: "lead" })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("已经有主控：程序老李 的 AI · 战斗代码") });
    const m = (await li.openMatter(id, { title: "穿透判定", body: "改碰撞层", via: ai(LI_AI) })).matter;
    const other = (await li.openMatter(id, { title: "命中特效", body: "特效", via: ai(LI_AI) })).matter;
    await expect(li.joinCoworkAgent(id, LI_W, "写代码", { role: "worker" })).rejects.toMatchObject({ status: 400 });
    const { agent } = await li.joinCoworkAgent(id, LI_W, "写代码", { role: "worker", matter: m.id });
    expect(agent).toMatchObject({ role: "worker", matter: m.id });
    expect((await li.cowork(id)).cowork.matters!.find((x) => x.id === m.id)!.bindings.sessions).toEqual([LI_W]);
    expect((await li.messages(id)).messages.at(-1)?.body).toBe("把 程序老李 的 AI · 写代码 拉了进来（执行 · 事项 1）");

    const w = ai(LI_W);
    // It posts facts in its own 事项 (and may @ its 主控 there) …
    expect((await li.postCowork(id, { threadId: m.id, body: "碰撞层改好了，测了 3 个敌人", agentMentions: [LI_AI], via: w })).message?.body).toContain("碰撞层");
    // … and nothing else.
    const refused = { status: 403 };
    await expect(li.postCowork(id, { body: "群聊里说一句", via: w })).rejects.toMatchObject({ ...refused, message: expect.stringContaining("你是执行（事项 1「穿透判定」）") });
    await expect(li.postCowork(id, { threadId: other.id, body: "别的事项", via: w })).rejects.toMatchObject(refused);
    await expect(li.postCowork(id, { threadId: m.id, body: "@策划小王", mentions: ["策划小王"], via: w })).rejects.toMatchObject(refused);
    await expect(li.patchMatter(id, m.id, { status: "pushed", via: w })).rejects.toMatchObject(refused);
    await expect(li.concludeCowork(id, m.id, "好了", w)).rejects.toMatchObject(refused);
    await expect(li.openMatter(id, { title: "再开一个", body: "x", via: w })).rejects.toMatchObject(refused);
    await expect(li.askCowork(id, { to: "策划小王", title: "问", body: "x", via: w })).rejects.toMatchObject(refused);
    await expect(li.coworkBoardOps(id, [{ op: "add", item: { kind: "note" } }], w)).rejects.toMatchObject(refused);
    await expect(li.updateCowork(id, { goal: "改目标", via: w })).rejects.toMatchObject(refused);
    // It reads its own 事项 only, and its card only.
    await wang.postCowork(id, { body: "群聊里的进度" });
    const feed = await li.coworkFeed(id, 0, LI_W);
    expect(new Set(feed.messages.map((x) => x.threadId))).toEqual(new Set([m.id]));
    // No cards: its 事项卡 is drawn from the 事项 it reads.
    expect((await li.coworkBoard(id, 0, LI_W)).items).toEqual([]);

    // Its owner (or the side's 主控) makes it the 主控 once the other leaves.
    await expect(li.setCoworkAgentRole(id, LI_W, "lead")).rejects.toMatchObject({ status: 409 });
    await li.leaveCoworkAgent(id, LI_AI);
    expect((await li.setCoworkAgentRole(id, LI_W, "lead")).agent).toMatchObject({ role: "lead", matter: null });
    expect((await wang.cowork(id)).cowork.matters!.find((x) => x.id === m.id)!.lead).toBe(LI_W);
  });
});

describe("回执和待我处理", () => {
  it("gives each recipient a receipt: the 群聊 to people and 主控, a 事项 to its 主控 and 执行; 看过 by reading, 处理了 by marking or closing", async () => {
    const { wang, li, zhou, id } = await team();
    await wang.addCoworkMembers(id, ["美术小周"]);
    const chat = await wang.postCowork(id, { body: "今天先把穿透做完" });
    expect(chat.message!.receipts!.map((r) => [r.party, r.state])).toEqual([
      [personParty("程序老李"), "delivered"],
      [personParty("美术小周"), "delivered"],
      [agentParty(WANG_AI), "queued"],
      [agentParty(LI_AI), "queued"],
    ]);
    const m = (await li.openMatter(id, { title: "穿透判定", body: "改碰撞层", waitingOn: [agentParty(WANG_AI)], via: ai(LI_AI) })).matter;
    await li.joinCoworkAgent(id, LI_W, "写代码", { role: "worker", matter: m.id });
    const fact = await li.postCowork(id, { threadId: m.id, body: "测了 3 个敌人，穿透 2 个", via: ai(LI_W) });
    // Its 主控, the 主控 of the side it waits on; no people.
    expect(fact.message!.receipts!.map((r) => r.party).sort()).toEqual([agentParty(LI_AI), agentParty(WANG_AI)].sort());

    // 看过: a person opening the thread; an agent reading the feed.
    const liEvents = await listen(li);
    await li.read(id);
    expect((await wang.messages(id)).messages.find((x) => x.seq === chat.message!.seq)!.receipts!.find((r) => r.party === personParty("程序老李"))).toMatchObject({ state: "seen" });
    await li.coworkFeed(id, 0, LI_AI);
    expect((await li.messages(m.id)).messages.find((x) => x.seq === fact.message!.seq)!.receipts!.find((r) => r.party === agentParty(LI_AI))).toMatchObject({ state: "seen" });
    await expect.poll(() => of(liEvents, "receipts").length).toBeGreaterThan(0);

    // 待我处理: 小王's 主控 — the 事项 waits on it, and a message there is to it; 小周 has nothing.
    const wangList = (await wang.coworkPending({ coworkId: id, party: agentParty(WANG_AI) })).lists[0]!;
    // Newest first; the 事项's opening message and its 等你 fall in the same or the next millisecond, so either order.
    expect(wangList.items[0]).toMatchObject({ kind: "message", matter: m.id, seq: fact.message!.seq });
    expect(wangList.items.slice(1).map((i) => [i.kind, i.matter, i.seq])).toEqual(
      expect.arrayContaining([
        ["waiting", m.id, null],
        ["message", m.id, (await li.messages(m.id)).messages[0]!.seq],
      ]),
    );
    expect(wangList.items.length).toBe(3);
    expect((await zhou.coworkPending({ coworkId: id })).lists[0]!.items).toEqual([]);
    // Reading the list counts as 送到 for that agent.
    expect((await li.messages(m.id)).messages.find((x) => x.seq === fact.message!.seq)!.receipts!.find((r) => r.party === agentParty(WANG_AI))).toMatchObject({ state: "delivered" });
    // Someone else's agent's list, or another's: refused.
    await expect(li.coworkPending({ party: agentParty(WANG_AI) })).rejects.toMatchObject({ status: 403 });
    await expect(li.coworkPending({ party: personParty("策划小王") })).rejects.toMatchObject({ status: 403 });

    // 处理了 by marking; the 事项 no longer waiting: the list empties, its version goes up, and the owner is told.
    const wangEvents = await listen(wang);
    await wang.markCowork(id, { mark: "handled", seqs: [fact.message!.seq], via: ai(WANG_AI) });
    await li.patchMatter(id, m.id, { waitingOn: [], via: ai(LI_AI) });
    const after = (await wang.coworkPending({ coworkId: id, party: agentParty(WANG_AI) })).lists[0]!;
    expect(after.items.map((i) => i.seq)).toEqual([(await li.messages(m.id)).messages[0]!.seq]);
    expect(after.version).toBeGreaterThan(wangList.version);
    await expect.poll(() => of(wangEvents, "pending").filter((e) => e.party === agentParty(WANG_AI)).at(-1)?.version).toBe(after.version);
    // Closing the 事项 (2026-11-25): the closing side's are 处理了, by closing; the other side's unseen ones stay as they
    // are, and its 主控 and person get 「事项 1 关了」 instead, until they have seen it.
    const opening = (await li.messages(m.id)).messages[0]!.seq;
    await li.patchMatter(id, m.id, { status: "closed", via: ai(LI_AI) });
    const msgs = (await li.messages(m.id)).messages;
    expect(msgs.find((x) => x.seq === fact.message!.seq)!.receipts!.find((r) => r.party === agentParty(LI_AI))).toMatchObject({ state: "handled", byClose: true });
    expect(msgs.find((x) => x.seq === opening)!.receipts!.find((r) => r.party === agentParty(WANG_AI))).toMatchObject({ state: "delivered" });
    const line = msgs.find((x) => x.closed)!;
    expect(line).toMatchObject({ kind: "event", closed: true, body: "事项 1「穿透判定」关了：（没写结论）" });
    expect(line.receipts!.map((r) => r.party).sort()).toEqual([agentParty(WANG_AI), personParty("策划小王")].sort());
    const wangClosed = (await wang.coworkPending({ coworkId: id, party: agentParty(WANG_AI) })).lists[0]!.items;
    expect(wangClosed.map((i) => [i.kind, i.matter, i.seq])).toEqual([["closed", m.id, line.seq]]);
    expect((await wang.coworkPending({ coworkId: id })).lists[0]!.items.map((i) => i.kind)).toEqual(["closed"]);
    expect((await li.coworkPending({ coworkId: id, party: agentParty(LI_AI) })).lists[0]!.items).toEqual([]);
    // Seen (the agent reads; the person marks it 看过了): gone.
    await li.coworkFeed(id, 0, LI_AI);
    await wang.markCowork(id, { mark: "seen", seqs: [line.seq], via: ai(WANG_AI) });
    expect((await wang.coworkPending({ coworkId: id, party: agentParty(WANG_AI) })).lists[0]!.items).toEqual([]);
    await wang.markCowork(id, { mark: "seen", seqs: [line.seq] });
    expect((await wang.coworkPending({ coworkId: id })).lists[0]!.items).toEqual([]);
    expect((await wang.messages(m.id)).messages.find((x) => x.closed)!.receipts!.find((r) => r.party === personParty("策划小王"))).toMatchObject({ state: "handled" });
  });

  it("counts an @ in the 群聊 until handled, a reply to it handles it, and a long poll answers when the list changes", async () => {
    const { wang, li, id } = await team();
    const first = await li.coworkPending({ party: agentParty(LI_AI) });
    expect(first.lists.map((l) => [l.coworkId, l.items])).toEqual([[id, []]]);
    const waiting = li.coworkPending({ party: agentParty(LI_AI), since: first.version, wait: 5000 });
    await new Promise((r) => setTimeout(r, 80));
    const asked = await wang.postCowork(id, { body: "老李的 AI，穿透要改几处？", agentMentions: [LI_AI] });
    const got = await waiting;
    expect(got.version).toBeGreaterThan(first.version);
    expect(got.lists[0]!.items.map((i) => [i.kind, i.seq, i.matter])).toEqual([["mention", asked.message!.seq, null]]);
    await li.postCowork(id, { body: "两处", replyTo: asked.message!.seq, via: ai(LI_AI) });
    expect((await li.coworkPending({ party: agentParty(LI_AI) })).lists[0]!.items).toEqual([]);
  });
});

describe("撤回、原地改、取代", () => {
  it("withdraws or rewrites while nobody has seen it; after, a new message supersedes it and names the agents that had seen it", async () => {
    const { wang, li, id } = await team();
    const events = await listen(li);
    const a = await li.postCowork(id, { body: "穿透 3 个", agentMentions: [WANG_AI], via: ai(LI_AI) });
    const re = await li.rewriteCoworkMessage(id, a.message!.seq, { body: "穿透 2 个", via: ai(LI_AI) });
    expect(re).toMatchObject({ body: "穿透 2 个", editedAt: expect.any(Number) });
    await expect.poll(() => of(events, "message-changed").at(-1)?.message.body).toBe("穿透 2 个");
    // Only its author's agent (or its author) may.
    await expect(wang.rewriteCoworkMessage(id, a.message!.seq, { body: "x" })).rejects.toMatchObject({ status: 403 });
    const b = await li.postCowork(id, { body: "说错了，忽略", via: ai(LI_AI) });
    const gone = await li.withdrawCoworkMessage(id, b.message!.seq, ai(LI_AI));
    expect(gone).toMatchObject({ body: "", withdrawnAt: expect.any(Number) });
    // 小王's 主控 read the first: no rewriting it now.
    await wang.coworkFeed(id, 0, WANG_AI);
    await expect(li.rewriteCoworkMessage(id, a.message!.seq, { body: "穿透 1 个", via: ai(LI_AI) })).rejects.toMatchObject({ status: 409 });
    await expect(li.withdrawCoworkMessage(id, a.message!.seq, ai(LI_AI))).rejects.toMatchObject({ status: 409 });
    const c = await li.postCowork(id, { body: "改成穿透 1 个", supersedes: a.message!.seq, via: ai(LI_AI) });
    expect(c.message && c.superseded).toEqual({ seq: a.message!.seq, supersededBy: c.message!.seq, seenByAgents: [WANG_AI] });
    expect((await li.messages(id)).messages.find((x) => x.seq === a.message!.seq)).toMatchObject({ supersededBy: c.message!.seq });
    // The superseded @ is no longer to handle.
    expect((await wang.coworkPending({ party: agentParty(WANG_AI) })).lists[0]!.items.map((i) => i.seq)).not.toContain(a.message!.seq);
    await expect(li.postCowork(id, { body: "再取代一次", supersedes: a.message!.seq, via: ai(LI_AI) })).rejects.toMatchObject({ status: 409 });
  });
});

describe("旧数据", () => {
  it("turns 子会话 from before into 事项 (open → 在做, concluded → 关闭) and leaves the agents 未分角色", () => {
    const db = new RelayStore(":memory:");
    const now = () => 1_800_000_000_000;
    const cw = new CoworkStore(db, now);
    db.register("策划小王", "pw-wang");
    db.register("程序老李", "pw-li");
    const c = cw.create("策划小王", { title: "老协作", members: ["程序老李"] }).cowork;
    cw.joinAgent(c.id, "策划小王", WANG_AI, "文档", "lead");
    const open = cw.ask(c.id, "策划小王", { to: "程序老李", title: "还开着", body: "?" });
    const done = cw.ask(c.id, "策划小王", { to: "程序老李", title: "定了", body: "?" });
    cw.conclude(c.id, done.thread!.id, "程序老李", { conclusion: "就这样" });
    // As a database from before: no 事项, no roles; two agents of 小王.
    const raw = db.db as DatabaseSync;
    raw.exec("DELETE FROM cowork_matters; DELETE FROM cowork_matter_events; ALTER TABLE cowork_agents DROP COLUMN role; ALTER TABLE cowork_agents DROP COLUMN matter;");
    raw.prepare("INSERT INTO cowork_agents (cowork_id, mark, owner, label, joined_at) VALUES (?, ?, ?, ?, ?)").run(c.id, "studio:d_wang0000000000000000000:s-two", "策划小王", "第二个", now() + 1);
    const again = new CoworkStore(db, now);
    const ms = again.view(c.id).matters as Matter[];
    expect(ms.map((m) => [m.no, m.title, m.status, m.conclusion, m.side, m.waitingOn])).toEqual([
      // 2026-11-25 (plans/collab-framework.md 「已有的协作」): open → 在做, moved by events from then on.
      [1, "还开着", "doing", null, "策划小王", []],
      [2, "定了", "closed", "就这样", "策划小王", []],
    ]);
    expect(ms[0]!.id).toBe(open.thread!.id);
    // Its events add up to it.
    expect(deriveMatter(again.matters.events(ms[1]!.id))).toMatchObject({ status: "closed", conclusion: "就这样" });
    // No roles before: 未分角色, both of 小王's (as before, a side may have several) until a person picks.
    expect(again.view(c.id).agents.map((a) => [a.label, a.role])).toEqual([
      ["文档", "unassigned"],
      ["第二个", "unassigned"],
    ]);
    db.close();
  });
});

describe("AI 之间、知会、久没动静", () => {
  it("two AIs going on AGENT_STREAK_MAX times in a 事项 with no person: 等人确认 on both people, a line in the 群聊, the AIs get nothing; a person goes on", async () => {
    const { wang, li, id } = await team();
    const m = (await li.openMatter(id, { title: "穿透判定", body: "改碰撞层", via: ai(LI_AI) })).matter;
    // Its opening message (by 老李's 主控) is the first of them.
    for (let i = 1; i < AGENT_STREAK_MAX; i++) {
      const lead = i % 2 ? LI_AI : WANG_AI;
      await (i % 2 ? li : wang).postCowork(id, { threadId: m.id, body: `第 ${i} 条`, via: ai(lead) });
    }
    const now = (await wang.cowork(id)).cowork.matters!.find((x) => x.id === m.id)!;
    expect(now).toMatchObject({ status: "confirm", limited: true, waitingWhy: { reason: "limit" } });
    expect([...now.waitingOn].sort()).toEqual([personParty("程序老李"), personParty("策划小王")].sort());
    expect((await wang.messages(id)).messages.at(-1)?.body).toBe(`事项 1「穿透判定」里 AI 之间来回了 ${AGENT_STREAK_MAX} 条，没有人说话：停下来等 程序老李、策划小王 看一下，AI 先不再被叫醒`);
    expect((await li.coworkPending({ coworkId: id, party: agentParty(LI_AI) })).lists[0]!.items).toEqual([]);
    expect((await wang.coworkPending({ coworkId: id })).lists[0]!.items.map((i) => [i.kind, i.matterNo, i.why.reason])).toEqual([["waiting", 1, "limit"]]);
    await wang.postCowork(id, { threadId: m.id, body: "按 2 个穿透做，别再争了" });
    expect((await wang.cowork(id)).cowork.matters!.find((x) => x.id === m.id)!).toMatchObject({ status: "doing", limited: false, waitingOn: [] });
  });

  it("a 知会 is in the person's 待我处理 until they mark it 看过了", async () => {
    const { wang, li, id } = await team();
    const n = await wang.postCowork(id, { body: "射速表改了第 3 行", notice: ["程序老李"] });
    expect(n.message).toMatchObject({ notice: ["程序老李"] });
    const before = (await li.coworkPending({ coworkId: id })).lists[0]!;
    expect(before.items.map((i) => [i.kind, i.seq, i.body])).toEqual([["notice", n.message!.seq, "射速表改了第 3 行"]]);
    // Opening it is not enough; 看过了 is.
    await li.read(id);
    expect((await li.coworkPending({ coworkId: id })).lists[0]!.items.length).toBe(1);
    const marked = await li.markCowork(id, { mark: "seen", seqs: [n.message!.seq] });
    expect(marked.changed.map((c) => c.receipt.state)).toEqual(["handled"]);
    expect((await li.coworkPending({ coworkId: id })).lists[0]!.items).toEqual([]);
    // An AI's 知会 to a person goes as well; an 执行 may not.
    const m = (await li.openMatter(id, { title: "穿透判定", body: "x", via: ai(LI_AI) })).matter;
    await li.joinCoworkAgent(id, LI_W, "写代码", { role: "worker", matter: m.id });
    await expect(li.postCowork(id, { threadId: m.id, body: "x", notice: ["策划小王"], via: ai(LI_W) })).rejects.toMatchObject({ status: 403 });
  });
});

// What was settled after the v6 acceptance (2026-11-25, plans/collab-agent-spec.md 「v6 之后定的」).
describe("v6 之后定的", () => {
  it("an AI's inferred answer is a 知会 to the person it speaks for, with 「! 我的判断」, until they have seen it", async () => {
    const { wang, li, id } = await team();
    const m = (await li.openMatter(id, { title: "冰冻挡不挡", body: "冰冻的敌人挡不挡苦无？", waitingOn: [agentParty(WANG_AI)], via: ai(LI_AI) })).matter;
    const q = (await li.messages(m.id)).messages[0]!;
    const a = await wang.postCowork(id, { threadId: m.id, body: "我看挡：冰冻算实体", replyTo: q.seq, basis: { kind: "inferred", person: "策划小王" }, via: ai(WANG_AI) });
    expect(a.message).toMatchObject({ basis: { kind: "inferred", person: "策划小王" }, notice: ["策划小王"] });
    expect(a.message!.receipts!.map((r) => r.party)).toContain(personParty("策划小王"));
    const list = (await wang.coworkPending({ coworkId: id })).lists[0]!.items;
    expect(list.map((i) => [i.kind, i.seq])).toEqual([["notice", a.message!.seq]]);
    expect(list[0]!.why.text).toMatch(/^! 我的判断/);
    // A confirmed answer is not; 看过了 takes it away.
    const c = await wang.postCowork(id, { threadId: m.id, body: "带盾的挡", basis: { kind: "confirmed", person: "策划小王", at: Date.now() }, via: ai(WANG_AI) });
    expect(c.message!.notice).toBeUndefined();
    await wang.markCowork(id, { mark: "seen", seqs: [a.message!.seq] });
    expect((await wang.coworkPending({ coworkId: id })).lists[0]!.items).toEqual([]);
  });

  it("only a 「等人确认」's conclusion or one closed with decided goes into 已定的事; work's stays in its 事项", async () => {
    const { wang, li, id } = await team();
    const decisions = async () => (await wang.coworkEvents(id)).filter((e) => e.kind === "decision").map((e) => e.text);
    const work = (await li.openMatter(id, { title: "穿透判定", body: "x", via: ai(LI_AI) })).matter;
    expect(await li.patchMatter(id, work.id, { conclusion: "做完了，合进 master", via: ai(LI_AI) })).toMatchObject({ status: "closed", decided: false });
    const gate = (await li.openMatter(id, { title: "等程序老李确认：合 master", body: "合吗", kind: "confirm", waitingOn: [personParty("程序老李")], via: ai(LI_AI) })).matter;
    await li.patchMatter(id, gate.id, { conclusion: "老李确认合", via: ai(LI_AI) });
    const rule = (await li.openMatter(id, { title: "穿透上限", body: "x", via: ai(LI_AI) })).matter;
    await li.patchMatter(id, rule.id, { conclusion: "穿透 2 个", decided: true, via: ai(LI_AI) });
    expect(await decisions()).toEqual(["「等程序老李确认：合 master」：老李确认合", "「穿透上限」：穿透 2 个"]);
    // cowork_conclude (the old name of close) by an AI goes by the kind.
    const more = (await li.openMatter(id, { title: "命中特效", body: "x", via: ai(LI_AI) })).matter;
    const out = await li.concludeCowork(id, more.id, "特效只播一次", ai(LI_AI));
    expect(out.event).toBeNull();
    expect(await decisions()).toHaveLength(2);
  });

  it("an AI may not change the other side's 事项 (403 saying whose it is); it may still say something there, and people may", async () => {
    const { wang, li, id } = await team();
    const m = (await wang.openMatter(id, { title: "实现射速上限", body: "程序这边做", waitingOn: [agentParty(LI_AI)], via: ai(WANG_AI) })).matter;
    expect(m.side).toBe("策划小王");
    for (const patch of [{ status: "verified" as const }, { waitingOn: [] }, { blocker: "等表" }, { conclusion: "做完了" }, { status: "closed" as const }]) {
      await expect(li.patchMatter(id, m.id, { ...patch, via: ai(LI_AI) })).rejects.toMatchObject({ status: 403, message: expect.stringContaining("这件归 策划小王 那方，在事项里 @ 它") });
    }
    await expect(li.concludeCowork(id, m.id, "做完了", ai(LI_AI))).rejects.toMatchObject({ status: 403 });
    await li.postCowork(id, { threadId: m.id, body: "做完了，提交 abc1234", agentMentions: [WANG_AI], via: ai(LI_AI) });
    // Its own side's AI and the other side's person may.
    expect((await li.patchMatter(id, m.id, { blocker: "等表" })).blocker).toBe("等表");
    expect((await wang.patchMatter(id, m.id, { conclusion: "做完了", via: ai(WANG_AI) })).status).toBe("closed");
  });

  it("待核对 is in its 主控's 待我处理 only: a passing verification answers what was still asked there", async () => {
    const { wang, li, id } = await team();
    // 小王's 主控 opens the work for 老李's side; 老李's 执行 does it and posts the passing result.
    const m = (await wang.openMatter(id, { title: "实现射速上限", body: "程序这边做", waitingOn: [agentParty(LI_AI)], via: ai(WANG_AI) })).matter;
    await li.joinCoworkAgent(id, LI_W, "写代码", { role: "worker", matter: m.id });
    await li.postCowork(id, { threadId: m.id, body: "字符串算填错吗？", agentMentions: [WANG_AI], via: ai(LI_AI) });
    await wang.postCowork(id, { threadId: m.id, body: "算", agentMentions: [LI_AI], basis: { kind: "confirmed", person: "策划小王", at: Date.now() }, via: ai(WANG_AI) });
    const v = await li.postCowork(id, { threadId: m.id, body: "推了，测试 12/12 过", commits: ["abc1234"], verify: { passed: true, how: "npm test" }, via: ai(LI_W) });
    const now = (await li.matterEvents(id, m.id)).matter;
    expect(now).toMatchObject({ status: "review", waitingOn: [] });
    const kinds = async (c: RelayClient, mark: string) => (await c.coworkPending({ coworkId: id, party: agentParty(mark) })).lists[0]!.items.filter((i) => i.matter === m.id).map((i) => i.kind);
    expect(await kinds(wang, WANG_AI)).toContain("review");
    expect(await kinds(li, LI_AI)).not.toContain("review");
    expect(await kinds(li, LI_AI)).not.toContain("waiting");
    const item = (await wang.coworkPending({ coworkId: id, party: agentParty(WANG_AI) })).lists[0]!.items.find((i) => i.kind === "review")!;
    expect(item).toMatchObject({ matterStatus: "review", seqs: [v.message!.seq] });
    // Checked: gone.
    await wang.patchMatter(id, m.id, { status: "verified", note: "核对过", via: ai(WANG_AI) });
    expect(await kinds(wang, WANG_AI)).not.toContain("review");
  });

  it("久没动静: 在做 with no event for MATTER_QUIET_MS goes into its 主控's 待我处理, and the sweep finds it", () => {
    const db = new RelayStore(":memory:");
    let t = 1_800_000_000_000;
    const cw = new CoworkStore(db, () => t);
    db.register("策划小王", "pw-wang");
    db.register("程序老李", "pw-li");
    const c = cw.create("程序老李", { title: "协作", members: ["策划小王"] }).cowork;
    cw.joinAgent(c.id, "程序老李", LI_AI, "主控", "lead");
    const m = cw.openMatter(c.id, "程序老李", { title: "穿透判定", body: "x" }).matter;
    cw.joinAgent(c.id, "程序老李", LI_W, "执行", "worker", m.id);
    expect(cw.matters.get(m.id)!.status).toBe("doing");
    const quiet = () => cw.matters.pending(c.id, agentParty(LI_AI)).items.filter((i) => i.kind === "quiet");
    t += MATTER_QUIET_MS - 1;
    expect(quiet()).toEqual([]);
    expect(cw.matters.quietDue(t - 1000, t)).toEqual([]);
    t += 1;
    expect(cw.matters.quietDue(t - 1000, t)).toEqual([c.id]);
    expect(quiet().map((i) => [i.matterNo, i.why.text])).toEqual([[1, "在做，超过 2 小时没有动静"]]);
    // Something happens: gone.
    cw.post(m.id, "程序老李", { kind: "text", body: "还在改", via: ai(LI_W) });
    expect(quiet()).toEqual([]);
    db.close();
  });
});

// What Studio 0.9.81 sends (its RelayClient, before 事项 and roles), word for word: it keeps working against this service
// (2026-11-25, plans/collab-framework.md 「已有的协作、新旧版本混用」).
describe("旧客户端连新服务器", () => {
  const raw = async (key: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${server!.url}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  it("joins without a role (未分角色, several on a side), posts, @s, asks, concludes, writes the board and notes as before; /api/health says what it can", async () => {
    store = new RelayStore(":memory:");
    server = await startRelayServer({ store, host: "127.0.0.1", port: 0, name: "测试组", coworkSweepMs: 30 });
    const anon = new RelayClient(server.url);
    const wangKey = (await anon.register("策划小王", "pw-wang")).key;
    const liKey = (await anon.register("程序老李", "pw-li")).key;
    expect((await anon.health()).cowork).toBe(COWORK_VERSION);
    const id = (await raw(wangKey, "POST", "/api/cowork", { title: "苦无改穿透", goal: "苦无穿透 2 个敌人", repo: "", branch: "", members: ["程序老李"], options: { aiInitiates: true } })).body.cowork.id as string;
    // Two of 老李's sessions, the old way: no role, both in.
    for (const [mark, label] of [[LI_AI, "战斗代码"], [LI_W, "写代码"]]) {
      const j = await raw(liKey, "POST", `/api/cowork/${id}/agents`, { mark, label });
      expect(j.status).toBe(200);
      expect(j.body.agent).toMatchObject({ mark, role: "unassigned" });
    }
    expect((await raw(wangKey, "POST", `/api/cowork/${id}/agents`, { mark: WANG_AI, label: "策划文档" })).status).toBe(200);
    // Both post in the 群聊 and @ (by mark) at once; the @-ed AI is sent it.
    const post = await raw(liKey, "POST", `/api/cowork/${id}/messages`, { body: "穿透层改好了", mentions: ["策划小王"], agentMentions: [WANG_AI], via: ai(LI_AI) });
    expect(post.status).toBe(200);
    expect(post.body.message).toMatchObject({ body: "穿透层改好了", mentions: ["策划小王"] });
    expect(post.body.draft ?? null).toBeNull();
    expect((await raw(liKey, "POST", `/api/cowork/${id}/messages`, { body: "测试也过了", via: ai(LI_W) })).status).toBe(200);
    const inbox = await raw(wangKey, "GET", `/api/cowork-inbox?prefix=${encodeURIComponent("studio:d_wang")}`);
    expect(inbox.body.items.map((d: { delivery: { agent: string } }) => d.delivery.agent)).toContain(WANG_AI);
    // cowork_ask and cowork_conclude as they were.
    const ask = await raw(liKey, "POST", `/api/cowork/${id}/sessions`, { to: "策划小王", title: "穿透几个", body: "2 个够吗？", questions: [{ text: "几个？", options: ["2", "3"] }], via: ai(LI_W) });
    expect(ask.status).toBe(200);
    const tid = ask.body.thread.id as string;
    expect((await raw(wangKey, "POST", `/api/threads/${tid}/messages`, { body: "2 个" })).status).toBe(200);
    const done = await raw(liKey, "POST", `/api/cowork/${id}/sessions/${tid}/conclude`, { conclusion: "穿透 2 个", via: ai(LI_W) });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ thread: { id: tid }, event: { kind: "decision" } });
    // The board, notes and commits, the feed, the whole view (drafts and options still there for it to read).
    const ops = await raw(liKey, "POST", `/api/cowork/${id}/board/ops`, { ops: [{ op: "add", opId: "o1", item: { kind: "note", text: "碰撞层", x: 0, y: 0 } }], via: ai(LI_W) });
    expect(ops.status).toBe(200);
    expect(ops.body.applied.length).toBe(1);
    expect((await raw(liKey, "GET", `/api/cowork/${id}/board?after=0`)).body.items.map((i: { kind: string }) => i.kind)).toEqual(["note"]);
    const ev = await raw(liKey, "POST", `/api/cowork/${id}/events`, { kind: "commit", text: "推了", commit: "3f2a91c", files: ["src/a.ts"], via: ai(LI_AI) });
    expect(ev.status).toBe(200);
    expect(ev.body).toHaveProperty("event");
    expect(ev.body).toHaveProperty("board");
    const feed = await raw(liKey, "GET", `/api/cowork/${id}/feed?after=0&agent=${encodeURIComponent(LI_W)}`);
    expect(feed.body.messages.length).toBeGreaterThan(3);
    expect(typeof feed.body.lastSeq).toBe("number");
    const view = await raw(liKey, "GET", `/api/cowork/${id}`);
    expect(view.body).toMatchObject({ drafts: [], cowork: { id, options: expect.any(Object) } });
    expect(view.body.cowork.agents.map((a: { role: string }) => a.role)).toEqual(["unassigned", "unassigned", "unassigned"]);
    // A 主控 named later does not take the others' rights away; one 主控 per side still.
    await raw(liKey, "POST", `/api/cowork/${id}/agents/role`, { mark: LI_AI, role: "lead" });
    expect((await raw(liKey, "POST", `/api/cowork/${id}/messages`, { body: "还能说", via: ai(LI_W) })).status).toBe(200);
    expect((await raw(liKey, "POST", `/api/cowork/${id}/agents/role`, { mark: LI_W, role: "lead" })).status).toBe(409);
  });

  it("a draft kept from before 「AI 发起 @ 和提问」 went is still its owner's to send or drop, once", async () => {
    const { li, wang, id } = await team();
    const db = store!.db as DatabaseSync;
    const put = (did: string, payload: unknown) =>
      db.prepare("INSERT INTO cowork_drafts (id, cowork_id, agent, owner, kind, thread_id, payload, state, created_at) VALUES (?, ?, ?, '程序老李', 'post', ?, ?, 'pending', ?)").run(did, id, LI_AI, id, JSON.stringify(payload), Date.now());
    put("dr_0000000000000001", { body: "@策划小王 看下这个", mentions: ["策划小王"], via: ai(LI_AI) });
    put("dr_0000000000000002", { body: "不发了的", mentions: ["策划小王"], via: ai(LI_AI) });
    expect((await li.coworkDrafts(id)).map((d) => d.id)).toEqual(["dr_0000000000000001", "dr_0000000000000002"]);
    expect(await wang.coworkDrafts(id)).toEqual([]);
    expect((await li.decideCoworkDraft(id, "dr_0000000000000001", { action: "send" })).state).toBe("sent");
    expect((await li.decideCoworkDraft(id, "dr_0000000000000002", { action: "drop" })).state).toBe("dropped");
    await expect(li.decideCoworkDraft(id, "dr_0000000000000001", { action: "send" })).rejects.toMatchObject({ status: 409 });
    expect((await wang.messages(id)).messages.some((m) => m.body === "@策划小王 看下这个")).toBe(true);
    expect(await li.coworkDrafts(id)).toEqual([]);
    // And no new ones: an AI's @ goes at once.
    expect((await li.postCowork(id, { body: "直接发", mentions: ["策划小王"], via: ai(LI_AI) })).message).toBeTruthy();
    expect(await li.coworkDrafts(id)).toEqual([]);
  });
});

// Two people at one 事项卡 or one 事项's edit box (2026-11-25, the user: 「a 在拖拽卡 b 就不拖拽，省得出现并发出问题」).
describe("拖事项卡、改事项：锁和版本", () => {
  it("one drags at a time; a drop with an older placeVersion goes back; the lock is pushed and listed, and goes on drop", async () => {
    const { wang, li, id } = await team();
    const m = (await li.openMatter(id, { title: "穿透判定", body: "改碰撞层", via: ai(LI_AI) })).matter;
    expect(m.placeVersion).toBe(0);
    const liEvents = await listen(li);
    // Both start dragging at once: one gets it.
    const both = await Promise.allSettled([wang.lockMatter(id, m.id, "place", true), li.lockMatter(id, m.id, "place", true)]);
    expect(both.filter((r) => r.status === "fulfilled").length).toBe(1);
    const lost = both.find((r) => r.status === "rejected") as PromiseRejectedResult;
    const [holder, other] = both[0]!.status === "fulfilled" ? [wang, li] : [li, wang];
    const holderName = holder === wang ? "策划小王" : "程序老李";
    expect(lost.reason).toMatchObject({ status: 409, message: `${holderName}正在移动这张事项卡`, data: { lock: { card: matterLockKey("place", m.id), by: holderName }, matter: { id: m.id } } });
    await expect.poll(() => of(liEvents, "board-lock").map((e) => [e.card, e.lock?.by ?? null])).toContainEqual([matterLockKey("place", m.id), holderName]);
    expect((await other.coworkBoard(id)).locks.map((l) => l.card)).toEqual([matterLockKey("place", m.id)]);
    // The other cannot drop it meanwhile; an AI never places.
    await expect(other.patchMatter(id, m.id, { place: { x: 5, y: 5 }, placeBase: 0 })).rejects.toMatchObject({ status: 409, data: { lock: { by: holderName } } });
    await expect(li.patchMatter(id, m.id, { place: { x: 1, y: 1 }, via: ai(LI_AI) })).rejects.toMatchObject({ status: 403 });
    // The holder drops it: written, placeVersion up, the 事项's version not; the lock is gone (and pushed so).
    const dropped = await holder.patchMatter(id, m.id, { place: { x: 400, y: 300 }, placeBase: 0 });
    expect(dropped).toMatchObject({ place: { x: 400, y: 300 }, placeVersion: 1, version: m.version });
    expect((await other.coworkBoard(id)).locks).toEqual([]);
    await expect.poll(() => of(liEvents, "board-lock").filter((e) => e.card === matterLockKey("place", m.id)).at(-1)).toMatchObject({ lock: null });
    // The other drags from what it read (placeVersion 0): refused, with where it is now.
    await other.lockMatter(id, m.id, "place", true);
    await expect(other.patchMatter(id, m.id, { place: { x: 9, y: 9 }, placeBase: 0 })).rejects.toMatchObject({ status: 409, data: { matter: { place: { x: 400, y: 300 }, placeVersion: 1 } } });
    expect((await other.patchMatter(id, m.id, { place: { x: 9, y: 9 }, placeBase: 1 })).placeVersion).toBe(2);
    // AIs take no locks.
    const res = await fetch(`${server!.url}/api/cowork/${id}/matters/1/lock`, { method: "POST", headers: { authorization: `Bearer ${li.key}`, "content-type": "application/json" }, body: JSON.stringify({ what: "place", on: true, via: ai(LI_AI) }) });
    expect(res.status).toBe(403);
  });

  it("one edits its judgement fields at a time: others (and AIs) wait while it is open; two saves from one version: one wins, the other gets the 事项 as it is now", async () => {
    const { wang, li, id } = await team();
    const m = (await li.openMatter(id, { title: "穿透判定", body: "改碰撞层", via: ai(LI_AI) })).matter;
    await li.lockMatter(id, "事项 1", "edit", true);
    await expect(wang.lockMatter(id, m.id, "edit", true)).rejects.toMatchObject({ status: 409, message: "程序老李正在改事项 1" });
    await expect(wang.patchMatter(id, m.id, { blocker: "等美术" })).rejects.toMatchObject({ status: 409, message: "程序老李正在改事项 1：等他改完再改", data: { lock: { by: "程序老李" }, matter: { id: m.id, version: m.version } } });
    await expect(li.patchMatter(id, m.id, { status: "doing", via: ai(LI_AI) })).rejects.toMatchObject({ status: 409 });
    // Fields it does not guard (a title, a binding) still go; the holder saves its own.
    expect((await wang.patchMatter(id, m.id, { bind: { tasks: ["task-1"] } })).bindings.tasks).toEqual(["task-1"]);
    const saved = await li.patchMatter(id, m.id, { blocker: "等碰撞层的提交" });
    expect(saved.blocker).toBe("等碰撞层的提交");
    expect(await li.lockMatter(id, m.id, "edit", false)).toBeNull();
    // Free again: two saves from the same version at once — one is kept, the other is told and given the latest.
    const base = (await wang.cowork(id)).cowork.matters!.find((x) => x.id === m.id)!.version;
    const two = await Promise.allSettled([wang.patchMatter(id, m.id, { base, blocker: "等美术" }), li.patchMatter(id, m.id, { base, blocker: "等测试" })]);
    expect(two.filter((r) => r.status === "fulfilled").length).toBe(1);
    const kept = (two.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<Matter>).value;
    expect((two.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ status: 409, data: { matter: { version: kept.version, blocker: kept.blocker } } });
  });

  it("an AI's board op on a 事项卡 is refused with why", async () => {
    const { li, id } = await team();
    const m = (await li.openMatter(id, { title: "穿透判定", body: "改碰撞层", via: ai(LI_AI) })).matter;
    const out = await li.coworkBoardOps(id, [{ op: "set", opId: "o1", id: m.id, base: 1, fields: { x: 10, y: 10 } }], ai(LI_AI));
    expect(out.rejected.map((r) => r.message)).toEqual([expect.stringContaining("事项卡不是白板上存的卡")]);
  });
});
