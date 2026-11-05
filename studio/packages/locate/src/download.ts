import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, statSync, truncateSync } from "node:fs";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";

// Downloading big program files so a break costs only what is left (plans/done/claude-code-mirror.md, 2026-11-03). Claude
// Code's official script fetches its 335 MB exe in one go and starts over when the line drops; the team server mirrors it
// (packages/relay/src/mirror.ts) and AMO 平台 installs it (packages/platform/src/claude-install.ts), both with this: the
// bytes go to a .part file, and the next try asks for the rest with Range. Both sides also unpack the .zst the same way to
// check it against the official manifest (which gives the unpacked exe's sha256 and size, not the .zst's).

export class DownloadError extends Error {
  constructor(
    message: string,
    /** HTTP status when the server answered; null when the line itself failed or stalled. */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "DownloadError";
  }
}

export interface ResumeOptions {
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  /** No byte for this long = stalled: the request is dropped (a line may hang rather than break). Default 60 s. */
  stallMs?: number;
  signal?: AbortSignal;
  /** Bytes in the file so far and the whole file's size (null while not known). */
  onProgress?: (done: number, total: number | null) => void;
}

const contentRange = (h: string | null) => {
  const m = /^bytes\s+(?:(\d+)-(\d+)|\*)\/(\d+|\*)$/i.exec(h?.trim() ?? "");
  if (!m) return null;
  return { start: m[1] === undefined ? null : Number(m[1]), total: m[3] === "*" ? null : Number(m[3]) };
};

/**
 * Brings `url` into `dest` (a .part file the caller names), going on from the bytes already there (Range); a server that
 * answers 200 instead of 206 is taken from the start. Throws DownloadError when it breaks, stalls or the size comes out
 * wrong — `dest` keeps what arrived, so calling again goes on from there. Not checked here: the caller hashes the file.
 */
export async function resumeDownload(url: string, dest: string, o: ResumeOptions = {}): Promise<{ size: number }> {
  const fetchFn = o.fetch ?? fetch;
  let have = existsSync(dest) ? statSync(dest).size : 0;
  const ac = new AbortController();
  const onAbort = () => ac.abort(o.signal?.reason);
  o.signal?.addEventListener("abort", onAbort, { once: true });
  const stallMs = o.stallMs ?? 60_000;
  let stalled = false;
  let timer: NodeJS.Timeout | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ac.abort();
    }, stallMs);
  };
  const failed = (err: unknown) => {
    if (o.signal?.aborted) return new DownloadError("下载被取消了");
    if (stalled) return new DownloadError(`${Math.round(stallMs / 1000)} 秒没收到数据，断开了`);
    return err instanceof DownloadError ? err : new DownloadError(`下载断了（${err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)}）`);
  };
  try {
    touch();
    let res: Response;
    try {
      // identity: the byte counts and ranges are the file's own, never a compressed transfer of it.
      res = await fetchFn(url, { headers: { ...o.headers, "accept-encoding": "identity", ...(have ? { range: `bytes=${have}-` } : {}) }, signal: ac.signal });
    } catch (err) {
      throw failed(err);
    }
    let total: number | null;
    if (res.status === 416 && have) {
      // Asked for what follows the end: done already when the server's size is what is here.
      const size = contentRange(res.headers.get("content-range"))?.total ?? null;
      await res.body?.cancel();
      if (size === have) {
        o.onProgress?.(have, have);
        return { size: have };
      }
      truncateSync(dest, 0);
      throw new DownloadError("下了一半的文件比服务器上的还大，已经清掉，从头再下", 416);
    }
    if (res.status === 206) {
      const range = contentRange(res.headers.get("content-range"));
      if (range?.start !== have) {
        await res.body?.cancel();
        truncateSync(dest, 0);
        throw new DownloadError("服务器给的不是接着的那一段，已经清掉，从头再下", 206);
      }
      total = range.total;
    } else if (res.status === 200) {
      have = 0;
      const len = Number(res.headers.get("content-length"));
      total = Number.isFinite(len) && len > 0 ? len : null;
    } else {
      const text = await res.text().catch(() => "");
      let message = `服务器回了 ${res.status}`;
      try {
        const m = (JSON.parse(text) as { message?: unknown }).message;
        if (typeof m === "string" && m) message = m;
      } catch {
        // not JSON: the status says it
      }
      throw new DownloadError(message, res.status);
    }
    if (!res.body) throw new DownloadError("服务器没有给内容", res.status);
    let done = have;
    o.onProgress?.(done, total);
    const count = new Transform({
      transform(chunk: Buffer, _enc, next) {
        touch();
        done += chunk.length;
        o.onProgress?.(done, total);
        next(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), count, createWriteStream(dest, { flags: have ? "a" : "w" }));
    } catch (err) {
      throw failed(err);
    }
    const size = statSync(dest).size;
    if (total !== null && size !== total) throw new DownloadError(`只收到 ${size} / ${total} 字节`);
    return { size };
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Unpacks a .zst, hashing what comes out (sha256, hex) and counting it; with `to`, also writes it there. A damaged file
 * throws (zstd checks its frames).
 */
export async function unpackZstd(file: string, to?: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, next) {
      hash.update(chunk);
      size += chunk.length;
      next(null, chunk);
    },
  });
  const sink = to
    ? createWriteStream(to)
    : new Writable({
        write(_chunk, _enc, next) {
          next();
        },
      });
  await pipeline(createReadStream(file), createZstdDecompress(), tap, sink);
  return { sha256: hash.digest("hex"), size };
}

/** sha256 (hex) of a file as it is. */
export async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** npm's integrity of a file (`sha512-<base64>`), to compare with a package's `dist.integrity` (Codex, 2026-11-03). */
export async function fileIntegrity(file: string): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return `sha512-${hash.digest("base64")}`;
}

/** An npm `dist.integrity` we can check: one sha512 (the registry gives that for every package published since 2017). */
export const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
