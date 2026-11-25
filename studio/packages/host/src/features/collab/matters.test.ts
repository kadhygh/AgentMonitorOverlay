import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MailMessage, ModelProfile, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { recordRole, roleUpdate, taskLeadOf } from "../../core/role.js";
import { roleCard } from "../guide/role.js";

// 本机的事项和消息 (2026-11-25, protocol/src/localmail.ts, plans/collab-framework.md「留言和主控的来往也在本轮改」): 留言 is
// a message of a 事项 with a 「#seq」 and receipts; it goes in by distance; replyTo goes back on its own line; what is
// still queued can be taken back or rewritten; what waited says when it was sent; a session opened forPerson gets
// 背景更新 with the person's next message; the 留言 from before are kept.

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let alpha: Workspace;
let topic: Topic;
let taskA: Task;
let taskB: Task;
let lone: Task;
let a: Session;
let b: Session;
let c: Session;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-matters-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  mkdirSync(join(root, "alpha"));
  alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
  topic = service.topics.createTopic({ title: "掉落" });
  taskA = store.createTask({ title: "掉落表", workspaceId: alpha.id, topicId: topic.id });
  taskB = store.createTask({ title: "掉落界面", workspaceId: alpha.id, topicId: topic.id });
  lone = store.createTask({ title: "别处", workspaceId: alpha.id });
  a = await service.tasks.addSession(taskA.id, { profileId: "p-ds" });
  await service.sessions.renameSession(a.id, "表");
  b = await service.tasks.addSession(taskB.id, { profileId: "p-ds" });
  await service.sessions.renameSession(b.id, "界面");
  c = await service.tasks.addSession(lone.id, { profileId: "p-ds" });
});

afterEach(async () => {
  await servers.close();
  store.close();
  removeTempDir(root);
});

const until = async (pred: () => boolean, tries = 240) => {
  for (let i = 0; i < tries && !pred(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(pred()).toBe(true);
};
const userTexts = (sessionId: string) => store.listItems(sessionId).flatMap((i) => (i.type === "user" ? [i.text] : []));
const idle = (id: string) => until(() => store.getSession(id)?.status === "idle" && !service.sessions.inbox.held(id).length);
const mail = (m: MailMessage) => store.getMail(m.id)!;

describe("本机的事项", () => {
  it("goes in by distance: the same topic at once, another topic or none waits for the person (or 先问 on the task); the person sends it in", { timeout: 20_000 }, async () => {
    const near = await service.collab.sendFromSession(a.id, { toTaskId: taskB.id, text: "掉落表的字段名改成 dropId 了" });
    expect(near).toMatchObject({ seq: 1, via: "mail", state: "forwarded", to: { kind: "task", taskId: taskB.id } });
    await until(() => userTexts(b.id).some((t) => t.includes("dropId")));
    const row = userTexts(b.id).find((t) => t.includes("dropId"))!;
    expect(row).toMatch(/^【留言 #1 · 事项 1「掉落表的字段名改成 dropId 了」】来自任务「掉落表」的会话「表」/);
    expect(row).toContain("mailbox_send 带 replyTo: 1");
    // The receipt names the session it went into, and goes on to 看过 once its turn is over.
    await until(() => mail(near).receipts?.[0]?.state === "seen");
    expect(mail(near).receipts?.[0]?.party).toBe(`agent:${b.id}`);

    // Farther: waits in the person's 待我处理.
    const far = await service.collab.sendFromSession(a.id, { toSessionId: c.id, text: "别处也用这个字段" });
    expect(far).toMatchObject({ ask: true, state: "unread", receipts: [{ state: "queued" }] });
    expect(service.collab.matters.pendingView().asks.map((m) => m.id)).toEqual([far.id]);
    expect(service.collab.matters.pendingView().pending.map((p) => p.seq)).toEqual([far.seq]);
    await service.collab.forwardMail(far.id);
    await until(() => userTexts(c.id).some((t) => t.includes("别处也用这个字段")));
    expect(service.collab.matters.pendingView().asks).toEqual([]);

    // 先问 on the task: the same topic waits too.
    service.tasks.updateTask(taskB.id, { relayAuto: false });
    const held = await service.collab.sendFromSession(a.id, { toSessionId: b.id, text: "先问的任务" });
    expect(held.ask).toBe(true);
    service.tasks.updateTask(taskB.id, { relayAuto: null });
    expect(store.getTask(taskB.id)?.relayAuto).toBeUndefined();
  });

  it("a message whose task, session or topic is archived or gone is not listed as waiting; restored, it is again", { timeout: 20_000 }, async () => {
    // A task and a topic without sessions: archiving them says so by their own events only.
    const empty = store.createTask({ title: "没会话", workspaceId: alpha.id });
    const other = service.topics.createTopic({ title: "别的专题" });
    const toTask = await service.collab.sendFromSession(a.id, { toTaskId: empty.id, text: "给任务" });
    const toSession = await service.collab.sendFromSession(a.id, { toSessionId: c.id, text: "给会话" });
    const toTopic = await service.collab.sendFromSession(a.id, { toTopicId: other.id, text: "给专题" });
    const all = [toTask, toSession, toTopic];
    const stored = all.map(mail);
    store.putMail({ id: "mail-gone", fromSessionId: a.id, fromTaskId: taskA.id, to: { kind: "session", sessionId: "s-gone" }, text: "收的会话没了", state: "unread", createdAt: new Date().toISOString(), handledAt: null, ask: true });

    const listed = () => service.collab.matters.pendingView().asks.map((m) => m.id).sort();
    const items = () => service.collab.matters.pendingView().pending.map((p) => p.seq).sort();
    const snapshot = () => (service.pending.snapshot().groups.find((g) => g.id === "local:me")?.items ?? []).map((i) => i.key).sort();
    /** Without `gone`: the page's list, its items, and 待我处理's snapshot (made again by the archive's own event). */
    const expectWithout = async (...gone: MailMessage[]) => {
      const left = all.filter((m) => !gone.includes(m));
      expect(listed()).toEqual(left.map((m) => m.id).sort());
      expect(items()).toEqual(left.map((m) => m.seq).sort());
      const keys = left.map((m) => `ask:${m.id}`).sort();
      await until(() => JSON.stringify(snapshot()) === JSON.stringify(keys));
    };
    await expectWithout();

    await service.tasks.archiveTask(empty.id);
    await expectWithout(toTask);
    await service.tasks.unarchiveTask(empty.id);
    await expectWithout();

    await service.sessions.archive(c.id);
    await expectWithout(toSession);
    await service.sessions.unarchive(c.id);
    await expectWithout();

    await service.topics.archiveTopic(other.id);
    await expectWithout(toTopic);
    // The task side column's list follows it too.
    expect(service.collab.matters.pendingView(taskA.id).asks.map((m) => m.id)).not.toContain(toTopic.id);
    await service.topics.unarchiveTopic(other.id);
    await expectWithout();

    // Only left out of the list: nothing about the messages changed.
    expect(all.map(mail)).toEqual(stored);
  });

  it("replyTo goes back to the sender in the same 事项 without an address; the 事项 closes once all is 处理了", { timeout: 20_000 }, async () => {
    const ask = await service.collab.sendFromSession(a.id, { toSessionId: b.id, text: "界面要几列？" });
    await idle(b.id);
    const answer = await service.collab.sendFromSession(b.id, { replyTo: `#${ask.seq}`, text: "三列" });
    expect(answer).toMatchObject({ matter: ask.matter, replyTo: ask.seq, to: { kind: "session", sessionId: a.id } });
    await until(() => userTexts(a.id).some((t) => t.includes("三列")));
    expect(mail(ask).receipts?.[0]?.state).toBe("handled");
    // A's 待我处理: the answer, until it marks it.
    await idle(a.id);
    expect(service.collab.matters.pendingOf(a.id).map((p) => p.seq)).toEqual([answer.seq]);
    expect(service.collab.matters.markHandledBy(store.getSession(a.id)!, [answer.seq])).toEqual([answer.seq]);
    expect(service.collab.matters.pendingOf(a.id)).toEqual([]);
    expect(store.getMatter(ask.matter!)?.status).toBe("closed");
    // A new message in it opens it again; matter: 「事项 1」 writes to its other side.
    const again = await service.collab.sendFromSession(a.id, { matter: "事项 1", text: "再加一列" });
    expect(again).toMatchObject({ matter: ask.matter, to: { kind: "session", sessionId: b.id } });
    expect(store.getMatter(ask.matter!)?.status).toBe("doing");
    // The thread in order, for the page.
    expect(store.listMailInMatter(ask.matter!).map((m) => m.text)).toEqual(["界面要几列？", "三列", "再加一列"]);
  });

  it("what is still queued can be withdrawn or rewritten by its sender; once in, it cannot; a message that waited says when it was sent", { timeout: 20_000 }, async () => {
    const worker = await service.sessions.startPeer(a.id, { text: "[[slow]]", title: "慢活" });
    await until(() => store.getSession(worker.id)?.status === "running");
    const one = await service.sessions.sendPeer(a.id, { sessionId: worker.id, text: "阶段 2" });
    const two = await service.sessions.sendPeer(a.id, { sessionId: worker.id, text: "阶段 3" });
    expect(one).toMatchObject({ delivered: false, waiting: 1 });
    expect(service.collab.matters.queuedFrom(a.id).map((m) => m.seq)).toEqual([one.seq, two.seq]);
    // Only its sender.
    expect(() => service.collab.matters.withdraw(one.seq, store.getSession(b.id)!)).toThrow(/不是你发的/);
    await service.sessions.sendPeer(a.id, { withdraw: `#${one.seq}` });
    await service.sessions.sendPeer(a.id, { edit: two.seq, text: "阶段 3（改过）" });
    const rows = store.listItems(worker.id).filter((i) => i.type === "user");
    expect(rows.map((r) => r.type === "user" && r.delivery)).toEqual([undefined, "withdrawn", "held"]);
    expect(rows[2]?.type === "user" && rows[2].text).toContain("阶段 3（改过）");
    // (Not stopped by the person: that would hold them for the person's next message.)
    await until(() => !service.sessions.inbox.held(worker.id).length, 400);
    // Withdrawn never went in; the rewritten one did, saying when it was sent and what was done since.
    const sent = store.listItems(worker.id).filter((i) => i.type === "user");
    expect(sent[1]?.type === "user" && sent[1].delivery).toBe("withdrawn");
    expect(sent[2]?.type === "user" && sent[2].text).toMatch(/（这条发出于 \d\d:\d\d，之后你又做了 1 轮/);
    expect(() => service.collab.matters.withdraw(two.seq, store.getSession(a.id)!)).toThrow(/已经送到了（/);
    expect(store.getMailBySeq(one.seq!)?.withdrawnAt).toBeTypeOf("number");
  });

  it("session_start opens a 委派事项; the worker's mailbox_send without a 事项 goes into it, and its report then says 内容同上", { timeout: 20_000 }, async () => {
    const worker = await service.sessions.startPeer(a.id, { text: "[[slow]]", title: "数表" });
    const matter = service.collab.matters.delegateOf(worker.id, a.id)!;
    expect(matter).toMatchObject({ kind: "delegate", title: "数表" });
    await until(() => store.getSession(worker.id)?.status === "running");
    const sent = await service.collab.sendFromSession(worker.id, { toSessionId: a.id, text: "一共 3 张表" });
    expect(sent.matter).toBe(matter.id);
    await service.sessions.interrupt(worker.id);
    await until(() => userTexts(a.id).some((t) => t.includes("被人停下了")));
    await service.sessions.sendMessage(worker.id, "接着");
    await until(() => userTexts(a.id).some((t) => t.includes("这一轮做完了")));
    expect(store.listMailInMatter(matter.id).map((m) => m.via)).toEqual(["start", "mail", "report", "report"]);
  });

  it("session_send to a session opened forPerson is a 背景更新: it goes in with the person's next message, marked as whose", { timeout: 20_000 }, async () => {
    const forPerson = await service.sessions.startPeer(a.id, { text: "人来处理", title: "人", forPerson: true });
    await idle(forPerson.id);
    const r = await service.sessions.sendPeer(a.id, { sessionId: forPerson.id, text: "表的字段名已经改成 dropId" });
    expect(r).toMatchObject({ background: true, delivered: false });
    await new Promise((res) => setTimeout(res, 200));
    expect(userTexts(forPerson.id)).toHaveLength(1);
    await service.sessions.sendMessage(forPerson.id, "接着做吧");
    const last = userTexts(forPerson.id).at(-1)!;
    expect(last).toContain("接着做吧");
    expect(last).toMatch(/背景更新（#\d+，来自开这个会话的「表」，\d\d:\d\d；是补充的情况，不是人的话）：表的字段名已经改成 dropId/);
    expect(store.getMailBySeq(r.seq!)?.receipts?.[0]?.state).not.toBe("queued");
    // Once only.
    await idle(forPerson.id);
    await service.sessions.sendMessage(forPerson.id, "再来");
    expect(userTexts(forPerson.id).at(-1)).not.toContain("背景更新");
  });

  it("the 留言 from before get their #seq when the Host starts: unread ones wait for the person, the rest are done", async () => {
    store.putMail({ id: "mail-old-1", fromSessionId: a.id, fromTaskId: taskA.id, to: { kind: "task", taskId: lone.id }, text: "旧的一条", state: "unread", createdAt: "2026-11-01T00:00:00.000Z", handledAt: null });
    store.putMail({ id: "mail-old-2", fromSessionId: a.id, fromTaskId: taskA.id, to: { kind: "session", sessionId: b.id }, text: "旧的转过了", state: "forwarded", createdAt: "2026-11-02T00:00:00.000Z", handledAt: "2026-11-02T01:00:00.000Z" });
    const again = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
    expect(store.getMail("mail-old-1")).toMatchObject({ seq: 1, ask: true, receipts: [{ party: `agent:task:${lone.id}`, state: "queued" }] });
    expect(store.getMail("mail-old-2")).toMatchObject({ seq: 2, receipts: [{ party: `agent:${b.id}`, state: "handled" }] });
    expect(again.collab.matters.pendingView().asks.map((m) => m.id)).toEqual(["mail-old-1"]);
    // New ones number on.
    expect((await again.collab.sendFromSession(a.id, { toSessionId: b.id, text: "新的" })).seq).toBe(3);
  });
});

describe("任务主控 and 待我处理's local source", () => {
  it("the first main session the person opened is the task's 主控, with its card; the person can pick another", { timeout: 20_000 }, async () => {
    expect(taskLeadOf(store, taskA.id)).toBe(a.id);
    expect(roleCard(service, a.id)).toContain("你是任务「掉落表」的**主控**");
    const a2 = await service.tasks.addSession(taskA.id, { profileId: "p-ds" });
    expect(roleCard(service, a2.id)).not.toContain("你是任务「掉落表」的**主控**");
    expect(roleCard(service, a2.id)).toContain(`任务主控：会话「表」（${a.id}）`);
    recordRole(service, a.id);
    recordRole(service, a2.id);
    service.tasks.updateTask(taskA.id, { leadSessionId: a2.id });
    expect(taskLeadOf(store, taskA.id)).toBe(a2.id);
    expect(roleUpdate(service, a2.id).lines.join("\n")).toContain("你现在是这个任务的主控");
    expect(roleUpdate(service, a.id).lines.join("\n")).toContain("你不再是这个任务的主控");
    expect(() => service.tasks.updateTask(taskA.id, { leadSessionId: b.id })).toThrow(/主会话/);
    service.tasks.updateTask(taskA.id, { leadSessionId: null });
    expect(taskLeadOf(store, taskA.id)).toBe(a.id);
  });

  it("the person's group (先问 messages, 不送 by marking), a 主控's group: what went in is told, a 事项 waiting on it wakes it", { timeout: 30_000 }, async () => {
    service.pending.patrolMs = 3600_000; // ticked by hand
    service.pending.start();
    try {
      const far = await service.collab.sendFromSession(c.id, { toTaskId: taskB.id, text: "图标下周才到" });
      await until(() => service.pending.snapshot().groups.some((g) => g.id === "local:me"));
      const me = service.pending.snapshot().groups.find((g) => g.id === "local:me")!;
      expect(me).toMatchObject({ source: "local", for: { kind: "person" }, canMark: true });
      expect(me.items).toEqual([expect.objectContaining({ key: `ask:${far.id}`, kind: "message", seq: far.seq, open: { kind: "here" } })]);
      expect(service.pending.snapshot().mine).toBeGreaterThanOrEqual(1);
      await service.pending.mark({ group: "local:me", keys: [`ask:${far.id}`], mark: "handled" });
      expect(mail(far).state).toBe("dismissed");

      // 「掉落界面」's first session is its 主控: a message that went into its conversation is told, not woken for.
      const near = await service.collab.sendFromSession(a.id, { toSessionId: b.id, text: "字段名改成 dropId" });
      await idle(b.id);
      await until(() => service.pending.forSession(b.id).some((g) => g.items.some((i) => i.seq === near.seq)));
      const group = service.pending.forSession(b.id)[0]!;
      expect(group.id).toBe(`local:session:${b.id}`);
      await service.pending.tick();
      expect(service.pending.fresh(b.id, service.pending.forSession(b.id)[0]!)).toEqual([]);
      expect(userTexts(b.id).some((t) => t.startsWith("【本机 · 待你处理】"))).toBe(false);

      // A 事项 that starts waiting on it: the patrol wakes it with that one.
      const m = service.collab.matters.get(near.matter!)!;
      service.collab.matters.update(m.id, { waitingOn: [`agent:${b.id}`] }, `agent:${a.id}`);
      await until(() => service.pending.forSession(b.id)[0]?.items.some((i) => i.seq === null) ?? false);
      await service.pending.tick();
      await until(() => userTexts(b.id).some((t) => t.startsWith("【本机 · 待你处理】")));
      const woke = userTexts(b.id).find((t) => t.startsWith("【本机 · 待你处理】"))!;
      expect(woke).toContain(`事项 ${m.no}「${m.title}」`);
      expect(woke).toContain("在等你");
      expect(woke).not.toContain(`#${near.seq} `);
    } finally {
      service.pending.stop();
    }
  });
});
