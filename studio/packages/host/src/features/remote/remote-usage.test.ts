import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteProfileId, type AccountUsage, type ChannelBalance, type ModelProfile, type RemoteState } from "@amo-studio/protocol";
import { saveAccount, type Protector } from "@amo-studio/account";
import { RelayStore, startRelayServer } from "@amo-studio/relay";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { Backoff } from "./link.js";
import { RemoteUsageCopies, sharesUsage } from "./usage.js";

// 远程额度 (2026-11-06): A pushes the quota it already has (never asking an account or a site for it) for the models of
// the tasks it granted, only to a device of its own account; B keeps it and its remote state shows it. Hosts through a
// relay service on this machine, the fake Codex app-server as the model.

const fake: Protector = {
  protect: async (t) => Buffer.from(`enc:${t}`).toString("base64"),
  unprotect: async (d) => Buffer.from(d, "base64").toString().slice(4),
};
const PROFILES: ModelProfile[] = [
  { id: "p", label: "P", runtime: "codex", provider: "x", model: "m" },
  { id: "q", label: "Q", runtime: "codex", provider: "y", model: "n" },
];

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0).reverse()) await c();
});
const tempDir = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `amo-rusage-${name}-`));
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
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function host(name: string, server: string, account: string, key: string) {
  const home = tempDir(name);
  const env = { AMO_HOME: home, COMPUTERNAME: name };
  await saveAccount({ server, name: account, key }, { env, protector: fake });
  const store = new Store(join(tempDir(`${name}-data`), "studio.db"));
  const servers = new FakeServers(PROFILES);
  const codex = new CodexRuntime({ store, servers, profiles: PROFILES });
  const service = new HostService(store, codex, PROFILES);
  service.remote.start({ env, protector: fake, watchMs: 30, backoff: new Backoff({ baseMs: 30, maxMs: 120 }), pingTimeoutMs: 2000, usagePollMs: 40 });
  await service.remote.setEnabled(true);
  cleanups.push(async () => {
    service.remote.stop();
    await servers.close();
    store.close();
  });
  const state = (): RemoteState => service.remote.state();
  return { service, store, codex, state, remote: service.remote };
}

const online = (s: RemoteState) => s.connection.state === "online";

/** A and B on the same account (the person's two computers), C on another; both paired with A (A allowed them). */
async function three() {
  const relayStore = new RelayStore(":memory:");
  const relay = await startRelayServer({ store: relayStore, host: "127.0.0.1", port: 0 });
  cleanups.push(() => relayStore.close());
  cleanups.push(() => relay.close());
  const mine = relayStore.register("台式机的我", "pw-aaaa").key;
  const other = relayStore.register("同事", "pw-cccc").key;
  const a = await host("A-PC", relay.url, "台式机的我", mine);
  const b = await host("B-PC", relay.url, "台式机的我", mine);
  const c = await host("C-PC", relay.url, "同事", other);
  for (const h of [a, b, c]) await until(h.state, online, "online");
  const aDevice = a.state().device!.id;
  for (const h of [b, c]) {
    await h.remote.requestPair("台式机的我", aDevice);
    const req = (await until(a.state, (s) => s.incoming.length === 1, "request")).incoming[0]!;
    await a.remote.answer(req.id, true);
    await until(h.state, (s) => s.peers.some((p) => p.device === aDevice && p.online === true), "sees A");
  }
  const toB = { account: "台式机的我", device: b.state().device!.id };
  const toC = { account: "同事", device: c.state().device!.id };
  return { a, b, c, aDevice, toB, toC };
}

const read = (at: string | null, used = 62): AccountUsage => ({ profileId: "p", label: "P", windows: [{ label: "5 小时", usedPercent: used, resetsAt: null }], note: null, updatedAt: at });

describe("远程额度", () => {
  it("A pushes only what it has cached, for the task's models, to its own account's device; B keeps it", async () => {
    const { a, b, c, aDevice, toB, toC } = await three();
    let cached: AccountUsage | null = { profileId: "p", label: "P", windows: [], note: "展开刷新后显示", updatedAt: null };
    const cachedUsage = vi.spyOn(a.codex, "cachedUsage").mockImplementation((pid) => (pid === "p" ? cached : null));
    const usage = vi.spyOn(a.codex, "usage");
    const balance: ChannelBalance = { profileId: "q", ok: true, remaining: 88.1, used: null, total: null, unit: "CNY", planName: null, message: null, checkedAt: "2026-11-06T08:00:00.000Z" };
    vi.spyOn(a.service.channels, "cachedBalance").mockImplementation((pid) => (pid === "q" ? balance : null));

    const { task } = await a.service.tasks.createTask({ title: "远程任务", firstSession: { profileId: "p", text: "第一句" } });
    a.remote.grant(task.id, toB);
    a.remote.grant(task.id, toC);
    await until(() => b.store.getTask(task.id), (t) => t?.remote?.state === "active", "B's copy");
    await until(() => c.store.getTask(task.id), (t) => t?.remote?.state === "active", "C's copy");
    // Nothing read yet on A (only 「展开刷新后显示」): nothing goes.
    await until(() => cachedUsage.mock.calls.length, (n) => n >= 3, "A looked a few times");
    expect(b.state().usage).toEqual([]);

    // A read it (its own refresh, a turn's rate limits…): B hears it, under its copy's model id.
    cached = read("2026-11-06T08:00:00.000Z");
    const got = await until(() => b.state().usage ?? [], (u) => u.length === 1, "B has A's quota");
    expect(got[0]).toMatchObject({ account: "台式机的我", device: aDevice, usage: [{ profileId: remoteProfileId(aDevice, "p"), label: "P", windows: [{ label: "5 小时", usedPercent: 62 }], updatedAt: "2026-11-06T08:00:00.000Z" }], balances: [] });
    // Changed numbers follow.
    cached = read("2026-11-06T08:05:00.000Z", 71);
    await until(() => b.state().usage?.[0]?.usage[0]?.windows[0]?.usedPercent, (n) => n === 71, "B has the new numbers");

    // Only the task's models: q's balance goes once a session of the task runs on q.
    expect(b.state().usage?.[0]?.balances).toEqual([]);
    await a.service.tasks.addSession(task.id, { profileId: "q", text: "换个模型" });
    await until(() => b.state().usage?.[0]?.balances ?? [], (x) => x.length === 1, "B has q's balance");
    expect(b.state().usage?.[0]?.balances[0]).toMatchObject({ profileId: remoteProfileId(aDevice, "q"), remaining: 88.1, unit: "CNY" });

    // Never for another account's device; and A never asked an account for any of it.
    await pause(200);
    expect(c.state().usage).toEqual([]);
    expect(usage).not.toHaveBeenCalled();
    expect(new Set(cachedUsage.mock.calls.map(([pid]) => pid))).toEqual(new Set(["p", "q"]));
  });

  it("an account whose numbers are gone from A's cache is cleared on B", async () => {
    const { a, b, toB } = await three();
    let cached: AccountUsage | null = read("2026-11-06T08:00:00.000Z");
    vi.spyOn(a.codex, "cachedUsage").mockImplementation(() => cached);
    const { task } = await a.service.tasks.createTask({ title: "远程任务", firstSession: { profileId: "p", text: "第一句" } });
    a.remote.grant(task.id, toB);
    await until(() => b.state().usage ?? [], (u) => u.length === 1, "B has A's quota");
    cached = null;
    await until(() => b.state().usage ?? [], (u) => u.length === 0, "B cleared it");
  });
});

describe("远程额度 for another account's device (the user, 2026-11-06: 默认关，A 上打开开关才推)", () => {
  it("not ticked: nothing; ticked: it gets the quota; unticked: it is cleared at once", async () => {
    const { a, b, c, aDevice, toB, toC } = await three();
    vi.spyOn(a.codex, "cachedUsage").mockImplementation((pid) => (pid === "p" ? read("2026-11-06T08:00:00.000Z") : null));
    const { task } = await a.service.tasks.createTask({ title: "远程任务", firstSession: { profileId: "p", text: "第一句" } });
    a.remote.grant(task.id, toB);
    a.remote.grant(task.id, toC);
    await until(() => c.store.getTask(task.id), (t) => t?.remote?.state === "active", "C's copy");
    // The same account's device has it; the other account's, not ticked, has nothing.
    await until(() => b.state().usage ?? [], (u) => u.length === 1, "B has A's quota");
    await pause(200);
    expect(c.state().usage).toEqual([]);
    expect(a.state().usageShare).toEqual([]);

    // Ticked on A: C hears it, under its copy's model id.
    expect(a.remote.setUsageShare(toC, true).usageShare).toEqual([toC]);
    const got = await until(() => c.state().usage ?? [], (u) => u.length === 1, "C has A's quota");
    expect(got[0]).toMatchObject({ device: aDevice, usage: [{ profileId: remoteProfileId(aDevice, "p"), windows: [{ usedPercent: 62 }] }] });

    // Unticked: an empty push at once — the numbers did not change, so the poll alone would never clear it.
    expect(a.remote.setUsageShare(toC, false).usageShare).toEqual([]);
    await until(() => c.state().usage ?? [], (u) => u.length === 0, "C cleared");
    await pause(200);
    expect(c.state().usage).toEqual([]);
    expect(b.state().usage).toHaveLength(1);

    // Only for a paired device of another account.
    expect(() => a.remote.setUsageShare(toB, true)).toThrow(/同一个账号/);
    expect(() => a.remote.setUsageShare({ account: "同事", device: "nope" }, true)).toThrow(/没有和这台设备配对/);
  });
});

describe("远程额度 pieces", () => {
  it("a device of the same account shares the quota; another account's only once let", () => {
    expect(sharesUsage("台式机的我", { account: "台式机的我", device: "d2" })).toBe(true);
    expect(sharesUsage("台式机的我", { account: "同事", device: "d3" })).toBe(false);
    expect(sharesUsage("台式机的我", { account: "同事", device: "d3" }, [{ account: "同事", device: "d3" }])).toBe(true);
    expect(sharesUsage("台式机的我", { account: "同事", device: "d4" }, [{ account: "同事", device: "d3" }])).toBe(false);
    expect(sharesUsage(null, { account: "台式机的我", device: "d2" })).toBe(false);
  });

  it("B keeps what came under its copies' ids, leaves out what it cannot read, and an empty push clears it", () => {
    const copies = new RemoteUsageCopies();
    const changed = vi.fn();
    copies.onChange = changed;
    const peer = { account: "台式机的我", device: "dev-a" };
    copies.receive(peer, {
      type: "usage",
      usage: [read("2026-11-06T08:00:00.000Z"), { profileId: 3 }, "x", { profileId: "r", label: "R", windows: "nope" }],
      balances: [{ profileId: "q", ok: true, remaining: 5, used: null, total: null, unit: "USD", checkedAt: "2026-11-06T08:00:00.000Z" }, { profileId: "z", ok: false, unit: "USD" }],
      later: "a field a newer A adds",
    });
    expect(copies.list()).toMatchObject([{ account: "台式机的我", device: "dev-a", usage: [{ profileId: remoteProfileId("dev-a", "p"), windows: [{ usedPercent: 62 }] }], balances: [{ profileId: remoteProfileId("dev-a", "q"), remaining: 5 }] }]);
    expect(changed).toHaveBeenCalledTimes(1);
    // Not an object at all: as empty.
    copies.receive(peer, null);
    expect(copies.list()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(2);
    copies.receive(peer, { usage: [] });
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
