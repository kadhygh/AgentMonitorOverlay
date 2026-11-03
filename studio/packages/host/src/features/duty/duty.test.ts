import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DutyRun, ModelProfile } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { amoToolsFor } from "../../mcp/tools.js";

// 值守 (2026-10-31, plans/issues.md): items run at their times, once at a time — a command, a session (its run lasts
// as long as the session works), one of Studio's jobs — and a used-up subscription takes the fallback model or skips.

const PROFILES: ModelProfile[] = [
  { id: "p", label: "P", runtime: "codex", provider: "x", model: "m" },
  { id: "q", label: "Q", runtime: "codex", provider: "x", model: "n" },
];

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, what = "condition", ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "amo-duty-"));
  cleanups.push(() => removeTempDir(root));
  const store = new Store(join(root, "studio.db"));
  const servers = new FakeServers(PROFILES);
  const service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  cleanups.push(async () => {
    service.duty.stop();
    await servers.close();
    store.close();
  });
  return { service, store, duty: service.duty, root };
}

const lastRun = (runs: DutyRun[], itemId: string) => runs.find((r) => r.itemId === itemId);

// Items here run real commands (`node -e …`), several in a row in some tests: a busy machine (the full suite at low
// priority) takes more than vitest's 5 s for them, so the tests get as long as `until` waits (2026-11-03).
describe("值守", { timeout: 30_000 }, () => {
  it("runs a command when it is due, once at a time, and keeps its last line", async () => {
    const { duty } = setup();
    let now = Date.parse("2026-10-31T10:00:00Z");
    duty.now = () => now;
    const id = duty.create({ title: "说一声", enabled: true, schedule: { every: 60 }, action: { kind: "command", command: `node -e "console.log('first'); console.log('值守好了')"` } }).items[0]!.id;
    expect(duty.state().next[id]).toBe(new Date(now + 60_000).toISOString());
    duty.tick();
    expect(duty.state().running).toEqual([]);
    now += 61_000;
    duty.tick();
    expect(duty.state().running).toEqual([id]);
    expect(() => duty.runNow(id)).toThrow("正在运行");
    const run = await until(() => lastRun(duty.runs(), id), (r) => r?.ok !== null, "the command");
    expect(run).toMatchObject({ ok: true, summary: "完成：值守好了" });
    // Not due again until a minute after this start.
    duty.tick();
    expect(duty.state().running).toEqual([]);
    expect(duty.state().next[id]).toBe(new Date(Date.parse(run!.startedAt) + 60_000).toISOString());

    const bad = duty.create({ title: "会失败", enabled: false, schedule: { every: 60 }, action: { kind: "command", command: `node -e "process.exit(3)"` } }).items[1]!.id;
    duty.runNow(bad);
    expect(await until(() => lastRun(duty.runs(), bad), (r) => r?.ok !== null, "the failing command")).toMatchObject({ ok: false, summary: "退出码 3" });
  });

  it("a session item makes a task each time and its run lasts until the session stops", async () => {
    const { duty, store } = setup();
    const id = duty.create({ title: "问题页", enabled: false, schedule: { every: 30 }, action: { kind: "session", profileId: "p", prompt: "看一下有没有新问题", taskTitle: "处理问题", options: { model: "m2", permission: "full", effort: "" } } }).items[0]!.id;
    duty.runNow(id);
    const run = await until(
      () => {
        duty.tick();
        return lastRun(duty.runs(), id);
      },
      (r) => r?.ok !== null,
      "the session's run",
    );
    expect(run).toMatchObject({ ok: true, summary: "会话这一轮结束了" });
    const task = store.getTask(run!.taskId!)!;
    expect(task.title).toMatch(/^处理问题 · \d\d-\d\d \d\d:\d\d$/);
    expect(store.getSession(run!.sessionId!)!.profileId).toBe("p");
    // The item's model and permissions (an unattended run should not stop to ask); empty ones are left out.
    expect(duty.items()[0]!.action).toMatchObject({ options: { model: "m2", permission: "full" } });
    expect(store.getSession(run!.sessionId!)!.options).toMatchObject({ model: "m2", permission: "full" });
  });

  it("a used-up subscription takes the fallback model, or skips the run", async () => {
    const { duty, service, store } = setup();
    vi.spyOn(service.runtime, "usage").mockImplementation(async (profileId) => ({ profileId, label: profileId.toUpperCase(), windows: [{ label: "5 小时", usedPercent: profileId === "p" ? 99 : 10, resetsAt: null }], note: null, updatedAt: null }));
    const id = duty.create({ title: "修", enabled: false, schedule: { every: 30 }, action: { kind: "session", profileId: "p", fallbackProfileId: "q", prompt: "修一下", options: { model: "m2" } } }).items[0]!.id;
    duty.runNow(id);
    const started = await until(() => lastRun(duty.runs(), id), (r) => !!r?.sessionId, "the session");
    expect(started!.summary).toContain("P「5 小时」已用 99%，改用 Q");
    expect(store.getSession(started!.sessionId!)!.profileId).toBe("q");
    expect(store.getSession(started!.sessionId!)!.options).toEqual({});
    await until(
      () => {
        duty.tick();
        return lastRun(duty.runs(), id);
      },
      (r) => r?.ok !== null,
      "the run's end",
    );

    duty.update(id, { action: { kind: "session", profileId: "p", prompt: "修一下" } });
    duty.runNow(id);
    expect(await until(() => lastRun(duty.runs(), id), (r) => r?.ok !== null && !r?.sessionId, "the skip")).toMatchObject({ ok: true, skipped: true, summary: "额度快用完了（P「5 小时」已用 99%），这次跳过" });
  });

  it("a session item checks first: nothing found, no model; a finding starts one with it; the same finding not again", async () => {
    const { duty, store } = setup();
    const dir = mkdtempSync(join(tmpdir(), "amo-duty-check-"));
    cleanups.push(() => removeTempDir(dir));
    const found = join(dir, "found.txt");
    // The check prints what the file holds (nothing while it is empty) and fails when the file says "fail".
    const check = `node -e "const t=require('fs').readFileSync(process.argv[1],'utf8'); if(t==='fail') process.exit(2); process.stdout.write(t)" "${found}"`;
    writeFileSync(found, "");
    const id = duty.create({ title: "问题页", enabled: false, schedule: { every: 30 }, action: { kind: "session", profileId: "p", prompt: "照模板做", check: { kind: "command", command: check } } }).items[0]!.id;
    const once = async (what: string) => {
      duty.runNow(id);
      return until(
        () => {
          duty.tick();
          return lastRun(duty.runs(), id);
        },
        (r) => r?.ok !== null,
        what,
      );
    };
    expect(await once("an empty check")).toMatchObject({ ok: true, skipped: true, summary: "检查过了，没有要做的" });
    expect(store.listTasks()).toHaveLength(0);

    writeFileSync(found, "新问题：#1 输入栏没缓存");
    const run = await once("a finding");
    expect(run).toMatchObject({ ok: true, summary: "会话这一轮结束了" });
    expect(store.listItems(run!.sessionId!).find((i) => i.type === "user")).toMatchObject({ text: "照模板做\n\n值守检查发现：\n新问题：#1 输入栏没缓存" });
    expect(await once("the same finding")).toMatchObject({ ok: true, skipped: true, summary: "检查结果和上次开会话时一样，不再开" });

    writeFileSync(found, "fail");
    expect(await once("a failing check")).toMatchObject({ ok: false, summary: "检查没跑通：退出码 2" });
    // Nothing for a while, then the same finding again: it is new again.
    writeFileSync(found, "");
    await once("nothing");
    writeFileSync(found, "新问题：#1 输入栏没缓存");
    expect((await once("the finding back"))?.sessionId).toBeTruthy();

    duty.registerCheck({ name: "x.pending", label: "X", description: "看 X", run: async () => null });
    expect(duty.state().checks).toContainEqual({ name: "x.pending", label: "X", description: "看 X" });
    expect(() => duty.update(id, { action: { kind: "session", profileId: "p", prompt: "x", check: { kind: "builtin", name: "nope" } } })).toThrow("没有这个 Studio 检查");
    duty.update(id, { action: { kind: "session", profileId: "p", prompt: "x", check: { kind: "builtin", name: "x.pending" } } });
    expect(await once("a builtin check")).toMatchObject({ skipped: true, summary: "检查过了，没有要做的" });

    // Several (the day's 维护: 问题页 and what is due for release): what they found together; one failing beside a
    // finding is said under it; all failing fails the run.
    let issues: string | null = "新问题：#2 列表断开";
    duty.registerCheck({ name: "y.pending", label: "问题页", description: "看问题页", run: async () => issues });
    expect(() => duty.update(id, { action: { kind: "session", profileId: "p", prompt: "x", check: { kind: "all", checks: [] } } })).toThrow("1 到 5 样");
    writeFileSync(found, "该发布：AMO 便签（notes）");
    duty.update(id, { action: { kind: "session", profileId: "p", prompt: "维护", check: { kind: "all", checks: [{ kind: "builtin", name: "y.pending" }, { kind: "command", command: check }] } } });
    const both = await once("two findings");
    expect(store.listItems(both!.sessionId!).find((i) => i.type === "user")).toMatchObject({ text: "维护\n\n值守检查发现：\n新问题：#2 列表断开\n\n该发布：AMO 便签（notes）" });
    writeFileSync(found, "fail");
    issues = "新问题：#3 便签闪退";
    const half = await once("one failing beside a finding");
    expect(store.listItems(half!.sessionId!).find((i) => i.type === "user")).toMatchObject({ text: expect.stringContaining("新问题：#3 便签闪退\n\n（没跑通的检查：「node -e") });
    issues = null;
    duty.registerCheck({ name: "y.pending", label: "问题页", description: "看问题页", run: async () => Promise.reject(new Error("没登录")) });
    expect(await once("both failing")).toMatchObject({ ok: false, summary: expect.stringContaining("检查没跑通：「问题页」没登录；「node -e") });
  });

  it("an agent sets an item up (approved), its session is told to stop it, and duty_stop turns it off", async () => {
    const { service, duty, store, root } = setup();
    mkdirSync(join(root, "alpha"));
    const alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
    const task = store.createTask({ title: "盯构建", workspaceId: alpha.id });
    const asking = store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "q", workspaceId: alpha.id, title: "", status: "idle", writer: "workbench", runtimeRef: null });
    const tool = async (sessionId: string, name: string, args: Record<string, unknown> = {}) => {
      const t = amoToolsFor(service, { sessionId } as never).find((x) => x.name === name)!;
      const out = await t.run(args);
      const text = out.content.map((c) => c.text).join("");
      return { tool: t, error: !!out.isError, text, value: out.isError ? null : (JSON.parse(text) as Record<string, any>) };
    };
    writeFileSync(join(root, "alpha", "check.js"), "console.log('构建失败：3 个测试没过')");
    const saved = await tool(asking.id, "duty_save", { title: "盯构建", schedule: { every: 1800 }, action: { kind: "session", prompt: "看看为什么失败", untilDone: true, check: { kind: "command", command: "node check.js" } } });
    // Saving waits for the person; turning off and listing do not.
    expect(saved.tool.autoApprove).toBe(false);
    expect((await tool(asking.id, "duty_stop")).tool.autoApprove).toBe(true);
    // Defaults: the caller's model, its own task, its project's folder for the check.
    const item = saved.value!.item;
    expect(item).toMatchObject({ enabled: true, by: "agent", setBy: asking.id, schedule: { every: 1800 }, action: { kind: "session", profileId: "q", taskId: task.id, untilDone: true, check: { kind: "command", command: "node check.js", workspaceId: alpha.id } } });
    expect((await tool(asking.id, "duty_list")).value!.items[0]).toMatchObject({ id: item.id, nextRun: expect.any(String) });
    // Not started by 值守: duty_stop wants an id.
    expect(await tool(asking.id, "duty_stop")).toMatchObject({ error: true, text: expect.stringContaining("不是值守开的") });

    duty.runNow(item.id);
    const run = await until(() => lastRun(duty.runs(), item.id), (r) => !!r?.sessionId, "the session");
    expect(store.getSession(run!.sessionId!)!.taskId).toBe(task.id);
    // Kept for the marks in the session list, past the item's last few runs.
    expect(duty.state().sessions).toEqual({ [run!.sessionId!]: item.id });
    const said = store.listItems(run!.sessionId!).find((i) => i.type === "user");
    expect(said).toMatchObject({ text: expect.stringContaining("值守检查发现：\n构建失败：3 个测试没过") });
    expect(said).toMatchObject({ text: expect.stringContaining("调 AMO 的 duty_stop 关掉它") });
    // The session it started stops it without an id.
    expect((await tool(run!.sessionId!, "duty_stop")).value!.item).toMatchObject({ id: item.id, enabled: false });
    // The person's own edit clears the mark; turning it on alone keeps it.
    duty.update(item.id, { enabled: true });
    expect(duty.items()[0]!.by).toBe("agent");
    duty.update(item.id, { title: "盯构建（人改的）" });
    expect(duty.items()[0]).not.toHaveProperty("by");
    expect(duty.items()[0]).not.toHaveProperty("setBy");

    // The day's 维护 task, its 值守 working in another folder (the 值守 directory): named like session_start's
    // workspace; the check runs there too; the session stays the task's.
    mkdirSync(join(root, "beta"));
    const beta = store.addWorkspace({ path: join(root, "beta"), name: "beta（值守目录）" });
    writeFileSync(join(root, "beta", "check.js"), "console.log('该发布：便签')");
    const there = (await tool(asking.id, "duty_save", { title: "维护", schedule: { every: 1800 }, action: { kind: "session", prompt: "发布", workspace: "beta（值守目录）", permission: "read-only", check: { kind: "command", command: "node check.js" } } })).value!.item;
    // permission as session_start names it, made the model's own.
    expect(there.action).toMatchObject({ profileId: "q", options: { permission: "read-only" }, taskId: task.id, workspaceId: beta.id, check: { workspaceId: beta.id } });
    expect(there.action.permission).toBeUndefined();
    expect(await tool(asking.id, "duty_save", { title: "x", schedule: { every: 60 }, action: { kind: "session", prompt: "x", permission: "root" } })).toMatchObject({ error: true, text: expect.stringContaining("permission must be one of") });
    expect(there.action.workspace).toBeUndefined();
    duty.runNow(there.id);
    const r2 = await until(() => lastRun(duty.runs(), there.id), (r) => !!r?.sessionId, "the session in beta");
    expect(store.getSession(r2!.sessionId!)).toMatchObject({ taskId: task.id, workspaceId: beta.id });
    expect(store.listItems(r2!.sessionId!).find((i) => i.type === "user")).toMatchObject({ text: expect.stringContaining("你在项目「beta（值守目录）」的文件夹") });
  });

  it("a finding names its session, which is shown under the one that set the item up; an answer goes on in the session that took it", async () => {
    const { service, duty, store, root } = setup();
    mkdirSync(join(root, "alpha"));
    const alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
    const task = store.createTask({ title: "10-31维护", workspaceId: alpha.id });
    const setter = store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "p", workspaceId: alpha.id, title: "开始维护", status: "idle", writer: "workbench", runtimeRef: null });
    let finding: { text: string; sessionId?: string; title?: string } | null = { text: "新问题：#1 输入栏没缓存", title: "#1 输入栏没缓存" };
    duty.registerCheck({ name: "z.pending", label: "问题页", description: "看问题页", run: async () => finding });
    const t = amoToolsFor(service, { sessionId: setter.id } as never).find((x) => x.name === "duty_save")!;
    const item = JSON.parse((await t.run({ title: "AMO 维护", schedule: { every: 60 }, action: { kind: "session", prompt: "照模板做", check: { kind: "builtin", name: "z.pending" } } })).content.map((c) => c.text).join("")).item;
    duty.update(item.id, { enabled: false });
    const once = async (what: string) => {
      duty.runNow(item.id);
      return until(
        () => {
          duty.tick();
          return lastRun(duty.runs(), item.id);
        },
        (r) => r?.ok !== null,
        what,
      );
    };
    const first = await once("the first session");
    expect(first).toMatchObject({ ok: true, taskId: task.id });
    expect(store.getSession(first!.sessionId!)).toMatchObject({ taskId: task.id, title: "#1 输入栏没缓存", startedBy: setter.id });
    expect(store.listSessions({ taskId: task.id })).toHaveLength(2);

    // The person answered on the issue that session took: the same session goes on, no new one.
    const before = store.listItems(first!.sessionId!).filter((i) => i.type === "agent").length;
    finding = { text: "你回复了：#1 输入栏没缓存（等你回答，第 3 条）", sessionId: first!.sessionId!, title: "#1 输入栏没缓存" };
    const again = await once("the answer");
    expect(again).toMatchObject({ ok: true, sessionId: first!.sessionId, summary: "会话这一轮结束了" });
    expect(store.listSessions({ taskId: task.id })).toHaveLength(2);
    expect(store.listItems(first!.sessionId!).filter((i) => i.type === "user").at(-1)).toMatchObject({ text: "照模板做\n\n值守检查发现：\n你回复了：#1 输入栏没缓存（等你回答，第 3 条）" });
    // It waited for the new reply, not the old one.
    expect(store.listItems(first!.sessionId!).filter((i) => i.type === "agent").length).toBeGreaterThan(before);

    // A session this item did not start (or one archived) is not gone on in: a new one.
    finding = { text: "你回复了：#1 输入栏没缓存（等你回答，第 5 条）", sessionId: setter.id, title: "#1 输入栏没缓存" };
    const fresh = await once("someone else's session");
    expect(fresh!.sessionId).not.toBe(setter.id);
    expect(fresh!.sessionId).not.toBe(first!.sessionId);
    expect(store.listSessions({ taskId: task.id })).toHaveLength(3);
  });

  it("a command that prints AMO_DUTY_DONE turns its item off: a command item, a check with or without a finding", async () => {
    const { duty } = setup();
    const done = (id: string, what: string) => {
      duty.runNow(id);
      return until(
        () => {
          duty.tick();
          return lastRun(duty.runs(), id);
        },
        (r) => r?.ok !== null,
        what,
      );
    };
    const cmd = duty.create({ title: "等文件", enabled: true, schedule: { every: 60 }, action: { kind: "command", command: `node -e "console.log('到了'); console.log('AMO_DUTY_DONE')"` } }).items[0]!.id;
    expect(await done(cmd, "the command")).toMatchObject({ ok: true, summary: "完成，值守已关掉：到了" });
    expect(duty.items().find((i) => i.id === cmd)!.enabled).toBe(false);

    const quiet = duty.create({ title: "没事了", enabled: true, schedule: { every: 60 }, action: { kind: "session", profileId: "p", prompt: "x", check: { kind: "command", command: `node -e "console.log('AMO_DUTY_DONE')"` } } }).items[1]!.id;
    expect(await done(quiet, "a check that ends it")).toMatchObject({ ok: true, skipped: true, summary: "检查说不用再值守了，已关掉" });
    expect(duty.items().find((i) => i.id === quiet)!.enabled).toBe(false);

    const last = duty.create({ title: "最后一次", enabled: true, schedule: { every: 60 }, action: { kind: "session", profileId: "p", prompt: "x", check: { kind: "command", command: `node -e "console.log('最后一个问题'); console.log('AMO_DUTY_DONE')"` } } }).items[2]!.id;
    const run = await done(last, "a last finding");
    expect(run).toMatchObject({ ok: true, sessionId: expect.any(String) });
    expect(duty.items().find((i) => i.id === last)!.enabled).toBe(false);
  });

  it("a feature's job ships its item off; it can be turned on and timed, not removed or changed", async () => {
    const { duty } = setup();
    let calls = 0;
    duty.register({ name: "issues.poll", label: "问题页", description: "看服务器上有没有新问题", item: { id: "duty_issues", title: "问题页：看新问题", schedule: { every: 30 } }, run: async () => ({ ok: true, summary: `看了 ${++calls} 次` }) });
    duty.register({ name: "issues.poll", label: "问题页", description: "看服务器上有没有新问题", item: { id: "duty_issues", title: "问题页：看新问题", schedule: { every: 30 } }, run: async () => ({ ok: true, summary: `看了 ${++calls} 次` }) });
    expect(duty.items()).toMatchObject([{ id: "duty_issues", enabled: false, builtin: true, action: { kind: "builtin", name: "issues.poll" } }]);
    expect(duty.state().builtins).toEqual([{ name: "issues.poll", label: "问题页", description: "看服务器上有没有新问题" }]);
    expect(() => duty.remove("duty_issues")).toThrow("不能删");
    expect(() => duty.update("duty_issues", { action: { kind: "command", command: "x" } })).toThrow("只能开关、改时间");
    duty.update("duty_issues", { enabled: true, schedule: { every: 15 } });
    duty.runNow("duty_issues");
    expect(await until(() => lastRun(duty.runs(), "duty_issues"), (r) => r?.ok !== null, "the job")).toMatchObject({ ok: true, summary: "看了 1 次" });
  });

  it("an item hangs under another: one level, on only with its parent on, off with it; removing the parent frees it (2026-11-01)", () => {
    const { duty } = setup();
    const cmd = { kind: "command" as const, command: `node -e "0"` };
    const parent = duty.create({ title: "日常值守", enabled: true, schedule: { every: 60 }, action: cmd }).items[0]!.id;
    const child = duty.create({ title: "自动打包", enabled: true, schedule: { every: 60 }, action: cmd, parentId: parent }).items[1]!.id;
    const other = duty.create({ title: "别的", enabled: false, schedule: { every: 60 }, action: cmd }).items[2]!.id;
    const item = (id: string) => duty.items().find((i) => i.id === id)!;
    expect(item(child)).toMatchObject({ parentId: parent, enabled: true });
    // One level, not itself.
    expect(() => duty.update(other, { parentId: child })).toThrow("只能挂一层");
    expect(() => duty.update(parent, { parentId: other })).toThrow("下面已经挂着别的");
    expect(() => duty.update(other, { parentId: other })).toThrow("自己下面");
    expect(() => duty.update(other, { parentId: "duty-gone" })).toThrow("不在了");
    // The parent off: the child with it (an agent's duty_stop too); the child does not come back on by itself.
    duty.turnOff(parent);
    expect(item(child).enabled).toBe(false);
    expect(() => duty.update(child, { enabled: true })).toThrow("先开它");
    expect(() => duty.create({ title: "也挂上", enabled: true, schedule: { every: 60 }, action: cmd, parentId: parent })).toThrow("先开它");
    duty.update(parent, { enabled: true });
    expect(item(child).enabled).toBe(false);
    duty.update(child, { enabled: true });
    expect(item(child).enabled).toBe(true);
    // Taken off its parent; put back; the parent removed: the child stays, on its own.
    duty.update(child, { parentId: null });
    expect(item(child).parentId).toBeUndefined();
    duty.update(child, { parentId: parent });
    duty.remove(parent);
    expect(item(child)).toMatchObject({ enabled: true });
    expect(item(child).parentId).toBeUndefined();
  });

  it("times: every so many seconds or a daily time; bad ones are refused; a run left going by the last Host is closed", () => {
    const { duty, store } = setup();
    expect(() => duty.create({ title: "太快", schedule: { every: 3 }, action: { kind: "command", command: "x" } })).toThrow("至少 10 秒");
    expect(() => duty.create({ title: "错时间", schedule: { daily: "25:00" }, action: { kind: "command", command: "x" } })).toThrow("HH:MM");
    expect(() => duty.create({ title: "没命令", schedule: { every: 60 }, action: { kind: "command", command: " " } })).toThrow("要写命令");
    expect(() => duty.create({ title: "x", schedule: { every: 60 }, action: { kind: "session", profileId: "nope", prompt: "x" } })).toThrow();

    const base = new Date(2026, 9, 31, 10, 0, 0).getTime();
    duty.now = () => base;
    const item = duty.create({ title: "夜里", schedule: { daily: "2:00" }, action: { kind: "command", command: "echo" } }).items[0]!;
    expect(item.schedule).toEqual({ daily: "02:00" });
    expect(duty.nextRun(item)).toBe(new Date(2026, 10, 1, 2, 0, 0).getTime());

    store.setKv("duty.runs", JSON.stringify([{ itemId: item.id, startedAt: new Date(base).toISOString(), endedAt: null, ok: null, summary: "运行中…" }]));
    duty.start();
    expect(duty.runs()[0]).toMatchObject({ ok: false, summary: "Studio 重启了，没等到这次结束" });
  });
});
