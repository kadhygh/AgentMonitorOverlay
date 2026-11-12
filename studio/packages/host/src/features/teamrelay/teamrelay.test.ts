import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostEvent, ModelProfile, Session } from "@amo-studio/protocol";
import { saveAccount, type Protector } from "@amo-studio/account";
import { RelayClient, RelayStore, startRelayServer, type RelayServer } from "@amo-studio/relay";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { Backoff } from "../remote/link.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { amoToolsFor } from "../../mcp/tools.js";

// 会话里用中转 (2026-10-30, plans/done/relay-in-sessions.md), against a relay service on this machine (never the team server):
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
  // What goes into sessions (their inbox, 2026-11-04), instead of a model turn; `realInbox` puts the real one back.
  const told: Array<{ sessionId: string; text: string }> = [];
  const inboxPut = service.sessions.inbox.put.bind(service.sessions.inbox);
  service.sessions.inbox.put = async (sessionId: string, text: string) => {
    told.push({ sessionId, text });
    return { delivered: true, waiting: 0 };
  };
  const realInbox = () => (service.sessions.inbox.put = inboxPut);
  const events: HostEvent[] = [];
  service.on("event", (e) => events.push(e));
  // As host-process does (2026-11-05, plans/host-structure.md 8a): the team link, which 中转 speaks through, then 远程
  // (started, but off until turned on).
  service.teamLink.start({ env, protector: fake, watchMs: 30 });
  service.remote.start({ backoff: new Backoff({ baseMs: 30, maxMs: 120 }) });
  service.teamRelay.pauseMs = { signedOut: 50, failed: 100, wait: 400 };
  service.teamRelay.start();
  cleanups.push(async () => {
    service.teamRelay.stop();
    service.remote.stop();
    service.teamLink.stop();
    await servers.close();
    store.close();
  });
  const coderClient = new RelayClient(relay.url, coder.key);
  const tool = async (sessionId: string, name: string, args: Record<string, unknown> = {}) => {
    const t = amoToolsFor(service, { sessionId } as never).find((x) => x.name === name)!;
    const out = await t.run(args);
    return { text: out.content.map((c) => (c.type === "text" ? c.text : "")).join(""), error: !!out.isError, content: out.content };
  };
  await until(() => service.teamLink.login(), (l) => !signedIn || !!l, "the platform's login");
  return { service, store, told, events, session, coderClient, tool, relay, relayStore, root, realInbox, alpha };
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

  it("已接手，不用回复 (2026-11-05): taken on quietly it only shows as taken; with the note ticked for the AI it goes in once; 在 Studio 里打开 names the session", async () => {
    const { service, told, events, session, coderClient, tool } = await setup();
    const asking = session("加特林");
    const ask = async (title: string) => {
      await tool(asking.id, "team_ask", { to: "程序老李", title, body: "做完了，请审。" });
      const pending = service.teamRelay.sends().find((s) => s.title === title && s.state === "pending")!;
      await service.teamRelay.send(pending.id);
      return (await coderClient.threads()).find((t) => t.title === title)!;
    };
    // A review simply accepted: nothing goes into the session; it shows as taken.
    const quiet = await ask("审一下射速");
    await coderClient.session(quiet.id, "take");
    await until(() => service.teamRelay.threads().find((t) => t.threadId === quiet.id), (t) => t?.state === "done" && !!t.takenAt, "taken, as seen");
    await service.teamRelay.scan();
    expect(told).toHaveLength(0);
    expect(service.teamRelay.sessionLines(asking.id)).toContain("程序老李 已接手，不用回复");
    // Ticked: the note goes in, once, and says there is nothing to answer.
    const noted = await ask("审一下过热");
    await coderClient.session(noted.id, "take", { note: "接口我来改，你不用动。", tellAi: true });
    await until(() => told.length, (n) => n > 0, "the note in the session");
    expect(told[0]!.sessionId).toBe(asking.id);
    expect(told[0]!.text).toContain("程序老李 已接手你发的会话「审一下过热」");
    expect(told[0]!.text).toContain("接口我来改，你不用动。");
    expect(told[0]!.text).toContain("不用 team_done");
    await service.teamRelay.scan();
    expect(told).toHaveLength(1);

    // 在 Studio 里打开: the workbench is told which task and session.
    expect(service.teamRelay.openInUi(asking.id)).toEqual({ taskId: asking.taskId, sessionId: asking.id });
    expect(events.find((e) => e.type === "ui.open")).toMatchObject({ type: "ui.open", taskId: asking.taskId, sessionId: asking.id });
    expect(() => service.teamRelay.openInUi("s-nope")).toThrow(/没有会话/);
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

  it("attachments (2026-11-13): the reply lists the session's files, the new ones marked; team_file_get saves one byte for byte, only from the caller's own sessions", async () => {
    const { service, told, session, coderClient, tool, root } = await setup();
    service.config.updateSettings({ teamAutoSend: true });
    const asking = session("过热");
    const other = session("别的任务");
    const doc = join(root, "gatling.md");
    writeFileSync(doc, "# 加特林");
    await tool(asking.id, "team_ask", { to: "程序老李", title: "过热的表现", body: "枪管发红要多红？", files: [doc] });
    await tool(other.id, "team_ask", { to: "程序老李", title: "别的事", body: "另一件", files: [doc] });
    const threads = await coderClient.threads();
    const thread = threads.find((t) => t.title === "过热的表现")!;
    const otherThread = threads.find((t) => t.title === "别的事")!;
    const [otherDoc] = await coderClient.files({ threadId: otherThread.id });

    // The coder answers with a screenshot and a build.
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(30_000)]);
    const zip = randomBytes(200_000);
    const shot = await coderClient.upload({ threadId: thread.id }, "过热截图.png", png, "image/png");
    const build = await coderClient.upload({ threadId: thread.id }, "build.zip", zip, "application/zip");
    await coderClient.send(thread.id, { kind: "reply", body: "看截图。" });
    await until(() => told.length, (n) => n > 0, "the reply in the session");
    const reply = told[0]!.text;
    expect(told[0]!.sessionId).toBe(asking.id);
    expect(reply).toContain("### 会话里的文件（3 个，2 个是你上次发言之后发来的，标了「新」）");
    expect(reply).toContain("team_file_get（threadId, fileId）");
    expect(reply).toMatch(new RegExp(`- 过热截图\\.png v1 · image/png · 30 KB · 程序老李 \\S+ \\S+ 上传 · 新 · fileId ${shot.id}`));
    expect(reply).toMatch(/- gatling\.md v1 · .+ · 策划小王 \S+ \S+ 上传 · fileId /);
    expect((await tool(asking.id, "team_session", { threadId: thread.id })).text).toContain(`fileId ${build.id}`);

    // A picture: saved in the data folder, the same bytes, and as an image; a build: only its path.
    const pic = await tool(asking.id, "team_file_get", { threadId: thread.id, fileId: shot.id });
    expect(pic.error).toBe(false);
    const picPath = join(root, "attachments", "team", shot.id, "过热截图.png");
    expect(pic.text).toContain(`已取下：过热截图.png v1 · image/png · 30 KB · 程序老李 上传\n${picPath}`);
    expect(readFileSync(picPath).equals(png)).toBe(true);
    expect(pic.content.find((c) => c.type === "image")).toMatchObject({ mimeType: "image/png", data: png.toString("base64") });
    const bin = await tool(asking.id, "team_file_get", { threadId: thread.id, fileId: build.id });
    expect(bin.content.map((c) => c.type)).toEqual(["text"]);
    expect(readFileSync(join(root, "attachments", "team", build.id, "build.zip")).equals(zip)).toBe(true);
    expect((await tool(asking.id, "team_file_get", { threadId: thread.id, fileId: shot.id })).text).toContain("已经取过这个文件");

    // Refused: the thread of another session; a file of another thread named with this one; no such file; not an id.
    expect((await tool(other.id, "team_file_get", { threadId: thread.id, fileId: shot.id })).text).toContain("不是你这个会话发的");
    for (const fileId of [otherDoc!.id, "f_0000000000000000", "../../studio.db"]) {
      const refused = await tool(asking.id, "team_file_get", { threadId: thread.id, fileId });
      expect(refused).toMatchObject({ error: true });
      expect(refused.text).toContain("不在中转会话「过热的表现」里");
    }
    expect(existsSync(join(root, "attachments", "team", otherDoc!.id))).toBe(false);

    // Signed out of the platform: says where to sign in.
    const out = await setup(false);
    const t = out.session("任务");
    const signedOut = await out.tool(t.id, "team_file_get", { threadId: thread.id, fileId: shot.id });
    expect(signedOut).toMatchObject({ error: true });
    expect(signedOut.text).toContain("在 AMO 平台里登录");
  });

  it("a reply for a session at work waits in its inbox (shown, not steered in); one that cannot go in is 没送到, and 重新发送 sends it (2026-11-04)", async () => {
    const { service, store, coderClient, tool, realInbox, alpha } = await setup();
    realInbox();
    const task = store.createTask({ title: "背包上限", workspaceId: alpha.id });
    const asking = await service.tasks.addSession(task.id, { profileId: "p" });
    await tool(asking.id, "team_ask", { to: "程序老李", title: "背包上限存哪", body: "打算写死。" });
    await service.teamRelay.send(service.teamRelay.sends()[0]!.id);
    const [thread] = await coderClient.threads();
    // At work (a turn of its own): the reply is shown at once, held until the turn is over.
    store.updateSession(asking.id, { status: "running" });
    await coderClient.send(thread!.id, { kind: "reply", body: "放服务端配置表。" });
    const row = () => store.listItems(asking.id).find((i) => i.type === "user" && i.text.includes("【中转回复】"));
    await until(row, (r) => !!r, "the reply in the session");
    expect(row()).toMatchObject({ delivery: "held" });
    expect((await coderClient.threads())[0]?.request?.pickedAt).not.toBeNull();

    // The turn ends; the runtime fails it once: 没送到 and a line why — not lost after the relay marked it taken.
    const rt = service.runtime as { resend?: (...a: unknown[]) => Promise<unknown> };
    const resend = rt.resend!.bind(rt);
    rt.resend = async () => {
      rt.resend = resend;
      throw new Error("Codex 起不来");
    };
    service.publish({ type: "session.upserted", session: store.updateSession(asking.id, { status: "idle" }) });
    await until(row, (r) => r?.type === "user" && r.delivery === "unsent", "没送到");
    expect(store.listItems(asking.id).some((i) => i.type === "notice" && i.message.includes("Codex 起不来"))).toBe(true);

    // 重新发送: the same row goes in.
    await service.sessions.resend(asking.id, row()!.id);
    await until(row, (r) => r?.type === "user" && r.delivery === undefined, "sent again");
    expect(store.listItems(asking.id).filter((i) => i.type === "user" && i.text.includes("【中转回复】"))).toHaveLength(1);
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
