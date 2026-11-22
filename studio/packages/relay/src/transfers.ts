import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { open, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DEVICE_ID_RE } from "./devices-protocol.js";
import { RelayError } from "./store.js";
import {
  TRANSFER_CHUNK,
  TRANSFER_DEVICE_DAYS,
  TRANSFER_KEEP_MS,
  TRANSFER_MAX_BYTES,
  TRANSFER_MAX_FILES,
  TRANSFER_MAX_TARGETS,
  TRANSFER_RECORD_DAYS,
  transferBytesText,
  transferPathProblem,
  type RelayDevice,
  type Transfer,
  type TransferFile,
  type TransferState,
  type TransferTarget,
  type TransferTargetState,
} from "./transfer-protocol.js";

// 传文件's records and content on the service (transfer-protocol.ts). In the relay's database: the devices that used the
// desktop client (each /ws connection with a device says so), the sends, their files (how much the service has of each)
// and their targets (account × device, each accepting or declining on its own). The content is one file per file of
// a send, `<dir>/<send id>/<index>`, written piece by piece at the offset the service is at — a broken upload goes on
// from there, also after the service restarts. Gone once every target saved it or declined, the sender cancelled, or
// a day passed (sweep); the record stays a week for both sides to see what became of it.

type Row = Record<string, unknown>;
const DAY = 24 * 60 * 60_000;
const SHA = /^[0-9a-f]{64}$/;
const NAME_MAX = 40;
/** What the service keeps free besides what the open sends still need (the Mac's disk has terabytes; 2026-11-23). */
export const TRANSFER_DISK_RESERVE = 5 * 1024 * 1024 * 1024;

export function checkTransferDevice(device: unknown): string {
  if (typeof device !== "string" || !DEVICE_ID_RE.test(device)) throw new RelayError("bad_request", "设备编号不对");
  return device;
}

export function cleanDeviceName(name: unknown): string {
  const n = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, NAME_MAX) : "";
  return n || "未命名设备";
}

const newId = () => `x_${randomBytes(8).toString("hex")}`;

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export interface TransferStoreOptions {
  db: DatabaseSync;
  /** Where the content goes; none = sends are refused. */
  dir?: string;
  now?: () => number;
  /** Free bytes on the disk of `dir` (tests give their own). */
  freeBytes?: (dir: string) => Promise<number>;
  reserveBytes?: number;
}

export class TransferStore {
  private readonly db: DatabaseSync;
  readonly dir: string | undefined;
  private readonly now: () => number;
  private readonly freeBytes: (dir: string) => Promise<number>;
  private readonly reserve: number;
  /** Pieces being written now, `<id>/<index>`: a second one for the same file at the same time is refused. */
  private readonly busy = new Set<string>();

  constructor(opts: TransferStoreOptions) {
    this.db = opts.db;
    this.dir = opts.dir;
    this.now = opts.now ?? Date.now;
    this.freeBytes = opts.freeBytes ?? (async (d) => {
      const s = await statfs(d);
      return Number(s.bavail) * Number(s.bsize);
    });
    this.reserve = opts.reserveBytes ?? TRANSFER_DISK_RESERVE;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transfer_devices (
        account TEXT NOT NULL, device TEXT NOT NULL, name TEXT NOT NULL, seen_at INTEGER NOT NULL,
        PRIMARY KEY (account, device)
      );
      CREATE TABLE IF NOT EXISTS transfers (
        id TEXT PRIMARY KEY, from_account TEXT NOT NULL, from_device TEXT NOT NULL, from_device_name TEXT NOT NULL,
        roots TEXT NOT NULL, dirs TEXT NOT NULL, total INTEGER NOT NULL, state TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS transfer_files (
        transfer_id TEXT NOT NULL, idx INTEGER NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL,
        received INTEGER NOT NULL DEFAULT 0, sha256 TEXT, done INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (transfer_id, idx)
      );
      CREATE TABLE IF NOT EXISTS transfer_targets (
        transfer_id TEXT NOT NULL, account TEXT NOT NULL, device TEXT NOT NULL, device_name TEXT NOT NULL,
        state TEXT NOT NULL, answered_at INTEGER, got INTEGER NOT NULL DEFAULT 0, done_at INTEGER,
        PRIMARY KEY (transfer_id, account, device)
      );
      CREATE INDEX IF NOT EXISTS transfer_targets_account ON transfer_targets(account);
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

  // ---- devices

  /** A device connected (its /ws): kept with its name, so others can send to it. */
  seenDevice(account: string, device: string, name: string): void {
    this.db
      .prepare("INSERT INTO transfer_devices (account, device, name, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (account, device) DO UPDATE SET name = excluded.name, seen_at = excluded.seen_at")
      .run(account, device, name, this.now());
  }

  /** The devices seen in the last TRANSFER_DEVICE_DAYS days, of accounts that are still there. */
  devices(isMember: (account: string) => boolean, online: (account: string, device: string) => boolean): RelayDevice[] {
    const since = this.now() - TRANSFER_DEVICE_DAYS * DAY;
    return (this.db.prepare("SELECT account, device, name, seen_at FROM transfer_devices WHERE seen_at >= ? ORDER BY account, seen_at DESC").all(since) as Row[])
      .filter((r) => isMember(String(r.account)))
      .map((r) => ({ account: String(r.account), id: String(r.device), name: String(r.name), online: online(String(r.account), String(r.device)), lastSeen: Number(r.seen_at) }));
  }

  // ---- reading

  private row(id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM transfers WHERE id = ?").get(id) as Row | undefined;
  }

  private view(r: Row): Transfer {
    const id = String(r.id);
    const files = (this.db.prepare("SELECT * FROM transfer_files WHERE transfer_id = ? ORDER BY idx").all(id) as Row[]).map(
      (f): TransferFile => ({ index: Number(f.idx), path: String(f.path), size: Number(f.size), received: Number(f.received), sha256: f.sha256 === null ? null : String(f.sha256), done: Number(f.done) === 1 }),
    );
    const targets = (this.db.prepare("SELECT * FROM transfer_targets WHERE transfer_id = ? ORDER BY rowid").all(id) as Row[]).map(
      (t): TransferTarget => ({
        account: String(t.account),
        device: String(t.device),
        deviceName: String(t.device_name),
        state: String(t.state) as TransferTargetState,
        answeredAt: t.answered_at === null ? null : Number(t.answered_at),
        got: Number(t.got),
        doneAt: t.done_at === null ? null : Number(t.done_at),
      }),
    );
    return {
      id,
      from: String(r.from_account),
      fromDevice: String(r.from_device),
      fromDeviceName: String(r.from_device_name),
      roots: JSON.parse(String(r.roots)) as string[],
      dirs: JSON.parse(String(r.dirs)) as string[],
      files,
      totalSize: Number(r.total),
      targets,
      state: String(r.state) as TransferState,
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
      endedAt: r.ended_at === null ? null : Number(r.ended_at),
    };
  }

  /** Any send by id, for the service's own use (who to tell). */
  peek(id: string): Transfer | null {
    const r = this.row(id);
    return r ? this.view(r) : null;
  }

  /** Who sees it: the sender and every target account. */
  people(t: Transfer): string[] {
    return [...new Set([t.from, ...t.targets.map((x) => x.account)])];
  }

  get(id: string, me: string): Transfer {
    const t = this.peek(id);
    if (!t || !this.people(t).includes(me)) throw new RelayError("not_found", "没有这个传送");
    return t;
  }

  /** My sends and the ones to me, newest first. */
  list(me: string): Transfer[] {
    const rows = this.db
      .prepare("SELECT * FROM transfers WHERE from_account = ? OR id IN (SELECT transfer_id FROM transfer_targets WHERE account = ?) ORDER BY created_at DESC LIMIT 300")
      .all(me, me) as Row[];
    return rows.map((r) => this.view(r));
  }

  /** Bytes the open sends still have to put on the disk. */
  outstanding(): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(f.size - f.received), 0) AS n FROM transfer_files f JOIN transfers t ON t.id = f.transfer_id WHERE t.state = 'open'").get() as Row;
    return Number(r.n);
  }

  // ---- making one

  async create(me: string, body: Record<string, unknown>, isMember: (account: string) => boolean): Promise<Transfer> {
    if (!this.dir) throw new RelayError("bad_request", "这个服务没有开文件存储，不能传文件");
    const device = checkTransferDevice(body.device);
    const deviceName = cleanDeviceName(body.deviceName);
    if (!Array.isArray(body.entries)) throw new RelayError("bad_request", "entries 必须是列表");
    const entries = body.entries as Array<{ path?: unknown; size?: unknown }>;
    const dirs = body.dirs === undefined || body.dirs === null ? [] : body.dirs;
    if (!Array.isArray(dirs)) throw new RelayError("bad_request", "dirs 必须是列表");
    if (!entries.length && !dirs.length) throw new RelayError("bad_request", "没有要发的文件");
    if (entries.length > TRANSFER_MAX_FILES || dirs.length > TRANSFER_MAX_FILES) throw new RelayError("bad_request", `文件太多（一次最多 ${TRANSFER_MAX_FILES} 个）：先打个压缩包再发`);
    // Windows does not tell names apart by case: two that differ only so would land on one file.
    const seen = new Set<string>();
    const files: Array<{ path: string; size: number }> = [];
    let total = 0;
    for (const e of entries) {
      const problem = transferPathProblem(e?.path);
      if (problem) throw new RelayError("bad_request", problem);
      const path = String(e.path);
      if (typeof e.size !== "number" || !Number.isSafeInteger(e.size) || e.size < 0) throw new RelayError("bad_request", `大小不对：${path}`);
      const key = path.toLowerCase();
      if (seen.has(key)) throw new RelayError("bad_request", `重复的文件：${path}`);
      seen.add(key);
      files.push({ path, size: e.size });
      total += e.size;
    }
    if (total > TRANSFER_MAX_BYTES) throw new RelayError("bad_request", `一次最多发 ${transferBytesText(TRANSFER_MAX_BYTES)}，这次是 ${transferBytesText(total)}`);
    const emptyDirs: string[] = [];
    for (const d of dirs as unknown[]) {
      const problem = transferPathProblem(d);
      if (problem) throw new RelayError("bad_request", problem);
      const key = String(d).toLowerCase();
      if (seen.has(key)) throw new RelayError("bad_request", `重复的名字：${String(d)}`);
      seen.add(key);
      emptyDirs.push(String(d));
    }
    // A file cannot also be a folder another path goes through.
    const filePaths = new Set(files.map((f) => f.path.toLowerCase()));
    for (const p of [...files.map((f) => f.path), ...emptyDirs]) {
      const parts = p.toLowerCase().split("/");
      for (let i = 1; i < parts.length; i++) if (filePaths.has(parts.slice(0, i).join("/"))) throw new RelayError("bad_request", `「${parts.slice(0, i).join("/")}」既是文件又是文件夹`);
    }
    const roots = [...new Set([...files.map((f) => f.path), ...emptyDirs].map((p) => p.split("/")[0]!))];

    if (!Array.isArray(body.targets) || !body.targets.length) throw new RelayError("bad_request", "选一台要发到的设备");
    if (body.targets.length > TRANSFER_MAX_TARGETS) throw new RelayError("bad_request", `一次最多发到 ${TRANSFER_MAX_TARGETS} 台设备`);
    const known = new Map((this.db.prepare("SELECT account, device, name FROM transfer_devices").all() as Row[]).map((r) => [`${String(r.account)}\n${String(r.device)}`, String(r.name)]));
    const targets: Array<{ account: string; device: string; name: string }> = [];
    for (const t of body.targets as Array<{ account?: unknown; device?: unknown }>) {
      const account = typeof t?.account === "string" ? t.account : "";
      if (!isMember(account)) throw new RelayError("bad_request", `没有这个人：${account}`);
      const dev = checkTransferDevice(t.device);
      if (account === me && dev === device) throw new RelayError("bad_request", "不能发给自己这台设备");
      const name = known.get(`${account}\n${dev}`);
      if (name === undefined) throw new RelayError("bad_request", `${account} 没有这台设备`);
      if (targets.some((x) => x.account === account && x.device === dev)) continue;
      targets.push({ account, device: dev, name });
    }

    mkdirSync(this.dir, { recursive: true });
    const free = await this.freeBytes(this.dir);
    if (free - this.outstanding() - total < this.reserve) throw new RelayError("conflict", `服务器的空间不够（还剩 ${transferBytesText(Math.max(0, free))}），过一阵再发，或者找管理员`);

    const id = newId();
    const now = this.now();
    this.tx(() => {
      this.db
        .prepare("INSERT INTO transfers (id, from_account, from_device, from_device_name, roots, dirs, total, state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)")
        .run(id, me, device, deviceName, JSON.stringify(roots), JSON.stringify(emptyDirs), total, now, now + TRANSFER_KEEP_MS);
      const addFile = this.db.prepare("INSERT INTO transfer_files (transfer_id, idx, path, size) VALUES (?, ?, ?, ?)");
      files.forEach((f, i) => addFile.run(id, i, f.path, f.size));
      const addTarget = this.db.prepare("INSERT INTO transfer_targets (transfer_id, account, device, device_name, state) VALUES (?, ?, ?, ?, 'pending')");
      for (const t of targets) addTarget.run(id, t.account, t.device, t.name);
    });
    mkdirSync(join(this.dir, id), { recursive: true });
    return this.get(id, me);
  }

  // ---- answering, cancelling, the end

  private openOrThrow(t: Transfer): void {
    if (t.state === "cancelled") throw new RelayError("conflict", "发送方已经取消了");
    if (t.state === "expired") throw new RelayError("conflict", "已经过期了（服务器只存 1 天）");
    if (t.state === "done") throw new RelayError("conflict", "这次传送已经结束了");
  }

  /** Accept or decline on one of my devices; a decline after accepting stops receiving there. */
  answer(me: string, id: string, deviceValue: unknown, accept: boolean): Transfer {
    const device = checkTransferDevice(deviceValue);
    const t = this.get(id, me);
    this.openOrThrow(t);
    const target = t.targets.find((x) => x.account === me && x.device === device);
    if (!target) throw new RelayError("forbidden", "这台设备不在收件的里面");
    if (target.state === "done" || target.state === "declined") throw new RelayError("conflict", target.state === "done" ? "已经收完了" : "已经拒绝了");
    if (accept && target.state === "accepted") return t;
    this.db.prepare("UPDATE transfer_targets SET state = ?, answered_at = ? WHERE transfer_id = ? AND account = ? AND device = ?").run(accept ? "accepted" : "declined", this.now(), id, me, device);
    this.settle(id);
    return this.get(id, me);
  }

  /** The receiving device says how far it is; `done`: everything saved and checked there. */
  progress(me: string, id: string, deviceValue: unknown, got: unknown, done: boolean): Transfer {
    const device = checkTransferDevice(deviceValue);
    const t = this.get(id, me);
    const target = t.targets.find((x) => x.account === me && x.device === device);
    if (!target) throw new RelayError("forbidden", "这台设备不在收件的里面");
    if (target.state !== "accepted") return t;
    const bytes = typeof got === "number" && Number.isFinite(got) ? Math.max(0, Math.min(Math.floor(got), t.totalSize)) : target.got;
    if (done) {
      if (t.files.some((f) => !f.done)) throw new RelayError("conflict", "还有文件没传到服务器，不能算收完");
      this.db.prepare("UPDATE transfer_targets SET state = 'done', got = ?, done_at = ? WHERE transfer_id = ? AND account = ? AND device = ?").run(t.totalSize, this.now(), id, me, device);
      this.settle(id);
    } else this.db.prepare("UPDATE transfer_targets SET got = ? WHERE transfer_id = ? AND account = ? AND device = ?").run(bytes, id, me, device);
    return this.get(id, me);
  }

  cancel(me: string, id: string): Transfer {
    const t = this.get(id, me);
    if (t.from !== me) throw new RelayError("forbidden", "只有发送的人能取消");
    if (t.state !== "open") return t;
    this.end(id, "cancelled");
    return this.get(id, me);
  }

  /** Every target saved it or declined: done, the content goes. */
  private settle(id: string): void {
    const t = this.peek(id);
    if (t?.state === "open" && t.targets.every((x) => x.state === "done" || x.state === "declined")) this.end(id, "done");
  }

  private end(id: string, state: Exclude<TransferState, "open">): void {
    this.db.prepare("UPDATE transfers SET state = ?, ended_at = ? WHERE id = ? AND state = 'open'").run(state, this.now(), id);
    this.dropContent(id);
  }

  private dropContent(id: string): void {
    if (this.dir && /^x_[0-9a-f]{16}$/.test(id)) rmSync(join(this.dir, id), { recursive: true, force: true });
  }

  /**
   * A day passed: open sends expire and their content goes; records ended more than a week ago are dropped; content
   * folders no open send owns (left by a crash) go too. The ids that changed, for the service to tell their people.
   */
  sweep(): Transfer[] {
    const now = this.now();
    const changed: Transfer[] = [];
    for (const r of this.db.prepare("SELECT id FROM transfers WHERE state = 'open' AND expires_at <= ?").all(now) as Row[]) {
      this.end(String(r.id), "expired");
      changed.push(this.peek(String(r.id))!);
    }
    const old = now - TRANSFER_RECORD_DAYS * DAY;
    for (const r of this.db.prepare("SELECT id FROM transfers WHERE state != 'open' AND ended_at <= ?").all(old) as Row[]) {
      const id = String(r.id);
      this.tx(() => {
        this.db.prepare("DELETE FROM transfer_files WHERE transfer_id = ?").run(id);
        this.db.prepare("DELETE FROM transfer_targets WHERE transfer_id = ?").run(id);
        this.db.prepare("DELETE FROM transfers WHERE id = ?").run(id);
      });
    }
    if (this.dir && existsSync(this.dir)) {
      const live = new Set((this.db.prepare("SELECT id FROM transfers WHERE state = 'open'").all() as Row[]).map((r) => String(r.id)));
      for (const name of readdirSync(this.dir)) if (!live.has(name)) this.dropContent(name);
    }
    return changed;
  }

  // ---- content

  private fileOf(t: Transfer, indexValue: unknown): TransferFile {
    const index = Number(indexValue);
    const f = Number.isInteger(index) ? t.files.find((x) => x.index === index) : undefined;
    if (!f) throw new RelayError("not_found", "这次传送里没有这个文件");
    return f;
  }

  private fileRow(id: string, indexValue: unknown): TransferFile {
    const index = Number(indexValue);
    const f = Number.isInteger(index) ? (this.db.prepare("SELECT * FROM transfer_files WHERE transfer_id = ? AND idx = ?").get(id, index) as Row | undefined) : undefined;
    if (!f) throw new RelayError("not_found", "这次传送里没有这个文件");
    return { index: Number(f.idx), path: String(f.path), size: Number(f.size), received: Number(f.received), sha256: f.sha256 === null ? null : String(f.sha256), done: Number(f.done) === 1 };
  }

  private contentPath(id: string, index: number): string {
    return join(this.dir!, id, String(index));
  }

  /**
   * A piece of a file from the sending device, at the offset the service is at (anything else is refused with where it
   * is, so the sender goes on from there). `sha256` is the whole file's, the same with every piece; once the file is
   * complete it is checked, and a file that does not match (changed while it was sent, or damaged) starts again.
   */
  async writePiece(me: string, id: string, indexValue: unknown, q: { device: unknown; offset: unknown; sha256: unknown }, data: Buffer): Promise<{ file: TransferFile; allDone: boolean }> {
    // A folder of thousands of small files is a piece per file: only the rows this piece needs, not the whole send.
    const r = this.row(id);
    if (!r || (String(r.from_account) !== me && !this.db.prepare("SELECT 1 FROM transfer_targets WHERE transfer_id = ? AND account = ?").get(id, me))) throw new RelayError("not_found", "没有这个传送");
    if (String(r.from_account) !== me) throw new RelayError("forbidden", "只有发送的人能上传");
    if (checkTransferDevice(q.device) !== String(r.from_device)) throw new RelayError("forbidden", "要从发出它的那台设备上传");
    this.openOrThrow({ state: String(r.state) as TransferState } as Transfer);
    if (!this.db.prepare("SELECT 1 FROM transfer_targets WHERE transfer_id = ? AND state = 'accepted'").get(id)) throw new RelayError("conflict", "还没有设备接收，先等对方确认");
    const f = this.fileRow(id, indexValue);
    const sha = typeof q.sha256 === "string" ? q.sha256.toLowerCase() : "";
    if (!SHA.test(sha)) throw new RelayError("bad_request", "sha256 要是 64 位十六进制");
    const offset = Number(q.offset);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RelayError("bad_request", "offset 不对");
    if (f.done) return { file: f, allDone: !this.db.prepare("SELECT 1 FROM transfer_files WHERE transfer_id = ? AND done = 0").get(id) };
    if (data.length > TRANSFER_CHUNK) throw new RelayError("bad_request", `一块最多 ${TRANSFER_CHUNK / 1024 / 1024} MB`);
    if (offset + data.length > f.size) throw new RelayError("bad_request", "超出了文件的大小");
    if (!data.length && f.size > 0) throw new RelayError("bad_request", "这一块是空的");
    const key = `${id}/${f.index}`;
    if (this.busy.has(key)) throw new RelayError("conflict", "这个文件正在上传");
    this.busy.add(key);
    try {
      const where = this.contentPath(id, f.index);
      const reset = () => {
        this.db.prepare("UPDATE transfer_files SET received = 0, sha256 = NULL WHERE transfer_id = ? AND idx = ?").run(id, f.index);
        rmSync(where, { force: true });
      };
      // The file changed on the sender's disk (another sha256 part way): from the start again.
      if (offset > 0 && f.sha256 && f.sha256 !== sha) {
        reset();
        throw new RelayError("conflict", `「${f.path}」在发送中被改动过，从头再传`);
      }
      if (offset !== f.received || (offset > 0 && !existsSync(where))) {
        if (offset > 0 && !existsSync(where)) reset();
        throw new RelayError("conflict", `位置对不上：服务器上有 ${offset > 0 && !existsSync(where) ? 0 : f.received} 字节`);
      }
      mkdirSync(join(this.dir!, id), { recursive: true });
      const fh = await open(where, offset === 0 ? "w" : "r+");
      try {
        if (data.length) await fh.write(data, 0, data.length, offset);
      } finally {
        await fh.close();
      }
      // Cancelled or expired while the piece was being written.
      const state = String(this.row(id)?.state ?? "cancelled") as TransferState;
      if (state !== "open") {
        this.dropContent(id);
        this.openOrThrow({ state } as Transfer);
      }
      const received = offset + data.length;
      this.db.prepare("UPDATE transfer_files SET received = ?, sha256 = ? WHERE transfer_id = ? AND idx = ?").run(received, sha, id, f.index);
      if (received === f.size) {
        const got = await sha256Of(where);
        if (got !== sha) {
          reset();
          throw new RelayError("conflict", `「${f.path}」校验不对（在发送中被改动过，或者传坏了），从头再传`);
        }
        this.db.prepare("UPDATE transfer_files SET done = 1 WHERE transfer_id = ? AND idx = ?").run(id, f.index);
      }
      const allDone = !this.db.prepare("SELECT 1 FROM transfer_files WHERE transfer_id = ? AND done = 0").get(id);
      return { file: this.fileRow(id, f.index), allDone };
    } finally {
      this.busy.delete(key);
    }
  }

  /** A complete file for one of my devices that accepted it. */
  download(me: string, id: string, indexValue: unknown, deviceValue: unknown): { path: string; size: number } {
    const device = checkTransferDevice(deviceValue);
    const t = this.get(id, me);
    this.openOrThrow(t);
    const target = t.targets.find((x) => x.account === me && x.device === device);
    if (!target || target.state !== "accepted") throw new RelayError("forbidden", "要先在这台设备上接收");
    const f = this.fileOf(t, indexValue);
    if (!f.done) throw new RelayError("conflict", "这个文件还没传完到服务器");
    const path = this.contentPath(id, f.index);
    if (!existsSync(path)) throw new RelayError("not_found", "文件的内容不在了");
    return { path, size: f.size };
  }
}
