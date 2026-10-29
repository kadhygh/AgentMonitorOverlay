import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pipeline } from "node:stream";
import { createGunzip } from "node:zlib";
import { WebSocketServer, type WebSocket } from "ws";
import { PLATFORM_ZIP, PlatformFiles, SHA256, TOOL_ID, VERSION } from "./platform.js";
import { PublicFiles, landingPage, sendFile, sendHtml } from "./public.js";
import { adminPage } from "./admin-page.js";
import { MAX_FILE_BYTES, RELAY_APP, RELAY_VERSION, TICK_MS, type RelayFile, type Health, type Member, type Message, type RelayEvent, type SessionAction, type Thread } from "./protocol.js";
import { RelayError, type RelayStore } from "./store.js";
import { checkDeviceId, checkDeviceName, DeviceHub } from "./devices.js";
import { DEVICE_CHANNEL_VERSION, MAX_DEVICE_FRAME } from "./devices-protocol.js";

// The relay service (plans/relay.md): HTTP for everything, /ws to push new messages and who is online. People register
// with a name and password (plus the invite passphrase, when the service has one); a login hands the device a key that
// every other call carries (Authorization: Bearer, or ?key= for the WebSocket). Any origin may call it — the key, not a
// cookie, is the credential — so the desktop client's pages, loaded from disk, reach it. It also hands out the client
// (public.ts): / is the page to send people, /client/ and /app/ the client's content, /downloads/ its zip. With a
// platform dir it also hands out the AMO platform's tools to people signed in (platform.ts): /api/platform/channels,
// /api/platform/tools/<tool>/<version> and /platform/objects/<sha256>.

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
  /** Where uploaded files are kept (one file per upload, named by its id); none = no files. */
  filesDir?: string;
  /** The AMO platform's files (platform.ts: channels, manifests, objects); none = the platform calls answer 404. */
  platformDir?: string;
  /** How often to look for a newer client build (default 5 s) and to send a tick (default TICK_MS). Tests shorten them. */
  clientWatchMs?: number;
  tickMs?: number;
  /** Devices (devices.ts): how often each is pinged (default 15 s) and how long unanswered means gone (default 60 s). */
  deviceHeartbeatMs?: number;
  deviceDeadMs?: number;
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

/** A request's bytes, at most `max`. */
function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        fail(new RelayError("bad_request", `文件太大（最多 ${Math.round(max / 1024 / 1024)} MB）`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
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

/** Whether an Accept-Encoding takes gzip: `gzip` (or `x-gzip`, or `*` when gzip is not named) with a q above 0. */
export function acceptsGzip(header: string | undefined): boolean {
  if (!header) return false;
  let star = false;
  for (const part of header.toLowerCase().split(",")) {
    const [coding = "", ...params] = part.split(";").map((s) => s.trim());
    const q = params.find((p) => p.startsWith("q="));
    const ok = !q || Number(q.slice(2)) > 0;
    if (coding === "gzip" || coding === "x-gzip") return ok;
    if (coding === "*") star = ok;
  }
  return star;
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
  const platform = new PlatformFiles(opts.platformDir);
  const sockets = new Map<string, Set<WebSocket>>();
  const lastSeen = new Map<string, number>();
  const waiters = new Set<Waiter>();
  let closing = false;
  // Devices and their pairing (remote sessions, step 1): tables in the same database, who is online in memory.
  const devices = new DeviceHub({
    db: store.db,
    isMember: (n) => store.members().some((m) => m.name === n),
    ...(opts.deviceHeartbeatMs ? { heartbeatMs: opts.deviceHeartbeatMs } : {}),
    ...(opts.deviceDeadMs ? { deadMs: opts.deviceDeadMs } : {}),
  });

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

  /** A team task changed: everyone sees tasks. */
  const taskChanged = (taskId: string | null | undefined) => {
    if (taskId && !closing) pushAll({ type: "task", task: store.task(taskId) });
  };

  /** A file came: its task or its session moved. */
  const fileChanged = (file: RelayFile, me: string) => {
    if (file.slot) pushAll({ type: "settings", settings: store.settings() });
    if (file.taskId) taskChanged(file.taskId);
    if (file.threadId) {
      const thread = store.thread(file.threadId, me);
      push(thread.members, { type: "updated", thread });
    }
  };
  /** Notes on a file changed: to whoever can see it (everyone for a task's file, the two people for a session's). */
  const notesChanged = (file: RelayFile) => {
    const names = file.threadId ? store.threadMembers(file.threadId) : [...sockets.keys()];
    push(names, { type: "notes", fileId: file.id });
    if (file.taskId) taskChanged(file.taskId);
  };

  /** A new message: to the thread's members, and to the waits it answers (not the author's own). */
  const announce = (thread: Thread, message: Message) => {
    push(thread.members, { type: "message", thread, message });
    taskChanged(thread.request?.taskId);
    for (const w of [...waiters]) {
      if (w.name === message.author || !thread.members.includes(w.name)) continue;
      if (w.threadId && w.threadId !== thread.id) continue;
      if (message.seq <= w.after) continue;
      w.done([message]);
    }
  };

  /** The asking side's AI fetched a session that came back: tell its members (no message is written). */
  const pickedBy = (threadId: string, name: string) => {
    if (!store.markPicked(threadId, name)) return;
    const thread = store.thread(threadId, name);
    push(thread.members, { type: "updated", thread });
    taskChanged(thread.request?.taskId);
  };

  const auth = (req: IncomingMessage, url: URL): string => {
    const key = keyOf(req, url);
    const name = key ? store.memberByKey(key) : null;
    if (!name) throw new RelayError("unauthorized", "登录已失效，请重新登录");
    lastSeen.set(name, Date.now());
    return name;
  };

  // Registering takes a passphrase when the admin page set one (kept in the store, hashed) or the service was started with
  // --passphrase / AMO_RELAY_PASSPHRASE. The page's one wins when both exist, so the page is what decides once it's used.
  const inviteNeeded = () => store.hasPassphrase() || !!opts.passphrase;
  const passphraseOk = (given: unknown): boolean => {
    if (store.hasPassphrase()) return store.passphraseMatches(given);
    if (opts.passphrase) return typeof given === "string" && samePassphrase(given, opts.passphrase);
    return true;
  };

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    // HEAD is answered as GET; Node leaves the body out.
    const method = req.method === "HEAD" ? "GET" : (req.method ?? "GET");
    const path = url.pathname;
    if (method === "GET" && path === "/api/health") {
      const health: Health = { app: RELAY_APP, version: RELAY_VERSION, name: serviceName, invite: inviteNeeded(), client: files.manifest()?.version ?? null, shell: files.shell(), devices: DEVICE_CHANNEL_VERSION };
      return send(res, 200, health);
    }
    if (method === "POST" && path === "/api/register") {
      const body = await readJson(req);
      if (!passphraseOk(body.passphrase)) throw new RelayError("unauthorized", "邀请口令不对");
      const joined = store.register(body.name, body.password, body.role);
      pushMembers();
      return send(res, 200, joined);
    }
    if (method === "POST" && path === "/api/login") {
      const body = await readJson(req);
      return send(res, 200, store.login(body.name, body.password));
    }
    // The admin page (2026-10-29, the user: a plain page for the LAN, no AMO login): its own password, set on the service
    // machine (`amo-relay admin-password`), sent with every call as x-amo-admin.
    if (method === "GET" && path === "/admin") return sendHtml(res, adminPage(serviceName));
    if (path.startsWith("/api/admin/")) {
      if (!store.hasAdminPassword()) throw new RelayError("forbidden", "还没有设管理密码：在服务器上运行 amo-relay admin-password（或在开发机上 npm run relay:mac -- admin-password）");
      if (!store.adminPasswordMatches(req.headers["x-amo-admin"])) {
        // A guess costs a moment.
        await new Promise((r) => setTimeout(r, 600));
        throw new RelayError("unauthorized", "管理密码不对");
      }
      const kick = (name: string) => {
        for (const ws of sockets.get(name) ?? []) ws.close(1012, "account changed");
        devices.dropAccount(name);
      };
      if (method === "GET" && path === "/api/admin/members") {
        const online = new Map(members().map((m) => [m.name, m]));
        return send(res, 200, { service: serviceName, invite: inviteNeeded(), members: store.adminMembers().map((m) => ({ ...m, online: !!online.get(m.name)?.online, lastSeen: online.get(m.name)?.lastSeen ?? 0 })) });
      }
      const body = await readJson(req);
      if (method === "POST" && path === "/api/admin/rename") {
        const done = store.renameMember(body.from, body.to);
        kick(done.from);
        pushMembers();
        return send(res, 200, done);
      }
      if (method === "POST" && path === "/api/admin/password") {
        const password = typeof body.password === "string" && body.password ? body.password : Array.from({ length: 8 }, () => "abcdefghjkmnpqrstuvwxyz23456789"[randomBytes(1)[0]! % 31]).join("");
        store.setPassword(body.name, password);
        kick(String(body.name));
        return send(res, 200, { name: body.name, password });
      }
      if (method === "POST" && path === "/api/admin/disable") {
        store.setDisabled(body.name, body.disabled !== false);
        if (body.disabled !== false) kick(String(body.name));
        pushMembers();
        return send(res, 200, { ok: true });
      }
      // The admin password itself, from the page (2026-10-29, the user asked): the current one already checked above.
      if (method === "POST" && path === "/api/admin/admin-password") {
        store.setAdminPassword(body.password);
        return send(res, 200, { ok: true });
      }
      // The registration passphrase (2026-10-29, the user asked): empty clears it; logins already made are untouched.
      if (method === "POST" && path === "/api/admin/passphrase") {
        store.setPassphrase(typeof body.passphrase === "string" ? body.passphrase : null);
        return send(res, 200, { invite: inviteNeeded() });
      }
      throw new RelayError("not_found", "没有这个管理操作");
    }
    // The AMO platform's files (platform.ts, plans/amo-lan-platform.md): for people signed in; objects also take ?key=,
    // so a download can be a plain URL.
    if (method === "GET" && (path.startsWith("/api/platform/") || path.startsWith("/platform/"))) {
      auth(req, url);
      if (!platform.dir) throw new RelayError("not_found", "这个服务没有放 AMO 平台的文件：启动时用 --platform-dir 或环境变量 AMO_RELAY_PLATFORM_DIR 指定平台目录");
      const part = (s: string) => {
        try {
          return decodeURIComponent(s);
        } catch {
          throw new RelayError("bad_request", `路径不对：${path}`);
        }
      };
      if (path === "/api/platform/channels") return send(res, 200, platform.channels());
      const tm = /^\/api\/platform\/tools\/([^/]+)\/([^/]+)$/.exec(path);
      if (tm) {
        const [tool, version] = [part(tm[1]!), part(tm[2]!)];
        if (!TOOL_ID.test(tool)) throw new RelayError("bad_request", `工具名不对：${tool}`);
        if (!VERSION.test(version)) throw new RelayError("bad_request", `版本号不对：${version}`);
        const file = platform.manifest(tool, version);
        if (!file) throw new RelayError("not_found", `${tool} 还没有发布 ${version}`);
        return sendFile(res, file);
      }
      const om = /^\/platform\/objects\/([^/]+)$/.exec(path);
      if (om) {
        const sha = part(om[1]!);
        if (!SHA256.test(sha)) throw new RelayError("bad_request", "文件的 sha256 要是 64 位小写十六进制");
        const obj = await platform.openObject(sha);
        if (!obj) throw new RelayError("not_found", `服务器上没有这个文件：${sha}`);
        // Named by its content: it never changes.
        const headers: Record<string, string> = { "content-type": "application/octet-stream", "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" };
        // Stored gzipped (2026-10-29): sent as it is to a client that takes gzip (the platform's fetch does), unpacked on
        // the way for one that does not (curl without --compressed), whose length is then not known up front.
        if (obj.gzip) headers.vary = "accept-encoding";
        const gzipped = obj.gzip && acceptsGzip(req.headers["accept-encoding"]);
        if (!obj.gzip || gzipped) headers["content-length"] = String(obj.size);
        if (gzipped) headers["content-encoding"] = "gzip";
        res.writeHead(200, headers);
        // A client that goes away part way, or a damaged .gz, ends the response early: the client checks size and sha256.
        const ended = (err: unknown) => void (err && res.destroy());
        const stream = obj.handle.createReadStream();
        if (obj.gzip && !gzipped) pipeline(stream, createGunzip(), res, ended);
        else pipeline(stream, res, ended);
        return;
      }
      throw new RelayError("not_found", `没有这个接口：${method} ${path}`);
    }
    if (method === "GET" && !path.startsWith("/api/")) {
      // The platform's own zip: in downloads/ beside the client's, or in the platform dir (which deploy leaves alone).
      const platformZip = files.file("downloads", PLATFORM_ZIP) ?? platform.zip();
      if (path === "/" || path === "/index.html") return sendHtml(res, landingPage(serviceName, files.manifest(), files.downloads().filter((f) => f.name !== PLATFORM_ZIP), platformZip ? { size: statSync(platformZip).size } : null));
      if (path === `/downloads/${PLATFORM_ZIP}` && platformZip) return sendFile(res, platformZip, true);
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
    if (method === "GET" && path === "/api/me") {
      const m = store.members().find((x) => x.name === me);
      return send(res, 200, { name: me, service: serviceName, role: m?.role ?? "", nick: m?.nick ?? "", avatar: m?.avatar ?? null });
    }
    if (method === "PATCH" && path === "/api/me") {
      const body = await readJson(req);
      store.setProfile(me, body);
      pushMembers();
      return send(res, 200, { ok: true });
    }
    if (method === "GET" && path === "/api/members") return send(res, 200, { members: members() });

    // Devices (devices-protocol.ts): pairing requests and pairs, each call naming the calling device of this account.
    if (path === "/api/devices/pair" || path === "/api/devices/pairs" || path === "/api/devices/unpair" || path.startsWith("/api/devices/pair/")) {
      const body = method === "GET" || method === "DELETE" ? {} : await readJson(req);
      const device = checkDeviceId(method === "GET" || method === "DELETE" ? url.searchParams.get("device") : body.device);
      const self = { account: me, device };
      const named = () => ({ ...self, name: checkDeviceName(body.deviceName) });
      if (method === "POST" && path === "/api/devices/pair") return send(res, 200, { request: devices.requestPair(named(), body.to) });
      if (method === "GET" && path === "/api/devices/pair") return send(res, 200, devices.requests(self));
      if (method === "GET" && path === "/api/devices/pairs") return send(res, 200, { pairs: devices.pairs(self) });
      if (method === "POST" && path === "/api/devices/unpair") return send(res, 200, { ok: true, removed: devices.unpair(self, body.peerAccount, body.peerDevice) });
      const pm = /^\/api\/devices\/pair\/([^/]+)(\/answer)?$/.exec(path);
      if (pm && method === "POST" && pm[2]) return send(res, 200, devices.answer(named(), decodeURIComponent(pm[1]!), body.allow));
      if (pm && method === "DELETE" && !pm[2]) {
        devices.dismiss(self, decodeURIComponent(pm[1]!));
        return send(res, 200, { ok: true });
      }
      throw new RelayError("not_found", `没有这个接口：${method} ${path}`);
    }
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
      // An AI waiting on the asking side: what it gets counts as fetched (「AI 已取回」).
      const ai = url.searchParams.get("via") === "ai";
      const picked = (messages: Message[]) => {
        if (ai) for (const id of new Set(messages.map((m) => m.threadId))) pickedBy(id, me);
        return messages;
      };
      const after = Number(url.searchParams.get("after") ?? 0) || 0;
      const timeout = Math.max(0, Math.min(Number(url.searchParams.get("timeout") ?? 60_000) || 0, MAX_WAIT));
      // What already came while the caller was away answers at once.
      const pending = threadId
        ? store.messages(threadId, me, after).filter((m) => m.author !== me)
        : store.threadsFor(me).flatMap((t) => (t.lastSeq > after ? store.messages(t.id, me, after).filter((m) => m.author !== me) : []));
      if (pending.length || timeout === 0) return send(res, 200, { messages: picked(pending.sort((a, b) => a.seq - b.seq)) });
      await new Promise<void>((resolve) => {
        const w: Waiter = {
          name: me,
          threadId,
          after,
          done: (messages) => {
            clearTimeout(timer);
            waiters.delete(w);
            if (!res.writableEnded) send(res, 200, { messages: picked(messages) });
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

    if (method === "GET" && path === "/api/settings") return send(res, 200, { settings: store.settings() });
    if (method === "PUT" && path === "/api/settings") {
      const settings = store.saveSettings(await readJson(req));
      pushAll({ type: "settings", settings });
      return send(res, 200, { settings });
    }
    if (method === "GET" && path === "/api/tasks") return send(res, 200, { tasks: store.tasksFor(me) });
    if (method === "POST" && path === "/api/tasks") {
      const task = store.createTask(me, (await readJson(req)) as never);
      taskChanged(task.id);
      return send(res, 200, { task: store.taskView(task.id, me) });
    }
    // Files (2c) and their notes (2d). A task's are everyone's; a session's, its two people's.
    if (path === "/api/files" && (method === "POST" || method === "GET")) {
      const taskId = url.searchParams.get("task") || null;
      const threadId = url.searchParams.get("thread") || null;
      const slot = url.searchParams.get("slot") || null;
      if (method === "GET") return send(res, 200, { files: store.filesOf({ taskId: taskId ?? undefined, threadId: threadId ?? undefined }, me) });
      if (!opts.filesDir) throw new RelayError("bad_request", "这个服务没有开文件存储");
      const data = await readRaw(req, MAX_FILE_BYTES);
      if (!data.length) throw new RelayError("bad_request", "文件是空的");
      const id = `f_${randomBytes(8).toString("hex")}`;
      mkdirSync(opts.filesDir, { recursive: true });
      writeFileSync(join(opts.filesDir, id), data);
      let file;
      try {
        const type = url.searchParams.get("type") || String(req.headers["content-type"] ?? "") || "application/octet-stream";
        file = store.addFile(me, { id, taskId, threadId, slot, name: url.searchParams.get("name"), size: data.length, type, sha256: createHash("sha256").update(data).digest("hex"), via: url.searchParams.get("via") === "ai" ? { kind: "ai" } : undefined });
      } catch (err) {
        rmSync(join(opts.filesDir, id), { force: true });
        throw err;
      }
      fileChanged(file, me);
      return send(res, 200, { file });
    }
    const fm = /^\/api\/files\/([^/]+)(\/versions|\/notes)?$/.exec(path);
    if (fm) {
      const file = store.file(decodeURIComponent(fm[1]!), me);
      if (method === "GET" && !fm[2]) {
        const where = opts.filesDir ? join(opts.filesDir, file.id) : null;
        if (!where || !existsSync(where)) throw new RelayError("not_found", "文件的内容不在了");
        res.writeHead(200, {
          "content-type": file.type,
          "content-length": String(file.size),
          "cache-control": "private, max-age=31536000, immutable",
          // Opened straight from the service, an HTML file runs in a sandbox of its own, never on the service's origin.
          "content-security-policy": "sandbox",
          "x-content-type-options": "nosniff",
          "content-disposition": `${url.searchParams.get("download") ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        });
        createReadStream(where).pipe(res);
        return;
      }
      if (method === "GET" && fm[2] === "/versions") return send(res, 200, { files: store.versionsOf(file.id, me) });
      if (method === "GET" && fm[2] === "/notes") return send(res, 200, { notes: store.notesOf(file.id, me) });
      if (method === "POST" && fm[2] === "/notes") {
        const note = store.addNote(me, file.id, await readJson(req));
        notesChanged(file);
        return send(res, 200, { note });
      }
    }
    const nm = /^\/api\/notes\/([^/]+)$/.exec(path);
    if (nm && method === "DELETE") {
      const note = store.deleteNote(me, decodeURIComponent(nm[1]!));
      notesChanged(store.file(note.fileId, me));
      return send(res, 200, { ok: true });
    }

    const tk = /^\/api\/tasks\/([^/]+)(\/transfer|\/archive|\/seen)?$/.exec(path);
    if (tk) {
      const id = decodeURIComponent(tk[1]!);
      if (method === "GET" && !tk[2]) return send(res, 200, { task: store.taskView(id, me), events: store.taskEvents(id) });
      if (method === "PATCH" && !tk[2]) {
        store.updateTask(me, id, (await readJson(req)) as never);
        taskChanged(id);
        return send(res, 200, { task: store.taskView(id, me) });
      }
      if (method === "POST" && tk[2] === "/archive") {
        store.archiveTask(me, id, (await readJson(req)).archived !== false);
        taskChanged(id);
        return send(res, 200, { task: store.taskView(id, me) });
      }
      if (method === "POST" && tk[2] === "/seen") {
        store.markTaskSeen(id, me);
        return send(res, 200, { task: store.taskView(id, me) });
      }
      if (method === "POST" && tk[2] === "/transfer") {
        const body = await readJson(req);
        const via = body.via as never;
        store.transferTask(me, id, body as never);
        // 接手任务 from a session: answer it too — handed back when it needs a reply, else closed.
        const threadId = typeof body.threadId === "string" ? body.threadId : null;
        if (threadId && body.closeSession !== false) {
          const r = store.thread(threadId, me).request;
          const task = store.task(id);
          const note = `${task.holder === me ? "我接手了这个任务" : `任务交给了 ${task.holder}`}（${task.status}）${body.reason ? `：${String(body.reason)}` : ""}`;
          if (r && r.state !== "done") {
            const out = r.to === me && r.needsReply ? store.addMessage(threadId, me, { kind: "reply", body: note, via }) : store.sessionAction(threadId, me, "done", { note, via });
            announce(out.thread, out.message);
          }
        }
        taskChanged(id);
        return send(res, 200, { task: store.taskView(id, me) });
      }
    }

    const m = /^\/api\/threads\/([^/]+)(\/messages|\/read|\/archive|\/session|\/members|\/leave)?$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      if (method === "POST" && m[2] === "/members") {
        const out = store.addMembers(id, me, (await readJson(req)).add);
        // The new people get the thread (with its history) first, then everyone the event.
        for (const n of out.added) push([n], { type: "thread", thread: out.thread });
        announce(out.thread, out.message);
        return send(res, 200, { thread: out.thread });
      }
      if (method === "POST" && m[2] === "/leave") {
        const out = store.leaveGroup(id, me);
        push([me], { type: "left", threadId: id });
        announce(out.thread, out.message);
        return send(res, 200, { ok: true });
      }
      if (method === "PATCH" && !m[2]) {
        const out = store.renameThread(id, me, (await readJson(req)).title);
        announce(out.thread, out.message);
        return send(res, 200, { thread: out.thread });
      }
      if (method === "GET" && !m[2]) return send(res, 200, { thread: store.thread(id, me) });
      if (method === "POST" && m[2] === "/archive") {
        const archived = (await readJson(req)).archived !== false;
        store.setArchived(id, me, archived);
        push([me], { type: "archived", threadId: id, archived });
        return send(res, 200, { archived });
      }
      if (method === "POST" && m[2] === "/session") {
        const body = await readJson(req);
        const out = store.sessionAction(id, me, body.action as SessionAction, { via: body.via as never, note: body.note });
        announce(out.thread, out.message);
        return send(res, 200, out);
      }
      if (method === "GET" && m[2] === "/messages") {
        if (url.searchParams.get("via") === "ai") pickedBy(id, me);
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
    res.setHeader("access-control-allow-methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
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
  const deviceWss = new WebSocketServer({ noServer: true, maxPayload: MAX_DEVICE_FRAME });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://relay");
    // A device (devices.ts): the account's key and the device's id and name.
    if (url.pathname === "/api/devices/ws") {
      let me: { account: string; device: string; name: string };
      try {
        me = { account: auth(req, url), device: checkDeviceId(url.searchParams.get("device")), name: checkDeviceName(url.searchParams.get("name")) };
      } catch (err) {
        const unauthorized = err instanceof RelayError && err.code === "unauthorized";
        socket.write(unauthorized ? "HTTP/1.1 401 Unauthorized\r\n\r\n" : "HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }
      deviceWss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("message", (data) => devices.frame(me, String(data)));
        devices.connect(me, ws);
      });
      return;
    }
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
      devices.close();
      wss.close();
      deviceWss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
