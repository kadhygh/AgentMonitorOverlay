import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { HostEvent, ModelProfile, Session, SessionItem, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../runtime/codex/codex-runtime.js";
import { FakeServers } from "../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../service.js";
import { Store } from "../store/store.js";
import { startHostServer, type HostServer } from "./server.js";

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];
const TOKEN = "test-host-token";

let root: string;
let store: Store;
let servers: FakeServers;
let http: HostServer;

async function boot() {
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  const runtime = new CodexRuntime({ store, servers, profiles: PROFILES });
  const service = new HostService(store, runtime, PROFILES);
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
  const ws = await ok<Workspace>("POST", "/api/workspaces", { path: join(root, "alpha") });
  const created = await ok<{ task: Task; session: Session }>("POST", "/api/tasks", {
    scope: { kind: "workspace", workspaceId: ws.id },
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
    expect(state.workspaces.map((w) => w.id)).toEqual([ws.id]);
    expect(state.profiles.map((p) => p.id)).toEqual(["p-ds"]);
  });

  it("creates a task with its first session and streams the reply", async () => {
    const { task, session } = await createTask("hello there");
    expect(task).toMatchObject({ title: "hello there", column: "doing" });
    expect(session).toMatchObject({ taskId: task.id, kind: "main", profileId: "p-ds" });
    await until(async () => (await lastAgentText(session.id)) === "FAKE: hello there", "reply");
  });

  it("requires a workspace per session for cross-workspace tasks", async () => {
    const a = await ok<Workspace>("POST", "/api/workspaces", { path: join(root, "alpha") });
    const b = await ok<Workspace>("POST", "/api/workspaces", { path: join(root, "beta") });
    const bad = await api("POST", "/api/tasks", { scope: { kind: "area" }, firstSession: { profileId: "p-ds", text: "x" } });
    expect(bad.status).toBe(400);
    const { task, session } = await ok<{ task: Task; session: Session }>("POST", "/api/tasks", {
      scope: { kind: "area" },
      firstSession: { profileId: "p-ds", workspaceId: a.id, text: "x" },
    });
    expect(session.workspaceId).toBe(a.id);
    const second = await ok<Session>("POST", `/api/tasks/${task.id}/sessions`, { profileId: "p-ds", workspaceId: b.id });
    expect(second.workspaceId).toBe(b.id);
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
});
