import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { checkChannels, checkManifest, PlatformError, type Channels, type Manifest } from "./manifest.js";

// The platform's side of the team server (the relay service), logged in: the channels, a version's manifest, and the
// files by sha256. All need `Authorization: Bearer <key>` (account.json).

/** What the installer needs from a server; tests can hand it something else. */
export interface Source {
  manifest(tool: string, version: string): Promise<Manifest>;
  /** Writes the object's bytes to `dest`, calling `onBytes` as they arrive. Does not check them: the installer does. */
  download(sha256: string, dest: string, onBytes: (n: number) => void): Promise<void>;
}

const IDLE_MS = 30_000;

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

  async manifest(tool: string, version: string): Promise<Manifest> {
    const res = await this.get(`/api/platform/tools/${encodeURIComponent(tool)}/${encodeURIComponent(version)}`);
    return checkManifest(await res.json().catch(() => null), tool, version);
  }

  async download(sha256: string, dest: string, onBytes: (n: number) => void): Promise<void> {
    // A download that stops sending for a while is given up (the connection may hang rather than break).
    const abort = new AbortController();
    let idle = setTimeout(() => abort.abort(), IDLE_MS);
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => abort.abort(), IDLE_MS);
    };
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.server}/platform/objects/${sha256}`, { headers: { authorization: `Bearer ${this.key}` }, signal: abort.signal });
      } catch (err) {
        throw new PlatformError("unreachable", `下载 ${sha256.slice(0, 12)} 时连不上服务器（${err instanceof Error ? err.message : String(err)}）`);
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
        throw new PlatformError("unreachable", `下载 ${sha256.slice(0, 12)} 中途断了（${err instanceof Error ? err.message : String(err)}）`);
      }
    } finally {
      clearTimeout(idle);
    }
  }
}
