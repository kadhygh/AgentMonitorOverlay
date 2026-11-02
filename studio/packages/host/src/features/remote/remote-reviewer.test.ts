import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitReviewComment, GitStatus, HostEvent, ModelProfile, RemoteState, TextFile, ViewPack } from "@amo-studio/protocol";
import { saveAccount, type Protector } from "@amo-studio/account";
import { RelayStore, startRelayServer } from "@amo-studio/relay";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { FileReply } from "../../http/route.js";
import { Backoff } from "./link.js";

// 远程 Reviewer on B (plans/remote-reviewer.md, 2026-11-02): a remote task's Reviewer reads go through B's Host to A
// (rt.view) and come back; kept on B, they are shown again (said to be old) while A is away or the grant is gone; the
// copy archived, they go with it. Two Hosts through a relay service on this machine, the fake Codex app-server.

const fake: Protector = {
  protect: async (t) => Buffer.from(`enc:${t}`).toString("base64"),
  unprotect: async (d) => Buffer.from(d, "base64").toString().slice(4),
};
const PROFILES: ModelProfile[] = [{ id: "p", label: "P", runtime: "codex", provider: "x", model: "m" }];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const tempDir = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `amo-rrev-${name}-`));
  cleanups.push(() => removeTempDir(d));
  return d;
};

async function until<T>(read: () => T, ok: (v: T) => boolean, what = "condition", ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)?.slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function host(name: string, server: string, account: string, key: string) {
  const home = tempDir(name);
  const env = { AMO_HOME: home, COMPUTERNAME: name };
  await saveAccount({ server, name: account, key }, { env, protector: fake });
  const store = new Store(join(tempDir(`${name}-data`), "studio.db"));
  const servers = new FakeServers(PROFILES);
  const service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES);
  const options = { env, protector: fake, watchMs: 30, backoff: new Backoff({ baseMs: 30, maxMs: 120 }), pingTimeoutMs: 2000 };
  service.remote.start(options);
  await service.remote.setEnabled(true);
  cleanups.push(async () => {
    service.remote.stop();
    await servers.close();
    store.close();
  });
  return { service, store, state: () => service.remote.state(), remote: service.remote, restart: () => service.remote.start(options) };
}

const online = (s: RemoteState) => s.connection.state === "online";

async function paired() {
  const relayStore = new RelayStore(":memory:");
  const relay = await startRelayServer({ store: relayStore, host: "127.0.0.1", port: 0 });
  cleanups.push(() => relayStore.close());
  cleanups.push(() => relay.close());
  const ka = relayStore.register("台式机的我", "pw-aaaa").key;
  const kb = relayStore.register("笔记本的我", "pw-bbbb").key;
  const a = await host("A-PC", relay.url, "台式机的我", ka);
  const b = await host("B-PC", relay.url, "笔记本的我", kb);
  await until(a.state, online, "A online");
  await until(b.state, online, "B online");
  await b.remote.requestPair("台式机的我");
  const req = (await until(a.state, (s) => s.incoming.length === 1, "request")).incoming[0]!;
  await a.remote.answer(req.id, true);
  await until(b.state, (s) => s.peers.length === 1 && s.peers[0]!.online === true, "B sees A");
  return { a, b, toB: { account: "笔记本的我", device: b.state().device!.id } };
}

/** A task on A in a git project, granted to B, with a pack its session sent. */
async function grantedWithPack() {
  const { a, b, toB } = await paired();
  const dir = tempDir("game");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "drop.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "shot.png"), PNG);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  writeFileSync(join(dir, "src", "drop.ts"), "export const a = 2;\n");
  const ws = a.store.addWorkspace({ path: dir, name: "game" });
  const { task, session } = await a.service.tasks.createTask({ title: "掉落", workspaceId: ws.id, firstSession: { profileId: "p", text: "第一句" } });
  a.service.liveWindows = 1;
  const { pack } = await a.service.viewPacks.open({ items: [{ kind: "file", path: "src/drop.ts" }, { kind: "git" }] }, { sessionId: session!.id });
  a.remote.grant(task.id, toB);
  await until(() => b.store.getTask(task.id)?.remote?.state, (s) => s === "active", "B's copy");
  return { a, b, toB, task, session: session!, pack, ws, dir };
}

describe("远程 Reviewer through two Hosts", () => {
  it("B reads A's pack, git and named files through rt.view; a picture by rt.file", async () => {
    const { b, task, pack, ws } = await grantedWithPack();
    const none = new URLSearchParams();
    const got = (await b.remote.view(task.id, "GET", `/api/viewpacks/${pack.id}`, none, undefined)) as ViewPack;
    expect(got.items.map((i) => i.kind)).toEqual(["file", "git"]);
    const status = (await b.remote.view(task.id, "GET", `/api/workspaces/${ws.id}/git/status`, none, undefined)) as GitStatus;
    expect(status).toMatchObject({ repo: true, root: "任务文件夹" });
    const file = (await b.remote.view(task.id, "GET", "/api/fs/text", new URLSearchParams({ path: "src/drop.ts", workspaceId: ws.id }), undefined)) as TextFile;
    expect(file).toMatchObject({ path: "任务文件夹/src/drop.ts", text: "export const a = 2;\n" });
    // A's refusal comes to B as it is.
    await expect(b.remote.view(task.id, "GET", `/api/workspaces/ws-other/git/status`, none, undefined)).rejects.toThrow("不是这个任务的项目");
    // A picture (an <img> of a pack's file): fetched as any remote file and served from B's copy.
    const pic = await b.remote.view(task.id, "GET", "/api/fs/raw", new URLSearchParams({ path: "shot.png", workspaceId: ws.id }), undefined);
    expect(pic).toBeInstanceOf(FileReply);
    expect((pic as FileReply).mime).toBe("image/png");
    // Nothing of B's own (VS Code) is offered; writes are not reads.
    expect(await b.remote.view(task.id, "GET", "/api/open-in/apps", none, undefined)).toEqual({ vscode: false });
    await expect(b.remote.view(task.id, "DELETE", "/api/viewpacks/x", none, undefined)).rejects.toThrow("不能在这台电脑上做");
    // Only a remote copy goes there.
    const own = b.store.createTask({ title: "B 自己的", workspaceId: b.service.tasks.commonWorkspace().id });
    await expect(b.remote.view(own.id, "GET", `/api/viewpacks/${pack.id}`, none, undefined)).rejects.toThrow("不是远程任务");
  }, 60_000);

  it("shows what came last time while A is away or the grant is gone, saying so; archiving the copy throws it away", async () => {
    const { a, b, toB, task, pack } = await grantedWithPack();
    const said: Array<string | null> = [];
    b.service.on("event", (e: HostEvent) => e.type === "remote.view" && e.taskId === task.id && said.push(e.stale));
    const none = new URLSearchParams();
    const path = `/api/viewpacks/${pack.id}`;
    await b.remote.view(task.id, "GET", path, none, undefined);
    expect(said).toEqual([null]);
    a.remote.stop();
    await until(b.state, (s) => s.peers[0]?.online === false, "B sees A gone");
    const old = (await b.remote.view(task.id, "GET", path, none, undefined)) as ViewPack;
    expect(old.id).toBe(pack.id);
    expect(said.at(-1)).toContain("A-PC 现在连不上，显示的是上次取来的内容");
    // Never read before: nothing to show.
    await expect(b.remote.view(task.id, "GET", `/api/viewpacks/${pack.id}/items/${pack.items[0]!.id}/diff`, none, undefined)).rejects.toThrow("离线");
    a.restart();
    await until(b.state, (s) => s.peers[0]?.online === true, "A back");
    await b.remote.view(task.id, "GET", path, none, undefined);
    expect(said.at(-1)).toBeNull();
    a.remote.revoke(task.id, toB);
    await until(() => b.store.getTask(task.id)?.remote?.state, (s) => s === "revoked", "revoked on B");
    await b.remote.view(task.id, "GET", path, none, undefined);
    expect(said.at(-1)).toContain("授权已收回");
    const kept = b.service.remote.copies.views.dirOf(task.id);
    expect(readdirSync(kept).length).toBeGreaterThan(0);
    await b.service.tasks.archiveTask(task.id);
    expect(existsSync(kept)).toBe(false);
  }, 60_000);

  it("what an agent opens shows on the side that started the turn; A also with 「我也关心」 (its window decides), B never for A's turns", async () => {
    const { a, b, task, session, ws, dir } = await grantedWithPack();
    const opened = (h: typeof a) => {
      const list: HostEvent[] = [];
      h.service.on("event", (e: HostEvent) => (e.type === "viewpack.open" || e.type === "review.open") && list.push(e));
      return list;
    };
    const onA = opened(a);
    const onB = opened(b);
    // The latest open of a pack each side heard (a quick second view_open joins the pack of a moment ago).
    const lastPack = (list: HostEvent[]) => list.filter((e) => e.type === "viewpack.open").at(-1);
    const agentText = (h: typeof a, t: string) => h.store.listItems(session.id).some((i) => i.type === "agent" && !i.streaming && i.markdown === t);
    await until(() => agentText(a, "FAKE: 第一句"), Boolean, "A's first reply");

    // B's message starts the turn: the pack shows on B; A has no window open and needs none.
    a.service.liveWindows = 0;
    await b.service.sessions.sendMessage(session.id, "从 B 来");
    await until(() => agentText(a, "FAKE: 从 B 来"), Boolean, "A replies to B");
    const p1 = (await a.service.viewPacks.open({ items: [{ kind: "file", path: "src/drop.ts" }] }, { sessionId: session.id })).pack;
    const onB1 = await until(() => onB.find((e) => e.type === "viewpack.open" && e.packId === p1.id), Boolean, "B told to open");
    expect(onB1).toMatchObject({ remote: task.id });
    expect(onB1).not.toHaveProperty("onlyIfAlsoMine");
    expect(onA.find((e) => e.type === "viewpack.open" && e.packId === p1.id)).toMatchObject({ onlyIfAlsoMine: task.id });
    // A Review of the task's project, the same way (B reads it through rt.view).
    await a.service.gitReview.openReview({ workspaceId: ws.id, sessionId: session.id });
    const r1 = await until(() => onB.find((e) => e.type === "review.open"), Boolean, "B told to open the Review");
    expect(r1).toMatchObject({ target: { workspaceId: ws.id, remote: task.id } });
    expect(r1).not.toHaveProperty("onlyIfAlsoMine");
    // A Review of another folder is not the task's: not sent to B — and A, without a window, says so.
    const elsewhere = tempDir("elsewhere");
    execFileSync("git", ["init", "-q"], { cwd: elsewhere });
    await expect(a.service.gitReview.openReview({ path: elsewhere, sessionId: session.id })).rejects.toThrow("窗口没有打开");
    void dir;

    // A's own message starts the next turn: A shows it as always; B is not told (its conversation's rows open it).
    a.service.liveWindows = 1;
    await a.service.sessions.sendMessage(session.id, "A 自己说");
    await until(() => agentText(a, "FAKE: A 自己说"), Boolean, "A replies");
    const heardB = onB.length;
    await a.service.viewPacks.open({ items: [{ kind: "file", path: "shot.png" }] }, { sessionId: session.id });
    expect(lastPack(onA)).not.toHaveProperty("onlyIfAlsoMine");
    await a.service.gitReview.openReview({ workspaceId: ws.id, sessionId: session.id });
    await new Promise((r) => setTimeout(r, 500));
    expect(onB.length).toBe(heardB);

    // B's turn, but B went away: shown on A (and A without a window refuses again, as before remote).
    await b.service.sessions.sendMessage(session.id, "B 最后一句");
    await until(() => agentText(a, "FAKE: B 最后一句"), Boolean, "A replies to B");
    b.remote.stop();
    await until(a.state, (s) => s.peers[0]?.online === false, "A sees B gone");
    a.service.liveWindows = 0;
    await expect(a.service.viewPacks.open({ items: [{ kind: "file", path: "src/drop.ts" }] }, { sessionId: session.id })).rejects.toThrow("窗口没有打开");
    a.service.liveWindows = 1;
    const heardA = onA.length;
    await a.service.viewPacks.open({ items: [{ kind: "file", path: "src/drop.ts" }] }, { sessionId: session.id });
    expect(onA.length).toBe(heardA + 1);
    expect(lastPack(onA)).not.toHaveProperty("onlyIfAlsoMine");
  }, 90_000);
  it("B's comments stay on B: written, copied with 任务文件夹/ paths, sent into the task's conversation as a message", async () => {
    const { a, b, task, session, ws } = await grantedWithPack();
    const none = new URLSearchParams();
    const base = `/api/workspaces/${ws.id}/review-comments`;
    const view = (method: string, path: string, body?: unknown) => b.remote.view(task.id, method, path, none, body);
    const agentText = (t: string) => a.store.listItems(session.id).some((i) => i.type === "agent" && !i.streaming && i.markdown === t);
    await until(() => agentText("FAKE: 第一句"), Boolean, "A's first reply");

    const first = (await view("POST", base, { range: "file", path: "src/drop.ts", side: "new", line: 1, lineText: "export const a = 2;", note: "改回 1" })) as GitReviewComment;
    const second = (await view("POST", base, { range: "working", path: "src/drop.ts", side: "new", line: 1, lineText: "export const a = 2;", note: "这一行不对" })) as GitReviewComment;
    const scrap = (await view("POST", base, { range: "file", path: "README.md", side: "new", line: 3, lineText: "x", note: "删掉" })) as GitReviewComment;
    // Checked as this computer's own comments are.
    await expect(view("POST", base, { range: "file", path: "src/drop.ts", side: "old", line: 1, lineText: "", note: "x" })).rejects.toThrow("new side");
    await expect(view("POST", base, { range: "file", path: "src/drop.ts", side: "new", line: 1, lineText: "", note: "  " })).rejects.toThrow("note is required");
    expect(((await view("PATCH", `/api/review-comments/${first.id}`, { note: "改回 1，别动别的" })) as GitReviewComment).note).toBe("改回 1，别动别的");
    expect(await view("DELETE", `/api/review-comments/${scrap.id}`)).toEqual({ ok: true });
    await expect(view("DELETE", `/api/review-comments/${scrap.id}`)).rejects.toThrow("not found");
    expect(((await view("GET", base)) as GitReviewComment[]).map((c) => c.id)).toEqual([first.id, second.id]);
    // Never on A: neither its comments nor the project's.
    expect(a.store.listReviewComments(ws.id)).toEqual([]);

    // 复制: the paths start at 任务文件夹/, the project is named by A; A's own folder never shows.
    const copied = (await view("POST", `${base}/copy`, { ids: [first.id] })) as { text: string; sent: GitReviewComment[] };
    expect(copied.text).toContain("「A-PC 上的任务文件夹」");
    expect(copied.text).toContain("### 任务文件夹/src/drop.ts");
    expect(copied.text).not.toContain(ws.path);
    expect(copied.sent).toMatchObject([{ id: first.id, state: "sent", sessionId: null }]);
    await expect(view("PATCH", `/api/review-comments/${first.id}`, { note: "again" })).rejects.toThrow("cannot be edited");

    // 发到对话: only into a conversation of this task; it reaches A as B's message (rt.send), paths as the session reads them.
    const other = (await b.service.tasks.createTask({ title: "B 自己的", workspaceId: b.service.tasks.commonWorkspace().id, firstSession: { profileId: "p", text: "B 这边" } })).session!;
    await expect(view("POST", `${base}/send`, { sessionId: other.id })).rejects.toThrow("只能发到这个远程任务自己的对话里");
    await expect(view("POST", `${base}/send`, { sessionId: "s-nope" })).rejects.toThrow("只能发到这个远程任务自己的对话里");
    const sent = (await view("POST", `${base}/send`, { sessionId: session.id })) as { mode: string; sent: GitReviewComment[] };
    expect(sent.sent).toMatchObject([{ id: second.id, state: "sent", sessionId: session.id }]);
    const msg = await until(() => a.store.listItems(session.id).find((i) => i.type === "user" && i.text.startsWith("Git Review 批注")), Boolean, "A got the comments");
    expect(msg).toMatchObject({ type: "user" });
    const text = (msg as { text: string }).text;
    expect(text).toContain("「任务文件夹」的改动");
    expect(text).toContain("### src/drop.ts");
    expect(text).toContain("这一行不对");
    expect(text).not.toContain("任务文件夹/src");
    await expect(view("POST", `${base}/copy`, {})).rejects.toThrow("no comments to copy");

    // Away from A, the comments are still B's to read; archiving the copy throws them away.
    a.remote.stop();
    await until(b.state, (s) => s.peers[0]?.online === false, "B sees A gone");
    expect(((await view("GET", base)) as GitReviewComment[]).length).toBe(2);
    await b.service.tasks.archiveTask(task.id);
    expect(b.service.remote.copies.comments.list(task.id)).toEqual([]);
  }, 60_000);
});
