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
    // Archiving the caller leaves the sessions it started alone.
    await service.sessions.archive(caller.id);
    expect(store.getSession(s.id)?.archivedAt).toBeNull();
    // No report asked: nothing comes back into the caller.
    await new Promise((r) => setTimeout(r, 300));
    expect(userTexts(caller.id).some((t) => t.includes("这一轮做完了"))).toBe(false);
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
