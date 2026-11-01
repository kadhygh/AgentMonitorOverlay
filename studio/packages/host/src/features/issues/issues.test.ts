import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProfile } from "@amo-studio/protocol";
import { saveAccount, type Protector } from "@amo-studio/account";
import { RelayClient, RelayStore, startRelayServer } from "@amo-studio/relay";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { amoToolsFor } from "../../mcp/tools.js";
import { Backoff } from "../remote/link.js";

// 问题页 ↔ 会话 (2026-10-31, plans/issues.md stage 3), against a relay service on this machine (never the team server):
// a session lists the person's issues, reads one with its screenshot as a local file, takes it, answers with a
// screenshot of its own, and marks what a test build fixed — each entry the AI's, as the person's account.

const fake: Protector = {
  protect: async (t) => Buffer.from(`enc:${t}`).toString("base64"),
  unprotect: async (d) => Buffer.from(d, "base64").toString().slice(4),
};
const PROFILES: ModelProfile[] = [{ id: "p", label: "P", runtime: "codex", provider: "x", model: "m" }];
// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const tempDir = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `amo-issues-${name}-`));
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
  const relay = await startRelayServer({ store: relayStore, filesDir: tempDir("files"), host: "127.0.0.1", port: 0 });
  cleanups.push(() => relayStore.close());
  cleanups.push(() => relay.close());
  const me = relayStore.register("戴", "pw-aaaa");
  const home = tempDir("home");
  const env = { AMO_HOME: home, COMPUTERNAME: "DEV-PC" };
  if (signedIn) await saveAccount({ server: relay.url, name: "戴", key: me.key }, { env, protector: fake });
  const root = tempDir("data");
  const store = new Store(join(root, "studio.db"));
  const servers = new FakeServers(PROFILES);
  const service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  service.remote.start({ env, protector: fake, watchMs: 30, backoff: new Backoff({ baseMs: 30, maxMs: 120 }) });
  cleanups.push(async () => {
    service.remote.stop();
    await servers.close();
    store.close();
  });
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const t = amoToolsFor(service, { sessionId: "s-x" } as never).find((x) => x.name === name)!;
    const out = await t.run(args);
    const text = out.content.map((c) => c.text).join("");
    return { text, error: !!out.isError, value: out.isError ? null : (JSON.parse(text) as Record<string, any>) };
  };
  if (signedIn) await until(() => service.remote.teamLogin(), (l) => !!l, "the platform's login");
  return { tool, page: new RelayClient(relay.url, me.key), root, service };
}

describe("问题页 tools", () => {
  it("list, read with screenshots, take, answer with a picture, release", async () => {
    const { tool, page, root } = await setup();
    // The person reports two issues on the page, one with a screenshot; one of them is closed.
    const shot = await page.uploadIssueImage("bug.png", PNG, "image/png");
    await page.createIssue({ title: "输入栏没缓存", body: "切走再回来，写了一半的话没了", tool: "studio", version: "0.9.16", images: [shot.id] });
    const old = await page.createIssue({ body: "旧问题" });
    await page.updateIssue(old.number, { status: "closed" });

    const list = (await tool("issue_list")).value!;
    expect(list.issues.map((i: { number: number }) => i.number)).toEqual([1]);
    expect(list.issues[0]).toMatchObject({ title: "输入栏没缓存", status: "new", statusLabel: "新", tool: "studio", version: "0.9.16", awaitsAi: true });
    expect((await tool("issue_list", { all: true })).value!.issues).toHaveLength(2);

    const one = (await tool("issue_get", { number: 1 })).value!;
    const image = one.entries[0].images[0];
    expect(image.path).toBe(join(root, "issue-images", `${shot.id}.png`));
    expect(readFileSync(image.path)).toEqual(PNG);

    // Take it, then answer with a screenshot and 已修好.
    expect((await tool("issue_update", { number: 1, status: "working", worker: "Opus 5.5 · 任务「问题 #1」" })).value).toMatchObject({ status: "working", worker: "Opus 5.5 · 任务「问题 #1」" });
    const mine = join(root, "after.png");
    writeFileSync(mine, PNG);
    const answered = (await tool("issue_reply", { number: 1, body: "修好了：输入栏按任务存草稿", status: "fixed", images: [mine] })).value!;
    expect(answered).toMatchObject({ status: "fixed", awaitsAi: false });
    const back = await page.issue(1);
    const last = back.entries!.at(-1)!;
    expect(last).toMatchObject({ ai: true, author: "戴", body: "修好了：输入栏按任务存草稿" });
    expect(last.images).toHaveLength(1);
    expect(back.entries!.filter((e) => e.kind === "status" && e.ai)).toHaveLength(1);

    // Refusals the agent can read.
    expect(await tool("issue_reply", { number: 1, images: ["relative.png"] })).toMatchObject({ error: true, text: expect.stringContaining("完整路径") });
    expect(await tool("issue_reply", { number: 1, images: [join(root, "studio.db")] })).toMatchObject({ error: true, text: expect.stringContaining("只能传图片") });
    expect(await tool("issue_get", { number: 99 })).toMatchObject({ error: true });
    expect(await tool("issue_update", { number: 1 })).toMatchObject({ error: true, text: expect.stringContaining("没有要改的") });

    // 发布打包 asked on the page; the build goes out.
    expect((await page.requestIssueRelease()).requestedBy).toBe("戴");
    expect((await tool("issue_list")).value!.release.requestedAt).toEqual(expect.any(Number));
    const released = (await tool("issue_released", { version: "Studio 0.9.17", numbers: [1] })).value!;
    expect(released).toMatchObject({ released: [1], release: { requestedAt: null, last: { version: "Studio 0.9.17" } } });
    expect(await page.issue(1)).toMatchObject({ status: "released", fixedIn: "Studio 0.9.17" });
  });

  it("值守's check: new issues, the person's answers, a test build that failed — nothing otherwise", async () => {
    const { service, page } = await setup();
    const issues = service.issues;
    expect(await issues.pending()).toBeNull();
    await page.createIssue({ title: "输入栏没缓存", body: "x" });
    await page.createIssue({ title: "列表断开", body: "y" });
    expect(await issues.pending()).toBe("新问题：#1 输入栏没缓存；#2 列表断开");

    // The AI takes #1 and asks; fixes #2. Nothing to do until the person answers.
    await issues.reply(1, { body: "哪个输入栏？", status: "asking" });
    await issues.reply(2, { body: "修好了", status: "fixed" });
    expect(await issues.pending()).toBeNull();
    await page.addIssueEntry(1, { body: "新建任务页那个" });
    expect(await issues.pending()).toBe("你回复了：#1 输入栏没缓存（需要确认，第 3 条）");
    await issues.reply(1, { body: "明白了" });
    expect(await issues.pending()).toBeNull();
    // 去会话讨论 (2026-10-31 晚) is the person's only: the AI cannot set it, and 值守 leaves it alone, answers included,
    // until the person hands it back.
    await expect(issues.reply(1, { body: "这个牵涉缓存的整体设计", status: "discuss" })).rejects.toThrow("只由人在问题页上点");
    await page.updateIssue(1, { status: "discuss" });
    await page.addIssueEntry(1, { body: "我在 Studio 里和它谈" });
    expect(await issues.pending()).toBeNull();
    await page.updateIssue(1, { status: "working" });
    expect(await issues.pending()).toBe("你回复了：#1 输入栏没缓存（修复中，第 7 条）");
    await issues.reply(1, { body: "好", status: "working" });
    expect(await issues.pending()).toBeNull();

    // Builds go out by themselves (2026-11-01): fixed ones and 发布打包 are the script's; a failed build is 值守's.
    await page.requestIssueRelease();
    expect(await issues.pending()).toBeNull();
    await page.reportIssueBuild({ start: { label: "AMO Studio 0.9.25", steps: ["类型检查", "单测", "打包"] } });
    await page.reportIssueBuild({ step: 1 });
    expect(await issues.pending()).toBeNull();
    await page.reportIssueBuild({ end: { ok: false, message: "单测有 1 个没过" } });
    expect(await issues.pending()).toBe("上一次打测试包没成功（AMO Studio 0.9.25，停在「单测」：单测有 1 个没过）");
    expect(await issues.pendingWork()).toMatchObject({ title: "打包没成功" });
    await page.reportIssueBuild({ start: { label: "AMO Studio 0.9.25", steps: ["打包"] } });
    await page.reportIssueBuild({ end: { ok: true, message: "已发到测试通道" } });
    expect(await issues.pending()).toBeNull();
    // Registered as 值守's check.
    expect(service.duty.state().checks.map((c) => c.name)).toContain("issues.pending");
  });

  it("值守's check names the session after the first issue, and gives back the session that took an answered issue", async () => {
    const { service, page } = await setup();
    const store = service.store;
    const ws = service.commonWorkspace();
    const task = store.createTask({ title: "10-31维护", workspaceId: ws.id });
    const session = (title: string) => store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "p", workspaceId: ws.id, title, status: "idle", writer: "workbench", runtimeRef: null });
    const a = session("a");
    const b = session("b");
    const tool = (sessionId: string, name: string, args: Record<string, unknown>) => amoToolsFor(service, { sessionId } as never).find((x) => x.name === name)!.run(args);
    await page.createIssue({ title: "远程任务里，控制端按@什么都出不来，按说也应该能at出被控端的模板", body: "x" });
    await page.createIssue({ title: "列表断开", body: "y" });
    expect(await service.issues.pendingWork()).toEqual({ text: expect.stringContaining("新问题：#1"), title: "#1 远程任务里，控制端按@什么都出不来，按说也应该能at出被控端…" });

    // a takes #1 and asks; b takes #2 and asks.
    await tool(a.id, "issue_update", { number: 1, status: "working" });
    await tool(a.id, "issue_reply", { number: 1, body: "哪个输入框？", status: "asking" });
    await tool(b.id, "issue_reply", { number: 2, body: "哪个列表？", status: "asking" });
    // On the page too, to copy into Studio's search.
    expect((await page.issue(1)).session).toBe(a.id);
    expect(JSON.parse((await tool(a.id, "issue_list", {})).content.map((c) => c.text).join("")).issues).toContainEqual(expect.objectContaining({ number: 1, session: a.id }));
    await page.addIssueEntry(1, { body: "新建任务页那个" });
    expect(await service.issues.pendingWork()).toMatchObject({ text: expect.stringContaining("你回复了：#1"), title: expect.stringMatching(/^#1 /), sessionId: a.id });
    // Answers on issues two sessions took, or a new issue beside: no one session to go on in.
    await page.addIssueEntry(2, { body: "任务列表" });
    expect(await service.issues.pendingWork()).not.toHaveProperty("sessionId");
    await tool(b.id, "issue_reply", { number: 2, body: "明白了", status: "working" });
    await page.createIssue({ title: "第三个", body: "z" });
    expect(await service.issues.pendingWork()).not.toHaveProperty("sessionId");
  });

  it("says to sign in on the platform when there is no login", async () => {
    const { tool, service } = await setup(false);
    expect(await tool("issue_list")).toMatchObject({ error: true, text: "要先在 AMO 平台里登录团队服务器，才能读写问题页。" });
    await expect(service.issues.pending()).rejects.toThrow("要先在 AMO 平台里登录");
  });
});
