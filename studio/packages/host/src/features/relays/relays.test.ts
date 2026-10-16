import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfile, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
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

  it("waits for the person: dismissed, or delivered into a new session (none yet), marked as from the 主控", async () => {
    const no = service.relays.send(leadSession.id, { taskId: target.id, text: "不用了" });
    expect(service.relays.dismiss(no.id).state).toBe("dismissed");
    expect(lastMail()).toBe("人没有让你的传话送到「装甲车」。");
    const yes = service.relays.send(leadSession.id, { taskId: target.id, text: "先迁数据表，界面等我通知" });
    const delivered = await service.relays.deliver(yes.id);
    expect(delivered).toMatchObject({ state: "delivered", sessionId: expect.any(String) });
    const text = userTexts(delivered.sessionId!)[0]!;
    expect(text).toContain("【主控「迁移主控」传话】");
    expect(text).toContain("先迁数据表，界面等我通知");
    expect(text).toContain("mailbox_send");
    expect(lastMail()).toBe("传话已送到「装甲车」。");
    await expect(service.relays.deliver(yes.id)).rejects.toThrow(/decided already/);
  });

  it("goes at once to a task that takes relays without asking, into its session", async () => {
    const first = await service.relays.deliver(service.relays.send(leadSession.id, { taskId: target.id, text: "开始" }).id);
    service.tasks.updateTask(target.id, { relayAuto: true });
    const sent = service.relays.send(leadSession.id, { taskId: target.id, text: "计划改了：先做界面" });
    await until(() => store.getRelay(sent.id)?.state === "delivered");
    expect(store.getRelay(sent.id)!.sessionId).toBe(first.sessionId);
    expect(userTexts(first.sessionId!).at(-1)).toContain("计划改了：先做界面");
  });
});
