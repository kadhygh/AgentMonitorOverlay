import type { DatabaseSync } from "node:sqlite";
import { DEVICE_ID_RE } from "./devices-protocol.js";
import { RelayError } from "./store.js";
import { TODO_ID_RE, TODO_ITEMS_MAX, TODO_OPS_MAX, TODO_SHARED, TODO_TEXT_MAX, TODO_TOMBSTONE_DAYS, type TodoDevice, type TodoItem, type TodoOp, type TodoOpsResult, type TodoSnapshot } from "./todo-protocol.js";

// 待办's records (2026-11-01, plans/done/todo.md), in the relay's database: the items of every account's lists, the devices
// that used them, and per account the change counter (`rev`, every change takes it up and stamps the item) and the
// highest counter of the deletion marks already thrown away (a device that last asked before that gets everything).

type Row = Record<string, unknown>;

const DAY = 24 * 60 * 60_000;
const NAME_MAX = 40;

function listOk(value: unknown): value is string {
  return value === TODO_SHARED || (typeof value === "string" && value.startsWith("device:") && DEVICE_ID_RE.test(value.slice(7)));
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") throw new RelayError("bad_request", "待办的内容要是文字");
  const t = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\s*\n\s*/g, " ").trim();
  if (!t) throw new RelayError("bad_request", "待办的内容不能为空");
  if (t.length > TODO_TEXT_MAX) throw new RelayError("bad_request", `待办太长（最多 ${TODO_TEXT_MAX} 个字）`);
  return t;
}

export function checkTodoDevice(device: unknown, name: unknown): { device: string; name: string } {
  if (typeof device !== "string" || !DEVICE_ID_RE.test(device)) throw new RelayError("bad_request", "设备编号不对");
  const n = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, NAME_MAX) : "";
  return { device, name: n || "未命名设备" };
}

function itemOf(r: Row): TodoItem {
  return {
    id: String(r.id),
    list: String(r.list),
    text: String(r.text),
    done: Number(r.done) === 1,
    order: Number(r.ord),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    doneAt: r.done_at === null || r.done_at === undefined ? null : Number(r.done_at),
    byDevice: String(r.by_device),
    byName: String(r.by_name),
    deleted: r.deleted_at !== null && r.deleted_at !== undefined,
    rev: Number(r.rev),
  };
}

export class TodoStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS todo_items (
        account TEXT NOT NULL, id TEXT NOT NULL, list TEXT NOT NULL, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
        ord REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, done_at INTEGER,
        by_device TEXT NOT NULL, by_name TEXT NOT NULL, deleted_at INTEGER, rev INTEGER NOT NULL,
        PRIMARY KEY (account, id)
      );
      CREATE INDEX IF NOT EXISTS todo_items_rev ON todo_items(account, rev);
      CREATE TABLE IF NOT EXISTS todo_devices (
        account TEXT NOT NULL, device TEXT NOT NULL, name TEXT NOT NULL, seen_at INTEGER NOT NULL,
        PRIMARY KEY (account, device)
      );
      CREATE TABLE IF NOT EXISTS todo_accounts (account TEXT PRIMARY KEY, rev INTEGER NOT NULL DEFAULT 0, purged_rev INTEGER NOT NULL DEFAULT 0);
    `);
  }

  private tx<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = run();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private counters(account: string): { rev: number; purgedRev: number } {
    const r = this.db.prepare("SELECT rev, purged_rev FROM todo_accounts WHERE account = ?").get(account) as Row | undefined;
    return { rev: Number(r?.rev ?? 0), purgedRev: Number(r?.purged_rev ?? 0) };
  }

  /** The device asked or changed something: it shows (by its name now) in the account's other devices. */
  private seen(account: string, d: { device: string; name: string }): void {
    this.db
      .prepare("INSERT INTO todo_devices (account, device, name, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (account, device) DO UPDATE SET name = excluded.name, seen_at = excluded.seen_at")
      .run(account, d.device, d.name, this.now());
  }

  private devices(account: string): TodoDevice[] {
    return (this.db.prepare("SELECT device, name, seen_at FROM todo_devices WHERE account = ? ORDER BY seen_at DESC").all(account) as Row[]).map((r) => ({ device: String(r.device), name: String(r.name), seenAt: Number(r.seen_at) }));
  }

  /** The changes after `since` for a device of the account (0, or older than the marks kept: everything). */
  snapshot(account: string, device: { device: string; name: string }, sinceValue: unknown): TodoSnapshot {
    const since = typeof sinceValue === "number" && Number.isFinite(sinceValue) && sinceValue > 0 ? Math.floor(sinceValue) : 0;
    this.seen(account, device);
    const { rev, purgedRev } = this.counters(account);
    // Asking from the future (the server's database was replaced): everything again.
    const full = since === 0 || since < purgedRev || since > rev;
    const rows = full
      ? (this.db.prepare("SELECT * FROM todo_items WHERE account = ? AND deleted_at IS NULL").all(account) as Row[])
      : (this.db.prepare("SELECT * FROM todo_items WHERE account = ? AND rev > ?").all(account, since) as Row[]);
    return { rev, items: rows.map(itemOf), devices: this.devices(account), full };
  }

  /** Applies a device's changes in order. A change that can never apply (bad text, a list that is not one) is skipped
   *  and reported, so the device's queue does not stick on it. */
  apply(account: string, device: { device: string; name: string }, opsValue: unknown): TodoOpsResult {
    if (!Array.isArray(opsValue)) throw new RelayError("bad_request", "ops 要是一个列表");
    if (opsValue.length > TODO_OPS_MAX) throw new RelayError("bad_request", `一次最多 ${TODO_OPS_MAX} 条改动`);
    return this.tx(() => {
      this.seen(account, device);
      let { rev } = this.counters(account);
      const now = this.now();
      const rejected: TodoOpsResult["rejected"] = [];
      const get = this.db.prepare("SELECT * FROM todo_items WHERE account = ? AND id = ?");
      let live = Number((this.db.prepare("SELECT COUNT(*) AS n FROM todo_items WHERE account = ? AND deleted_at IS NULL").get(account) as Row).n);
      opsValue.forEach((raw: unknown, index) => {
        try {
          const op = (raw && typeof raw === "object" ? raw : {}) as Partial<TodoOp> & Record<string, unknown>;
          if (typeof op.id !== "string" || !TODO_ID_RE.test(op.id)) throw new RelayError("bad_request", "待办编号不对");
          const have = get.get(account, op.id) as Row | undefined;
          if (op.op === "delete") {
            if (!have || have.deleted_at !== null) return;
            rev += 1;
            this.db.prepare("UPDATE todo_items SET deleted_at = ?, updated_at = ?, rev = ? WHERE account = ? AND id = ?").run(now, now, rev, account, op.id);
            live -= 1;
            return;
          }
          if (op.op !== "put") throw new RelayError("bad_request", `没有这种改动：${String(op.op)}`);
          if (op.list !== undefined && !listOk(op.list)) throw new RelayError("bad_request", `没有这张表：${String(op.list)}`);
          if (op.done !== undefined && typeof op.done !== "boolean") throw new RelayError("bad_request", "done 要是 true 或 false");
          if (op.order !== undefined && (typeof op.order !== "number" || !Number.isFinite(op.order))) throw new RelayError("bad_request", "order 要是数字");
          const text = op.text === undefined ? undefined : cleanText(op.text);
          if (have) {
            // Deleted stays deleted: an edit from a device that was away does not bring it back.
            if (have.deleted_at !== null) return;
            const done = op.done ?? Number(have.done) === 1;
            const doneAt = op.done === undefined ? have.done_at : op.done ? (Number(have.done) === 1 ? have.done_at : now) : null;
            rev += 1;
            this.db
              .prepare("UPDATE todo_items SET list = ?, text = ?, done = ?, ord = ?, done_at = ?, updated_at = ?, rev = ? WHERE account = ? AND id = ?")
              .run(op.list ?? String(have.list), text ?? String(have.text), done ? 1 : 0, op.order ?? Number(have.ord), (doneAt ?? null) as number | null, now, rev, account, op.id);
            return;
          }
          if (op.list === undefined || text === undefined) throw new RelayError("bad_request", "新的待办要有表和内容");
          if (live >= TODO_ITEMS_MAX) throw new RelayError("bad_request", `待办太多了（最多 ${TODO_ITEMS_MAX} 条），先清掉一些已完成的`);
          rev += 1;
          this.db
            .prepare("INSERT INTO todo_items (account, id, list, text, done, ord, created_at, updated_at, done_at, by_device, by_name, deleted_at, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)")
            .run(account, op.id, op.list, text, op.done ? 1 : 0, op.order ?? 0, now, now, op.done ? now : null, device.device, device.name, rev);
          live += 1;
        } catch (err) {
          if (!(err instanceof RelayError)) throw err;
          rejected.push({ index, message: err.message });
        }
      });
      // Deletion marks older than TODO_TOMBSTONE_DAYS go; a device last here before them gets everything next time.
      const old = now - TODO_TOMBSTONE_DAYS * DAY;
      const gone = this.db.prepare("SELECT MAX(rev) AS r FROM todo_items WHERE account = ? AND deleted_at IS NOT NULL AND deleted_at < ?").get(account, old) as Row;
      const purged = gone.r === null || gone.r === undefined ? null : Number(gone.r);
      if (purged !== null) this.db.prepare("DELETE FROM todo_items WHERE account = ? AND deleted_at IS NOT NULL AND deleted_at < ?").run(account, old);
      this.db
        .prepare("INSERT INTO todo_accounts (account, rev, purged_rev) VALUES (?, ?, ?) ON CONFLICT (account) DO UPDATE SET rev = excluded.rev, purged_rev = MAX(todo_accounts.purged_rev, excluded.purged_rev)")
        .run(account, rev, purged ?? 0);
      return { rev, rejected };
    });
  }
}
