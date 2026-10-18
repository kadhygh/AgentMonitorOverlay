import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitChanges, GitCommitChanges, HostEvent, ModelProfile, ReviewOpenResult, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { startHostServer, type HostServer } from "../../http/server.js";

// 外部打开 Review (2026-10-18): another tool asks the open Studio to show a project's changes; refs are resolved here and
// the main window gets a review.open event.

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
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-openreview-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES);
  http = await startHostServer({ service, token: TOKEN, allowedOrigins: [] });
  events = [];
  service.on("event", (e) => events.push(e));
});

afterEach(async () => {
  await http.close();
  await servers.close();
  store.close();
  removeTempDir(root);
});

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${http.url}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, data: (await res.json()) as T };
}
const open = (body: unknown) => api<ReviewOpenResult & { error?: { message: string } }>("POST", "/api/review/open", body);
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=AMO Test", "-c", "user.email=amo@test.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();

/** main: base → one; branch feature from base: two, three; the working tree changes a.txt. */
function makeRepo(): { dir: string; base: string; one: string; two: string; three: string } {
  const dir = join(root, "game");
  mkdirSync(dir);
  run(dir, "init", "-q", "-b", "main");
  run(dir, "config", "core.autocrlf", "false");
  const commit = (file: string, text: string, msg: string) => {
    writeFileSync(join(dir, file), text);
    run(dir, "add", ".");
    run(dir, "commit", "-q", "-m", msg);
    return run(dir, "rev-parse", "HEAD");
  };
  const base = commit("a.txt", "a\n", "base");
  const one = commit("main.txt", "m\n", "one");
  run(dir, "checkout", "-q", "-b", "feature", base);
  const two = commit("b.txt", "b\n", "two");
  const three = commit("c.txt", "c\n", "three");
  writeFileSync(join(dir, "a.txt"), "a changed\n");
  return { dir, base, one, two, three };
}

describe("POST /api/review/open", { timeout: 30_000 }, () => {
  it("needs an open Studio window", async () => {
    const r = await open({ path: makeRepo().dir });
    expect(r.status).toBe(409);
    expect(r.data.error?.message).toContain("窗口没有打开");
  });

  it("registers a new folder and opens its uncommitted changes, with the session for 发回", async () => {
    service.liveWindows = 1;
    const { dir } = makeRepo();
    mkdirSync(join(root, "other"));
    const ws0 = store.addWorkspace({ path: join(root, "other"), name: "other" });
    const task = store.createTask({ title: "t", workspaceId: ws0.id });
    const session = await service.tasks.startSession({ taskId: task.id, topicId: null }, ws0, { profileId: "p-ds" });
    const r = await open({ path: dir, sessionId: session.id, file: "a.txt" });
    expect(r.status).toBe(200);
    expect(r.data.workspaceAdded).toBe(true);
    const ws = store.listWorkspaces().find((w: Workspace) => w.path === dir)!;
    expect(r.data.target).toEqual({ workspaceId: ws.id, sessionId: session.id, file: "a.txt" });
    expect(events.find((e) => e.type === "review.open")).toMatchObject({ type: "review.open", target: r.data.target });
    // Again: the same project, not registered twice.
    expect((await open({ path: dir })).data.workspaceAdded).toBe(false);
    expect((await open({ path: dir, sessionId: "s-nope" })).status).toBe(404);
  });

  it("resolves refs: a base for the working tree, a commit, A..B and A...B", async () => {
    service.liveWindows = 1;
    const { dir, base, one, two, three } = makeRepo();
    expect((await open({ path: dir, base: "main" })).data.target).toMatchObject({ base: one, baseLabel: "main" });
    expect((await open({ path: dir, commit: "HEAD~1" })).data.target).toMatchObject({ commit: two });
    expect((await open({ path: dir, range: "main..feature" })).data.target).toMatchObject({ commit: three, base: one });
    expect((await open({ path: dir, range: "main...feature" })).data.target).toMatchObject({ commit: three, base, baseLabel: "main 的分叉点" });
    // Refused: what is not a ref, what reads as an option, a range with a commit, a ref that is not there.
    expect((await open({ path: dir, commit: "--output=x" })).status).toBe(400);
    expect((await open({ path: dir, base: "a b" })).status).toBe(400);
    expect((await open({ path: dir, range: "main..feature", commit: "HEAD" })).status).toBe(400);
    expect((await open({ path: dir, commit: "nope" })).status).toBe(404);
    expect((await open({})).status).toBe(400);
  });

  it("lists the working tree against a given base, and a commit against one", async () => {
    service.liveWindows = 1;
    const { dir, base, three } = makeRepo();
    const ws = (await api<Workspace>("POST", "/api/workspaces", { path: dir })).data;
    const changes = (await api<GitChanges>("GET", `/api/workspaces/${ws.id}/git/changes?range=branch&base=${base}&label=start`)).data;
    expect(changes.files.map((f) => f.path)).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(changes.status).toMatchObject({ mergeBase: base, base: "start" });
    expect((await api(`GET`, `/api/workspaces/${ws.id}/git/changes?range=working&base=${base}`)).status).toBe(400);
    const commit = (await api<GitCommitChanges>("GET", `/api/workspaces/${ws.id}/git/commit?sha=${three}&base=${base}`)).data;
    expect(commit).toMatchObject({ base });
    expect(commit.files.map((f) => f.path)).toEqual(["b.txt", "c.txt"]);
  });
});
