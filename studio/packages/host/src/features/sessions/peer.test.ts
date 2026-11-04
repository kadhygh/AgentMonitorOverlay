import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfile, Session, Task, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CLAUDE_PERMISSIONS } from "../../runtime/choices.js";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { peerPermission } from "./service.js";

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
    // permission: the runtime's own option for the level (Codex: read-only, full-auto), never wider than the caller's
    // (10-29); left out, the caller's own (here none was picked: the default it runs on, Codex's 逐条询问).
    expect(s.options.permission).toBe("ask");
    expect((await service.sessions.startPeer(caller.id, { text: "只读看看", permission: "read-only" })).options.permission).toBe("read-only");
    await expect(service.sessions.startPeer(caller.id, { text: "跑一串命令", permission: "full" })).rejects.toThrow(/不能比你宽：permission 用 read-only/);
    store.updateSession(caller.id, { options: { ...store.getSession(caller.id)!.options, permission: "full-auto" } });
    expect((await service.sessions.startPeer(caller.id, { text: "跑一串命令", permission: "full" })).options.permission).toBe("full-auto");
    expect((await service.sessions.startPeer(caller.id, { text: "接着跑" })).options.permission).toBe("full-auto");
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

  it("permission across CLIs (10-29): Claude's write is 帮我审批, the caller's own when left out, never wider than it", () => {
    const claude = { permissions: CLAUDE_PERMISSIONS, defaultPermission: "default" };
    const auto = { runtime: "claude" as const, permission: "auto" };
    // A Claude session started with write by one on 帮我审批 asked about every command (自动接受编辑): now 帮我审批.
    expect(peerPermission(auto, "claude", "write", claude)).toBe("auto");
    expect(peerPermission(auto, "claude", null, claude)).toBe("auto");
    expect(peerPermission(auto, "claude", "read-only", claude)).toBe("plan");
    expect(() => peerPermission(auto, "claude", "full", claude)).toThrow(/不能比你宽：permission 用 read-only 或 write/);
    // No classifier on another endpoint (GLM…): write is 自动接受编辑.
    const glm = { permissions: CLAUDE_PERMISSIONS.map((p) => (p.id === "auto" ? { ...p, unavailable: "x" } : p)), defaultPermission: "default" };
    expect(peerPermission({ runtime: "claude", permission: "acceptEdits" }, "claude", "write", glm)).toBe("acceptEdits");
    // The same CLI goes by order: a caller on 自动接受编辑 cannot start one on 帮我审批.
    expect(() => peerPermission({ runtime: "claude", permission: "acceptEdits" }, "claude", "write", claude)).toThrow(/不能比你宽/);
    // Another CLI: its default, unless wider than the caller's level (a read-only caller starts read-only ones).
    const codex = { permissions: [], defaultPermission: "ask" };
    expect(peerPermission(auto, "codex", null, codex)).toBeUndefined();
    expect(peerPermission({ runtime: "claude", permission: "plan" }, "codex", null, codex)).toBe("read-only");
    expect(peerPermission({ runtime: "claude", permission: "bypassPermissions" }, "dsh", "full", null)).toBe("full-access");
    expect(() => peerPermission(auto, "dsh", "full", null)).toThrow(/不能比你宽/);
    // No caller to go by (a remote one): the level as asked, or the model's default.
    expect(peerPermission(null, "claude", "full", claude)).toBe("bypassPermissions");
    expect(peerPermission(null, "claude", null, claude)).toBeUndefined();
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

// 收会话 (session_archive, 2026-11-01, 问题 #6): what a session started it can archive again; nothing else.
// 续发 (session_send, 2026-11-01): what a session started it can tell more; one in a turn gets it after the turn.
describe("session_send (续发)", () => {
  it("sends into a session the caller started, marked as from it; refuses itself, the person's, another's, forPerson and archived ones", async () => {
    const s = await service.sessions.startPeer(caller.id, { text: "阶段 1：只改数值表" });
    await until(() => store.getSession(s.id)?.status === "idle");
    const sent = await service.sessions.sendPeer(caller.id, { sessionId: s.id, text: "阶段 2：再加一列" });
    expect(sent).toMatchObject({ delivered: true, waiting: 0 });
    await until(() => userTexts(s.id).length === 2);
    expect(userTexts(s.id)[1]).toContain(`【开启你的会话「主会话」（${caller.id}）发来】`);
    expect(userTexts(s.id)[1]).toContain("阶段 2：再加一列");

    await expect(service.sessions.sendPeer(caller.id, { sessionId: caller.id, text: "x" })).rejects.toThrow(/不能发给你自己/);
    const persons = await service.tasks.addSession(task.id, { profileId: "p-ds" });
    await expect(service.sessions.sendPeer(caller.id, { sessionId: persons.id, text: "x" })).rejects.toThrow(/不是你用 session_start 开的/);
    const others = await service.sessions.startPeer(persons.id, { text: "另一个会话开的" });
    await expect(service.sessions.sendPeer(caller.id, { sessionId: others.id, text: "x" })).rejects.toThrow(/不是你用 session_start 开的/);
    const forPerson = await service.sessions.startPeer(caller.id, { text: "人来处理", forPerson: true });
    await expect(service.sessions.sendPeer(caller.id, { sessionId: forPerson.id, text: "x" })).rejects.toThrow(/不是你用 session_start 开的/);
    await expect(service.sessions.sendPeer(caller.id, { sessionId: s.id, text: "  " })).rejects.toThrow();
    await until(() => store.getSession(s.id)?.status === "idle");
    await service.sessions.archivePeer(caller.id, { sessionId: s.id });
    await expect(service.sessions.sendPeer(caller.id, { sessionId: s.id, text: "x" })).rejects.toThrow(/已经归档/);
  });

  it("one in a turn gets it once the turn is over, after its report; shown meanwhile (held); several waiting go in together", async () => {
    const s = await service.sessions.startPeer(caller.id, { text: "[[slow]]", report: true });
    await until(() => store.getSession(s.id)?.status === "running");
    expect(await service.sessions.sendPeer(caller.id, { sessionId: s.id, text: "阶段 2" })).toMatchObject({ delivered: false, waiting: 1 });
    expect(await service.sessions.sendPeer(caller.id, { sessionId: s.id, text: "阶段 2 补一句" })).toMatchObject({ delivered: false, waiting: 2 });
    // In the session's inbox (2026-11-04): shown at once, in the running turn, not sent yet.
    expect(deliveries(s.id)).toEqual([undefined, "held", "held"]);
    expect(store.listItems(s.id).filter((i) => i.type === "user").slice(1).every((i) => !!i.raw?.turnId)).toBe(true);
    await until(() => deliveries(s.id).every((d) => d === undefined));
    expect(userTexts(s.id)[1]).toContain("阶段 2");
    expect(userTexts(s.id)[2]).toContain("阶段 2 补一句");
    // The caller hears of the turn that ended (through its own inbox: it was free, so at once).
    await until(() => userTexts(caller.id).some((t) => t.includes(`（${s.id}）这一轮做完了`)));
    await until(() => store.getSession(s.id)?.status === "idle");
    expect(userTexts(s.id)).toHaveLength(3);
  });
});

// 会话收件箱 (2026-11-04, plans/message-delivery.md): what agents and Studio send waits on disk until the session is free.
describe("the session inbox", () => {
  it("goes on after a Host restart, and moves session_send's old queue in", async () => {
    const s = await service.sessions.startPeer(caller.id, { text: "阶段 1" });
    await until(() => store.getSession(s.id)?.status === "idle");
    // Busy when the message came; the Host stops before the session is free.
    store.updateSession(s.id, { status: "running" });
    expect(await service.sessions.sendPeer(caller.id, { sessionId: s.id, text: "阶段 2" })).toMatchObject({ delivered: false, waiting: 1 });
    store.updateSession(s.id, { status: "interrupted" });
    // A Host before the inbox left session_send's own queue.
    store.setKv("sessions.peer-queue", JSON.stringify({ [s.id]: ["【开启你的会话】\n旧队列里的一条"] }));
    await servers.close();

    // The next Host (a fake app-server does not keep threads across a restart: what the runtime is asked to send is
    // recorded instead).
    servers = new FakeServers(PROFILES);
    const runtime = new CodexRuntime({ store, servers, profiles: PROFILES });
    const sent: string[] = [];
    runtime.resend = async (sessionId: string, itemId: string) => {
      const it = store.getItem(itemId)!;
      if (it.type === "user") sent.push(`${sessionId}:${it.text}`);
      store.replaceItem({ ...it, delivery: undefined } as never);
      return { mode: "start" };
    };
    new HostService(store, runtime, PROFILES, { commonDir: join(root, "common") });
    await until(() => sent.length === 2);
    expect(sent[0]).toBe(`${s.id}:${userTexts(s.id)[1]}`);
    expect(sent[0]).toContain("阶段 2");
    expect(sent[1]).toContain("旧队列里的一条");
    expect(deliveries(s.id).every((d) => d === undefined)).toBe(true);
    expect(store.getKv("sessions.peer-queue")?.value ?? "").toBe("");
    expect(JSON.parse(store.getKv("sessions.inbox")?.value ?? "[]")).toEqual([]);
  });

  it("one that cannot go in is 没送到 with a line why; 重新发送 sends it; an archived session's are 没送到", async () => {
    const s = await service.sessions.startPeer(caller.id, { text: "阶段 1" });
    await until(() => store.getSession(s.id)?.status === "idle");
    const rt = service.runtime as { resend?: (...a: unknown[]) => Promise<unknown> };
    const resend = rt.resend!.bind(rt);
    rt.resend = async () => {
      rt.resend = resend;
      throw new Error("渠道的 Key 没了");
    };
    expect(await service.sessions.sendPeer(caller.id, { sessionId: s.id, text: "阶段 2" })).toMatchObject({ delivered: true, waiting: 0 });
    expect(deliveries(s.id)).toEqual([undefined, "unsent"]);
    expect(store.listItems(s.id).some((i) => i.type === "notice" && i.message.includes("渠道的 Key 没了"))).toBe(true);
    const row = store.listItems(s.id).filter((i) => i.type === "user")[1]!;
    await service.sessions.resend(s.id, row.id);
    await until(() => deliveries(s.id).every((d) => d === undefined));

    await until(() => store.getSession(s.id)?.status === "idle");
    store.updateSession(s.id, { status: "running" });
    await service.sessions.sendPeer(caller.id, { sessionId: s.id, text: "阶段 3" });
    store.updateSession(s.id, { status: "idle" });
    await service.sessions.archive(s.id);
    await until(() => deliveries(s.id).at(-1) === "unsent");
  });

  it("立即发送 on a held message puts it in now", async () => {
    const s = await service.sessions.startPeer(caller.id, { text: "[[slow]]" });
    await until(() => store.getSession(s.id)?.status === "running");
    await service.sessions.sendPeer(caller.id, { sessionId: s.id, text: "等不及了" });
    const row = store.listItems(s.id).filter((i) => i.type === "user")[1]!;
    expect(row).toMatchObject({ delivery: "held" });
    await service.sessions.sendNow(s.id, row.id);
    await until(() => (store.getItem(row.id) as { delivery?: string }).delivery !== "held");
  });
});

const deliveries = (sessionId: string) => store.listItems(sessionId).flatMap((i) => (i.type === "user" ? [i.delivery] : []));

describe("session_archive (收会话)", () => {
  it("archives a session the caller started, with what hangs under it; refuses itself, the person's, another's and forPerson ones", async () => {
    const s = await service.sessions.startPeer(caller.id, { text: "只改数值表" });
    await until(() => store.getSession(s.id)?.status !== "running");
    const archived = await service.sessions.archivePeer(caller.id, { sessionId: s.id });
    expect(archived.map((x) => x.id)).toContain(s.id);
    expect(store.getSession(s.id)?.archivedAt).not.toBeNull();
    expect(store.getSession(caller.id)?.archivedAt).toBeNull();
    await expect(service.sessions.archivePeer(caller.id, { sessionId: s.id })).rejects.toThrow(/已经归档/);

    await expect(service.sessions.archivePeer(caller.id, { sessionId: caller.id })).rejects.toThrow(/不能归档你自己/);
    const persons = await service.tasks.addSession(task.id, { profileId: "p-ds" });
    await expect(service.sessions.archivePeer(caller.id, { sessionId: persons.id })).rejects.toThrow(/不是你用 session_start 开的/);
    const others = await service.sessions.startPeer(persons.id, { text: "另一个会话开的" });
    await expect(service.sessions.archivePeer(caller.id, { sessionId: others.id })).rejects.toThrow(/不是你用 session_start 开的/);
    const forPerson = await service.sessions.startPeer(caller.id, { text: "人来处理", forPerson: true });
    await expect(service.sessions.archivePeer(caller.id, { sessionId: forPerson.id })).rejects.toThrow(/不是你用 session_start 开的/);
    await expect(service.sessions.archivePeer(caller.id, { sessionId: "nope" })).rejects.toThrow(/不是你用 session_start 开的/);
    await expect(service.sessions.archivePeer(caller.id, {})).rejects.toThrow(/sessionId/);
    for (const id of [persons.id, others.id, forPerson.id]) expect(store.getSession(id)?.archivedAt).toBeNull();
  });

  it("refuses one still in a turn unless stop: true, which stops it and archives it", async () => {
    const s = await service.sessions.startPeer(caller.id, { text: "[[slow]]" });
    await until(() => store.getSession(s.id)?.status === "running");
    await expect(service.sessions.archivePeer(caller.id, { sessionId: s.id })).rejects.toThrow(/还在跑.*stop: true/);
    expect(store.getSession(s.id)?.archivedAt).toBeNull();
    await service.sessions.archivePeer(caller.id, { sessionId: s.id, stop: true });
    expect(store.getSession(s.id)?.archivedAt).not.toBeNull();
  });
});
