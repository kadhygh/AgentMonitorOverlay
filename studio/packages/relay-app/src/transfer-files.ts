import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { TRANSFER_CHUNK, TRANSFER_MAX_FILES, type PickedSend, type ReceiveState, type TransferEntry } from "@amo-studio/relay";

// 传文件 on this computer (2026-11-23, plans/relay-file-transfer.md 第 2 项): what the shell does on disk for the content,
// which drives the sends (relay-ui transfer.ts). Sending: what the person picked (files, folders, dropped ones) is
// listed and remembered under the relay's home, so a send goes on reading the same files after a restart — the content
// can read only those. Receiving: a send accepted into a folder gets its top-level names there (a name taken gets
// 「名字 (1)」), each file is written into `<name>.<id>.part` piece by piece, checked with sha256 and only then renamed to
// its name. Records: <home>/transfers/{pick,send,recv}-<id>.json.

const ID = /^[A-Za-z0-9_-]{1,40}$/;
interface Root {
  name: string;
  path: string;
  folder: boolean;
}
interface SendRecord {
  roots: Root[];
}
interface RecvRecord extends ReceiveState {
  /** Top-level names that are folders (made at prepare); the rest are files, named when they are saved. */
  folders: string[];
}

function checkId(id: unknown): string {
  if (typeof id !== "string" || !ID.test(id)) throw new Error("传送的编号不对");
  return id;
}

/** "a/b.txt" as a relative path with nothing that climbs out. */
function segments(path: unknown): string[] {
  if (typeof path !== "string" || !path) throw new Error("路径不对");
  const parts = path.split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || /[\\/:]/.test(p))) throw new Error(`路径不对：${path}`);
  return parts;
}

/** 「a.txt」 → 「a (1).txt」, a folder 「素材」 → 「素材 (1)」: the first free one in `dir`. */
export function freeName(dir: string, name: string, folder: boolean, taken: (candidate: string) => boolean = () => false): string {
  const ext = folder ? "" : extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? name : `${stem} (${n})${ext === name ? "" : ext}`;
    if (!existsSync(join(dir, candidate)) && !taken(candidate.toLowerCase())) return candidate;
  }
}

export class TransferFiles {
  private readonly dir: string;

  constructor(home: string) {
    this.dir = join(home, "transfers");
  }

  private file(kind: "pick" | "send" | "recv", id: string): string {
    return join(this.dir, `${kind}-${checkId(id)}.json`);
  }

  private read<T>(kind: "pick" | "send" | "recv", id: string): T | null {
    try {
      return JSON.parse(readFileSync(this.file(kind, id), "utf8")) as T;
    } catch {
      return null;
    }
  }

  private write(kind: "pick" | "send" | "recv", id: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const file = this.file(kind, id);
    writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 1));
    renameSync(`${file}.tmp`, file);
  }

  // ---- sending

  /**
   * What `paths` hold, as a send lists it (with `addTo`, added to that pick). Links and what is neither file nor folder
   * are left out, and a name already picked from somewhere else (said in `skipped`).
   */
  async pick(paths: string[], addTo?: string | null): Promise<PickedSend> {
    const token = addTo ? checkId(addTo) : `p_${randomBytes(8).toString("hex")}`;
    const roots = (addTo ? this.read<SendRecord>("pick", token)?.roots : null) ?? [];
    const skipped: string[] = [];
    for (const p of paths) {
      const path = resolve(p);
      const name = basename(path);
      let s;
      try {
        s = statSync(path);
      } catch {
        skipped.push(`${name}（读不到）`);
        continue;
      }
      if (!s.isFile() && !s.isDirectory()) {
        skipped.push(`${name}（不是文件或文件夹）`);
        continue;
      }
      const same = roots.find((r) => r.name.toLowerCase() === name.toLowerCase());
      if (same) {
        if (same.path !== path) skipped.push(`${name}（和已选的重名）`);
        continue;
      }
      roots.push({ name, path, folder: s.isDirectory() });
    }
    this.write("pick", token, { roots } satisfies SendRecord);
    return { pick: token, ...(await this.list(roots)), skipped };
  }

  private async list(roots: Root[]): Promise<Omit<PickedSend, "pick" | "skipped">> {
    const entries: TransferEntry[] = [];
    const dirs: string[] = [];
    const walk = async (abs: string, rel: string): Promise<void> => {
      const items = await readdir(abs, { withFileTypes: true });
      let any = false;
      for (const d of items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (entries.length > TRANSFER_MAX_FILES) return;
        const r = `${rel}/${d.name}`;
        if (d.isDirectory()) {
          any = true;
          await walk(join(abs, d.name), r);
        } else if (d.isFile()) {
          any = true;
          entries.push({ path: r, size: (await stat(join(abs, d.name))).size });
        }
      }
      if (!any) dirs.push(rel);
    };
    for (const r of roots) {
      if (r.folder) await walk(r.path, r.name);
      else entries.push({ path: r.name, size: statSync(r.path).size });
    }
    return { roots: roots.map((r) => ({ name: r.name, folder: r.folder })), entries, dirs, totalSize: entries.reduce((n, e) => n + e.size, 0) };
  }

  /** The pick became send `id` (only the `keep` top-level names of it, when given): its files stay readable for it. */
  bind(pick: string, id: string, keep?: string[]): void {
    const rec = this.read<SendRecord>("pick", pick);
    if (!rec) throw new Error("选的文件找不到了，重新选一次");
    const roots = keep ? rec.roots.filter((r) => keep.includes(r.name)) : rec.roots;
    this.write("send", id, { roots } satisfies SendRecord);
    rmSync(this.file("pick", pick), { force: true });
  }

  private source(id: string, path: string): string {
    const rec = this.read<SendRecord>("send", id);
    if (!rec) throw new Error("这台电脑上没有这次发送的记录");
    const [top, ...rest] = segments(path);
    const root = rec.roots.find((r) => r.name === top);
    if (!root || (!root.folder && rest.length)) throw new Error(`不在这次发送里：${path}`);
    const abs = resolve(root.path, ...rest);
    if (root.folder && !abs.startsWith(resolve(root.path) + sep)) throw new Error(`不在这次发送里：${path}`);
    return abs;
  }

  /** Bytes offset..offset+length of a file being sent (fewer at its end). */
  async readPiece(id: string, path: string, offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > TRANSFER_CHUNK) throw new Error("读的范围不对");
    const fh = await open(this.source(id, path), "r");
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return bytesRead === length ? buf : buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  /** sha256 and size of a file being sent, as it is now. */
  async sourceHash(id: string, path: string): Promise<{ sha256: string; size: number }> {
    const file = this.source(id, path);
    return { sha256: await sha256Of(file), size: statSync(file).size };
  }

  forgetSend(id: string): void {
    rmSync(this.file("send", id), { force: true });
  }

  // ---- receiving

  /**
   * Accepted into `dir`: the folders among the top-level names get a free name there now (so nothing else takes it
   * while the send goes on), and the empty folders are made. Again for the same send: what was set the first time.
   */
  prepare(id: string, dir: string, plan: { roots: string[]; folders: string[]; dirs: string[] }): ReceiveState {
    const had = this.read<RecvRecord>("recv", id);
    if (had) return { dir: had.dir, names: had.names, done: had.done };
    const base = resolve(dir);
    mkdirSync(base, { recursive: true });
    const names: Record<string, string> = {};
    const folders = plan.folders.filter((f) => plan.roots.includes(f));
    for (const f of folders) {
      segments(f);
      names[f] = freeName(base, f, true);
      mkdirSync(join(base, names[f]!), { recursive: true });
    }
    const rec: RecvRecord = { dir: base, names, done: [], folders };
    this.write("recv", id, rec);
    for (const d of plan.dirs) mkdirSync(this.target(rec, d), { recursive: true });
    return { dir: base, names, done: [] };
  }

  received(id: string): ReceiveState | null {
    const r = this.read<RecvRecord>("recv", id);
    return r ? { dir: r.dir, names: r.names, done: r.done } : null;
  }

  /** Where a path of the send goes; a top-level file not saved yet has no name: its own (the part is named after it). */
  private target(rec: RecvRecord, path: string): string {
    const [top, ...rest] = segments(path);
    const folder = rec.folders.includes(top!);
    if (!folder && rest.length) throw new Error(`路径不对：${path}`);
    const abs = folder ? resolve(rec.dir, rec.names[top!]!, ...rest) : resolve(rec.dir, rec.names[top!] ?? top!);
    if (!abs.startsWith(rec.dir + sep)) throw new Error(`路径不对：${path}`);
    return abs;
  }

  private part(id: string, rec: RecvRecord, path: string): string {
    const t = this.target(rec, path);
    return join(dirname(t), `${basename(t)}.${id.slice(-6)}.part`);
  }

  private rec(id: string): RecvRecord {
    const r = this.read<RecvRecord>("recv", id);
    if (!r) throw new Error("这台电脑上没有这次接收的记录");
    return r;
  }

  /** How much of a file is here: its part's size; -1 when it is saved already. */
  partSize(id: string, path: string): number {
    const rec = this.rec(id);
    if (rec.done.includes(path)) return -1;
    try {
      return statSync(this.part(id, rec, path)).size;
    } catch {
      return 0;
    }
  }

  /** A piece at the end of the part (offset 0 starts it again). */
  async writePiece(id: string, path: string, offset: number, data: Uint8Array): Promise<void> {
    const rec = this.rec(id);
    if (rec.done.includes(path)) return;
    const part = this.part(id, rec, path);
    const have = offset === 0 ? 0 : this.partSize(id, path);
    if (offset !== have) throw new Error(`位置对不上：本机已有 ${have} 字节`);
    mkdirSync(dirname(part), { recursive: true });
    const fh = await open(part, offset === 0 ? "w" : "r+");
    try {
      if (data.length) await fh.write(data, 0, data.length, offset);
    } finally {
      await fh.close();
    }
  }

  /**
   * The part is complete: saved under its name when it matches `sha256` (a top-level file gets a free name now), else
   * removed (false). The saved path.
   */
  async finish(id: string, path: string, sha256: string): Promise<string | false> {
    const rec = this.rec(id);
    if (rec.done.includes(path)) return this.target(rec, path);
    const part = this.part(id, rec, path);
    if (!existsSync(part)) await this.writePiece(id, path, 0, new Uint8Array(0));
    if ((await sha256Of(part)) !== sha256.toLowerCase()) {
      rmSync(part, { force: true });
      return false;
    }
    const [top, ...rest] = segments(path);
    let final = this.target(rec, path);
    if (!rest.length && !rec.folders.includes(top!)) {
      const taken = new Set(Object.values(rec.names).map((n) => n.toLowerCase()));
      rec.names[top!] = freeName(rec.dir, top!, false, (c) => taken.has(c) && c !== top!.toLowerCase());
      final = join(rec.dir, rec.names[top!]!);
    } else if (existsSync(final)) final = join(dirname(final), freeName(dirname(final), basename(final), false));
    renameSync(part, final);
    rec.done.push(path);
    this.write("recv", id, rec);
    return final;
  }

  /** The send ended before everything came: its parts go (what was saved stays), and its record. */
  discard(id: string): void {
    const rec = this.read<RecvRecord>("recv", id);
    if (!rec) return;
    const suffix = `.${id.slice(-6)}.part`;
    const sweep = (abs: string) => {
      let items;
      try {
        items = readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of items) {
        if (d.isDirectory()) sweep(join(abs, d.name));
        else if (d.name.endsWith(suffix)) rmSync(join(abs, d.name), { force: true });
      }
    };
    for (const f of rec.folders) sweep(join(rec.dir, rec.names[f]!));
    for (const d of readdirSync(rec.dir, { withFileTypes: true })) if (d.isFile() && d.name.endsWith(suffix)) rmSync(join(rec.dir, d.name), { force: true });
    this.forgetReceive(id);
  }

  forgetReceive(id: string): void {
    rmSync(this.file("recv", id), { force: true });
  }

  /** What to show for 打开文件夹: the one thing received (selected in its folder), or the folder it went into. */
  shown(id: string): { item: string | null; dir: string } | null {
    const rec = this.read<RecvRecord>("recv", id);
    if (!rec) return null;
    const names = Object.values(rec.names);
    return { item: names.length === 1 ? join(rec.dir, names[0]!) : null, dir: rec.dir };
  }

  /** Records of sends no longer listed by the service (ended a week ago): gone. Picks never sent go after a day. */
  prune(keep: string[]): void {
    let items: string[];
    try {
      items = readdirSync(this.dir);
    } catch {
      return;
    }
    const live = new Set(keep);
    for (const name of items) {
      const m = /^(pick|send|recv)-(.+)\.json$/.exec(name);
      if (!m) continue;
      if (m[1] === "pick") {
        if (Date.now() - statSync(join(this.dir, name)).mtimeMs > 24 * 3600_000) rmSync(join(this.dir, name), { force: true });
      } else if (!live.has(m[2]!)) rmSync(join(this.dir, name), { force: true });
    }
  }
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
