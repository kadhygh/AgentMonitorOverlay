import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyCanvas, splitRoleUpdate, type ModelProfile, type Session, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { McpIdentities } from "../../mcp/identity.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { noteOwnDescription, recordRole, roleCard, roleCardFor } from "./role.js";

// 2026-10-17: Codex threads start with the role card as developer instructions; a task's later changes (topic, canvas
// references, 主控, 说明) come with the session's next message; a 主控 relays to tasks referenced on its canvas.

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let alpha: Workspace;
let topic: Topic;
let task: Task;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-role-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  // Wired as host-process does.
  const runtime = new CodexRuntime({
    store,
    servers,
    profiles: PROFILES,
    identities: new McpIdentities(store),
    roleInstructions: (draft) => roleCardFor(service, { ...draft, kind: "main", runtime: "codex" }),
    roleGiven: (sessionId) => recordRole(service, sessionId),
  });
  service = new HostService(store, runtime, PROFILES, { commonDir: join(root, "common") });
  mkdirSync(join(root, "alpha"));
  alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
  topic = service.topics.createTopic({ title: "迁移" });
  task = store.createTask({ title: "装甲车", workspaceId: alpha.id });
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
const start = (taskId: string, text = "开始") => service.tasks.startSession({ taskId, topicId: null }, alpha, { profileId: "p-ds", text });
const send = async (session: Session, text: string) => {
  const before = userTexts(session.id).length;
  await service.sessions.sendMessage(session.id, text);
  await until(() => userTexts(session.id).length > before);
  return userTexts(session.id).at(-1)!;
};
const reference = (topicId: string, taskId: string) =>
  store.putCanvas({ ...emptyCanvas(topicId), nodes: [{ id: `r-${taskId}`, kind: "ref", taskId, groupId: null, pos: { x: 0, y: 0 } }] });

describe("role card (2026-10-17)", () => {
  it("starts a Codex thread with the session's role card as developer instructions", async () => {
    await start(task.id);
    const call = servers.fakes.get("p-ds")!.calls.find((c) => c.method === "thread/start")!;
    const instructions = (call.params as { developerInstructions?: string }).developerInstructions;
    expect(instructions).toContain("你在 AMO Studio 里的角色：执行");
    expect(instructions).toContain("任务：装甲车");
    expect(instructions).toContain("新会话");
  });

  it("tells the session what changed with its next message, once", async () => {
    const session = await start(task.id);
    expect(splitRoleUpdate(await send(session, "继续")).update).toBeNull();

    // Referenced on a topic's canvas: the card says so, and the next message too.
    reference(topic.id, task.id);
    expect(roleCard(service, session.id)).toContain("也被引用在专题「迁移」");
    const referenced = splitRoleUpdate(await send(session, "接着做"));
    expect(referenced.text).toBe("接着做");
    expect(referenced.update).toContain("任务被引用到了专题「迁移」");
    expect(splitRoleUpdate(await send(session, "再来")).update).toBeNull();

    // Moved into the topic, made its 主控, described: all in one note.
    service.tasks.updateTask(task.id, { topicId: topic.id });
    service.tasks.updateTask(task.id, { lead: true, description: "迁移装甲车的数据表" });
    const update = splitRoleUpdate(await send(session, "看看")).update!;
    expect(update).toContain("你现在是「主控」（之前是「执行」）");
    expect(update).toContain("任务现在在专题「迁移」");
    expect(update).toContain("任务说明改成了：迁移装甲车的数据表");
    expect(update).not.toContain("不再在");
    expect(update).toContain("amo_whoami");
  });

  it("does not tell a session the 说明 it wrote itself, but still tells its other changes and the task's other sessions", async () => {
    const writer = await start(task.id);
    const other = await start(task.id, "另一个");
    reference(topic.id, task.id);
    service.tasks.updateTask(task.id, { description: "合入策划分支" });
    noteOwnDescription(service, writer.id);
    const own = splitRoleUpdate(await send(writer, "提交吧")).update!;
    expect(own).toContain("任务被引用到了专题「迁移」");
    expect(own).not.toContain("任务说明");
    expect(splitRoleUpdate(await send(other, "继续")).update).toContain("任务说明改成了：合入策划分支");
  });

  it("only notes a session it never told (one from before), without a note", async () => {
    const session = await start(task.id);
    store.setKv(`role-stamp:${session.id}`, "");
    service.tasks.updateTask(task.id, { description: "新说明" });
    expect(splitRoleUpdate(await send(session, "一")).update).toBeNull();
    service.tasks.updateTask(task.id, { description: "再改" });
    expect(splitRoleUpdate(await send(session, "二")).update).toContain("任务说明改成了：再改");
  });

  it("lets a 主控 relay to a task its canvas references", async () => {
    const lead = store.createTask({ title: "迁移主控", workspaceId: alpha.id, topicId: topic.id, lead: true });
    const leadSession = await start(lead.id);
    expect(() => service.relays.send(leadSession.id, { taskId: task.id, text: "x" })).toThrow(/不在你的专题里/);
    reference(topic.id, task.id);
    expect(service.relays.send(leadSession.id, { taskId: task.id, text: "先做数据" })).toMatchObject({ state: "pending", toTaskId: task.id });
  });
});
