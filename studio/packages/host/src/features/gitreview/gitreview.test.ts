import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composeGitReviewMessage,
  rangeBase,
  type GitChanges,
  type GitCommitChanges,
  type GitFileDiff,
  type GitLog,
  type GitReviewComment,
  type GitStatus,
  type ModelProfile,
  type Session,
  type SessionItem,
  type Task,
  type Workspace,
} from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { startHostServer, type HostServer } from "../../http/server.js";

// Git Review through the Host API: status and diffs of a project, comments, and sending them to a session.

const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { connection: "close", ...(init.headers as Record<string, string> | undefined) } });
const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];
const TOKEN = "test-host-token";

let root: string;
let store: Store;
let servers: FakeServers;
let http: HostServer;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-gitreview-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  const service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES);
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
const ok = async <T>(method: string, path: string, body?: unknown) => {
  const r = await api<T>(method, path, body);
  if (r.status !== 200) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};
const until = async (pred: () => Promise<boolean>, label: string, timeoutMs = 5000) => {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=AMO Test", "-c", "user.email=amo@test.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true });

function makeRepo(): string {
  const dir = join(root, "game");
  mkdirSync(dir);
  run(dir, "init", "-q", "-b", "main");
  run(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "drop.lua"), "local rate = 0.1\nlocal boss = 'Lv20'\nreturn rate\n");
  run(dir, "add", ".");
  run(dir, "commit", "-q", "-m", "base");
  writeFileSync(join(dir, "drop.lua"), "local rate = 0.25\nreturn rate\n");
  return dir;
}

// git is a process per call: slow on a loaded machine (the whole suite runs in parallel).
describe("Git Review API", { timeout: 30_000 }, () => {
  it("answers status, changes and diffs; a folder without git is not an error", async () => {
    const ws = await ok<Workspace>("POST", "/api/workspaces", { path: makeRepo() });
    const status = await ok<GitStatus>("GET", `/api/workspaces/${ws.id}/git/status`);
    expect(status).toMatchObject({ repo: true, branch: "main" });
    const changes = await ok<GitChanges>("GET", `/api/workspaces/${ws.id}/git/changes?range=working`);
    expect(changes.files).toEqual([{ path: "drop.lua", status: "modified", additions: 1, deletions: 2, binary: false }]);
    const diff = await ok<GitFileDiff>("GET", `/api/workspaces/${ws.id}/git/diff?range=working&path=drop.lua`);
    expect(diff.lines.map((l) => `${l.kind}:${l.oldLine ?? "-"}:${l.newLine ?? "-"}`)).toEqual(["del:1:-", "del:2:-", "add:-:1", "context:3:2"]);
    // With the list's base and untracked flag: the same diff; a base that is no commit id is refused.
    const fast = await ok<GitFileDiff>("GET", `/api/workspaces/${ws.id}/git/diff?range=working&path=drop.lua&base=${rangeBase("working", changes.status)}&untracked=0`);
    expect(fast.lines).toEqual(diff.lines);
    expect((await api(`GET`, `/api/workspaces/${ws.id}/git/diff?path=drop.lua&base=HEAD~1`)).status).toBe(400);
    expect((await api(`GET`, `/api/workspaces/${ws.id}/git/changes?range=everything`)).status).toBe(400);
    expect((await api(`GET`, `/api/workspaces/${ws.id}/git/diff?path=..%2Fsecret.txt`)).status).toBe(400);

    mkdirSync(join(root, "plain"));
    const plain = await ok<Workspace>("POST", "/api/workspaces", { path: join(root, "plain") });
    const none = await ok<GitStatus>("GET", `/api/workspaces/${plain.id}/git/status`);
    if (!none.repo) {
      expect(none.reason).toBe("不是 git 仓库");
      expect((await ok<GitChanges>("GET", `/api/workspaces/${plain.id}/git/changes`)).files).toEqual([]);
    }
  });

  it("keeps line comments and sends the drafts to a session as one message", async () => {
    const ws = await ok<Workspace>("POST", "/api/workspaces", { path: makeRepo() });
    const { session } = await ok<{ task: Task; session: Session }>("POST", "/api/tasks", { workspaceId: ws.id, firstSession: { profileId: "p-ds", text: "改掉落表" } });
    const items = () => ok<SessionItem[]>("GET", `/api/sessions/${session.id}/items`);
    await until(async () => (await items()).some((i) => i.type === "agent" && i.markdown === "FAKE: 改掉落表"), "first reply");

    const base = `/api/workspaces/${ws.id}/review-comments`;
    // Validation.
    expect((await api("POST", base, { range: "working", path: "drop.lua", side: "new", line: 0, lineText: "", note: "x" })).status).toBe(400);
    expect((await api("POST", base, { range: "working", path: "drop.lua", side: "middle", line: 1, lineText: "", note: "x" })).status).toBe(400);
    expect((await api("POST", base, { range: "working", path: "drop.lua", side: "new", line: 1, lineText: "", note: "  " })).status).toBe(400);
    expect((await api("POST", `${base}/send`, { sessionId: session.id })).status).toBe(400);

    const rate = await ok<GitReviewComment>("POST", base, { range: "working", path: "drop.lua", side: "new", line: 1, lineText: "local rate = 0.25", note: "概率太高" });
    const boss = await ok<GitReviewComment>("POST", base, { range: "working", path: "drop.lua", side: "old", line: 2, lineText: "local boss = 'Lv20'", note: "为什么删掉" });
    const scrap = await ok<GitReviewComment>("POST", base, { range: "branch", path: "a.lua", side: "new", line: 3, lineText: "x", note: "删掉我" });
    expect(rate).toMatchObject({ workspaceId: ws.id, state: "draft", sessionId: null, sentAt: null });
    expect((await ok<GitReviewComment>("PATCH", `/api/review-comments/${rate.id}`, { note: "概率太高，改回 0.15" })).note).toBe("概率太高，改回 0.15");
    expect(await ok("DELETE", `/api/review-comments/${scrap.id}`)).toEqual({ ok: true });
    expect((await ok<GitReviewComment[]>("GET", base)).map((c) => c.id)).toEqual([rate.id, boss.id]);

    const result = await ok<{ mode: string; sent: GitReviewComment[] }>("POST", `${base}/send`, { sessionId: session.id });
    expect(result.sent.map((c) => [c.id, c.state, c.sessionId])).toEqual([
      [rate.id, "sent", session.id],
      [boss.id, "sent", session.id],
    ]);
    const expected = composeGitReviewMessage([{ ...rate, note: "概率太高，改回 0.15" }, boss], "game");
    expect(expected).toBe(
      "Git Review 批注：我看了「game」的改动，有 2 条批注。\n\n### drop.lua\n\ndrop.lua:1\n> local rate = 0.25\n概率太高，改回 0.15\n\ndrop.lua（旧版第 2 行，已删除）\n> local boss = 'Lv20'\n为什么删掉",
    );
    await until(async () => (await items()).some((i) => i.type === "user" && i.text === expected), "summary message");

    // Sent comments are frozen; nothing is left to send.
    expect((await api("PATCH", `/api/review-comments/${rate.id}`, { note: "again" })).status).toBe(409);
    expect((await api("POST", `${base}/send`, { sessionId: session.id })).status).toBe(400);
    expect((await ok<GitReviewComment[]>("GET", base)).every((c) => c.state === "sent")).toBe(true);

    // The viewer's 文件 mode (S14-A): comments on the file as it is now, new side only; sent with the same bar.
    expect((await api("POST", base, { range: "file", path: "drop.lua", side: "old", line: 1, lineText: "", note: "x" })).status).toBe(400);
    expect((await api("POST", base, { range: "staged-ish", path: "drop.lua", side: "new", line: 1, lineText: "", note: "x" })).status).toBe(400);
    const onFile = await ok<GitReviewComment>("POST", base, { range: "file", path: "drop.lua", side: "new", line: 1, lineText: "local rate = 0.25", note: "这一行的来历？" });
    expect(onFile).toMatchObject({ range: "file", side: "new", state: "draft" });
    await ok("POST", `${base}/send`, { sessionId: session.id });
    const fileMessage = "文件批注：我看了「game」的文件，有 1 条批注。\n\n### drop.lua\n\ndrop.lua:1\n> local rate = 0.25\n这一行的来历？";
    expect(composeGitReviewMessage([onFile], "game")).toBe(fileMessage);
    await until(async () => (await items()).some((i) => i.type === "user" && i.text === fileMessage), "file comments message");
  });
});

describe("commit history API (S13-B)", { timeout: 30_000 }, () => {
  it("lists commits, one commit's files and one file of a commit; refuses other names", async () => {
    const dir = makeRepo();
    run(dir, "commit", "-q", "-am", "tune");
    const ws = await ok<Workspace>("POST", "/api/workspaces", { path: dir });
    const log = await ok<GitLog>("GET", `/api/workspaces/${ws.id}/git/log`);
    expect(log.commits.map((c) => c.subject)).toEqual(["tune", "base"]);
    expect((await ok<GitLog>("GET", `/api/workspaces/${ws.id}/git/log?limit=1`)).truncated).toBe(true);
    const tune = log.commits[0]!;
    const changes = await ok<GitCommitChanges>("GET", `/api/workspaces/${ws.id}/git/commit?sha=${tune.sha.slice(0, 8)}`);
    expect(changes).toMatchObject({ commit: { sha: tune.sha }, base: log.commits[1]!.sha, truncated: false });
    expect(changes.files).toEqual([{ path: "drop.lua", status: "modified", additions: 1, deletions: 2, binary: false }]);
    const diff = await ok<GitFileDiff>("GET", `/api/workspaces/${ws.id}/git/commit-diff?sha=${tune.sha}&base=${changes.base}&path=drop.lua`);
    expect(diff.commit).toBe(tune.sha);
    expect(diff.lines.map((l) => l.kind)).toEqual(["del", "del", "add", "context"]);

    for (const sha of ["HEAD", "abc", "--all", "abc1234..HEAD"]) expect((await api("GET", `/api/workspaces/${ws.id}/git/commit?sha=${encodeURIComponent(sha)}`)).status).toBe(400);
    expect((await api("GET", `/api/workspaces/${ws.id}/git/commit?sha=0000000`)).status).toBe(404);
    expect((await api("GET", `/api/workspaces/${ws.id}/git/commit-diff?sha=${tune.sha.slice(0, 7)}&base=${changes.base}&path=drop.lua`)).status).toBe(400);
    expect((await api("GET", `/api/workspaces/${ws.id}/git/commit-diff?sha=${tune.sha}&base=${changes.base}&path=..%2Fx`)).status).toBe(400);
    expect((await api("GET", `/api/workspaces/${ws.id}/git/log?limit=0`)).status).toBe(400);

    mkdirSync(join(root, "plain"));
    const plain = await ok<Workspace>("POST", "/api/workspaces", { path: join(root, "plain") });
    const none = await ok<GitStatus>("GET", `/api/workspaces/${plain.id}/git/status`);
    if (!none.repo) expect((await api("GET", `/api/workspaces/${plain.id}/git/log`)).status).toBe(400);
  });
});
