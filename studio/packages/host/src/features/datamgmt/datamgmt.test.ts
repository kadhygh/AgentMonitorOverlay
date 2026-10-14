import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectWorkspaces, type CanvasDoc, type ModelProfile, type Session, type Task } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

// 设置 → 数据管理 and archived projects (2026-10-14).

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

let root: string;
let servers: FakeServers;
let store: Store;
let host: HostService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-data-"));
  for (const dir of ["alpha", "beta"]) mkdirSync(join(root, dir));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  host = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
});

afterEach(async () => {
  store?.close();
  await servers?.close();
  removeTempDir(root);
});

function session(owner: { taskId?: string; topicId?: string }, workspaceId: string, title: string, parentId: string | null = null): Session {
  return store.createSession({
    taskId: owner.taskId ?? null,
    topicId: owner.topicId ?? null,
    parentId,
    kind: parentId ? "fork" : "main",
    runtime: "codex",
    profileId: "p-ds",
    workspaceId,
    title,
    status: "idle",
    writer: "workbench",
    runtimeRef: null,
  });
}

function say(sessionId: string, text: string): void {
  store.appendItem({ id: `i-${sessionId}-${text}`, sessionId, type: "user", text, createdAt: new Date().toISOString() } as never);
}

async function setup() {
  const alpha = host.projects.addWorkspace({ path: join(root, "alpha") });
  const beta = host.projects.addWorkspace({ path: join(root, "beta") });
  const topic = host.topics.createTopic({ title: "数值" });
  const t1 = (await host.tasks.createTask({ title: "掉落表", workspaceId: alpha.id, topicId: topic.id })).task;
  const t2 = (await host.tasks.createTask({ title: "导入重试", workspaceId: alpha.id })).task;
  const t3 = (await host.tasks.createTask({ title: "别的项目", workspaceId: beta.id })).task;
  const s1 = session({ taskId: t1.id }, alpha.id, "掉落");
  const s1f = session({ taskId: t1.id }, alpha.id, "掉落分支", s1.id);
  const s2 = session({ taskId: t2.id }, alpha.id, "导入");
  const s3 = session({ taskId: t3.id }, beta.id, "beta");
  const st = session({ topicId: topic.id }, alpha.id, "专题会话");
  return { alpha, beta, topic, t1, t2, t3, s1, s1f, s2, s3, st };
}

const task = (id: string): Task | undefined => store.getTask(id);

describe("archived projects", () => {
  it("take their tasks and topic sessions along, leave every list, and come back with what went with them", async () => {
    const x = await setup();
    await host.tasks.archiveTask(x.t2.id);
    const before = store.getTask(x.t2.id)!.archivedAt!;

    const { workspace, tasks } = await host.projects.archiveWorkspace(x.alpha.id);
    expect(workspace.archivedAt).toBeTruthy();
    expect(tasks.map((t) => t.id)).toEqual([x.t1.id]);
    expect(store.getSession(x.s1f.id)!.archivedAt).toBeTruthy();
    expect(store.getSession(x.st.id)!.archivedAt).toBeTruthy();
    expect(task(x.t3.id)!.archivedAt).toBeNull();
    expect(projectWorkspaces(store.listWorkspaces()).map((w) => w.name)).toEqual(["beta"]);
    await expect(host.tasks.createTask({ title: "新", workspaceId: x.alpha.id })).rejects.toMatchObject({ code: "read_only" });
    expect(() => host.projects.addWorkspace({ path: join(root, "alpha") })).toThrow(/已归档的项目/);
    expect(() => host.projects.archiveWorkspace(host.commonWorkspace().id)).rejects.toMatchObject({ code: "conflict" });

    // The topic itself is not archived, so its session comes back; the task archived before stays archived.
    await host.projects.unarchiveWorkspace(x.alpha.id);
    expect(store.getWorkspace(x.alpha.id)!.archivedAt).toBeUndefined();
    expect(task(x.t1.id)!.archivedAt).toBeNull();
    expect(store.getSession(x.s1f.id)!.archivedAt).toBeNull();
    expect(store.getSession(x.st.id)!.archivedAt).toBeNull();
    expect(task(x.t2.id)!.archivedAt).toBe(before);
  });
});

describe("数据管理", () => {
  it("lists archived things at the top of what would go with them", async () => {
    const x = await setup();
    await host.tasks.archiveTask(x.t3.id);
    await host.sessions.archive(x.s2.id);
    await host.topics.archiveTopic(x.topic.id);
    const list = host.data.archived();
    expect(list.map((e) => `${e.kind}:${e.title}`).sort()).toEqual(["session:导入", "task:别的项目", "topic:数值"]);
    expect(list.find((e) => e.kind === "task")!.context).toBe("项目 beta");
    expect(list.find((e) => e.kind === "session")!.context).toBe("任务 导入重试");
  });

  it("deletes an archived task with its sessions, records, cards and images, and nothing else", async () => {
    const x = await setup();
    const used = host.attachments.save(PNG, { mime: "image/png" });
    const shared = host.attachments.save(PNG, { mime: "image/png" });
    say(x.s1.id, `看图 ${used.id} ${shared.id}`);
    say(x.s1f.id, "分支里");
    say(x.s3.id, `也用了 ${shared.id}`);
    store.addTaskNote({ id: "n1", taskId: x.t1.id, sessionId: x.s1.id, kind: "progress", text: "进度", createdAt: new Date().toISOString() } as never);
    store.putTodo({ id: "todo1", text: "做掉落表", done: false, workspaceId: x.alpha.id, taskId: x.t1.id, createdAt: new Date().toISOString() });
    // A reference card to it on another topic's canvas, with a dependency.
    const other = host.topics.createTopic({ title: "别处" });
    const canvas: CanvasDoc = {
      id: other.id,
      version: 1,
      groups: [],
      nodes: [
        { id: "r1", kind: "ref", taskId: x.t1.id, groupId: null, pos: { x: 0, y: 0 } },
        { id: "c3", kind: "task", taskId: x.t3.id, groupId: null, pos: { x: 300, y: 0 } },
      ],
      edges: [{ id: "e1", kind: "depends", from: x.t1.id, to: x.t3.id }],
      updatedAt: new Date().toISOString(),
    };
    store.putCanvas(canvas);

    await expect(Promise.resolve().then(() => host.data.preview("task", x.t1.id))).rejects.toMatchObject({ code: "conflict" });
    await host.tasks.archiveTask(x.t1.id);
    const preview = host.data.preview("task", x.t1.id);
    expect(preview).toMatchObject({ tasks: 1, sessions: 2, items: 2, attachments: 2 });

    const seen: string[] = [];
    host.on("event", (e) => seen.push(e.type));
    const done = host.data.purge("task", x.t1.id);
    expect(done).toMatchObject({ kind: "task", title: "掉落表", sessions: 2, attachments: 1 });
    expect(seen).toContain("data.purged");
    expect(task(x.t1.id)).toBeUndefined();
    expect(store.getSession(x.s1.id)).toBeUndefined();
    expect(store.getSession(x.s1f.id)).toBeUndefined();
    expect(store.listItems(x.s1.id)).toEqual([]);
    expect(store.listTaskNotes(x.t1.id)).toEqual([]);
    expect(store.getTodo("todo1")).toMatchObject({ text: "做掉落表", taskId: null });
    const after = store.getCanvas(other.id)!;
    expect(after.nodes.map((n) => n.id)).toEqual(["c3"]);
    expect(after.edges).toEqual([]);
    expect(existsSync(used.path)).toBe(false);
    expect(existsSync(shared.path)).toBe(true);
    // Only the event that says it is gone still names it.
    expect(store.listEvents(0, 100000).filter((e) => JSON.stringify(e).includes(x.s1.id)).map((e) => e.type)).toEqual(["data.purged"]);
    // The rest is untouched.
    expect(store.listItems(x.s3.id)).toHaveLength(1);
    expect(task(x.t2.id)).toBeDefined();
  });

  it("refuses while something live hangs on it", async () => {
    const x = await setup();
    await host.sessions.archive(x.s1.id);
    await host.sessions.unarchive(x.s1f.id).catch(() => undefined);
    // A fork restored on its own keeps its parent.
    store.db.prepare("UPDATE sessions SET archived_at = NULL WHERE id = ?").run(x.s1f.id);
    expect(() => host.data.preview("session", x.s1.id)).toThrow(/还没归档|分出来/);
    expect(() => host.data.purge("workspace", host.commonWorkspace().id)).toThrow(/公共目录/);
    expect(() => host.data.purge("nope", "x")).toThrow(/kind/);
  });

  it("deletes an archived project with all its tasks, topic sessions, comments and marks; the topic stays", async () => {
    const x = await setup();
    host.topics.updateTopic(x.topic.id, { workspaceIds: [x.alpha.id, x.beta.id] });
    store.putFileMark({ id: "m1", path: join(root, "alpha", "a.txt"), workspaceId: x.alpha.id, startLine: null, endLine: null, note: "", order: 0, createdAt: new Date().toISOString() } as never);
    await host.projects.archiveWorkspace(x.alpha.id);
    expect(host.data.preview("workspace", x.alpha.id)).toMatchObject({ workspaces: 1, tasks: 2, sessions: 4 });
    host.data.purge("workspace", x.alpha.id);
    expect(store.getWorkspace(x.alpha.id)).toBeUndefined();
    expect(task(x.t1.id)).toBeUndefined();
    expect(task(x.t2.id)).toBeUndefined();
    expect(store.getSession(x.st.id)).toBeUndefined();
    expect(store.listFileMarks(x.alpha.id)).toEqual([]);
    expect(store.getTopic(x.topic.id)!.workspaceIds).toEqual([x.beta.id]);
    expect(task(x.t3.id)).toBeDefined();
    expect(existsSync(join(root, "alpha"))).toBe(true);
  });

  it("deletes an archived topic with its canvas, tasks and sessions", async () => {
    const x = await setup();
    store.putCanvas({ id: x.topic.id, version: 1, groups: [], nodes: [{ id: "c1", kind: "task", taskId: x.t1.id, groupId: null, pos: { x: 0, y: 0 } }], edges: [], updatedAt: new Date().toISOString() });
    await host.topics.archiveTopic(x.topic.id);
    expect(host.data.preview("topic", x.topic.id)).toMatchObject({ topics: 1, tasks: 1, sessions: 3 });
    host.data.purge("topic", x.topic.id);
    expect(store.getTopic(x.topic.id)).toBeUndefined();
    expect(store.getCanvas(x.topic.id)).toBeUndefined();
    expect(task(x.t1.id)).toBeUndefined();
    expect(store.getSession(x.st.id)).toBeUndefined();
    expect(task(x.t2.id)!.archivedAt).toBeNull();
  });
});
