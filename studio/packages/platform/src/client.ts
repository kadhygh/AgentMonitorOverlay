import { createWriteStream, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { checkChannels, checkManifest, checkSummary, PlatformError, type Channels, type Manifest, type ManifestSummary } from "./manifest.js";

// The platform's side of the team server (the relay service), logged in: the channels, a version's manifest, and the
// files by sha256. All need `Authorization: Bearer <key>` (account.json).

/** What the installer needs from a server; tests can hand it something else. */
export interface Source {
  manifest(tool: string, version: string): Promise<Manifest>;
  /** Writes the object's bytes to `dest`, calling `onBytes` as they arrive. Does not check them: the installer does. */
  download(sha256: string, dest: string, onBytes: (n: number) => void): Promise<void>;
}

const IDLE_MS = 30_000;
/** A download that breaks off is tried this many times in all. */
const DOWNLOAD_TRIES = 3;
/** The whole package (用完整包) goes on where it stopped this many times in all. */
const PACKAGE_TRIES = 5;

/** An error and what is under it (undici says only 「terminated」 or 「fetch failed」; the cause says why). */
function why(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
  const under = cause ? [cause.code, cause.message].filter(Boolean).join(" ") : "";
  return under && !text.includes(under) ? `${text}：${under}` : text;
}
/** A manifest (a few MB) may take a while on a slow link: the timeout covers reading its body as well. */
const MANIFEST_MS = 120_000;

export class PlatformClient implements Source {
  constructor(
    readonly server: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get(path: string, timeoutMs = 15_000): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.server}${path}`, { headers: { authorization: `Bearer ${this.key}` }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new PlatformError("unreachable", `连不上服务器 ${this.server.replace(/^https?:\/\//, "")}（${err instanceof Error ? err.message : String(err)}）`);
    }
    if (res.ok) return res;
    const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
    const message = typeof body?.message === "string" && body.message ? body.message : `服务器回了 ${res.status}`;
    if (res.status === 401 || res.status === 403) throw new PlatformError("unauthorized", message);
    if (res.status === 404) throw new PlatformError("not_found", message);
    throw new PlatformError("server", message);
  }

  async channels(): Promise<Channels> {
    try {
      const res = await this.get("/api/platform/channels");
      return checkChannels(await res.json().catch(() => null));
    } catch (err) {
      // 404: the service has no platform folder yet, or nothing was ever published — no tools, not a failure.
      if (err instanceof PlatformError && err.code === "not_found") return { stable: {}, test: {} };
      throw err;
    }
  }

  /**
   * What the platform shows of a version: its summary (2026-11-03), a few KB instead of the whole manifest. A server
   * from before has no …/summary (404 for the path): the manifest then, without its files.
   */
  async summary(tool: string, version: string): Promise<ManifestSummary> {
    const base = `/api/platform/tools/${encodeURIComponent(tool)}/${encodeURIComponent(version)}`;
    let res: Response;
    try {
      res = await this.get(`${base}/summary`);
    } catch (err) {
      if (err instanceof PlatformError && err.code === "not_found") {
        const { files: _files, ...rest } = await this.manifest(tool, version);
        return rest;
      }
      throw err;
    }
    return checkSummary(await res.json().catch(() => null), tool, version);
  }

  /**
   * A version's manifest. 2026-11-03: Studio's is 2.3 MB now, and the 15 s the other calls get covers reading the body
   * too — on a slow link it was cut off and reported as 「不是 JSON 对象」. So it gets longer, one more try when the body
   * does not arrive whole, and says so when it still does not.
   */
  async manifest(tool: string, version: string): Promise<Manifest> {
    const path = `/api/platform/tools/${encodeURIComponent(tool)}/${encodeURIComponent(version)}`;
    let why = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.get(path, MANIFEST_MS);
      const expected = Number(res.headers.get("content-length") ?? NaN);
      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        why = `读到一半断了（${err instanceof Error ? err.message : String(err)}）`;
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        const got = Buffer.byteLength(text);
        // Cut short on the way: try once more. Whole but not JSON: the manifest itself is wrong.
        if (Number.isFinite(expected) && got < expected) {
          why = `只读到 ${got} / ${expected} 字节`;
          continue;
        }
        return checkManifest(null, tool, version);
      }
      return checkManifest(value, tool, version);
    }
    throw new PlatformError("unreachable", `从服务器读 ${tool} ${version} 的清单没读完整：${why}。网络慢或者断了，再试一次`);
  }

  /**
   * An object's bytes into `dest`. 2026-11-03: the platform's update kept failing with 「中途断了（terminated）」 on its
   * biggest new file while the same download from a script never did — undici ends a body whose Response has been
   * garbage collected, and nothing held `res` once its body was handed to the pipeline (the platform's window process
   * collects often). `res` is now held until the file is written; a download that still breaks is tried twice more from
   * the start, and its cause is said.
   */
  async download(sha256: string, dest: string, onBytes: (n: number) => void): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      let got = 0;
      try {
        await this.downloadOnce(sha256, dest, (n) => {
          got += n;
          onBytes(n);
        });
        return;
      } catch (err) {
        // The bar went forward with what came: back again, the next try counts it anew.
        if (got) onBytes(-got);
        if (!(err instanceof PlatformError) || err.code !== "unreachable" || attempt >= DOWNLOAD_TRIES) throw err;
      }
    }
  }

  /**
   * 用完整包 (2026-11-03): a version's whole program as one zip (/platform/zip/<tool>/<version>, the server makes it from
   * the same files) into `dest`. `fetchImpl` is the platform's other network stack (Electron's net.fetch: the update file
   * by file runs on Node's fetch, which is what broke). It comes in `<dest>.part`, with the zip's ETag beside it, and a
   * broken download goes on from where it stopped (Range, If-Range: a zip made anew — the version published again —
   * starts over), also on a later click. Calls `onProgress(done, total)` as bytes arrive.
   */
  async downloadPackage(tool: string, version: string, dest: string, onProgress: (done: number, total: number) => void, fetchImpl: typeof fetch = this.fetchImpl): Promise<void> {
    const url = `${this.server}/platform/zip/${encodeURIComponent(tool)}/${encodeURIComponent(version)}`;
    const part = `${dest}.part`;
    const tagFile = `${dest}.part.etag`;
    let reason = "";
    for (let attempt = 1; attempt <= PACKAGE_TRIES; attempt++) {
      let have = existsSync(part) ? statSync(part).size : 0;
      const etag = have && existsSync(tagFile) ? readFileSync(tagFile, "utf8").trim() : "";
      if (have && !etag) {
        rmSync(part, { force: true });
        have = 0;
      }
      const abort = new AbortController();
      let idle = setTimeout(() => abort.abort(), IDLE_MS);
      const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(() => abort.abort(), IDLE_MS);
      };
      let res: Response | undefined;
      try {
        try {
          res = await fetchImpl(url, { headers: { authorization: `Bearer ${this.key}`, ...(have ? { range: `bytes=${have}-`, "if-range": etag } : {}) }, signal: abort.signal });
        } catch (err) {
          reason = `连不上服务器（${why(err)}）`;
          continue;
        }
        if (res.status === 416) {
          // What is here is longer than the zip: begin again.
          rmSync(part, { force: true });
          reason = "下载了一半的部分对不上";
          continue;
        }
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
          const message = typeof body?.message === "string" ? body.message : `下载完整包时服务器回了 ${res.status}`;
          // An older relay service has no /platform/zip/: it says 「没有这个接口」.
          if (res.status === 404 && message.includes("没有这个接口")) throw new PlatformError("not_found", "团队服务器还不能给完整包：要先把中转服务更新到新版");
          throw new PlatformError(res.status === 401 ? "unauthorized" : res.status === 404 ? "not_found" : "server", message);
        }
        const resumed = res.status === 206;
        let total = Number(res.headers.get("content-length") ?? NaN);
        if (resumed) {
          const m = /^bytes (\d+)-\d+\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
          if (!m || Number(m[1]) !== have) {
            rmSync(part, { force: true });
            reason = "服务器接着给的位置不对";
            continue;
          }
          total = Number(m[2]);
        } else {
          have = 0;
          writeFileSync(tagFile, res.headers.get("etag") ?? "");
        }
        let done = have;
        onProgress(done, total);
        const count = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            touch();
            done += chunk.length;
            onProgress(done, total);
            cb(null, chunk);
          },
        });
        try {
          await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), count, createWriteStream(part, { flags: resumed ? "a" : "w" }));
        } catch (err) {
          reason = `中途断了（${why(err)}）`;
          continue;
        }
        const size = statSync(part).size;
        if (Number.isFinite(total) && size !== total) {
          reason = `只下到 ${size} / ${total} 字节`;
          continue;
        }
        rmSync(dest, { force: true });
        renameSync(part, dest);
        rmSync(tagFile, { force: true });
        return;
      } finally {
        clearTimeout(idle);
        // Held to here (see download).
        void res?.status;
      }
    }
    throw new PlatformError("unreachable", `完整包没下完：${reason}。下了的部分留着，再点一次会接着下`);
  }

  private async downloadOnce(sha256: string, dest: string, onBytes: (n: number) => void): Promise<void> {
    // A download that stops sending for a while is given up (the connection may hang rather than break).
    const abort = new AbortController();
    let idle = setTimeout(() => abort.abort(), IDLE_MS);
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => abort.abort(), IDLE_MS);
    };
    let res: Response | undefined;
    try {
      try {
        // The server keeps most objects gzipped (2026-10-29) and sends them as Content-Encoding: gzip when asked to; fetch
        // unpacks them, so what is written, counted (onBytes: the progress bar runs on the manifest's sizes) and checked
        // is always the original file.
        res = await this.fetchImpl(`${this.server}/platform/objects/${sha256}`, { headers: { authorization: `Bearer ${this.key}`, "accept-encoding": "gzip" }, signal: abort.signal });
      } catch (err) {
        throw new PlatformError("unreachable", `下载 ${sha256.slice(0, 12)} 时连不上服务器（${why(err)}）`);
      }
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
        throw new PlatformError(res.status === 401 ? "unauthorized" : res.status === 404 ? "not_found" : "server", typeof body?.message === "string" ? body.message : `下载文件时服务器回了 ${res.status}`);
      }
      const count = new Transform({
        transform(chunk: Buffer, _enc, done) {
          touch();
          onBytes(chunk.length);
          done(null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), count, createWriteStream(dest));
      } catch (err) {
        throw new PlatformError("unreachable", `下载 ${sha256.slice(0, 12)} 中途断了（${why(err)}）`);
      }
    } finally {
      clearTimeout(idle);
      // Held to here (see download): read after the body is done, so the Response is not collected while it streams.
      void res?.status;
    }
  }
}
