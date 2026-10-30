import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DutyRun, ModelProfile } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

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
  return { service, store, duty: service.duty };
}

const lastRun = (runs: DutyRun[], itemId: string) => runs.find((r) => r.itemId === itemId);

describe("值守", () => {
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
