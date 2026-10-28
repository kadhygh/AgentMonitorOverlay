import { statSync } from "node:fs";
import type { RemoteConnection, RemoteIncomingRequest, RemoteOutgoingRequest, RemotePeer, RemotePingResult, RemoteState } from "@amo-studio/protocol";
import { accountFile, deviceFile, ensureDevice, readAccount, readDevice, serverLabel, setDeviceName, type Account, type Device, type Env, type Protector } from "@amo-studio/account";
import type { DeviceEvent, DeviceRef, PairRequest, PeerView } from "@amo-studio/relay";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { Backoff, CommandError, CommandLog, DeviceLink, type RelayFrameIn } from "./link.js";

// 远程, step 1 (plans/remote-session.md, 2026-10-29): this computer as a device on the team server — the AMO platform's
// login (account.json, Studio has none of its own) and device.json — and the devices paired with it. The Host connects
// out when there is a login (link.ts), takes pairing requests, and answers a 「测试连接」 ping from a paired device.
// The pairs' record is here, in the Host's data (kv `remote.pairs`, by account + device id): for pairs this computer
// allowed ("owner") it is the one that counts — after a reconnect the server's copy is brought in line with it; pairs
// another device allowed ("guest") come from the server, which is how an approval made while this one was away
// arrives. Remote tasks and sessions (step 2) are not here yet: the channel only carries ping / pong.

const PAIRS_KEY = "remote.pairs";
/** Unpairings the server has not heard of yet (it was not reachable): sent first thing after the next connect. */
const UNPAIRS_KEY = "remote.unpairs";

interface StoredPair {
  account: string;
  device: string;
  name: string;
  role: "owner" | "guest";
  pairedAt: string;
}

export interface RemoteOptions {
  /** Where account.json and device.json are (AMO_HOME); default the Host's environment. */
  env?: Env;
  /** Tests: something other than DPAPI for the key. */
  protector?: Protector;
  /** How often to look at account.json and device.json for changes the platform made (default 5 s). */
  watchMs?: number;
  heartbeatMs?: number;
  deadMs?: number;
  backoff?: Backoff;
  /** 测试连接's wait for the answer (default 10 s). */
  pingTimeoutMs?: number;
}

const iso = (ms: number) => new Date(ms).toISOString();
const same = (a: DeviceRef, b: DeviceRef) => a.account === b.account && a.device === b.device;

export class RemoteFeature extends Feature {
  private opts: RemoteOptions | null = null;
  private account: Account | null = null;
  private device: Device | null = null;
  private link: DeviceLink | null = null;
  private watch: NodeJS.Timeout | null = null;
  private seenFiles = "";
  private incoming: PairRequest[] = [];
  private outgoing: PairRequest[] = [];
  /** What the server last said about each peer: online, and when it was last seen. */
  private presence = new Map<string, { online: boolean; lastSeen: number | null }>();
  private readonly answered = new CommandLog<{ kind: string; body: unknown }>();
  private reading: Promise<void> | null = null;

  /** Starts remote (host-process.ts with the Host's own environment); without it the page says remote is off. */
  start(options: RemoteOptions = {}): void {
    if (this.opts) return;
    this.opts = options;
    try {
      this.device = ensureDevice({ env: options.env });
    } catch (err) {
      console.log(`remote: cannot make device.json: ${String(err)}`);
    }
    this.seenFiles = this.fileStamp();
    void this.loadAccount();
    this.watch = setInterval(() => this.checkFiles(), options.watchMs ?? 5000);
    this.watch.unref();
  }

  stop(): void {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    this.link?.stop();
    this.link = null;
    this.opts = null;
    this.account = null;
    this.incoming = [];
    this.outgoing = [];
    this.presence.clear();
  }

  private get env(): Env | undefined {
    return this.opts?.env;
  }

  // ---- account.json and device.json (the platform may change either while Studio runs)

  private fileStamp(): string {
    const stamp = (f: string) => {
      try {
        const s = statSync(f);
        return `${s.mtimeMs}:${s.size}`;
      } catch {
        return "-";
      }
    };
    return `${stamp(accountFile(this.env))}|${stamp(deviceFile(this.env))}`;
  }

  private checkFiles(): void {
    const now = this.fileStamp();
    if (now === this.seenFiles) return;
    const [accountBefore] = this.seenFiles.split("|");
    this.seenFiles = now;
    if (now.split("|")[0] !== accountBefore) void this.loadAccount();
    const d = readDevice({ env: this.env });
    if (d && this.device && (d.name !== this.device.name || d.id !== this.device.id)) {
      const idChanged = d.id !== this.device.id;
      this.device = d;
      if (idChanged) this.connect();
      else this.link?.send({ type: "name", name: d.name });
      this.changed();
    }
  }

  private loadAccount(): Promise<void> {
    const run = async () => {
      const opts = this.opts;
      if (!opts) return;
      const a = await readAccount({ env: opts.env, ...(opts.protector ? { protector: opts.protector } : {}) });
      // Stopped (or stopped and started again) while it read.
      if (this.opts !== opts) return;
      const before = this.account;
      this.account = a;
      if (!a) {
        this.link?.stop();
        this.link = null;
        this.incoming = [];
        this.outgoing = [];
      } else if (!before || before.server !== a.server || before.name !== a.name || before.key !== a.key) {
        this.connect();
      }
      this.changed();
    };
    // One read at a time (DPAPI starts a PowerShell).
    this.reading = (this.reading ?? Promise.resolve()).then(run, run);
    return this.reading;
  }

  private connect(): void {
    this.link?.stop();
    this.link = null;
    this.presence.clear();
    const a = this.account;
    const d = this.device;
    if (!a || !d || !this.opts) return;
    const link = new DeviceLink({
      server: a.server,
      key: a.key,
      device: d,
      ...(this.opts.heartbeatMs ? { heartbeatMs: this.opts.heartbeatMs } : {}),
      ...(this.opts.deadMs ? { deadMs: this.opts.deadMs } : {}),
      ...(this.opts.backoff ? { backoff: this.opts.backoff } : {}),
    });
    this.link = link;
    link.on("state", (s) => {
      if (this.link !== link) return;
      if (s !== "online") this.presence.clear();
      this.changed();
    });
    link.on("event", (e) => {
      if (this.link === link) void this.onEvent(e).catch((err: unknown) => console.log(`remote: ${String(err)}`));
    });
    link.start();
  }

  // ---- the server's events

  private async onEvent(e: DeviceEvent): Promise<void> {
    switch (e.type) {
      case "hello":
        // Everything again after a (re)connect: pairs, requests, who is online (what changed meanwhile left no event).
        await this.sync();
        return;
      case "pair-request":
        this.incoming = [...this.incoming.filter((r) => r.id !== e.request.id), e.request];
        break;
      case "pair-request-closed":
        this.incoming = this.incoming.filter((r) => r.id !== e.requestId);
        break;
      case "pair-answered":
        await this.sync();
        return;
      case "unpaired":
        this.savePairs(this.pairs().filter((p) => !same(p, e.peer)));
        break;
      case "presence": {
        this.presence.set(`${e.peer.account}\n${e.peer.device}`, { online: e.online, lastSeen: e.online ? Date.now() : e.ago === null ? null : Date.now() - e.ago });
        const pairs = this.pairs();
        if (pairs.some((p) => same(p, e.peer) && p.name !== e.peer.name)) this.savePairs(pairs.map((p) => (same(p, e.peer) ? { ...p, name: e.peer.name } : p)));
        break;
      }
      case "relay":
        this.onFrame(e);
        return;
      default:
        return;
    }
    this.changed();
  }

  /** A command from a paired device. Only 测试连接's ping in step 1; a repeated id gets the answer it got before. */
  private onFrame(f: RelayFrameIn): void {
    const link = this.link;
    if (!link) return;
    const reply = (answer: { kind: string; body: unknown }) => link.send({ type: "relay", to: f.from, id: `r_${f.id}`.slice(0, 64), kind: answer.kind, re: f.id, body: answer.body });
    const before = this.answered.get(f.from, f.id);
    if (before) return void reply(before);
    let answer: { kind: string; body: unknown };
    // The server forwards between devices it has as paired; this computer's own list has the last word.
    if (!this.pairs().some((p) => same(p, f.from))) answer = { kind: "error", body: { code: "not_paired", message: "对方那边已经没有这个配对了" } };
    else if (f.kind === "ping") answer = { kind: "pong", body: { at: Date.now() } };
    else answer = { kind: "error", body: { code: "unknown_kind", message: `对方的 Studio 不认识「${f.kind}」，可能版本不同` } };
    this.answered.remember(f.from, f.id, answer);
    reply(answer);
  }

  /** Pairs and requests from the server, brought in line with this computer's record. */
  private async sync(): Promise<void> {
    const d = this.device;
    if (!d || !this.account) return;
    // Unpairings the server missed go first, so they do not come back as guest pairs below.
    const unpairs = this.pendingUnpairs();
    for (const u of unpairs) {
      try {
        await this.call("POST", "/api/devices/unpair", { device: d.id, peerAccount: u.account, peerDevice: u.device });
        this.setPendingUnpairs(this.pendingUnpairs().filter((x) => !same(x, u)));
      } catch {
        return;
      }
    }
    const [{ pairs: server }, requests] = await Promise.all([
      this.call<{ pairs: PeerView[] }>("GET", `/api/devices/pairs?device=${encodeURIComponent(d.id)}`),
      this.call<{ incoming: PairRequest[]; outgoing: PairRequest[] }>("GET", `/api/devices/pair?device=${encodeURIComponent(d.id)}`),
    ]);
    const local = this.pairs();
    const next: StoredPair[] = [];
    for (const p of local) {
      const there = server.find((s) => same(s.peer, p) && s.role === p.role);
      // Gone from the server: the other side ended it while this one was away.
      if (there) next.push({ ...p, name: there.peer.name });
    }
    for (const s of server) {
      if (next.some((p) => same(p, s.peer) && p.role === s.role)) continue;
      if (s.role === "guest") next.push({ account: s.peer.account, device: s.peer.device, name: s.peer.name, role: "guest", pairedAt: iso(s.pairedAt) });
      // An owner pair this computer has no record of (its data was reset, or the answer got lost): not allowed any more.
      else void this.call("POST", "/api/devices/unpair", { device: d.id, peerAccount: s.peer.account, peerDevice: s.peer.device }).catch(() => undefined);
    }
    this.savePairs(next);
    this.presence.clear();
    for (const s of server) this.presence.set(`${s.peer.account}\n${s.peer.device}`, { online: s.online, lastSeen: s.online ? Date.now() : s.ago === null ? null : Date.now() - s.ago });
    this.incoming = requests.incoming;
    // An allowed request is now a pair: put the answer away.
    this.outgoing = requests.outgoing.filter((r) => r.state !== "allowed");
    for (const r of requests.outgoing.filter((x) => x.state === "allowed")) void this.call("DELETE", `/api/devices/pair/${encodeURIComponent(r.id)}?device=${encodeURIComponent(d.id)}`).catch(() => undefined);
    this.changed();
  }

  // ---- the team server's HTTP side

  private async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const a = this.account;
    if (!a) throw new HostError("bad_request", "在 AMO 平台里登录后才能用远程功能");
    let res: Response;
    try {
      res = await fetch(`${a.server}${path}`, {
        method,
        headers: { authorization: `Bearer ${a.key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new HostError("runtime_error", `连不上团队服务器 ${serverLabel(a.server)}`);
    }
    const data = (await res.json().catch(() => null)) as { message?: unknown } | null;
    if (!res.ok) {
      if (res.status === 404 && !data?.message) throw new HostError("runtime_error", "团队服务器上的中转服务还没有更新，不支持远程会话");
      const message = typeof data?.message === "string" && data.message ? data.message : `团队服务器回了 ${res.status}`;
      throw new HostError(res.status < 500 ? (res.status === 404 ? "not_found" : res.status === 409 ? "conflict" : "bad_request") : "runtime_error", message);
    }
    return data as T;
  }

  private named() {
    const d = this.device;
    if (!d) throw new HostError("runtime_error", "这台电脑还没有设备编号（device.json 写不进去）");
    return { device: d.id, deviceName: d.name };
  }

  // ---- what 设置 → 远程 and Focus do

  pairs(): StoredPair[] {
    const raw = this.store.getKv(PAIRS_KEY)?.value;
    try {
      const list = raw ? (JSON.parse(raw) as StoredPair[]) : [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  private savePairs(list: StoredPair[]): void {
    this.store.setKv(PAIRS_KEY, JSON.stringify(list));
  }

  private pendingUnpairs(): DeviceRef[] {
    try {
      const v = JSON.parse(this.store.getKv(UNPAIRS_KEY)?.value ?? "[]") as DeviceRef[];
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  private setPendingUnpairs(list: DeviceRef[]): void {
    this.store.setKv(UNPAIRS_KEY, JSON.stringify(list));
  }

  state(): RemoteState {
    // Not started (the Reviewer, tests): nothing of %APPDATA%\AMO is read.
    const started = !!this.opts;
    const info = this.account;
    const link = this.link;
    const connection: RemoteConnection = !started
      ? { state: "off", message: null, retryAt: null, since: null }
      : !this.account
        ? { state: "no-account", message: null, retryAt: null, since: null }
        : link
          ? { state: link.state, message: link.message, retryAt: link.retryAt ? iso(link.retryAt) : null, since: link.since ? iso(link.since) : null }
          : { state: "connecting", message: null, retryAt: null, since: null };
    const online = connection.state === "online";
    const peers: RemotePeer[] = this.pairs().map((p) => {
      const pr = this.presence.get(`${p.account}\n${p.device}`);
      return { ...p, online: online ? (pr?.online ?? false) : null, lastSeen: pr?.lastSeen ? iso(pr.lastSeen) : null };
    });
    const incoming: RemoteIncomingRequest[] = this.incoming.map((r) => ({ id: r.id, account: r.from.account, device: r.from.device, name: r.from.name, createdAt: iso(r.createdAt), expiresAt: iso(r.expiresAt) }));
    const outgoing: RemoteOutgoingRequest[] = this.outgoing.map((r) => ({ id: r.id, to: r.to, state: r.state === "refused" ? "refused" : "pending", answeredBy: r.answeredBy?.name ?? null, createdAt: iso(r.createdAt), expiresAt: iso(r.expiresAt) }));
    return {
      device: this.device,
      account: info ? { server: info.server, name: info.name } : null,
      connection,
      peers,
      incoming,
      outgoing,
    };
  }

  private changed(): void {
    // Not kept in the event log: windows read GET /api/remote when they open (like item.delta, emitted as it is).
    this.host.emit("event", { type: "remote.updated", remote: this.state(), seq: this.store.lastEventSeq() });
  }

  private requireStarted(): void {
    if (!this.opts) throw new HostError("bad_request", "这个 Host 没有开远程功能");
    if (!this.account) throw new HostError("bad_request", "在 AMO 平台里登录后才能用远程功能");
  }

  rename(name: string): RemoteState {
    if (!this.opts) throw new HostError("bad_request", "这个 Host 没有开远程功能");
    try {
      this.device = setDeviceName(name, { env: this.env });
    } catch (err) {
      throw new HostError("bad_request", err instanceof Error ? err.message : String(err));
    }
    this.seenFiles = this.fileStamp();
    this.link?.send({ type: "name", name: this.device.name });
    this.changed();
    return this.state();
  }

  async requestPair(accountValue: string): Promise<RemoteState> {
    this.requireStarted();
    const to = accountValue.trim();
    if (!to) throw new HostError("bad_request", "先填对方的账号名");
    const { request } = await this.call<{ request: PairRequest }>("POST", "/api/devices/pair", { ...this.named(), to });
    this.outgoing = [...this.outgoing.filter((r) => r.id !== request.id && r.to !== request.to), request];
    this.changed();
    return this.state();
  }

  async answer(id: string, allow: boolean): Promise<RemoteState> {
    this.requireStarted();
    try {
      const r = await this.call<{ request: PairRequest; pair: PeerView | null }>("POST", `/api/devices/pair/${encodeURIComponent(id)}/answer`, { ...this.named(), allow });
      if (allow && r.pair) {
        const p = r.pair;
        this.savePairs([...this.pairs().filter((x) => !(same(x, p.peer) && x.role === "owner")), { account: p.peer.account, device: p.peer.device, name: p.peer.name, role: "owner", pairedAt: iso(p.pairedAt) }]);
        this.presence.set(`${p.peer.account}\n${p.peer.device}`, { online: p.online, lastSeen: p.online ? Date.now() : p.ago === null ? null : Date.now() - p.ago });
      }
    } finally {
      // Answered here, elsewhere, or gone: either way it is no longer waiting on this computer.
      this.incoming = this.incoming.filter((r) => r.id !== id);
      this.changed();
    }
    return this.state();
  }

  async dismiss(id: string): Promise<RemoteState> {
    this.requireStarted();
    const d = this.named();
    try {
      await this.call("DELETE", `/api/devices/pair/${encodeURIComponent(id)}?device=${encodeURIComponent(d.device)}`);
    } catch (err) {
      if (!(err instanceof HostError && err.code === "not_found")) throw err;
    }
    this.outgoing = this.outgoing.filter((r) => r.id !== id);
    this.changed();
    return this.state();
  }

  /** Ends the pairing: forgotten here at once (this computer decides), the server and the peer told now or after the next connect. */
  async unpair(peer: DeviceRef): Promise<RemoteState> {
    this.requireStarted();
    const d = this.named();
    this.savePairs(this.pairs().filter((p) => !same(p, peer)));
    this.presence.delete(`${peer.account}\n${peer.device}`);
    try {
      await this.call("POST", "/api/devices/unpair", { device: d.device, peerAccount: peer.account, peerDevice: peer.device });
    } catch {
      this.setPendingUnpairs([...this.pendingUnpairs().filter((x) => !same(x, peer)), { account: peer.account, device: peer.device }]);
    }
    this.changed();
    return this.state();
  }

  /** 测试连接: ping → pong through the server; how long it took, or why it did not come back. */
  async ping(peer: DeviceRef): Promise<RemotePingResult> {
    this.requireStarted();
    if (!this.pairs().some((p) => same(p, peer))) throw new HostError("not_found", "没有和这台设备配对");
    const link = this.link;
    if (!link || link.state !== "online") return { ok: false, ms: null, message: "这台电脑没有连上团队服务器" };
    const t0 = performance.now();
    try {
      const answer = await link.request(peer, "ping", { at: Date.now() }, this.opts?.pingTimeoutMs ?? 10_000);
      const ms = Math.max(1, Math.round(performance.now() - t0));
      if (answer.kind === "pong") return { ok: true, ms, message: `对方在线，往返 ${ms} 毫秒` };
      const why = (answer.body as { message?: unknown } | undefined)?.message;
      return { ok: false, ms, message: typeof why === "string" ? why : "对方回了一个错误" };
    } catch (err) {
      if (err instanceof CommandError) return { ok: false, ms: null, message: err.code === "offline" ? "对方现在不在线" : err.code === "not_paired" ? "服务器上已经没有这对配对" : err.message };
      throw err;
    }
  }

  reconnect(): RemoteState {
    if (this.opts && !this.account) void this.loadAccount();
    else if (this.link && this.link.state !== "online" && this.link.state !== "connecting") {
      this.link.retryNow();
    }
    return this.state();
  }
}
