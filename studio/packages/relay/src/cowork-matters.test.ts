import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RelayClient } from "./api.js";
import { SETTLED_SIDE, agentParty, personParty, type CoworkRelayEvent, type Matter } from "./cowork-protocol.js";
import { CoworkStore } from "./cowork.js";
import type { RelayEvent, Via } from "./protocol.js";
import { startRelayServer, type RelayServer } from "./server.js";
import { RelayStore } from "./store.js";

// 协作的事项 (2026-11-24, plans/collab-framework.md「11-24」 step 2, the service's side): 子会话 are 事项 (old ones migrated),
// 主控 one per side and 执行 bound to one 事项 (and refused the rest), receipts per recipient (送到 → 看过 → 处理了, closing
// handles all), 撤回 / 原地改 before anyone saw it and 被 #x 取代 after, 待我处理 with a version (pushed, long poll), and
// the board's 事项卡 in a group per side, moved to 「已定 / 已验」 once settled unless a person moved it.

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
  await wang.joinCoworkAgent(cw.id, WANG_AI, "策划文档");
  await li.joinCoworkAgent(cw.id, LI_AI, "战斗代码");
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
  it("is opened by a 主控 or a person, numbered per cowork, with its card in the 群聊 and on the board in its side's group", async () => {
    const { wang, li, id } = await team();
    const events = await listen(wang);
    const one = await li.openMatter(id, { title: "穿透判定", body: "先改碰撞层", via: ai(LI_AI) });
    expect(one.matter).toMatchObject({ no: 1, title: "穿透判定", kind: "work", status: "todo", side: "程序老李", lead: LI_AI, owner: agentParty(LI_AI), scope: "cowork", scopeId: id });
    expect(one.thread.request).toMatchObject({ coworkId: id, from: "程序老李", to: "程序老李" });
    expect(one.message).toMatchObject({ kind: "request", matter: one.matter.id });
    // An ask is a 事项 too (等人确认, waiting on the one asked), numbered after it.
    const two = await wang.askCowork(id, { to: "程序老李", title: "穿透几个", body: "2 个够吗？", via: ai(WANG_AI) });
    const m2 = (await wang.cowork(id)).cowork.matters!.find((m) => m.id === two.thread!.id)!;
    expect(m2).toMatchObject({ no: 2, kind: "confirm", status: "confirm", waitingOn: [personParty("程序老李")], side: "策划小王" });
    expect((await li.messages(id)).messages.at(-2)).toMatchObject({ kind: "event", body: "开了事项 1「穿透判定」（待开始）", session: one.matter.id });
    await expect.poll(() => of(events, "matter").map((e) => e.matter.no)).toEqual(expect.arrayContaining([1, 2]));

    const board = (await wang.coworkBoard(id)).items!;
    const lane = (side: string) => board.find((it) => it.kind === "group" && it.side === side)!;
    expect(lane("程序老李").text).toBe("程序老李 这一方");
    expect(lane("策划小王").text).toBe("策划小王 这一方");
    expect(board.find((it) => it.kind === "matter" && it.matter === one.matter.id)).toMatchObject({ group: lane("程序老李").id, placedBy: "auto", text: "" });
    expect(board.find((it) => it.kind === "matter" && it.matter === two.thread!.id)).toMatchObject({ group: lane("策划小王").id });
  });

  it("changes field by field with a history; an older base is refused; settled, its card moves to 「已定 / 已验」 unless a person moved it", async () => {
    const { wang, li, id } = await team();
    const a = (await li.openMatter(id, { title: "穿透判定", body: "改碰撞层", via: ai(LI_AI) })).matter;
    const b = (await li.openMatter(id, { title: "命中特效", body: "穿透时特效", via: ai(LI_AI) })).matter;
    const pushed = await li.patchMatter(id, a.id, { base: a.version, status: "doing", blocker: "等碰撞层的提交", bind: { commits: ["3F2A91C"], tasks: ["task-1"] }, via: ai(LI_AI) });
    expect(pushed).toMatchObject({ status: "doing", blocker: "等碰撞层的提交", bindings: { commits: ["3f2a91c"], tasks: ["task-1"], sessions: [] }, version: a.version + 1 });
    expect(pushed.history.map((h) => [h.from, h.to, h.by])).toEqual([
      [null, "todo", agentParty(LI_AI)],
      ["todo", "doing", agentParty(LI_AI)],
    ]);
    await expect(wang.patchMatter(id, a.id, { base: a.version, status: "verified" })).rejects.toMatchObject({ status: 409 });
    expect((await li.messages(a.id)).messages.at(-1)?.body).toBe("事项 1：待开始 → 在做");
    // 小王 drags 事项 2's card himself: it stays where he put it.
    const cardOf = async (mid: string) => (await wang.coworkBoard(id)).items!.find((it) => it.kind === "matter" && it.matter === mid)!;
    const cb = await cardOf(b.id);
    await wang.coworkBoardOps(id, [{ op: "set", id: cb.id, fields: { x: 2000, y: 2000, group: null } }]);
    expect(await cardOf(b.id)).toMatchObject({ placedBy: "person", x: 2000 });
    await li.patchMatter(id, a.id, { status: "verified", via: ai(LI_AI) });
    await li.patchMatter(id, b.id, { conclusion: "穿透时只播一次特效", via: ai(LI_AI) });
    const board = (await wang.coworkBoard(id)).items!;
    const settled = board.find((it) => it.kind === "group" && it.side === SETTLED_SIDE)!;
    expect(settled.text).toBe("已定 / 已验");
    expect(await cardOf(a.id)).toMatchObject({ group: settled.id, placedBy: "auto" });
    expect(await cardOf(b.id)).toMatchObject({ group: null, x: 2000 });
    // A conclusion is 已定的事.
    expect((await wang.coworkEvents(id)).filter((e) => e.kind === "decision").map((e) => e.text)).toEqual(["「命中特效」：穿透时只播一次特效"]);
    // Waiting on someone not in it, a dependency on itself: refused.
    await expect(li.patchMatter(id, a.id, { waitingOn: [personParty("美术小周")] })).rejects.toMatchObject({ status: 400 });
    await expect(li.patchMatter(id, a.id, { dependsOn: [a.id] })).rejects.toMatchObject({ status: 400 });
    expect((await li.patchMatter(id, b.id, { dependsOn: [a.id] })).dependsOn).toEqual([a.id]);
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
    expect((await matter()).history.map((h) => h.to)).toEqual(["confirm", "doing", "closed"]);
  });
});

describe("主控和执行", () => {
  it("has one 主控 per side (a second is refused saying who); an 执行 is bound to one 事项 and refused everything else", async () => {
    const { wang, li, id } = await team();
    await expect(li.joinCoworkAgent(id, LI_W, "写代码")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("已经有主控：程序老李 的 AI · 战斗代码") });
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
    const board = await li.coworkBoard(id, 0, LI_W);
    expect(board.items!.map((it) => [it.kind, it.matter])).toEqual([["matter", m.id]]);

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
    expect(wangList.items.map((i) => [i.kind, i.matter, i.seq])).toEqual([
      ["message", m.id, fact.message!.seq],
      ["waiting", m.id, null],
      ["message", m.id, (await li.messages(m.id)).messages[0]!.seq],
    ]);
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
    // Closing the 事项: everything in it is 处理了, by closing.
    await li.patchMatter(id, m.id, { status: "closed", via: ai(LI_AI) });
    expect((await wang.coworkPending({ coworkId: id, party: agentParty(WANG_AI) })).lists[0]!.items).toEqual([]);
    expect((await li.messages(m.id)).messages.find((x) => x.seq === fact.message!.seq)!.receipts!.find((r) => r.party === agentParty(LI_AI))).toMatchObject({ state: "handled", byClose: true });
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
  it("turns 子会话 from before into 事项 and the agents into 主控 (the first of a side) and 执行", () => {
    const db = new RelayStore(":memory:");
    const now = () => 1_800_000_000_000;
    const cw = new CoworkStore(db, now);
    db.register("策划小王", "pw-wang");
    db.register("程序老李", "pw-li");
    const c = cw.create("策划小王", { title: "老协作", members: ["程序老李"] }).cowork;
    cw.joinAgent(c.id, "策划小王", WANG_AI, "文档");
    const open = cw.ask(c.id, "策划小王", { to: "程序老李", title: "还开着", body: "?" });
    const done = cw.ask(c.id, "策划小王", { to: "程序老李", title: "定了", body: "?" });
    cw.conclude(c.id, done.thread!.id, "程序老李", { conclusion: "就这样" });
    // As a database from before: no 事项, no roles; two agents of 小王.
    const raw = db.db as DatabaseSync;
    raw.exec("DELETE FROM cowork_matters; ALTER TABLE cowork_agents DROP COLUMN role; ALTER TABLE cowork_agents DROP COLUMN matter;");
    raw.prepare("INSERT INTO cowork_agents (cowork_id, mark, owner, label, joined_at) VALUES (?, ?, ?, ?, ?)").run(c.id, "studio:d_wang0000000000000000000:s-two", "策划小王", "第二个", now() + 1);
    const again = new CoworkStore(db, now);
    const ms = again.view(c.id).matters as Matter[];
    expect(ms.map((m) => [m.no, m.title, m.status, m.conclusion, m.side, m.waitingOn])).toEqual([
      [1, "还开着", "doing", null, "策划小王", [personParty("程序老李")]],
      [2, "定了", "closed", "就这样", "策划小王", []],
    ]);
    expect(ms[0]!.id).toBe(open.thread!.id);
    expect(again.view(c.id).agents.map((a) => [a.label, a.role])).toEqual([
      ["文档", "lead"],
      ["第二个", "worker"],
    ]);
    db.close();
  });
});
