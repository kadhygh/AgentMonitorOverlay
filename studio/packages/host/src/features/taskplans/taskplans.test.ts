import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostEvent, ModelProfile, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

// Stage 16: a 主控 proposes splitting the work into tasks; the person accepts (changed) or dismisses it.

const PROFILES: ModelProfile[] = [
  { id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" },
  { id: "p-gpt", label: "GPT Sol", runtime: "codex", provider: "amo-ds", model: "gpt-sol" },
];

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let events: HostEvent[];
let alpha: Workspace;
let beta: Workspace;
let topic: Topic;
let leadTask: Task;
let leadSession: Session;
let worker: Session;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-taskplans-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  events = [];
  service.on("event", (e) => events.push(e));
  for (const name of ["alpha", "beta"]) mkdirSync(join(root, name));
  alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
  beta = store.addWorkspace({ path: join(root, "beta"), name: "beta" });
  topic = service.topics.createTopic({ title: "迁移" });
  leadTask = store.createTask({ title: "迁移主控", workspaceId: alpha.id, topicId: topic.id, lead: true });
  const workerTask = store.createTask({ title: "执行", workspaceId: alpha.id, topicId: topic.id });
  const session = (taskId: string) => store.createSession({ taskId, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "p-ds", workspaceId: alpha.id, title: "", status: "idle", writer: "workbench", runtimeRef: `thr-${taskId}` });
  leadSession = session(leadTask.id);
  worker = session(workerTask.id);
});

afterEach(async () => {
  await servers.close();
  store.close();
  removeTempDir(root);
});

const proposal = {
  summary: "把装甲车迁到两个项目",
  tasks: [
    { key: "a", title: "装甲车数据", project: "alpha", description: "先迁数据", firstMessage: "迁装甲车的数据表", model: "GPT Sol" },
    { key: "b", title: "装甲车界面", project: "beta", dependsOn: ["a"] },
    { key: "c", title: "弹射闪电" },
  ],
};

describe("task plans (拆任务提案)", () => {
  it("takes a proposal only from a 主控, and checks it", () => {
    expect(() => service.taskPlans.propose(worker.id, proposal)).toThrow(/只有主控/);
    expect(() => service.taskPlans.propose(leadSession.id, { ...proposal, summary: " " })).toThrow(/summary/);
    expect(() => service.taskPlans.propose(leadSession.id, { summary: "x", tasks: [{ title: "a", project: "nope" }] })).toThrow(/project nope/);
    expect(() => service.taskPlans.propose(leadSession.id, { summary: "x", tasks: [{ title: "a", model: "nope" }] })).toThrow(/DS, GPT Sol/);
    expect(() => service.taskPlans.propose(leadSession.id, { summary: "x", tasks: [{ key: "a", title: "a", dependsOn: ["b"] }, { key: "b", title: "b", dependsOn: ["a"] }] })).toThrow(/cycle/);
    const plan = service.taskPlans.propose(leadSession.id, proposal);
    expect(plan).toMatchObject({ topicId: topic.id, fromSessionId: leadSession.id, fromTaskId: leadTask.id, state: "open" });
    expect(plan.tasks.map((t) => [t.key, t.workspaceId, t.profileId, t.dependsOn])).toEqual([
      ["a", alpha.id, "p-gpt", []],
      ["b", beta.id, "p-ds", ["a"]],
      ["c", alpha.id, "p-ds", []],
    ]);
    expect(service.taskPlans.list().map((p) => p.id)).toEqual([plan.id]);
    expect(events.some((e) => e.type === "taskplan.upserted")).toBe(true);
  });

  it("accepts it as changed: tasks with descriptions, on the canvas in a group per project, dependencies, and mail to the 主控", async () => {
    const plan = service.taskPlans.propose(leadSession.id, proposal);
    const accepted = await service.taskPlans.accept(plan.id, {
      run: false,
      tasks: [{ ...plan.tasks[0]!, title: "装甲车数据表" }, { ...plan.tasks[1]! }, { ...plan.tasks[2]!, include: false }],
    });
    expect(accepted.state).toBe("accepted");
    expect(accepted.created!.map((c) => c.key)).toEqual(["a", "b"]);
    const [data, ui] = accepted.created!.map((c) => store.getTask(c.taskId)!);
    expect(data).toMatchObject({ title: "装甲车数据表", workspaceId: alpha.id, topicId: topic.id, column: "todo", description: "先迁数据" });
    expect(ui).toMatchObject({ title: "装甲车界面", workspaceId: beta.id, column: "todo" });
    expect(store.listSessions({ taskId: data!.id })).toEqual([]);
    const canvas = service.canvases.canvas(topic.id);
    expect(canvas.groups.map((g) => g.title).sort()).toEqual(["alpha", "beta"]);
    expect(canvas.nodes.filter((n) => n.kind === "task").map((n) => [n.kind === "task" && n.taskId, canvas.groups.find((g) => g.id === n.groupId)?.title])).toEqual([
      [data!.id, "alpha"],
      [ui!.id, "beta"],
    ]);
    expect(canvas.edges.map((e) => [e.from, e.to])).toEqual([[data!.id, ui!.id]]);
    const mail = service.collab.readMailFromSession(leadSession.id);
    expect(mail.at(-1)!.text).toContain("建了 2 个任务（1 个没有采用）");
    expect(mail.at(-1)!.text).toContain(data!.id);
    await expect(service.taskPlans.accept(plan.id, { run: false })).rejects.toThrow(/decided already/);
  });

  it("dismisses it with a note the 主控 reads", () => {
    const plan = service.taskPlans.propose(leadSession.id, proposal);
    expect(service.taskPlans.dismiss(plan.id, { note: "先只做装甲车" })).toMatchObject({ state: "dismissed", note: "先只做装甲车" });
    expect(service.collab.readMailFromSession(leadSession.id).at(-1)!.text).toBe("人没有采用你的拆任务提案「把装甲车迁到两个项目」：先只做装甲车");
    expect(store.listTasks().length).toBe(2);
  });
});
