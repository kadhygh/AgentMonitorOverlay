import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RelayClient } from "./api.js";
import { AGENT_STALE_MS, AGENT_STREAK_MAX, BOARD_LOCK_MS, type BoardOp, type CoworkRelayEvent } from "./cowork-protocol.js";
import { CoworkStore } from "./cowork.js";
import type { RelayEvent, Via } from "./protocol.js";
import { startRelayServer, type RelayServer } from "./server.js";
import { RelayStore } from "./store.js";

// 协作 (2026-11-23, plans/cowork.md 第 1 步): the service's side — who may see and do what, an agent woken only when @-ed
// or when someone writes in a 子会话 it started, its deliveries' three steps, drafts only its owner sees, 子会话 everyone
// in the cowork is in, and the board several change at once (positions, soft locks, an agent refused on a locked card,
// a replay after a break kept as 另一版, delete and restore, undo of one's own only, at most 10 cards per agent call).

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
const LI_AI = "studio:d_li00000000000000000000000:s-code";
const ai = (conv: string): Via => ({ kind: "ai", client: "amo-studio", conv });

async function service() {
  const clock = { now: 1_800_000_000_000 };
  store = new RelayStore(":memory:");
  server = await startRelayServer({ store, host: "127.0.0.1", port: 0, name: "测试组", coworkSweepMs: 30, coworkNow: () => clock.now });
  const anon = new RelayClient(server.url);
  const wang = new RelayClient(server.url, (await anon.register("策划小王", "pw-wang")).key);
  const li = new RelayClient(server.url, (await anon.register("程序老李", "pw-li")).key);
  const zhou = new RelayClient(server.url, (await anon.register("美术小周", "pw-zhou")).key);
  const out = new RelayClient(server.url, (await anon.register("路人甲", "pw-lu")).key);
  return { clock, wang, li, zhou, out };
}

/** A client's /ws events, collected. */
async function listen(client: RelayClient): Promise<{ events: RelayEvent[]; ws: WebSocket }> {
  const events: RelayEvent[] = [];
  const ws = new WebSocket(`${server!.url.replace(/^http/, "ws")}/ws?key=${encodeURIComponent(client.key!)}`);
  sockets.push(ws);
  ws.on("message", (d) => events.push(JSON.parse(String(d)) as RelayEvent));
  await new Promise((ok, fail) => (ws.once("open", ok), ws.once("error", fail)));
  await expect.poll(() => events.some((e) => e.type === "hello")).toBe(true);
  return { events, ws };
}

const of = <T extends CoworkRelayEvent["type"]>(events: RelayEvent[], type: T) => events.filter((e): e is Extract<CoworkRelayEvent, { type: T }> => e.type === type);

/** A cowork of 小王 with 老李 in it, each with one agent. */
async function team() {
  const s = await service();
  const cw = await s.wang.createCowork({ title: "射速改版", goal: "射速 10 → 12", repo: "game", branch: "feat/rate", members: ["程序老李"] });
  await s.wang.joinCoworkAgent(cw.id, WANG_AI, "射速文档");
  await s.li.joinCoworkAgent(cw.id, LI_AI, "战斗代码");
  return { ...s, id: cw.id };
}

describe("协作：成员和权限", () => {
  it("is made with its people; only they see it or change anything in it", async () => {
    const { wang, li, out } = await service();
    expect((await wang.health()).cowork).toBe(1);
    const cw = await wang.createCowork({ title: "射速改版", goal: "射速 10 → 12", repo: "game", branch: "feat/rate", members: ["程序老李"] });
    expect(cw).toMatchObject({ title: "射速改版", goal: "射速 10 → 12", repo: "game", branch: "feat/rate", members: ["策划小王", "程序老李"], options: { aiInitiate: false }, endedAt: null });
    expect((await li.coworks()).map((c) => c.id)).toEqual([cw.id]);
    expect(await out.coworks()).toEqual([]);
    // Its 群聊 is a thread like any other: listed, with a message, readable through the old calls.
    expect((await li.threads()).find((t) => t.id === cw.id)).toMatchObject({ kind: "cowork", title: "射速改版" });
    expect((await li.messages(cw.id)).messages.at(-1)?.body).toContain("发起了协作");

    const forbidden = { status: 403 };
    await expect(out.cowork(cw.id)).rejects.toMatchObject(forbidden);
    await expect(out.coworkFeed(cw.id)).rejects.toMatchObject(forbidden);
    await expect(out.postCowork(cw.id, { body: "我也来" })).rejects.toMatchObject(forbidden);
    await expect(out.send(cw.id, { body: "我也来" })).rejects.toMatchObject(forbidden);
    await expect(out.updateCowork(cw.id, { goal: "改掉" })).rejects.toMatchObject(forbidden);
    await expect(out.coworkBoard(cw.id)).rejects.toMatchObject(forbidden);
    await expect(out.coworkBoardOps(cw.id, [{ op: "add", item: { kind: "note", text: "x" } }])).rejects.toMatchObject(forbidden);
    await expect(out.joinCoworkAgent(cw.id, "studio:d_x:s", "我的")).rejects.toMatchObject(forbidden);
    await expect(out.askCowork(cw.id, { to: "策划小王", title: "t", body: "b" })).rejects.toMatchObject(forbidden);
    await expect(out.addCoworkMembers(cw.id, ["路人甲"])).rejects.toMatchObject(forbidden);
    await expect(out.coworkGoals(cw.id)).rejects.toMatchObject(forbidden);
    await expect(new RelayClient(server!.url).coworks()).rejects.toMatchObject({ status: 401 });

    // Brought in, they see everything that came before.
    await li.addCoworkMembers(cw.id, ["路人甲"]);
    expect((await out.cowork(cw.id)).cowork.members).toEqual(["策划小王", "程序老李", "路人甲"]);
    await out.leaveCowork(cw.id);
    await expect(out.cowork(cw.id)).rejects.toMatchObject(forbidden);
  });

  it("keeps every version of the goal; options default off; an ended cowork takes nothing until reopened", async () => {
    const { wang, li, id } = await team();
    const { events } = await listen(li);
    await li.updateCowork(id, { goal: "射速 10 → 12，后坐力不变" });
    await wang.updateCowork(id, { goal: "射速 10 → 12，后坐力 -5%", repo: "game", branch: "feat/rate-2" });
    expect((await li.coworkGoals(id)).map((g) => [g.by, g.goal])).toEqual([
      ["策划小王", "射速 10 → 12"],
      ["程序老李", "射速 10 → 12，后坐力不变"],
      ["策划小王", "射速 10 → 12，后坐力 -5%"],
    ]);
    await expect.poll(() => of(events, "cowork").at(-1)?.cowork.branch).toBe("feat/rate-2");
    expect((await li.cowork(id)).events.filter((e) => e.kind === "goal").map((e) => e.text)).toEqual(["改了目标", "改了目标", "仓库和分支改为 game · feat/rate-2"]);

    await li.updateCowork(id, { ended: true });
    await expect(wang.postCowork(id, { body: "还有一件事" })).rejects.toMatchObject({ status: 409 });
    await expect(wang.coworkBoardOps(id, [{ op: "add", item: { kind: "note" } }])).rejects.toMatchObject({ status: 409 });
    await expect(wang.updateCowork(id, { goal: "再改" })).rejects.toMatchObject({ status: 409 });
    await wang.updateCowork(id, { ended: false });
    expect((await wang.postCowork(id, { body: "还有一件事" })).message?.body).toBe("还有一件事");
  });
});

describe("协作：agent", () => {
  it("is brought in by its owner only, shown as their AI, and its state comes from their Studio (不在线 when it stops)", async () => {
    const { clock, wang, li, zhou, id } = await team();
    await expect(li.joinCoworkAgent(id, WANG_AI, "抢过来")).rejects.toMatchObject({ status: 409 });
    await wang.addCoworkMembers(id, ["美术小周"]);
    await zhou.updateCowork(id, {}); // a member may call; nothing changes
    const { events } = await listen(zhou);
    let agents = (await zhou.cowork(id)).cowork.agents;
    expect(agents.map((a) => [a.name, a.state])).toEqual([
      ["策划小王 的 AI · 射速文档", "offline"],
      ["程序老李 的 AI · 战斗代码", "offline"],
    ]);
    // An agent speaks only as its owner: another account cannot use its mark.
    await expect(li.postCowork(id, { body: "我是小王的 AI", via: ai(WANG_AI) })).rejects.toMatchObject({ status: 403 });
    await expect(wang.postCowork(id, { body: "没拉进来的会话", via: ai("studio:d_wang0000000000000000000:s-other") })).rejects.toMatchObject({ status: 403 });

    await wang.reportCoworkAgents([{ mark: WANG_AI, state: "busy" }]);
    await expect.poll(() => of(events, "cowork-agent").filter((e) => e.agent.mark === WANG_AI).at(-1)?.agent).toMatchObject({ state: "busy", lastSeen: clock.now });
    // Reporting the same again pushes nothing new.
    const wangPushes = () => of(events, "cowork-agent").filter((e) => e.agent.mark === WANG_AI).length;
    const pushed = wangPushes();
    await wang.reportCoworkAgents([{ mark: WANG_AI, state: "busy" }]);
    await new Promise((r) => setTimeout(r, 120));
    expect(wangPushes()).toBe(pushed);
    // Someone else cannot report it.
    expect(await li.reportCoworkAgents([{ mark: WANG_AI, state: "idle" }])).toEqual([]);

    clock.now += AGENT_STALE_MS + 1;
    await expect.poll(() => of(events, "cowork-agent").filter((e) => e.agent.mark === WANG_AI).at(-1)?.agent.state).toBe("offline");
    await wang.reportCoworkAgents([{ mark: WANG_AI, state: "owner" }]);
    agents = (await zhou.cowork(id)).cowork.agents;
    expect(agents.find((a) => a.mark === WANG_AI)?.state).toBe("owner");

    await wang.leaveCoworkAgent(id, WANG_AI);
    expect((await zhou.cowork(id)).cowork.agents.map((a) => a.mark)).toEqual([LI_AI]);
    await expect(wang.postCowork(id, { body: "我还在吗", via: ai(WANG_AI) })).rejects.toMatchObject({ status: 403 });
  });

  it("is woken only when @-ed or when someone writes in a 子会话 it started; deliveries go 排队中 → 已送达 → 已回复", async () => {
    const { wang, li, id } = await team();
    const liStudio = "studio:d_li00000000000000000000000:";
    // Plain chat, mentions of people, a person's 子会话: nobody's agent is woken.
    await wang.postCowork(id, { body: "大家看下射速" });
    await wang.postCowork(id, { body: "@程序老李 你看下", mentions: ["程序老李"] });
    const own = await wang.askCowork(id, { to: "程序老李", title: "射速上限", body: "12 行吗？" });
    await li.send(own.thread!.id, { kind: "reply", body: "行" });
    expect((await li.coworkInbox(liStudio)).items).toEqual([]);
    expect((await wang.coworkInbox("studio:")).items).toEqual([]);
    // …but it counts as unread for the agents.
    expect((await li.coworkInbox(liStudio)).unread).toEqual([{ coworkId: id, agent: LI_AI, count: 4 }]);

    // A long poll waits for the first thing queued.
    const waiting = li.coworkInbox(liStudio, { waitMs: 5000 });
    await new Promise((r) => setTimeout(r, 80));
    const asked = await wang.postCowork(id, { body: "老李的 AI，伤害公式在哪？", agentMentions: [LI_AI] });
    expect(asked.deliveries?.map((d) => [d.agent, d.reason, d.state])).toEqual([[LI_AI, "mention", "queued"]]);
    const inbox = await waiting;
    expect(inbox.items.map((i) => [i.delivery.agent, i.message.body, i.cowork.branch, i.thread.kind])).toEqual([[LI_AI, "老李的 AI，伤害公式在哪？", "feat/rate", "cowork"]]);
    // Another Studio's prefix does not get it; nor does someone else's account.
    expect((await li.coworkInbox("studio:d_other:")).items).toEqual([]);
    expect((await wang.coworkInbox(liStudio)).items).toEqual([]);
    expect((await wang.cowork(id)).cowork.agents.find((a) => a.mark === LI_AI)?.queued).toBe(1);

    const { events } = await listen(wang);
    expect(await wang.ackCowork([inbox.items[0]!.delivery.id])).toEqual([]);
    const [delivered] = await li.ackCowork([inbox.items[0]!.delivery.id]);
    expect(delivered).toMatchObject({ state: "delivered" });
    await expect.poll(() => of(events, "cowork-delivery").at(-1)?.delivery.state).toBe("delivered");
    expect((await li.coworkInbox(liStudio)).items).toEqual([]);

    // Its answer quotes what it was given (without saying so) and marks it 已回复.
    const answer = await li.postCowork(id, { body: "在 damage.ts 里", via: ai(LI_AI) });
    expect(answer.message?.replyTo).toBe(asked.message!.seq);
    expect(answer.deliveries?.map((d) => [d.id, d.state, d.replySeq])).toEqual([[delivered!.id, "replied", answer.message!.seq]]);
    await expect.poll(() => of(events, "cowork-delivery").at(-1)?.delivery.state).toBe("replied");

    // A 子会话 its agent started: a reply, and anyone's 插话, wake it; its own messages there do not.
    await li.updateCowork(id, { options: { aiInitiate: true } });
    const sub = await li.askCowork(id, { to: "策划小王", title: "暴击要不要叠加", body: "叠还是不叠？", via: ai(LI_AI) });
    expect(sub.thread?.request).toMatchObject({ coworkId: id, from: "程序老李", to: "策划小王" });
    await wang.send(sub.thread!.id, { kind: "reply", body: "不叠" });
    const woke = (await li.coworkInbox(liStudio)).items;
    expect(woke.map((i) => [i.delivery.reason, i.message.body, i.thread.title])).toEqual([["reply", "不叠", "暴击要不要叠加"]]);
    await li.ackCowork(woke.map((i) => i.delivery.id));
    await li.postCowork(id, { threadId: sub.thread!.id, body: "好，那就不叠", via: ai(LI_AI) });
    expect((await li.coworkInbox(liStudio)).items).toEqual([]);
    expect((await li.cowork(id)).deliveries.map((d) => d.state)).toEqual(["replied", "replied"]);
  });

  it("stops waking agents after 30 AI messages in a row in one thread, says so once, and starts again when a person speaks there", async () => {
    const { wang, li, zhou, id } = await team();
    await wang.addCoworkMembers(id, ["美术小周"]);
    await wang.updateCowork(id, { options: { aiInitiate: true } });
    const sub = await li.askCowork(id, { to: "策划小王", title: "暴击要不要叠加", body: "叠还是不叠？", via: ai(LI_AI) });
    const { events } = await listen(zhou);
    const queued = (r: { deliveries?: Array<{ state: string }> }) => (r.deliveries ?? []).filter((d) => d.state === "queued").length;
    // Two agents @-ing each other in the 群聊: each message wakes the other, up to the limit.
    for (let i = 1; i <= AGENT_STREAK_MAX + 1; i++) {
      const [who, self, other] = i % 2 ? [wang, WANG_AI, LI_AI] : [li, LI_AI, WANG_AI];
      const out = await who.postCowork(id, { body: `第 ${i} 条`, agentMentions: [other], via: ai(self) });
      expect([i, queued(out), out.events?.map((e) => e.kind)]).toEqual([i, i < AGENT_STREAK_MAX ? 1 : 0, i === AGENT_STREAK_MAX ? ["paused"] : []]);
    }
    await expect.poll(() => of(events, "cowork-event").filter((e) => e.event.kind === "paused").map((e) => [e.event.text, e.event.data?.threadId])).toEqual([[`AI 之间已经连续往来 ${AGENT_STREAK_MAX} 条，等人看一下：有人在这里说一句话，AI 才会再被叫醒`, id]]);
    // A 子会话 counts on its own: an agent's message there still wakes the agent that started it.
    expect(queued(await wang.postCowork(id, { threadId: sub.thread!.id, body: "不叠", via: ai(WANG_AI) }))).toBe(1);
    // A person's word in the 群聊 starts the count again (an event, like someone joining, does not).
    await wang.addCoworkMembers(id, ["路人甲"]);
    expect(queued(await wang.postCowork(id, { body: "又一条", agentMentions: [LI_AI], via: ai(WANG_AI) }))).toBe(0);
    await zhou.postCowork(id, { body: "我看过了，接着来" });
    expect(queued(await wang.postCowork(id, { body: "好", agentMentions: [LI_AI], via: ai(WANG_AI) }))).toBe(1);
  });
});

describe("协作：AI 的草稿", () => {
  it("keeps an agent's @ and its new 子会话 for its owner while 「AI 发起 @ 和提问」 is off; only the owner sees and decides", async () => {
    const { wang, li, id } = await team();
    const wangEvents = await listen(wang);
    const liEvents = await listen(li);
    // A plain message from an agent goes out; one that @-s someone waits.
    expect((await wang.postCowork(id, { body: "我先读一下文档", via: ai(WANG_AI) })).message).toBeTruthy();
    const kept = await wang.postCowork(id, { body: "老李，射速上限你定？", mentions: ["程序老李"], agentMentions: [LI_AI], via: ai(WANG_AI) });
    expect(kept.draft).toMatchObject({ kind: "post", agent: WANG_AI, owner: "策划小王", state: "pending" });
    const askKept = await wang.askCowork(id, { to: "程序老李", title: "射速上限", body: "12 行吗？", via: ai(WANG_AI) });
    expect(askKept.draft).toMatchObject({ kind: "ask", state: "pending" });
    expect((await li.coworkInbox("studio:")).items).toEqual([]);
    expect((await wang.cowork(id)).drafts.map((d) => d.kind)).toEqual(["post", "ask"]);
    expect((await li.cowork(id)).drafts).toEqual([]);
    expect(await li.coworkDrafts(id)).toEqual([]);
    await expect.poll(() => of(wangEvents.events, "cowork-draft").length).toBe(2);
    expect(of(liEvents.events, "cowork-draft")).toEqual([]);

    await expect(li.decideCoworkDraft(id, kept.draft!.id, { action: "send" })).rejects.toMatchObject({ status: 403 });
    // The agent itself cannot send its own draft.
    const byAi = await fetch(`${server!.url}/api/cowork/${id}/drafts/${kept.draft!.id}`, { method: "POST", headers: { authorization: `Bearer ${wang.key}`, "content-type": "application/json" }, body: JSON.stringify({ action: "send", via: ai(WANG_AI) }) });
    expect(byAi.status).toBe(403);

    // 改一下再发: it goes as the agent's, approved and edited, and wakes 老李's agent.
    const sent = await wang.decideCoworkDraft(id, kept.draft!.id, { action: "send", edit: { body: "老李，射速上限 12 你看行吗？" } });
    expect(sent).toMatchObject({ state: "sent" });
    const msg = (await li.messages(id)).messages.find((m) => m.seq === sent.result!.seq)!;
    expect(msg).toMatchObject({ body: "老李，射速上限 12 你看行吗？", approvedBy: "策划小王", edited: true, agentMentions: [LI_AI], mentions: ["程序老李"], via: { kind: "ai", conv: WANG_AI } });
    expect((await li.coworkInbox("studio:d_li")).items.map((i) => i.message.seq)).toEqual([msg.seq]);
    await expect(wang.decideCoworkDraft(id, kept.draft!.id, { action: "drop" })).rejects.toMatchObject({ status: 409 });

    // 发出 the 子会话: every member is in it.
    const askSent = await wang.decideCoworkDraft(id, askKept.draft!.id, { action: "send" });
    const sub = (await li.cowork(id)).cowork.sessions.find((s) => s.id === askSent.result!.threadId)!;
    expect(sub).toMatchObject({ title: "射速上限", from: "策划小王", to: "程序老李", agent: WANG_AI, state: "open" });

    // 不发.
    const third = await wang.postCowork(id, { body: "@程序老李 还在吗", mentions: ["程序老李"], via: ai(WANG_AI) });
    expect((await wang.decideCoworkDraft(id, third.draft!.id, { action: "drop" })).state).toBe("dropped");
    expect((await wang.cowork(id)).drafts).toEqual([]);

    // Turned on: an agent's @ goes out at once.
    await wang.updateCowork(id, { options: { aiInitiate: true } });
    expect((await wang.postCowork(id, { body: "@程序老李 再确认一下", mentions: ["程序老李"], via: ai(WANG_AI) })).message).toBeTruthy();
  });
});

describe("协作：子会话", () => {
  it("has every member of the cowork in it, takes 插话, and its conclusion goes into 已定的事", async () => {
    const { wang, li, zhou, id } = await team();
    const sub = await wang.askCowork(id, { to: "程序老李", title: "射速上限", body: "12 行吗？", questions: [{ text: "上限", options: ["12", "14"] }] });
    const tid = sub.thread!.id;
    // The 群聊 has its card.
    const card = (await li.messages(id)).messages.at(-1)!;
    expect(card).toMatchObject({ kind: "event", session: tid });
    // Someone brought in later is in the 子会话 too, and may write in it (插话) without taking it over.
    await wang.addCoworkMembers(id, ["美术小周"]);
    expect((await zhou.messages(tid)).thread.members).toEqual(expect.arrayContaining(["策划小王", "程序老李", "美术小周"]));
    await zhou.send(tid, { body: "补充：特效按 12 做过" });
    expect((await zhou.messages(tid)).thread.request?.waitingOn).toBe("程序老李");
    await expect(zhou.send(tid, { kind: "reply", body: "我替他答" })).rejects.toMatchObject({ status: 403 });
    await li.send(tid, { kind: "reply", answers: [{ questionId: "q1", choice: "12" }] });
    // Only its asker or the person asked concludes it.
    await expect(zhou.concludeCowork(id, tid, "就 12")).rejects.toMatchObject({ status: 403 });
    await wang.concludeCowork(id, tid, "射速上限 12");
    const d = await zhou.cowork(id);
    expect(d.cowork.sessions.find((s) => s.id === tid)).toMatchObject({ state: "done", conclusion: "射速上限 12" });
    expect(d.events.filter((e) => e.kind === "decision").map((e) => e.text)).toEqual(["「射速上限」：射速上限 12"]);
    // Through the old calls too: a request with coworkId, 标记完成 with a note.
    const other = (await wang.ask({ coworkId: id, to: "美术小周", title: "特效", body: "要改吗？" } as never)) as { thread: { id: string } };
    expect((await li.messages(other.thread.id)).thread.request?.coworkId).toBe(id);
    await zhou.send(other.thread.id, { kind: "reply", body: "不用" });
    await wang.session(other.thread.id, "done", { note: "特效不改" });
    expect((await li.coworkEvents(id)).filter((e) => e.kind === "decision").map((e) => e.text)).toEqual(["「射速上限」：射速上限 12", "「特效」：特效不改"]);
    // Asking someone not in it is refused.
    await expect(wang.askCowork(id, { to: "路人甲", title: "t", body: "b" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("协作：白板多人同时改", () => {
  it("numbers operations, the later position wins, catches up by seq, and a repeated opId does nothing twice", async () => {
    const { wang, li, id } = await team();
    const { events } = await listen(li);
    const add = await wang.coworkBoardOps(id, [{ op: "add", opId: "w1", item: { id: "n1", kind: "note", x: 10, y: 10, text: "射速 12" } }]);
    expect(add.applied[0]).toMatchObject({ seq: 1, op: "add", actor: "策划小王", items: [{ id: "n1", version: 1, text: "射速 12" }] });
    await expect.poll(() => of(events, "board").at(-1)?.ops[0]?.seq).toBe(1);
    // Two people let go of the same card: the later one stays, the earlier is in the history.
    await wang.coworkBoardOps(id, [{ op: "set", id: "n1", base: 1, fields: { x: 100, y: 100 } }]);
    await li.coworkBoardOps(id, [{ op: "set", id: "n1", base: 1, fields: { x: 300, y: 50 } }]);
    const snap = await li.coworkBoard(id);
    expect(snap).toMatchObject({ seq: 3, full: true });
    expect(snap.items?.[0]).toMatchObject({ x: 300, y: 50, version: 3 });
    expect((await li.coworkBoard(id, 1)).ops?.map((o) => o.seq)).toEqual([2, 3]);
    expect((await li.coworkBoardHistory(id, "n1")).map((o) => [o.seq, o.actor])).toEqual([
      [3, "程序老李"],
      [2, "策划小王"],
      [1, "策划小王"],
    ]);
    // A client replaying its queue after a break: the same operation again is answered, not done again.
    const again = await wang.coworkBoardOps(id, [{ op: "add", opId: "w1", item: { id: "n1", kind: "note", text: "射速 12" } }]);
    expect(again.applied.map((o) => o.seq)).toEqual([1]);
    expect((await wang.coworkBoard(id)).seq).toBe(3);
    // A bad operation is reported by its place; the rest apply.
    const mixed = await wang.coworkBoardOps(id, [{ op: "set", id: "nope", fields: { x: 1 } }, { op: "add", item: { id: "n2", kind: "note" } }, { op: "fly" } as unknown as BoardOp]);
    expect(mixed.rejected.map((r) => [r.index, r.code])).toEqual([
      [0, "missing"],
      [2, "bad"],
    ]);
    expect(mixed.applied.map((o) => o.items[0]!.id)).toEqual(["n2"]);
  });

  it("locks a card's text while someone writes it: others and agents keep off its words, a replay becomes 另一版", async () => {
    const { clock, wang, li, id } = await team();
    await wang.coworkBoardOps(id, [{ op: "add", item: { id: "n1", kind: "note", text: "射速 12" } }]);
    const liEvents = await listen(li);
    const lock = await wang.coworkBoardLock(id, "n1", true);
    expect(lock).toMatchObject({ card: "n1", by: "策划小王" });
    await expect.poll(() => of(liEvents.events, "board-lock").at(-1)?.lock?.by).toBe("策划小王");
    await expect(li.coworkBoardLock(id, "n1", true)).rejects.toMatchObject({ status: 409 });
    expect((await li.coworkBoard(id)).locks.map((l) => l.by)).toEqual(["策划小王"]);

    // An agent: refused, told who writes it; it may still not delete it. Moving it is fine.
    const byAi = await li.coworkBoardOps(id, [{ op: "set", id: "n1", fields: { text: "射速 14" } }, { op: "delete", id: "n1" }, { op: "set", id: "n1", fields: { x: 500 } }], ai(LI_AI));
    expect(byAi.rejected.map((r) => [r.code, r.by])).toEqual([
      ["locked", "策划小王"],
      ["locked", "策划小王"],
    ]);
    expect(byAi.rejected[0]!.message).toContain("策划小王 正在写这张卡");
    expect(byAi.applied[0]).toMatchObject({ agent: LI_AI, items: [{ x: 500, updatedAgent: LI_AI }] });
    // A person's change on it (a replay of what they wrote offline) is kept beside it.
    const replay = await li.coworkBoardOps(id, [{ op: "set", id: "n1", base: 1, fields: { text: "射速 13" } }]);
    expect(replay.applied[0]).toMatchObject({ conflict: true, items: [{ text: "射速 12", alt: { text: "射速 13", by: "程序老李" } }] });
    // The holder writes; the lock goes after 30 s without a word.
    await wang.coworkBoardOps(id, [{ op: "set", id: "n1", fields: { text: "射速 12（暂定）" } }]);
    clock.now += BOARD_LOCK_MS + 1;
    await expect.poll(() => of(liEvents.events, "board-lock").at(-1)?.lock).toBeNull();
    // Now a person picks a version; agents may not.
    expect((await li.coworkBoardOps(id, [{ op: "resolve", id: "n1", keep: "alt" }], ai(LI_AI))).rejected[0]?.code).toBe("forbidden");
    const picked = await li.coworkBoardOps(id, [{ op: "resolve", id: "n1", keep: "alt" }]);
    expect(picked.applied[0]!.items[0]).toMatchObject({ text: "射速 13", alt: null });
    // An agent's text on a version older than the card's: refused (read again first).
    const stale = await li.coworkBoardOps(id, [{ op: "set", id: "n1", base: 1, fields: { text: "射速 15" } }], ai(LI_AI));
    expect(stale.rejected[0]?.code).toBe("stale");

    // A lock goes when its holder's last connection closes.
    const wangWs = await listen(wang);
    await wang.coworkBoardLock(id, "n1", true);
    wangWs.ws.close();
    await expect.poll(async () => (await li.coworkBoard(id)).locks).toEqual([]);
  });

  it("deletes only by marking (found again), not while someone writes; each undoes only their own steps", async () => {
    const { wang, li, id } = await team();
    await wang.coworkBoardOps(id, [
      { op: "add", item: { id: "g1", kind: "group", text: "数值" } },
      { op: "add", item: { id: "n1", kind: "note", text: "射速 12", group: "g1" } },
      { op: "add", item: { id: "n2", kind: "note", text: "后坐力" } },
      { op: "add", item: { id: "l1", kind: "link", from: "n1", to: "n2" } },
    ]);
    await li.coworkBoardLock(id, "n2", true);
    expect((await wang.coworkBoardOps(id, [{ op: "delete", id: "n2" }])).rejected[0]?.message).toContain("程序老李 正在写这张卡");
    await li.coworkBoardLock(id, "n2", false);
    const del = await wang.coworkBoardOps(id, [{ op: "delete", id: "n2" }]);
    const items = (await li.coworkBoard(id)).items!;
    expect(items.find((i) => i.id === "n2")).toMatchObject({ deleted: true, deletedBy: "策划小王" });
    expect((await li.coworkBoardOps(id, [{ op: "set", id: "n2", fields: { x: 1 } }])).rejected[0]?.code).toBe("deleted");
    await li.coworkBoardOps(id, [{ op: "restore", id: "n2" }]);
    expect((await li.coworkBoard(id)).items!.find((i) => i.id === "n2")?.deleted).toBe(false);
    // Big changes are the cowork's events.
    expect((await li.coworkEvents(id)).filter((e) => e.kind === "board").map((e) => e.text)).toEqual(expect.arrayContaining(["在白板上加了「射速 12」", "删了白板上的「后坐力」"]));

    // 小王 moves n1, then 老李 recolours it and moves n2; 小王's undo puts back only his own move.
    const move = await wang.coworkBoardOps(id, [{ op: "set", id: "n1", fields: { x: 200, y: 200 } }]);
    await li.coworkBoardOps(id, [{ op: "set", id: "n1", fields: { color: "red", y: 260 } }]);
    await expect(li.coworkBoardOps(id, [{ op: "undo", seq: move.applied[0]!.seq }]).then((r) => r.rejected[0]?.code)).resolves.toBe("forbidden");
    const undo = await wang.coworkBoardOps(id, [{ op: "undo", seq: move.applied[0]!.seq }]);
    expect(undo.applied[0]).toMatchObject({ undoOf: move.applied[0]!.seq, items: [{ x: 0, y: 260, color: "red" }] });
    expect((await wang.coworkBoardOps(id, [{ op: "undo", seq: move.applied[0]!.seq }])).rejected[0]?.code).toBe("nothing");
    // Undoing an undo is a redo; undoing my delete brings the card back.
    expect((await wang.coworkBoardOps(id, [{ op: "undo", seq: undo.applied[0]!.seq }])).applied[0]!.items[0]).toMatchObject({ x: 200 });
    expect((await wang.coworkBoardOps(id, [{ op: "undo", seq: del.applied[0]!.seq }])).rejected[0]?.code).toBe("nothing"); // 老李 restored it already
    // Malformed links and groups are refused.
    expect((await wang.coworkBoardOps(id, [{ op: "add", item: { kind: "link", from: "n1", to: "missing" } }])).rejected[0]?.code).toBe("missing");
    expect((await wang.coworkBoardOps(id, [{ op: "set", id: "n2", fields: { group: "n1" } }])).rejected[0]?.code).toBe("bad");
  });

  it("lets an agent touch at most 10 cards per call, and marks reference cards 已过时 when a newer commit of their file is recorded", async () => {
    const { wang, li, id } = await team();
    const eleven: BoardOp[] = Array.from({ length: 11 }, (_, i) => ({ op: "add", item: { id: `a${i}`, kind: "note", text: `卡 ${i}` } }));
    await expect(li.coworkBoardOps(id, eleven, ai(LI_AI))).rejects.toMatchObject({ status: 403 });
    expect((await li.coworkBoard(id)).items).toEqual([]);
    expect((await li.coworkBoardOps(id, eleven.slice(0, 10), ai(LI_AI))).applied).toHaveLength(10);
    // A person has no such limit.
    expect((await wang.coworkBoardOps(id, eleven.map((o, i) => ({ ...o, item: { ...(o as { item: object }).item, id: `p${i}` } }) as BoardOp))).applied).toHaveLength(11);

    await wang.coworkBoardOps(id, [
      { op: "add", item: { id: "r1", kind: "ref", ref: { kind: "file", path: "设计/射速.md", commit: "abc1234" } } },
      { op: "add", item: { id: "r2", kind: "ref", ref: { kind: "file", path: "设计/后坐力.md", commit: "abc1234" } } },
    ]);
    const { events } = await listen(wang);
    const out = await li.addCoworkEvent(id, { kind: "commit", text: "推了射速的改动", commit: "def5678", files: ["设计/射速.md"], via: ai(LI_AI) });
    expect(out.event).toMatchObject({ kind: "commit", agent: LI_AI, data: { commit: "def5678", files: ["设计/射速.md"] } });
    expect(out.board?.applied.map((o) => [o.items[0]!.id, o.items[0]!.stale, o.agent])).toEqual([["r1", true, LI_AI]]);
    await expect.poll(() => of(events, "cowork-event").map((e) => e.event.text)).toEqual(expect.arrayContaining(["推了射速的改动", "把白板上的「设计/射速.md」标成已过时"]));
    // Events never wake an agent.
    expect((await wang.coworkInbox("studio:")).items).toEqual([]);
  });

  it("passes presence on to the others, over /ws or HTTP, and drops it when they go", async () => {
    const { wang, li, id } = await team();
    await wang.coworkBoardOps(id, [{ op: "add", item: { id: "n1", kind: "note" } }]);
    const liEvents = await listen(li);
    const wangWs = await listen(wang);
    wangWs.ws.send(JSON.stringify({ type: "board-presence", coworkId: id, selected: ["n1"], dragging: { id: "n1", x: 40, y: 60 } }));
    await expect.poll(() => of(liEvents.events, "board-presence").at(-1)?.presence).toMatchObject([{ name: "策划小王", selected: ["n1"], dragging: { id: "n1", x: 40, y: 60 } }]);
    expect((await li.coworkBoardPresence(id, { selected: [] })).map((p) => p.name).sort()).toEqual(["程序老李", "策划小王"]);
    wangWs.ws.close();
    await expect.poll(() => of(liEvents.events, "board-presence").at(-1)?.presence.map((p) => p.name)).toEqual(["程序老李"]);
  });
});

describe("协作：旧数据库和旧接口", () => {
  it("opens a database from before 协作, and the sessions in it carry on as before", () => {
    const dir = mkdtempSync(join(tmpdir(), "amo-relay-cowork-"));
    try {
      const file = join(dir, "relay.db");
      const old = new RelayStore(file);
      old.register("策划小王", "pw-wang");
      old.register("程序老李", "pw-li");
      const sent = old.createRequest("策划小王", { to: "程序老李", title: "老会话", body: "还在吗？" });
      // As the database was before 2026-11-23.
      old.db.exec("DROP INDEX threads_cowork; ALTER TABLE threads DROP COLUMN cowork_id; ALTER TABLE threads DROP COLUMN cw_agent; ALTER TABLE threads DROP COLUMN cw_conclusion;");
      old.close();
      const again = new RelayStore(file);
      const cowork = new CoworkStore(again);
      const t = again.thread(sent.thread.id, "程序老李");
      expect(t.request).toMatchObject({ from: "策划小王", to: "程序老李", state: "open" });
      expect(t.request?.coworkId).toBeUndefined();
      expect(again.addMessage(t.id, "程序老李", { kind: "reply", body: "在" }).thread.request?.state).toBe("returned");
      expect(cowork.create("策划小王", { title: "新的协作", members: ["程序老李"] }).cowork.members).toEqual(["策划小王", "程序老李"]);
      // A second start finds everything in place.
      again.close();
      const third = new RelayStore(file);
      expect(new CoworkStore(third).list("程序老李").map((c) => c.title)).toEqual(["新的协作"]);
      third.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
