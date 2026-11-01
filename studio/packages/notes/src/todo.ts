import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyTodoOps, type TodoDevice, type TodoEntry, type TodoOp, type TodoStatus, type TodoView } from "@amo-studio/protocol";

// 待办's copy and its sync (2026-11-01, plans/todo.md). The lists live on the team server (the relay service's
// /api/todo); this keeps, per account, the server's state as last fetched (`base`, with its `rev`) and the changes made
// here not sent yet (`queue`), in the program's home (todo-cache.json — a copy of the server's, not the person's file,
// so not in the work folder). What the window shows is the base with the queue applied on top. A sync sends the queue,
// then asks for what changed since `rev`. It runs when something changes here, when the window is shown, and on a timer
// (often while the window is open, rarely while it is not). The server cannot be reached: the queue waits, the window
// says so, and the next sync sends it.

export interface TodoAccount {
  server: string;
  name: string;
  key: string;
}

export interface TodoSyncDeps {
  /** Who is logged in here (the AMO 平台's account.json), read at once without the key: which copy to show. */
  accountInfo(): { server: string; name: string } | null;
  /** The same with its key (decrypting takes a moment), or null when it cannot be had. */
  account(): Promise<TodoAccount | null>;
  /** This computer (device.json). */
  device(): { id: string; name: string };
  /** 使用待办 and 已完成保留 (the program's settings). */
  settings(): { useTodo: boolean; keepDays: number };
  /** The view changed: tell the windows. */
  changed(view: TodoView): void;
  fetch?: typeof fetch;
  now?: () => number;
}

interface Copy {
  rev: number;
  loaded: boolean;
  items: TodoEntry[];
  devices: TodoDevice[];
  queue: TodoOp[];
}

interface CacheFile {
  accounts?: Record<string, Copy>;
}

const DAY = 24 * 60 * 60_000;
const OPS_PER_CALL = 500;
const emptyCopy = (): Copy => ({ rev: 0, loaded: false, items: [], devices: [], queue: [] });
const accountKey = (a: { server: string; name: string }) => `${a.server}\n${a.name}`;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class TodoSync {
  private readonly file: string;
  private cache: CacheFile;
  /** The account with its key, as of the last sync (null: none, or not the one account.json names now). */
  private who: TodoAccount | null = null;
  private status: TodoStatus = "syncing";
  private message: string | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private stopped = false;

  constructor(
    home: string,
    private readonly deps: TodoSyncDeps,
  ) {
    this.file = join(home, "todo-cache.json");
    this.cache = this.read();
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private read(): CacheFile {
    try {
      if (!existsSync(this.file)) return {};
      const o = JSON.parse(readFileSync(this.file, "utf8")) as CacheFile;
      return o && typeof o === "object" ? o : {};
    } catch {
      // A damaged copy: the server has everything but what was queued.
      return {};
    }
  }

  private write(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.cache));
    renameSync(tmp, this.file);
  }

  private info(): { server: string; name: string } | null {
    try {
      return this.deps.accountInfo();
    } catch {
      return null;
    }
  }

  private copy(): Copy | null {
    const info = this.info();
    if (!info) return null;
    const key = accountKey(info);
    this.cache.accounts ??= {};
    return (this.cache.accounts[key] ??= emptyCopy());
  }

  private me(): { device: string; name: string } {
    const d = this.deps.device();
    return { device: d.id, name: d.name };
  }

  view(): TodoView {
    const settings = this.deps.settings();
    const d = this.deps.device();
    const info = this.info();
    const copy = this.copy();
    const base = new Map((copy?.items ?? []).map((i) => [i.id, i]));
    const items = copy ? [...applyTodoOps(base, copy.queue, this.me(), this.now).values()].filter((i) => !i.deleted) : [];
    return {
      status: settings.useTodo ? (info ? this.status : "signed-out") : "off",
      message: settings.useTodo && info ? this.message : null,
      account: info,
      device: d,
      items,
      devices: copy?.devices ?? [],
      pending: copy?.queue.length ?? 0,
      loaded: copy?.loaded ?? false,
      keepDays: settings.keepDays,
    };
  }

  private tell(): void {
    this.deps.changed(this.view());
  }

  /** Changes made in the window: shown at once, sent soon. */
  change(ops: TodoOp[]): TodoView {
    const copy = this.copy();
    if (!copy) throw new Error("没有登录，待办用不了");
    copy.queue.push(...ops);
    this.write();
    this.tell();
    this.later(200);
    return this.view();
  }

  /** The window is shown (sync often) or hidden (now and then). */
  setActive(on: boolean): void {
    this.active = on;
    if (on) this.later(0);
    else this.schedule();
  }

  start(): void {
    this.stopped = false;
    this.later(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.soon) clearTimeout(this.soon);
    this.timer = this.soon = null;
  }

  private later(ms: number): void {
    if (this.stopped) return;
    if (this.soon) clearTimeout(this.soon);
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.sync();
    }, ms);
  }

  /** The next timed sync: every 10 s with the window open, every 2 min without; 30 s after a failure. */
  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const failing = this.status === "offline" || this.status === "error";
    const ms = this.active ? 10_000 : failing ? 30_000 : 120_000;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync();
    }, ms);
    this.timer.unref?.();
  }

  /** Sends the queue and fetches what changed; one at a time (asked again while running: once more after). */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.sync();
      } else this.schedule();
    });
    return this.running;
  }

  private async run(): Promise<void> {
    if (!this.deps.settings().useTodo) {
      this.tell();
      return;
    }
    const info = this.info();
    const before = this.who;
    try {
      this.who = info ? await this.deps.account() : null;
    } catch {
      this.who = null;
    }
    if (!info) {
      this.message = null;
      this.tell();
      return;
    }
    if (!this.who || accountKey(this.who) !== accountKey(info)) {
      // account.json is there but its key cannot be read here (another Windows user's, copied from elsewhere).
      this.who = null;
      this.status = "signed-out";
      this.message = "读不到登录信息，请在 AMO 平台里重新登录";
      this.tell();
      return;
    }
    if (!before || accountKey(before) !== accountKey(this.who)) this.message = null;
    this.status = "syncing";
    this.tell();
    try {
      const refused = [await this.push()];
      this.expire();
      refused.push(await this.push());
      await this.pull();
      this.status = "synced";
      this.message = refused.find((m) => m) ?? null;
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        // The key ran out (or the account was renamed): as good as signed out here until the platform logs in again.
        this.status = "signed-out";
        this.message = "登录已失效，请在 AMO 平台里重新登录";
      } else if (err instanceof HttpError) {
        this.status = "error";
        this.message = `服务器出错：${err.message}`;
      } else {
        this.status = "offline";
        this.message = "连不上服务器";
      }
    }
    this.tell();
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const who = this.who!;
    const res = await (this.deps.fetch ?? fetch)(`${who.server}${path}`, {
      method,
      headers: { authorization: `Bearer ${who.key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
    if (!res.ok || !data) throw new HttpError(res.status, data?.message ?? `HTTP ${res.status}`);
    return data;
  }

  /** Sends what is queued, a batch at a time; what the server will never take is dropped (and said until the next sync). */
  private async push(): Promise<string | null> {
    const copy = this.copy()!;
    const me = this.me();
    let refused: string | null = null;
    while (copy.queue.length) {
      const batch = copy.queue.slice(0, OPS_PER_CALL);
      const r = await this.call<{ rev: number; rejected: Array<{ index: number; message: string }> }>("POST", "/api/todo/ops", { device: me.device, deviceName: me.name, ops: batch });
      // Only what was sent goes: changes made while it was on its way stay queued.
      copy.queue.splice(0, batch.length);
      if (r.rejected.length) refused = `有 ${r.rejected.length} 条改动服务器没收：${r.rejected[0]!.message}`;
      this.write();
    }
    return refused;
  }

  private async pull(): Promise<void> {
    const copy = this.copy()!;
    const me = this.me();
    const q = new URLSearchParams({ device: me.device, deviceName: me.name, since: String(copy.loaded ? copy.rev : 0) });
    const s = await this.call<{ rev: number; items: TodoEntry[]; devices: TodoDevice[]; full: boolean }>("GET", `/api/todo?${q}`);
    const items = s.full ? new Map<string, TodoEntry>() : new Map(copy.items.map((i) => [i.id, i]));
    for (const i of s.items) {
      if (i.deleted) items.delete(i.id);
      else items.set(i.id, i);
    }
    copy.items = [...items.values()];
    copy.devices = s.devices;
    copy.rev = s.rev;
    copy.loaded = true;
    this.write();
  }

  /** 已完成保留: items done longer ago than that are deleted (by whichever device sees it first). */
  private expire(): void {
    const days = this.deps.settings().keepDays;
    const copy = this.copy()!;
    if (!days || !copy.loaded) return;
    const before = this.now - days * DAY;
    const view = applyTodoOps(new Map(copy.items.map((i) => [i.id, i])), copy.queue, this.me(), this.now);
    const old = [...view.values()].filter((i) => !i.deleted && i.done && i.doneAt !== null && i.doneAt < before);
    if (!old.length) return;
    copy.queue.push(...old.map((i): TodoOp => ({ op: "delete", id: i.id })));
    this.write();
  }
}
