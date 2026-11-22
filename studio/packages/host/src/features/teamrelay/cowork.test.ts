import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostEvent, MessageOrigin, ModelProfile, Session } from "@amo-studio/protocol";
import { saveAccount, type Protector } from "@amo-studio/account";
import { RelayClient, RelayStore, startRelayServer, type RelayServer } from "@amo-studio/relay";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { amoToolsFor } from "../../mcp/tools.js";
import { coworkHint } from "../../core/cowork.js";

// 协作 (2026-11-23, plans/cowork.md 第 4 步), against a relay service on this machine (never the team server): the planner's
// session is brought into a cowork the coder started; its state is reported; an @ and a reply in a 子会话 it started go into
// it only once it is free, once, folded as the cowork's; the teamrelay scan leaves 子会话 alone; cowork_* speak as the
// planner's AI (drafts while 「AI 发起 @ 和提问」 is off); 转到我的会话 hands a 子会话 to a session here.

const fake: Protector = {
  protect: async (t) => Buffer.from(`enc:${t}`).toString("base64"),
  unprotect: async (d) => Buffer.from(d, "base64").toString().slice(4),
};
const PROFILES: ModelProfile[] = [{ id: "p", label: "P", runtime: "codex", provider: "x", model: "m" }];

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const tempDir = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `amo-cowork-${name}-`));
  cleanups.push(() => removeTempDir(d));
  return d;
};

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, what = "condition", ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function setup() {
  const relayStore = new RelayStore(":memory:");
  const relay: RelayServer = await startRelayServer({ store: relayStore, filesDir: tempDir("files"), host: "127.0.0.1", port: 0, coworkSweepMs: 100 });
  cleanups.push(() => relayStore.close());
  cleanups.push(() => relay.close());
  const planner = relayStore.register("策划小王", "pw-aaaa");
  const coder = relayStore.register("程序老李", "pw-bbbb");
  const artist = relayStore.register("美术小周", "pw-cccc");

  const home = tempDir("home");
  const env = { AMO_HOME: home, COMPUTERNAME: "PLANNER-PC" };
  await saveAccount({ server: relay.url, name: "策划小王", key: planner.key }, { env, protector: fake });
  const root = tempDir("data");
  const store = new Store(join(root, "studio.db"));
  const servers = new FakeServers(PROFILES);
  const service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  mkdirSync(join(root, "alpha"));
  const alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
  const session = (title: string): Session => {
    const task = store.createTask({ title, workspaceId: alpha.id });
    return store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "p", workspaceId: alpha.id, title, status: "idle", writer: "workbench", runtimeRef: null });
  };
  // What goes into sessions (their inbox), instead of a model turn.
  const told: Array<{ sessionId: string; text: string; origin?: MessageOrigin }> = [];
  service.sessions.inbox.put = async (sessionId: string, text: string, origin?: MessageOrigin) => {
    told.push({ sessionId, text, ...(origin ? { origin } : {}) });
    return { delivered: true, waiting: 0 };
  };
  const events: HostEvent[] = [];
  service.on("event", (e) => events.push(e));
  service.teamLink.start({ env, protector: fake, watchMs: 30 });
  service.teamRelay.pauseMs = { signedOut: 50, failed: 100, wait: 300 };
  service.teamRelay.cowork.pauseMs = { signedOut: 50, failed: 100, wait: 300, held: 100, report: 200 };
  service.teamRelay.start();
  cleanups.push(async () => {
    service.teamRelay.stop();
    service.teamLink.stop();
    await servers.close();
    store.close();
  });
  const coderClient = new RelayClient(relay.url, coder.key);
  const plannerClient = new RelayClient(relay.url, planner.key);
  const tool = async (sessionId: string, name: string, args: Record<string, unknown> = {}) => {
    const t = amoToolsFor(service, { sessionId } as never).find((x) => x.name === name)!;
    const out = await t.run(args);
    return { text: out.content.map((c) => (c.type === "text" ? c.text : "")).join(""), error: !!out.isError };
  };
  const setStatus = (id: string, status: Session["status"]) => service.publish({ type: "session.upserted", session: store.updateSession(id, { status }) });
  await until(() => service.teamLink.login(), (l) => !!l, "the platform's login");
  const artistClient = new RelayClient(relay.url, artist.key);
  return { service, store, told, events, session, coderClient, plannerClient, artistClient, tool, setStatus };
}

describe("协作 in Studio", () => {
  it("brings a session in; reports its state; an @ goes in once it is free, once, folded; cowork_post answers as the planner's AI", async () => {
    const { service, told, events, session, coderClient, tool, setStatus } = await setup();
    const c = await coderClient.createCowork({ title: "射速调整", goal: "把射速上限做成可配。", repo: "game", branch: "feat/rate", members: ["策划小王"] });
    const s = session("射速文档");

    // What 拉进协作 offers, then joining: shown as the planner's AI, with the session's name.
    expect(await service.teamRelay.cowork.coworks()).toMatchObject({ me: "策划小王", coworks: [{ title: "射速调整", members: ["程序老李", "策划小王"] }] });
    const j = await service.teamRelay.cowork.join(s.id, c.id);
    expect(j).toMatchObject({ coworkId: c.id, coworkTitle: "射速调整", sessionId: s.id, label: "射速文档", name: "策划小王 的 AI · 射速文档" });
    expect(service.teamRelay.cowork.joined()).toHaveLength(1);
    expect(events.some((e) => e.type === "cowork.joined.changed")).toBe(true);
    // Told it is in it, with the person's next message.
    expect(coworkHint(service.store, s.id)?.lines.join("\n")).toContain("拉进了协作「射速调整」");

    const agentOf = async () => (await coderClient.cowork(c.id)).cowork.agents.find((a) => a.mark === j.mark)!;
    await until(agentOf, (a) => a.state === "idle", "待命 reported");

    // Running: 处理中. An @ meanwhile waits on the service (排队中), not in the session.
    setStatus(s.id, "running");
    await until(agentOf, (a) => a.state === "busy", "处理中 reported");
    await coderClient.postCowork(c.id, { kind: "text", body: "上限放配置表行吗？", agentMentions: [j.mark] });
    await new Promise((r) => setTimeout(r, 600));
    expect(told).toHaveLength(0);
    expect((await agentOf()).queued).toBe(1);

    // The person writes in its composer: 等主人, still held.
    setStatus(s.id, "idle");
    service.teamRelay.cowork.composerSaid(s.id, true);
    await until(agentOf, (a) => a.state === "owner", "等主人 reported");
    await new Promise((r) => setTimeout(r, 400));
    expect(told).toHaveLength(0);

    // The composer emptied: it goes in, once, as the cowork's (folded), and is 已送达.
    service.teamRelay.cowork.composerSaid(s.id, false);
    await until(() => told.length, (n) => n === 1, "the @ in the session");
    expect(told[0]!.sessionId).toBe(s.id);
    expect(told[0]!.text).toMatch(/^【协作「射速调整」· 程序老李 在群聊里 @ 了你】/);
    expect(told[0]!.text).toContain("上限放配置表行吗？");
    expect(told[0]!.text).toContain("拉进了协作「射速调整」");
    expect(told[0]!.text).toContain(`cowork_post（threadId ${c.id}`);
    expect(told[0]!.origin).toMatchObject({ kind: "cowork", from: "程序老李", threadIds: [c.id], cowork: { id: c.id, title: "射速调整", where: "在群聊里 @ 了你" } });
    expect(coworkHint(service.store, s.id)).toBeNull();
    await until(async () => (await coderClient.cowork(c.id)).deliveries.map((d) => d.state), (st) => st.join() === "delivered", "已送达");
    await new Promise((r) => setTimeout(r, 400));
    expect(told).toHaveLength(1);

    // Its answer: as the planner's AI, quoting the message; the delivery is 已回复.
    const seq = (await coderClient.coworkFeed(c.id)).messages.find((m) => m.body === "上限放配置表行吗？")!.seq;
    const posted = await tool(s.id, "cowork_post", { body: "行，放 config/rate.json。", replyTo: seq });
    expect(posted).toMatchObject({ error: false });
    expect(posted.text).toContain("已发出");
    // Answering is not waking: no AI was sent it.
    expect(posted.text).not.toContain("送给了");
    const after = await coderClient.cowork(c.id);
    expect(after.deliveries[0]).toMatchObject({ state: "replied" });
    const reply = (await coderClient.coworkFeed(c.id)).messages.find((m) => m.body.startsWith("行，"))!;
    expect(reply).toMatchObject({ author: "策划小王", replyTo: seq, via: { kind: "ai", conv: j.mark } });

    // Other chat wakes nobody; it is counted, and said with the person's next message.
    await coderClient.postCowork(c.id, { kind: "text", body: "我先去改代码。" });
    await until(() => coworkHint(service.store, s.id)?.lines.join("") ?? "", (t) => t.includes("1 条新消息"), "「N 条新的」");
    expect(told).toHaveLength(1);

    // cowork_read: the goal, the people and AIs, the new messages; reading clears the count.
    const read = await tool(s.id, "cowork_read");
    expect(read.text).toContain("把射速上限做成可配。");
    expect(read.text).toContain("策划小王 的 AI · 射速文档");
    expect(read.text).toContain("我先去改代码。");
    expect(read.text).toContain("「AI 发起 @ 和提问」关着");
    expect(coworkHint(service.store, s.id)).toBeNull();

    // 退出: gone from the cowork and from the list.
    await service.teamRelay.cowork.leave(s.id, c.id);
    expect(service.teamRelay.cowork.joined()).toEqual([]);
    expect((await coderClient.cowork(c.id)).cowork.agents).toEqual([]);
    expect((await tool(s.id, "cowork_read")).text).toContain("不在任何协作里");
  }, 30_000);

  it("cowork_ask is a draft while 「AI 发起 @ 和提问」 is off; on, a reply in it goes in once — not again as a 中转回复", async () => {
    const { service, told, session, coderClient, plannerClient, tool } = await setup();
    const c = await coderClient.createCowork({ title: "背包", members: ["策划小王"] });
    const s = session("背包文档");
    const j = await service.teamRelay.cowork.join(s.id, c.id, "背包");

    const draft = await tool(s.id, "cowork_ask", { to: "程序老李", title: "上限存哪", body: "客户端常量还是配置表？" });
    expect(draft.text).toContain("存成了草稿");
    expect((await coderClient.cowork(c.id)).cowork.sessions).toEqual([]);
    // A draft waiting for the person: 等主人.
    await until(async () => (await coderClient.cowork(c.id)).cowork.agents[0]!.state, (st) => st === "owner", "等主人 for a draft");

    await coderClient.updateCowork(c.id, { options: { aiInitiate: true } });
    const asked = await tool(s.id, "cowork_ask", { to: "程序老李", title: "图标尺寸", body: "64×64 行吗？", questions: [{ text: "行不行", options: ["行", "不行"] }] });
    expect(asked.text).toContain("子会话「图标尺寸」已开");
    const sub = (await coderClient.cowork(c.id)).cowork.sessions.find((x) => x.title === "图标尺寸")!;
    expect(sub.agent).toBe(j.mark);

    // The planner drops the draft (in 中转): 待命 again; the coder answers the 子会话: in once, as the cowork's.
    const [d] = await plannerClient.coworkDrafts(c.id);
    await plannerClient.decideCoworkDraft(c.id, d!.id, { action: "drop" });
    await until(async () => (await coderClient.cowork(c.id)).cowork.agents[0]!.state, (st) => st === "idle", "待命 after the draft");
    await coderClient.send(sub.id, { kind: "reply", answers: [{ questionId: "q1", choice: "行" }], body: "按 64 出。" });
    await until(() => told.length, (n) => n === 1, "the reply in the session");
    expect(told[0]!.text).toMatch(/^【协作「背包」· 程序老李 回复了你发起的子会话「图标尺寸」】/);
    expect(told[0]!.text).toContain("按 64 出。");
    expect(told[0]!.text).not.toContain("【中转回复】");
    await service.teamRelay.scan();
    await new Promise((r) => setTimeout(r, 500));
    expect(told).toHaveLength(1);

    // The 子会话 in full.
    const full = await tool(s.id, "cowork_read", { threadId: sub.id });
    expect(full.text).toContain("子会话「图标尺寸」");
    expect(full.text).toContain("64×64 行吗？");
  }, 30_000);

  it("cowork_board reads and changes the board (base from what it read; stale and over 10 cards refused with what to do); cowork_note; 转到我的会话", async () => {
    const { service, told, events, session, coderClient, tool, store } = await setup();
    const c = await coderClient.createCowork({ title: "射速", members: ["策划小王"] });
    const s = session("射速文档");
    await service.teamRelay.cowork.join(s.id, c.id);

    expect((await tool(s.id, "cowork_board")).text).toContain("白板是空的");
    const added = await tool(s.id, "cowork_board", { ops: [{ op: "add", item: { id: "n1", kind: "note", text: "上限 20", x: 0, y: 0 } }, { op: "add", item: { id: "r1", kind: "ref", ref: { kind: "file", path: "设计/射速.md", commit: "aaa111" }, x: 300, y: 0 } }] });
    expect(added.text).toContain("做了 2 条");
    expect((await tool(s.id, "cowork_board")).text).toContain("[note] n1 · base 1");
    // The coder rewrites it after the agent read it: the agent's change (base filled in from its read) is refused.
    await coderClient.coworkBoardOps(c.id, [{ op: "set", id: "n1", base: 1, fields: { text: "上限 25" } }]);
    const stale = await tool(s.id, "cowork_board", { ops: [{ op: "set", id: "n1", fields: { text: "上限 30" } }] });
    expect(stale.text).toContain("没做的 1 条");
    expect(stale.text).toContain("先不带 ops 调 cowork_board 重新读");
    const many = await tool(s.id, "cowork_board", { ops: Array.from({ length: 11 }, (_, i) => ({ op: "add", item: { kind: "note", text: `卡 ${i}` } })) });
    expect(many).toMatchObject({ error: true });
    expect(many.text).toContain("一次最多改 10 张卡");

    // A commit with its files: the ref card on an older commit of it goes 已过时.
    const noted = await tool(s.id, "cowork_note", { kind: "commit", text: "射速上限进配置表", commit: "bbb222", files: ["设计/射速.md"] });
    expect(noted.text).toContain("1 张引用了这些文件旧提交的卡标成了已过时");
    expect((await coderClient.coworkEvents(c.id)).map((e) => e.kind)).toContain("commit");

    // 转到我的会话: the coder asks the planner (a person) in a 子会话; the planner hands it to another session here.
    const asked = await coderClient.askCowork(c.id, { to: "策划小王", title: "射速曲线", body: "线性还是指数？" });
    const sub = asked.thread!;
    const other = session("曲线");
    const h = await service.teamRelay.cowork.handoff(sub.id);
    expect(h).toMatchObject({ threadId: sub.id, coworkId: c.id, coworkTitle: "射速", title: "射速曲线", from: "程序老李", to: "策划小王" });
    expect(events.some((e) => e.type === "cowork.handoffs.changed" && e.added === sub.id)).toBe(true);
    expect(service.teamRelay.cowork.handoffs()).toHaveLength(1);
    const took = await service.teamRelay.cowork.acceptHandoff({ threadId: sub.id, sessionId: other.id });
    expect(took).toMatchObject({ sessionId: other.id, taskId: other.taskId });
    expect(service.teamRelay.cowork.handoffs()).toEqual([]);
    expect(service.teamRelay.cowork.joined().map((j) => j.sessionId).sort()).toEqual([s.id, other.id].sort());
    const handed = told.find((t) => t.sessionId === other.id)!;
    expect(handed.text).toMatch(/^【协作「射速」· 策划小王 把子会话「射速曲线」转给你】/);
    expect(handed.text).toContain("线性还是指数？");
    expect(handed.text).toContain(`cowork_post（threadId ${sub.id}）`);
    expect(handed.origin).toMatchObject({ kind: "cowork", from: "策划小王", threadIds: [sub.id] });
    expect(events.some((e) => e.type === "ui.open" && e.sessionId === other.id)).toBe(true);

    // A new task's session takes another one.
    const again = await coderClient.askCowork(c.id, { to: "策划小王", title: "射速音效", body: "要不要随射速变？" });
    await service.teamRelay.cowork.handoff(again.thread!.id);
    const made = await service.teamRelay.cowork.acceptHandoff({ threadId: again.thread!.id, newTask: { workspaceId: store.listWorkspaces().find((w) => w.name === "alpha")!.id, profileId: "p" } });
    expect(store.getTask(made.taskId)?.title).toBe("协作：射速音效");
    expect(service.teamRelay.cowork.joined().find((j) => j.sessionId === made.sessionId)).toMatchObject({ label: "射速音效" });
    expect(told.find((t) => t.sessionId === made.sessionId)?.text).toContain("要不要随射速变？");
  }, 30_000);
  it("cowork_read lists the files of the 群聊 and the 子会话 (team_file_get takes them); cowork_conclude only for the asker or the one asked (2026-11-23)", async () => {
    const { service, session, coderClient, artistClient, tool } = await setup();
    const c = await coderClient.createCowork({ title: "射速调整", members: ["策划小王", "美术小周"] });
    const s = session("射速文档");
    await service.teamRelay.cowork.join(s.id, c.id, "射速文档");
    const enc = new TextEncoder();
    const inChat = await coderClient.upload({ threadId: c.id }, "rate.json", enc.encode('{"max":12}'), "application/json");
    const toPlanner = await coderClient.askCowork(c.id, { to: "策划小王", title: "射速曲线", body: "线性还是指数？" });
    const inSub = await coderClient.upload({ threadId: toPlanner.thread!.id }, "curve.txt", enc.encode("linear"), "text/plain");
    const toArtist = await coderClient.askCowork(c.id, { to: "美术小周", title: "枪口火光", body: "要随射速变大吗？" });

    // The files, each with where it is and the threadId + fileId team_file_get takes.
    const read = await tool(s.id, "cowork_read");
    expect(read.text).toContain("## 文件（2 个）");
    expect(read.text).toMatch(new RegExp(`rate\\.json v1 .* 在群聊 · threadId ${c.id} · fileId ${inChat.id}`));
    expect(read.text).toMatch(new RegExp(`curve\\.txt v1 .* 在子会话「射速曲线」 · threadId ${toPlanner.thread!.id} · fileId ${inSub.id}`));
    for (const [threadId, fileId] of [[c.id, inChat.id], [toPlanner.thread!.id, inSub.id]] as const) {
      const got = await tool(s.id, "team_file_get", { threadId, fileId });
      expect(got.error).toBe(false);
      expect(got.text).toContain("已取下");
    }

    // A 子会话 asking someone else: not the planner's to conclude; the 群聊 has none; one asking the planner, once.
    const notMine = await tool(s.id, "cowork_conclude", { threadId: toArtist.thread!.id, conclusion: "不变" });
    expect(notMine.error).toBe(true);
    expect(notMine.text).toContain("是 程序老李 问 美术小周 的，结论只有他们两边");
    expect((await tool(s.id, "cowork_conclude", { threadId: c.id, conclusion: "x" })).text).toContain("群聊没有结论");
    const done = await tool(s.id, "cowork_conclude", { threadId: toPlanner.thread!.id, conclusion: "先用线性，上限 12。" });
    expect(done.error).toBe(false);
    expect(done.text).toContain("子会话「射速曲线」定下结论：先用线性，上限 12。");
    const after = await coderClient.cowork(c.id);
    expect(after.cowork.sessions.find((x) => x.id === toPlanner.thread!.id)).toMatchObject({ state: "done", conclusion: "先用线性，上限 12。" });
    const decision = after.events.find((e) => e.kind === "decision")!;
    expect(decision.text).toBe("「射速曲线」：先用线性，上限 12。");
    expect(decision.agent).toBe(service.teamRelay.cowork.joined()[0]!.mark);
    expect((await tool(s.id, "cowork_conclude", { threadId: toPlanner.thread!.id, conclusion: "改成指数" })).text).toContain("已经结束了，结论是：先用线性，上限 12。");
    expect((await tool(s.id, "cowork_read")).text).toContain("「射速曲线」：先用线性，上限 12。");
    // The one asked, by hand, may too (the service's rule): 美术小周 settles theirs.
    await artistClient.concludeCowork(c.id, toArtist.thread!.id, "不变");
  }, 30_000);
  it("an @ it read with cowork_read while busy is 送达 then, not put into the conversation once it is free (2026-11-23, real-model run)", async () => {
    const { service, told, session, coderClient, tool, setStatus } = await setup();
    const c = await coderClient.createCowork({ title: "射速调整", members: ["策划小王"] });
    const s = session("射速文档");
    const j = await service.teamRelay.cowork.join(s.id, c.id);
    const agentOf = async () => (await coderClient.cowork(c.id)).cowork.agents.find((a) => a.mark === j.mark)!;
    await until(agentOf, (a) => a.state === "idle", "待命 reported");
    setStatus(s.id, "running");
    await until(agentOf, (a) => a.state === "busy", "处理中 reported");
    const at = await coderClient.postCowork(c.id, { kind: "text", body: "warn 带上文件路径。", agentMentions: [j.mark] });
    await until(async () => (await coderClient.cowork(c.id)).deliveries.map((d) => d.state), (st) => st[0] === "queued", "排队中");

    // Mid-turn it reads the 协作: the @ is in what it read, and it is told it will not come again.
    const read = await tool(s.id, "cowork_read");
    expect(read.text).toContain("warn 带上文件路径。");
    expect(read.text).toContain(`（上面有 1 条是给你的（#${at.message!.seq}）：算你已经收到，不会再单独送进这个对话。`);
    expect((await coderClient.cowork(c.id)).deliveries.map((d) => d.state)).toEqual(["delivered"]);

    // Its turn ends: nothing goes in; its answer in the 群聊 settles it.
    setStatus(s.id, "idle");
    await until(agentOf, (a) => a.state === "idle", "待命 again");
    await new Promise((r) => setTimeout(r, 800));
    expect(told).toHaveLength(0);
    await tool(s.id, "cowork_post", { body: "已加上。", replyTo: at.message!.seq });
    expect((await coderClient.cowork(c.id)).deliveries.map((d) => d.state)).toEqual(["replied"]);
    // Read again: nothing waiting, nothing said about it.
    expect((await tool(s.id, "cowork_read")).text).not.toContain("算你已经收到");
  }, 30_000);
});
