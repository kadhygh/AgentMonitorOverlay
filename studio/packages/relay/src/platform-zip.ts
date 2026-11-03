import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { crc32 } from "node:zlib";

// A version's whole program as one zip (2026-11-03, the user: when the platform cannot update itself file by file, its
// 更新 page downloads the whole package and installs from that; the download page's zip comes from here too, so it is
// never older than what was published). Made from the manifest and the objects on the fly, nothing stored:
//   - an object kept gzipped (most are, platform.ts) goes in as it is: a gzip member is a deflate stream with a header
//     and the CRC-32 and size of what it unpacks to — what a zip entry (method 8) needs, so nothing is packed again;
//   - an object kept as it is (images, fonts: packing them was no use) is stored (method 0), its CRC-32 read once.
// The layout (every header, where each object's bytes start) is worked out before anything is sent, so the length is
// known and a broken download can go on with Range (the same version gives the same bytes; the ETag says which).
// Plain zip, no zip64: a tool is a few hundred MB in a few thousand files; a bigger one is refused, not cut.

export interface ZipFileEntry {
  /** As in the manifest: `resources/app/package.json`. */
  path: string;
  size: number;
  sha256: string;
}

/** Where an object is kept: the .gz or the file as it is (platform.ts objectFile). */
export interface StoredObject {
  file: string;
  size: number;
  gzip: boolean;
}

type Segment = { kind: "bytes"; data: Buffer } | { kind: "file"; file: string; start: number; length: number };

export interface ZipLayout {
  size: number;
  etag: string;
  segments: Segment[];
}

interface EntryData {
  method: 0 | 8;
  crc: number;
  start: number;
  length: number;
}

const LIMIT = 0xffffffff;

/** What a gzip member holds: where its deflate stream starts and ends, and the CRC-32 and size (mod 2^32) it unpacks to. */
export async function gzipMember(file: string): Promise<{ start: number; length: number; crc: number; size: number }> {
  const handle = await open(file, "r");
  try {
    const total = (await handle.stat()).size;
    const head = Buffer.alloc(Math.min(total, 64 * 1024));
    await handle.read(head, 0, head.length, 0);
    if (total < 18 || head[0] !== 0x1f || head[1] !== 0x8b || head[2] !== 8) throw new Error("不是 gzip（deflate）文件");
    const flags = head[3]!;
    let at = 10;
    if (flags & 4) at += 2 + head.readUInt16LE(at);
    for (const bit of [8, 16]) {
      if (!(flags & bit)) continue;
      const zero = head.indexOf(0, at);
      if (zero < 0) throw new Error("gzip 头太长");
      at = zero + 1;
    }
    if (flags & 2) at += 2;
    const tail = Buffer.alloc(8);
    await handle.read(tail, 0, 8, total - 8);
    if (at > total - 8) throw new Error("gzip 文件不完整");
    return { start: at, length: total - 8 - at, crc: tail.readUInt32LE(0), size: tail.readUInt32LE(4) };
  } finally {
    await handle.close();
  }
}

async function fileCrc(file: string): Promise<number> {
  let c = 0;
  for await (const chunk of createReadStream(file)) c = crc32(chunk as Buffer, c);
  return c >>> 0;
}

/** DOS date and time of a moment (UTC; a zip has no time zone), 1980 at the earliest. */
function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(Number.isFinite(ms) && ms > 315532800000 ? ms : 315532800000);
  return { time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2), date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() };
}

export class ZipMaker {
  /** Per kept object (its file and size, so a swap by platform-compress is seen): how it goes into a zip. */
  private readonly entries = new Map<string, EntryData>();
  private readonly layouts = new Map<string, ZipLayout>();

  constructor(private readonly kept = 4) {}

  private async entry(sha256: string, size: number, obj: StoredObject): Promise<EntryData> {
    const key = `${obj.file}|${obj.size}`;
    const known = this.entries.get(key);
    if (known) return known;
    let made: EntryData;
    if (obj.gzip) {
      const m = await gzipMember(obj.file);
      if (m.size !== size % 2 ** 32) throw new Error(`服务器上 ${sha256.slice(0, 12)} 的 .gz 解开后大小不对`);
      made = { method: 8, crc: m.crc, start: m.start, length: m.length };
    } else {
      if (obj.size !== size) throw new Error(`服务器上 ${sha256.slice(0, 12)} 的大小和清单不一样`);
      made = { method: 0, crc: await fileCrc(obj.file), start: 0, length: size };
    }
    this.entries.set(key, made);
    // The objects of a few tools' versions: a few tens of thousands at most.
    while (this.entries.size > 200_000) this.entries.delete(this.entries.keys().next().value!);
    return made;
  }

  /**
   * The zip of `files` under the folder `root` (`AMO Platform/`), the files dated `builtAt`. `key` names the manifest
   * as it is (its file, size and time): the layout is kept for the last few asked for. `find` says where an object is
   * kept (null: not there, the zip cannot be made).
   */
  async layout(key: string, root: string, builtAt: number, files: ZipFileEntry[], find: (sha256: string) => Promise<StoredObject | null>): Promise<ZipLayout> {
    const kept = this.layouts.get(key);
    if (kept) {
      this.layouts.delete(key);
      this.layouts.set(key, kept);
      return kept;
    }
    if (files.length > 0xfffe) throw new Error("文件太多，打不成一个 zip");
    const { time, date } = dosTime(builtAt);
    const segments: Segment[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    const prefix = root ? `${root.replace(/\/+$/, "")}/` : "";
    const add = (name: string, e: EntryData, size: number, file: string | null) => {
      const nameBuf = Buffer.from(name, "utf8");
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // names in UTF-8
      local.writeUInt16LE(e.method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(e.crc >>> 0, 14);
      local.writeUInt32LE(e.length, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      const head = Buffer.concat([local, nameBuf]);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0x0800, 8);
      cd.writeUInt16LE(e.method, 10);
      cd.writeUInt16LE(time, 12);
      cd.writeUInt16LE(date, 14);
      cd.writeUInt32LE(e.crc >>> 0, 16);
      cd.writeUInt32LE(e.length, 20);
      cd.writeUInt32LE(size, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      // extra 0, comment 0, disk 0, internal 0; external: the DOS directory bit for a folder
      cd.writeUInt32LE(name.endsWith("/") ? 0x10 : 0, 38);
      cd.writeUInt32LE(offset, 42);
      central.push(cd, nameBuf);
      segments.push({ kind: "bytes", data: head });
      offset += head.length;
      if (file && e.length) {
        segments.push({ kind: "file", file, start: e.start, length: e.length });
        offset += e.length;
      }
      if (offset > LIMIT) throw new Error("太大了，打不成一个 zip（超过 4 GB）");
    };
    // The folder first, as zips made by hand have it (unpacked "here", it is one folder, not the files loose).
    if (prefix) add(prefix, { method: 0, crc: 0, start: 0, length: 0 }, 0, null);
    for (const f of files) {
      if (f.size > LIMIT) throw new Error(`${f.path} 太大了，打不成 zip`);
      const obj = await find(f.sha256);
      if (!obj) throw new Error(`服务器上少了 ${f.path}（${f.sha256.slice(0, 12)}）`);
      const e = await this.entry(f.sha256, f.size, obj);
      add(`${prefix}${f.path}`, e, f.size, obj.file);
    }
    const cdBuf = Buffer.concat(central);
    const count = central.length / 2;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(count, 8);
    end.writeUInt16LE(count, 10);
    end.writeUInt32LE(cdBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    segments.push({ kind: "bytes", data: Buffer.concat([cdBuf, end]) });
    const size = offset + cdBuf.length + end.length;
    if (size > LIMIT) throw new Error("太大了，打不成一个 zip（超过 4 GB）");
    const made: ZipLayout = { size, etag: `"zip-${createHash("sha256").update(key).update(root).digest("hex").slice(0, 32)}"`, segments };
    this.layouts.set(key, made);
    while (this.layouts.size > this.kept) this.layouts.delete(this.layouts.keys().next().value!);
    return made;
  }
}

/** Writes bytes `start`..`end` (inclusive) of the zip to `res`, as they come; stops when `res` goes away. */
export async function writeZip(res: ServerResponse, layout: ZipLayout, start: number, end: number): Promise<void> {
  let at = 0;
  for (const seg of layout.segments) {
    if (res.destroyed) return;
    const length = seg.kind === "bytes" ? seg.data.length : seg.length;
    const from = Math.max(start, at);
    const to = Math.min(end + 1, at + length);
    if (from < to) {
      if (seg.kind === "bytes") {
        if (!res.write(seg.data.subarray(from - at, to - at))) await once(res, "drain");
      } else {
        for await (const chunk of createReadStream(seg.file, { start: seg.start + (from - at), end: seg.start + (to - at) - 1 })) {
          if (res.destroyed) return;
          if (!res.write(chunk)) await once(res, "drain");
        }
      }
    }
    at += length;
    if (at > end) break;
  }
  res.end();
}

/**
 * Sends a zip with Range (a broken download goes on: `Range: bytes=N-` and `If-Range: <etag>`; another etag gets the
 * whole zip again). HEAD gets the headers only.
 */
export async function sendZip(req: IncomingMessage, res: ServerResponse, layout: ZipLayout, filename: string): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/zip",
    "accept-ranges": "bytes",
    etag: layout.etag,
    "cache-control": "private, no-cache",
    "x-content-type-options": "nosniff",
    "content-disposition": `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  };
  const ifRange = req.headers["if-range"];
  const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? "").trim());
  let start = 0;
  let end = layout.size - 1;
  if (m && (!ifRange || ifRange === layout.etag)) {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), layout.size - 1) : layout.size - 1;
    if (start >= layout.size || end < start) {
      res.writeHead(416, { ...headers, "content-range": `bytes */${layout.size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${layout.size}`, "content-length": String(end - start + 1) });
  } else res.writeHead(200, { ...headers, "content-length": String(layout.size) });
  if (req.method === "HEAD") return void res.end();
  try {
    await writeZip(res, layout, start, end);
  } catch {
    // A file gone on the way (platform-compress swapped it): the client sees the download short and tries again.
    res.destroy();
  }
}
