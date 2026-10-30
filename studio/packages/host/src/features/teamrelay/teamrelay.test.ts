import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostEvent, ModelProfile, Session } from "@amo-studio/protocol";
import { saveAccount, type Protector } from "@amo-studio/account";
import { RelayClient, RelayStore, startRelayServer, type RelayServer } from "@amo-studio/relay";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { amoToolsFor } from "../../mcp/tools.js";
import { Backoff } from "../remote/link.js";

// 会话里用中转 (2026-10-30, plans/relay-in-sessions.md), against a relay service on this machine (never the team server):
// a session asks someone, the person confirms it in Studio, the other person replies in 中转, and the reply goes back
// into the session that asked — only into it, once.

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
  const d = mkdtempSync(join(tmpdir(), `amo-teamrelay-${name}-`));
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

async function setup(signedIn = true) {
  const relayStore = new RelayStore(":memory:");
  const relay: RelayServer = await startRelayServer({ store: relayStore, filesDir: tempDir("files"), host: "127.0.0.1", port: 0 });
  cleanups.push(() => relayStore.close());
  cleanups.push(() => relay.close());
  const planner = relayStore.register("策划小王", "pw-aaaa");
  const coder = relayStore.register("程序老李", "pw-bbbb");

  const home = tempDir("home");
  const env = { AMO_HOME: home, COMPUTERNAME: "PLANNER-PC" };
  if (signedIn) await saveAccount({ server: relay.url, name: "策划小王", key: planner.key }, { env, protector: fake });
  const root = tempDir("data");
  const store = new Store(join(root, "studio.db"));
  const servers = new FakeServers(PROFILES);
  const service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  mkdirSync(join(root, "alpha"));
  const alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
  const session = (title: string): Session => {
    const task = store.createTask({ title, workspaceId: alpha.id });
    return store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "p", workspaceId: alpha.id, title: "", status: "idle", writer: "workbench", runtimeRef: null });
  };
  // What goes into sessions, instead of a model turn.
  const told: Array<{ sessionId: string; text: string }> = [];
  service.sessions.sendMessage = async (sessionId: string, text: string) => {
    told.push({ sessionId, text });
    return { mode: "turn" } as never;
  };
  const events: HostEvent[] = [];
  service.on("event", (e) => events.push(e));
  service.remote.start({ env, protector: fake, watchMs: 30, backoff: new Backoff({ baseMs: 30, maxMs: 120 }) });
  service.teamRelay.pauseMs = { signedOut: 50, failed: 100, wait: 400 };
  service.teamRelay.start();
  cleanups.push(async () => {
    service.teamRelay.stop();
    service.remote.stop();
    await servers.close();
    store.close();
  });
  const coderClient = new RelayClient(relay.url, coder.key);
  const tool = async (sessionId: string, name: string, args: Record<string, unknown> = {}) => {
    const t = amoToolsFor(service, { sessionId } as never).find((x) => x.name === name)!;
    const out = await t.run(args);
    return { text: out.content.map((c) => c.text).join(""), error: !!out.isError };
  };
  await until(() => service.remote.teamLogin(), (l) => !signedIn || !!l, "the platform's login");
  return { service, store, told, events, session, coderClient, tool, relay, relayStore, root };
}

describe("会话里用中转", () => {
  it("team_ask waits for the person; sent as them (AI 代发, the session's mark); the reply goes back into that session once", async () => {
    const { service, told, events, session, coderClient, tool, root } = await setup();
    const asking = session("背包上限");
    const other = session("别的任务");
    expect((await tool(asking.id, "team_members")).text).toContain("程序老李");

    const doc = join(root, "bag.md");
    writeFileSync(doc, "# 背包\n\n每升 10 级 +5 格。");
    const asked = await tool(asking.id, "team_ask", { to: "程序老李", title: "背包上限存哪", body: "打算写死在客户端常量里。", questions: [{ text: "上限放哪", options: ["客户端常量", "服务端配置表"] }], files: [doc] });
    expect(asked.error).toBe(false);
    expect(asked.text).toContain("等人在 Studio 里确认后发给 程序老李");
    // Nothing went out yet.
    expect(await coderClient.threads()).toEqual([]);
    const [pending] = service.teamRelay.sends();
    expect(pending).toMatchObject({ sessionId: asking.id, kind: "ask", to: "程序老李", state: "pending", files: [doc] });
    expect(events.some((e) => e.type === "teamsend.upserted" && e.send.id === pending!.id)).toBe(true);

    // The person says send it: the coder has it, as the planner's AI, with the file.
    const sent = await service.teamRelay.send(pending!.id);
    expect(sent).toMatchObject({ state: "sent" });
    const [thread] = await coderClient.threads();
    expect(thread?.request).toMatchObject({ from: "策划小王", to: "程序老李", byAi: true, handler: "ai" });
    expect(thread?.request?.conv).toMatch(new RegExp(`^studio:d_[0-9a-f]{24}:${asking.id}$`));
    expect(thread?.last?.via).toMatchObject({ kind: "ai", client: "AMO Studio" });
    expect((await coderClient.files({ threadId: thread!.id })).map((f) => f.name)).toEqual(["bag.md"]);
    expect(service.teamRelay.threads()).toEqual([expect.objectContaining({ threadId: thread!.id, sessionId: asking.id, to: "程序老李", state: "open" })]);
    expect((await tool(asking.id, "team_sessions")).text).toContain("等 程序老李 回复");

    // The coder replies: the reply goes into the asking session by itself — not into the other one — once.
    await coderClient.send(thread!.id, { kind: "reply", answers: [{ questionId: "q1", choice: "服务端配置表" }], body: "运营会调。", verdict: "change" });
    await until(() => told.length, (n) => n > 0, "the reply in the session");
    expect(told).toHaveLength(1);
    expect(told[0]!.sessionId).toBe(asking.id);
    expect(told[0]!.text).toContain("【中转回复】");
    expect(told[0]!.text).toContain("**上限放哪** → 服务端配置表");
    expect(told[0]!.text).not.toContain("打算写死在客户端常量里");
    expect(told[0]!.text).toContain("team_followup");
    const [back] = await coderClient.threads();
    expect(back?.request?.pickedAt).not.toBeNull();
    await until(() => service.teamRelay.threads()[0], (t) => t?.state === "returned" && t.deliveredAt !== null, "the thread back");
    await service.teamRelay.scan();
    expect(told).toHaveLength(1);
    expect(told.some((t) => t.sessionId === other.id)).toBe(false);

    // A follow-up waits too, and only the session that sent it may ask again.
    expect((await tool(other.id, "team_followup", { threadId: thread!.id, body: "再问" })).text).toContain("不是你这个会话发的");
    await tool(asking.id, "team_followup", { threadId: thread!.id, body: "好，放配置表。用哪张？", questions: [{ text: "哪张表", options: ["player_level", "新建 bag_limit"] }] });
    const follow = service.teamRelay.sends().find((s) => s.kind === "followup")!;
    expect(follow).toMatchObject({ state: "pending", threadId: thread!.id, to: "程序老李" });
    await service.teamRelay.send(follow.id);
    await coderClient.send(thread!.id, { kind: "reply", answers: [{ questionId: "q1", choice: "新建 bag_limit" }] });
    await until(() => told.length, (n) => n > 1, "the second reply");
    expect(told[1]!.text).toContain("**哪张表** → 新建 bag_limit");
    expect(told[1]!.text).not.toContain("上限放哪");

    // Settled: team_done closes it (no asking).
    expect((await tool(asking.id, "team_done", { threadId: thread!.id, note: "按 bag_limit 做。" })).error).toBe(false);
    expect((await coderClient.threads())[0]?.request?.state).toBe("done");
  });

  it("not sent: the session hears so; without the platform's login the tools say where to sign in", async () => {
    const { service, told, session, coderClient, tool } = await setup();
    const s = session("任务");
    expect((await tool(s.id, "team_ask", { to: "没这个人", title: "x", body: "y" })).text).toContain("团队里没有「没这个人」");
    expect((await tool(s.id, "team_ask", { to: "策划小王", title: "x", body: "y" })).text).toContain("直接在对话里问");
    await tool(s.id, "team_ask", { to: "程序老李", title: "接口确认", body: "要加字段" });
    const [pending] = service.teamRelay.sends();
    service.teamRelay.dismiss(pending!.id);
    expect(service.teamRelay.sends()[0]?.state).toBe("dismissed");
    expect(told).toEqual([{ sessionId: s.id, text: expect.stringContaining("人没让发出去") }]);
    expect(await coderClient.threads()).toEqual([]);
    await expect(service.teamRelay.send(pending!.id)).rejects.toThrow(/decided already/);

    const out = await setup(false);
    const t = out.session("任务");
    expect((await out.tool(t.id, "team_ask", { to: "程序老李", title: "x", body: "y" })).text).toContain("在 AMO 平台里登录");
  });

  it("with 不用先问我 on (设置 → 功能 → 中转) it goes at once; 远程 being off does not stop 中转 (2026-10-30)", async () => {
    const { service, told, session, coderClient, tool } = await setup();
    // 远程 is off (never turned on here): 中转 only uses the same login.
    expect(service.remote.state().connection.state).toBe("disabled");
    expect(service.config.settings().teamAutoSend).toBe(false);
    service.config.updateSettings({ teamAutoSend: true });
    const s = session("任务");
    const asked = await tool(s.id, "team_ask", { to: "程序老李", title: "接口确认", body: "要加字段", questions: [{ text: "加不加", options: ["加", "不加"] }] });
    expect(asked.error).toBe(false);
    expect(asked.text).toContain("已发给 程序老李");
    expect(service.teamRelay.sends()).toEqual([expect.objectContaining({ state: "sent", sessionId: s.id })]);
    const [thread] = await coderClient.threads();
    expect(thread?.request).toMatchObject({ from: "策划小王", to: "程序老李", byAi: true });
    // A follow-up goes at once too (here it cannot: the session is closed); a failure is the tool's answer, not a
    // message into the session.
    await service.teamRelay.done(s.id, { threadId: thread!.id });
    const failed = await tool(s.id, "team_followup", { threadId: thread!.id, body: "再问" });
    expect(failed).toMatchObject({ error: true });
    expect(failed.text).toContain("没发给 程序老李");
    expect(told).toEqual([]);
    expect(() => service.config.updateSettings({ teamAutoSend: "yes" as never })).toThrow(/teamAutoSend/);
  });
});
