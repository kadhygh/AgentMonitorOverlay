import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostEvent, ModelProfile, Task, Topic, TopicDoc, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { startHostServer, type HostServer } from "../../http/server.js";

// Stage 16: a topic's documents through the Host API, and the 主控 mark on a task.

const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { connection: "close", ...(init.headers as Record<string, string> | undefined) } });
const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];
const TOKEN = "test-host-token";

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let http: HostServer;
let events: HostEvent[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-topicdocs-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  events = [];
  service.on("event", (e) => events.push(e));
  http = await startHostServer({ service, token: TOKEN, allowedOrigins: [] });
});

afterEach(async () => {
  await http.close();
  await servers.close();
  store.close();
  removeTempDir(root);
});

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${http.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, data: (await res.json()) as T };
}

describe("topic documents and 主控", () => {
  it("writes, lists, changes and deletes a topic's documents, with events", async () => {
    const topic = (await api<Topic>("POST", "/api/topics", { title: "迁移" })).data;
    expect((await api("POST", `/api/topics/${topic.id}/docs`, { title: " " })).status).toBe(400);
    const doc = (await api<TopicDoc>("POST", `/api/topics/${topic.id}/docs`, { title: "迁移计划", body: "先装甲车" })).data;
    expect(doc).toMatchObject({ topicId: topic.id, title: "迁移计划", body: "先装甲车" });
    await api("PATCH", `/api/topic-docs/${doc.id}`, { body: "先装甲车，再弹射闪电" });
    expect((await api<TopicDoc[]>("GET", `/api/topics/${topic.id}/docs`)).data).toMatchObject([{ id: doc.id, title: "迁移计划", body: "先装甲车，再弹射闪电" }]);
    expect((await api("DELETE", `/api/topic-docs/${doc.id}`)).status).toBe(200);
    expect((await api<TopicDoc[]>("GET", `/api/topics/${topic.id}/docs`)).data).toEqual([]);
    expect(events.filter((e) => e.type.startsWith("topicdoc.")).map((e) => e.type)).toEqual(["topicdoc.upserted", "topicdoc.upserted", "topicdoc.removed"]);
    expect((await api("PATCH", "/api/topic-docs/nope", { body: "x" })).status).toBe(404);
  });

  it("marks a task 主控 when it is made or later, and takes the mark off", async () => {
    const ws = (await api<Workspace>("POST", "/api/workspaces", { path: join(root, "alpha") })).data;
    const made = (await api<{ task: Task }>("POST", "/api/tasks", { title: "主控", workspaceId: ws.id, lead: true })).data.task;
    expect(made.lead).toBe(true);
    const other = (await api<{ task: Task }>("POST", "/api/tasks", { title: "执行", workspaceId: ws.id })).data.task;
    expect(other).not.toHaveProperty("lead");
    expect((await api<Task>("PATCH", `/api/tasks/${other.id}`, { lead: true })).data.lead).toBe(true);
    expect((await api<Task>("PATCH", `/api/tasks/${made.id}`, { lead: false })).data).not.toHaveProperty("lead");
    expect((await api("PATCH", `/api/tasks/${made.id}`, { lead: "yes" })).status).toBe(400);
    expect(store.getTask(other.id)?.lead).toBe(true);
  });
});
