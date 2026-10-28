import { statSync } from "node:fs";
import { REMOTE_KINDS, type HostEvent, type Id, type ModelProfile, type NewSessionInput, type RemoteConnection, type RemoteIncomingRequest, type RemoteOutgoingRequest, type RemotePeer, type RemotePingResult, type RemoteState, type Session, type Task } from "@amo-studio/protocol";
import { accountFile, deviceFile, ensureDevice, readAccount, readDevice, serverLabel, setDeviceName, type Account, type Device, type Env, type Protector } from "@amo-studio/account";
import type { DeviceEvent, DeviceRef, PairRequest, PeerView } from "@amo-studio/relay";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { Backoff, CommandError, CommandLog, DeviceLink, type RelayFrameIn } from "./link.js";
import { RemoteGrants, type Answer, type RemoteContext } from "./grants.js";
import { RemoteCopies } from "./copies.js";

// 远程, step 1 (plans/remote-session.md, 2026-10-29): this computer as a device on the team server — the AMO platform's
// login (account.json, Studio has none of its own) and device.json — and the devices paired with it. The Host connects
// out when there is a login (link.ts), takes pairing requests, and answers a 「测试连接」 ping from a paired device.
// The pairs' record is here, in the Host's data (kv `remote.pairs`, by account + device id): for pairs this computer
// allowed ("owner") it is the one that counts — after a reconnect the server's copy is brought in line with it; pairs
// another device allowed ("guest") come from the server, which is how an approval made while this one was away
// arrives. Step 2 (2026-10-29): tasks granted to paired devices (grants.ts, this computer as A) and the copies of tasks
// granted to this one (copies.ts, as B) go over the same channel.

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
  /** Commands being answered: the same id again waits for that answer instead of running twice. */
  private readonly inflight = new Map<string, Promise<Answer>>();
  private reading: Promise<void> | null = null;
  private readonly context: RemoteContext = {
    host: this.host,
    link: () => this.link,
    deviceName: () => this.device?.name ?? "授权的电脑",
    peer: (ref, role) => {
      const p = this.pairs().find((x) => same(x, ref) && (!role || x.role === role));
      if (!p) return null;
      const pr = this.presence.get(`${ref.account}\n${ref.device}`);
      return { name: p.name, online: this.link?.state === "online" && !!pr?.online };
    },
    changed: () => this.changed(),
  };
  /** Step 2 as A: the tasks this computer granted. */
  readonly grants = new RemoteGrants(this.context);
  /** Step 2 as B: the copies of tasks granted to this computer. */
  readonly copies = new RemoteCopies(this.context);
  private readonly onHostEvent = (e: HostEvent) => {
    try {
      this.grants.onHostEvent(e);
    } catch (err) {
      console.log(`remote: ${String(err)}`);
    }
  };

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
    this.host.on("event", this.onHostEvent);
  }

  stop(): void {
    this.host.off("event", this.onHostEvent);
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
        // And the copies of what paired devices granted this computer (step 2): checked again from A, each of them.
        for (const p of this.pairs()) if (p.role === "guest" && this.presence.get(`${p.account}\n${p.device}`)?.online) void this.copies.syncPeer(p);
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
        const key = `${e.peer.account}\n${e.peer.device}`;
        const wasOnline = !!this.presence.get(key)?.online;
        this.presence.set(key, { online: e.online, lastSeen: e.online ? Date.now() : e.ago === null ? null : Date.now() - e.ago });
        const pairs = this.pairs();
        if (pairs.some((p) => same(p, e.peer) && p.name !== e.peer.name)) {
          this.savePairs(pairs.map((p) => (same(p, e.peer) ? { ...p, name: e.peer.name } : p)));
          this.grants.rename(e.peer, e.peer.name);
          this.copies.rename(e.peer, e.peer.name);
        }
        // A device that granted this computer tasks is back: what it did meanwhile comes over (step 2).
        if (e.online && !wasOnline && pairs.some((p) => same(p, e.peer) && p.role === "guest")) void this.copies.syncPeer(e.peer);
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

  /**
   * A frame from a paired device: 测试连接's ping, a command about a task granted to it (step 2, answered once per id:
   * the same id again gets the same answer, also while the first is still being worked out), or what a device that
   * granted this computer a task pushes (no answer).
   */
  private onFrame(f: RelayFrameIn): void {
    // An answer that came after its wait ended: nothing waits for it, and answering it would start an endless echo.
    if (f.re) return;
    if (f.kind === REMOTE_KINDS.push) {
      if (this.pairs().some((p) => same(p, f.from) && p.role === "guest")) this.copies.apply(f.from, f.body);
      return;
    }
    const reply = (answer: Answer) => this.link?.send({ type: "relay", to: f.from, id: `r_${f.id}`.slice(0, 64), kind: answer.kind, re: f.id, body: answer.body });
    const before = this.answered.get(f.from, f.id);
    if (before) return void reply(before);
    const key = `${f.from.account}\n${f.from.device}\n${f.id}`;
    const running = this.inflight.get(key);
    if (running) return void running.then(reply);
    const work = this.answerFrame(f).then((answer) => {
      this.answered.remember(f.from, f.id, answer);
      this.inflight.delete(key);
      return answer;
    });
    this.inflight.set(key, work);
    void work.then(reply);
  }

  private async answerFrame(f: RelayFrameIn): Promise<Answer> {
    // The server forwards between devices it has as paired; this computer's own list has the last word.
    if (!this.pairs().some((p) => same(p, f.from))) return { kind: "error", body: { code: "not_paired", message: "对方那边已经没有这个配对了" } };
    if (f.kind === "ping") return { kind: "pong", body: { at: Date.now() } };
    if (f.kind.startsWith("rt.")) return this.grants.serve(f.from, f.kind, f.body);
    return { kind: "error", body: { code: "unknown_kind", message: `对方的 Studio 不认识「${f.kind}」，可能版本不同` } };
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

  /** A pairing that ends takes its grants with it (this computer as A) and revokes its copies (as B). */
  private savePairs(list: StoredPair[]): void {
    const before = this.pairs();
    this.store.setKv(PAIRS_KEY, JSON.stringify(list));
    for (const p of before) {
      if (list.some((x) => same(x, p) && x.role === p.role)) continue;
      if (p.role === "owner") this.grants.dropPeer(p);
      else this.copies.revokePeer(p, "配对已解除");
    }
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
      grants: this.grants.list(),
      allowed: this.grants.allowed(),
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

  // ---- step 2: granting tasks (this computer as A)

  grant(taskId: Id, peer: DeviceRef): RemoteState {
    this.requireStarted();
    this.grants.grant(taskId, peer);
    return this.state();
  }

  revoke(taskId: Id, peer: DeviceRef): RemoteState {
    if (!this.grants.revoke(taskId, peer, "授权已收回")) throw new HostError("not_found", "这个任务没有授权给这台设备");
    return this.state();
  }

  setAllowed(body: unknown): RemoteState {
    this.grants.setAllowed(body);
    return this.state();
  }

  // ---- step 2: copies of granted tasks (this computer as B)

  /** The models copies run on, as hidden profiles of this Host (only their names are used). */
  copyProfiles(): ModelProfile[] {
    return this.copies.profiles();
  }

  startCopySession(task: Task, input: NewSessionInput): Promise<Session> {
    return this.copies.start(task, input);
  }

  dropCopy(task: Task): void {
    this.copies.drop(task);
  }

  /**
   * What a copy takes from this computer's own API (B's Host refuses the rest, 「B 能看到什么」): reading it, a message,
   * an answer to an approval or question, 打断, a new session, and archiving it (which deletes the copy). Changing the
   * task (its name, column, topic, 说明), a session's model or name, a branch, a terminal, comments sent into it… are
   * A's to do.
   */
  guardRoute(method: string, path: string, params: Record<string, string>): void {
    const id = params.id;
    if (!id || method === "GET") return;
    const task = path.startsWith("/api/tasks/:id") ? this.store.getTask(id) : path.startsWith("/api/sessions/:id") ? this.sessionTask(id) : undefined;
    if (!task?.remote) return;
    if (COPY_ROUTES.has(`${method} ${path}`)) return;
    throw new HostError("read_only", `这是 ${task.remote.name} 上的远程任务：这一项要在那台电脑上操作`);
  }

  private sessionTask(sessionId: Id): Task | undefined {
    const s = this.store.getSession(sessionId);
    return s?.taskId ? this.store.getTask(s.taskId) : undefined;
  }
}

/** The writes a copy takes (RemoteFeature.guardRoute); every GET reads the copy. */
const COPY_ROUTES = new Set([
  "POST /api/sessions/:id/messages",
  "POST /api/sessions/:id/interrupt",
  "POST /api/sessions/:id/questions/:itemId/answer",
  "POST /api/tasks/:id/sessions",
  "POST /api/tasks/:id/archive",
]);
