import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyCanvas, type ModelProfile, type Session, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

// Stage 16: 传话 — a 主控's message for another task's session: confirmed by the person (or not asked), delivered.

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let alpha: Workspace;
let topic: Topic;
let leadSession: Session;
let target: Task;
let workerSession: Session;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-relays-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  mkdirSync(join(root, "alpha"));
  alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
  topic = service.topics.createTopic({ title: "迁移" });
  const lead = store.createTask({ title: "迁移主控", workspaceId: alpha.id, topicId: topic.id, lead: true });
  target = store.createTask({ title: "装甲车", workspaceId: alpha.id, topicId: topic.id });
  const other = store.createTask({ title: "别处", workspaceId: alpha.id });
  const session = (taskId: string) => store.createSession({ taskId, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "p-ds", workspaceId: alpha.id, title: "", status: "idle", writer: "workbench", runtimeRef: `thr-${taskId}` });
  leadSession = session(lead.id);
  workerSession = session(other.id);
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
const lastMail = () => service.collab.readMailFromSession(leadSession.id).at(-1)?.text;
const userTexts = (sessionId: string) => store.listItems(sessionId).flatMap((i) => (i.type === "user" ? [i.text] : []));

describe("relays (传话)", () => {
  it("takes a relay only from a 主控, for a task of its topic", () => {
    expect(() => service.relays.send(workerSession.id, { taskId: target.id, text: "x" })).toThrow(/只有主控/);
    const outside = store.listTasks().find((t) => t.title === "别处")!;
    expect(() => service.relays.send(leadSession.id, { taskId: outside.id, text: "x" })).toThrow(/不在你的专题里/);
    expect(() => service.relays.send(leadSession.id, { taskId: target.id, text: " " })).toThrow(/text/);
    expect(service.relays.send(leadSession.id, { taskId: target.id, text: "先做数据" })).toMatchObject({ state: "pending", toTaskId: target.id });
  });

  it("waits for the person when the task says 先问: dismissed, or delivered into a new session (none yet), marked as from the 主控", async () => {
    service.tasks.updateTask(target.id, { relayAuto: false });
    const no = service.relays.send(leadSession.id, { taskId: target.id, text: "不用了" });
    // In the person's 待我处理 (2026-11-25) while it waits.
    expect(service.collab.matters.pendingView().asks.map((m) => m.relayId)).toEqual([no.id]);
    expect(service.relays.dismiss(no.id).state).toBe("dismissed");
    expect(lastMail()).toBe("人没有让你的传话送到「装甲车」。");
    expect(service.collab.matters.pendingView().asks).toEqual([]);
    const yes = service.relays.send(leadSession.id, { taskId: target.id, text: "先迁数据表，界面等我通知" });
    const delivered = await service.relays.deliver(yes.id);
    expect(delivered).toMatchObject({ state: "delivered", sessionId: expect.any(String) });
    const text = userTexts(delivered.sessionId!)[0]!;
    expect(text).toMatch(/^【传话 #\d+ · 事项 \d+「先迁数据表，界面等我通知」】来自任务「迁移主控」/);
    expect(text).toContain("先迁数据表，界面等我通知");
    expect(text).toContain("mailbox_send 带 replyTo");
    // Delivered: no 「传话已送到」 mail any more — its receipt says so.
    expect(lastMail()).toBeUndefined();
    expect(store.getMail(yes.mailId!)?.receipts?.[0]).toMatchObject({ party: `agent:${delivered.sessionId}`, state: expect.stringMatching(/^(delivered|seen|handled)$/) });
    await expect(service.relays.deliver(yes.id)).rejects.toThrow(/decided already/);
  });

  it("goes at once to a task of the same topic (2026-11-25: relayAuto turned round), into its session; one only on the canvas waits unless the task takes relays", async () => {
    const opened = service.relays.send(leadSession.id, { taskId: target.id, text: "开始" });
    await until(() => store.getRelay(opened.id)?.state === "delivered");
    // The person cannot send it in a second time.
    await expect(service.relays.deliver(opened.id)).rejects.toThrow(/decided already/);
    const first = store.getRelay(opened.id)!;
    const sent = service.relays.send(leadSession.id, { taskId: target.id, text: "计划改了：先做界面" });
    await until(() => store.getRelay(sent.id)?.state === "delivered");
    expect(store.getRelay(sent.id)!.sessionId).toBe(first.sessionId);
    await until(() => userTexts(first.sessionId!).at(-1)?.includes("计划改了：先做界面") === true);
    // A task of another topic, referenced on this topic's canvas: the person confirms, unless relayAuto is on.
    const elsewhere = service.topics.createTopic({ title: "别的专题" });
    const ref = store.createTask({ title: "引用来的", workspaceId: alpha.id, topicId: elsewhere.id });
    store.putCanvas({ ...emptyCanvas(topic.id), nodes: [{ id: "n1", kind: "ref", taskId: ref.id, groupId: null, pos: { x: 0, y: 0 } }] });
    expect(service.relays.goesAtOnce(leadSession.id, ref.id)).toBe(false);
    service.tasks.updateTask(ref.id, { relayAuto: true });
    expect(service.relays.goesAtOnce(leadSession.id, ref.id)).toBe(true);
  });

  it("a 委派's answer comes back to the 主控 by itself: replyTo from the task, and the reply of the turn that read it", { timeout: 15_000 }, async () => {
    const relay = service.relays.send(leadSession.id, { taskId: target.id, text: "数一下装甲车有几张表" });
    await until(() => store.getRelay(relay.id)?.state === "delivered");
    const worker = store.getRelay(relay.id)!.sessionId!;
    const mail = store.getMail(relay.mailId!)!;
    // The turn that read it reports its reply into the 主控's conversation, in the same 事项.
    await until(() => userTexts(leadSession.id).some((t) => t.includes("这一轮做完了")));
    const report = userTexts(leadSession.id).find((t) => t.includes("这一轮做完了"))!;
    expect(report).toMatch(/^【结果 #\d+ · 事项 1「数一下装甲车有几张表」】来自任务「装甲车」/);
    expect(report).toContain("FAKE:");
    const inMatter = store.listMailInMatter(mail.matter!);
    expect(inMatter.map((m) => m.via)).toEqual(["relay", "report"]);
    expect(inMatter[1]).toMatchObject({ fromSessionId: worker, replyTo: mail.seq });
    // The task answers with replyTo: no address, it goes to the 主控 (same topic: at once), in the same 事项.
    await until(() => store.getSession(worker)?.status === "idle");
    const answer = await service.collab.sendFromSession(worker, { replyTo: `#${mail.seq}`, text: "一共 3 张" });
    expect(answer).toMatchObject({ matter: mail.matter, replyTo: mail.seq, to: { kind: "session", sessionId: leadSession.id } });
    await until(() => userTexts(leadSession.id).some((t) => t.includes("一共 3 张")));
    // Answered: the 传话 is 处理了 for the task.
    expect(store.getMail(mail.id)!.receipts![0]).toMatchObject({ party: `agent:${worker}`, state: "handled" });
  });

  it("通知 needs no answer: read, it is 处理了, and it does not report back", { timeout: 15_000 }, async () => {
    const relay = service.relays.send(leadSession.id, { taskId: target.id, text: "下周一合主干", kind: "notice" });
    await until(() => store.getRelay(relay.id)?.state === "delivered");
    const mail = store.getMail(relay.mailId!)!;
    await until(() => store.getMail(mail.id)!.receipts![0]!.state === "handled");
    await new Promise((r) => setTimeout(r, 300));
    expect(userTexts(leadSession.id).some((t) => t.includes("这一轮做完了"))).toBe(false);
    expect(store.getMatter(mail.matter!)?.status).toBe("closed");
    expect(() => service.relays.send(leadSession.id, { taskId: target.id, text: "x", kind: "nope" })).toThrow(/kind must be/);
  });
});
