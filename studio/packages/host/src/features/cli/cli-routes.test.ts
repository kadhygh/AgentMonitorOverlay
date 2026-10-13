import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BackgroundOutput, ChatSettings, ModelProfile, Session, SlashCommandList, Task, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { RuntimeRouter } from "../../runtime/runtime.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { startHostServer, type HostServer } from "../../http/server.js";

// Stage 12, S12-E: the `/` command routes, background output and the chat settings, over HTTP.

const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { connection: "close", ...(init.headers as Record<string, string> | undefined) } });
const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];
const TOKEN = "test-host-token";

let root: string;
let store: Store;
let servers: FakeServers;
let http: HostServer;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-cli-routes-"));
  mkdirSync(join(root, "plain"));
  mkdirSync(join(root, "repo"));
  execFileSync("git", ["init", "-q"], { cwd: join(root, "repo") });
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  const runtime = new RuntimeRouter(store, PROFILES, { codex: new CodexRuntime({ store, servers, profiles: PROFILES }) });
  const service = new HostService(store, runtime, PROFILES);
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

async function session(folder: string): Promise<Session> {
  const ws = (await api<Workspace>("POST", "/api/workspaces", { path: join(root, folder) })).data;
  return (await api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "t", workspaceId: ws.id, firstSession: { profileId: "p-ds" } })).data.session;
}

describe("/ commands over HTTP", () => {
  it("puts Studio's commands first, /review only in a git project", async () => {
    const plain = await session("plain");
    const list = (await api<SlashCommandList>("GET", `/api/sessions/${plain.id}/commands`)).data;
    expect(list.commands.map((c) => `${c.group}:${c.name}`)).toEqual(["studio:compact", "runtime:code-review", "skill:release-notes"]);
    const repo = await session("repo");
    const inRepo = (await api<SlashCommandList>("GET", `/api/sessions/${repo.id}/commands`)).data;
    expect(inRepo.commands.slice(0, 2)).toMatchObject([{ name: "compact" }, { name: "review", local: "open-review" }]);
  });

  it("checks the command before running it", async () => {
    const s = await session("plain");
    const path = `/api/sessions/${s.id}/commands`;
    expect((await api("POST", path, { name: "" })).status).toBe(400);
    expect((await api("POST", path, { name: "compact", args: 3 })).status).toBe(400);
    expect((await api("POST", path, { name: "review" })).status).toBe(400);
    expect((await api("POST", path, { name: "nope" })).status).toBe(400);
    expect(await api("POST", path, { name: "/release-notes", args: "v2" })).toEqual({ status: 200, data: { mode: "start" } });
  });
});

describe("background output", () => {
  it("returns the tail of the command's output file", async () => {
    const s = await session("plain");
    const file = join(root, "task.output");
    writeFileSync(file, `${"x".repeat(9000)}\nline two\nline three\n`);
    store.appendItem({ id: "i-bg", sessionId: s.id, createdAt: new Date().toISOString(), type: "background", taskId: "b1", command: "npm run dev", state: "running", startedAt: new Date().toISOString(), outputFile: file });
    store.appendItem({ id: "i-bg2", sessionId: s.id, createdAt: new Date().toISOString(), type: "background", taskId: "b2", command: "sleep", state: "running", startedAt: new Date().toISOString() });
    const out = (await api<BackgroundOutput>("GET", `/api/sessions/${s.id}/background/b1/output`)).data;
    expect(out).toEqual({ text: "line two\nline three\n", truncated: true });
    expect((await api<BackgroundOutput>("GET", `/api/sessions/${s.id}/background/b2/output`)).data).toEqual({ text: "", truncated: false, missing: true });
    expect((await api("GET", `/api/sessions/${s.id}/background/nope/output`)).status).toBe(404);
  });
});

describe("chat settings", () => {
  it("keeps prompt suggestions off by default and remembers the choice", async () => {
    expect((await api<ChatSettings>("GET", "/api/settings/chat")).data).toEqual({ promptSuggestions: false });
    expect((await api<ChatSettings>("PUT", "/api/settings/chat", { promptSuggestions: true })).data).toEqual({ promptSuggestions: true });
    expect((await api("PUT", "/api/settings/chat", { promptSuggestions: "no" })).status).toBe(400);
    expect((await api<ChatSettings>("PUT", "/api/settings/chat", { promptSuggestions: false })).data).toEqual({ promptSuggestions: false });
    expect((await api<ChatSettings>("GET", "/api/settings/chat")).data).toEqual({ promptSuggestions: false });
  });
});
