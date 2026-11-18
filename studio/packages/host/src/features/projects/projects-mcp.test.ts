import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfile, Session, SessionStatus, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { amoCallOf } from "../../runtime/codex/asks.js";
import { ClaudeAsks } from "../../runtime/claude/asks.js";
import { amoApprovalNote, amoToolsFor } from "../../mcp/tools.js";
import { PROMPTED_WRITE_TOOLS } from "../../mcp/names.js";
import { textOf } from "../../mcp/tool-kit.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

// project_add / project_remove / project_group_save / project_group_delete (2026-11-18, the user: ai 可以添加工程和删除
// 工程、处理工程分组): what each does, what it refuses, and what the approval card says before anything changes.

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let alpha: Workspace;
let beta: Workspace;
let caller: Session;

function session(taskId: string | null, workspaceId: string, title: string, status: SessionStatus = "idle", topicId: string | null = null): Session {
  return store.createSession({ taskId, topicId, parentId: null, kind: "main", runtime: "codex", profileId: "p-ds", workspaceId, title, status, writer: "workbench", runtimeRef: null });
}

const tool = (name: string) => amoToolsFor(service, { sessionId: caller.id }).find((t) => t.name === name)!;
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await tool(name).run(args);
  const text = textOf(r.content[0]!);
  return { error: r.isError ? text : null, data: r.isError ? null : JSON.parse(text) };
};
const note = (name: string, args: Record<string, unknown>) => tool(name).approvalNote!(args);
const groups = () => service.config.projectGroups().map((g) => [g.name, g.workspaceIds.map((id) => store.getWorkspace(id)!.name)]);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-ai-projects-"));
  for (const name of ["alpha", "beta", "gamma"]) mkdirSync(join(root, name));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  alpha = service.projects.addWorkspace({ path: join(root, "alpha") });
  beta = service.projects.addWorkspace({ path: join(root, "beta") });
  // The asking session works in alpha, in a turn (it is the one calling).
  const own = (await service.tasks.createTask({ title: "维护", workspaceId: alpha.id })).task;
  caller = session(own.id, alpha.id, "值守主控", "running");
});

afterEach(async () => {
  await servers.close();
  store.close();
  removeTempDir(root);
});

describe("the tools", () => {
  it("all ask the person first (Codex prompts, DSH leaves them out), none is read-only", () => {
    for (const name of ["project_add", "project_remove", "project_group_save", "project_group_delete"]) {
      expect(tool(name).autoApprove).toBe(false);
      expect(tool(name).readOnly).toBe(false);
      expect(PROMPTED_WRITE_TOOLS).toContain(name);
    }
    // A caller Studio cannot tell (reading only) cannot use them.
    expect(textOf((amoToolsFor(service, null).find((t) => t.name === "project_add")!.run({ path: root }) as { content: never[] }).content[0]!)).toMatch(/只读/);
  });
});

describe("project_add", () => {
  it("registers a folder with its name, note and group", async () => {
    const g = service.config.saveProjectGroup({ name: "客户端" });
    expect(note("project_add", { path: join(root, "gamma"), name: "伽马", group: "客户端" })).toContain("放进项目分组「客户端」");
    const { data } = await call("project_add", { path: join(root, "gamma"), name: "伽马", description: "Unity 客户端", group: g.id });
    expect(data).toMatchObject({ added: true, group: "客户端", project: { name: "伽马", description: "Unity 客户端" } });
    const ws = store.getWorkspace(data.project.id)!;
    expect(ws).toMatchObject({ name: "伽马", description: "Unity 客户端", path: join(root, "gamma") });
    expect(groups()).toEqual([["客户端", ["伽马"]]]);
  });

  it("gives back a folder already registered, unchanged — also written in another case or with /", async () => {
    const before = store.listWorkspaces().length;
    const { data } = await call("project_add", { path: join(root, "alpha"), name: "新名字", description: "x" });
    expect(data).toMatchObject({ alreadyRegistered: true, project: { id: alpha.id, name: "alpha" } });
    const other = process.platform === "win32" ? join(root, "ALPHA").replaceAll("\\", "/") : join(root, "alpha") + "/";
    expect((await call("project_add", { path: other })).data).toMatchObject({ alreadyRegistered: true, project: { id: alpha.id } });
    expect(store.listWorkspaces().length).toBe(before);
    expect(store.getWorkspace(alpha.id)).toMatchObject({ name: "alpha" });
    expect(store.getWorkspace(alpha.id)?.description ?? "").toBe("");
  });

  it("refuses a folder that is not there, a group that is not there, an archived project — leaving nothing behind", async () => {
    const before = store.listWorkspaces().length;
    expect((await call("project_add", { path: join(root, "nope") })).error).toMatch(/not a directory/);
    expect((await call("project_add", { path: join(root, "gamma"), group: "没有这个" })).error).toMatch(/没有叫 没有这个 的项目分组/);
    expect((await call("project_add", { path: join(root, "gamma"), description: "x".repeat(2001) })).error).toMatch(/too long/);
    await service.projects.archiveWorkspace(beta.id);
    expect((await call("project_add", { path: join(root, "beta") })).error).toMatch(/已归档.*数据管理/);
    expect(store.listWorkspaces().length).toBe(before);
  });
});

describe("project_remove", () => {
  it("archives the project with its tasks, as 归档项目 does, and leaves the folder; the card says how many tasks", async () => {
    const t1 = (await service.tasks.createTask({ title: "掉落表", workspaceId: beta.id })).task;
    const t2 = (await service.tasks.createTask({ title: "导入重试", workspaceId: beta.id })).task;
    const s = session(t1.id, beta.id, "掉落");
    service.config.saveProjectGroup({ name: "工具", add: [beta.id] });
    const card = note("project_remove", { workspace: "beta" });
    expect(card).toContain("只取消登记，文件夹和里面的文件不动");
    expect(card).toMatch(/它的 2 个任务（「(掉落表|导入重试)」、「(掉落表|导入重试)」）和这些任务的会话一起归档/);
    expect(card).toContain("项目分组「工具」");
    const { data } = await call("project_remove", { workspace: beta.id });
    expect(data).toMatchObject({ removed: { id: beta.id }, archivedTasks: 2 });
    expect(store.getWorkspace(beta.id)?.archivedAt).toBeTruthy();
    expect([store.getTask(t1.id)?.archivedAt, store.getTask(t2.id)?.archivedAt, store.getSession(s.id)?.archivedAt].every(Boolean)).toBe(true);
    expect(existsSync(join(root, "beta"))).toBe(true);
    // Gone from what agents read; the group keeps it for when it is restored.
    expect((await call("project_context", {})).data.workspaces.map((w: { name: string }) => w.name)).not.toContain("beta");
    expect(service.config.projectGroups()[0]!.workspaceIds).toEqual([beta.id]);
    await service.projects.unarchiveWorkspace(beta.id);
    expect(store.getTask(t1.id)?.archivedAt).toBeFalsy();
  });

  it("refuses while a session of it is at work — its tasks' or a topic session in it, the caller's own included", async () => {
    const t = (await service.tasks.createTask({ title: "掉落表", workspaceId: beta.id })).task;
    const busy = session(t.id, beta.id, "跑着的", "running");
    const card = note("project_remove", { workspace: "beta" });
    expect(card).toContain("1 个会话还在运行或等人，Studio 会拒绝这次移除");
    expect((await call("project_remove", { workspace: "beta" })).error).toMatch(/还有 1 个会话在运行或等人（「跑着的」）/);
    expect(store.getWorkspace(beta.id)?.archivedAt).toBeFalsy();
    expect(store.getTask(t.id)?.archivedAt).toBeFalsy();
    store.updateSession(busy.id, { status: "idle" });
    const topic = service.topics.createTopic({ title: "专题" });
    session(null, beta.id, "专题会话", "awaiting-approval", topic.id);
    expect((await call("project_remove", { workspace: "beta" })).error).toMatch(/专题会话/);
    // Its own project: the caller is in a turn there.
    expect((await call("project_remove", { workspace: "alpha" })).error).toMatch(/「值守主控」/);
    expect(store.getWorkspace(alpha.id)?.archivedAt).toBeFalsy();
  });

  it("refuses the common space, an unknown project and one already archived", async () => {
    expect((await call("project_remove", { workspace: service.commonWorkspace().id })).error).toMatch(/公共空间/);
    expect((await call("project_remove", { workspace: "nope" })).error).toMatch(/not found/);
    await service.projects.archiveWorkspace(beta.id);
    expect((await call("project_remove", { workspace: "beta" })).error).toMatch(/not found/);
  });
});

describe("project groups", () => {
  it("are made, renamed, noted, filled, emptied, moved and removed; project_context reads them in order", async () => {
    const gamma = service.projects.addWorkspace({ path: join(root, "gamma") });
    expect(note("project_group_save", { name: "客户端", add: ["alpha"] })).toBe("新建项目分组「客户端」；放入 「alpha」。项目本身不动。");
    const client = (await call("project_group_save", { name: "客户端", description: "Unity", projects: ["alpha", join(root, "beta")] })).data.group;
    expect(client).toMatchObject({ name: "客户端", description: "Unity", projects: [{ name: "alpha" }, { name: "beta" }] });
    await call("project_group_save", { name: "工具", add: [gamma.id] });
    // A project is in one group: putting beta into 工具 takes it out of 客户端, and the card says so.
    expect(note("project_group_save", { id: "工具", add: ["beta"] })).toContain("「beta」从「客户端」移过来");
    await call("project_group_save", { id: "工具", add: ["beta"] });
    expect(groups()).toEqual([["客户端", ["alpha"]], ["工具", ["gamma", "beta"]]]);
    // Order inside a group, then the groups' order, a new name and an emptied note.
    await call("project_group_save", { id: "工具", projects: ["beta", "gamma"], position: 0, name: "工具链", description: "" });
    expect(groups()).toEqual([["工具链", ["beta", "gamma"]], ["客户端", ["alpha"]]]);
    expect(service.config.projectGroups()[0]!.description).toBe("");
    await call("project_group_save", { id: client.id, remove: ["alpha"] });
    expect(groups()).toEqual([["工具链", ["beta", "gamma"]], ["客户端", []]]);
    const ctx = (await call("project_context", {})).data;
    expect(ctx.groups).toEqual([expect.objectContaining({ name: "工具链", projects: ["beta", "gamma"] }), expect.objectContaining({ name: "客户端", projects: [] })]);
    expect((await call("project_context", { workspace: "beta" })).data.group).toMatchObject({ name: "工具链" });
    // Removing a group leaves its projects ungrouped; the card names them.
    expect(note("project_group_delete", { id: "工具链" })).toBe("删除项目分组「工具链」：里面的 2 个项目 「beta」、「gamma」 回到未分组；项目本身不动。");
    expect((await call("project_group_delete", { id: "工具链" })).data).toMatchObject({ removed: { name: "工具链" }, ungrouped: ["beta", "gamma"] });
    expect(groups()).toEqual([["客户端", []]]);
    expect(store.listWorkspaces().filter((w) => !w.archivedAt).length).toBe(4);
  });

  it("refuses what is not there or not allowed, changing nothing", async () => {
    await call("project_group_save", { name: "客户端", add: ["alpha"] });
    const before = JSON.stringify(service.config.projectGroups());
    expect((await call("project_group_save", { id: "没有这个", name: "x" })).error).toMatch(/没有叫 没有这个 的项目分组；现有的：客户端/);
    expect((await call("project_group_save", { name: " " })).error).toMatch(/name is required/);
    expect((await call("project_group_save", { id: "客户端", add: ["nope"] })).error).toMatch(/not found/);
    expect((await call("project_group_save", { id: "客户端", add: [service.commonWorkspace().id] })).error).toMatch(/公共空间/);
    expect((await call("project_group_save", { id: "客户端", position: -1 })).error).toMatch(/position/);
    expect((await call("project_group_delete", { id: "没有这个" })).error).toMatch(/没有叫/);
    expect(JSON.stringify(service.config.projectGroups())).toBe(before);
  });

  it("keeps an archived project in its group when the list is set again", async () => {
    await call("project_group_save", { name: "客户端", projects: ["alpha", "beta"] });
    await service.projects.archiveWorkspace(beta.id);
    await call("project_group_save", { id: "客户端", projects: ["alpha"] });
    expect(service.config.projectGroups()[0]!.workspaceIds).toEqual([alpha.id, beta.id]);
  });
});

describe("the approval card", () => {
  it("is only read before the person answers: making it changes nothing", () => {
    const t = store.listTasks().length;
    const ws = JSON.stringify(store.listWorkspaces());
    note("project_add", { path: join(root, "gamma") });
    note("project_remove", { workspace: "beta" });
    note("project_group_save", { name: "x", add: ["alpha"] });
    expect(store.listTasks().length).toBe(t);
    expect(JSON.stringify(store.listWorkspaces())).toBe(ws);
    expect(service.config.projectGroups()).toEqual([]);
  });

  it("gives no note for another server's tools or a call it cannot describe", () => {
    const tools = amoToolsFor(service, { sessionId: caller.id });
    expect(amoApprovalNote(tools, "project_remove", { workspace: "nope" })).toBeUndefined();
    expect(amoApprovalNote(tools, "duty_save", {})).toBeUndefined();
    expect(amoApprovalNote(tools, "project_group_delete", { id: "x" })).toBeUndefined();
  });

  it("shows the note in a Claude session's card; declined, the tool does not run", async () => {
    const appended: Array<Record<string, unknown>> = [];
    const core = {
      appendItem: (_s: string, body: Record<string, unknown>) => (appended.push(body), { id: "item-1", ...body }),
      setStatus: () => undefined,
      updateItem: () => undefined,
      requireSession: () => caller,
      approvalNote: (_s: string, name: string, input: Record<string, unknown>) => amoApprovalNote(amoToolsFor(service, { sessionId: caller.id }), name.replace("mcp__amo__", ""), input),
    };
    const asks = new ClaudeAsks(core as never);
    const live = { approvals: new Map<string, { resolve(r: unknown): void }>(), questions: new Map(), askedTools: new Set() };
    const answer = asks.askPerson(caller.id, live as never, "mcp__amo__project_remove", { workspace: "beta" }, { signal: new AbortController().signal, toolUseID: "tu-1" });
    expect(appended[0]).toMatchObject({ type: "approval", kind: "permissions" });
    expect(String(appended[0]!.detail)).toContain("从 Studio 里移除项目「beta」");
    live.approvals.get("tu-1")!.resolve({ behavior: "deny", message: "declined" });
    expect(await answer).toMatchObject({ behavior: "deny" });
    expect(store.getWorkspace(beta.id)?.archivedAt).toBeFalsy();
  });

  it("finds the AMO call in a Codex approval when Codex passes its arguments", () => {
    const message = 'Allow the amo MCP server to run tool "project_remove"?';
    expect(amoCallOf({ serverName: "amo", message, _meta: { tool_params: { workspace: "beta" } } })).toEqual({ tool: "project_remove", args: { workspace: "beta" } });
    expect(amoCallOf({ serverName: "amo", message, _meta: null })).toBeNull();
    expect(amoCallOf({ serverName: "other", message, _meta: { tool_params: {} } })).toBeNull();
  });
});
