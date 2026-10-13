import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { composeAnnotationMessage, type Annotation, type CanvasDoc, type HostEvent, type ModelProfile, type Session, type SessionItem, type StateSnapshot, type StudioSettings, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../runtime/codex/codex-runtime.js";
import { FakeServers } from "../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../service.js";
import { Store } from "../store/store.js";
import { startHostServer, type HostServer } from "./server.js";

// Each test boots a fresh server, and the OS may hand out a port that a closed server just used. A pooled keep-alive
// socket to that old server would then fail ("fetch failed"), so test requests never reuse connections.
const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { connection: "close", ...(init.headers as Record<string, string> | undefined) } });

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];
const TOKEN = "test-host-token";

let root: string;
let store: Store;
let servers: FakeServers;
let http: HostServer;
let service: HostService;

async function boot() {
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  const runtime = new CodexRuntime({ store, servers, profiles: PROFILES });
  service = new HostService(store, runtime, PROFILES);
  http = await startHostServer({ service, token: TOKEN, allowedOrigins: ["http://127.0.0.1:47901"] });
}

async function shutdown() {
  await http.close();
  await servers.close();
  store.close();
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-api-"));
  mkdirSync(join(root, "alpha"));
  mkdirSync(join(root, "beta"));
  mkdirSync(join(root, "spare"));
  await boot();
});

afterEach(async () => {
  await shutdown();
  removeTempDir(root);
});

async function api<T>(method: string, path: string, body?: unknown, token = TOKEN): Promise<{ status: number; data: T }> {
  const res = await fetch(`${http.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, data: (await res.json()) as T };
}
const ok = async <T>(method: string, path: string, body?: unknown) => {
  const r = await api<T>(method, path, body);
  if (r.status !== 200) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};

const until = async (pred: () => Promise<boolean> | boolean, label: string, timeoutMs = 5000) => {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function createTask(text = "hello") {
  const existing = (await ok<StateSnapshot>("GET", "/api/state")).workspaces.find((w) => w.name === "alpha");
  const ws = existing ?? (await ok<Workspace>("POST", "/api/workspaces", { path: join(root, "alpha") }));
  const created = await ok<{ task: Task; session: Session }>("POST", "/api/tasks", {
    workspaceId: ws.id,
    firstSession: { profileId: "p-ds", text },
  });
  return { ws, ...created };
}

const items = (sessionId: string) => ok<SessionItem[]>("GET", `/api/sessions/${sessionId}/items`);
const lastAgentText = async (sessionId: string) => (await items(sessionId)).filter((i) => i.type === "agent").map((i) => (i as { markdown: string }).markdown).at(-1);

describe("Host API", () => {
  it("rejects requests without the host token", async () => {
    expect((await api("GET", "/api/state", undefined, "wrong")).status).toBe(401);
    const res = await fetch(`${http.url}/api/state`);
    expect(res.status).toBe(401);
  });

  it("registers workspaces and validates the path", async () => {
    const ws = await ok<Workspace>("POST", "/api/workspaces", { path: join(root, "alpha") });
    expect(ws.name).toBe("alpha");
    expect((await api("POST", "/api/workspaces", { path: join(root, "alpha") })).status).toBe(409);
    expect((await api("POST", "/api/workspaces", { path: join(root, "missing") })).status).toBe(400);
    const state = await ok<StateSnapshot>("GET", "/api/state");
    expect(state.workspaces.filter((w) => !w.builtin).map((w) => w.id)).toEqual([ws.id]);
    // The common space is always there, as a built-in workspace the UI does not list.
    expect(state.workspaces.filter((w) => w.builtin === "common")).toHaveLength(1);
    expect(state.profiles.map((p) => p.id)).toEqual(["p-ds"]);
  });

  it("creates a task with its first session and streams the reply", async () => {
    const { task, session } = await createTask("hello there");
    expect(task).toMatchObject({ title: "hello there", column: "doing" });
    expect(session).toMatchObject({ taskId: task.id, kind: "main", profileId: "p-ds" });
    await until(async () => (await lastAgentText(session.id)) === "FAKE: hello there", "reply");
  });

  it("files a task without a project in the common space and keeps its sessions in the task's project", async () => {
    const a = await ok<Workspace>("POST", "/api/workspaces", { path: join(root, "alpha") });
    const b = await ok<Workspace>("POST", "/api/workspaces", { path: join(root, "beta") });
    const { commonWorkspace } = await ok<StudioSettings>("GET", "/api/settings");
    const filed = await ok<{ task: Task; session: Session | null }>("POST", "/api/tasks", { title: "先记下来" });
    expect(filed.session).toBeNull();
    expect(filed.task).toMatchObject({ title: "先记下来", workspaceId: commonWorkspace.id, topicId: null, column: "todo", archivedAt: null });
    // The project can change until the first session starts; then it is fixed.
    expect((await ok<Task>("PATCH", `/api/tasks/${filed.task.id}`, { workspaceId: a.id })).workspaceId).toBe(a.id);
    const session = await ok<Session>("POST", `/api/tasks/${filed.task.id}/sessions`, { profileId: "p-ds" });
    expect(session).toMatchObject({ taskId: filed.task.id, topicId: null, workspaceId: a.id });
    expect((await api("PATCH", `/api/tasks/${filed.task.id}`, { workspaceId: null })).status).toBe(409);
    expect((await api("POST", `/api/tasks/${filed.task.id}/sessions`, { profileId: "p-ds", workspaceId: b.id })).status).toBe(400);
    // Starting at once: no project means the common space.
    const quick = await ok<{ task: Task; session: Session }>("POST", "/api/tasks", { firstSession: { profileId: "p-ds", text: "问个问题" } });
    expect(quick.task).toMatchObject({ workspaceId: commonWorkspace.id, column: "doing", title: "问个问题" });
    expect(quick.session.workspaceId).toBe(commonWorkspace.id);
  });

  it("keeps topics: tasks in them, transfer between them, topic sessions, archiving with their tasks", async () => {
    const a = await ok<Workspace>("POST", "/api/workspaces", { path: join(root, "alpha") });
    const b = await ok<Workspace>("POST", "/api/workspaces", { path: join(root, "beta") });
    const spare = await ok<Workspace>("POST", "/api/workspaces", { path: join(root, "spare") });
    const { commonWorkspace } = await ok<StudioSettings>("GET", "/api/settings");
    expect((await api("POST", "/api/topics", { title: " " })).status).toBe(400);
    expect((await api("POST", "/api/topics", { title: "x", workspaceIds: [commonWorkspace.id] })).status).toBe(400);
    const topic = await ok<Topic>("POST", "/api/topics", { title: "掉落表重构", workspaceIds: [b.id] });
    const other = await ok<Topic>("POST", "/api/topics", { title: "武器 v2" });
    const t1 = (await ok<{ task: Task }>("POST", "/api/tasks", { title: "校验", workspaceId: a.id, topicId: topic.id, firstSession: { profileId: "p-ds" } })).task;
    const t2 = (await ok<{ task: Task }>("POST", "/api/tasks", { title: "补测试", workspaceId: b.id, topicId: topic.id })).task;
    expect(t1.topicId).toBe(topic.id);

    // Each topic has its own canvas, holding only its own tasks.
    const empty = await ok<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
    expect(empty).toMatchObject({ id: topic.id, version: 0, nodes: [] });
    const outsider = (await ok<{ task: Task }>("POST", "/api/tasks", { title: "别处" })).task;
    const withOutsider = { ...empty, nodes: [{ id: "n9", kind: "task", taskId: outsider.id, groupId: null, pos: { x: 0, y: 0 } }] };
    expect((await api("PUT", `/api/topics/${topic.id}/canvas`, withOutsider)).status).toBe(400);
    const saved = await ok<CanvasDoc>("PUT", `/api/topics/${topic.id}/canvas`, {
      ...empty,
      nodes: [
        { id: "n1", kind: "task", taskId: t1.id, groupId: null, pos: { x: 0, y: 0 } },
        { id: "n2", kind: "task", taskId: t2.id, groupId: null, pos: { x: 300, y: 0 } },
      ],
      edges: [{ id: "e1", kind: "depends", from: t1.id, to: t2.id }],
    });

    // Transfer: t2 moves to the other topic and leaves the first canvas with its dependency.
    expect((await ok<Task>("PATCH", `/api/tasks/${t2.id}`, { topicId: other.id })).topicId).toBe(other.id);
    const after = await ok<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
    expect(after.version).toBe(saved.version + 1);
    expect(after.nodes.map((n) => n.id)).toEqual(["n1"]);
    expect(after.edges).toEqual([]);

    // Topic sessions run in one of the topic's projects (hand-added or from its tasks) or in the common space.
    const coord = await ok<Session>("POST", `/api/topics/${topic.id}/sessions`, { profileId: "p-ds" });
    expect(coord).toMatchObject({ taskId: null, topicId: topic.id, workspaceId: commonWorkspace.id, kind: "main" });
    expect((await ok<Session>("POST", `/api/topics/${topic.id}/sessions`, { profileId: "p-ds", workspaceId: a.id })).workspaceId).toBe(a.id);
    expect((await ok<Session>("POST", `/api/topics/${topic.id}/sessions`, { profileId: "p-ds", workspaceId: b.id })).workspaceId).toBe(b.id);
    expect((await api("POST", `/api/topics/${topic.id}/sessions`, { profileId: "p-ds", workspaceId: spare.id })).status).toBe(400);

    // Archiving the topic archives its sessions and its tasks with theirs; the moved task is not touched.
    const archived = await ok<{ topic: Topic; tasks: Task[] }>("POST", `/api/topics/${topic.id}/archive`);
    expect(archived.topic.archivedAt).not.toBeNull();
    expect(archived.tasks.map((t) => t.id)).toEqual([t1.id]);
    let state = await ok<StateSnapshot>("GET", "/api/state");
    expect(state.tasks.find((t) => t.id === t1.id)?.archivedAt).not.toBeNull();
    expect(state.tasks.find((t) => t.id === t2.id)?.archivedAt).toBeNull();
    expect(state.sessions.filter((s) => s.topicId === topic.id || s.taskId === t1.id).every((s) => s.archivedAt)).toBe(true);
    expect((await api("POST", `/api/tasks/${t1.id}/sessions`, { profileId: "p-ds" })).status).toBe(409);
    expect((await api("POST", `/api/topics/${topic.id}/sessions`, { profileId: "p-ds" })).status).toBe(409);
    expect((await api("POST", "/api/tasks", { title: "y", topicId: topic.id })).status).toBe(409);
    expect((await api("POST", `/api/tasks/${t1.id}/unarchive`)).status).toBe(409); // its topic is archived

    // Restoring the topic brings back its tasks and the sessions archived with them.
    const restored = await ok<{ topic: Topic; tasks: Task[] }>("POST", `/api/topics/${topic.id}/unarchive`);
    expect(restored.topic.archivedAt).toBeNull();
    expect(restored.tasks.map((t) => t.id)).toEqual([t1.id]);
    state = await ok<StateSnapshot>("GET", "/api/state");
    expect(state.sessions.filter((s) => s.topicId === topic.id || s.taskId === t1.id).every((s) => !s.archivedAt)).toBe(true);
    expect(state.topics.map((t) => t.title)).toEqual(["掉落表重构", "武器 v2"]);
  });

  it("archives a single task with its sessions and restores them", async () => {
    const { task, session } = await createTask("archive me");
    const archived = await ok<Task>("POST", `/api/tasks/${task.id}/archive`);
    expect(archived.archivedAt).not.toBeNull();
    expect((await ok<StateSnapshot>("GET", "/api/state")).sessions.find((s) => s.id === session.id)?.archivedAt).not.toBeNull();
    expect((await api("PATCH", `/api/tasks/${task.id}`, { column: "done" })).status).toBe(409);
    const back = await ok<Task>("POST", `/api/tasks/${task.id}/unarchive`);
    expect(back.archivedAt).toBeNull();
    expect((await ok<StateSnapshot>("GET", "/api/state")).sessions.find((s) => s.id === session.id)?.archivedAt).toBeNull();
  });

  it("reads the subscription quota only when asked to refresh", async () => {
    // p-ds is routed to its own provider: no ChatGPT quota. A profile on the person's own login has one.
    expect(await ok("GET", "/api/usage")).toEqual([]);
  });

  it("renames tasks, and sessions in their own runtime", async () => {
    const { task, session } = await createTask("first words");
    expect((await ok<Task>("PATCH", `/api/tasks/${task.id}`, { title: "导入重试" })).title).toBe("导入重试");
    const renamed = await ok<Session>("PATCH", `/api/sessions/${session.id}`, { title: "先看看现状" });
    expect(renamed.title).toBe("先看看现状");
    // The Codex thread got the name (thread/name/set), so the TUI and `codex resume` show it as well.
    expect(servers.fakes.get("p-ds")!.calls.some((c) => c.method === "thread/name/set" && (c.params as { name?: string }).name === "先看看现状")).toBe(true);
    expect((await api("PATCH", `/api/sessions/${session.id}`, { title: " " })).status).toBe(400);
  });

  it("moves cards between columns only when asked and rejects unknown columns", async () => {
    const { task } = await createTask();
    expect((await ok<Task>("PATCH", `/api/tasks/${task.id}`, { column: "review" })).column).toBe("review");
    expect((await api("PATCH", `/api/tasks/${task.id}`, { column: "nope" })).status).toBe(400);
    expect((await api("PATCH", "/api/tasks/missing", { column: "done" })).status).toBe(404);
  });

  it("handles approvals, steer, fork and archive through the API", async () => {
    const { session } = await createTask("seed");
    await until(async () => (await lastAgentText(session.id)) === "FAKE: seed", "seed");

    expect(await ok("POST", `/api/sessions/${session.id}/messages`, { text: "[[shell: cmd /c echo x]]" })).toEqual({ mode: "start" });
    let approvalId = "";
    await until(async () => {
      const a = (await items(session.id)).find((i) => i.type === "approval") as { approvalId: string } | undefined;
      approvalId = a?.approvalId ?? "";
      return !!a;
    }, "approval");
    expect(await ok("POST", `/api/approvals/${approvalId}`, { sessionId: session.id, decision: "accept" })).toEqual({ ok: true });
    expect((await api("POST", `/api/approvals/${approvalId}`, { sessionId: session.id, decision: "accept" })).status).toBe(409);
    await until(async () => (await lastAgentText(session.id)) === "FAKE-RAN", "approved run");

    const fork = await ok<Session>("POST", `/api/sessions/${session.id}/fork`, {});
    expect(fork).toMatchObject({ kind: "fork", parentId: session.id });
    const archived = await ok<Session[]>("POST", `/api/sessions/${session.id}/archive`);
    expect(archived).toHaveLength(2);
    const blocked = await api<{ error: { code: string } }>("POST", `/api/sessions/${session.id}/messages`, { text: "x" });
    expect(blocked.status).toBe(409);
    expect(blocked.data.error.code).toBe("read_only");
    expect(await ok<Session[]>("POST", `/api/sessions/${session.id}/unarchive`)).toHaveLength(2);
  });

  it("streams events over WS with a backlog after ?since=", async () => {
    const before = (await ok<StateSnapshot>("GET", "/api/state")).eventSeq;
    const refused = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${http.url.replace("http", "ws")}/api/events?token=wrong`);
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => resolve(200));
    });
    expect(refused).toBe(401);

    const { session } = await createTask("events");
    await until(async () => (await lastAgentText(session.id)) === "FAKE: events", "reply");
    const received: HostEvent[] = [];
    const ws = new WebSocket(`${http.url.replace("http", "ws")}/api/events?token=${TOKEN}&since=${before}`);
    ws.on("message", (raw) => received.push(JSON.parse(String(raw)) as HostEvent));
    await until(() => received.some((e) => e.type === "item.updated"), "backlog");
    expect(received[0]!.seq).toBeGreaterThan(before);
    expect(received.some((e) => e.type === "workspace.upserted")).toBe(true);
    expect(received.some((e) => e.type === "item.delta")).toBe(false); // deltas are live-only

    const count = received.length;
    await ok("POST", `/api/sessions/${session.id}/messages`, { text: "live" });
    await until(() => received.slice(count).some((e) => e.type === "item.delta"), "live delta");
    ws.close();
  });

  it("keeps tasks, sessions and items across a Host restart", async () => {
    const { task, session } = await createTask("persist");
    await until(async () => (await lastAgentText(session.id)) === "FAKE: persist", "reply");
    await shutdown();
    await boot();
    const state = await ok<StateSnapshot>("GET", "/api/state");
    expect(state.tasks.map((t) => t.id)).toEqual([task.id]);
    expect(state.sessions.map((s) => s.id)).toEqual([session.id]);
    expect(await lastAgentText(session.id)).toBe("FAKE: persist");
  });

  it("answers CORS preflight only for allowed origins and serves 404 outside the API", async () => {
    const pre = await fetch(`${http.url}/api/state`, { method: "OPTIONS", headers: { origin: "http://127.0.0.1:47901" } });
    expect(pre.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:47901");
    const other = await fetch(`${http.url}/api/state`, { method: "OPTIONS", headers: { origin: "http://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(`${http.url}/nothing`)).status).toBe(404);
  });

  it("serves the UI without escaping its folder and survives malformed paths", async () => {
    const uiDir = join(root, "ui");
    mkdirSync(uiDir);
    writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>ui</title>");
    writeFileSync(join(root, "secret.txt"), "do not serve");
    const runtime = new CodexRuntime({ store, servers, profiles: PROFILES });
    const ui = await startHostServer({ service: new HostService(store, runtime, PROFILES), token: TOKEN, uiDir });
    try {
      expect(await (await fetch(`${ui.url}/`)).text()).toContain("<title>ui</title>");
      expect(await (await fetch(`${ui.url}/..%2f..%2fsecret.txt`)).text()).not.toContain("do not serve");
      expect((await fetch(`${ui.url}/%E0%A4%A`)).status).toBe(404);
      expect((await fetch(`${ui.url}/api/state`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    } finally {
      await ui.close();
    }
  });

  it("keeps notes and handoffs on a task, written by the person or by the task's own sessions", async () => {
    const { task, session } = await createTask("notes");
    const other = await createTask("other");
    const note = await ok<{ kind: string; sessionId: string | null; text: string }>("POST", `/api/tasks/${task.id}/notes`, { text: " 先查导入日志 " });
    expect(note).toMatchObject({ kind: "progress", sessionId: null, text: "先查导入日志" });
    expect(service.collab.addTaskNote(task.id, { text: "交接：重试已加，测试待补", kind: "handoff" }, session.id)).toMatchObject({ kind: "handoff", sessionId: session.id });
    expect(() => service.collab.addTaskNote(other.task.id, { text: "x" }, session.id)).toThrow(/its own task/);
    expect((await ok<Array<{ kind: string }>>("GET", `/api/tasks/${task.id}/notes`)).map((n) => n.kind)).toEqual(["progress", "handoff"]);
    expect((await api("POST", `/api/tasks/${task.id}/notes`, { text: " " })).status).toBe(400);
    expect((await api("POST", `/api/tasks/${task.id}/notes`, { text: "x".repeat(8001) })).status).toBe(400);
  });

  it("passes mail between sessions and lets the person forward or dismiss it", async () => {
    const a = await createTask("a");
    const b = await createTask("b");
    const toB = service.collab.sendMail(a.session.id, { kind: "session", sessionId: b.session.id }, "接口改好了，你可以接着做导入");
    expect(toB).toMatchObject({ fromSessionId: a.session.id, fromTaskId: a.task.id, state: "unread" });
    expect(() => service.collab.sendMail(a.session.id, { kind: "session", sessionId: a.session.id }, "me")).toThrow(/itself/);
    const toTask = await ok<{ id: string; fromSessionId: string | null }>("POST", "/api/mail", { to: { kind: "task", taskId: b.task.id }, text: "记得更新文档" });
    expect(toTask.fromSessionId).toBeNull();
    expect((await api("POST", "/api/mail", { to: { kind: "task", taskId: "nope" }, text: "x" })).status).toBe(404);
    expect((await api("POST", "/api/mail", { to: { kind: "task", taskId: b.task.id }, text: "x".repeat(8001) })).status).toBe(400);

    // B's mailbox: its own mail and its task's, oldest first; reading marks them read.
    expect((await ok<Array<{ id: string }>>("GET", `/api/mail?sessionId=${b.session.id}&taskId=${b.task.id}&state=unread`)).map((m) => m.id)).toEqual([toB.id, toTask.id]);
    expect(service.collab.readMailFromSession(b.session.id).map((m) => m.state)).toEqual(["read", "read"]);
    expect(service.collab.readMailFromSession(b.session.id)).toEqual([]);

    // Forwarding puts it into the conversation as a user message marked as AMO mail.
    const forwarded = await ok<{ state: string }>("POST", `/api/mail/${toB.id}/forward`, {});
    expect(forwarded.state).toBe("forwarded");
    expect((await api("POST", `/api/mail/${toB.id}/forward`, {})).status).toBe(409);
    expect(servers.fakes.get("p-ds")!.calls.filter((c) => c.method === "turn/start").at(-1)?.params).toMatchObject({
      input: [{ type: "text", text: expect.stringMatching(/^\[AMO 留言\] 来自任务「.*」的会话「a」：\n\n接口改好了/) }],
    });
    // Task mail needs a session of that task; dismissing is the other way out.
    expect((await api("POST", `/api/mail/${toTask.id}/forward`, {})).status).toBe(400);
    expect((await api("POST", `/api/mail/${toTask.id}/forward`, { sessionId: a.session.id })).status).toBe(400);
    expect(await ok("PATCH", `/api/mail/${toTask.id}`, { state: "dismissed" })).toMatchObject({ state: "dismissed" });
  });

  it("answers a decision request and sends the answer back to the asking session", async () => {
    const { session } = await createTask("decide");
    const d = service.collab.requestDecisionFromSession(session.id, "掉落表按关卡拆还是按怪物拆？", ["按关卡", "按怪物", " "]);
    expect(d).toMatchObject({ state: "open", options: ["按关卡", "按怪物"] });
    expect((await ok<Array<{ id: string }>>("GET", "/api/decisions?state=open")).map((x) => x.id)).toEqual([d.id]);
    const answered = await ok<{ state: string; answer: string }>("POST", `/api/decisions/${d.id}/answer`, { answer: "按关卡" });
    expect(answered).toMatchObject({ state: "answered", answer: "按关卡" });
    expect((await api("POST", `/api/decisions/${d.id}/answer`, { answer: "x" })).status).toBe(409);
    expect(await ok("GET", "/api/decisions?state=open")).toEqual([]);
    const mail = service.collab.mail({ sessionId: session.id });
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ fromSessionId: null, text: "针对你的问题「掉落表按关卡拆还是按怪物拆？」，我的决定：按关卡" });
  });

  it("lists a workspace's extension packs and reads their documents", async () => {
    const path = join(root, "packed");
    const dir = join(path, ".amo", "packs", "demo");
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "pack.json"), JSON.stringify({ schemaVersion: 1, name: "demo", title: "示例", docs: [{ id: "style", title: "规范", path: "docs/style.md" }] }));
    writeFileSync(join(dir, "docs", "style.md"), "# 规范");
    const ws = await ok<Workspace>("POST", "/api/workspaces", { path });
    const packs = await ok<Array<{ dirName: string; manifest: { title: string } | null; errors: string[] }>>("GET", `/api/workspaces/${ws.id}/packs`);
    expect(packs.map((p) => [p.dirName, p.manifest?.title, p.errors])).toEqual([["demo", "示例", []]]);
    expect(await ok("GET", `/api/workspaces/${ws.id}/packs/demo/docs/style`)).toMatchObject({ pack: "demo", id: "style", text: "# 规范" });
    expect((await api("GET", `/api/workspaces/${ws.id}/packs/demo/docs/nope`)).status).toBe(404);
    expect((await api("GET", `/api/workspaces/${ws.id}/packs/${encodeURIComponent("..")}/docs/style`)).status).toBe(404);
    expect((await api("GET", "/api/workspaces/nope/packs")).status).toBe(404);
  });

  it("creates a task from a pack template with its steps as a checklist", async () => {
    const path = join(root, "templated");
    const dir = join(path, ".amo", "packs", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pack.json"), JSON.stringify({ schemaVersion: 1, name: "demo", title: "示例", templates: [{ id: "feat", title: "新功能", titlePrefix: "[功能]", steps: ["读规范", "实现", "补测试"] }] }));
    const ws = await ok<Workspace>("POST", "/api/workspaces", { path });
    const other = await ok<Workspace>("POST", "/api/workspaces", { path: join(root, "alpha") });
    const scope = { workspaceId: ws.id };
    const { task } = await ok<{ task: Task }>("POST", "/api/tasks", { title: "冲刺", ...scope, firstSession: { profileId: "p-ds" }, template: { workspaceId: ws.id, pack: "demo", template: "feat" } });
    expect(task.title).toBe("[功能] 冲刺");
    const items = await ok<Array<{ id: string; text: string; done: boolean; source: string }>>("GET", `/api/checklist?taskId=${task.id}`);
    expect(items.map((i) => [i.text, i.done, i.source])).toEqual([["读规范", false, "demo/feat"], ["实现", false, "demo/feat"], ["补测试", false, "demo/feat"]]);
    expect(await ok("PATCH", `/api/checklist/${items[1]!.id}`, { done: true })).toMatchObject({ done: true, doneBySessionId: null });
    expect((await ok<Array<{ done: boolean }>>("GET", "/api/checklist")).map((i) => i.done)).toEqual([false, true, false]);
    expect((await api("PATCH", `/api/checklist/${items[1]!.id}`, { done: "yes" })).status).toBe(400);
    expect((await api("PATCH", "/api/checklist/nope", { done: true })).status).toBe(404);
    // Without a title the template's title is used; templates come from the task's own workspace; unknown ones fail.
    const untitled = await ok<{ task: Task }>("POST", "/api/tasks", { ...scope, firstSession: { profileId: "p-ds" }, template: { workspaceId: ws.id, pack: "demo", template: "feat" } });
    expect(untitled.task.title).toBe("[功能] 新功能");
    const bad = (template: unknown, s: unknown = scope) => api("POST", "/api/tasks", { scope: s, firstSession: { profileId: "p-ds" }, template }).then((r) => r.status);
    expect(await bad({ workspaceId: ws.id, pack: "demo", template: "nope" })).toBe(400);
    expect(await bad({ workspaceId: ws.id, pack: "nope", template: "feat" })).toBe(400);
    expect(await bad({ workspaceId: ws.id, pack: "demo", template: "feat" }, { kind: "workspace", workspaceId: other.id })).toBe(400);
    // A session ticks only its own task's steps.
    const { session } = await createTask("other task");
    expect(() => service.collab.setChecklistDone(items[0]!.id, true, session.id)).toThrow("a session can only tick its own task's checklist");
  });

  it("fills a pack's session preset in for a task without starting anything", async () => {
    const path = join(root, "preset");
    const dir = join(path, ".amo", "packs", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pack.json"), JSON.stringify({ schemaVersion: 1, name: "demo", title: "示例", presets: [{ id: "impl", title: "实现", profile: "p-ds", prompt: "实现「{{task.title}}」" }] }));
    const ws = await ok<Workspace>("POST", "/api/workspaces", { path });
    const { task } = await ok<{ task: Task }>("POST", "/api/tasks", { title: "冲刺", workspaceId: ws.id, firstSession: { profileId: "p-ds" } });
    const sessionsBefore = (await ok<StateSnapshot>("GET", "/api/state")).sessions.length;
    const draft = await ok("POST", `/api/workspaces/${ws.id}/packs/demo/presets/impl/draft`, { taskId: task.id });
    expect(draft).toEqual({ presetId: "impl", title: "实现", workspaceId: ws.id, profileId: "p-ds", text: "实现「冲刺」", contextFiles: [], warnings: [] });
    expect((await ok<StateSnapshot>("GET", "/api/state")).sessions.length).toBe(sessionsBefore);
    expect((await api("POST", `/api/workspaces/${ws.id}/packs/demo/presets/nope/draft`, { taskId: task.id })).status).toBe(404);
    expect((await api("POST", `/api/workspaces/${ws.id}/packs/demo/presets/impl/draft`, {})).status).toBe(400);
    // A workspace task takes presets from its own workspace only.
    const { task: elsewhere } = await createTask("elsewhere");
    expect((await api("POST", `/api/workspaces/${ws.id}/packs/demo/presets/impl/draft`, { taskId: elsewhere.id })).status).toBe(400);
  });

  it("keeps whole-picture todos", async () => {
    const ws = await ok<Workspace>("POST", "/api/workspaces", { path: join(root, "alpha") });
    expect(await ok("GET", "/api/todos")).toEqual([]);
    const todo = await ok<{ id: string; text: string; done: boolean; workspaceId: string | null }>("POST", "/api/todos", { text: " 统一掉落表格式 ", workspaceId: ws.id });
    expect(todo).toMatchObject({ text: "统一掉落表格式", done: false, workspaceId: ws.id });
    expect((await api("POST", "/api/todos", { text: "  " })).status).toBe(400);
    expect((await api("POST", "/api/todos", { text: "x", workspaceId: "nope" })).status).toBe(400);
    expect(await ok("PATCH", `/api/todos/${todo.id}`, { done: true, workspaceId: null })).toMatchObject({ done: true, workspaceId: null });
    expect(await ok("DELETE", `/api/todos/${todo.id}`)).toEqual({ ok: true });
    expect((await api("DELETE", `/api/todos/${todo.id}`)).status).toBe(404);
    expect(await ok("GET", "/api/todos")).toEqual([]);
  });

  it("drops todo, topic and group hints when their workspace is removed", async () => {
    const ws = await ok<Workspace>("POST", "/api/workspaces", { path: join(root, "spare") });
    const todo = await ok<{ id: string }>("POST", "/api/todos", { text: "x", workspaceId: ws.id });
    const topic = await ok<Topic>("POST", "/api/topics", { title: "备用专题", workspaceIds: [ws.id] });
    const canvas = await ok<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
    await ok("PUT", `/api/topics/${topic.id}/canvas`, { ...canvas, groups: [{ id: "g1", title: "备用", workspaceId: ws.id, rect: { x: 0, y: 0, w: 300, h: 200 } }] });
    expect(await ok("DELETE", `/api/workspaces/${ws.id}`)).toEqual({ ok: true });
    expect((await ok<Array<{ id: string; workspaceId: string | null }>>("GET", "/api/todos")).find((t) => t.id === todo.id)?.workspaceId).toBeNull();
    const after = await ok<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
    expect(after.groups[0]?.workspaceId).toBeNull();
    expect(after.version).toBe(canvas.version + 2);
    expect((await ok<StateSnapshot>("GET", "/api/state")).topics[0]?.workspaceIds).toEqual([]);
    // The common space cannot be removed.
    const { commonWorkspace } = await ok<StudioSettings>("GET", "/api/settings");
    expect((await api("DELETE", `/api/workspaces/${commonWorkspace.id}`)).status).toBe(409);
  });

  it("turns a todo into a task in its workspace, or in the common space", async () => {
    const ws = await ok<Workspace>("POST", "/api/workspaces", { path: join(root, "alpha") });
    const todo = await ok<{ id: string }>("POST", "/api/todos", { text: "统一掉落表格式", workspaceId: ws.id });
    const converted = await ok<{ todo: { taskId: string; done: boolean }; task: Task; session: Session }>("POST", `/api/todos/${todo.id}/convert`, { profileId: "p-ds" });
    expect(converted.task).toMatchObject({ title: "统一掉落表格式", workspaceId: ws.id, topicId: null });
    expect(converted.todo).toMatchObject({ taskId: converted.task.id, done: true });
    // No first message, so the session has not started a turn (no model call).
    expect(converted.session.status).toBe("idle");
    expect((await ok<SessionItem[]>("GET", `/api/sessions/${converted.session.id}/items`)).filter((i) => i.type === "user")).toEqual([]);
    expect((await api("POST", `/api/todos/${todo.id}/convert`, { profileId: "p-ds" })).status).toBe(409);
    // A profile is required; a todo without a workspace lands in the common space.
    const loose = await ok<{ id: string }>("POST", "/api/todos", { text: "随便看看" });
    expect((await api("POST", `/api/todos/${loose.id}/convert`, { workspaceId: ws.id })).status).toBe(400);
    const { commonWorkspace } = await ok<StudioSettings>("GET", "/api/settings");
    expect((await ok<{ task: Task }>("POST", `/api/todos/${loose.id}/convert`, { profileId: "p-ds" })).task.workspaceId).toBe(commonWorkspace.id);
  });

  it("starts a proposal's work only when the person approves it", async () => {
    const ws = await ok<Workspace>("POST", "/api/workspaces", { path: join(root, "alpha") });
    const todo = await ok<{ id: string }>("POST", "/api/todos", { text: "统一掉落表格式", workspaceId: ws.id });
    const p = await ok<{ id: string; state: string; workspaceId: string }>("POST", "/api/proposals", { todoId: todo.id, profileId: "p-ds", prompt: "统一 drops.json 的字段", reason: "alpha 空闲" });
    expect(p).toMatchObject({ state: "pending", workspaceId: ws.id });
    expect((await ok<StateSnapshot>("GET", "/api/state")).tasks).toEqual([]);
    expect((await api("POST", "/api/proposals", { todoId: todo.id, profileId: "p-ds", prompt: "again" })).status).toBe(409);
    expect((await ok<Array<{ id: string }>>("GET", "/api/proposals?state=pending")).map((x) => x.id)).toEqual([p.id]);

    // Approving with an edited prompt: the todo becomes a task whose first session starts with it.
    const approved = await ok<{ proposal: { state: string; taskId: string; prompt: string }; task: Task; session: Session }>("POST", `/api/proposals/${p.id}/approve`, { prompt: "统一 drops.json 的字段，先别改 skills" });
    expect(approved.proposal).toMatchObject({ state: "approved", taskId: approved.task.id, prompt: "统一 drops.json 的字段，先别改 skills" });
    expect(approved.task.title).toBe("统一掉落表格式");
    await until(async () => (await ok<SessionItem[]>("GET", `/api/sessions/${approved.session.id}/items`)).some((i) => i.type === "user"), "first message");
    expect((await ok<Array<{ taskId: string | null; done: boolean }>>("GET", "/api/todos")).find((t) => t.taskId === approved.task.id)?.done).toBe(true);
    expect((await api("POST", `/api/proposals/${p.id}/approve`, {})).status).toBe(409);

    // Rejecting; deleting a todo expires its pending proposal.
    const other = await ok<{ id: string }>("POST", "/api/todos", { text: "清理导表脚本", workspaceId: ws.id });
    const q = await ok<{ id: string }>("POST", "/api/proposals", { todoId: other.id, profileId: "p-ds", prompt: "清理" });
    expect(await ok("POST", `/api/proposals/${q.id}/reject`)).toMatchObject({ state: "rejected" });
    const r = await ok<{ id: string }>("POST", "/api/proposals", { todoId: other.id, profileId: "p-ds", prompt: "再试" });
    await ok("DELETE", `/api/todos/${other.id}`);
    expect((await ok<Array<{ id: string; state: string }>>("GET", "/api/proposals")).find((x) => x.id === r.id)?.state).toBe("expired");
    expect((await api("POST", "/api/proposals", { todoId: "nope", profileId: "p-ds", prompt: "x" })).status).toBe(404);
  });

  it("runs a scheduler round by hand in the fixed scheduler task", async () => {
    const ws = await ok<Workspace>("POST", "/api/workspaces", { path: join(root, "alpha") });
    await ok("POST", "/api/todos", { text: "统一掉落表格式", workspaceId: ws.id });
    const { commonWorkspace } = await ok<StudioSettings>("GET", "/api/settings");
    const first = await ok<{ task: Task; session: Session }>("POST", "/api/scheduler/run", { profileId: "p-ds" });
    expect(first.task).toMatchObject({ title: "调度", workspaceId: commonWorkspace.id, topicId: null });
    expect(first.session.workspaceId).toBe(commonWorkspace.id);
    await until(async () => (await ok<SessionItem[]>("GET", `/api/sessions/${first.session.id}/items`)).some((i) => i.type === "user"), "brief");
    const brief = (await ok<SessionItem[]>("GET", `/api/sessions/${first.session.id}/items`)).find((i) => i.type === "user") as { text: string };
    expect(brief.text).toContain("统一掉落表格式");
    expect(service.planning.isSchedulerSession(first.session.id)).toBe(true);
    const second = await ok<{ task: Task; session: Session }>("POST", "/api/scheduler/run", { profileId: "p-ds" });
    expect(second.task.id).toBe(first.task.id);
    expect(second.session.id).not.toBe(first.session.id);
  });

  it("caps proposals per scheduler round", async () => {
    const ws = await ok<Workspace>("POST", "/api/workspaces", { path: join(root, "alpha") });
    const { session } = await createTask("scheduler");
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await ok<{ id: string }>("POST", "/api/todos", { text: `待办 ${i}`, workspaceId: ws.id })).id);
    for (const id of ids.slice(0, 3)) service.planning.propose({ todoId: id, profileId: "p-ds", prompt: "做" }, session.id);
    expect(() => service.planning.propose({ todoId: ids[3], profileId: "p-ds", prompt: "做" }, session.id)).toThrow("at most 3 proposals per scheduler round");
  });

  it("turns a todo into one task even when asked twice at once", async () => {
    const ws = await ok<Workspace>("POST", "/api/workspaces", { path: join(root, "alpha") });
    const todo = service.planning.addTodo({ text: "双击批准", workspaceId: ws.id });
    const both = await Promise.allSettled([service.planning.convertTodo(todo.id, { profileId: "p-ds" }), service.planning.convertTodo(todo.id, { profileId: "p-ds" })]);
    expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await ok<StateSnapshot>("GET", "/api/state")).tasks.filter((t) => t.title === "双击批准")).toHaveLength(1);
  });

  it("saves 常用预设 and checks them", async () => {
    const profileId = (await ok<StateSnapshot>("GET", "/api/state")).profiles[0]!.id;
    const saved = await ok<{ presets: Array<{ id: string; name: string }> }>("PUT", "/api/settings", { presets: [{ name: " 深度 ", profileId, options: { effort: "high", permission: "ask", junk: "x" } }] });
    expect(saved.presets).toEqual([{ id: expect.stringMatching(/^pre/), name: "深度", profileId, options: { effort: "high", permission: "ask" } }]);
    expect((await api("PUT", "/api/settings", { presets: [{ name: "x", profileId: "nope", options: {} }] })).status).toBe(400);
    expect((await api("PUT", "/api/settings", { presets: [{ name: "x", profileId, options: { model: "bad;rm" } }] })).status).toBe(400);
    expect((await ok<{ presets: unknown[] }>("PUT", "/api/settings", { presets: [] })).presets).toEqual([]);
  });

  it("keeps the common space next to the data and lets the person move it", async () => {
    const initial = await ok<StudioSettings>("GET", "/api/settings");
    expect(initial.commonWorkspace).toMatchObject({ path: join(root, "common"), name: "公共", builtin: "common" });
    expect(initial.presets).toEqual([]);
    const dir = join(root, "common", "space");
    const moved = await ok<StudioSettings>("PUT", "/api/settings", { commonDir: dir });
    expect(moved.commonWorkspace).toMatchObject({ id: initial.commonWorkspace.id, path: dir });
    // A registered project cannot become the common space; neither can a file or nothing.
    const alpha = await ok<Workspace>("POST", "/api/workspaces", { path: join(root, "alpha") });
    expect((await api("PUT", "/api/settings", { commonDir: alpha.path })).status).toBe(409);
    expect((await api("PUT", "/api/settings", { commonDir: null })).status).toBe(400);
    writeFileSync(join(root, "a-file"), "x");
    expect((await api("PUT", "/api/settings", { commonDir: join(root, "a-file") })).status).toBe(400);
    const round = await ok<{ session: Session }>("POST", "/api/scheduler/run", { profileId: "p-ds" });
    expect(round.session.workspaceId).toBe(initial.commonWorkspace.id);
    // It survives a restart.
    await shutdown();
    await boot();
    expect((await ok<StudioSettings>("GET", "/api/settings")).commonWorkspace).toMatchObject({ id: initial.commonWorkspace.id, path: dir });
  });

  it("saves a topic's canvas with optimistic versions and serves its outline", async () => {
    const { ws } = await createTask("canvas");
    const topic = await ok<Topic>("POST", "/api/topics", { title: "导入" });
    const task = (await ok<{ task: Task }>("POST", "/api/tasks", { title: "画布上的任务", workspaceId: ws.id, topicId: topic.id })).task;
    const empty = await ok<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
    expect(empty).toMatchObject({ id: topic.id, version: 0, groups: [], nodes: [], edges: [] });

    const draft: CanvasDoc = {
      ...empty,
      groups: [{ id: "g1", title: "导入", workspaceId: null, rect: { x: 0, y: 0, w: 400, h: 300 } }],
      nodes: [{ id: "n1", kind: "task", taskId: task.id, groupId: "g1", pos: { x: 10, y: 10 } }],
    };
    const saved = await ok<CanvasDoc>("PUT", `/api/topics/${topic.id}/canvas`, draft);
    expect(saved.version).toBe(1);
    expect((await api("PUT", `/api/topics/${topic.id}/canvas`, draft)).status).toBe(409); // still based on version 0
    const bad = await api<{ error: { message: string } }>("PUT", `/api/topics/${topic.id}/canvas`, { ...saved, nodes: [{ id: "n9", kind: "task", taskId: "missing", groupId: null, pos: { x: 0, y: 0 } }] });
    expect(bad.status).toBe(400);
    expect(bad.data.error.message).toMatch(/missing task/);
    expect((await api("GET", "/api/topics/nope/canvas")).status).toBe(404);

    const { outline, json } = await ok<{ outline: string; json: { groups: Array<{ tasks: Array<{ id: string }> }> } }>("GET", `/api/topics/${topic.id}/canvas/outline`);
    expect(json.groups[0]!.tasks.map((t) => t.id)).toEqual([task.id]);
    expect(outline).toContain("分组「导入」");

    // An archived task keeps its card, and the canvas can still be saved (it used to be refused as a missing task).
    await ok("POST", `/api/tasks/${task.id}/archive`);
    const cleared = await ok<CanvasDoc>("PUT", `/api/topics/${topic.id}/canvas`, { ...saved, groups: [], nodes: [{ ...saved.nodes[0]!, groupId: null }] });
    expect(cleared.nodes.map((n) => n.id)).toEqual(["n1"]);
    await ok("POST", `/api/tasks/${task.id}/unarchive`);

    await shutdown();
    await boot();
    expect((await ok<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`)).version).toBe(2);
  });

  it("reads and writes the global scratchpad, announcing changes", async () => {
    expect(await ok("GET", "/api/scratchpad")).toEqual({ text: "", updatedAt: null });
    const received: HostEvent[] = [];
    const ws = new WebSocket(`${http.url.replace("http", "ws")}/api/events?token=${TOKEN}&since=${(await ok<StateSnapshot>("GET", "/api/state")).eventSeq}`);
    ws.on("message", (raw) => received.push(JSON.parse(String(raw)) as HostEvent));
    await new Promise<void>((r) => ws.once("open", () => r()));
    const note = "待办：\n- 看掉落表";
    const saved = await ok<{ text: string; updatedAt: string }>("PUT", "/api/scratchpad", { text: note });
    expect(saved.text).toBe(note);
    expect(saved.updatedAt).toBeTruthy();
    expect((await api("PUT", "/api/scratchpad", { text: 42 })).status).toBe(400);
    await until(() => received.some((e) => e.type === "scratchpad.updated"), "scratchpad event");
    ws.close();
    await shutdown();
    await boot();
    expect((await ok<{ text: string }>("GET", "/api/scratchpad")).text).toBe(note);
  });

  it("annotates replies and sends the annotations back as one message", async () => {
    const { session } = await createTask("first reply");
    await until(async () => (await lastAgentText(session.id)) === "FAKE: first reply", "first reply");
    await ok("POST", `/api/sessions/${session.id}/messages`, { text: "second reply" });
    await until(async () => (await lastAgentText(session.id)) === "FAKE: second reply", "second reply");
    const agents = (await items(session.id)).filter((i) => i.type === "agent");
    const userItem = (await items(session.id)).find((i) => i.type === "user")!;

    // Validation: only agent replies, non-empty quote and note, a real range.
    expect((await api("POST", `/api/sessions/${session.id}/annotations`, { itemId: userItem.id, quote: "x", start: 0, end: 1, note: "n" })).status).toBe(400);
    expect((await api("POST", `/api/sessions/${session.id}/annotations`, { itemId: agents[0]!.id, quote: "x", start: 0, end: 1, note: " " })).status).toBe(400);
    expect((await api("POST", `/api/sessions/${session.id}/annotations`, { itemId: agents[0]!.id, quote: "x", start: 3, end: 3, note: "n" })).status).toBe(400);
    expect((await api("POST", `/api/sessions/${session.id}/annotations`, { itemId: agents[0]!.id, quote: "x", start: 0, end: 9999, note: "n" })).status).toBe(400);
    expect((await api("POST", `/api/sessions/${session.id}/annotations/send`)).status).toBe(400);

    // Created out of order on purpose: the summary follows reply order.
    const later = await ok<Annotation>("POST", `/api/sessions/${session.id}/annotations`, { itemId: agents[1]!.id, quote: "second", start: 6, end: 12, prefix: "FAKE: ", suffix: " reply", note: "这里要改" });
    const earlier = await ok<Annotation>("POST", `/api/sessions/${session.id}/annotations`, { itemId: agents[0]!.id, quote: "first", start: 6, end: 11, note: "这里不对" });
    const scrap = await ok<Annotation>("POST", `/api/sessions/${session.id}/annotations`, { itemId: agents[0]!.id, quote: "reply", start: 12, end: 17, note: "删掉我" });
    expect(later).toMatchObject({ prefix: "FAKE: ", suffix: " reply", sentAt: null });
    expect((await ok<Annotation>("PATCH", `/api/annotations/${earlier.id}`, { note: "这里不对，换一种写法" })).note).toBe("这里不对，换一种写法");
    expect(await ok("DELETE", `/api/annotations/${scrap.id}`)).toEqual({ ok: true });
    expect((await ok<Annotation[]>("GET", `/api/sessions/${session.id}/annotations`)).map((a) => a.id).sort()).toEqual([earlier.id, later.id].sort());

    const result = await ok<{ mode: string; sent: Annotation[] }>("POST", `/api/sessions/${session.id}/annotations/send`);
    expect(result.mode).toBe("start");
    expect(result.sent.map((a) => a.id)).toEqual([earlier.id, later.id]);
    expect(result.sent.every((a) => a.sentAt)).toBe(true);
    const expected = composeAnnotationMessage([{ quote: "first", note: "这里不对，换一种写法" }, { quote: "second", note: "这里要改" }]);
    await until(async () => (await items(session.id)).some((i) => i.type === "user" && i.text === expected), "summary message");
    expect(expected).toBe("针对你上面的回复，我有 2 条批注：\n\n> first\n这里不对，换一种写法\n\n> second\n这里要改");

    // Sent annotations are frozen and nothing is left to send.
    expect((await api("PATCH", `/api/annotations/${earlier.id}`, { note: "again" })).status).toBe(409);
    expect((await api("POST", `/api/sessions/${session.id}/annotations/send`)).status).toBe(400);
  });
  it("keeps attachments: raw image upload, the file back (header or ?token=), images only", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082", "hex");
    const up = await fetch(`${http.url}/api/attachments?name=${encodeURIComponent("截图.png")}&type=image/png`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/png" },
      body: png,
    });
    expect(up.status).toBe(200);
    const a = (await up.json()) as { id: string; name: string; mime: string; size: number; path: string };
    expect(a).toMatchObject({ name: "截图.png", mime: "image/png", size: png.length });
    expect(a.path.startsWith(join(root))).toBe(true);
    const back = await fetch(`${http.url}/api/attachments/${a.id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(back.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await back.arrayBuffer()).equals(png)).toBe(true);
    // An <img> sends the token in the query; that works only on this route and only with the right token.
    expect((await fetch(`${http.url}/api/attachments/${a.id}?token=${TOKEN}`)).status).toBe(200);
    expect((await fetch(`${http.url}/api/attachments/${a.id}?token=wrong`)).status).toBe(401);
    expect((await fetch(`${http.url}/api/state?token=${TOKEN}`)).status).toBe(401);
    // Images only; unknown ids are 404 (and cannot reach outside the folder).
    const text = await fetch(`${http.url}/api/attachments?type=text/plain`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "hi" });
    expect(text.status).toBe(400);
    expect((await api("GET", "/api/attachments/att-..%2F..%2Fstudio.db")).status).toBe(404);
  });
});
