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

async function service(publicDir?: string) {
  store = new RelayStore(":memory:");
  server = await startRelayServer({ store, passphrase: "芝麻开门", publicDir, host: "127.0.0.1", port: 0, name: "测试组" });
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

  it("carries a request and its reply, pushes it, and wakes a wait", async () => {
    const { url, planner, coder } = await service();
    const coderKey = coder.key!;
    const feed = await events(url, coderKey);
    expect(await feed.next()).toEqual({ type: "hello", me: "程序老李" });
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

    const waiting = client.callTool({ name: "relay_wait", arguments: { threadId, minutes: 0.2 } });
    await coder.send(threadId!, { kind: "reply", answers: [{ questionId: "q1", text: "改成 cdByLevel" }], verdict: "change" });
    const waited = text(await waiting);
    expect(waited).toContain("**字段名可以吗** → 改成 cdByLevel");
    expect(waited).toContain("结论：**需要改**");

    expect(text(await client.callTool({ name: "relay_replies", arguments: {} }))).toContain("已回复（需要改）");
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
