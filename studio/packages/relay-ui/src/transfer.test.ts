import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { RelayClient, RelayStore, startRelayServer, TRANSFER_CHUNK, type RelayServer, type ShellTransfer } from "@amo-studio/relay";
import { Session } from "./session.js";
import { TransferEngine } from "./transfer.js";

// 传文件's engine (transfer.ts, 2026-11-23) against a real service: the client stopped part way — closed, reloaded —
// and started again goes on from where the service is (sending) and from where its .part is (receiving), not from the
// start. The shell is a stand-in that keeps files in memory (the real one is relay-app transfer-files.ts, tested there).

let server: RelayServer | null = null;
let store: RelayStore | null = null;
const sessions: Session[] = [];
const engines: TransferEngine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) e.stop();
  for (const s of sessions.splice(0)) s.stop();
  await server?.close();
  store?.close();
  server = store = null;
});

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A shell in memory: `files` to send, what is received (parts and saved), and every read and write it was asked for. */
function standIn(files: Record<string, Uint8Array> = {}) {
  const parts = new Map<string, Uint8Array>();
  const saved = new Map<string, Uint8Array>();
  const reads: number[] = [];
  const writes: number[] = [];
  let onRead = (_n: number) => {};
  let onWrite = (_n: number) => {};
  const recv = new Map<string, { dir: string; names: Record<string, string>; done: string[] }>();
  const tx: ShellTransfer = {
    device: async () => ({ id: "unused", name: "unused" }),
    pickFiles: async () => null,
    pickFolder: async () => null,
    dropped: async () => null,
    bind: async () => undefined,
    read: async (_id, path, offset, length) => {
      reads.push(offset);
      onRead(reads.length);
      return files[path]!.subarray(offset, offset + length);
    },
    hash: async (_id, path) => ({ sha256: sha(files[path]!), size: files[path]!.length }),
    forgetSend: async () => undefined,
    receiveDir: async () => "/inbox",
    setReceiveDir: async (d) => d,
    chooseDir: async () => null,
    prepare: async (id, dir) => {
      const r = recv.get(id) ?? { dir, names: {}, done: [] };
      recv.set(id, r);
      return r;
    },
    received: async (id) => recv.get(id) ?? null,
    partSize: async (id, path) => (recv.get(id)?.done.includes(path) ? -1 : (parts.get(path)?.length ?? 0)),
    write: async (_id, path, offset, data) => {
      writes.push(offset);
      const have = offset === 0 ? new Uint8Array(0) : parts.get(path)!;
      if (have.length !== offset) throw new Error("位置对不上");
      parts.set(path, new Uint8Array([...have, ...data]));
      onWrite(writes.length);
    },
    finish: async (id, path, sum) => {
      const part = parts.get(path) ?? new Uint8Array(0);
      parts.delete(path);
      if (sha(part) !== sum) return false;
      saved.set(path, part);
      recv.get(id)!.done.push(path);
      return `/inbox/${path}`;
    },
    discard: async () => undefined,
    openFolder: async () => undefined,
    prune: async () => undefined,
  };
  return { tx, saved, reads, writes, setOnRead: (f: (n: number) => void) => (onRead = f), setOnWrite: (f: (n: number) => void) => (onWrite = f) };
}

async function signedIn(client: RelayClient, name: string, device: { id: string; name: string }): Promise<Session> {
  const s = new Session({ server: client.server, name, role: "", key: client.key!, service: "测试组" }, device);
  sessions.push(s);
  await s.start();
  await expect.poll(() => s.snapshot.connection).toBe("online");
  return s;
}

describe("传文件's engine (2026-11-23)", () => {
  it("goes on from where it was after the client stopped part way, on both sides", async () => {
    store = new RelayStore(":memory:");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    server = await startRelayServer({ store, host: "127.0.0.1", port: 0, transfersDir: join(mkdtempSync(join(tmpdir(), "amo-relay-engine-")), "t"), transferFreeBytes: async () => 100 * 1024 ** 3 });
    const anon = new RelayClient(server.url);
    const dai = new RelayClient(server.url, (await anon.register("老戴", "pw-dai")).key);
    const li = new RelayClient(server.url, (await anon.register("老李", "pw-li")).key);
    const DESK = { id: "d_desk000000000000000000", name: "台式机" };
    const LI = { id: "d_lipc0000000000000000000", name: "老李的电脑" };
    const data = new Uint8Array(2 * TRANSFER_CHUNK + 4096).map((_, i) => (i * 13) % 251);
    const sender = standIn({ "big.bin": data, "empty.txt": new Uint8Array(0) });
    const receiver = standIn();

    const daiSession = await signedIn(dai, "老戴", DESK);
    const liSession = await signedIn(li, "老李", LI);
    const t = await dai.createTransfer({ device: DESK.id, deviceName: DESK.name, entries: [{ path: "big.bin", size: data.length }, { path: "empty.txt", size: 0 }], targets: [{ account: "老李", device: LI.id }] });
    await expect.poll(() => liSession.snapshot.transfers.find((x) => x.id === t.id)?.targets[0]?.state).toBe("pending");

    // The sender's client stops while the second piece goes up (after it, the engine stops as a closed window would).
    const up1 = new TransferEngine(daiSession, sender.tx);
    engines.push(up1);
    sender.setOnRead((n) => n === 2 && up1.stop());
    up1.start();
    // Nothing goes up before 老李 accepts.
    await new Promise((r) => setTimeout(r, 300));
    expect(sender.reads).toEqual([]);

    // 老李's client stops after its first piece is written.
    const down1 = new TransferEngine(liSession, receiver.tx);
    engines.push(down1);
    receiver.setOnWrite((n) => n === 1 && down1.stop());
    down1.start();
    await down1.accept(liSession.snapshot.transfers.find((x) => x.id === t.id)!, "/inbox");

    await expect.poll(async () => (await dai.transfer(t.id)).files[0]!.received).toBe(2 * TRANSFER_CHUNK);
    await new Promise((r) => setTimeout(r, 300));
    expect(sender.reads).toEqual([0, TRANSFER_CHUNK]);

    // Started again: the rest from where the service is, then the empty file.
    sender.setOnRead(() => undefined);
    const up2 = new TransferEngine(daiSession, sender.tx);
    engines.push(up2);
    up2.start();
    await expect.poll(async () => (await dai.transfer(t.id)).files.every((f) => f.done)).toBe(true);
    expect(sender.reads).toEqual([0, TRANSFER_CHUNK, 2 * TRANSFER_CHUNK, 0]);

    // 老李's first engine wrote one piece and stopped; the second goes on from the part's end.
    await expect.poll(() => receiver.writes.length).toBe(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(receiver.writes).toEqual([0]);
    receiver.setOnWrite(() => undefined);
    const down2 = new TransferEngine(liSession, receiver.tx);
    engines.push(down2);
    down2.start();
    await expect.poll(async () => (await li.transfer(t.id)).state, { timeout: 10_000 }).toBe("done");
    expect(receiver.writes).toEqual([0, TRANSFER_CHUNK, 2 * TRANSFER_CHUNK]);
    expect(sha(receiver.saved.get("big.bin")!)).toBe(sha(data));
    expect(receiver.saved.get("empty.txt")!.length).toBe(0);
    expect((await dai.transfer(t.id)).targets[0]).toMatchObject({ state: "done", got: data.length });
  });
});
