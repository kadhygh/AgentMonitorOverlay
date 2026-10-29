import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get as httpGet, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { RelayClient, RelayClientError, type RelaySettings } from "./client.js";
import { createRelayMcp } from "./mcp.js";
import type { RelayEvent } from "./protocol.js";
import { acceptsGzip, startRelayServer, type RelayServer } from "./server.js";
import { RelayStore } from "./store.js";
import { usagePrompt } from "./usage.js";
import { DeviceHub } from "./devices.js";
import { CLOSE_REPLACED, DEVICE_CHANNEL_VERSION, PAIR_REQUEST_DAYS, type DeviceEvent, type PairRequest, type PeerView } from "./devices-protocol.js";

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

async function service(publicDir?: string, timing: { clientWatchMs?: number; tickMs?: number; platformDir?: string } = {}) {
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

  it("the admin page: its own password; renames an account live (its sockets reconnect as the new name), resets a password, turns an account off", async () => {
    const { url, coder } = await service();
    const admin = (method: string, path: string, body?: unknown, pw = "admin-pw") =>
      fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", "x-amo-admin": pw }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));
    const page = await fetch(`${url}/admin`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("测试组 · 管理");
    // No password set yet: says how to set one; then a wrong one is refused.
    expect(await admin("GET", "/api/admin/members")).toMatchObject({ status: 403, body: { message: expect.stringContaining("admin-password") } });
    store!.setAdminPassword("admin-pw");
    expect((await admin("GET", "/api/admin/members", undefined, "wrong")).status).toBe(401);
    const list = await admin("GET", "/api/admin/members");
    expect(list.body).toMatchObject({ service: "测试组", invite: true });
    expect((list.body.members as Array<{ name: string }>).map((m) => m.name)).toEqual(["策划小王", "程序老李"]);

    const live = await events(url, coder.key!);
    expect((await live.next()).type).toBe("hello");
    const closed = new Promise<number>((ok) => live.ws.once("close", (code) => ok(code)));
    expect(await admin("POST", "/api/admin/rename", { from: "程序老李", to: "lee" })).toMatchObject({ status: 200, body: { from: "程序老李", to: "lee" } });
    expect(await closed).toBe(1012);
    // The same key, now as lee.
    expect((await coder.me()).name).toBe("lee");
    const again = await events(url, coder.key!);
    expect(await again.next()).toMatchObject({ type: "hello", me: "lee" });
    expect((await admin("POST", "/api/admin/rename", { from: "lee", to: "策划小王" })).status).toBe(409);

    const reset = await admin("POST", "/api/admin/password", { name: "lee" });
    expect(reset.body.password).toMatch(/^[a-z2-9]{8}$/);
    await expect(coder.me()).rejects.toMatchObject({ status: 401 });
    const lee = new RelayClient(url, (await new RelayClient(url).login("lee", String(reset.body.password))).key);
    expect((await admin("POST", "/api/admin/disable", { name: "lee", disabled: true })).status).toBe(200);
    await expect(lee.me()).rejects.toMatchObject({ status: 401 });
    await expect(new RelayClient(url).login("lee", String(reset.body.password))).rejects.toMatchObject({ status: 403 });
    await admin("POST", "/api/admin/disable", { name: "lee", disabled: false });
    expect((await new RelayClient(url).login("lee", String(reset.body.password))).name).toBe("lee");

    // The admin password itself, changed from the page: too short is refused; then the old one stops working.
    expect((await admin("POST", "/api/admin/admin-password", { password: "ab" })).status).toBe(400);
    expect(await admin("POST", "/api/admin/admin-password", { password: "new-admin-pw" })).toMatchObject({ status: 200, body: { ok: true } });
    expect((await admin("GET", "/api/admin/members")).status).toBe(401);
    expect((await admin("GET", "/api/admin/members", undefined, "new-admin-pw")).status).toBe(200);
  });

  it("the admin page sets the registration passphrase: needed once set, open again once cleared; the page's one wins over --passphrase", async () => {
    store = new RelayStore(":memory:");
    const filesDir = mkdtempSync(join(tmpdir(), "relay-files-"));
    closers.push(() => rmSync(filesDir, { recursive: true, force: true }));
    server = await startRelayServer({ store, filesDir, host: "127.0.0.1", port: 0, name: "测试组" });
    const url = server.url;
    store.setAdminPassword("admin-pw");
    const admin = (method: string, path: string, body?: unknown) =>
      fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", "x-amo-admin": "admin-pw" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));
    const anon = new RelayClient(url);
    // Open to start with.
    expect(await anon.health()).toMatchObject({ invite: false });
    expect((await admin("GET", "/api/admin/members")).body).toMatchObject({ invite: false });
    const early = await anon.register("早来的", "pw-early");
    expect((await admin("POST", "/api/admin/passphrase", { passphrase: "ab" })).status).toBe(400);
    expect(await admin("POST", "/api/admin/passphrase", { passphrase: "芝麻开门" })).toMatchObject({ status: 200, body: { invite: true } });
    expect(await anon.health()).toMatchObject({ invite: true });
    expect((await admin("GET", "/api/admin/members")).body).toMatchObject({ invite: true });
    await expect(anon.register("路人", "pw-lu")).rejects.toMatchObject({ status: 401 });
    await expect(anon.register("路人", "pw-lu", { passphrase: "错的" })).rejects.toMatchObject({ status: 401 });
    expect((await anon.register("新人", "pw-new", { passphrase: "芝麻开门" })).name).toBe("新人");
    // Accounts already there are untouched.
    expect((await new RelayClient(url, early.key).me()).name).toBe("早来的");
    expect((await anon.login("早来的", "pw-early")).name).toBe("早来的");
    // Cleared: open again.
    expect(await admin("POST", "/api/admin/passphrase", { passphrase: "" })).toMatchObject({ status: 200, body: { invite: false } });
    expect(await anon.health()).toMatchObject({ invite: false });
    expect((await anon.register("路人", "pw-lu")).name).toBe("路人");

    // A service started with --passphrase: the page's one replaces it while set; cleared, the started one is back.
    await server.close();
    server = await startRelayServer({ store, passphrase: "启动口令", filesDir, host: "127.0.0.1", port: 0, name: "测试组" });
    const url2 = server.url;
    const anon2 = new RelayClient(url2);
    const admin2 = (body: unknown) => fetch(`${url2}/api/admin/passphrase`, { method: "POST", headers: { "content-type": "application/json", "x-amo-admin": "admin-pw" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<Record<string, unknown>>);
    expect(await admin2({ passphrase: "页面口令" })).toMatchObject({ invite: true });
    await expect(anon2.register("甲", "pw-jia", { passphrase: "启动口令" })).rejects.toMatchObject({ status: 401 });
    expect((await anon2.register("甲", "pw-jia", { passphrase: "页面口令" })).name).toBe("甲");
    expect(await admin2({ passphrase: null })).toMatchObject({ invite: true });
    await expect(anon2.register("乙", "pw-yi")).rejects.toMatchObject({ status: 401 });
    expect((await anon2.register("乙", "pw-yi", { passphrase: "启动口令" })).name).toBe("乙");
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
    // 2026-10-28: the page links only AMO 平台; the client's zip and /app/ still answer, unlinked.
    expect(landing).not.toContain("/downloads/AMO-Relay.zip");
    expect(landing).not.toContain('href="/app/"');
    expect(await (await get("/app/")).text()).toBe("<p>client</p>");
    expect(await (await get("/client/assets/a.js")).text()).toBe("1");
    expect((await get("/downloads/AMO-Relay.zip")).headers.get("content-disposition")).toContain("attachment");
    expect((await get("/client/..%2Fsecret.txt")).status).toBe(404);
    expect((await get("/client/nope.js")).status).toBe(404);
  });

  it("hands out the AMO platform's files to people signed in, never outside the platform dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-platform-"));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    const body = "hello platform";
    const sha = createHash("sha256").update(body).digest("hex");
    mkdirSync(join(dir, "objects", sha.slice(0, 2)), { recursive: true });
    writeFileSync(join(dir, "objects", sha.slice(0, 2), sha), body);
    mkdirSync(join(dir, "tools", "notes"), { recursive: true });
    const manifest = { tool: "notes", name: "AMO Notes", version: "0.9.0", builtAt: 1, exe: "AMO Notes.exe", notes: "- 第一版", files: [{ path: "a.txt", size: body.length, sha256: sha }] };
    writeFileSync(join(dir, "tools", "notes", "0.9.0.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "tools", "secret.json"), "{}");
    writeFileSync(join(dir, "channels.json"), JSON.stringify({ stable: { notes: "0.9.0" }, test: { notes: "0.9.0" } }));
    mkdirSync(join(dir, "downloads"));
    writeFileSync(join(dir, "downloads", "AMO-Platform-win.zip"), "zip");
    const { url, plannerSettings } = await service(undefined, { platformDir: dir });
    const key = plannerSettings.key;
    const get = (p: string, k: string | null = key) => fetch(`${url}${p}`, { headers: k ? { authorization: `Bearer ${k}` } : {} });

    expect((await get("/api/platform/channels", null)).status).toBe(401);
    expect((await get(`/platform/objects/${sha}`, null)).status).toBe(401);
    expect(await (await get("/api/platform/channels")).json()).toEqual({ stable: { notes: "0.9.0" }, test: { notes: "0.9.0" } });
    expect(await (await get("/api/platform/tools/notes/0.9.0")).json()).toEqual(manifest);
    const obj = await get(`/platform/objects/${sha}`);
    expect(obj.headers.get("content-type")).toBe("application/octet-stream");
    expect(await obj.text()).toBe(body);
    // A plain URL with ?key= works too (downloads).
    expect(await (await get(`/platform/objects/${sha}?key=${encodeURIComponent(key)}`, null)).text()).toBe(body);

    expect((await get("/api/platform/tools/notes/0.9.1")).status).toBe(404);
    expect((await get(`/platform/objects/${"0".repeat(64)}`)).status).toBe(404);
    // Names that fail their pattern never reach the disk.
    for (const p of ["/api/platform/tools/Notes/0.9.0", "/api/platform/tools/notes/..%2Fsecret", "/api/platform/tools/..%2Ftools/0.9.0", "/api/platform/tools/notes/0.9", `/platform/objects/${sha.toUpperCase()}`, `/platform/objects/${sha.slice(1)}`, "/platform/objects/..%2Fchannels.json", "/platform/objects/%E0%A4%A"]) {
      expect((await get(p)).status, p).toBe(400);
    }
    expect((await get("/api/platform/tools/secret")).status).toBe(404);

    // The download page offers the platform; the zip needs no login.
    const landing = await (await get("/", null)).text();
    expect(landing).toContain("下载 AMO 平台");
    expect(landing).toContain("/downloads/AMO-Platform-win.zip");
    expect(landing).not.toContain("下载 Windows 客户端");
    const zip = await get("/downloads/AMO-Platform-win.zip", null);
    expect(zip.headers.get("content-disposition")).toContain("attachment");
    expect(await zip.text()).toBe("zip");
  });

  it("sends an object stored gzipped as gzip to a client that takes it, and unpacked to one that does not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-platform-"));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    const body = "AMO Studio ".repeat(50_000);
    const gz = gzipSync(body);
    const sha = createHash("sha256").update(body).digest("hex");
    const plain = "stored as it is";
    const plainSha = createHash("sha256").update(plain).digest("hex");
    const both = "both a .gz and the original (platform-compress half way) ".repeat(100);
    const bothSha = createHash("sha256").update(both).digest("hex");
    const put = (name: string, data: string | Buffer) => {
      mkdirSync(join(dir, "objects", name.slice(0, 2)), { recursive: true });
      writeFileSync(join(dir, "objects", name.slice(0, 2), name), data);
    };
    put(`${sha}.gz`, gz);
    put(plainSha, plain);
    put(bothSha, both);
    put(`${bothSha}.gz`, gzipSync(both));
    put(`${"a".repeat(64)}.gz`, Buffer.from("not gzip at all"));
    const { url, plannerSettings } = await service(undefined, { platformDir: dir });
    const key = plannerSettings.key;

    // fetch asks for gzip and unpacks it.
    const viaFetch = await fetch(`${url}/platform/objects/${sha}`, { headers: { authorization: `Bearer ${key}` } });
    expect(viaFetch.headers.get("content-encoding")).toBe("gzip");
    expect(viaFetch.headers.get("vary")).toBe("accept-encoding");
    expect(await viaFetch.text()).toBe(body);

    // On the wire, without anything unpacking it.
    const raw = (path: string, acceptEncoding?: string) =>
      new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
        const req = httpGet(`${url}${path}`, { headers: { authorization: `Bearer ${key}`, ...(acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding }) } }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
          res.on("error", reject);
        });
        req.on("error", reject);
      });
    const gzipped = await raw(`/platform/objects/${sha}`, "gzip, deflate, br");
    expect(gzipped.headers["content-encoding"]).toBe("gzip");
    expect(gzipped.headers["content-length"]).toBe(String(gz.length));
    expect(gzipped.body.equals(gz)).toBe(true);
    // A client that does not take gzip (curl without --compressed, gzip;q=0, identity) gets the original, unpacked on the way.
    for (const ae of [undefined, "identity", "gzip;q=0", "br", "*;q=0"]) {
      const r = await raw(`/platform/objects/${sha}`, ae);
      expect(r.status, String(ae)).toBe(200);
      expect(r.headers["content-encoding"], String(ae)).toBeUndefined();
      expect(r.body.toString(), String(ae)).toBe(body);
    }
    expect((await raw(`/platform/objects/${sha}`, "*")).headers["content-encoding"]).toBe("gzip");
    // Stored as it is: as before, whatever the client takes.
    for (const ae of [undefined, "gzip"]) {
      const r = await raw(`/platform/objects/${plainSha}`, ae);
      expect(r.headers["content-encoding"]).toBeUndefined();
      expect(r.headers["content-length"]).toBe(String(plain.length));
      expect(r.body.toString()).toBe(plain);
    }
    // Both there: either is right; the .gz is taken.
    expect((await raw(`/platform/objects/${bothSha}`, "gzip")).headers["content-encoding"]).toBe("gzip");
    expect((await raw(`/platform/objects/${bothSha}`)).body.toString()).toBe(both);
    // A damaged .gz unpacked on the way ends the response early instead of sending something else.
    await expect(raw(`/platform/objects/${"a".repeat(64)}`)).rejects.toThrow();
  });

  it("reads Accept-Encoding", () => {
    expect(acceptsGzip(undefined)).toBe(false);
    expect(acceptsGzip("gzip, deflate")).toBe(true);
    expect(acceptsGzip("deflate, GZIP;q=0.5")).toBe(true);
    expect(acceptsGzip("gzip;q=0")).toBe(false);
    expect(acceptsGzip("x-gzip")).toBe(true);
    expect(acceptsGzip("*")).toBe(true);
    expect(acceptsGzip("*, gzip;q=0")).toBe(false);
    expect(acceptsGzip("identity")).toBe(false);
  });

  it("says when it has no platform dir", async () => {
    const { url, plannerSettings } = await service();
    const res = await fetch(`${url}/api/platform/channels`, { headers: { authorization: `Bearer ${plannerSettings.key}` } });
    expect(res.status).toBe(404);
    expect((await res.json()).message).toContain("AMO_RELAY_PLATFORM_DIR");
    expect(await (await fetch(`${url}/`)).text()).toContain("还没有放 AMO 平台的安装包");
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

    // Short instructions (they sit in every conversation), and no stage-1 aliases.
    expect(client.getInstructions()).toContain("我是 策划小王（策划）");
    expect(client.getInstructions()!.length).toBeLessThan(400);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("relay_ask");
    expect(names).toHaveLength(14);
    const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

    expect(text(await client.callTool({ name: "relay_people", arguments: {} }))).toContain("程序老李");
    const asked = text(await client.callTool({ name: "relay_session_open", arguments: { to: "程序老李", title: "接口确认", body: "要加 cooldownByLevel", questions: [{ text: "字段名可以吗" }] } }));
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
    expect(text(await client.callTool({ name: "relay_session_get", arguments: {} }))).toContain("已返回给 策划小王（需要改），由 AI 接着处理");
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

// ---- Devices (remote sessions, step 1): pairing requests, pairs, frames between paired devices only.

type DevEvent = DeviceEvent;

/** A device's socket on the service, its events in a queue. */
function device(url: string, key: string, id: string, name: string): Promise<{ ws: WebSocket; next: (type?: DevEvent["type"]) => Promise<DevEvent>; send: (f: unknown) => void; closed: Promise<number> }> {
  const ws = new WebSocket(`${url.replace("http", "ws")}/api/devices/ws?device=${id}&name=${encodeURIComponent(name)}`, { headers: { authorization: `Bearer ${key}` } });
  const queue: DevEvent[] = [];
  const waiting: Array<() => void> = [];
  ws.on("message", (d) => {
    queue.push(JSON.parse(String(d)) as DevEvent);
    for (const w of waiting.splice(0)) w();
  });
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  closers.push(() => ws.terminate());
  /** The next event (of this type: others before it are dropped). */
  const next = async (type?: DevEvent["type"]): Promise<DevEvent> => {
    for (;;) {
      const i = queue.findIndex((e) => !type || e.type === type);
      if (i >= 0) return queue.splice(0, i + 1).at(-1)!;
      await new Promise<void>((r) => waiting.push(r));
    }
  };
  return new Promise((ok, fail) => {
    ws.once("open", () => ok({ ws, next, send: (f) => ws.send(JSON.stringify(f)), closed }));
    ws.once("error", fail);
  });
}

async function devicesCall<T = Record<string, unknown>>(url: string, key: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${url}${path}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as T };
}

describe("devices", () => {
  async function two(timing: { deviceHeartbeatMs?: number; deviceDeadMs?: number } = {}) {
    store = new RelayStore(":memory:");
    server = await startRelayServer({ store, host: "127.0.0.1", port: 0, ...timing });
    const a = store.register("台式机的我", "pw-aaaa").key;
    const b = store.register("笔记本的我", "pw-bbbb").key;
    return { url: server.url, a, b };
  }
  const A = { account: "台式机的我", device: "d_aaaaaaaaaaaa" };
  const B = { account: "笔记本的我", device: "d_bbbbbbbbbbbb" };

  it("says it has the devices channel, and every call needs the key and a device id", async () => {
    const { url, a } = await two();
    expect(await (await fetch(`${url}/api/health`)).json()).toMatchObject({ devices: DEVICE_CHANNEL_VERSION });
    expect((await devicesCall(url, null, "GET", `/api/devices/pairs?device=${A.device}`)).status).toBe(401);
    expect((await devicesCall(url, a, "GET", "/api/devices/pairs?device=x")).status).toBe(400);
    expect((await devicesCall(url, a, "POST", "/api/devices/pair", { device: A.device, deviceName: "", to: "笔记本的我" })).body).toMatchObject({ message: "设备名 不能为空" });
    expect((await devicesCall(url, a, "POST", "/api/devices/pair", { device: A.device, deviceName: "台式机", to: "没这人" })).status).toBe(404);
    // A socket without the key, or without a device id, is turned away.
    await expect(device(url, "bad", A.device, "台式机")).rejects.toThrow(/401/);
    await expect(device(url, a, "no", "台式机")).rejects.toThrow(/400/);
  });

  it("pairs B with A on A's say-so, passes frames between them only, and unpairs both ways", async () => {
    const { url, a, b } = await two();
    const da = await device(url, a, A.device, "台式机");
    expect(await da.next()).toMatchObject({ type: "hello", me: { ...A, name: "台式机" } });
    const db = await device(url, b, B.device, "笔记本");
    await db.next("hello");

    // Not paired: nothing goes through.
    db.send({ type: "relay", to: A, id: "c1", kind: "ping", body: { at: 1 } });
    expect(await db.next("relay-error")).toMatchObject({ id: "c1", code: "not_paired" });

    // B asks A's account; A's device sees it at once and in its list.
    const asked = await devicesCall<{ request: PairRequest }>(url, b, "POST", "/api/devices/pair", { device: B.device, deviceName: "笔记本", to: A.account });
    expect(asked.status).toBe(200);
    const request = asked.body.request;
    expect(request).toMatchObject({ from: { ...B, name: "笔记本" }, to: A.account, state: "pending", answeredBy: null });
    expect(await da.next("pair-request")).toMatchObject({ request: { id: request.id } });
    expect((await devicesCall(url, a, "GET", `/api/devices/pair?device=${A.device}`)).body).toMatchObject({ incoming: [{ id: request.id }], outgoing: [] });
    expect((await devicesCall(url, b, "GET", `/api/devices/pair?device=${B.device}`)).body).toMatchObject({ incoming: [], outgoing: [{ id: request.id, state: "pending" }] });
    // Asking again renews the same request; only A's account may answer, and not from B's side.
    expect((await devicesCall<{ request: PairRequest }>(url, b, "POST", "/api/devices/pair", { device: B.device, deviceName: "笔记本", to: A.account })).body.request.id).toBe(request.id);
    expect((await devicesCall(url, b, "POST", `/api/devices/pair/${request.id}/answer`, { device: B.device, deviceName: "笔记本", allow: true })).status).toBe(403);
    expect((await devicesCall(url, a, "POST", `/api/devices/pair/${request.id}/answer`, { device: A.device, deviceName: "台式机", allow: "yes" })).status).toBe(400);

    const answered = await devicesCall<{ request: PairRequest; pair: PeerView }>(url, a, "POST", `/api/devices/pair/${request.id}/answer`, { device: A.device, deviceName: "台式机", allow: true });
    expect(answered.body.request).toMatchObject({ state: "allowed", answeredBy: { ...A, name: "台式机" } });
    expect(answered.body.pair).toMatchObject({ peer: { ...B, name: "笔记本" }, role: "owner", online: true, ago: 0 });
    expect(await db.next("pair-answered")).toMatchObject({ request: { id: request.id, state: "allowed" } });
    expect((await devicesCall(url, a, "POST", `/api/devices/pair/${request.id}/answer`, { device: A.device, deviceName: "台式机", allow: false })).status).toBe(409);
    expect((await devicesCall(url, b, "GET", `/api/devices/pairs?device=${B.device}`)).body).toMatchObject({ pairs: [{ peer: { ...A, name: "台式机" }, role: "guest", online: true }] });
    // B puts the answer away once it has seen it.
    expect((await devicesCall(url, b, "DELETE", `/api/devices/pair/${request.id}?device=${B.device}`)).status).toBe(200);
    expect((await devicesCall(url, b, "GET", `/api/devices/pair?device=${B.device}`)).body).toMatchObject({ outgoing: [] });

    // Frames now pass, envelope added, body untouched; an answer carries `re`.
    db.send({ type: "relay", to: A, id: "c2", kind: "ping", body: { at: 5, deep: [1, { x: "中" }] } });
    expect(await da.next("relay")).toEqual({ type: "relay", from: B, to: A, id: "c2", kind: "ping", body: { at: 5, deep: [1, { x: "中" }] } });
    da.send({ type: "relay", to: B, id: "c3", kind: "pong", re: "c2" });
    expect(await db.next("relay")).toMatchObject({ from: A, id: "c3", kind: "pong", re: "c2" });
    // Bad frames are said to be bad, not passed on.
    db.send({ type: "relay", to: A, id: "c4", kind: "Ping!" });
    expect(await db.next("relay-error")).toMatchObject({ id: "c4", code: "bad_frame" });
    db.ws.send("not json");
    expect(await db.next("relay-error")).toMatchObject({ code: "bad_frame" });

    // A renames itself: its peer hears of it and the pair list follows.
    da.send({ type: "name", name: "书房台式机" });
    expect(await db.next("presence")).toMatchObject({ peer: { ...A, name: "书房台式机" }, online: true });

    // A goes away: B hears so, and frames to A say offline.
    da.ws.close();
    expect(await db.next("presence")).toMatchObject({ peer: A, online: false });
    db.send({ type: "relay", to: A, id: "c5", kind: "ping" });
    expect(await db.next("relay-error")).toMatchObject({ id: "c5", code: "offline" });
    const offline = await devicesCall<{ pairs: PeerView[] }>(url, b, "GET", `/api/devices/pairs?device=${B.device}`);
    expect(offline.body.pairs[0]).toMatchObject({ peer: { name: "书房台式机" }, online: false });
    expect(offline.body.pairs[0]!.ago).toBeGreaterThanOrEqual(0);

    // A back, then B ends the pairing: A is told, nothing passes any more.
    const da2 = await device(url, a, A.device, "书房台式机");
    await da2.next("hello");
    expect((await devicesCall(url, b, "POST", "/api/devices/unpair", { device: B.device, peerAccount: A.account, peerDevice: A.device })).body).toEqual({ ok: true, removed: 1 });
    expect(await da2.next("unpaired")).toEqual({ type: "unpaired", peer: B });
    expect((await devicesCall(url, a, "GET", `/api/devices/pairs?device=${A.device}`)).body).toEqual({ pairs: [] });
    db.send({ type: "relay", to: A, id: "c6", kind: "ping" });
    expect(await db.next("relay-error")).toMatchObject({ id: "c6", code: "not_paired" });
  });

  it("keeps a request for an account that is away; a refusal reaches B; B may withdraw", async () => {
    const { url, a, b } = await two();
    const r1 = (await devicesCall<{ request: PairRequest }>(url, b, "POST", "/api/devices/pair", { device: B.device, deviceName: "笔记本", to: A.account })).body.request;
    expect(r1.expiresAt - r1.createdAt).toBe(PAIR_REQUEST_DAYS * 24 * 60 * 60_000);
    // A comes online later and finds it waiting.
    const da = await device(url, a, A.device, "台式机");
    await da.next("hello");
    expect((await devicesCall(url, a, "GET", `/api/devices/pair?device=${A.device}`)).body).toMatchObject({ incoming: [{ id: r1.id }] });
    // Refused while B is away: B finds the answer when it asks.
    await devicesCall(url, a, "POST", `/api/devices/pair/${r1.id}/answer`, { device: A.device, deviceName: "台式机", allow: false });
    expect((await devicesCall(url, b, "GET", `/api/devices/pair?device=${B.device}`)).body).toMatchObject({ outgoing: [{ id: r1.id, state: "refused", answeredBy: { name: "台式机" } }] });
    expect((await devicesCall(url, a, "GET", `/api/devices/pairs?device=${A.device}`)).body).toEqual({ pairs: [] });
    // A new request replaces the old answer; withdrawing it tells A's devices.
    const r2 = (await devicesCall<{ request: PairRequest }>(url, b, "POST", "/api/devices/pair", { device: B.device, deviceName: "笔记本", to: A.account })).body.request;
    expect(r2.id).not.toBe(r1.id);
    await da.next("pair-request");
    expect((await devicesCall(url, a, "DELETE", `/api/devices/pair/${r2.id}?device=${A.device}`)).status).toBe(403);
    await devicesCall(url, b, "DELETE", `/api/devices/pair/${r2.id}?device=${B.device}`);
    expect(await da.next("pair-request-closed")).toEqual({ type: "pair-request-closed", requestId: r2.id });
    expect((await devicesCall(url, a, "GET", `/api/devices/pair?device=${A.device}`)).body).toMatchObject({ incoming: [] });
  });

  it("lists the account's other online devices; a request to one of them is that device's alone", async () => {
    const { url, a, b } = await two();
    const A2 = { account: A.account, device: "d_aaaa22222222" };
    const A3 = { account: A.account, device: "d_aaaa33333333" };
    expect((await devicesCall(url, a, "GET", "/api/devices/online?device=x")).status).toBe(400);
    expect((await devicesCall(url, a, "GET", `/api/devices/online?device=${A.device}`)).body).toEqual({ devices: [] });
    const d2 = await device(url, a, A2.device, "笔记本");
    await d2.next("hello");
    const d3 = await device(url, a, A3.device, "家里的电脑");
    await d3.next("hello");
    // Another account's device is never listed.
    await (await device(url, b, B.device, "别人的")).next("hello");
    const listed = await devicesCall<{ devices: Array<{ device: string; name: string; since: number }> }>(url, a, "GET", `/api/devices/online?device=${A.device}`);
    expect(listed.body.devices.map((d) => [d.device, d.name]).sort()).toEqual([
      [A2.device, "笔记本"],
      [A3.device, "家里的电脑"],
    ]);
    expect(listed.body.devices[0]!.since).toBeGreaterThan(0);
    // The asking device is left out even when it is connected itself.
    expect((await devicesCall<{ devices: Array<{ device: string }> }>(url, a, "GET", `/api/devices/online?device=${A2.device}`)).body.devices.map((d) => d.device)).toEqual([A3.device]);

    // A (not connected) asks 笔记本 only: 笔记本 hears of it and may answer; 家里的电脑 neither.
    expect((await devicesCall(url, a, "POST", "/api/devices/pair", { device: A.device, deviceName: "台式机", to: A.account, toDevice: A.device })).status).toBe(400);
    const asked = await devicesCall<{ request: PairRequest }>(url, a, "POST", "/api/devices/pair", { device: A.device, deviceName: "台式机", to: A.account, toDevice: A2.device });
    expect(asked.body.request).toMatchObject({ to: A.account, toDevice: { device: A2.device, name: "笔记本" } });
    expect(await d2.next("pair-request")).toMatchObject({ request: { id: asked.body.request.id } });
    expect((await devicesCall(url, a, "GET", `/api/devices/pair?device=${A2.device}`)).body).toMatchObject({ incoming: [{ id: asked.body.request.id }] });
    expect((await devicesCall(url, a, "GET", `/api/devices/pair?device=${A3.device}`)).body).toMatchObject({ incoming: [] });
    expect((await devicesCall(url, a, "POST", `/api/devices/pair/${asked.body.request.id}/answer`, { device: A3.device, deviceName: "家里的电脑", allow: true })).body).toMatchObject({ message: "这个配对请求是发给「笔记本」的" });
    // Asking the account as a whole is another request beside it.
    const whole = await devicesCall<{ request: PairRequest }>(url, a, "POST", "/api/devices/pair", { device: A.device, deviceName: "台式机", to: A.account });
    expect(whole.body.request).toMatchObject({ toDevice: null });
    expect(whole.body.request.id).not.toBe(asked.body.request.id);
    const answered = await devicesCall<{ pair: PeerView }>(url, a, "POST", `/api/devices/pair/${asked.body.request.id}/answer`, { device: A2.device, deviceName: "笔记本", allow: true });
    expect(answered.body.pair).toMatchObject({ peer: { ...A, name: "台式机" }, role: "owner" });
  });

  it("drops a device that stops answering pings, and a second socket of a device replaces the first", async () => {
    const { url, a, b } = await two({ deviceHeartbeatMs: 40, deviceDeadMs: 200 });
    const r = (await devicesCall<{ request: PairRequest }>(url, b, "POST", "/api/devices/pair", { device: B.device, deviceName: "笔记本", to: A.account })).body.request;
    await devicesCall(url, a, "POST", `/api/devices/pair/${r.id}/answer`, { device: A.device, deviceName: "台式机", allow: true });
    const db = await device(url, b, B.device, "笔记本");
    await db.next("hello");
    const da = await device(url, a, A.device, "台式机");
    expect(await db.next("presence")).toMatchObject({ peer: A, online: true });
    // A stops reading (no pongs): the service gives up on it and B hears A went.
    da.ws.pause();
    expect(await db.next("presence")).toMatchObject({ peer: A, online: false });
    // B connects again from a second socket: the first is closed with the 「replaced」 code.
    const db2 = await device(url, b, B.device, "笔记本");
    await db2.next("hello");
    expect(await db.closed).toBe(CLOSE_REPLACED);
  });

  it("forgets requests after 7 days", () => {
    let now = 1_000_000;
    const db = new RelayStore(":memory:");
    closers.push(() => db.close());
    const hub = new DeviceHub({ db: db.db, isMember: () => true, now: () => now });
    closers.push(() => hub.close());
    const r = hub.requestPair({ ...B, name: "笔记本" }, A.account);
    expect(hub.requests(A).incoming.map((x) => x.id)).toEqual([r.id]);
    now += PAIR_REQUEST_DAYS * 24 * 60 * 60_000;
    expect(hub.requests(A).incoming).toEqual([]);
    expect(() => hub.answer({ ...A, name: "台式机" }, r.id, true)).toThrow(/不在了/);
  });
});

describe("usage prompt", () => {
  it("lists the others and the command line when there is one", () => {
    const p = usagePrompt({ me: "小王", members: [{ name: "小王", role: "" }, { name: "老李", role: "程序" }], cli: "amo-relay" });
    expect(p).toContain("- 老李（程序）");
    expect(p).not.toContain("- 小王");
    expect(p).toContain("`relay ask --json <文件>`");
    expect(p).toContain('PowerShell 写 `& "amo-relay" people`');
    expect(p).not.toContain("newtask");
    expect(p).toContain("`relay put <本机文件> --thread <threadId>`");
    expect(usagePrompt({ me: "小王", cli: "amo-relay", tasks: true })).toContain("`relay newtask --title");
    expect(usagePrompt({ me: "小王" })).not.toContain("命令行");
    expect(usagePrompt({ me: "小王" })).toContain("relay_session_open");
    expect(usagePrompt({ me: "小王" })).not.toContain("relay_task_");
    expect(usagePrompt({ me: "小王", tasks: true })).toContain("relay_task_list");
  });
});
