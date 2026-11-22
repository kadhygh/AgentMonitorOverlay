import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RelayClient, RelayClientError } from "./api.js";
import type { RelayEvent } from "./protocol.js";
import { startRelayServer, type RelayServer } from "./server.js";
import { RelayStore } from "./store.js";
import { TRANSFER_CHUNK, TRANSFER_KEEP_MS, TRANSFER_MAX_BYTES, TRANSFER_MAX_FILES, TRANSFER_RECORD_DAYS, type Transfer } from "./transfer-protocol.js";

// 传文件 (2026-11-23, plans/relay-file-transfer.md 第 2 项): the service's side — devices seen over /ws, a send listed
// and checked (2 GB, paths, targets, disk space), uploaded only after a device accepted, in pieces at the offset the
// service is at (a break goes on from there), checked with sha256, downloaded with Range, ended (saved, declined,
// cancelled, a day passed) with its content gone.

let server: RelayServer | null = null;
let store: RelayStore | null = null;
let dir: string | null = null;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.close();
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  server = store = dir = null;
});

const DESK = "d_desk000000000000000000";
const LAPTOP = "d_laptop0000000000000000";
const LI_PC = "d_lipc0000000000000000000";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function service(opts: { free?: number; now?: () => number } = {}) {
  dir = mkdtempSync(join(tmpdir(), "amo-relay-transfer-"));
  store = new RelayStore(":memory:");
  server = await startRelayServer({
    store,
    host: "127.0.0.1",
    port: 0,
    name: "测试组",
    transfersDir: join(dir, "transfers"),
    transferFreeBytes: async () => opts.free ?? 100 * 1024 ** 3,
    ...(opts.now ? { transferNow: opts.now } : {}),
  });
  const anon = new RelayClient(server.url);
  const dai = new RelayClient(server.url, (await anon.register("老戴", "pw-dai")).key);
  const li = new RelayClient(server.url, (await anon.register("老李", "pw-li")).key);
  return { dai, li, transfersDir: join(dir, "transfers") };
}

/** A desktop client of `who` connected as `device`: its events. */
async function connect(client: RelayClient, device: string, name: string): Promise<RelayEvent[]> {
  const events: RelayEvent[] = [];
  const ws = new WebSocket(`${server!.url.replace(/^http/, "ws")}/ws?key=${encodeURIComponent(client.key!)}&device=${device}&deviceName=${encodeURIComponent(name)}`);
  sockets.push(ws);
  ws.on("message", (d) => events.push(JSON.parse(String(d)) as RelayEvent));
  await new Promise((ok, fail) => (ws.once("open", ok), ws.once("error", fail)));
  await expect.poll(() => events.some((e) => e.type === "hello")).toBe(true);
  return events;
}

const refused = async (p: Promise<unknown>, status: number, text?: RegExp) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(RelayClientError);
  expect((err as RelayClientError).status).toBe(status);
  if (text) expect((err as RelayClientError).message).toMatch(text);
};

describe("传文件 on the service (2026-11-23)", () => {
  it("devices seen over /ws are offered with who is online; a send is checked before anything is uploaded", async () => {
    const { dai, li } = await service();
    await connect(dai, DESK, "台式机");
    const laptop = new WebSocket(`${server!.url.replace(/^http/, "ws")}/ws?key=${encodeURIComponent(dai.key!)}&device=${LAPTOP}&deviceName=${encodeURIComponent("笔记本")}`);
    await new Promise((ok) => laptop.once("open", ok));
    await connect(li, LI_PC, "老李的电脑");
    const devices = await li.transferDevices();
    expect(devices.map((d) => [d.account, d.name, d.online]).sort()).toEqual([
      ["老戴", "台式机", true],
      ["老戴", "笔记本", true],
      ["老李", "老李的电脑", true],
    ]);
    laptop.close();
    await expect.poll(async () => (await li.transferDevices()).find((d) => d.id === LAPTOP)?.online).toBe(false);

    const base = { device: DESK, deviceName: "台式机", entries: [{ path: "a.txt", size: 3 }], targets: [{ account: "老李", device: LI_PC }] };
    await refused(dai.createTransfer({ ...base, entries: [{ path: "big.bin", size: TRANSFER_MAX_BYTES + 1 }] }), 400, /一次最多发 2\.00 GB/);
    await refused(dai.createTransfer({ ...base, entries: [{ path: "a/../b", size: 1 }] }), 400, /\.\./);
    await refused(dai.createTransfer({ ...base, entries: [{ path: "a:b", size: 1 }] }), 400, /Windows/);
    await refused(dai.createTransfer({ ...base, entries: [{ path: "A.txt", size: 1 }, { path: "a.txt", size: 1 }] }), 400, /重复/);
    await refused(dai.createTransfer({ ...base, entries: [{ path: "a", size: 1 }, { path: "a/b", size: 1 }] }), 400, /既是文件又是文件夹/);
    await refused(dai.createTransfer({ ...base, targets: [{ account: "老戴", device: DESK }] }), 400, /自己这台/);
    await refused(dai.createTransfer({ ...base, targets: [{ account: "老李", device: "d_nothere0000000000000" }] }), 400, /没有这台设备/);
    // Exactly 2 GB is fine, split over files.
    const ok = await dai.createTransfer({ ...base, entries: [{ path: "x/1.bin", size: TRANSFER_MAX_BYTES / 2 }, { path: "x/2.bin", size: TRANSFER_MAX_BYTES / 2 }], targets: [{ account: "老戴", device: LAPTOP }] });
    expect(ok).toMatchObject({ roots: ["x"], totalSize: TRANSFER_MAX_BYTES, state: "open", targets: [{ account: "老戴", device: LAPTOP, deviceName: "笔记本", state: "pending" }] });
    await refused(dai.createTransfer({ ...base, entries: [{ path: "aux.txt", size: 1 }] }), 400, /Windows 不让用/);
    // A folder of many small files: up to 10000, checked at once.
    const many = Array.from({ length: TRANSFER_MAX_FILES }, (_, i) => ({ path: `素材/${i % 100}/f${i}.png`, size: 10 }));
    const started = Date.now();
    expect((await dai.createTransfer({ ...base, entries: many })).files).toHaveLength(TRANSFER_MAX_FILES);
    expect(Date.now() - started).toBeLessThan(5000);
    await refused(dai.createTransfer({ ...base, entries: [...many, { path: "one-more.txt", size: 1 }] }), 400, /文件太多/);
    // Someone not in it does not see it.
    expect((await li.transfers()).map((t) => t.id)).not.toContain(ok.id);
    await refused(li.transfer(ok.id), 404);
  });

  it("is refused when the disk would not keep enough free", async () => {
    const { dai, li } = await service({ free: 6 * 1024 ** 3 });
    await connect(dai, DESK, "台式机");
    await connect(li, LI_PC, "老李的电脑");
    const t = { device: DESK, deviceName: "台式机", targets: [{ account: "老李", device: LI_PC }] };
    await dai.createTransfer({ ...t, entries: [{ path: "a.bin", size: 512 * 1024 ** 2 }] });
    // 6 GB free, 5 GB kept free, 0.5 GB already promised: another 1 GB does not fit.
    await refused(dai.createTransfer({ ...t, entries: [{ path: "b.bin", size: 1024 ** 3 }] }), 409, /空间不够/);
  });

  it("uploads in pieces after a device accepted, goes on from where the service is, checks sha256, downloads with Range, ends saved", async () => {
    const { dai, li, transfersDir } = await service();
    const daiEvents = await connect(dai, DESK, "台式机");
    const liEvents = await connect(li, LI_PC, "老李的电脑");
    const big = new Uint8Array(TRANSFER_CHUNK + 1000).map((_, i) => (i * 7) % 251);
    const empty = new Uint8Array(0);
    const t = await dai.createTransfer({ device: DESK, deviceName: "台式机", entries: [{ path: "素材/big.bin", size: big.length }, { path: "素材/empty.txt", size: 0 }], dirs: ["素材/空文件夹"], targets: [{ account: "老李", device: LI_PC }] });
    expect(t).toMatchObject({ roots: ["素材"], dirs: ["素材/空文件夹"] });
    await expect.poll(() => liEvents.some((e) => e.type === "transfer" && e.transfer.id === t.id)).toBe(true);
    const piece = (offset: number, bytes: Uint8Array, s = sha(big)) => dai.putTransferPiece(t.id, 0, { device: DESK, offset, sha256: s }, bytes);

    // Nobody accepted yet: nothing goes up.
    await refused(piece(0, big.subarray(0, TRANSFER_CHUNK)), 409, /还没有设备接收/);
    await refused(li.transferPiece(t.id, 0, LI_PC, 0, 10), 403);
    await li.answerTransfer(t.id, LI_PC, true);
    // Only the sending device uploads; only the device that accepted downloads.
    await refused(dai.putTransferPiece(t.id, 0, { device: LAPTOP, offset: 0, sha256: sha(big) }, big.subarray(0, 10)), 403);
    await refused(li.putTransferPiece(t.id, 0, { device: LI_PC, offset: 0, sha256: sha(big) }, big.subarray(0, 10)), 403);
    await refused(piece(0, new Uint8Array(TRANSFER_CHUNK + 1)), 400);

    expect(await piece(0, big.subarray(0, TRANSFER_CHUNK))).toMatchObject({ received: TRANSFER_CHUNK, done: false });
    // A piece sent again (the answer was lost) or one ahead is refused; the sender asks and goes on from there.
    await refused(piece(0, big.subarray(0, TRANSFER_CHUNK)), 409, /位置对不上/);
    await refused(piece(TRANSFER_CHUNK + 10, big.subarray(TRANSFER_CHUNK + 10)), 409, /位置对不上/);
    expect((await dai.transfer(t.id)).files[0]).toMatchObject({ received: TRANSFER_CHUNK, done: false });
    // Not complete: no download yet.
    await refused(li.transferPiece(t.id, 0, LI_PC, 0, 10), 409, /还没传完/);
    expect(await piece(TRANSFER_CHUNK, big.subarray(TRANSFER_CHUNK))).toMatchObject({ received: big.length, done: true, sha256: sha(big) });
    // An empty file is one empty piece.
    expect(await dai.putTransferPiece(t.id, 1, { device: DESK, offset: 0, sha256: sha(empty) }, empty)).toMatchObject({ done: true });

    // Downloaded in two ranges, the second one going on from the first.
    const a = await li.transferPiece(t.id, 0, LI_PC, 0, TRANSFER_CHUNK - 1);
    const b = await li.transferPiece(t.id, 0, LI_PC, TRANSFER_CHUNK, big.length - 1);
    expect(sha(new Uint8Array([...a, ...b]))).toBe(sha(big));
    await li.transferProgress(t.id, LI_PC, 4096);
    const done = await li.transferProgress(t.id, LI_PC, big.length, true);
    expect(done).toMatchObject({ state: "done", targets: [{ state: "done", got: big.length }] });
    expect(existsSync(join(transfersDir, t.id))).toBe(false);
    // Both sides heard every step.
    await expect.poll(() => daiEvents.filter((e) => e.type === "transfer" && e.transfer.id === t.id).at(-1)).toMatchObject({ transfer: { state: "done" } });
    await expect.poll(() => liEvents.filter((e) => e.type === "transfer" && e.transfer.id === t.id).at(-1)).toMatchObject({ transfer: { state: "done" } });
  });

  it("starts a file again when it does not match its sha256, or changed part way", async () => {
    const { dai, li } = await service();
    await connect(dai, DESK, "台式机");
    await connect(li, LI_PC, "老李的电脑");
    const data = new Uint8Array(TRANSFER_CHUNK + 10).fill(3);
    const t = await dai.createTransfer({ device: DESK, deviceName: "台式机", entries: [{ path: "a.bin", size: data.length }], targets: [{ account: "老李", device: LI_PC }] });
    await li.answerTransfer(t.id, LI_PC, true);
    const put = (offset: number, bytes: Uint8Array, s: string) => dai.putTransferPiece(t.id, 0, { device: DESK, offset, sha256: s }, bytes);
    // Changed part way (another sha256 for the rest): from the start.
    await put(0, data.subarray(0, TRANSFER_CHUNK), sha(data));
    await refused(put(TRANSFER_CHUNK, data.subarray(TRANSFER_CHUNK), "0".repeat(64)), 409, /改动过/);
    expect((await dai.transfer(t.id)).files[0]).toMatchObject({ received: 0, sha256: null });
    // Complete but not what its sha256 says: from the start too.
    await put(0, data.subarray(0, TRANSFER_CHUNK), "1".repeat(64));
    await refused(put(TRANSFER_CHUNK, data.subarray(TRANSFER_CHUNK), "1".repeat(64)), 409, /校验不对/);
    expect((await dai.transfer(t.id)).files[0]).toMatchObject({ received: 0, done: false });
    await put(0, data.subarray(0, TRANSFER_CHUNK), sha(data));
    expect(await put(TRANSFER_CHUNK, data.subarray(TRANSFER_CHUNK), sha(data))).toMatchObject({ done: true });
  });

  it("one device declines, another of the same person accepts; the sender cancels and the content goes", async () => {
    const { dai, li, transfersDir } = await service();
    await connect(dai, DESK, "台式机");
    await connect(dai, LAPTOP, "笔记本");
    await connect(li, LI_PC, "老李的电脑");
    const t = await li.createTransfer({ device: LI_PC, deviceName: "老李的电脑", entries: [{ path: "a.txt", size: 5 }], targets: [{ account: "老戴", device: DESK }, { account: "老戴", device: LAPTOP }] });
    expect((await dai.answerTransfer(t.id, DESK, false)).targets.map((x) => x.state)).toEqual(["declined", "pending"]);
    await refused(dai.answerTransfer(t.id, DESK, true), 409, /已经拒绝/);
    await dai.answerTransfer(t.id, LAPTOP, true);
    await li.putTransferPiece(t.id, 0, { device: LI_PC, offset: 0, sha256: sha(new Uint8Array([1, 2, 3, 4, 5])) }, new Uint8Array([1, 2, 3, 4, 5]));
    expect(readdirSync(join(transfersDir, t.id))).toEqual(["0"]);
    await refused(dai.cancelTransfer(t.id), 403);
    expect(await li.cancelTransfer(t.id)).toMatchObject({ state: "cancelled" });
    expect(existsSync(join(transfersDir, t.id))).toBe(false);
    await refused(dai.transferPiece(t.id, 0, LAPTOP, 0, 4), 409, /取消/);
    // Declined everywhere: done without anything uploaded.
    const u = await li.createTransfer({ device: LI_PC, deviceName: "老李的电脑", entries: [{ path: "b.txt", size: 5 }], targets: [{ account: "老戴", device: DESK }] });
    expect(await dai.answerTransfer(u.id, DESK, false)).toMatchObject({ state: "done" });
  });

  it("expires after a day with its content; the record goes a week later", async () => {
    let now = Date.parse("2026-11-23T10:00:00Z");
    const { dai, li, transfersDir } = await service({ now: () => now });
    await connect(dai, DESK, "台式机");
    const liEvents = await connect(li, LI_PC, "老李的电脑");
    const t = await dai.createTransfer({ device: DESK, deviceName: "台式机", entries: [{ path: "a.txt", size: 2 }], targets: [{ account: "老李", device: LI_PC }] });
    await li.answerTransfer(t.id, LI_PC, true);
    await dai.putTransferPiece(t.id, 0, { device: DESK, offset: 0, sha256: sha(new Uint8Array([9])) }, new Uint8Array([9]));
    expect(existsSync(join(transfersDir, t.id, "0"))).toBe(true);
    // A day later the service sweeps (here: a new service on the same data, which sweeps at start).
    now += TRANSFER_KEEP_MS + 1;
    await server!.close();
    server = await startRelayServer({ store: store!, host: "127.0.0.1", port: 0, transfersDir, transferNow: () => now, transferFreeBytes: async () => 100 * 1024 ** 3 });
    const dai2 = new RelayClient(server.url, dai.key);
    expect(await dai2.transfer(t.id)).toMatchObject({ state: "expired" });
    expect(existsSync(join(transfersDir, t.id))).toBe(false);
    void liEvents;
    now += TRANSFER_RECORD_DAYS * 24 * 3600_000 + 1;
    await server.close();
    server = await startRelayServer({ store: store!, host: "127.0.0.1", port: 0, transfersDir, transferNow: () => now, transferFreeBytes: async () => 100 * 1024 ** 3 });
    expect((await new RelayClient(server.url, dai.key).transfers()).map((x: Transfer) => x.id)).not.toContain(t.id);
  });

  it("sweeps on its timer and tells both sides", async () => {
    let now = Date.parse("2026-11-23T10:00:00Z");
    dir = mkdtempSync(join(tmpdir(), "amo-relay-transfer-"));
    store = new RelayStore(":memory:");
    server = await startRelayServer({ store, host: "127.0.0.1", port: 0, transfersDir: join(dir, "t"), transferNow: () => now, transferSweepMs: 50, transferFreeBytes: async () => 100 * 1024 ** 3 });
    const anon = new RelayClient(server.url);
    const dai = new RelayClient(server.url, (await anon.register("老戴", "pw-dai")).key);
    const li = new RelayClient(server.url, (await anon.register("老李", "pw-li")).key);
    await connect(dai, DESK, "台式机");
    const liEvents = await connect(li, LI_PC, "老李的电脑");
    const t = await dai.createTransfer({ device: DESK, deviceName: "台式机", entries: [{ path: "a.txt", size: 2 }], targets: [{ account: "老李", device: LI_PC }] });
    now += TRANSFER_KEEP_MS;
    await expect.poll(() => liEvents.filter((e) => e.type === "transfer" && e.transfer.id === t.id).at(-1)).toMatchObject({ transfer: { state: "expired" } });
  });

  it("follows a renamed account", async () => {
    const { dai, li } = await service();
    await connect(dai, DESK, "台式机");
    await connect(li, LI_PC, "老李的电脑");
    const t = await dai.createTransfer({ device: DESK, deviceName: "台式机", entries: [{ path: "a.txt", size: 2 }], targets: [{ account: "老李", device: LI_PC }] });
    store!.renameMember("老李", "李工");
    expect((await li.transfer(t.id)).targets[0]).toMatchObject({ account: "李工" });
    expect((await li.transferDevices()).map((d) => d.account)).toContain("李工");
  });
});
