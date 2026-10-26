import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfile, Session, Task, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

// 开会话 (session_start, 2026-10-22): a session starts another main session in its own task, at once; with report, the
// new session's first finished turn comes back into the caller's conversation.

const PROFILES: ModelProfile[] = [
  { id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" },
  { id: "p-gpt", label: "GPT", runtime: "codex", provider: "amo-gpt", model: "gpt-model" },
  { id: "p-plain", label: "Plain", runtime: "codex", provider: "amo-plain", model: null },
];

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let alpha: Workspace;
let task: Task;
let caller: Session;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-peer-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  mkdirSync(join(root, "alpha"));
  alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
  task = store.createTask({ title: "掉落表", workspaceId: alpha.id });
  caller = await service.tasks.addSession(task.id, { profileId: "p-ds" });
  await service.sessions.renameSession(caller.id, "主会话");
});

afterEach(async () => {
  await servers.close();
  store.close();
  removeTempDir(root);
});

const until = async (pred: () => boolean) => {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(pred()).toBe(true);
};
const userTexts = (sessionId: string) => store.listItems(sessionId).flatMap((i) => (i.type === "user" ? [i.text] : []));

describe("session_start (开会话)", () => {
  it("starts a main session in the caller's task, marked as from it, on the caller's model unless named", async () => {
    const s = await service.sessions.startPeer(caller.id, { text: "只改数值表，别动界面", title: "改数值" });
    expect(s).toMatchObject({ taskId: task.id, kind: "main", parentId: null, startedBy: caller.id, profileId: "p-ds", title: "改数值" });
    expect(store.getSession(s.id)?.startedBy).toBe(caller.id);
    const first = userTexts(s.id)[0]!;
    expect(first).toContain("【由本任务的会话「主会话」开启】");
    expect(first).toContain("只改数值表，别动界面");
    expect(first).toContain(`mailbox_send 给会话 ${caller.id}`);
    expect((await service.sessions.startPeer(caller.id, { text: "看看界面", model: "gpt" })).profileId).toBe("p-gpt");
    // permission: the runtime's own option for the level (Codex: full-auto, read-only); otherwise the model's default.
    expect((await service.sessions.startPeer(caller.id, { text: "跑一串命令", permission: "full" })).options.permission).toBe("full-auto");
    expect((await service.sessions.startPeer(caller.id, { text: "只读看看", permission: "read-only" })).options.permission).toBe("read-only");
    expect(s.options.permission).not.toBe("full-auto");
    // effort (10-26): one the model the session runs takes, as its CLI names it; any other is refused with the list.
    expect((await service.sessions.startPeer(caller.id, { text: "想深一点", model: "Plain", effort: "HIGH" })).options.effort).toBe("high");
    await expect(service.sessions.startPeer(caller.id, { text: "x", model: "Plain", effort: "max" })).rejects.toThrow(/effort 只能是：low, high/);
    // A model its CLI does not know the efforts of (a third-party one): none to pick, as in the workbench.
    await expect(service.sessions.startPeer(caller.id, { text: "x", effort: "high" })).rejects.toThrow(/没有思考强度可选/);
    // A particular model of an account (「@ 开子会话」, 10-26): "<account>/<model>" by id or name; efforts are that model's.
    const slow = await service.sessions.startPeer(caller.id, { text: "慢慢来", model: "Plain/Fake Slow" });
    expect(slow).toMatchObject({ profileId: "p-plain", options: { model: "fake-slow" } });
    await expect(service.sessions.startPeer(caller.id, { text: "x", model: "plain/fake-slow", effort: "high" })).rejects.toThrow(/没有思考强度可选/);
    await expect(service.sessions.startPeer(caller.id, { text: "x", model: "Plain/gpt-9" })).rejects.toThrow(/Plain 没有型号 gpt-9/);
    await expect(service.sessions.startPeer(caller.id, { text: "x", model: "nobody" })).rejects.toThrow(/model nobody not found/);
    await expect(service.sessions.startPeer(caller.id, { text: "x", permission: "root" })).rejects.toThrow(/permission must be/);
    // Archiving the caller leaves the sessions it started alone.
    await service.sessions.archive(caller.id);
    expect(store.getSession(s.id)?.archivedAt).toBeNull();
    // No report asked: nothing comes back into the caller.
    await new Promise((r) => setTimeout(r, 300));
    expect(userTexts(caller.id).some((t) => t.includes("这一轮做完了"))).toBe(false);
  });

  it("forPerson: a session the person works in, beside the caller rather than under it, not reporting back (2026-10-26)", async () => {
    const s = await service.sessions.startPeer(caller.id, { text: "拳套的问题人来处理，背景如下……", title: "拳套", forPerson: true });
    expect(s).toMatchObject({ taskId: task.id, kind: "main", parentId: null, title: "拳套" });
    expect(store.getSession(s.id)?.startedBy ?? null).toBeNull();
    expect(store.getSession(s.id)?.reportTo ?? null).toBeNull();
    const first = userTexts(s.id)[0]!;
    expect(first).toContain("应人的要求开启：人会在这里和你一起推进");
    expect(first).toContain(`mailbox_send 给会话 ${caller.id}`);
    await expect(service.sessions.startPeer(caller.id, { text: "x", forPerson: true, report: true })).rejects.toThrow(/去掉 report/);
  });

  it("runs in another project when asked (by name or path), still a session of the task, and says where it works", async () => {
    mkdirSync(join(root, "beta"));
    const beta = store.addWorkspace({ path: join(root, "beta"), name: "beta" });
    const byName = await service.sessions.startPeer(caller.id, { text: "看 beta 的提交", workspace: "beta" });
    expect(byName).toMatchObject({ taskId: task.id, workspaceId: beta.id, startedBy: caller.id });
    expect(userTexts(byName.id)[0]).toContain(`你在项目「beta」的文件夹 ${beta.path} 里工作`);
    expect((await service.sessions.startPeer(caller.id, { text: "再看", workspace: `${beta.path}\\` })).workspaceId).toBe(beta.id);
    // Its own project: no note.
    expect(userTexts((await service.sessions.startPeer(caller.id, { text: "本项目", workspace: "alpha" })).id)[0]).not.toContain("里工作，和任务本身的项目不同");
    await expect(service.sessions.startPeer(caller.id, { text: "x", workspace: "nope" })).rejects.toThrow(/project nope not found/);
  });

  it("with report, the new session's first finished turn comes back into the caller's conversation", async () => {
    const s = await service.sessions.startPeer(caller.id, { text: "数一下有几张表", report: true });
    expect(userTexts(s.id)[0]).toContain("你最后的回复会自动转给它");
    await until(() => userTexts(caller.id).some((t) => t.includes(`（${s.id}）这一轮做完了`)));
    const report = userTexts(caller.id).find((t) => t.includes("这一轮做完了"))!;
    // The fake app-server answers with its own text; whatever it is, the report carries the reply.
    const [reply] = store.findItems(s.id, "agent", {}, { newest: true, limit: 1 });
    expect(reply && reply.type === "agent" && report.includes(reply.markdown.trim().slice(0, 20))).toBe(true);
    // Once only.
    await new Promise((r) => setTimeout(r, 300));
    expect(userTexts(caller.id).filter((t) => t.includes("这一轮做完了"))).toHaveLength(1);
  });

  it("reports every turn that ends: stopped by the person is not done; the turn that finishes reports its reply; mail already left gets one line", async () => {
    const reports = (s: Session) => userTexts(caller.id).filter((t) => t.includes(`（${s.id}）`));
    const s = await service.sessions.startPeer(caller.id, { text: "[[slow]]", report: true });
    expect(store.getSession(s.id)?.reportTo).toBe(caller.id);
    await until(() => store.getSession(s.id)?.status === "running");
    await service.sessions.interrupt(s.id);
    await until(() => reports(s).length === 1);
    expect(reports(s)[0]).toContain("被人停下了，还没有结论");
    expect(reports(s)[0]).not.toContain("做完了");

    await service.sessions.sendMessage(s.id, "接着做完");
    await until(() => reports(s).length === 2);
    expect(reports(s)[1]).toContain("这一轮做完了");
    expect(reports(s)[1]).toContain("FAKE: 接着做完");

    // A turn in which it left the caller mail: the report is one line, not the reply again.
    await service.sessions.sendMessage(s.id, "[[slow]]");
    await until(() => store.getSession(s.id)?.status === "running");
    service.collab.sendMail(s.id, { kind: "session", sessionId: caller.id }, "结论：3 张表");
    await until(() => reports(s).length === 3);
    expect(reports(s)[2]).toContain("它已经用留言把结果发给你");
    expect(reports(s)[2]).not.toContain("slow slow");
    // No turn is told twice, whatever else changes on the session.
    await service.sessions.renameSession(s.id, "改个名");
    await new Promise((r) => setTimeout(r, 300));
    expect(reports(s)).toHaveLength(3);
  });

  it("refuses subagents, topic sessions, archived tasks, an unknown model and an empty message", async () => {
    const sub = store.createSession({ taskId: task.id, topicId: null, parentId: caller.id, kind: "sub", runtime: "codex", profileId: "p-ds", workspaceId: alpha.id, title: "", status: "idle", writer: "workbench", runtimeRef: "thr-sub" });
    await expect(service.sessions.startPeer(sub.id, { text: "x" })).rejects.toThrow(/子 agent/);
    const topic = service.topics.createTopic({ title: "迁移" });
    const topicSession = store.createSession({ taskId: null, topicId: topic.id, parentId: null, kind: "main", runtime: "codex", profileId: "p-ds", workspaceId: alpha.id, title: "", status: "idle", writer: "workbench", runtimeRef: "thr-topic" });
    await expect(service.sessions.startPeer(topicSession.id, { text: "x" })).rejects.toThrow(/专题会话/);
    await expect(service.sessions.startPeer(caller.id, { text: " " })).rejects.toThrow(/text/);
    await expect(service.sessions.startPeer(caller.id, { text: "x", model: "nope" })).rejects.toThrow(/model nope not found/);
    await service.tasks.archiveTask(task.id);
    await expect(service.sessions.startPeer(caller.id, { text: "x" })).rejects.toThrow(/归档/);
  });
});
