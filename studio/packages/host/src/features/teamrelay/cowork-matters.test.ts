import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MessageOrigin, ModelProfile, Session } from "@amo-studio/protocol";
import { saveAccount, type Protector } from "@amo-studio/account";
import { agentParty, RelayClient, RelayStore, startRelayServer, type RelayServer } from "@amo-studio/relay";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { amoToolsFor } from "../../mcp/tools.js";
import { recordRole, roleCard } from "../guide/role.js";
import { teamRelayRoutes } from "./routes.js";

// 协作里 AI 怎么参与 (2026-11-24, plans/collab-agent-spec.md), against a relay service on this machine with 事项 (health
// cowork 2): roles and their cards, the tools' 指代 (「事项 1」, #seq, names), cowork_matter / cowork_mark / cowork_retract,
// the patrol waking a 主控 with only what changed (after its turn when it is in one), 让主控现在看一遍, and 待我处理.

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
  const d = mkdtempSync(join(tmpdir(), `amo-matters-${name}-`));
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
  const told: Array<{ sessionId: string; text: string; origin?: MessageOrigin }> = [];
  service.sessions.inbox.put = async (sessionId: string, text: string, origin?: MessageOrigin) => {
    told.push({ sessionId, text, ...(origin ? { origin } : {}) });
    return { delivered: true, waiting: 0 };
  };
  service.teamLink.start({ env, protector: fake, watchMs: 30 });
  service.teamRelay.pauseMs = { signedOut: 50, failed: 100, wait: 300 };
  service.teamRelay.cowork.pauseMs = { signedOut: 50, failed: 100, wait: 300, held: 100, report: 200 };
  service.pending.patrolMs = 3600_000; // ticked by hand
  service.teamRelay.start();
  service.pending.start();
  if (service.teamRelay.coworkPending) service.teamRelay.coworkPending.waitMs = { person: 300, failed: 100 };
  cleanups.push(async () => {
    service.pending.stop();
    service.teamRelay.stop();
    service.teamLink.stop();
    await servers.close();
    store.close();
  });
  const coderClient = new RelayClient(relay.url, coder.key);
  const tool = async (sessionId: string, name: string, args: Record<string, unknown> = {}) => {
    const t = amoToolsFor(service, { sessionId } as never).find((x) => x.name === name)!;
    const out = await t.run(args);
    return { text: out.content.map((c) => (c.type === "text" ? c.text : "")).join(""), error: !!out.isError };
  };
  const setStatus = (id: string, status: Session["status"]) => service.publish({ type: "session.upserted", session: store.updateSession(id, { status }) });
  await until(() => service.teamLink.login(), (l) => !!l, "the platform's login");
  return { service, store, told, session, coderClient, tool, setStatus };
}

describe("协作里的事项和角色 in Studio (2026-11-24)", () => {
  it("joins as this side's 主控 with its card (a second is refused saying who); roles offers the 事项; an 执行 of one 事项 gets its card and is held to it", async () => {
    const { service, session, coderClient, tool } = await setup();
    const c = await coderClient.createCowork({ title: "穿透", goal: "子弹能穿透 3 个敌人。", members: ["策划小王"] });
    const lead = session("穿透文档");
    const j = await service.teamRelay.cowork.join(lead.id, c.id);
    expect(j).toMatchObject({ role: "lead", matters: true, matter: null });
    const card = service.sessions.roleUpdate(lead.id).lines.join("\n");
    expect(card).toContain("你的角色：主控");
    expect(card).toContain("「策划小王」这一方在协作「穿透」里的**主控**");
    expect(card).toContain("转述之前要核对");
    // amo_whoami gives the card too.
    expect(roleCard(service, lead.id)).toContain("协作「穿透」");
    expect(roleCard(service, lead.id)).toContain("里的角色：主控");

    // A second 主控 of the same side: refused, saying who holds it.
    const other = session("另一个");
    await expect(service.teamRelay.cowork.join(other.id, c.id)).rejects.toThrow(/已经有主控/);

    // 拉进协作's choice: who leads my side, and the 事项 an 执行 may take.
    const m = (await coderClient.openMatter(c.id, { title: "穿透判定", body: "改碰撞层" })).matter;
    const roles = await service.teamRelay.cowork.roles(c.id);
    expect(roles).toMatchObject({ matters: true, lead: { sessionId: lead.id }, openMatters: [{ id: m.id, no: 1, title: "穿透判定" }] });

    // An 执行 of 事项 1 (by 「事项 1」): its card; it reads only its 事项 and may not post in the 群聊.
    const w = await service.teamRelay.cowork.join(other.id, c.id, "写判定", { role: "worker", matter: "事项 1" });
    expect(w).toMatchObject({ role: "worker", matter: { id: m.id, no: 1 } });
    expect(service.sessions.roleUpdate(other.id).lines.join("\n")).toContain("只负责协作「穿透」");
    const read = await tool(other.id, "cowork_read");
    expect(read.text).toContain("角色：执行（事项 1）");
    expect(read.text).toContain("事项 1「穿透判定」");
    const chat = await tool(other.id, "cowork_post", { body: "我在群聊说一句" });
    expect(chat.error).toBe(true);
    // basis confirmed needs when: none of the person's words here yet, so refused; then with what the person said.
    expect((await tool(other.id, "cowork_post", { threadId: "事项 1", body: "已推 abc123。", basis: "confirmed" })).text).toContain("还没有 策划小王 的话");
    service.store.appendItem({ id: `i-${other.id}-said`, sessionId: other.id, createdAt: new Date().toISOString(), type: "user", text: "就按 3 个敌人做" } as never);
    const inMatter = await tool(other.id, "cowork_post", { threadId: "事项 1", body: "已推 abc123，改了 Bullet.cs。", basis: "confirmed" });
    expect(inMatter).toMatchObject({ error: false });
    expect(inMatter.text).toContain("在事项 1");
    const posted = (await coderClient.coworkFeed(c.id)).messages.find((x) => x.body.includes("abc123"))!;
    expect(posted).toMatchObject({ threadId: m.id, body: "已推 abc123，改了 Bullet.cs。", basis: { kind: "confirmed", person: "策划小王" } });
    expect(typeof (posted.basis as { at?: number } | undefined)?.at).toBe("number");
    expect((await tool(other.id, "cowork_matter", { action: "update", matter: "事项 1", status: "已推送" })).text).toContain("你是执行会话");

    // 改角色: the 执行 becomes nothing new here — the 主控 changes the 事项 instead (by 「事项 1」 and the status's label).
    const upd = await tool(lead.id, "cowork_matter", { action: "update", matter: "事项 1", status: "已推送", note: "执行贴了提交" });
    expect(upd).toMatchObject({ error: false });
    expect(upd.text).toContain("→ 已推送");
    expect((await coderClient.cowork(c.id)).cowork.matters!.find((x) => x.id === m.id)!.status).toBe("pushed");
  }, 30_000);

  it("the role card goes the role update's way (joined, role changed, after a compaction with the whole card); cowork_board lists the 事项卡; cowork-patrol-<id> wakes this side's 主控 (2026-11-25)", async () => {
    const { service, store, told, session, coderClient, tool } = await setup();
    const c = await coderClient.createCowork({ title: "穿透", goal: "子弹能穿透 3 个敌人。", members: ["策划小王"] });
    const lead = session("穿透文档");
    recordRole(service, lead.id);
    expect(service.sessions.roleUpdate(lead.id).lines).toEqual([]);
    await service.teamRelay.cowork.join(lead.id, c.id);
    // Joined: one line with the whole card, told once.
    const joined = service.sessions.roleUpdate(lead.id);
    expect(joined.lines).toHaveLength(1);
    expect(joined.lines[0]).toContain("你被拉进了协作「穿透」");
    expect(joined.lines[0]).toContain("这一方在协作「穿透」里的**主控**");
    joined.told();
    expect(service.sessions.roleUpdate(lead.id).lines).toEqual([]);
    // Its role changed: the new card.
    const m = (await coderClient.openMatter(c.id, { title: "穿透判定", body: "改碰撞层" })).matter;
    await service.teamRelay.cowork.setRole({ sessionId: lead.id, coworkId: c.id, role: "worker", matter: "事项 1" });
    const changed = service.sessions.roleUpdate(lead.id);
    expect(changed.lines.join("\n")).toContain("角色改成了「执行（事项 1）」（之前是「主控」）");
    expect(changed.lines.join("\n")).toContain("只负责协作「穿透」");
    changed.told();
    await service.teamRelay.cowork.setRole({ sessionId: lead.id, coworkId: c.id, role: "lead" });
    service.sessions.roleUpdate(lead.id).told();

    // After a compaction: to read the 协作 again, and the whole card it has now (its AMO role and its 协作 role).
    store.appendItem({ id: `i-${lead.id}-compact`, sessionId: lead.id, createdAt: new Date().toISOString(), type: "compaction", state: "completed" } as never);
    const after = service.sessions.roleUpdate(lead.id);
    expect(after.lines.join("\n")).toContain("你的上下文刚被压缩。先用 cowork_read");
    expect(after.lines.join("\n")).toContain("协作「穿透」（cowork:");
    expect(after.lines.join("\n")).toContain("里的角色：主控");
    after.told();
    expect(service.sessions.roleUpdate(lead.id).lines).toEqual([]);

    // cowork_board: the 事项卡 drawn from the 事项, read-only.
    const board = await tool(lead.id, "cowork_board");
    expect(board.text).toContain("事项卡（由事项算出");
    expect(board.text).toContain(`[事项] ${m.id} · 事项 1「穿透判定」· 在做`);
    expect(board.text).toContain("组「程序老李 这一方」");

    // 让我这一方的主控现在看一遍, as the 中转 client asks it.
    const route = teamRelayRoutes(service).find((r) => r.method === "POST" && r.path === "/api/ui/open")!;
    const asked: unknown[] = [];
    const patrol = service.pending.patrol.bind(service.pending);
    service.pending.patrol = async (ids?: unknown) => (asked.push(ids), patrol(ids));
    const out = await route.handle({ params: {}, body: { sessionId: `cowork-patrol-${c.id}` } } as never);
    expect(out).toMatchObject({ sessionId: lead.id, taskId: lead.taskId });
    expect(asked).toEqual([[lead.id]]);
    void told;
    await expect((async () => route.handle({ params: {}, body: { sessionId: "cowork-patrol-t_nope" } } as never))()).rejects.toThrow(/没有这个协作里你这一方的主控会话/);
  }, 30_000);

  it("在我的 Studio 里开这一方的主控 (the 中转 client's cowork-lead-<id>): asks which session, a new task joins as 主控 and is given the 协作", async () => {
    const { service, store, told, coderClient } = await setup();
    const c = await coderClient.createCowork({ title: "穿透", goal: "子弹能穿透 3 个敌人。", members: ["策划小王"] });
    await coderClient.openMatter(c.id, { title: "穿透判定", body: "改碰撞层" });
    const h = await service.teamRelay.cowork.leadAsk(`cowork:${c.id}`);
    expect(h).toMatchObject({ threadId: `lead:${c.id}`, coworkId: c.id, coworkTitle: "穿透", lead: true });
    expect(service.teamRelay.cowork.handoffs()).toHaveLength(1);
    const made = await service.teamRelay.cowork.acceptHandoff({ threadId: h.threadId, newTask: { workspaceId: store.listWorkspaces().find((w) => w.name === "alpha")!.id, profileId: "p" } });
    expect(store.getTask(made.taskId)?.title).toBe("协作：穿透");
    expect(service.teamRelay.cowork.joined().find((j) => j.sessionId === made.sessionId)).toMatchObject({ role: "lead", label: "主控" });
    expect(service.teamRelay.cowork.handoffs()).toEqual([]);
    const first = told.find((t) => t.sessionId === made.sessionId)!;
    expect(first.text).toMatch(/^【协作「穿透」· 策划小王 让你当这一方的主控】/);
    // Its card goes with that message as the role update (the inbox adds it; put is stood in for here).
    expect(service.sessions.roleUpdate(made.sessionId).lines.join("\n")).toContain("你的角色：主控");
    expect(first.text).toContain("子弹能穿透 3 个敌人。");
    expect(first.text).toContain("事项 1「穿透判定」");
    expect(first.origin).toMatchObject({ kind: "cowork", from: "策划小王", cowork: { id: c.id } });
    // A second ask while that side has its 主控: the join says who holds it.
    await service.teamRelay.cowork.leadAsk(c.id);
    const tasks = store.listTasks().length;
    await expect(service.teamRelay.cowork.acceptHandoff({ threadId: `lead:${c.id}`, newTask: { workspaceId: store.listWorkspaces()[0]!.id, profileId: "p" } })).rejects.toThrow(/已经有主控：策划小王 的 AI · 主控/);
    expect(store.listTasks()).toHaveLength(tasks);
  }, 30_000);

  it("cowork_matter opens one waiting on 「程序老李 的主控」; cowork_post answers by #seq and marks it handled; cowork_mark; cowork_retract before seen; close writes 已定的事", async () => {
    const { service, session, coderClient, tool } = await setup();
    const c = await coderClient.createCowork({ title: "射速", members: ["策划小王"] });
    const lead = session("射速文档");
    const j = await service.teamRelay.cowork.join(lead.id, c.id);
    const coderMark = "studio:CODER:s-1";
    await coderClient.joinCoworkAgent(c.id, coderMark, "射速代码");

    const opened = await tool(lead.id, "cowork_matter", { action: "open", title: "射速上限", body: "上限放配置表？", waitingOn: ["程序老李的主控"] });
    expect(opened.text).toContain("开了事项 1「射速上限」");
    const m = (await coderClient.cowork(c.id)).cowork.matters!.find((x) => x.no === 1)!;
    expect(m.waitingOn).toEqual([agentParty(coderMark)]);

    // The coder's AI answers in it, @-ing the planner's 主控; the planner's 主控 answers by 「#seq」, which marks it 处理了.
    const asked = await coderClient.postCowork(c.id, { kind: "text", threadId: m.id, body: "放 config/rate.json 行吗？", agentMentions: [j.mark], via: { kind: "ai", client: "AMO Studio", conv: coderMark } });
    const seq = asked.message!.seq;
    const before = await service.teamRelay.cowork.agentPending(service.teamRelay.cowork.relayLogin().client, c.id, j.mark);
    expect(before.some((i) => i.seq === seq)).toBe(true);
    const answer = await tool(lead.id, "cowork_post", { threadId: "事项 1", body: "行。", replyTo: `#${seq}` });
    expect(answer.text).toContain(`#${seq} 标成了处理了`);
    const after = await service.teamRelay.cowork.agentPending(service.teamRelay.cowork.relayLogin().client, c.id, j.mark);
    expect(after.some((i) => i.seq === seq)).toBe(false);

    // A message nobody saw yet: rewritten, then withdrawn. Unknown names are refused with who is there.
    const mine = (await tool(lead.id, "cowork_post", { threadId: "事项 1", body: "草稿一句" })).text;
    const mySeq = Number(/#(\d+)/.exec(mine)![1]);
    expect((await tool(lead.id, "cowork_retract", { seq: mySeq, body: "改过的一句" })).text).toContain("改好了");
    expect((await tool(lead.id, "cowork_retract", { seq: mySeq })).text).toContain("撤回了");
    const nobody = await tool(lead.id, "cowork_post", { body: "hi", agentMentions: ["不存在的人"] });
    expect(nobody.error).toBe(true);
    expect(nobody.text).toContain("找不到「不存在的人」");

    // cowork_mark by 事项; close (and cowork_conclude, its old name) writes the conclusion into 已定的事.
    expect((await tool(lead.id, "cowork_mark", { matter: "事项 1" })).error).toBe(false);
    const closed = await tool(lead.id, "cowork_conclude", { threadId: "事项 1", conclusion: "上限放 config/rate.json" });
    expect(closed.text).toContain("关掉了");
    const read = await tool(lead.id, "cowork_read");
    expect(read.text).toContain("上限放 config/rate.json");
    expect(read.text).toContain("角色：主控");
  }, 30_000);

  it("the patrol wakes a 主控 with only what changed, after its turn when it is in one; 让主控现在看一遍 wakes with all; 待我处理 has the person's and the 主控's groups", async () => {
    const { service, session, coderClient, told, setStatus } = await setup();
    const c = await coderClient.createCowork({ title: "背包", members: ["策划小王"] });
    const lead = session("背包文档");
    const j = await service.teamRelay.cowork.join(lead.id, c.id);
    const m = (await coderClient.openMatter(c.id, { title: "图标尺寸", body: "64 还是 128？", waitingOn: [agentParty(j.mark)] })).matter;

    // In a turn: nothing goes in; once it is over, the wake does.
    setStatus(lead.id, "running");
    await service.pending.tick();
    expect(told.filter((t) => t.sessionId === lead.id && t.text.includes("待你处理"))).toHaveLength(0);
    setStatus(lead.id, "idle");
    const woke = await until(() => told.filter((t) => t.sessionId === lead.id && t.text.includes("【协作 · 待你处理】")), (x) => x.length === 1, "the wake after the turn");
    expect(woke[0]!.text).toContain("为什么现在叫你：巡检");
    expect(woke[0]!.text).toContain(`事项 ${m.no}「图标尺寸」`);
    expect(woke[0]!.text).toContain("在等 你");
    expect(woke[0]!.text).toContain("这一轮结束前");
    expect(woke[0]!.origin).toMatchObject({ kind: "cowork", cowork: { id: c.id } });

    // Nothing new: the next patrol wakes nobody.
    await service.pending.tick();
    expect(told.filter((t) => t.text.includes("【协作 · 待你处理】"))).toHaveLength(1);

    // 让主控现在看一遍: the whole list again.
    const r = await service.pending.patrol([lead.id]);
    expect(r.woke).toEqual([lead.id]);
    const again = told.filter((t) => t.text.includes("【协作 · 待你处理】"));
    expect(again).toHaveLength(2);
    expect(again[1]!.text).toContain("让你现在看一遍");

    // 待我处理: the 主控's group (for its session) and, after an @ of the person, theirs.
    await coderClient.postCowork(c.id, { kind: "text", body: "@策划小王 看下图标", mentions: ["策划小王"] });
    await service.pending.tick();
    const snap = await until(() => service.pending.snapshot(), (s) => s.mine > 0, "the person's group");
    const leadGroup = snap.groups.find((g) => g.for.kind === "session")!;
    expect(leadGroup).toMatchObject({ source: "cowork", title: "协作「背包」", for: { sessionId: lead.id } });
    expect(leadGroup.items.find((i) => i.kind === "waiting")).toMatchObject({ matter: { no: 1 }, open: { kind: "session", sessionId: lead.id } });
    const mineGroup = snap.groups.find((g) => g.for.kind === "person")!;
    expect(mineGroup.items[0]).toMatchObject({ kind: "mention", open: { kind: "relay", target: `cowork:${c.id}` } });
    // Marked 处理了 from Studio: gone.
    const marked = await service.pending.mark({ group: mineGroup.id, keys: [mineGroup.items[0]!.key], mark: "handled" });
    expect(marked.mine).toBe(0);
    // The session's 协作 line counts its 待我处理.
    expect(service.teamRelay.cowork.joined().find((x) => x.sessionId === lead.id)!.pending).toBe(leadGroup.items.length);
  }, 30_000);
});
