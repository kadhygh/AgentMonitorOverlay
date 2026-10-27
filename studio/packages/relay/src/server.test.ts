import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { RelayClient, RelayClientError, type RelaySettings } from "./client.js";
import { createRelayMcp } from "./mcp.js";
import type { RelayEvent } from "./protocol.js";
import { startRelayServer, type RelayServer } from "./server.js";
import { RelayStore } from "./store.js";
import { usagePrompt } from "./usage.js";

let server: RelayServer | null = null;
let store: RelayStore | null = null;
const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await server?.close();
  store?.close();
  server = null;
  store = null;
});

async function service(publicDir?: string, timing: { clientWatchMs?: number; tickMs?: number } = {}) {
  store = new RelayStore(":memory:");
  const filesDir = mkdtempSync(join(tmpdir(), "relay-files-"));
  closers.push(() => rmSync(filesDir, { recursive: true, force: true }));
  server = await startRelayServer({ store, passphrase: "芝麻开门", publicDir, filesDir, host: "127.0.0.1", port: 0, name: "测试组", ...timing });
  const anon = new RelayClient(server.url);
  const a = await anon.register("策划小王", "pw-wang", { role: "策划", passphrase: "芝麻开门" });
  const b = await anon.register("程序老李", "pw-li", { role: "程序 · 战斗", passphrase: "芝麻开门" });
  return {
    url: server.url,
    planner: new RelayClient(server.url, a.key),
    coder: new RelayClient(server.url, b.key),
    plannerSettings: { server: server.url, name: a.name, key: a.key } satisfies RelaySettings,
  };
}

function events(url: string, key: string): Promise<{ next: () => Promise<RelayEvent>; ws: WebSocket }> {
  const ws = new WebSocket(`${url.replace("http", "ws")}/ws?key=${encodeURIComponent(key)}`);
  const queue: RelayEvent[] = [];
  const waiting: Array<(e: RelayEvent) => void> = [];
  ws.on("message", (d) => {
    const e = JSON.parse(String(d)) as RelayEvent;
    const w = waiting.shift();
    if (w) w(e);
    else queue.push(e);
  });
  closers.push(() => ws.close());
  return new Promise((ok, fail) => {
    ws.once("open", () => ok({ ws, next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise((r) => waiting.push(r))) }));
    ws.once("error", fail);
  });
}

describe("relay service", () => {
  it("registers with the invite passphrase, logs in and out", async () => {
    const { url } = await service();
    const anon = new RelayClient(url);
    expect(await anon.health()).toMatchObject({ name: "测试组", invite: true, client: null });
    await expect(anon.register("路人", "pw-lu", { passphrase: "错的" })).rejects.toMatchObject({ status: 401 });
    await expect(anon.members()).rejects.toBeInstanceOf(RelayClientError);
    await expect(new RelayClient(url, "bad").me()).rejects.toMatchObject({ status: 401 });
    await expect(anon.login("策划小王", "wrong")).rejects.toMatchObject({ status: 401 });
    const again = new RelayClient(url, (await anon.login("策划小王", "pw-wang")).key);
    expect((await again.me()).name).toBe("策划小王");
    await again.logout();
    await expect(again.me()).rejects.toMatchObject({ status: 401 });
  });

  it("hands out the client: landing page, content, downloads, never outside its folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-public-"));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "client", "assets"), { recursive: true });
    mkdirSync(join(dir, "downloads"));
    writeFileSync(join(dir, "client", "index.html"), "<p>client</p>");
    writeFileSync(join(dir, "client", "assets", "a.js"), "1");
    writeFileSync(join(dir, "client", "manifest.json"), JSON.stringify({ version: "0.1.0+1", builtAt: 1, minShell: 1, files: [] }));
    writeFileSync(join(dir, "downloads", "AMO-Relay.zip"), "zip");
    writeFileSync(join(dir, "secret.txt"), "no");
    const { url } = await service(dir);
    const get = (p: string) => fetch(`${url}${p}`);
    expect((await (await get("/api/health")).json()).client).toBe("0.1.0+1");
    const landing = await (await get("/")).text();
    expect(landing).toContain("/downloads/AMO-Relay.zip");
    expect(landing).toContain("/app/");
    expect(await (await get("/app/")).text()).toBe("<p>client</p>");
    expect(await (await get("/client/assets/a.js")).text()).toBe("1");
    expect((await get("/downloads/AMO-Relay.zip")).headers.get("content-disposition")).toContain("attachment");
    expect((await get("/client/..%2Fsecret.txt")).status).toBe(404);
    expect((await get("/client/nope.js")).status).toBe(404);
  });

  it("pushes a newly published client build and ticks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-public-"));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "client"));
    const publish = (version: string) => writeFileSync(join(dir, "client", "manifest.json"), JSON.stringify({ version, builtAt: 1, minShell: 1, files: [] }));
    publish("1");
    const { url, plannerSettings } = await service(dir, { clientWatchMs: 20, tickMs: 60 });
    const { next } = await events(url, plannerSettings.key);
    const seen: RelayEvent[] = [await next()];
    publish("2");
    while (!seen.some((e) => e.type === "client") || !seen.some((e) => e.type === "tick")) seen.push(await next());
    expect(seen[0]).toEqual({ type: "hello", me: "策划小王", client: "1" });
    expect(seen).toContainEqual({ type: "client", version: "2" });
  });

  it("carries a request and its reply, pushes it, and wakes a wait", async () => {
    const { url, planner, coder } = await service();
    const coderKey = coder.key!;
    const feed = await events(url, coderKey);
    expect(await feed.next()).toEqual({ type: "hello", me: "程序老李", client: null });
    expect((await feed.next()).type).toBe("members");

    const { thread } = await planner.ask({ to: "程序老李", title: "冷却按等级变", body: "见表", questions: [{ text: "能做吗", options: ["能", "不能"] }] });
    const pushed = await feed.next();
    expect(pushed).toMatchObject({ type: "message", thread: { id: thread.id }, message: { kind: "request" } });

    const waiting = planner.wait({ threadId: thread.id, after: thread.lastSeq, timeoutMs: 5000 });
    await coder.send(thread.id, { kind: "reply", answers: [{ questionId: "q1", choice: "能" }], verdict: "agree" });
    const got = await waiting;
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "reply", verdict: "agree", author: "程序老李" });

    // An answer that came before the wait is returned at once; nothing new times out empty.
    expect(await planner.wait({ threadId: thread.id, after: thread.lastSeq, timeoutMs: 5000 })).toHaveLength(1);
    expect(await planner.wait({ threadId: thread.id, after: got[0]!.seq, timeoutMs: 50 })).toEqual([]);

    const [view] = await planner.threads();
    expect(view).toMatchObject({ unread: 1, request: { status: "answered", verdict: "agree" } });
  });

  it("lets people chat directly, history on the service", async () => {
    const { planner, coder } = await service();
    const t = await planner.direct("程序老李");
    await planner.send(t.id, { body: "下午对一下战斗数值？" });
    await coder.send(t.id, { body: "好，三点" });
    const { messages } = await coder.messages(t.id);
    expect(messages.map((m) => [m.author, m.body])).toEqual([
      ["策划小王", "下午对一下战斗数值？"],
      ["程序老李", "好，三点"],
    ]);
    await expect(coder.send(t.id, { kind: "reply", verdict: "agree" })).rejects.toMatchObject({ status: 400 });
  });

  it("works as MCP tools for an AI", async () => {
    const { coder, plannerSettings } = await service();
    const mcp = await createRelayMcp({ settings: () => plannerSettings });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "claude-code", version: "1" });
    await Promise.all([mcp.connect(a), client.connect(b)]);
    closers.push(() => client.close());

    expect(client.getInstructions()).toContain("程序老李（程序 · 战斗）");
    const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

    expect(text(await client.callTool({ name: "relay_people", arguments: {} }))).toContain("程序老李");
    const asked = text(await client.callTool({ name: "relay_ask", arguments: { to: "程序老李", title: "接口确认", body: "要加 cooldownByLevel", questions: [{ text: "字段名可以吗" }] } }));
    const threadId = /threadId: (\S+)/.exec(asked)?.[1];
    expect(threadId).toBeTruthy();

    const [view] = await coder.threads();
    expect(view?.last).toMatchObject({ via: { kind: "ai", client: "claude-code" } });

    // The person asked cannot close it; they reply, and the AI waiting gets it — that counts as fetched.
    await expect(coder.session(threadId!, "done")).rejects.toThrow(/只有发起方能标记完成/);
    const waiting = client.callTool({ name: "relay_session_wait", arguments: { threadId, minutes: 0.2 } });
    await coder.send(threadId!, { kind: "reply", answers: [{ questionId: "q1", text: "改成 cdByLevel" }], verdict: "change" });
    const waited = text(await waiting);
    expect(waited).toContain("**字段名可以吗** → 改成 cdByLevel");
    expect(waited).toContain("结论：**需要改**");
    const [seen] = await coder.threads();
    expect(seen?.request).toMatchObject({ state: "returned", waitingOn: "策划小王", handler: "ai" });
    expect(seen?.request?.pickedAt).toBeTypeOf("number");

    expect(text(await client.callTool({ name: "relay_queue", arguments: {} }))).toContain("返回给我、等你接着处理");
    expect(text(await client.callTool({ name: "relay_replies", arguments: {} }))).toContain("已返回给 策划小王（需要改），由 AI 接着处理");
    expect(text(await client.callTool({ name: "relay_session_reply", arguments: { threadId, body: "那就用 cdByLevel？", then: "ask" } }))).toContain("回到 程序老李 手里");
    await coder.send(threadId!, { kind: "text", body: "可以", pass: true });
    expect(text(await client.callTool({ name: "relay_session_reply", arguments: { threadId, body: "好，按这个做", then: "done" } }))).toBe("已标记完成。");
    const got = text(await client.callTool({ name: "relay_session_get", arguments: { threadId } }));
    expect(got).toContain("· 已完成 ·");
    expect(got).toContain("的 AI（claude-code） 标记完成");
    expect(text(await client.callTool({ name: "relay_queue", arguments: {} }))).toBe("没有待处理的会话。");

    // Tasks: made, a session under it, handed over; the coder sees it handed to them.
    const made = text(await client.callTool({ name: "relay_task_create", arguments: { title: "加特林", description: "按住连射" } }));
    const taskId = /taskId: (\S+)/.exec(made)?.[1];
    expect(taskId).toBeTruthy();
    const second = text(await client.callTool({ name: "relay_session_open", arguments: { to: "程序老李", taskId, title: "过热", body: "复用能量条？", questions: [{ text: "能复用吗", options: ["能", "不能"] }] } }));
    const sid = /threadId: (\S+)/.exec(second)![1]!;
    await coder.send(sid, { kind: "reply", answers: [{ questionId: "q1", choice: "能" }] });
    const got2 = text(await client.callTool({ name: "relay_task_get", arguments: { taskId } }));
    expect(got2).toContain("### 决策\n- 能复用吗：能（来自会话「过热」）");
    expect(got2).toContain(`- 过热 · 策划小王 → 程序老李 · 已返回给 策划小王 · threadId ${sid}`);
    expect(text(await client.callTool({ name: "relay_task_transfer", arguments: { taskId, to: "程序老李", status: "待处理", reason: "请终审" } }))).toContain("已交给 程序老李");
    const [forCoder] = await coder.tasks();
    expect(forCoder).toMatchObject({ title: "加特林", holder: "程序老李", unseen: true });
    expect(text(await client.callTool({ name: "relay_task_list", arguments: { mine: true } }))).toBe("没有符合的任务。");

    // Files: the AI puts a local file into the task, the coder notes on it over HTTP, the AI reads both back.
    const dir = mkdtempSync(join(tmpdir(), "relay-put-"));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "designdoc.md"), "# 加特林\n\n基础射速每秒 12 发。");
    const put = text(await client.callTool({ name: "relay_file_put", arguments: { path: join(dir, "designdoc.md"), taskId } }));
    const fileId = /fileId: (\S+)/.exec(put)![1]!;
    expect(put).toContain("已上传 designdoc.md v1");
    const blob = await coder.fileData(fileId);
    expect(await blob.text()).toBe("# 加特林\n\n基础射速每秒 12 发。");
    const raw = await fetch(coder.fileUrl(fileId, { withKey: true }));
    expect(raw.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(raw.headers.get("content-security-policy")).toBe("sandbox");
    expect((await fetch(coder.fileUrl(fileId))).status).toBe(401);
    await coder.addNote(fileId, { quote: "每秒 12 发", body: "建议配表" });
    const read = text(await client.callTool({ name: "relay_file_get", arguments: { fileId } }));
    expect(read).toContain("基础射速每秒 12 发。");
    expect(read).toContain("> 每秒 12 发\n\n建议配表（程序老李）");
    const again2 = await coder.upload({ taskId }, "designdoc.md", new TextEncoder().encode("# v2"), "text/markdown");
    expect(again2).toMatchObject({ version: 2, versions: 2 });
    expect(text(await client.callTool({ name: "relay_task_get", arguments: { taskId } }))).toContain(`- designdoc.md v2 · fileId ${again2.id}`);
    const notJoined = await createRelayMcp({ settings: () => null });
    expect(notJoined).toBeTruthy();
  });
});

describe("usage prompt", () => {
  it("lists the others and the command line when there is one", () => {
    const p = usagePrompt({ me: "小王", members: [{ name: "小王", role: "" }, { name: "老李", role: "程序" }], cli: "amo-relay" });
    expect(p).toContain("- 老李（程序）");
    expect(p).not.toContain("- 小王");
    expect(p).toContain("amo-relay ask --json");
    expect(usagePrompt({ me: "小王" })).not.toContain("命令行");
  });
});
