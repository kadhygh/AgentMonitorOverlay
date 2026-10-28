import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { listenInStudioRange } from "./ports.js";

// A stand-in for the team server's side of AMO 平台 (plans/amo-lan-platform.md, 「第一版的接口约定」), for the platform's
// tests: the relay's /api/health, /api/register (its checks and messages, the invite passphrase when one is given),
// /api/login and /api/logout, and the three platform routes —
//   GET /api/platform/channels                → { stable: { <tool>: <version> }, test: { … } }
//   GET /api/platform/tools/<tool>/<version>  → { tool, name, version, builtAt, exe, notes, files: [{ path, size, sha256 }] }
//   GET /platform/objects/<sha256>            → the bytes (Authorization: Bearer <key>, or ?key=)
// Tests publish versions with their files; objects are stored by sha256 once, as on the real server. With `gzip`, an
// object gzip makes at least 10% smaller goes as Content-Encoding: gzip to a request that takes it, as the real server
// sends the .gz objects it stores (2026-10-29). Hooks make an object come back wrong or break off half way.

export interface FakePlatformManifest {
  tool: string;
  name: string;
  version: string;
  builtAt: number;
  exe: string;
  notes: string;
  files: Array<{ path: string; size: number; sha256: string }>;
}

export interface FakePlatformServer {
  url: string;
  /** Adds a version of a tool (files: path → content) and, unless `channel: null`, points that channel at it. */
  publish(tool: string, version: string, files: Record<string, string | Buffer>, options?: { name?: string; exe?: string; notes?: string; channel?: "stable" | "test" | null }): FakePlatformManifest;
  /** Points a channel at a published version (promote), or drops the tool from it (null). */
  setChannel(channel: "stable" | "test", tool: string, version: string | null): void;
  /** The next downloads of this object send other bytes (a wrong sha256). */
  corruptObject(sha256: string): void;
  /** The next downloads of this object send half the bytes and then drop the connection. */
  breakObject(sha256: string): void;
  /** Holds every object download this long before sending it (to see the progress on screen). */
  delayObjects(ms: number): void;
  /** Makes every later request with this key fail as logged out. */
  revokeKeys(): void;
  /** Every request, as "METHOD /path". */
  requests: string[];
  /** The accounts, those registered included: name → { password, role }. */
  members(): Record<string, { password: string; role: string }>;
  /** Object downloads so far: the bytes sent on the wire (gzipped or not), the original bytes they carry, how many gzipped. */
  objectTraffic: { sent: number; original: number; gzipped: number };
  close(): Promise<void>;
}

export const sha256Of = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export async function startFakePlatformServer(options: { users?: Record<string, string>; passphrase?: string; name?: string; gzip?: boolean } = {}): Promise<FakePlatformServer> {
  // The users given log in as 程序 (what the tests have always seen); people who register keep the role they gave.
  const members = new Map<string, { password: string; role: string }>(Object.entries(options.users ?? { 小王: "secret" }).map(([n, password]) => [n, { password, role: "程序" }]));
  const keys = new Map<string, string>();
  const objects = new Map<string, Buffer>();
  const gzipped = new Map<string, Buffer | null>();
  const objectTraffic = { sent: 0, original: 0, gzipped: 0 };
  /** The object as the real server would store it: gzipped when that is under 90% of it. */
  const stored = (sha: string, data: Buffer) => {
    if (!gzipped.has(sha)) {
      const gz = gzipSync(data);
      gzipped.set(sha, gz.length < data.length * 0.9 ? gz : null);
    }
    return gzipped.get(sha) ?? null;
  };
  const manifests = new Map<string, FakePlatformManifest>();
  const channels: Record<"stable" | "test", Record<string, string>> = { stable: {}, test: {} };
  const corrupt = new Set<string>();
  const broken = new Set<string>();
  const requests: string[] = [];
  let delay = 0;
  // As the real server (10-28): stable is never older than test — pointing stable at a version moves test along when
  // test has an older one or none.
  const newer = (a: string, b: string) => {
    const x = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
    const y = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
    return false;
  };
  const point = (channel: "stable" | "test", tool: string, version: string) => {
    channels[channel][tool] = version;
    const test = channels.test[tool];
    if (channel === "stable" && (!test || newer(version, test))) channels.test[tool] = version;
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  const fail = (res: ServerResponse, status: number, error: string, message: string) => send(res, status, { error, message });
  const readBody = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (d: string) => (raw += d));
      req.on("end", () => {
        try {
          resolve(JSON.parse(raw || "{}") as Record<string, unknown>);
        } catch {
          resolve({});
        }
      });
    });
  const keyOf = (req: IncomingMessage, url: URL) => {
    const h = req.headers.authorization;
    return h?.startsWith("Bearer ") ? h.slice(7) : url.searchParams.get("key");
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      requests.push(`${req.method} ${path}`);
      if (req.method === "GET" && path === "/api/health") return send(res, 200, { app: "amo-relay", version: "fake", name: options.name ?? "AMO 中转", invite: !!options.passphrase, client: null, shell: null });
      const signIn = (name: string) => {
        const key = randomBytes(12).toString("base64url");
        keys.set(key, name);
        return { name, role: members.get(name)!.role, key };
      };
      if (req.method === "POST" && path === "/api/register") {
        // The relay's order and wording (server.ts, store.register): passphrase, name, password, role, taken.
        const body = await readBody(req);
        if (options.passphrase && body.passphrase !== options.passphrase) return fail(res, 401, "unauthorized", "邀请口令不对");
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) return fail(res, 400, "bad_request", "名字 不能为空");
        if (name.length > 32) return fail(res, 400, "bad_request", "名字 太长（最多 32 字）");
        if (typeof body.password !== "string" || body.password.length < 4) return fail(res, 400, "bad_request", "密码至少 4 位");
        const role = typeof body.role === "string" ? body.role.trim() : "";
        if (role.length > 60) return fail(res, 400, "bad_request", "角色 太长（最多 60 字）");
        if (members.has(name)) return fail(res, 409, "conflict", `名字「${name}」已经有人用了`);
        members.set(name, { password: body.password, role });
        return send(res, 200, signIn(name));
      }
      if (req.method === "POST" && path === "/api/login") {
        const body = await readBody(req);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name || members.get(name)?.password !== body.password) return fail(res, 401, "unauthorized", "名字或密码不对");
        return send(res, 200, signIn(name));
      }
      const key = keyOf(req, url);
      if (!key || !keys.has(key)) return fail(res, 401, "unauthorized", "登录已失效，请重新登录");
      if (req.method === "POST" && path === "/api/logout") {
        keys.delete(key);
        return send(res, 200, { ok: true });
      }
      if (req.method === "GET" && path === "/api/platform/channels") return send(res, 200, channels);
      const tool = /^\/api\/platform\/tools\/([^/]+)\/([^/]+)$/.exec(path);
      if (req.method === "GET" && tool) {
        const m = manifests.get(`${decodeURIComponent(tool[1]!)}@${decodeURIComponent(tool[2]!)}`);
        return m ? send(res, 200, m) : fail(res, 404, "not_found", "没有这个版本");
      }
      const object = /^\/platform\/objects\/([0-9a-f]{64})$/.exec(path);
      if (req.method === "GET" && object) {
        const sha = object[1]!;
        const data = objects.get(sha);
        if (!data) return fail(res, 404, "not_found", "没有这个文件");
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (corrupt.has(sha)) {
          corrupt.delete(sha);
          const bad = Buffer.from(data);
          bad[0] = (bad[0] ?? 0) ^ 0xff;
          res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bad.length });
          return res.end(bad);
        }
        if (broken.has(sha)) {
          broken.delete(sha);
          res.writeHead(200, { "content-type": "application/octet-stream", "content-length": data.length });
          res.write(data.subarray(0, Math.max(1, Math.floor(data.length / 2))));
          setTimeout(() => res.destroy(), 20);
          return;
        }
        const gz = options.gzip && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? "")) ? stored(sha, data) : null;
        objectTraffic.original += data.length;
        objectTraffic.sent += (gz ?? data).length;
        if (gz) {
          objectTraffic.gzipped++;
          res.writeHead(200, { "content-type": "application/octet-stream", "content-encoding": "gzip", "content-length": gz.length });
          return res.end(gz);
        }
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": data.length });
        return res.end(data);
      }
      fail(res, 404, "not_found", `没有这个接口：${req.method} ${path}`);
    })().catch((err: unknown) => fail(res, 500, "internal", String(err)));
  });
  const port = await listenInStudioRange(server);

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    members: () => Object.fromEntries([...members].map(([n, m]) => [n, { ...m }])),
    objectTraffic,
    publish(toolId, version, files, o = {}) {
      const list = Object.entries(files).map(([path, content]) => {
        const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
        const sha = sha256Of(data);
        objects.set(sha, data);
        return { path, size: data.length, sha256: sha };
      });
      const manifest: FakePlatformManifest = { tool: toolId, name: o.name ?? toolId, version, builtAt: Date.now(), exe: o.exe ?? list[0]?.path ?? "", notes: o.notes ?? "", files: list };
      manifests.set(`${toolId}@${version}`, manifest);
      if (o.channel !== null) point(o.channel ?? "stable", toolId, version);
      return manifest;
    },
    setChannel(channel, toolId, version) {
      if (version === null) delete channels[channel][toolId];
      else point(channel, toolId, version);
    },
    delayObjects: (ms) => void (delay = ms),
    corruptObject: (sha) => void corrupt.add(sha),
    breakObject: (sha) => void broken.add(sha),
    revokeKeys: () => keys.clear(),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
