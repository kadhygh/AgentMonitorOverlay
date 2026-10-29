import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, closeSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ATTACHMENT_MIMES, REMOTE_FILE_CHUNK, REMOTE_KINDS, REMOTE_UPLOAD_MAX_BYTES, REMOTE_UPLOAD_TOTAL_BYTES, splitFileRefItems, withFileRefs, type Attachment, type FileRefItem, type Id, type RemoteTaskRequest, type RemoteUpload } from "@amo-studio/protocol";
import type { DeviceRef } from "@amo-studio/relay";
import { HostError } from "../../core/shared.js";
import type { RemoteContext } from "./grants.js";

// B sends A pictures and files (2026-10-29 evening, the user: 「B 给 A 派任务，允许加附件」). With a message in a
// remote task, a new session there, or a task B creates on A, B's Host sends each file in pieces first (rt.upload), then
// the command naming them. A keeps them as its own attachments: pictures the model sees (as a picture pasted on A),
// other files in its attachments folder, listed in the message's 引用文件 block with A's path — B's own paths mean
// nothing on A. A task that waits for a yes on A (安全) keeps them with the request until it is allowed or refused.

const UPLOAD_ID = /^up_[\w-]{6,60}$/;
/** Pieces nobody named in a command go after this long. */
const STALE_MS = 60 * 60_000;
const PIECE_MS = 60_000;

/** What A made of the files a command named. */
export interface Claimed {
  images: Attachment[];
  /** Other files (and pictures a session cannot take, DSH's), with the range and note B marked. */
  files: Array<FileRefItem & { id: Id; name: string }>;
}

export const NOTHING_CLAIMED: Claimed = { images: [], files: [] };

/** The message as A's session gets it: B's text, then the files in the 引用文件 block with A's paths. */
export const claimedText = (text: string, c: Claimed): string => withFileRefs(text, c.files.map(({ path, startLine, endLine, note }) => ({ path, startLine: startLine ?? null, endLine: endLine ?? null, ...(note ? { note } : {}) })));

/** As a held request keeps them (RemoteTaskRequest.attached). */
export const heldOf = (c: Claimed): NonNullable<RemoteTaskRequest["attached"]> => ({ images: c.images.map((a) => ({ id: a.id, name: a.name })), files: c.files });

/** A held request's files, as claimed again when it is allowed. */
export function claimedOf(held: RemoteTaskRequest["attached"], get: (id: Id) => Attachment): Claimed {
  if (!held) return NOTHING_CLAIMED;
  const images: Attachment[] = [];
  for (const i of held.images) {
    try {
      images.push(get(i.id));
    } catch {
      // Gone from the attachments folder by hand: the rest still goes.
    }
  }
  return { images, files: held.files.filter((f) => existsSync(f.path)) };
}

/** On A: the pieces paired devices send, and turning them into attachments when a command names them. */
export class UploadInbox {
  constructor(private readonly ctx: RemoteContext) {}

  private dir(): string {
    return join(dirname(this.ctx.host.attachments.dir()), "remote-uploads");
  }

  /** One device's upload, by a name that is safe on disk whatever the account and device are called. */
  private file(from: DeviceRef, uploadId: string): string {
    const who = createHash("sha256").update(`${from.account}\n${from.device}`).digest("hex").slice(0, 16);
    return join(this.dir(), `${who}-${uploadId}`);
  }

  private sweep(): void {
    const dir = this.dir();
    if (!existsSync(dir)) return;
    const now = Date.now();
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      try {
        if (now - statSync(p).mtimeMs > STALE_MS) rmSync(p, { force: true });
      } catch {
        // Taken meanwhile.
      }
    }
  }

  /** rt.upload: a piece, in order (offset = what came so far). The last piece makes it whole (`.done`). */
  receive(from: DeviceRef, body: Record<string, unknown>): { received: number } {
    if (!this.ctx.peer(from, "owner")) throw new HostError("bad_request", `只有 ${this.ctx.deviceName()} 允许配对的设备才能传文件过来`);
    const uploadId = typeof body.uploadId === "string" && UPLOAD_ID.test(body.uploadId) ? body.uploadId : null;
    if (!uploadId) throw new HostError("bad_request", "文件的编号不对");
    const size = typeof body.size === "number" && Number.isInteger(body.size) && body.size >= 0 ? body.size : -1;
    if (size < 0) throw new HostError("bad_request", "文件大小不对");
    if (size > REMOTE_UPLOAD_MAX_BYTES) throw new HostError("bad_request", `文件太大（最多 ${REMOTE_UPLOAD_MAX_BYTES / 1024 / 1024} MB）`);
    const offset = typeof body.offset === "number" && Number.isInteger(body.offset) ? body.offset : -1;
    const data = typeof body.data === "string" ? Buffer.from(body.data, "base64") : null;
    if (!data || data.length > REMOTE_FILE_CHUNK) throw new HostError("bad_request", "这一块数据不对");
    const part = `${this.file(from, uploadId)}.part`;
    mkdirSync(this.dir(), { recursive: true });
    if (offset === 0) {
      this.sweep();
      writeFileSync(part, data);
    } else {
      const had = existsSync(part) ? statSync(part).size : -1;
      // The same piece again (B asked again after a lost answer): already here.
      if (had === offset + data.length) return { received: had };
      if (had !== offset) throw new HostError("conflict", "文件的块接不上（可能中途断过），重新发一次");
      appendFileSync(part, data);
    }
    const received = statSync(part).size;
    if (received > size) throw new HostError("bad_request", "文件比说好的大");
    if (received === size) renameSync(part, `${this.file(from, uploadId)}.done`);
    return { received };
  }

  /**
   * The files a command names, made attachments of this computer's: pictures (unless `noImages`: a DSH session takes
   * none) as pictures, the rest as files. Each upload is used once; an unknown or unfinished one is refused, and what
   * was made before it is removed again.
   */
  claim(from: DeviceRef, uploads: unknown, opts: { noImages?: boolean } = {}): Claimed {
    if (uploads === undefined || uploads === null) return NOTHING_CLAIMED;
    if (!Array.isArray(uploads)) throw new HostError("bad_request", "uploads 要是文件的列表");
    const host = this.ctx.host;
    const out: Claimed = { images: [], files: [] };
    let total = 0;
    try {
      for (const raw of uploads as RemoteUpload[]) {
        const u = raw && typeof raw === "object" ? raw : ({} as RemoteUpload);
        if (typeof u.uploadId !== "string" || !UPLOAD_ID.test(u.uploadId)) throw new HostError("bad_request", "文件的编号不对");
        const done = `${this.file(from, u.uploadId)}.done`;
        if (!existsSync(done)) throw new HostError("bad_request", "有个文件没有传完整，重新发一次");
        const data = readFileSync(done);
        total += data.length;
        if (total > REMOTE_UPLOAD_TOTAL_BYTES) throw new HostError("bad_request", `一次传的文件太多（合计最多 ${REMOTE_UPLOAD_TOTAL_BYTES / 1024 / 1024} MB）`);
        const name = typeof u.name === "string" && basename(u.name).trim() ? basename(u.name).trim() : "file";
        const mime = typeof u.mime === "string" ? u.mime : "";
        if (mime && !opts.noImages && (ATTACHMENT_MIMES as readonly string[]).includes(mime)) out.images.push(host.attachments.save(data, { name, mime }));
        else {
          const a = host.attachments.saveFile(data, name);
          out.files.push({ id: a.id, name: a.name, path: a.path, ...(typeof u.startLine === "number" ? { startLine: u.startLine, endLine: typeof u.endLine === "number" ? u.endLine : null } : {}), ...(typeof u.note === "string" && u.note.trim() ? { note: u.note.trim() } : {}) });
        }
        rmSync(done, { force: true });
      }
    } catch (err) {
      this.drop(out);
      throw err;
    }
    return out;
  }

  /** Removes what was claimed (a request refused or taken back, a command that failed after claiming). */
  drop(c: Claimed | RemoteTaskRequest["attached"] | undefined): void {
    if (!c) return;
    for (const i of c.images) this.ctx.host.attachments.remove(i.id);
    for (const f of c.files) this.ctx.host.attachments.remove(f.id);
  }
}

type Ask = <T>(peer: DeviceRef, kind: string, body: unknown, timeoutMs?: number, offline?: string) => Promise<T>;

/**
 * On B: the files a message (its 引用文件 block, B's paths) and its pictures carry, sent to A in pieces before the
 * command. Returns the text without the block — A writes it again with its own paths — and the uploads to name.
 */
export async function sendAlong(ask: Ask, peer: DeviceRef, name: string, text: string, images: readonly Attachment[]): Promise<{ text: string; uploads: RemoteUpload[] }> {
  const { text: rest, refs } = splitFileRefItems(text);
  if (!refs.length && !images.length) return { text, uploads: [] };
  const items: Array<{ path: string; name: string; mime?: string; ref?: FileRefItem }> = [
    ...images.map((a) => ({ path: a.path, name: a.name, mime: a.mime })),
    ...refs.map((r) => ({ path: r.path, name: basename(r.path), ref: r })),
  ];
  let total = 0;
  for (const it of items) {
    let st;
    try {
      st = statSync(it.path);
    } catch {
      throw new HostError("bad_request", `找不到「${it.name}」（${it.path}），没有发出去`);
    }
    if (st.isDirectory()) throw new HostError("bad_request", `「${it.name}」是文件夹：远程任务只能传文件，可以先打包成 zip 再发`);
    if (st.size > REMOTE_UPLOAD_MAX_BYTES) throw new HostError("bad_request", `「${it.name}」太大（${(st.size / 1024 / 1024).toFixed(1)} MB），远程任务每个文件最多 ${REMOTE_UPLOAD_MAX_BYTES / 1024 / 1024} MB`);
    total += st.size;
  }
  if (total > REMOTE_UPLOAD_TOTAL_BYTES) throw new HostError("bad_request", `这次的文件合计 ${(total / 1024 / 1024).toFixed(1)} MB，远程任务一次最多 ${REMOTE_UPLOAD_TOTAL_BYTES / 1024 / 1024} MB`);
  const uploads: RemoteUpload[] = [];
  for (const it of items) {
    const uploadId = `up_${randomBytes(9).toString("base64url")}`;
    const size = statSync(it.path).size;
    const fd = openSync(it.path, "r");
    try {
      let offset = 0;
      do {
        const buf = Buffer.alloc(Math.min(REMOTE_FILE_CHUNK, size - offset));
        const n = buf.length ? readSync(fd, buf, 0, buf.length, offset) : 0;
        await ask(peer, REMOTE_KINDS.upload, { uploadId, name: it.name, size, offset, data: buf.subarray(0, n).toString("base64") }, PIECE_MS, `${name} 离线，文件没传过去`);
        offset += n;
        if (!n && offset < size) throw new HostError("runtime_error", `读「${it.name}」时出错了`);
      } while (offset < size);
    } finally {
      closeSync(fd);
    }
    uploads.push({ uploadId, name: it.name, ...(it.mime ? { mime: it.mime } : {}), ...(it.ref?.startLine ? { startLine: it.ref.startLine, endLine: it.ref.endLine ?? null } : {}), ...(it.ref?.note ? { note: it.ref.note } : {}) });
  }
  return { text: rest, uploads };
}
