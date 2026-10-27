import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { PublicFiles, landingPage, sendFile, sendHtml } from "./public.js";
import { RELAY_APP, RELAY_VERSION, TICK_MS, type Health, type Member, type Message, type RelayEvent, type Thread } from "./protocol.js";
import { RelayError, type RelayStore } from "./store.js";

// The relay service (plans/relay.md): HTTP for everything, /ws to push new messages and who is online. People register
// with a name and password (plus the invite passphrase, when the service has one); a login hands the device a key that
// every other call carries (Authorization: Bearer, or ?key= for the WebSocket). Any origin may call it — the key, not a
// cookie, is the credential — so the desktop client's pages, loaded from disk, reach it. It also hands out the client
// (public.ts): / is the page to send people, /client/ and /app/ the client's content, /downloads/ its zip.

export interface RelayServerOptions {
  store: RelayStore;
  /** The invite passphrase registering takes; none = anyone who reaches the service may register. */
  passphrase?: string;
  /** Holds client/ (content + manifest.json) and downloads/; none = no client handed out. */
  publicDir?: string;
  /** Shown to clients, e.g. 「策划组」. */
  name?: string;
  host?: string;
  port?: number;
  /** How often to look for a newer client build (default 5 s) and to send a tick (default TICK_MS). Tests shorten them. */
  clientWatchMs?: number;
  tickMs?: number;
}

export interface RelayServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const STATUS: Record<RelayError["code"], number> = { bad_request: 400, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409 };
const MAX_BODY = 4 * 1024 * 1024;
const MAX_WAIT = 10 * 60_000;

const digest = (s: string) => createHash("sha256").update(s).digest();
const samePassphrase = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new RelayError("bad_request", "内容太大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return ok({});
      try {
        const o = JSON.parse(raw) as unknown;
        ok(o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {});
      } catch {
        fail(new RelayError("bad_request", "不是有效的 JSON"));
      }
    });
    req.on("error", fail);
  });
}

function keyOf(req: IncomingMessage, url: URL): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  return url.searchParams.get("key");
}

interface Waiter {
  name: string;
  threadId: string | null;
  after: number;
  done(messages: Message[]): void;
}

export async function startRelayServer(opts: RelayServerOptions): Promise<RelayServer> {
  const { store } = opts;
  const serviceName = opts.name?.trim() || "AMO 中转";
  const files = new PublicFiles(opts.publicDir);
  const sockets = new Map<string, Set<WebSocket>>();
  const lastSeen = new Map<string, number>();
  const waiters = new Set<Waiter>();
  let closing = false;

  const members = (): Member[] =>
    store.members().map((m) => ({ ...m, online: (sockets.get(m.name)?.size ?? 0) > 0, lastSeen: lastSeen.get(m.name) ?? 0 }));

  const push = (names: Iterable<string>, event: RelayEvent) => {
    const data = JSON.stringify(event);
    for (const n of names) for (const ws of sockets.get(n) ?? []) if (ws.readyState === ws.OPEN) ws.send(data);
  };
  const pushAll = (event: RelayEvent) => push(sockets.keys(), event);
  /** Who is online changed; not while closing, when the store may already be shut. */
  const pushMembers = () => {
    if (!closing) pushAll({ type: "members", members: members() });
  };

  // A newer client build (npm run relay:release writes client/ while the service runs): pushed to everyone.
  let clientVersion = files.manifest()?.version ?? null;
  const watchClient = setInterval(() => {
    const now = files.manifest()?.version ?? null;
    if (now === clientVersion) return;
    clientVersion = now;
    pushAll({ type: "client", version: now });
  }, opts.clientWatchMs ?? 5000);
  const tick = setInterval(() => pushAll({ type: "tick" }), opts.tickMs ?? TICK_MS);

  /** A new message: to the thread's members, and to the waits it answers (not the author's own). */
  const announce = (thread: Thread, message: Message) => {
    push(thread.members, { type: "message", thread, message });
    for (const w of [...waiters]) {
      if (w.name === message.author || !thread.members.includes(w.name)) continue;
      if (w.threadId && w.threadId !== thread.id) continue;
      if (message.seq <= w.after) continue;
      w.done([message]);
    }
  };

  const auth = (req: IncomingMessage, url: URL): string => {
    const key = keyOf(req, url);
    const name = key ? store.memberByKey(key) : null;
    if (!name) throw new RelayError("unauthorized", "登录已失效，请重新登录");
    lastSeen.set(name, Date.now());
    return name;
  };

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    // HEAD is answered as GET; Node leaves the body out.
    const method = req.method === "HEAD" ? "GET" : (req.method ?? "GET");
    const path = url.pathname;
    if (method === "GET" && path === "/api/health") {
      const health: Health = { app: RELAY_APP, version: RELAY_VERSION, name: serviceName, invite: !!opts.passphrase, client: files.manifest()?.version ?? null };
      return send(res, 200, health);
    }
    if (method === "POST" && path === "/api/register") {
      const body = await readJson(req);
      if (opts.passphrase && (typeof body.passphrase !== "string" || !samePassphrase(body.passphrase, opts.passphrase))) throw new RelayError("unauthorized", "邀请口令不对");
      const joined = store.register(body.name, body.password, body.role);
      pushMembers();
      return send(res, 200, joined);
    }
    if (method === "POST" && path === "/api/login") {
      const body = await readJson(req);
      return send(res, 200, store.login(body.name, body.password));
    }
    if (method === "GET" && !path.startsWith("/api/")) {
      if (path === "/" || path === "/index.html") return sendHtml(res, landingPage(serviceName, files.manifest(), files.downloads()));
      if (path === "/app" || path === "/client") {
        res.writeHead(302, { location: `${path}/` });
        res.end();
        return;
      }
      const area = path.startsWith("/client/") || path.startsWith("/app/") ? "client" : path.startsWith("/downloads/") ? "downloads" : null;
      const rel = path.slice(path.indexOf("/", 1) + 1) || "index.html";
      const file = area ? files.file(area, rel) : null;
      if (file) return sendFile(res, file, area === "downloads");
      throw new RelayError("not_found", `没有这个文件：${path}`);
    }

    const me = auth(req, url);
    if (method === "POST" && path === "/api/logout") {
      store.logout(keyOf(req, url)!);
      return send(res, 200, { ok: true });
    }
    if (method === "GET" && path === "/api/me") return send(res, 200, { name: me, service: serviceName, role: store.members().find((m) => m.name === me)?.role ?? "" });
    if (method === "PATCH" && path === "/api/me") {
      const body = await readJson(req);
      store.setRole(me, body.role);
      pushMembers();
      return send(res, 200, { ok: true });
    }
    if (method === "GET" && path === "/api/members") return send(res, 200, { members: members() });
    if (method === "GET" && path === "/api/threads") return send(res, 200, { threads: store.threadsFor(me) });
    if (method === "POST" && path === "/api/threads/direct") {
      const body = await readJson(req);
      return send(res, 200, { thread: store.direct(me, body.with) });
    }
    if (method === "POST" && path === "/api/threads/topic") {
      const body = await readJson(req);
      const thread = store.createTopic(me, body.with, body.title);
      push(thread.members, { type: "thread", thread });
      return send(res, 200, { thread });
    }
    if (method === "POST" && path === "/api/requests") {
      const body = await readJson(req);
      const out = store.createRequest(me, body as never);
      announce(out.thread, out.message);
      return send(res, 200, out);
    }
    if (method === "GET" && path === "/api/wait") {
      const threadId = url.searchParams.get("thread") || null;
      const after = Number(url.searchParams.get("after") ?? 0) || 0;
      const timeout = Math.max(0, Math.min(Number(url.searchParams.get("timeout") ?? 60_000) || 0, MAX_WAIT));
      // What already came while the caller was away answers at once.
      const pending = threadId
        ? store.messages(threadId, me, after).filter((m) => m.author !== me)
        : store.threadsFor(me).flatMap((t) => (t.lastSeq > after ? store.messages(t.id, me, after).filter((m) => m.author !== me) : []));
      if (pending.length || timeout === 0) return send(res, 200, { messages: pending.sort((a, b) => a.seq - b.seq) });
      await new Promise<void>((resolve) => {
        const w: Waiter = {
          name: me,
          threadId,
          after,
          done: (messages) => {
            clearTimeout(timer);
            waiters.delete(w);
            if (!res.writableEnded) send(res, 200, { messages });
            resolve();
          },
        };
        const timer = setTimeout(() => w.done([]), timeout);
        waiters.add(w);
        req.on("close", () => {
          if (!res.writableEnded) w.done([]);
        });
      });
      return;
    }

    const m = /^\/api\/threads\/([^/]+)(\/messages|\/read|\/archive)?$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      if (method === "GET" && !m[2]) return send(res, 200, { thread: store.thread(id, me) });
      if (method === "POST" && m[2] === "/archive") {
        const archived = (await readJson(req)).archived !== false;
        store.setArchived(id, me, archived);
        push([me], { type: "archived", threadId: id, archived });
        return send(res, 200, { archived });
      }
      if (method === "GET" && m[2] === "/messages") {
        const after = Number(url.searchParams.get("after") ?? 0) || 0;
        const limit = Number(url.searchParams.get("limit") ?? 200) || 200;
        return send(res, 200, { thread: store.thread(id, me), messages: store.messages(id, me, after, limit) });
      }
      if (method === "POST" && m[2] === "/messages") {
        const body = await readJson(req);
        const out = store.addMessage(id, me, body as never);
        announce(out.thread, out.message);
        return send(res, 200, out);
      }
      if (method === "POST" && m[2] === "/read") {
        const body = await readJson(req);
        const readSeq = store.markRead(id, me, typeof body.seq === "number" ? body.seq : undefined);
        push([me], { type: "read", threadId: id, readSeq });
        return send(res, 200, { readSeq });
      }
    }
    throw new RelayError("not_found", `没有这个接口：${method} ${path}`);
  }

  const server = createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, PATCH, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://relay");
    route(req, res, url).catch((err: unknown) => {
      if (res.headersSent) return;
      if (err instanceof RelayError) send(res, STATUS[err.code], { error: err.code, message: err.message });
      else send(res, 500, { error: "internal", message: err instanceof Error ? err.message : String(err) });
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://relay");
    let name: string;
    try {
      if (url.pathname !== "/ws") throw new RelayError("not_found", "");
      name = auth(req, url);
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const set = sockets.get(name) ?? new Set();
      const wasOnline = set.size > 0;
      set.add(ws);
      sockets.set(name, set);
      ws.send(JSON.stringify({ type: "hello", me: name, client: clientVersion } satisfies RelayEvent));
      if (!wasOnline) pushMembers();
      ws.on("close", () => {
        set.delete(ws);
        lastSeen.set(name, Date.now());
        if (!set.size) {
          sockets.delete(name);
          pushMembers();
        }
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "0.0.0.0", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const shownHost = !opts.host || opts.host === "0.0.0.0" ? "127.0.0.1" : opts.host;
  return {
    url: `http://${shownHost}:${port}`,
    port,
    close: async () => {
      closing = true;
      clearInterval(watchClient);
      clearInterval(tick);
      for (const w of [...waiters]) w.done([]);
      for (const set of sockets.values()) for (const ws of set) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
