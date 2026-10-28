import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import type { DeviceEvent, DeviceFrame, DeviceRef } from "@amo-studio/relay";

// The Host's connection to the team server as a device (plans/remote-session.md, step 1; the ideas borrowed from Multica,
// not its code): the Host connects out — the server never reaches into this computer — and comes back by itself with a
// backoff (1 s doubling to 30 s, with jitter, back to 1 s once a connection held 10 s). Both ends ping: 60 s without an
// answer counts as gone. Commands carry an id; the receiver answers a repeated id with the answer it gave (CommandLog),
// and a command whose answer did not come before the connection dropped is「结果未确认」— never sent again blindly.

/** Reconnect delays: base doubling up to max, each ±20 %; reset() after a connection that held. */
export class Backoff {
  private attempt = 0;
  constructor(
    private readonly opts: { baseMs?: number; maxMs?: number; jitter?: number; random?: () => number } = {},
  ) {}
  next(): number {
    const base = this.opts.baseMs ?? 1000;
    const max = this.opts.maxMs ?? 30_000;
    const jitter = this.opts.jitter ?? 0.2;
    const raw = Math.min(max, base * 2 ** this.attempt);
    this.attempt++;
    const r = (this.opts.random ?? Math.random)();
    return Math.round(Math.min(max, raw * (1 - jitter + 2 * jitter * r)));
  }
  reset(): void {
    this.attempt = 0;
  }
}

/** The answers given to recent commands, by sender and id: a repeated command gets the same answer, not a second run. */
export class CommandLog<T> {
  private readonly seen = new Map<string, { at: number; answer: T }>();
  constructor(
    private readonly opts: { ttlMs?: number; max?: number; now?: () => number } = {},
  ) {}
  private key = (from: DeviceRef, id: string) => `${from.account}\n${from.device}\n${id}`;
  /** The answer already given to this command, or undefined. */
  get(from: DeviceRef, id: string): T | undefined {
    this.prune();
    return this.seen.get(this.key(from, id))?.answer;
  }
  remember(from: DeviceRef, id: string, answer: T): void {
    this.seen.set(this.key(from, id), { at: (this.opts.now ?? Date.now)(), answer });
    this.prune();
  }
  private prune(): void {
    const now = (this.opts.now ?? Date.now)();
    const ttl = this.opts.ttlMs ?? 10 * 60_000;
    for (const [k, v] of this.seen) if (now - v.at > ttl) this.seen.delete(k);
    const max = this.opts.max ?? 1000;
    // Oldest first (insertion order).
    for (const k of this.seen.keys()) {
      if (this.seen.size <= max) break;
      this.seen.delete(k);
    }
  }
  get size(): number {
    return this.seen.size;
  }
}

/** A command whose answer did not come: the connection dropped (unconfirmed), the peer could not be reached, or time ran out. */
export class CommandError extends Error {
  constructor(
    readonly code: "unconfirmed" | "offline" | "not_paired" | "timeout" | "bad_frame" | "not_connected",
    message: string,
  ) {
    super(message);
  }
}

export type LinkState = "connecting" | "online" | "offline" | "unauthorized" | "server-old" | "replaced";
export type RelayFrameIn = Extract<DeviceEvent, { type: "relay" }>;

export interface DeviceLinkOptions {
  /** `http://host:port` of the team server. */
  server: string;
  key: string;
  device: { id: string; name: string };
  heartbeatMs?: number;
  deadMs?: number;
  /** A connection that held this long resets the backoff. */
  stableMs?: number;
  backoff?: Backoff;
}

interface Pending {
  resolve(frame: RelayFrameIn): void;
  reject(err: CommandError): void;
  timer: NodeJS.Timeout;
}

/**
 * One device connection. Emits "state" when its state changes and "event" for each event from the server (relay frames
 * that answer a request() are taken by it and not emitted).
 */
export class DeviceLink extends EventEmitter<{ state: [LinkState]; event: [DeviceEvent] }> {
  state: LinkState = "connecting";
  /** Why it is not online, for the person. */
  message: string | null = null;
  retryAt: number | null = null;
  since: number | null = null;
  private ws: WebSocket | null = null;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private beatTimer: NodeJS.Timeout | null = null;
  private lastPong = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly backoff: Backoff;

  constructor(private readonly opts: DeviceLinkOptions) {
    super();
    this.backoff = opts.backoff ?? new Backoff();
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.terminate();
    this.ws = null;
    this.failPending("unconfirmed", "连接断了，结果未确认");
  }

  /** Try again now (after a failure), not at the next attempt. */
  retryNow(): void {
    if (this.stopped || this.state === "online" || this.state === "connecting") return;
    this.backoff.reset();
    this.open();
  }

  private clearTimers(): void {
    for (const t of [this.retryTimer, this.stableTimer, this.beatTimer]) if (t) clearTimeout(t);
    this.retryTimer = this.stableTimer = this.beatTimer = null;
  }

  private set(state: LinkState, message: string | null = null): void {
    this.state = state;
    this.message = message;
    if (state !== "offline") this.retryAt = null;
    this.since = state === "online" ? Date.now() : null;
    this.emit("state", state);
  }

  private open(): void {
    this.clearTimers();
    this.ws?.terminate();
    this.set("connecting");
    const { server, key, device } = this.opts;
    const url = `${server.replace(/^http/i, "ws")}/api/devices/ws?device=${encodeURIComponent(device.id)}&name=${encodeURIComponent(device.name)}`;
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${key}` }, handshakeTimeout: 10_000 });
    this.ws = ws;
    let refused: number | null = null;
    ws.on("unexpected-response", (_req, res) => {
      refused = res.statusCode ?? 0;
      res.resume();
      ws.terminate();
    });
    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.lastPong = Date.now();
      this.set("online");
      this.stableTimer = setTimeout(() => this.backoff.reset(), this.opts.stableMs ?? 10_000);
      this.beat(ws);
    });
    ws.on("pong", () => (this.lastPong = Date.now()));
    ws.on("message", (data) => {
      let e: DeviceEvent;
      try {
        e = JSON.parse(String(data)) as DeviceEvent;
      } catch {
        return;
      }
      this.take(e);
    });
    ws.on("error", () => undefined);
    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      this.failPending("unconfirmed", "连接断了，结果未确认（重连后可以再试）");
      if (this.stopped) return;
      if (code === 4001) return this.set("replaced", "这台电脑上另一个程序用同一个设备编号连上了服务器（比如同时开了两个 Studio）。关掉另一个后点「重新连接」。");
      if (refused === 401) return void this.whyRefused();
      this.later(refused ? `服务器拒绝了连接（${refused}）` : "连不上团队服务器，或者连接断了");
    });
  }

  /** 401 from a service without the devices channel (it answers 401 to any unknown socket path) vs. a key it no longer takes. */
  private async whyRefused(): Promise<void> {
    try {
      const h = (await (await fetch(`${this.opts.server}/api/health`, { signal: AbortSignal.timeout(10_000) })).json()) as { devices?: unknown };
      if (this.stopped) return;
      if (typeof h.devices !== "number") return this.set("server-old", "团队服务器上的中转服务还没有更新，不支持远程会话。更新中转服务后点「重新连接」。");
      this.set("unauthorized", "团队服务器不认这台电脑上的登录了：在 AMO 平台里重新登录。");
    } catch {
      if (!this.stopped) this.later("连不上团队服务器");
    }
  }

  private later(message: string): void {
    const wait = this.backoff.next();
    this.retryAt = Date.now() + wait;
    this.set("offline", message);
    this.retryTimer = setTimeout(() => this.open(), wait);
  }

  private beat(ws: WebSocket): void {
    this.beatTimer = setTimeout(() => {
      if (this.ws !== ws) return;
      if (Date.now() - this.lastPong > (this.opts.deadMs ?? 60_000)) {
        // Gone without a word (sleep, the network): treat it as closed.
        ws.terminate();
        return;
      }
      if (ws.readyState === ws.OPEN) ws.ping();
      this.beat(ws);
    }, this.opts.heartbeatMs ?? 15_000);
  }

  private take(e: DeviceEvent): void {
    if (e.type === "relay" && e.re && this.pending.has(e.re)) {
      const p = this.pending.get(e.re)!;
      this.pending.delete(e.re);
      clearTimeout(p.timer);
      p.resolve(e);
      return;
    }
    if (e.type === "relay-error" && e.id && this.pending.has(e.id)) {
      const p = this.pending.get(e.id)!;
      this.pending.delete(e.id);
      clearTimeout(p.timer);
      p.reject(new CommandError(e.code, e.message));
      return;
    }
    this.emit("event", e);
  }

  private failPending(code: CommandError["code"], message: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CommandError(code, message));
      this.pending.delete(id);
    }
  }

  /** Sends a frame as it is; false when not connected. */
  send(frame: DeviceFrame): boolean {
    const ws = this.ws;
    if (!ws || this.state !== "online" || ws.readyState !== ws.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }

  /** A command to a paired device and its answer (the relay frame whose `re` is its id). */
  request(to: DeviceRef, kind: string, body: unknown, timeoutMs = 10_000): Promise<RelayFrameIn> {
    const id = `c_${randomBytes(8).toString("hex")}`;
    return new Promise((resolve, reject) => {
      if (!this.send({ type: "relay", to, id, kind, body })) return reject(new CommandError("not_connected", "这台电脑没有连上团队服务器"));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CommandError("timeout", `${Math.round(timeoutMs / 1000)} 秒内没有回音`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }
}
