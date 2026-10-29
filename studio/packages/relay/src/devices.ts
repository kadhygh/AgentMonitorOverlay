import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { WebSocket } from "ws";
import {
  CLOSE_REPLACED,
  DEVICE_CHANNEL_VERSION,
  DEVICE_ID_RE,
  FRAME_ID_RE,
  FRAME_KIND_RE,
  PAIR_REQUEST_DAYS,
  type DeviceEvent,
  type DeviceRef,
  type NamedDevice,
  type PairRequest,
  type PairRequestState,
  type PeerView,
} from "./devices-protocol.js";
import { RelayError } from "./store.js";

// The devices side of the relay service (devices-protocol.ts, plans/remote-session.md step 1): who is connected as which
// device, pairing requests, the service's copy of the pairs, and passing frames between paired devices. The tables live
// in the relay's database beside the rest; what is online is memory only. Frames are never stored or read beyond their
// envelope (to, id, kind).

type Row = Record<string, unknown>;

const DAY = 24 * 60 * 60_000;
const NAME_MAX = 40;
/** Requests one device may have waiting at once: enough for a person, not for a flood. */
const MAX_PENDING_PER_DEVICE = 10;

const keyOf = (r: DeviceRef) => `${r.account}\n${r.device}`;

export function checkDeviceId(value: unknown, what = "设备编号"): string {
  if (typeof value !== "string" || !DEVICE_ID_RE.test(value)) throw new RelayError("bad_request", `${what}不对`);
  return value;
}

export function checkDeviceName(value: unknown): string {
  if (typeof value !== "string") throw new RelayError("bad_request", "设备名 必须是文字");
  const v = value.trim();
  if (!v) throw new RelayError("bad_request", "设备名 不能为空");
  if (v.length > NAME_MAX) throw new RelayError("bad_request", `设备名 太长（最多 ${NAME_MAX} 字）`);
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new RelayError("bad_request", "设备名里不能有控制字符");
  return v;
}

interface Live {
  ws: WebSocket;
  name: string;
  lastPong: number;
}

export interface DeviceHubOptions {
  db: DatabaseSync;
  /** Whether an account exists (the relay's members). */
  isMember(name: string): boolean;
  now?: () => number;
  /** How often to ping each device (default 15 s) and how long without an answer counts as gone (default 60 s). */
  heartbeatMs?: number;
  deadMs?: number;
}

export class DeviceHub {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly live = new Map<string, Live>();
  private readonly lastSeen = new Map<string, number>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly deadMs: number;

  constructor(private readonly opts: DeviceHubOptions) {
    this.db = opts.db;
    this.now = opts.now ?? Date.now;
    this.deadMs = opts.deadMs ?? 60_000;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_pair_requests (
        id TEXT PRIMARY KEY, from_account TEXT NOT NULL, from_device TEXT NOT NULL, from_name TEXT NOT NULL,
        to_account TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        answer_device TEXT, answer_name TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS device_pair_requests_to ON device_pair_requests(to_account, state);
      CREATE TABLE IF NOT EXISTS device_pairs (
        owner_account TEXT NOT NULL, owner_device TEXT NOT NULL, owner_name TEXT NOT NULL,
        guest_account TEXT NOT NULL, guest_device TEXT NOT NULL, guest_name TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (owner_account, owner_device, guest_account, guest_device)
      );
      CREATE INDEX IF NOT EXISTS device_pairs_guest ON device_pairs(guest_account, guest_device);
    `);
    this.heartbeat = setInterval(() => this.beat(), opts.heartbeatMs ?? 15_000);
    this.heartbeat.unref();
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const l of this.live.values()) l.ws.terminate();
    this.live.clear();
  }

  // ---- connections

  /** Closes every device of an account (renamed or turned off on the admin page): they connect again as who they are now. */
  dropAccount(account: string): void {
    for (const [k, l] of [...this.live]) if (k.startsWith(`${account}\n`)) l.ws.close(1012, "account changed");
  }

  online(ref: DeviceRef): boolean {
    return this.live.has(keyOf(ref));
  }

  /** ms since the device was last connected (0 online), null when not seen since the service started. */
  ago(ref: DeviceRef): number | null {
    if (this.online(ref)) return 0;
    const t = this.lastSeen.get(keyOf(ref));
    return t === undefined ? null : Math.max(0, this.now() - t);
  }

  /** A device's socket is open: it replaces another socket of the same device (told why, so it does not fight back). */
  connect(me: NamedDevice, ws: WebSocket): void {
    const k = keyOf(me);
    const old = this.live.get(k);
    if (old && old.ws !== ws) old.ws.close(CLOSE_REPLACED, "replaced");
    const entry: Live = { ws, name: me.name, lastPong: this.now() };
    this.live.set(k, entry);
    ws.on("pong", () => (entry.lastPong = this.now()));
    ws.on("close", () => {
      if (this.live.get(k) !== entry) return;
      this.live.delete(k);
      this.lastSeen.set(k, this.now());
      this.presence({ ...me, name: entry.name }, false);
    });
    this.rename(me, me.name, false);
    this.send(me, { type: "hello", me, version: DEVICE_CHANNEL_VERSION });
    this.presence(me, true);
  }

  private beat(): void {
    const now = this.now();
    for (const l of this.live.values()) {
      if (now - l.lastPong > this.deadMs) l.ws.terminate();
      else if (l.ws.readyState === l.ws.OPEN) l.ws.ping();
    }
  }

  private send(to: DeviceRef, event: DeviceEvent): boolean {
    const l = this.live.get(keyOf(to));
    if (!l || l.ws.readyState !== l.ws.OPEN) return false;
    l.ws.send(JSON.stringify(event));
    return true;
  }

  private sendAccount(account: string, event: DeviceEvent, except?: string): void {
    for (const [k, l] of this.live) {
      const [a, d] = k.split("\n");
      if (a === account && d !== except && l.ws.readyState === l.ws.OPEN) l.ws.send(JSON.stringify(event));
    }
  }

  /** Tells the device's peers it came, went, or has a new name. */
  private presence(me: NamedDevice, online: boolean): void {
    const ago = online ? 0 : this.ago(me);
    for (const p of this.pairs(me)) this.send(p.peer, { type: "presence", peer: { ...me }, online, ago });
  }

  /** A device's name, as it says it: kept in its pairs and requests (and told to its peers when `announce`). */
  rename(me: DeviceRef, nameValue: unknown, announce = true): void {
    const name = checkDeviceName(nameValue);
    const l = this.live.get(keyOf(me));
    if (l) l.name = name;
    this.db.prepare("UPDATE device_pairs SET owner_name = ? WHERE owner_account = ? AND owner_device = ?").run(name, me.account, me.device);
    this.db.prepare("UPDATE device_pairs SET guest_name = ? WHERE guest_account = ? AND guest_device = ?").run(name, me.account, me.device);
    this.db.prepare("UPDATE device_pair_requests SET from_name = ? WHERE from_account = ? AND from_device = ?").run(name, me.account, me.device);
    if (announce) this.presence({ ...me, name }, this.online(me));
  }

  // ---- pairing requests

  private prune(): void {
    this.db.prepare("DELETE FROM device_pair_requests WHERE expires_at <= ?").run(this.now());
  }

  private toRequest(r: Row): PairRequest {
    return {
      id: String(r.id),
      from: { account: String(r.from_account), device: String(r.from_device), name: String(r.from_name) },
      to: String(r.to_account),
      state: String(r.state) as PairRequestState,
      answeredBy: r.answer_device ? { account: String(r.to_account), device: String(r.answer_device), name: String(r.answer_name ?? "") } : null,
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
    };
  }

  private requestRow(id: unknown): Row {
    if (typeof id !== "string") throw new RelayError("bad_request", "请求编号不对");
    this.prune();
    const r = this.db.prepare("SELECT * FROM device_pair_requests WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw new RelayError("not_found", "这个配对请求已经不在了（处理过、撤回了，或者超过 7 天过期了）");
    return r;
  }

  /** B asks account `to` to pair with this device. Asking again while one waits renews it. */
  requestPair(me: NamedDevice, toValue: unknown): PairRequest {
    if (typeof toValue !== "string" || !toValue.trim()) throw new RelayError("bad_request", "先填对方的账号名");
    const to = toValue.trim();
    if (!this.opts.isMember(to)) throw new RelayError("not_found", `服务器上没有账号「${to}」`);
    this.prune();
    const now = this.now();
    const expires = now + PAIR_REQUEST_DAYS * DAY;
    const same = this.db.prepare("SELECT * FROM device_pair_requests WHERE from_account = ? AND from_device = ? AND to_account = ? AND state = 'pending'").get(me.account, me.device, to) as Row | undefined;
    let id: string;
    if (same) {
      id = String(same.id);
      this.db.prepare("UPDATE device_pair_requests SET from_name = ?, expires_at = ? WHERE id = ?").run(me.name, expires, id);
    } else {
      const waiting = Number((this.db.prepare("SELECT COUNT(*) AS n FROM device_pair_requests WHERE from_account = ? AND from_device = ? AND state = 'pending'").get(me.account, me.device) as Row).n);
      if (waiting >= MAX_PENDING_PER_DEVICE) throw new RelayError("conflict", `这台电脑已经有 ${waiting} 个配对请求在等回复，先撤回一些`);
      // Answers already seen or not, to the same account: the new request supersedes them.
      this.db.prepare("DELETE FROM device_pair_requests WHERE from_account = ? AND from_device = ? AND to_account = ?").run(me.account, me.device, to);
      id = `pr_${randomBytes(8).toString("hex")}`;
      this.db.prepare("INSERT INTO device_pair_requests (id, from_account, from_device, from_name, to_account, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, me.account, me.device, me.name, to, now, expires);
    }
    const request = this.toRequest(this.requestRow(id));
    this.sendAccount(to, { type: "pair-request", request }, to === me.account ? me.device : undefined);
    return request;
  }

  /** Requests to this device's account (pending, not its own), and this device's own (pending or answered). */
  requests(me: DeviceRef): { incoming: PairRequest[]; outgoing: PairRequest[] } {
    this.prune();
    const incoming = (this.db.prepare("SELECT * FROM device_pair_requests WHERE to_account = ? AND state = 'pending' ORDER BY created_at").all(me.account) as Row[])
      .map((r) => this.toRequest(r))
      .filter((r) => !(r.from.account === me.account && r.from.device === me.device));
    const outgoing = (this.db.prepare("SELECT * FROM device_pair_requests WHERE from_account = ? AND from_device = ? ORDER BY created_at").all(me.account, me.device) as Row[]).map((r) => this.toRequest(r));
    return { incoming, outgoing };
  }

  /** A device of the account asked allows or refuses. Allowing makes the pair (this device the owner). */
  answer(me: NamedDevice, id: unknown, allow: unknown): { request: PairRequest; pair: PeerView | null } {
    if (typeof allow !== "boolean") throw new RelayError("bad_request", "allow 必须是 true 或 false");
    const row = this.requestRow(id);
    const r = this.toRequest(row);
    if (r.to !== me.account) throw new RelayError("forbidden", "这个配对请求不是发给你的账号的");
    if (r.from.account === me.account && r.from.device === me.device) throw new RelayError("bad_request", "不能自己允许自己发出的请求");
    if (r.state !== "pending") throw new RelayError("conflict", r.state === "allowed" ? "这个请求已经被允许了" : "这个请求已经被拒绝了");
    const now = this.now();
    this.db.prepare("UPDATE device_pair_requests SET state = ?, answer_device = ?, answer_name = ?, expires_at = ? WHERE id = ?").run(allow ? "allowed" : "refused", me.device, me.name, now + PAIR_REQUEST_DAYS * DAY, r.id);
    if (allow)
      this.db
        .prepare(
          `INSERT INTO device_pairs (owner_account, owner_device, owner_name, guest_account, guest_device, guest_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(owner_account, owner_device, guest_account, guest_device) DO UPDATE SET owner_name = excluded.owner_name, guest_name = excluded.guest_name`,
        )
        .run(me.account, me.device, me.name, r.from.account, r.from.device, r.from.name, now);
    const request = this.toRequest(this.requestRow(r.id));
    this.send(r.from, { type: "pair-answered", request });
    this.sendAccount(me.account, { type: "pair-request-closed", requestId: r.id }, me.device);
    const pair = allow ? (this.pairs(me).find((p) => p.peer.account === r.from.account && p.peer.device === r.from.device && p.role === "owner") ?? null) : null;
    return { request, pair };
  }

  /** B withdraws its waiting request, or puts away an answer it has seen. */
  dismiss(me: DeviceRef, id: unknown): void {
    const r = this.toRequest(this.requestRow(id));
    if (r.from.account !== me.account || r.from.device !== me.device) throw new RelayError("forbidden", "只能撤回这台电脑自己发出的请求");
    this.db.prepare("DELETE FROM device_pair_requests WHERE id = ?").run(r.id);
    if (r.state === "pending") this.sendAccount(r.to, { type: "pair-request-closed", requestId: r.id });
  }

  // ---- pairs

  /** This device's pairs, both ways round, with whether each peer is online. */
  pairs(me: DeviceRef): PeerView[] {
    const rows = this.db.prepare("SELECT * FROM device_pairs WHERE (owner_account = ? AND owner_device = ?) OR (guest_account = ? AND guest_device = ?) ORDER BY created_at").all(me.account, me.device, me.account, me.device) as Row[];
    return rows.map((r) => {
      const owner = String(r.owner_account) === me.account && String(r.owner_device) === me.device;
      const peer: NamedDevice = owner
        ? { account: String(r.guest_account), device: String(r.guest_device), name: String(r.guest_name) }
        : { account: String(r.owner_account), device: String(r.owner_device), name: String(r.owner_name) };
      const live = this.live.get(keyOf(peer));
      return { peer: { ...peer, name: live?.name ?? peer.name }, role: owner ? "owner" : "guest", pairedAt: Number(r.created_at), online: !!live, ago: this.ago(peer) };
    });
  }

  paired(a: DeviceRef, b: DeviceRef): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM device_pairs WHERE (owner_account = ? AND owner_device = ? AND guest_account = ? AND guest_device = ?) OR (owner_account = ? AND owner_device = ? AND guest_account = ? AND guest_device = ?) LIMIT 1")
      .get(a.account, a.device, b.account, b.device, b.account, b.device, a.account, a.device);
  }

  /** Ends the pairing between this device and the peer, whichever allowed whom; the peer is told. */
  unpair(me: DeviceRef, peerAccount: unknown, peerDevice: unknown): number {
    if (typeof peerAccount !== "string" || !peerAccount) throw new RelayError("bad_request", "peerAccount 不能为空");
    const peer: DeviceRef = { account: peerAccount, device: checkDeviceId(peerDevice, "对方的设备编号") };
    const removed = Number(
      this.db
        .prepare("DELETE FROM device_pairs WHERE (owner_account = ? AND owner_device = ? AND guest_account = ? AND guest_device = ?) OR (owner_account = ? AND owner_device = ? AND guest_account = ? AND guest_device = ?)")
        .run(me.account, me.device, peer.account, peer.device, peer.account, peer.device, me.account, me.device).changes,
    );
    if (removed) this.send(peer, { type: "unpaired", peer: { account: me.account, device: me.device } });
    return removed;
  }

  // ---- frames

  /** A frame from a device's socket. Not JSON, not a frame, not paired, or the peer away: the sender is told why. */
  frame(me: DeviceRef, raw: string): void {
    let f: Record<string, unknown>;
    try {
      const o = JSON.parse(raw) as unknown;
      if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error();
      f = o as Record<string, unknown>;
    } catch {
      this.send(me, { type: "relay-error", id: "", to: null, code: "bad_frame", message: "不是有效的 JSON 对象" });
      return;
    }
    if (f.type === "name") {
      try {
        this.rename(me, f.name);
      } catch (err) {
        this.send(me, { type: "relay-error", id: "", to: null, code: "bad_frame", message: (err as Error).message });
      }
      return;
    }
    const id = typeof f.id === "string" && FRAME_ID_RE.test(f.id) ? f.id : null;
    const bad = (message: string): void => void this.send(me, { type: "relay-error", id: id ?? "", to: null, code: "bad_frame", message });
    if (f.type !== "relay") return bad(`不认识的帧：${String(f.type)}`);
    if (!id) return bad("id 不对（1–64 个字母、数字或 _.:-）");
    if (typeof f.kind !== "string" || !FRAME_KIND_RE.test(f.kind)) return bad("kind 不对");
    if (f.re !== undefined && (typeof f.re !== "string" || !FRAME_ID_RE.test(f.re))) return bad("re 不对");
    const t = f.to as Record<string, unknown> | undefined;
    if (!t || typeof t.account !== "string" || typeof t.device !== "string" || !DEVICE_ID_RE.test(t.device)) return bad("to 要写清对方的 account 和 device");
    const to: DeviceRef = { account: t.account, device: t.device };
    if (!this.paired(me, to)) {
      this.send(me, { type: "relay-error", id, to, code: "not_paired", message: "和这台设备没有配对，服务器不转发" });
      return;
    }
    const out: DeviceEvent = { type: "relay", from: { account: me.account, device: me.device }, to, id, kind: f.kind, ...(f.re !== undefined ? { re: f.re as string } : {}), ...(f.body !== undefined ? { body: f.body } : {}) };
    if (!this.send(to, out)) this.send(me, { type: "relay-error", id, to, code: "offline", message: "对方现在不在线" });
  }
}
