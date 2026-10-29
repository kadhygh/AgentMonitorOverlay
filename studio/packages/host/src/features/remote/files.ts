import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { PREVIEW_IMAGE_TYPES, REMOTE_ATTACHMENTS_FOLDER, REMOTE_FILE_CHUNK, REMOTE_FILE_MAX_BYTES, REMOTE_KINDS, REMOTE_TASK_FOLDER, remoteFileKind, type Id, type RemoteFetchedFile, type RemoteFileAnswer, type RemoteFileAsk, type RemoteFileKind, type SessionItem } from "@amo-studio/protocol";
import type { DeviceRef } from "@amo-studio/relay";
import { HostError } from "../../core/shared.js";
import type { RemoteContext } from "./grants.js";

// 远程, step 3 (plans/remote-session.md, 2026-10-29): B looks at a remote task's HTML, Markdown and images. On A
// (`readRemoteFile`): the asked path is resolved, links and junctions first, and must land under the task's folder — or be
// one of the pictures sent in its conversation — be one of those kinds by its name and its first bytes, and not too big;
// it goes in pieces (`rt.file`), the whole file's sha256 with the first. On B (`RemoteFiles`): the file is kept in the
// data folder (remote-files/<task>/<where in the task's folder>), opened by the viewer from there, asked for again with
// what B has so an unchanged file is not sent twice, and thrown away with the copy. Paths between the two name the
// task's folder (任务文件夹/…) rather than A's own path, which carries the user's name (borrowed from Multica's idea).

/** What a file request may reach on A. */
export interface FileRoots {
  /** The task's folder (its project, or the common folder). */
  root: string;
  /** Studio's attachments folder… */
  attachments: string;
  /** …of which only these files: the pictures sent in the task's conversations (as their items name them; read when needed). */
  attached(): readonly string[];
}

const win = process.platform === "win32";
const key = (p: string) => (win ? p.toLowerCase() : p);
const inside = (p: string, folder: string) => {
  const a = key(p);
  const f = key(folder.endsWith(sep) ? folder : folder + sep);
  return a.startsWith(f);
};
const slash = (p: string) => p.replace(/\\/g, "/");

/** `任务文件夹/…` (either slash) → what follows it ("" for the folder itself); null when the path does not start so. */
function underTaskFolder(p: string): string | null {
  if (p === REMOTE_TASK_FOLDER) return "";
  return p.startsWith(`${REMOTE_TASK_FOLDER}/`) || p.startsWith(`${REMOTE_TASK_FOLDER}\\`) ? p.slice(REMOTE_TASK_FOLDER.length + 1) : null;
}

/** Where on A an asked path points, before links are resolved. */
export function resolveAsked(roots: FileRoots, pathIn: string, cwd?: string): string {
  let p = pathIn.trim();
  if (!p) throw new HostError("bad_request", "没有给出文件");
  if (/^file:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(p.replace(/^file:\/\/\/?/i, ""));
    } catch {
      throw new HostError("bad_request", "文件地址不对");
    }
  }
  const inTask = underTaskFolder(p);
  if (inTask !== null) return normalize(join(roots.root, inTask));
  if (p.startsWith(`${REMOTE_ATTACHMENTS_FOLDER}/`)) return normalize(join(roots.attachments, basename(p)));
  if (isAbsolute(p)) return normalize(p);
  let base = roots.root;
  if (cwd?.trim()) {
    const c = cwd.trim();
    const cwdInTask = underTaskFolder(c);
    base = cwdInTask !== null ? join(roots.root, cwdInTask) : isAbsolute(c) ? c : join(roots.root, c);
  }
  return normalize(join(base, p));
}

const real = (p: string): string | null => {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
};

/** Does the file's start look like its kind (an image's signature; text without NUL bytes)? */
export function looksLike(kind: RemoteFileKind, ext: string, head: Buffer): boolean {
  if (kind !== "image") return !head.includes(0);
  const b = head;
  switch (ext) {
    case ".png":
      return b.length >= 8 && b.readUInt32BE(0) === 0x89504e47;
    case ".jpg":
    case ".jpeg":
      return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case ".gif":
      return b.subarray(0, 4).toString("latin1") === "GIF8";
    case ".webp":
      return b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
    case ".bmp":
      return b.subarray(0, 2).toString("latin1") === "BM";
    case ".ico":
      return b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0;
    case ".svg":
      return !b.includes(0) && /<svg[\s>]/i.test(b.toString("utf8"));
    default:
      return false;
  }
}

const extOf = (p: string) => /\.[^./\\]+$/.exec(p)?.[0].toLowerCase() ?? "";
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * On A: one piece of a file a paired device asked for, after every check (HostError with a reason the person on B can
 * read: not in the task's folder, the kind, the size, missing). `device`: this computer's name, for those reasons.
 */
export async function readRemoteFile(roots: FileRoots, ask: RemoteFileAsk, device: string): Promise<RemoteFileAnswer> {
  if (typeof ask.path !== "string" || ask.path.length > 2000) throw new HostError("bad_request", "文件路径不对");
  const asked = resolveAsked(roots, ask.path, typeof ask.cwd === "string" ? ask.cwd : undefined);
  const where = real(asked);
  if (!where) throw new HostError("not_found", `${device} 上找不到这个文件：${slash(ask.path)}`);
  const root = real(roots.root);
  const attachments = real(roots.attachments);
  let rel: string;
  if (root && inside(where, root)) rel = slash(relative(root, where));
  else if (attachments && inside(where, attachments) && roots.attached().some((a) => key(real(a) ?? "") === key(where))) rel = `${REMOTE_ATTACHMENTS_FOLDER}/${basename(where)}`;
  else throw new HostError("read_only", "这个文件不在任务的文件夹里，不能远程查看（只能看任务文件夹和对话附件里的文件）");
  const ext = extOf(where);
  const kind = remoteFileKind(where);
  if (!kind) throw new HostError("bad_request", `远程任务暂时只能看 HTML、Markdown 和图片，这是 ${ext || "没有扩展名的"} 文件`);
  const info = await stat(where);
  if (info.isDirectory()) throw new HostError("bad_request", "这是一个文件夹，不是文件");
  if (info.size > REMOTE_FILE_MAX_BYTES) throw new HostError("bad_request", `文件太大（${mb(info.size)}），远程最多取 ${mb(REMOTE_FILE_MAX_BYTES)}`);
  const mtime = Math.floor(info.mtimeMs);
  const base = { rel, size: info.size, mtime, kind };
  const offset = Number.isSafeInteger(ask.offset) && ask.offset > 0 ? ask.offset : 0;
  if (offset > 0) {
    // A later piece: the file must still be the one the first piece came from.
    if (!ask.expect || ask.expect.size !== info.size || ask.expect.mtime !== mtime) throw new HostError("conflict", "文件在传的时候被改了，重新取一次");
    if (offset >= info.size) return { ...base, offset, data: "" };
    const fh = await open(where, "r");
    try {
      const buf = Buffer.alloc(Math.min(REMOTE_FILE_CHUNK, info.size - offset));
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      return { ...base, offset, data: buf.subarray(0, bytesRead).toString("base64") };
    } finally {
      await fh.close();
    }
  }
  if (ask.have && ask.have.size === info.size && ask.have.mtime === mtime && typeof ask.have.sha256 === "string") return { ...base, sha256: ask.have.sha256, unchanged: true };
  const data = await readFile(where);
  if (!looksLike(kind, ext, data.subarray(0, 4096))) throw new HostError("bad_request", kind === "image" ? `这个文件的内容不像 ${ext} 图片，不能远程查看` : "这个文件的内容像二进制文件，不是文本，不能远程查看");
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (ask.have && ask.have.sha256 === sha256 && ask.have.size === data.length) return { ...base, sha256, unchanged: true };
  return { ...base, sha256, offset: 0, data: data.subarray(0, REMOTE_FILE_CHUNK).toString("base64") };
}

/** On A: the pictures sent in a task's conversations (user messages and tool calls name them by path). */
export function attachedPaths(items: Iterable<SessionItem>): string[] {
  const out: string[] = [];
  for (const it of items) if ((it.type === "user" || it.type === "tool") && it.images) for (const im of it.images) if (im.path) out.push(im.path);
  return out;
}

/**
 * On A: an item as the paired device gets it — a command's working directory under the task's folder named by that
 * folder (任务文件夹\…) instead of A's own path. Absolute paths written in the text stay as they are (the device's
 * file requests resolve them here, and only inside the task's folder).
 */
export function itemForPeer<T extends SessionItem>(item: T, root: string | null): T {
  if (item.type !== "tool" || !root || !item.cwd) return item;
  const c = normalize(item.cwd);
  const r = normalize(root);
  if (key(c) === key(r)) return { ...item, cwd: REMOTE_TASK_FOLDER };
  if (inside(c, r)) return { ...item, cwd: `${REMOTE_TASK_FOLDER}\\${relative(r, c)}` };
  return item;
}

// ---- B: fetching and keeping ---------------------------------------------------------------------------------------

interface Kept {
  size: number;
  mtime: number;
  sha256: string;
  kind: RemoteFileKind;
}

interface Index {
  files: Record<string, Kept>;
  /** What was asked (cwd + path) → where it was in the task's folder: the copy is found again while A is away. */
  asked: Record<string, string>;
}

/** A `rel` from A made safe as a path under this computer's folder for the task: no climbing out, no drive, no odd names. */
export function safeRel(rel: string): string {
  const parts = slash(rel).split("/");
  if (!parts.length || parts.some((s) => !s || s === "." || s === ".." || /[<>:"|?*\0]/.test(s) || /[. ]$/.test(s))) throw new HostError("bad_request", `对方给的文件位置不对：${rel}`);
  return parts.join(sep);
}

type Ask = <T>(peer: DeviceRef, kind: string, body: unknown, timeoutMs?: number, offline?: string) => Promise<T>;

const FILE_MS = 60_000;
/** A dropped copy's folder, moved aside until it can be deleted (task ids never start so). */
const GONE_PREFIX = ".gone-";

export class RemoteFiles {
  /** Key → task: pages' images are served under /api/remote/files/<key>/… (an <img> sends no token). Per Host run. */
  private readonly keys = new Map<string, Id>();
  private readonly keyOf = new Map<Id, string>();
  /** The same file asked for twice at once is fetched once. */
  private readonly running = new Map<string, Promise<RemoteFetchedFile>>();

  constructor(
    private readonly ctx: RemoteContext,
    private readonly ask: Ask,
  ) {}

  private get store() {
    return this.ctx.host.store;
  }

  /** remote-files/ beside the database (a temporary folder for an in-memory store). */
  root(): string {
    const db = this.store.path;
    return db === ":memory:" ? join(tmpdir(), `amo-studio-remote-files-${process.pid}`) : join(dirname(db), "remote-files");
  }

  dirOf(taskId: Id): string {
    if (!/^[\w-]{1,80}$/.test(taskId)) throw new HostError("bad_request", "任务编号不对");
    return join(this.root(), taskId);
  }

  private indexFile(taskId: Id): string {
    return join(this.dirOf(taskId), ".amo-files.json");
  }

  private index(taskId: Id): Index {
    try {
      const v = JSON.parse(readFileSync(this.indexFile(taskId), "utf8")) as Index;
      return { files: v.files ?? {}, asked: v.asked ?? {} };
    } catch {
      return { files: {}, asked: {} };
    }
  }

  private saveIndex(taskId: Id, index: Index): void {
    mkdirSync(this.dirOf(taskId), { recursive: true });
    writeFileSync(this.indexFile(taskId), JSON.stringify(index));
  }

  /** The key a task's pages load its images with. */
  key(taskId: Id): string {
    let k = this.keyOf.get(taskId);
    if (!k) {
      k = randomBytes(18).toString("base64url");
      this.keyOf.set(taskId, k);
      this.keys.set(k, taskId);
    }
    return k;
  }

  /**
   * Everything kept of a task's files goes (its copy was archived or deleted). 2026-10-29, the user: 归档同时删除 — the
   * session lives on A, B only looks. So the folder is first moved aside (a rename goes through where deleting a file
   * held for a moment by a virus scan or a viewer does not), which takes it away at once; what is aside is deleted now,
   * tried again for a while, and swept when the Host starts.
   */
  drop(taskId: Id): void {
    const k = this.keyOf.get(taskId);
    if (k) this.keys.delete(k);
    this.keyOf.delete(taskId);
    const dir = this.dirOf(taskId);
    if (!existsSync(dir)) return;
    const aside = join(this.root(), `${GONE_PREFIX}${taskId}-${randomBytes(4).toString("hex")}`);
    try {
      renameSync(dir, aside);
    } catch {
      this.remove(dir, 8);
      return;
    }
    this.remove(aside, 8);
  }

  /** Removes a folder; a file held for a moment (a virus scan of what was just written, a viewer) is tried again later. */
  private remove(dir: string, tries: number): void {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      if (tries > 1) setTimeout(() => this.remove(dir, tries - 1), 2000).unref();
    }
  }

  /** Folders of copies that are gone (removal failed while the Host ran, or it stopped first): removed when it starts. */
  sweep(): void {
    let names: string[];
    try {
      names = readdirSync(this.root());
    } catch {
      return;
    }
    for (const n of names) if (n.startsWith(GONE_PREFIX) || !this.store.getTask(n)?.remote) this.remove(join(this.root(), n), 1);
  }

  /** The copy is still here (it may have been archived while a file was on its way). */
  private stillHere(taskId: Id): void {
    if (!this.store.getTask(taskId)?.remote) throw new HostError("not_found", "这个远程任务已经归档了");
  }

  /** A file of a remote task: fetched from A (or found unchanged there), kept here. `fetchId` names its progress events. */
  fetch(taskId: Id, path: string, cwd?: string, fetchId?: string): Promise<RemoteFetchedFile> {
    const k = `${taskId}\n${cwd ?? ""}\n${path}`;
    const had = this.running.get(k);
    if (had) return had;
    const run = this.fetchNow(taskId, path, cwd, fetchId).finally(() => this.running.delete(k));
    this.running.set(k, run);
    return run;
  }

  private progress(fetchId: string | undefined, received: number, total: number): void {
    if (fetchId) this.ctx.host.emit("event", { type: "remote.file", fetchId, received, total, seq: this.store.lastEventSeq() });
  }

  /** `again`: a second try that ignores the copy here (it was gone, or the file changed while it came). */
  private async fetchNow(taskId: Id, path: string, cwd: string | undefined, fetchId: string | undefined, again = false): Promise<RemoteFetchedFile> {
    const task = this.store.getTask(taskId);
    if (!task?.remote) throw new HostError("not_found", "这不是远程任务");
    const r = task.remote;
    const peer: DeviceRef = { account: r.account, device: r.device };
    const name = this.ctx.peer(peer)?.name ?? r.name;
    const index = this.index(taskId);
    const askedKey = `${cwd ?? ""}\n${path}`;
    const keptRel = index.asked[askedKey];
    const keptAt = keptRel ? join(this.dirOf(taskId), safeRel(keptRel)) : null;
    const kept = keptRel && keptAt && existsSync(keptAt) ? index.files[keptRel] : undefined;
    const fromKept = (stale?: string): RemoteFetchedFile => ({ path: keptAt!, rel: keptRel!, kind: kept!.kind, size: kept!.size, device: name, cached: true, ...(stale ? { stale } : {}), key: this.key(taskId) });
    if (r.state !== "active") {
      if (kept) return fromKept("授权已收回，显示的是上次取来的版本");
      throw new HostError("read_only", "授权已收回，不能再从那台电脑取文件");
    }
    const body = (offset: number, extra: Partial<RemoteFileAsk> = {}): RemoteFileAsk => ({ taskId, path, ...(cwd ? { cwd } : {}), offset, ...extra });
    let first: RemoteFileAnswer;
    try {
      first = await this.ask<RemoteFileAnswer>(peer, REMOTE_KINDS.file, body(0, kept && !again ? { have: { size: kept.size, mtime: kept.mtime, sha256: kept.sha256 } } : {}), FILE_MS, `${name} 离线，取不到文件（回来后再打开一次）`);
    } catch (err) {
      // Not reachable (offline, or no answer in time): the copy from last time, saying so.
      if (kept && err instanceof HostError && err.code === "runtime_error") return fromKept(`${name} 现在连不上，显示的是上次取来的版本`);
      throw err;
    }
    const rel = first.rel;
    const at = join(this.dirOf(taskId), safeRel(rel));
    const dir = this.dirOf(taskId);
    if (!resolve(at).startsWith(resolve(dir) + sep)) throw new HostError("bad_request", `对方给的文件位置不对：${rel}`);
    this.stillHere(taskId);
    if (first.unchanged && existsSync(at) && index.files[rel]) {
      index.asked[askedKey] = rel;
      index.files[rel] = { ...index.files[rel]!, mtime: first.mtime };
      this.saveIndex(taskId, index);
      this.progress(fetchId, first.size, first.size);
      return { path: at, rel, kind: first.kind, size: first.size, device: name, cached: true, key: this.key(taskId) };
    }
    if (first.unchanged) {
      // A said unchanged but the copy here is gone: ask again for all of it.
      if (again) throw new HostError("runtime_error", "取文件出了错，再打开一次");
      return this.fetchNow(taskId, path, cwd, fetchId, true);
    }
    if (first.size > REMOTE_FILE_MAX_BYTES) throw new HostError("bad_request", `文件太大（${mb(first.size)}），远程最多取 ${mb(REMOTE_FILE_MAX_BYTES)}`);
    const parts: Buffer[] = [Buffer.from(first.data ?? "", "base64")];
    let received = parts[0]!.length;
    this.progress(fetchId, received, first.size);
    while (received < first.size) {
      let piece: RemoteFileAnswer;
      try {
        piece = await this.ask<RemoteFileAnswer>(peer, REMOTE_KINDS.file, body(received, { expect: { size: first.size, mtime: first.mtime } }), FILE_MS, `${name} 离线了，文件没取完（回来后再打开一次）`);
      } catch (err) {
        // Changed on A while it came: once more from the start.
        if (err instanceof HostError && err.code === "conflict" && !again) return this.fetchNow(taskId, path, cwd, fetchId, true);
        throw err;
      }
      const buf = Buffer.from(piece.data ?? "", "base64");
      if (!buf.length) throw new HostError("runtime_error", "文件没取完：对方没有再发内容");
      parts.push(buf);
      received += buf.length;
      this.progress(fetchId, Math.min(received, first.size), first.size);
    }
    const data = Buffer.concat(parts);
    if (data.length !== first.size || createHash("sha256").update(data).digest("hex") !== first.sha256) throw new HostError("runtime_error", "取来的文件和对方的对不上（传的时候可能出了错），再打开一次");
    // Archived while it came: nothing is written back (that would bring the folder back).
    this.stillHere(taskId);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, data);
    const now = this.index(taskId);
    now.files[rel] = { size: first.size, mtime: first.mtime, sha256: first.sha256!, kind: first.kind };
    now.asked[askedKey] = rel;
    this.saveIndex(taskId, now);
    return { path: at, rel, kind: first.kind, size: first.size, device: name, cached: false, key: this.key(taskId) };
  }

  /**
   * GET /api/remote/files/<key>/<rel>: an image a remote page (HTML) loads, by its place in the task's folder — fetched
   * from A when it is not here or changed there, else the copy here.
   */
  async serve(k: string, rel: string): Promise<{ path: string; mime: string }> {
    const taskId = this.keys.get(k);
    if (!taskId) throw new HostError("not_found", "not found");
    const mime = PREVIEW_IMAGE_TYPES[extOf(rel)];
    if (!mime) throw new HostError("not_found", "only images are served here");
    const f = await this.fetch(taskId, `${REMOTE_TASK_FOLDER}/${slash(rel)}`);
    return { path: f.path, mime };
  }
}
