import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { peerPresence, REMOTE_LOST_MS, type ModelProfile, type RemoteState } from "@amo-studio/protocol";
import { deviceFile, ensureDevice, readDevice, saveAccount, setDeviceName, type Protector } from "@amo-studio/account";
import { RelayStore, startRelayServer, type DeviceEvent, type RelayServer } from "@amo-studio/relay";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { Backoff, CommandError, CommandLog, DeviceLink } from "./link.js";

// 远程, step 1 (plans/remote-session.md): this computer's device id, the reconnect backoff, commands answered once, and
// two Hosts pairing through a relay service on this machine (never the team server).

const fake: Protector = {
  protect: async (t) => Buffer.from(`enc:${t}`).toString("base64"),
  unprotect: async (d) => Buffer.from(d, "base64").toString().slice(4),
};
const PROFILES: ModelProfile[] = [{ id: "p", label: "P", runtime: "codex", provider: "x", model: "m" }];

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const tempDir = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `amo-remote-${name}-`));
  cleanups.push(() => removeTempDir(d));
  return d;
};

async function until<T>(read: () => T, ok: (v: T) => boolean, what = "condition", ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("device.json", () => {
  it("is made once with a random id and the computer's name, renamed in place, and follows AMO_HOME", () => {
    const home = tempDir("device");
    const env = { AMO_HOME: home, COMPUTERNAME: "KANGAROO-PC" };
    expect(readDevice({ env })).toBeNull();
    const d = ensureDevice({ env });
    expect(d.id).toMatch(/^d_[0-9a-f]{24}$/);
    expect(d.name).toBe("KANGAROO-PC");
    expect(deviceFile(env)).toBe(join(home, "device.json"));
    // A second program gets the same one.
    expect(ensureDevice({ env })).toEqual(d);
    expect(setDeviceName("  书房台式机 ", { env })).toEqual({ id: d.id, name: "书房台式机" });
    expect(readDevice({ env })).toEqual({ id: d.id, name: "书房台式机" });
    expect(() => setDeviceName("", { env })).toThrow("设备名不能为空");
    expect(() => setDeviceName("x".repeat(41), { env })).toThrow(/太长/);
    expect(() => setDeviceName("a\nb", { env })).toThrow(/控制字符/);
    // A damaged file is replaced, not trusted.
    writeFileSync(deviceFile(env), "{ not json");
    expect(readDevice({ env })).toBeNull();
    expect(ensureDevice({ env }).id).not.toBe(d.id);
    expect(JSON.parse(readFileSync(deviceFile(env), "utf8")).name).toBe("KANGAROO-PC");
  });
});

describe("backoff and command ids", () => {
  it("doubles from 1 s to 30 s with ±20 % jitter, and starts over after reset", () => {
    const mid = new Backoff({ random: () => 0.5 });
    expect(Array.from({ length: 7 }, () => mid.next())).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    mid.reset();
    expect(mid.next()).toBe(1000);
    expect(new Backoff({ random: () => 0 }).next()).toBe(800);
    expect(new Backoff({ random: () => 0.999999 }).next()).toBe(1200);
    const top = new Backoff({ random: () => 1 });
    for (let i = 0; i < 10; i++) expect(top.next()).toBeLessThanOrEqual(30_000);
  });

  it("answers a repeated command with the first answer, per sender, for 10 minutes, at most N kept", () => {
    let now = 0;
    const log = new CommandLog<string>({ now: () => now, max: 3 });
    const a = { account: "a", device: "d_aaaaaa" };
    const b = { account: "b", device: "d_bbbbbb" };
    log.remember(a, "c1", "pong-1");
    expect(log.get(a, "c1")).toBe("pong-1");
    expect(log.get(b, "c1")).toBeUndefined();
    now += 10 * 60_000 + 1;
    expect(log.get(a, "c1")).toBeUndefined();
    for (const id of ["x1", "x2", "x3", "x4"]) log.remember(a, id, id);
    expect(log.size).toBe(3);
    expect(log.get(a, "x1")).toBeUndefined();
    expect(log.get(a, "x4")).toBe("x4");
  });

  it("says 刚失联 for five minutes after a device went, then 离线", () => {
    const now = Date.parse("2026-10-29T10:00:00Z");
    expect(peerPresence({ online: true, lastSeen: null }, now)).toBe("online");
    expect(peerPresence({ online: null, lastSeen: null }, now)).toBe("unknown");
    expect(peerPresence({ online: false, lastSeen: new Date(now - 60_000).toISOString() }, now)).toBe("lost");
    expect(peerPresence({ online: false, lastSeen: new Date(now - REMOTE_LOST_MS - 1).toISOString() }, now)).toBe("offline");
    expect(peerPresence({ online: false, lastSeen: null }, now)).toBe("offline");
  });
});

// ---- against a relay service on this machine

let relayStore: RelayStore;
let relay: RelayServer;

async function startRelay(port = 0): Promise<RelayServer> {
  relay = await startRelayServer({ store: relayStore, host: "127.0.0.1", port });
  return relay;
}

async function relayService(): Promise<{ url: string; keys: Record<string, string> }> {
  relayStore = new RelayStore(":memory:");
  await startRelay();
  cleanups.push(() => relayStore.close());
  cleanups.push(() => relay.close());
  const keys = { 台式机的我: relayStore.register("台式机的我", "pw-aaaa").key, 笔记本的我: relayStore.register("笔记本的我", "pw-bbbb").key };
  return { url: relay.url, keys };
}

async function host(name: string, server: string, account: string | null, key = "") {
  const home = tempDir(name);
  const env = { AMO_HOME: home, COMPUTERNAME: name };
  if (account) await saveAccount({ server, name: account, key }, { env, protector: fake });
  const store = new Store(join(tempDir(`${name}-data`), "studio.db"));
  const service = new HostService(store, new CodexRuntime({ store, servers: new FakeServers(PROFILES), profiles: PROFILES }), PROFILES);
  const events: RemoteState[] = [];
  service.on("event", (e) => e.type === "remote.updated" && events.push(e.remote));
  service.remote.start({ env, protector: fake, watchMs: 30, backoff: new Backoff({ baseMs: 30, maxMs: 120 }), pingTimeoutMs: 2000 });
  cleanups.push(() => {
    service.remote.stop();
    store.close();
  });
  const state = () => service.remote.state();
  return { service, store, env, home, events, state, remote: service.remote };
}

const online = (s: RemoteState) => s.connection.state === "online";

describe("remote between two Hosts", () => {
  it("without the platform's login says so, and connects once the platform logs in", async () => {
    const { url, keys } = await relayService();
    const a = await host("A-PC", url, null);
    expect(a.state()).toMatchObject({ account: null, connection: { state: "no-account" }, device: { name: "A-PC" } });
    await expect(a.remote.requestPair("笔记本的我")).rejects.toThrow("在 AMO 平台里登录后才能用远程功能");
    await saveAccount({ server: url, name: "台式机的我", key: keys["台式机的我"]! }, { env: a.env, protector: fake });
    await until(a.state, online, "online after login");
    expect(a.state().account).toEqual({ server: url, name: "台式机的我" });
    // Logged out in the platform: off the server again.
    rmSync(join(a.home, "account.json"));
    await until(a.state, (s) => s.connection.state === "no-account", "no-account after logout");
  });

  it("pairs B with A, tests the connection both ways, and an unpairing on A reaches B", async () => {
    const { url, keys } = await relayService();
    const a = await host("A-PC", url, "台式机的我", keys["台式机的我"]);
    const b = await host("B-PC", url, "笔记本的我", keys["笔记本的我"]);
    await until(a.state, online, "A online");
    await until(b.state, online, "B online");

    await expect(b.remote.requestPair("没这人")).rejects.toThrow("服务器上没有账号「没这人」");
    const sent = await b.remote.requestPair("台式机的我");
    expect(sent.outgoing).toMatchObject([{ to: "台式机的我", state: "pending" }]);
    const asked = await until(a.state, (s) => s.incoming.length === 1, "A sees the request");
    expect(asked.incoming[0]).toMatchObject({ account: "笔记本的我", name: "B-PC" });
    expect(a.events.some((e) => e.incoming.length === 1)).toBe(true);

    const after = await a.remote.answer(asked.incoming[0]!.id, true);
    expect(after.incoming).toEqual([]);
    expect(after.peers).toMatchObject([{ account: "笔记本的我", name: "B-PC", role: "owner", online: true }]);
    const bSees = await until(b.state, (s) => s.peers.length === 1, "B gets the pair");
    expect(bSees.peers[0]).toMatchObject({ account: "台式机的我", name: "A-PC", role: "guest", online: true });
    expect(bSees.outgoing).toEqual([]);
    // Kept in the Host's data, by account + device.
    expect(JSON.parse(a.store.getKv("remote.pairs")!.value)).toMatchObject([{ account: "笔记本的我", device: b.state().device!.id, role: "owner" }]);

    const peerOfA = { account: "笔记本的我", device: b.state().device!.id };
    const peerOfB = { account: "台式机的我", device: a.state().device!.id };
    expect(await a.remote.ping(peerOfA)).toMatchObject({ ok: true, message: expect.stringMatching(/^对方在线，往返 \d+ 毫秒$/) });
    expect(await b.remote.ping(peerOfB)).toMatchObject({ ok: true });

    // B renames itself: A's list follows.
    b.remote.rename("我的笔记本");
    await until(a.state, (s) => s.peers[0]?.name === "我的笔记本", "A sees the new name");

    // A ends it: B forgets A too, and a ping no longer goes anywhere.
    const ended = await a.remote.unpair(peerOfA);
    expect(ended.peers).toEqual([]);
    await until(b.state, (s) => s.peers.length === 0, "B loses the pair");
    await expect(b.remote.ping(peerOfB)).rejects.toThrow("没有和这台设备配对");
  });

  it("an approval made while B was away reaches B when it is back; a refusal stays until B puts it away", async () => {
    const { url, keys } = await relayService();
    const a = await host("A-PC", url, "台式机的我", keys["台式机的我"]);
    const b = await host("B-PC", url, "笔记本的我", keys["笔记本的我"]);
    await until(b.state, online, "B online");
    await until(a.state, online, "A online");
    await b.remote.requestPair("台式机的我");
    const r1 = (await until(a.state, (s) => s.incoming.length === 1, "request")).incoming[0]!;
    await a.remote.answer(r1.id, false);
    const refused = await until(b.state, (s) => s.outgoing[0]?.state === "refused", "B sees the refusal");
    expect(refused.outgoing[0]).toMatchObject({ answeredBy: "A-PC" });
    expect((await b.remote.dismiss(refused.outgoing[0]!.id)).outgoing).toEqual([]);

    // Ask again, B goes away, A allows, B comes back: the pair is there.
    await b.remote.requestPair("台式机的我");
    const r2 = (await until(a.state, (s) => s.incoming.length === 1, "second request")).incoming[0]!;
    b.remote.stop();
    await a.remote.answer(r2.id, true);
    b.remote.start({ env: b.env, protector: fake, watchMs: 30, backoff: new Backoff({ baseMs: 30, maxMs: 120 }) });
    const back = await until(b.state, (s) => s.peers.length === 1, "B gets the pair after coming back");
    expect(back.peers[0]).toMatchObject({ account: "台式机的我", role: "guest" });
  });

  it("comes back by itself after the server went away, and a command left unanswered is unconfirmed, not resent", async () => {
    const { url, keys } = await relayService();
    const a = await host("A-PC", url, "台式机的我", keys["台式机的我"]);
    await until(a.state, online, "A online");
    // A raw device B paired with A: it sends the same ping twice and gets the same answer twice.
    const bDevice = "d_bbbbbbbbbbbbbbbbbbbbbbbb";
    const req = (await (await fetch(`${url}/api/devices/pair`, { method: "POST", headers: { authorization: `Bearer ${keys["笔记本的我"]}`, "content-type": "application/json" }, body: JSON.stringify({ device: bDevice, deviceName: "B-raw", to: "台式机的我" }) })).json()) as { request: { id: string } };
    await until(a.state, (s) => s.incoming.length === 1, "request");
    await a.remote.answer(req.request.id, true);
    const ws = new WebSocket(`${url.replace("http", "ws")}/api/devices/ws?device=${bDevice}&name=B-raw`, { headers: { authorization: `Bearer ${keys["笔记本的我"]}` } });
    cleanups.push(() => ws.terminate());
    const got: DeviceEvent[] = [];
    ws.on("message", (d) => got.push(JSON.parse(String(d)) as DeviceEvent));
    await new Promise((r) => ws.once("open", r));
    const toA = { account: "台式机的我", device: a.state().device!.id };
    ws.send(JSON.stringify({ type: "relay", to: toA, id: "same-1", kind: "ping" }));
    ws.send(JSON.stringify({ type: "relay", to: toA, id: "same-1", kind: "ping" }));
    const pongs = await until(() => got.filter((e) => e.type === "relay"), (l) => l.length === 2, "two answers");
    expect(pongs[0]).toMatchObject({ kind: "pong", re: "same-1" });
    expect(pongs[1]).toEqual(pongs[0]);
    // Something A does not know: said so.
    ws.send(JSON.stringify({ type: "relay", to: toA, id: "odd-1", kind: "task.open" }));
    expect(await until(() => got.filter((e) => e.type === "relay").at(-1), (e) => (e as { re?: string } | undefined)?.re === "odd-1", "error answer")).toMatchObject({ kind: "error", body: { code: "unknown_kind" } });

    // A link that asks B (who never answers) and loses the server meanwhile: unconfirmed.
    const link = new DeviceLink({ server: url, key: keys["台式机的我"]!, device: { id: "d_cccccccccccc", name: "C" }, backoff: new Backoff({ baseMs: 30, maxMs: 60 }) });
    cleanups.push(() => link.stop());
    link.start();
    await until(() => link.state, (s) => s === "online", "link online");
    await expect(link.request({ account: "笔记本的我", device: bDevice }, "ping", {})).rejects.toMatchObject({ code: "not_paired" });
    const port = relay.port;
    await relay.close();
    await until(a.state, (s) => s.connection.state === "offline" && s.peers[0]?.online === null, "A offline, peers unknown");
    await expect(link.request(toA, "ping", {})).rejects.toBeInstanceOf(CommandError);
    // The service is back on the same port: A connects again by itself.
    await startRelay(port);
    await until(a.state, online, "A back online", 8000);
    await until(() => link.state, (s) => s === "online", "link back online", 8000);
  });

  it("a request in flight when the connection drops is「结果未确认」", async () => {
    const { url, keys } = await relayService();
    const a = await host("A-PC", url, "台式机的我", keys["台式机的我"]);
    await until(a.state, online, "A online");
    const bDevice = "d_dddddddddddddddddddddddd";
    const req = (await (await fetch(`${url}/api/devices/pair`, { method: "POST", headers: { authorization: `Bearer ${keys["笔记本的我"]}`, "content-type": "application/json" }, body: JSON.stringify({ device: bDevice, deviceName: "B-silent", to: "台式机的我" }) })).json()) as { request: { id: string } };
    await until(a.state, (s) => s.incoming.length === 1, "request");
    await a.remote.answer(req.request.id, true);
    // B is connected but never answers.
    const ws = new WebSocket(`${url.replace("http", "ws")}/api/devices/ws?device=${bDevice}&name=B-silent`, { headers: { authorization: `Bearer ${keys["笔记本的我"]}` } });
    cleanups.push(() => ws.terminate());
    await new Promise((r) => ws.once("open", r));
    const ping = a.remote.ping({ account: "笔记本的我", device: bDevice });
    await new Promise((r) => setTimeout(r, 100));
    await relay.close();
    expect(await ping).toMatchObject({ ok: false, message: expect.stringContaining("结果未确认") });
    // A fresh store so afterEach can close what it opened.
    await startRelay();
  });
});

describe("why a connection is refused", () => {
  it("tells a login the server no longer takes from a server without the devices channel", async () => {
    const { url } = await relayService();
    const bad = new DeviceLink({ server: url, key: "not-a-key", device: { id: "d_eeeeeeeeeeee", name: "E" } });
    cleanups.push(() => bad.stop());
    bad.start();
    await until(() => bad.state, (s) => s === "unauthorized", "unauthorized");
    expect(bad.message).toContain("在 AMO 平台里重新登录");
    // A relay from before devices: 401 on any socket path but /ws, and no `devices` in its health.
    const old = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ app: "amo-relay", version: "0.7.0", name: "旧的", invite: false, client: null }));
    });
    old.on("upgrade", (_req, socket) => {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
    });
    await new Promise<void>((r) => old.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => old.close(() => r())));
    const link = new DeviceLink({ server: `http://127.0.0.1:${(old.address() as AddressInfo).port}`, key: "k", device: { id: "d_ffffffffffff", name: "F" } });
    cleanups.push(() => link.stop());
    link.start();
    await until(() => link.state, (s) => s === "server-old", "server-old");
    expect(link.message).toContain("中转服务还没有更新");
  });
});

describe("a Host without remote", () => {
  it("reads nothing from a server and says remote is off", async () => {
    const store = new Store(join(tempDir("off"), "studio.db"));
    cleanups.push(() => store.close());
    const service = new HostService(store, new CodexRuntime({ store, servers: new FakeServers(PROFILES), profiles: PROFILES }), PROFILES);
    expect(service.remote.state().connection.state).toBe("off");
    await expect(service.remote.requestPair("x")).rejects.toThrow("这个 Host 没有开远程功能");
  });
});
