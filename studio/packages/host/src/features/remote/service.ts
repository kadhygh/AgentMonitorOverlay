import { extname, isAbsolute } from "node:path";
import { PREVIEW_IMAGE_TYPES, REMOTE_KINDS, REMOTE_TASK_FOLDER, type HostEvent, type Id, type ModelProfile, type NewSessionInput, type PromptTemplate, type RemoteConnection, type RemoteIncomingRequest, type RemoteOutgoingRequest, type RemotePeer, type RemoteAcceptInput, type RemoteCatalog, type RemoteCreateAnswer, type RemoteCreateResult, type RemoteFetchedFile, type RemoteListAnswer, type RemoteOnlineDevices, type RemotePingResult, type RemotePush, type RemoteState, type Session, type Task } from "@amo-studio/protocol";
import { serverLabel, type Account, type Device } from "@amo-studio/account";
import type { DeviceEvent, DeviceRef, OnlineDevice, PairRequest, PeerView } from "@amo-studio/relay";
import { HostError } from "../../core/shared.js";
import type { TeamLinkOptions } from "../../core/teamlink.js";
import { FileReply, type Route } from "../../http/route.js";
import { underTaskFolder } from "./files.js";
import { Feature } from "../../core/feature.js";
import { Backoff, CommandError, CommandLog, DeviceLink, type RelayFrameIn } from "./link.js";
import { RemoteGrants, type Answer, type RemoteContext } from "./grants.js";
import { RemoteCopies } from "./copies.js";
import { TaskAsks, TaskRequests } from "./requests.js";
import { RemoteCreates } from "./create.js";
import { sendAlong, UploadInbox } from "./uploads.js";

// 远程, step 1 (plans/remote-session.md, 2026-10-29): this computer as a device on the team server — the AMO platform's
// login and device.json, read by the Host's team link (core/teamlink.ts since 2026-11-05) — and the devices paired with
// it. The Host connects out when there is a login (link.ts), takes pairing requests, and answers a 「测试连接」 ping from
// a paired device.
// The pairs' record is here, in the Host's data (kv `remote.pairs`, by account + device id): for pairs this computer
// allowed ("owner") it is the one that counts — after a reconnect the server's copy is brought in line with it; pairs
// another device allowed ("guest") come from the server, which is how an approval made while this one was away
// arrives. Step 2 (2026-10-29): tasks granted to paired devices (grants.ts, this computer as A) and the copies of tasks
// granted to this one (copies.ts, as B) go over the same channel.

const PAIRS_KEY = "remote.pairs";
/** Unpairings the server has not heard of yet (it was not reachable): sent first thing after the next connect. */
const UNPAIRS_KEY = "remote.unpairs";
/**
 * 2026-10-30 (the user: 远程默认关闭，手动开启后才开；未登录时关闭且无法开启): the account (server + name) the person
 * turned remote on for. Absent, or another account logged in now: off — this computer does not connect as a device.
 */
const ENABLED_KEY = "remote.enabled";

interface StoredPair {
  account: string;
  device: string;
  name: string;
  role: "owner" | "guest";
  pairedAt: string;
}

/** With the team link's options: remote starts the link with them when nothing started it yet (tests). */
export interface RemoteOptions extends TeamLinkOptions {
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
  /** The login this feature last connected for (a new key, server or name connects again). */
  private seen: Account | null = null;
  /** Remote started the team link itself (nothing had: tests), so it stops it too. */
  private ownsTeam = false;
  private link: DeviceLink | null = null;
  private incoming: PairRequest[] = [];
  private outgoing: PairRequest[] = [];
  /** What the server last said about each peer: online, and when it was last seen. */
  private presence = new Map<string, { online: boolean; lastSeen: number | null }>();
  private readonly answered = new CommandLog<{ kind: string; body: unknown }>();
  /** Commands being answered: the same id again waits for that answer instead of running twice. */
  private readonly inflight = new Map<string, Promise<Answer>>();
  private readonly context: RemoteContext = {
    host: this.host,
    link: () => this.link,
    deviceName: () => this.device?.name ?? "授权的电脑",
    ownAccount: () => this.account?.name ?? null,
    inbox: () => this.inbox,
    peer: (ref, role) => {
      const p = this.pairs().find((x) => same(x, ref) && (!role || x.role === role));
      if (!p) return null;
      const pr = this.presence.get(`${ref.account}\n${ref.device}`);
      return { name: p.name, online: this.link?.state === "online" && !!pr?.online };
    },
    ownerPeers: () => this.pairs().filter((p) => p.role === "owner").map((p) => ({ account: p.account, device: p.device })),
    changed: () => this.changed(),
  };
  /** As A (2026-10-29 evening): pictures and files paired devices send along. */
  readonly inbox = new UploadInbox(this.context);
  /** Step 2 as A: the tasks this computer granted. */
  readonly grants = new RemoteGrants(this.context);
  /** Step 2 as B: the copies of tasks granted to this computer. */
  readonly copies = new RemoteCopies(this.context);
  /** Step 4 as A: tasks paired devices ask this computer to run. */
  readonly taskRequests = new TaskRequests(this.context, this.grants);
  /** Step 4 as B: tasks this computer asked paired devices to run. */
  /** 远程创建 as A (2026-10-29): what paired devices may pick creating a task here, and creating it. */
  readonly creates = new RemoteCreates(this.context, this.grants, this.taskRequests);
  readonly asks = new TaskAsks(this.context, (peer, kind, body, timeoutMs, offline) => this.copies.ask(peer, kind, body, timeoutMs, offline));
  private readonly onHostEvent = (e: HostEvent) => {
    try {
      this.grants.onHostEvent(e);
      this.creates.onHostEvent(e);
    } catch (err) {
      console.log(`remote: ${String(err)}`);
    }
  };

  /**
   * Starts remote (host-process.ts with the Host's own environment); without it the page says remote is off. The team
   * link is started with the same options when nothing started it yet (tests start remote alone), and then stopped with
   * remote.
   */
  start(options: RemoteOptions = {}): void {
    if (this.opts) return;
    this.opts = options;
    this.seen = null;
    this.copies.onList = (peer, list) => this.asks.sync(peer, list.requests);
    // The catch-up progress (读条, 2026-11-01): only the state, not what paired devices may pick (changed() announces that).
    this.copies.onProgress = () => this.host.emit("event", { type: "remote.updated", remote: this.state(), seq: this.store.lastEventSeq() });
    this.ownsTeam = !this.teamLink.started;
    this.teamLink.start(options);
    // Files fetched for copies that are gone (step 3).
    this.copies.files.sweep();
    this.copies.views.sweep();
    this.teamLink.on("account", this.onAccount);
    this.teamLink.on("device", this.onDevice);
    // The link read account.json before remote started: act on what it read (otherwise its first read tells).
    if (this.teamLink.loaded) this.onAccount();
    this.host.on("event", this.onHostEvent);
  }

  stop(): void {
    this.host.off("event", this.onHostEvent);
    this.teamLink.off("account", this.onAccount);
    this.teamLink.off("device", this.onDevice);
    this.creates.stop();
    this.link?.stop();
    this.link = null;
    this.opts = null;
    this.seen = null;
    if (this.ownsTeam) this.teamLink.stop();
    this.ownsTeam = false;
    this.incoming = [];
    this.outgoing = [];
    this.presence.clear();
  }

  /** The platform's login, while remote is started (stopped: none, as before the team link was its own). */
  private get account(): Account | null {
    return this.opts ? this.teamLink.account : null;
  }
  private get device(): Device | null {
    return this.teamLink.device;
  }

  // ---- what the team link read (the platform may change account.json or device.json while Studio runs)

  private readonly onAccount = (): void => {
    if (!this.opts) return;
    const a = this.teamLink.account;
    const before = this.seen;
    this.seen = a;
    if (!a) {
      this.link?.stop();
      this.link = null;
      this.incoming = [];
      this.outgoing = [];
    } else if (!before || before.server !== a.server || before.name !== a.name || before.key !== a.key || !this.link) {
      this.connect();
    }
    this.changed();
  };

  private readonly onDevice = (d: Device, { idChanged }: { idChanged: boolean }): void => {
    if (!this.opts) return;
    if (idChanged) this.connect();
    else this.link?.send({ type: "name", name: d.name });
    this.changed();
  };

  private connect(): void {
    this.link?.stop();
    this.link = null;
    this.presence.clear();
    const a = this.account;
    const d = this.device;
    if (!a || !d || !this.opts) return;
    if (!this.enabled()) {
      this.incoming = [];
      this.outgoing = [];
      return;
    }
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
      if (!this.pairs().some((p) => same(p, f.from) && p.role === "guest")) return;
      const push = f.body as RemotePush | null;
      if (push && push.type === "request") this.asks.apply(f.from, push.request);
      // 2026-10-30: the new-task page showing that device takes it as it is (ui/src/newtask/RemoteDraft.tsx).
      else if (push && push.type === "catalog") this.host.emit("event", { type: "remote.catalog", account: f.from.account, device: f.from.device, catalog: push.catalog, seq: this.store.lastEventSeq() });
      else this.copies.apply(f.from, f.body);
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
    const body = f.body && typeof f.body === "object" ? (f.body as Record<string, unknown>) : {};
    const failed = (err: unknown): Answer =>
      err instanceof HostError ? { kind: "error", body: { code: err.code, message: err.message } } : { kind: "error", body: { code: "runtime_error", message: err instanceof Error ? err.message : String(err) } };
    const said = (run: () => unknown): Answer => {
      try {
        return { kind: REMOTE_KINDS.ok, body: run() };
      } catch (err) {
        return failed(err);
      }
    };
    // 远程创建 (2026-10-29): what the device may pick, and the task made here now.
    if (f.kind === REMOTE_KINDS.catalog) return said(() => this.creates.serveCatalog(f.from));
    if (f.kind === REMOTE_KINDS.createTemplates) return said(() => ({ templates: this.creates.templates(f.from, body.workspaceId) }));
    if (f.kind === REMOTE_KINDS.upload) return said(() => this.inbox.receive(f.from, body));
    if (f.kind === REMOTE_KINDS.create) return this.creates.create(f.from, body).then((made): Answer => ({ kind: REMOTE_KINDS.ok, body: made }), failed);
    // Step 4: a request for a task, or taking one back.
    if (f.kind === REMOTE_KINDS.request) return said(() => ({ request: this.taskRequests.receive(f.from, body) }));
    if (f.kind === REMOTE_KINDS.withdraw) return said(() => (this.taskRequests.withdraw(f.from, body.requestId), { ok: true }));
    if (f.kind === REMOTE_KINDS.list) {
      const answer = await this.grants.serve(f.from, f.kind, f.body);
      if (answer.kind === REMOTE_KINDS.ok) (answer.body as RemoteListAnswer).requests = this.taskRequests.of(f.from);
      return answer;
    }
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

  // ---- what the remote page (顶栏「远程」) and Focus do

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
      if (p.role === "owner") {
        this.grants.dropPeer(p);
        this.taskRequests.dropPeer(p);
      } else {
        this.copies.revokePeer(p, "配对已解除");
        this.asks.dropPeer(p);
      }
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

  // ---- 2026-10-30: the switch

  /** Remote is on for the account logged in now. */
  enabled(): boolean {
    const a = this.account;
    if (!a) return false;
    try {
      const v = JSON.parse(this.store.getKv(ENABLED_KEY)?.value ?? "null") as { server?: unknown; name?: unknown } | null;
      return !!v && v.server === a.server && v.name === a.name;
    } catch {
      return false;
    }
  }

  /** Turns remote on (needs the platform's login; waits for a read of account.json under way) or off. */
  async setEnabled(on: boolean): Promise<RemoteState> {
    if (!this.opts) throw new HostError("bad_request", "这个 Host 没有开远程功能");
    await this.teamLink.settled();
    if (on) {
      const a = this.account;
      if (!a) throw new HostError("bad_request", "在 AMO 平台里登录后才能打开远程功能");
      this.store.setKv(ENABLED_KEY, JSON.stringify({ server: a.server, name: a.name }));
      if (!this.link) this.connect();
    } else {
      this.store.setKv(ENABLED_KEY, "null");
      this.link?.stop();
      this.link = null;
      this.incoming = [];
      this.outgoing = [];
      this.presence.clear();
    }
    this.changed();
    return this.state();
  }

  state(): RemoteState {
    // Not started (the Reviewer, tests): nothing of %APPDATA%\AMO is read.
    const started = !!this.opts;
    const info = this.account;
    const link = this.link;
    const enabled = this.enabled();
    const connection: RemoteConnection = !started
      ? { state: "off", message: null, retryAt: null, since: null }
      : !this.account
        ? { state: "no-account", message: null, retryAt: null, since: null }
        : !enabled
          ? { state: "disabled", message: null, retryAt: null, since: null }
          : link
          ? { state: link.state, message: link.message, retryAt: link.retryAt ? iso(link.retryAt) : null, since: link.since ? iso(link.since) : null }
          : { state: "connecting", message: null, retryAt: null, since: null };
    const online = connection.state === "online";
    const peers: RemotePeer[] = this.pairs().map((p) => {
      const pr = this.presence.get(`${p.account}\n${p.device}`);
      return { ...p, online: online ? (pr?.online ?? false) : null, lastSeen: pr?.lastSeen ? iso(pr.lastSeen) : null };
    });
    const incoming: RemoteIncomingRequest[] = this.incoming.map((r) => ({ id: r.id, account: r.from.account, device: r.from.device, name: r.from.name, createdAt: iso(r.createdAt), expiresAt: iso(r.expiresAt) }));
    const outgoing: RemoteOutgoingRequest[] = this.outgoing.map((r) => ({ id: r.id, to: r.to, ...(r.toDevice ? { toDevice: { device: r.toDevice.device, name: r.toDevice.name } } : {}), state: r.state === "refused" ? "refused" : "pending", answeredBy: r.answeredBy?.name ?? null, createdAt: iso(r.createdAt), expiresAt: iso(r.expiresAt) }));
    return {
      enabled,
      device: this.device,
      account: info ? { server: info.server, name: info.name } : null,
      connection,
      peers,
      incoming,
      outgoing,
      grants: this.grants.list(),
      allowed: this.grants.allowed(),
      taskRequests: this.taskRequests.pending(),
      asks: this.asks.list(),
      allowedProjects: this.creates.allowedProjects(),
      security: this.creates.security(),
      syncing: this.copies.syncState(),
    };
  }

  private changed(): void {
    // Not kept in the event log: windows read GET /api/remote when they open (like item.delta, emitted as it is).
    this.host.emit("event", { type: "remote.updated", remote: this.state(), seq: this.store.lastEventSeq() });
    // 远程设置, this computer's name, a device back online: what paired devices may pick here may have changed too.
    this.creates.announce();
  }

  private requireStarted(): void {
    if (!this.opts) throw new HostError("bad_request", "这个 Host 没有开远程功能");
    if (!this.account) throw new HostError("bad_request", "在 AMO 平台里登录后才能用远程功能");
    if (!this.enabled()) throw new HostError("bad_request", "远程功能没有打开：在顶栏的「远程」里打开");
  }

  rename(name: string): RemoteState {
    if (!this.opts) throw new HostError("bad_request", "这个 Host 没有开远程功能");
    const device = this.teamLink.rename(name);
    this.link?.send({ type: "name", name: device.name });
    this.changed();
    return this.state();
  }

  /** Asks an account to pair — or (`device`, the pair dialog) only that device of it, picked from its online devices. */
  async requestPair(accountValue: string, device?: string): Promise<RemoteState> {
    this.requireStarted();
    const to = accountValue.trim();
    if (!to) throw new HostError("bad_request", "先填对方的账号名");
    const { request } = await this.call<{ request: PairRequest }>("POST", "/api/devices/pair", { ...this.named(), to, ...(device ? { toDevice: device } : {}) });
    // One request per account and device asked (an older team server leaves toDevice out: per account).
    const target = (r: PairRequest) => `${r.to}\n${r.toDevice?.device ?? ""}`;
    this.outgoing = [...this.outgoing.filter((r) => r.id !== request.id && target(r) !== target(request)), request];
    this.changed();
    return this.state();
  }

  /**
   * The pair dialog (2026-10-29): this account's other devices connected to the team server now. An older relay service
   * has no such list: `supported: false`, and the dialog offers pairing by account name only.
   */
  async onlineDevices(): Promise<RemoteOnlineDevices> {
    this.requireStarted();
    if (this.link?.state !== "online") throw new HostError("runtime_error", "这台电脑没有连上团队服务器，列不出在线的设备");
    const d = this.named();
    try {
      const { devices } = await this.call<{ devices: OnlineDevice[] }>("GET", `/api/devices/online?device=${encodeURIComponent(d.device)}`);
      return { devices: devices.map((x) => ({ device: x.device, name: x.name, since: iso(x.since) })), supported: true };
    } catch (err) {
      if (err instanceof HostError && err.code === "not_found") return { devices: [], supported: false };
      throw err;
    }
  }

  async answer(id: string, allow: boolean): Promise<RemoteState> {
    this.requireStarted();
    try {
      const r = await this.call<{ request: PairRequest; pair: PeerView | null }>("POST", `/api/devices/pair/${encodeURIComponent(id)}/answer`, { ...this.named(), allow });
      if (allow && r.pair) {
        const p = r.pair;
        this.savePairs([...this.pairs().filter((x) => !(same(x, p.peer) && x.role === "owner")), { account: p.peer.account, device: p.peer.device, name: p.peer.name, role: "owner", pairedAt: iso(p.pairedAt) }]);
        this.presence.set(`${p.peer.account}\n${p.peer.device}`, { online: p.online, lastSeen: p.online ? Date.now() : p.ago === null ? null : Date.now() - p.ago });
        // One more of the own account's devices (2026-10-31): it sees the tasks the others were granted.
        this.grants.shareWith(p.peer);
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
    if (this.opts && !this.account) void this.teamLink.reload();
    else if (!this.enabled()) return this.state();
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

  setAllowedProjects(body: unknown): RemoteState {
    this.creates.setAllowedProjects(body);
    return this.state();
  }

  setSecurity(body: unknown): RemoteState {
    this.creates.setSecurity(body);
    return this.state();
  }

  // ---- 远程创建 as B (plans/remote-page-and-new-task.md 4.1, 2026-10-29): the new-task page's 「在别的设备上」

  /** A device that allowed this computer, online now: who it is (for what is said). */
  private creatable(peer: DeviceRef): { name: string } {
    this.requireStarted();
    if (this.link?.state !== "online") throw new HostError("runtime_error", "这台电脑没有连上团队服务器，回来后再试");
    const p = this.context.peer(peer, "guest");
    if (!p) throw new HostError("bad_request", "只能在允许了这台电脑配对的设备上建任务（在顶栏的「远程」里配对）");
    if (!p.online) throw new HostError("runtime_error", `${p.name} 不在线：要它开着 Studio、连上团队服务器才能在它上面建任务`);
    return p;
  }

  /** What the device lets this computer pick (its topics, allowed projects and models). */
  async catalog(peer: DeviceRef): Promise<RemoteCatalog> {
    const p = this.creatable(peer);
    return this.copies.ask<RemoteCatalog>(peer, REMOTE_KINDS.catalog, {}, 30_000, `${p.name} 不在线`);
  }

  /** The device's templates for a task created there in that project (null: the common folder); 问题 #1. */
  async catalogTemplates(peer: DeviceRef, workspaceId: Id | null): Promise<PromptTemplate[]> {
    const p = this.creatable(peer);
    const answer = await this.copies.ask<{ templates?: PromptTemplate[] }>(peer, REMOTE_KINDS.createTemplates, { workspaceId }, 30_000, `${p.name} 不在线`);
    return Array.isArray(answer.templates) ? answer.templates : [];
  }

  /**
   * Creates a task on the device (granted to this computer, its session started there) and answers once the copy is
   * here — it comes with the grant; asked for directly when it has not come after a while — or says it follows.
   */
  async create(peer: DeviceRef, body: Record<string, unknown>): Promise<RemoteCreateResult> {
    const p = this.creatable(peer);
    // Pictures and files go first (2026-10-29 evening); A writes the 引用文件 block again with its own paths.
    const images = Array.isArray(body.attachments) && body.attachments.length ? this.host.sessions.images(body.attachments as Id[]) : [];
    const along = await sendAlong((pr, kind, b, ms, off) => this.copies.ask(pr, kind, b, ms, off), peer, p.name, typeof body.text === "string" ? body.text : "", images);
    const ask = { title: typeof body.title === "string" ? body.title : "", text: along.text, topicId: body.topicId ?? null, workspaceId: body.workspaceId ?? null, profileId: body.profileId, ...(along.uploads.length ? { uploads: along.uploads } : {}) };
    // Starting the session takes longest (as rt.start).
    const made = await this.copies.ask<RemoteCreateAnswer>(peer, REMOTE_KINDS.create, ask, 90_000, `${p.name} 不在线，任务没建`);
    // 安全 (2026-10-29): it waits for a yes there — kept with this computer's requests (撤回 there too).
    if (made.waiting || !made.taskId) {
      if (made.waiting) this.asks.apply(peer, made.waiting);
      return { ...made, taskId: null, copied: false };
    }
    const taskId = made.taskId;
    const here = () => !!this.store.getTask(taskId)?.remote;
    const end = Date.now() + 5000;
    while (!here() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    if (!here()) await this.copies.syncTask(peer, taskId).catch(() => undefined);
    return { ...made, copied: here() };
  }

  // ---- step 4: requests for tasks

  /** As B: asks a device that allowed this computer to run a task (while it is online). */
  async sendAsk(peer: DeviceRef, title: unknown, text: unknown): Promise<RemoteState> {
    this.requireStarted();
    if (this.link?.state !== "online") throw new HostError("runtime_error", "这台电脑没有连上团队服务器，请求发不出去");
    await this.asks.send(peer, title, text);
    return this.state();
  }

  /** As B: takes a request back, or puts an answer away. */
  async withdrawAsk(id: string): Promise<RemoteState> {
    this.requireStarted();
    await this.asks.withdraw(id);
    return this.state();
  }

  /** As A: allows a request — the task made, granted, its session started. */
  async acceptRequest(id: string, input: unknown): Promise<RemoteState> {
    this.requireStarted();
    await this.taskRequests.accept(id, (input ?? {}) as RemoteAcceptInput);
    return this.state();
  }

  /** As A: refuses a request. */
  refuseRequest(id: string, reason: unknown): RemoteState {
    this.requireStarted();
    this.taskRequests.refuse(id, reason);
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

  renameCopy(task: Task, title: string): Promise<Task> {
    return this.copies.renameTask(task, title);
  }

  dropCopy(task: Task): void {
    this.copies.drop(task);
  }

  /** Step 3: a file of a remote task's copy, fetched from the computer it runs on and kept here. */
  async fetchFile(taskId: Id, path: string, cwd?: string, fetchId?: string): Promise<RemoteFetchedFile> {
    if (!this.store.getTask(taskId)?.remote) throw new HostError("not_found", "这不是远程任务");
    return this.copies.files.fetch(taskId, path, cwd, fetchId);
  }

  /**
   * 远程 Reviewer (plans/remote-reviewer.md, 2026-11-02): what a remote task's Reviewer window asks its Host for, under
   * /api/remote/view/<task>/<the route it would ask>. Reads go to the computer the task runs on (rt.view; kept here);
   * a picture by rt.file as any remote file; tools of this computer (VS Code, Explorer) are not offered.
   */
  async view(taskId: Id, method: string, path: string, query: URLSearchParams, body: unknown): Promise<unknown> {
    const task = this.store.getTask(taskId);
    if (!task?.remote) throw new HostError("not_found", "这不是远程任务");
    if (method === "GET" && path === "/api/fs/raw") {
      const p = query.get("path") ?? "";
      const f = await this.copies.files.fetch(taskId, underTaskFolder(p) !== null || isAbsolute(p) ? p : `${REMOTE_TASK_FOLDER}/${p.replace(/\\/g, "/")}`);
      const mime = PREVIEW_IMAGE_TYPES[extname(f.path).toLowerCase()];
      if (!mime) throw new HostError("bad_request", "only images are served");
      return new FileReply(f.path, mime, { fresh: true, whole: true });
    }
    if (method === "GET" && path === "/api/open-in/apps") return { vscode: false };
    // Comments stay on this computer (step 3): written, copied and sent from the copy's own list.
    if (this.copies.comments.handles(method, path)) return this.copies.comments.answer(task, method, path, body);
    if (method !== "GET" && method !== "POST") throw new HostError("read_only", `这是 ${task.remote.name} 上的远程任务：这一项不能在这台电脑上做`);
    return this.copies.views.read(taskId, method, path, Object.fromEntries(query), body);
  }

  /** Step 3: an image a remote page loads (GET /api/remote/files/<key>/<rel>). */
  serveFile(key: string, rel: string): Promise<{ path: string; mime: string }> {
    return this.copies.files.serve(key, rel);
  }

  /**
   * What a copy takes from this computer's own API (B's Host refuses the rest, 「B 能看到什么」): reading it, a message,
   * an answer to an approval or question, 打断, a new session, renaming the task or a session and archiving or restoring
   * a session (on A), and archiving the task (which deletes the copy). Changing the task's column, topic or 说明, a session's model, a branch, a terminal… are
   * A's to do. Each route that a copy takes says so where it is declared (`remoteCopy`, http/route.ts; 2026-11-05, it
   * was a list here that every new route had to be added to); a write to a task or session that does not say is refused.
   */
  guardRoute(route: Pick<Route, "method" | "path" | "remoteCopy">, params: Record<string, string>): void {
    const id = params.id;
    if (!id || route.method === "GET" || route.remoteCopy) return;
    const task = route.path.startsWith("/api/tasks/:id") ? this.store.getTask(id) : route.path.startsWith("/api/sessions/:id") ? this.sessionTask(id) : undefined;
    if (!task?.remote) return;
    throw new HostError("read_only", `这是 ${task.remote.name} 上的远程任务：这一项要在那台电脑上操作`);
  }

  private sessionTask(sessionId: Id): Task | undefined {
    const s = this.store.getSession(sessionId);
    return s?.taskId ? this.store.getTask(s.taskId) : undefined;
  }
}
