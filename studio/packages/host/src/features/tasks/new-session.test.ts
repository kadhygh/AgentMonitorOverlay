import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfile, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { ReadModel } from "../../mcp/read-model.js";

// 新会话 dialog (2026-11-17): a new session's name, and its MCP checked on the one path every new session takes
// (TasksFeature.startSession) — the dialog, the new-task page, a paired device, session_start.

const PROFILES: ModelProfile[] = [
  { id: "p", label: "P", runtime: "codex", provider: "amo-ds", model: "ds-model" },
  { id: "c", label: "C", runtime: "claude", provider: null, model: null },
];

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let alpha: Workspace;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-new-session-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  const runtime = new CodexRuntime({ store, servers, profiles: PROFILES });
  // Sessions on "c" (a Claude model, whose MCP is picked per session) run on the fake Codex server as "p" with what they were given.
  const start = runtime.startSession.bind(runtime);
  runtime.startSession = (input) => start({ ...input, profileId: input.profileId === "c" ? "p" : input.profileId });
  service = new HostService(store, runtime, PROFILES, { commonDir: join(root, "common") });
  mkdirSync(join(root, "alpha"));
  alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
  service.mcp.create({ name: "figma", spec: { type: "stdio", command: "npx", args: ["figma-mcp"], env: { FIGMA_KEY: "sk-secret" } }, note: "设计稿" });
  service.mcp.create({ name: "webtool", spec: { type: "http", url: "https://mcp.example.com/x" }, on: false });
});

afterEach(async () => {
  await servers.close();
  store.close();
  removeTempDir(root);
});

describe("拖拽排序 (2026-11-17)", () => {
  const ids = (taskId: string, parent: string | null = null) => {
    const live = store.listSessions({ taskId }).filter((s) => !s.archivedAt && (s.parentId ?? s.startedBy ?? null) === parent);
    return live.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.createdAt.localeCompare(b.createdAt)).map((s) => s.id);
  };

  it("saves a level's order, kept after a restart; a new session goes to the end; times and Focus's order are left alone", async () => {
    const { task } = await service.tasks.createTask({ workspaceId: alpha.id, title: "任务" });
    const one = await service.tasks.addSession(task.id, { profileId: "p", title: "一" });
    const two = await service.tasks.addSession(task.id, { profileId: "p", title: "二" });
    const three = await service.tasks.addSession(task.id, { profileId: "p", title: "三" });
    const before = store.getSession(one.id)!.updatedAt;
    const events: string[] = [];
    service.on("event", (e) => {
      if (e.type === "session.upserted") events.push(e.session.id);
    });
    const changed = await service.tasks.orderSessions(task.id, { order: [three.id, one.id, two.id] });
    expect(changed.map((s) => s.id).sort()).toEqual([one.id, two.id, three.id].sort());
    expect(events.sort()).toEqual([one.id, two.id, three.id].sort());
    expect(ids(task.id)).toEqual([three.id, one.id, two.id]);
    expect(store.getSession(one.id)!.updatedAt).toBe(before);
    // Named in part: the rest of the level keeps its order after them; nothing else moves, nothing else is told.
    events.length = 0;
    await service.tasks.orderSessions(task.id, { order: [two.id] });
    expect(ids(task.id)).toEqual([two.id, three.id, one.id]);
    // The tree everyone reads (the list, the agents' session_tree) follows it.
    expect(new ReadModel(service).sessionTree(task.id).sessions.map((n) => n.id)).toEqual([two.id, three.id, one.id]);
    const four = await service.tasks.addSession(task.id, { profileId: "p", title: "四" });
    expect(ids(task.id)).toEqual([two.id, three.id, one.id, four.id]);
    // After a restart (the same database opened again).
    const path = join(root, "studio.db");
    const again = new Store(path);
    try {
      const live = again.listSessions({ taskId: task.id }).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.createdAt.localeCompare(b.createdAt));
      expect(live.map((s) => s.id)).toEqual([two.id, three.id, one.id, four.id]);
    } finally {
      again.close();
    }
  });

  it("only within one level: sessions under one session among themselves; never across levels, never under another", async () => {
    const { task } = await service.tasks.createTask({ workspaceId: alpha.id, title: "任务" });
    const parent = await service.tasks.addSession(task.id, { profileId: "p", title: "上面" });
    const other = await service.tasks.addSession(task.id, { profileId: "p", title: "另一个" });
    const sub = (title: string) => store.createSession({ taskId: task.id, topicId: null, parentId: parent.id, kind: "fork", runtime: "codex", profileId: "p", workspaceId: alpha.id, title, status: "idle", writer: "workbench", runtimeRef: null });
    const x = sub("x");
    const y = sub("y");
    await service.tasks.orderSessions(task.id, [y.id, x.id]);
    expect(ids(task.id, parent.id)).toEqual([y.id, x.id]);
    expect(ids(task.id)).toEqual([parent.id, other.id]);
    await expect(service.tasks.orderSessions(task.id, [other.id, x.id])).rejects.toThrow("只能在同一层里调整顺序");
    await expect(service.tasks.orderSessions(task.id, [x.id, parent.id])).rejects.toThrow("只能在同一层里调整顺序");
    expect(store.getSession(x.id)!.parentId).toBe(parent.id);
    await expect(service.tasks.orderSessions(task.id, ["s-nope"])).rejects.toThrow("没有会话");
    await expect(service.tasks.orderSessions(task.id, [x.id, x.id])).rejects.toThrow("重复");
    await expect(service.tasks.orderSessions(task.id, [])).rejects.toThrow("order");
    // An archived session is out of the list; an archived task takes no new order.
    await service.sessions.archive(other.id);
    await expect(service.tasks.orderSessions(task.id, [other.id])).rejects.toThrow("没有会话");
    await service.tasks.archiveTask(task.id);
    await expect(service.tasks.orderSessions(task.id, [parent.id])).rejects.toThrow("已归档");
  });
});

describe("新会话 (2026-11-17)", () => {
  it("takes the name given (trimmed); blank or none, the session is named as before", async () => {
    const { task } = await service.tasks.createTask({ workspaceId: alpha.id, title: "任务" });
    const named = await service.tasks.addSession(task.id, { profileId: "p", title: "  查日志  " });
    expect(store.getSession(named.id)!.title).toBe("查日志");
    const blank = await service.tasks.addSession(task.id, { profileId: "p", title: "   " });
    const none = await service.tasks.addSession(task.id, { profileId: "p" });
    expect(store.getSession(blank.id)!.title).toBe(store.getSession(none.id)!.title);
  });

  it("offers the MCP a new session would have — names, sources, notes, on — nothing to run them with; Codex's to read only", async () => {
    const { task } = await service.tasks.createTask({ workspaceId: alpha.id, title: "任务" });
    const offer = service.mcp.offer(task.workspaceId, task.id, "c");
    expect(offer).toEqual({ perSession: true, entries: [{ name: "figma", source: "studio", note: "设计稿", on: true, inherited: true }, { name: "webtool", source: "studio", on: false, inherited: false }] });
    expect(JSON.stringify(offer)).not.toMatch(/sk-secret|npx|mcp\.example|summary|FIGMA_KEY/);
    expect(service.mcp.offer(null, null, "p").perSession).toBe(false);
  });

  it("checks the MCP asked for: names of the project's list only, none for Codex; the task's latest choices go under it", async () => {
    const { task } = await service.tasks.createTask({ workspaceId: alpha.id, title: "任务" });
    const first = await service.tasks.addSession(task.id, { profileId: "c", options: { mcp: { webtool: true } } });
    expect(store.getSession(first.id)!.options.mcp).toEqual({ webtool: true });
    // The next one inherits webtool and adds its own choice.
    const second = await service.tasks.addSession(task.id, { profileId: "c", options: { mcp: { figma: false } } });
    expect(store.getSession(second.id)!.options.mcp).toEqual({ webtool: true, figma: false });
    const count = store.listSessions({ taskId: task.id }).length;
    await expect(service.tasks.addSession(task.id, { profileId: "c", options: { mcp: { nope: true } } })).rejects.toThrow("没有这个 MCP：nope");
    await expect(service.tasks.addSession(task.id, { profileId: "p", options: { mcp: { figma: true } } })).rejects.toThrow("Codex 的 MCP");
    expect(store.listSessions({ taskId: task.id })).toHaveLength(count);
    // A new task's first session (the new-task page's MCP row) too.
    const made = await service.tasks.createTask({ workspaceId: alpha.id, firstSession: { profileId: "c", text: "开始", options: { mcp: { webtool: true } } } });
    expect(store.getSession(made.session!.id)!.options.mcp).toEqual({ webtool: true });
    await expect(service.tasks.createTask({ workspaceId: alpha.id, firstSession: { profileId: "c", text: "开始", options: { mcp: { nope: true } } } })).rejects.toThrow("没有这个 MCP：nope");
  });

  it("a choice inherited for a server removed since does not stop a new session", async () => {
    const { task } = await service.tasks.createTask({ workspaceId: alpha.id, title: "任务" });
    await service.tasks.addSession(task.id, { profileId: "c", options: { mcp: { webtool: true } } });
    const web = service.mcp.state().servers.find((s) => s.name === "webtool")!;
    service.mcp.remove(web.id);
    const next = await service.tasks.addSession(task.id, { profileId: "c", options: { mcp: { figma: false } } });
    expect(store.getSession(next.id)!.options.mcp).toMatchObject({ figma: false });
  });
});
