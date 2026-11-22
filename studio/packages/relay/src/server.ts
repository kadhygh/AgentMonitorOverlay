import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pipeline } from "node:stream";
import { createGunzip } from "node:zlib";
import { WebSocketServer, type WebSocket } from "ws";
import { APK_NAME, PLATFORM_ZIP, PlatformFiles, SHA256, TOOL_ID, VERSION } from "./platform.js";
import { ANDROID_DOWNLOAD, PublicFiles, landingPage, sendFile, sendHtml, sendRanged } from "./public.js";
import { sendZip } from "./platform-zip.js";
import { MIRROR_TOOLS, type MirrorTool, type ToolMirror } from "./mirror.js";
import { adminPage } from "./admin-page.js";
import { ServerMonitor } from "./monitor.js";
import { issuesPage } from "./issues-page.js";
import { IssueStore } from "./issues.js";
import { MAX_FILE_BYTES, RELAY_APP, RELAY_VERSION, TICK_MS, type RelayFile, type Health, type Member, type Message, type RelayEvent, type SessionAction, type Thread } from "./protocol.js";
import { RelayError, type RelayStore } from "./store.js";
import { checkDeviceId, checkDeviceName, DeviceHub } from "./devices.js";
import { checkTodoDevice, TodoStore } from "./todo.js";
import { DEVICE_CHANNEL_VERSION, MAX_DEVICE_FRAME } from "./devices-protocol.js";
import { checkTransferDevice, cleanDeviceName, TransferStore } from "./transfers.js";
import { TRANSFER_CHUNK, type Transfer } from "./transfer-protocol.js";
import { CoworkStore } from "./cowork.js";
import { COWORK_INBOX_MAX_WAIT, COWORK_VERSION, type BoardOpRecord, type CoworkAgent, type CoworkClientFrame, type CoworkDelivery, type CoworkEvent } from "./cowork-protocol.js";

// The relay service (plans/done/relay.md): HTTP for everything, /ws to push new messages and who is online. People register
// with a name and password (plus the invite passphrase, when the service has one); a login hands the device a key that
// every other call carries (Authorization: Bearer, or ?key= for the WebSocket). Any origin may call it — the key, not a
// cookie, is the credential — so the desktop client's pages, loaded from disk, reach it. It also hands out the client
// (public.ts): / is the page to send people, /client/ and /app/ the client's content, /downloads/ its zip. With a
// platform dir it also hands out the AMO platform's tools to people signed in (platform.ts): /api/platform/channels,
// /api/platform/tools/<tool>/<version> and /platform/objects/<sha256>; and the Android app's newest build,
// /api/platform/android and /platform/android/<name>.apk (2026-10-31).

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
  /** Screenshots not on any issue are removed once this old (ms); default a week. Tests set it shorter. */
  orphanImageMs?: number;
  /** The AMO platform's files (platform.ts: channels, manifests, objects); none = the platform calls answer 404. */
  platformDir?: string;
  /** How often to look for a newer client build (default 5 s) and to send a tick (default TICK_MS). Tests shorten them. */
  clientWatchMs?: number;
  tickMs?: number;
  /** Devices (devices.ts): how often each is pinged (default 15 s) and how long unanswered means gone (default 60 s). */
  deviceHeartbeatMs?: number;
  deviceDeadMs?: number;
  /** The service's data folder: its size is shown on the admin page's 服务器状态, and the 24-hour curve is kept there
   *  (monitor.json); none = the curve only in memory. */
  dataDir?: string;
  /** How often 服务器状态 takes a point (default 5 min). Tests shorten it. */
  monitorEveryMs?: number;
  /** 工具镜像 (mirror.ts, 2026-11-03: Claude Code, Codex): their admin calls and, for people signed in, their files;
   *  none = 404. Started and closed by whoever made them (bin.ts). */
  mirrors?: Partial<Record<MirrorTool, ToolMirror>>;
  /** 传文件 (transfers.ts, 2026-11-23): where a send's content is kept; none = sends are refused. */
  transfersDir?: string;
  /** How often expired sends are cleared (default 10 min); the clock, free disk space and what to keep free (tests). */
  transferSweepMs?: number;
  transferNow?: () => number;
  transferFreeBytes?: (dir: string) => Promise<number>;
  transferReserveBytes?: number;
  /** 协作 (cowork.ts, 2026-11-23): how often run-out text locks, presence and agents gone 不在线 are looked for (default
   *  5 s), and the clock (tests). */
  coworkSweepMs?: number;
  coworkNow?: () => number;
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
/** The ports above 1023 that fetch (and browsers, by the Fetch standard's 「bad port」 list) will not connect to. */
export const FETCH_BAD_PORTS: ReadonlySet<number> = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

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
  /** A version's whole zip; an object missing or damaged on the server is said as such (409), not a crash. */
  const platformZip = async (tool: string, version: string) => {
    try {
      return await platform.zipOf(tool, version);
    } catch (err) {
      throw new RelayError("conflict", `服务器上 ${tool} ${version} 打不成完整包：${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const mirrorList = () => MIRROR_TOOLS.flatMap((t) => (opts.mirrors?.[t] ? [opts.mirrors[t]] : []));
  const mirrorOf = (tool: unknown): ToolMirror => {
    const m = MIRROR_TOOLS.includes(tool as MirrorTool) ? opts.mirrors?.[tool as MirrorTool] : undefined;
    if (!m) throw new RelayError("not_found", `这个服务没有开${typeof tool === "string" && tool ? ` ${tool.slice(0, 40)} 的` : ""}镜像`);
    return m;
  };
  // 问题页 (2026-10-31, plans/issues.md): its tables in the same database.
  const issues = new IssueStore(store.db);
  // Screenshots pasted for a report that was never sent: gone after a week, the bytes with them (2026-11-04, the 11-03
  // audit). At start and every 6 hours.
  const pruneImages = () => {
    for (const id of issues.pruneOrphanImages(opts.orphanImageMs ?? 7 * 24 * 3600_000)) if (opts.filesDir) rmSync(join(opts.filesDir, id), { force: true });
  };
  pruneImages();
  const pruneTimer = setInterval(pruneImages, 6 * 3600_000);
  pruneTimer.unref?.();
  // 待办 (2026-11-01, plans/done/todo.md): every account's todo lists, in the same database.
  const todo = new TodoStore(store.db);
  // 传文件 (2026-11-23, transfers.ts): sends between devices, in the same database; their content in transfersDir.
  const transfers = new TransferStore({ db: store.db, dir: opts.transfersDir, ...(opts.transferNow ? { now: opts.transferNow } : {}), ...(opts.transferFreeBytes ? { freeBytes: opts.transferFreeBytes } : {}), ...(opts.transferReserveBytes !== undefined ? { reserveBytes: opts.transferReserveBytes } : {}) });
  // 协作 (2026-11-23, cowork-protocol.ts): coworks, their agents, deliveries, drafts, events and board, in the same database.
  const cowork = new CoworkStore(store, opts.coworkNow ?? Date.now);
  const isMember = (n: string) => store.members().some((m) => m.name === n);
  const deviceOnline = (account: string, device: string) => [...(sockets.get(account) ?? [])].some((ws) => socketDevice.get(ws) === device);
  /** A send changed: to its people. Pieces come several a second: at most one push a second for those (`soon`). */
  const transferTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const transferPushedAt = new Map<string, number>();
  const transferChanged = (t: Transfer, soon = false) => {
    if (closing) return;
    const flush = () => {
      transferTimers.delete(t.id);
      transferPushedAt.set(t.id, Date.now());
      const now = transfers.peek(t.id);
      if (now) push(transfers.people(now), { type: "transfer", transfer: now });
    };
    if (!soon) {
      clearTimeout(transferTimers.get(t.id));
      return flush();
    }
    if (transferTimers.has(t.id)) return;
    const wait = 1000 - (Date.now() - (transferPushedAt.get(t.id) ?? 0));
    if (wait <= 0) return flush();
    transferTimers.set(t.id, setTimeout(flush, wait));
  };
  const sweepTransfers = () => {
    try {
      for (const t of transfers.sweep()) transferChanged(t);
    } catch {
      // the next sweep tries again
    }
  };
  sweepTransfers();
  const transferSweep = setInterval(sweepTransfers, opts.transferSweepMs ?? 10 * 60_000);
  transferSweep.unref?.();
  const sockets = new Map<string, Set<WebSocket>>();
  /** The device a /ws connection said it is (desktop clients with 传文件, 2026-11-23). */
  const socketDevice = new Map<WebSocket, string>();
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

  // 服务器状态 (monitor.ts, 2026-10-31): a point every 5 minutes, the rest worked out when the admin page asks.
  const monitor = new ServerMonitor({
    file: opts.dataDir ? join(opts.dataDir, "monitor.json") : undefined,
    dirs: [{ label: "数据", path: opts.dataDir }, { label: "平台发布", path: opts.platformDir }, { label: "客户端", path: opts.publicDir }],
    counts: () => ({ people: sockets.size, devices: devices.liveCount }),
    ...(opts.monitorEveryMs ? { everyMs: opts.monitorEveryMs } : {}),
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

  // ---- 协作's pushes (cowork-protocol.ts CoworkRelayEvent): to the cowork's people; drafts to their owner only.
  const coworkChanged = (id: string) => {
    if (!closing) push(cowork.people(id), { type: "cowork", cowork: cowork.view(id) });
  };
  const coworkEvents = (id: string, events: CoworkEvent[]) => {
    for (const event of events) push(cowork.people(id), { type: "cowork-event", coworkId: id, event });
  };
  /** What each agent was last pushed as (state, queue, name): a report that changes nothing is not pushed again. */
  const agentShown = new Map<string, string>();
  const pushAgent = (coworkId: string, agent: CoworkAgent | null) => {
    if (!agent) return;
    const key = `${coworkId} ${agent.mark}`;
    const now = `${agent.state}:${agent.queued}:${agent.name}`;
    if (agentShown.get(key) === now) return;
    agentShown.set(key, now);
    push(cowork.people(coworkId), { type: "cowork-agent", coworkId, agent });
  };
  /** The owner's Studio waiting on /api/cowork-inbox for its agents (marks starting with prefix). */
  const inboxWaiters = new Set<{ owner: string; prefix: string; done(): void }>();
  const deliveriesChanged = (list: CoworkDelivery[]) => {
    for (const d of list) {
      push(cowork.people(d.coworkId), { type: "cowork-delivery", coworkId: d.coworkId, delivery: d });
      pushAgent(d.coworkId, cowork.agent(d.coworkId, d.agent));
      if (d.state === "queued") for (const w of [...inboxWaiters]) if (w.owner === d.owner && d.agent.startsWith(w.prefix)) w.done();
    }
  };
  const boardPushed = (id: string, ops: BoardOpRecord[]) => {
    if (ops.length) push(cowork.people(id), { type: "board", coworkId: id, ops });
  };
  const lockPushed = (id: string, card: string) => push(cowork.people(id), { type: "board-lock", coworkId: id, card, lock: cowork.board.lockOf(id, card) });
  const presencePushed = (id: string) => push(cowork.people(id), { type: "board-presence", coworkId: id, presence: cowork.board.presenceOf(id) });
  /** A message in a cowork's thread went out: to its people, then the agents it woke; a 子会话 moved the cowork's list. */
  const coworkPosted = (out: { thread: Thread; message: Message; deliveries: CoworkDelivery[] }) => {
    announce(out.thread, out.message);
    deliveriesChanged(out.deliveries);
    if (out.thread.kind === "request" && out.thread.request?.coworkId) coworkChanged(out.thread.request.coworkId);
  };
  // Text locks and presence that ran out, agents whose Studio stopped reporting (不在线).
  const coworkSweep = setInterval(() => {
    if (closing) return;
    try {
      for (const l of cowork.board.sweepLocks()) lockPushed(l.coworkId, l.card);
      for (const id of cowork.board.sweepPresence()) presencePushed(id);
      for (const a of cowork.activeAgents()) pushAgent(a.coworkId, a.agent);
    } catch {
      // the next sweep tries again
    }
  }, opts.coworkSweepMs ?? 5000);
  coworkSweep.unref?.();

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
      const health: Health = { app: RELAY_APP, version: RELAY_VERSION, name: serviceName, invite: inviteNeeded(), client: files.manifest()?.version ?? null, shell: files.shell(), devices: DEVICE_CHANNEL_VERSION, cowork: COWORK_VERSION };
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
    // 问题页 (2026-10-31): the page is plain; what it shows and does takes the team account (/api/issues below).
    if (method === "GET" && path === "/issues") return sendHtml(res, issuesPage(serviceName));
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
      if (method === "GET" && path === "/api/admin/mirror") {
        if (!mirrorList().length) throw new RelayError("not_found", "这个服务没有开工具镜像");
        return send(res, 200, { tools: mirrorList().map((m) => m.adminView()) });
      }
      if (method === "GET" && path === "/api/admin/monitor") {
        return send(res, 200, { everyMs: monitor.intervalMs, now: await monitor.now(), history: monitor.history() });
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
      // 维护者 (2026-11-03, the user): sees every issue on 问题页 and reviews the others' reports.
      if (method === "POST" && path === "/api/admin/maintainer") {
        store.setMaintainer(body.name, body.maintainer !== false);
        return send(res, 200, { ok: true });
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
      // 工具镜像 (mirror.ts): a card per tool on the admin page; the body says which tool.
      if (path.startsWith("/api/admin/mirror")) {
        const mirror = mirrorOf(body.tool);
        const { tool: _tool, ...settings } = body as Record<string, unknown>;
        if (method === "POST" && path === "/api/admin/mirror/settings") {
          mirror.saveSettings(settings);
          return send(res, 200, mirror.adminView());
        }
        if (method === "POST" && path === "/api/admin/mirror/check") {
          if (!mirror.settings().enabled) throw new RelayError("conflict", `${mirror.source.name} 镜像关着：先打开它`);
          // Answered at once; the page follows the check by asking again. A failure is the check's own (status.error).
          mirror.checkNow().catch(() => undefined);
          return send(res, 200, mirror.adminView());
        }
      }
      throw new RelayError("not_found", "没有这个管理操作");
    }
    // The AMO platform's files (platform.ts, plans/amo-lan-platform.md): for people signed in; objects also take ?key=,
    // so a download can be a plain URL.
    // 工具镜像 (mirror.ts, 2026-11-03), for people signed in like the platform's files: what is ready (/api/platform/mirror/
    // <tool>), a ready version's own file (Claude Code: Anthropic's manifest) and its platform files with Range (a broken
    // download goes on).
    if (method === "GET" && (path.startsWith("/api/platform/mirror/") || path.startsWith("/platform/mirror/"))) {
      auth(req, url);
      const api = path.startsWith("/api/");
      const [tool = "", ...parts] = path.slice(api ? "/api/platform/mirror/".length : "/platform/mirror/".length).split("/");
      const mirror = mirrorOf(tool);
      if (api && !parts.length) return send(res, 200, mirror.platformView());
      if (!api && parts.length === 2) {
        const file = mirror.metaFile(parts[0]!, parts[1]!);
        if (!file) throw new RelayError("not_found", `镜像里没有 ${parts.join(" ")}`);
        return sendFile(res, file);
      }
      if (!api && parts.length === 3) {
        const got = mirror.file(parts[0]!, parts[1]!);
        if (!got || basename(got.path) !== parts[2]) throw new RelayError("not_found", `镜像里没有 ${parts.join(" ")}`);
        return sendRanged(req, res, got.path, got.size);
      }
      throw new RelayError("not_found", `没有这个接口：${method} ${path}`);
    }
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
      // The Android app updates itself from here (2026-10-31, the user).
      if (path === "/api/platform/android") {
        const latest = platform.androidLatest();
        if (!latest) throw new RelayError("not_found", "服务器上还没有发布安卓版");
        return send(res, 200, latest);
      }
      const am = /^\/platform\/android\/([^/]+)$/.exec(path);
      if (am) {
        const name = part(am[1]!);
        if (!APK_NAME.test(name)) throw new RelayError("bad_request", `安装包的名字不对：${name}`);
        const file = platform.apk(name);
        if (!file) throw new RelayError("not_found", `服务器上没有 ${name}`);
        return sendFile(res, file, true);
      }
      // A version's manifest, or (/summary, 2026-11-03) all of it but the file list: what the platform shows. The
      // manifest goes minified, gzipped to a client that takes it (Studio's: 2.3 MB as written, 0.53 MB so).
      const tm = /^\/api\/platform\/tools\/([^/]+)\/([^/]+)(\/summary)?$/.exec(path);
      if (tm) {
        const [tool, version] = [part(tm[1]!), part(tm[2]!)];
        if (!TOOL_ID.test(tool)) throw new RelayError("bad_request", `工具名不对：${tool}`);
        if (!VERSION.test(version)) throw new RelayError("bad_request", `版本号不对：${version}`);
        const served = platform.manifestServed(tool, version);
        if (!served) throw new RelayError("not_found", `${tool} 还没有发布 ${version}`);
        if (tm[3]) return send(res, 200, served.summary);
        const gzipped = acceptsGzip(req.headers["accept-encoding"]);
        const body = gzipped ? served.gzip : served.json;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": String(body.length), vary: "accept-encoding", ...(gzipped ? { "content-encoding": "gzip" } : {}) });
        res.end(body);
        return;
      }
      // A version's whole program as one zip (platform-zip.ts, 2026-11-03): the platform's 更新 page falls back on it when
      // the update file by file does not go through. Range and If-Range, so a broken download goes on.
      const zm = /^\/platform\/zip\/([^/]+)\/([^/]+)$/.exec(path);
      if (zm) {
        const [tool, version] = [part(zm[1]!), part(zm[2]!)];
        if (!TOOL_ID.test(tool)) throw new RelayError("bad_request", `工具名不对：${tool}`);
        if (!VERSION.test(version)) throw new RelayError("bad_request", `版本号不对：${version}`);
        const zip = await platformZip(tool, version);
        if (!zip) throw new RelayError("not_found", `${tool} 还没有发布 ${version}`);
        return sendZip(req, res, zip.layout, zip.filename);
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
      // The platform's own zip (2026-11-03, the user: each release updates the page's too): made from the newest
      // published platform; only when none is published, the one put by hand (downloads/ beside the client's, or in the
      // platform dir).
      const newest = platform.dir ? platform.newestPlatform() : null;
      const made = newest && (path === "/" || path === "/index.html" || path === `/downloads/${PLATFORM_ZIP}`) ? await platformZip("platform", newest).catch(() => null) : null;
      const platformZipFile = made ? null : (files.file("downloads", PLATFORM_ZIP) ?? platform.zip());
      // The Android app's newest build, for anyone on the page (2026-11-02, the user: a phone installs it from here without
      // signing in; it pairs only after signing in). Updates still go through /platform/android/ (signed in).
      const android = platform.dir ? platform.androidLatest() : null;
      const pageZip = made ? { size: made.layout.size, version: newest! } : platformZipFile ? { size: statSync(platformZipFile).size } : null;
      if (path === "/" || path === "/index.html") return sendHtml(res, landingPage(serviceName, files.manifest(), files.downloads().filter((f) => f.name !== PLATFORM_ZIP), pageZip, android));
      if (path === `/downloads/${PLATFORM_ZIP}` && made) return sendZip(req, res, made.layout, `AMO-Platform-win-${newest}.zip`);
      if (path === `/downloads/${PLATFORM_ZIP}` && platformZipFile) return sendFile(res, platformZipFile, true);
      if (path === ANDROID_DOWNLOAD) {
        const file = android ? platform.apk(android.file) : null;
        if (!file) throw new RelayError("not_found", "服务器上还没有发布安卓版");
        return sendFile(res, file, true);
      }
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

    // 问题页 (2026-10-31, plans/issues.md): issues, their entries and screenshots, 发布打包. Studio's 值守 reads and
    // answers them with the person's account (`ai` marks what its AI wrote).
    if (path === "/api/issues" || path.startsWith("/api/issues/")) {
      // 维护者 (2026-11-03): who asks decides what they see and may do.
      const who = { name: me, maintainer: store.isMaintainer(me) };
      if (method === "GET" && path === "/api/issues") {
        const after = Number(url.searchParams.get("after") ?? 0);
        return send(res, 200, issues.list(who, Number.isFinite(after) && after > 0 ? after : undefined));
      }
      if (method === "POST" && path === "/api/issues") return send(res, 200, { issue: issues.create(who, (await readJson(req)) as never) });
      if (method === "POST" && path === "/api/issues/images") {
        if (!opts.filesDir) throw new RelayError("bad_request", "这个服务没有开文件存储，不能传截图");
        const data = await readRaw(req, MAX_FILE_BYTES);
        if (!data.length) throw new RelayError("bad_request", "图片是空的");
        const id = `ii_${randomBytes(8).toString("hex")}`;
        const image = issues.addImage(me, { id, name: url.searchParams.get("name"), type: url.searchParams.get("type") || req.headers["content-type"], size: data.length });
        mkdirSync(opts.filesDir, { recursive: true });
        await writeFile(join(opts.filesDir, id), data);
        return send(res, 200, { image });
      }
      const im = /^\/api\/issues\/images\/(ii_[0-9a-f]{16})$/.exec(path);
      if (im && method === "GET") {
        const image = issues.image(who, im[1]!);
        const where = opts.filesDir ? join(opts.filesDir, image.id) : null;
        if (!where || !existsSync(where)) throw new RelayError("not_found", "图片的内容不在了");
        res.writeHead(200, { "content-type": image.type, "content-length": String(image.size), "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff", "content-security-policy": "sandbox" });
        createReadStream(where).pipe(res);
        return;
      }
      if (method === "POST" && path === "/api/issues/release") {
        const body = await readJson(req);
        return send(res, 200, { release: issues.requestRelease(who, body.on !== false) });
      }
      if (method === "POST" && path === "/api/issues/release/done") {
        const body = await readJson(req);
        return send(res, 200, issues.released(who, body.version, body.numbers));
      }
      // `npm run release` says where its test build is (2026-10-31): the page shows it.
      if (method === "POST" && path === "/api/issues/release/build") return send(res, 200, { release: issues.reportBuild(me, (await readJson(req)) as never) });
      const nm = /^\/api\/issues\/(\d+)(\/entries)?$/.exec(path);
      if (nm) {
        const number = Number(nm[1]);
        if (method === "GET" && !nm[2]) return send(res, 200, { issue: issues.get(who, number) });
        if (method === "POST" && nm[2]) return send(res, 200, { issue: issues.addEntry(who, number, (await readJson(req)) as never) });
        if (method === "PATCH" && !nm[2]) return send(res, 200, { issue: issues.update(who, number, (await readJson(req)) as never) });
      }
      throw new RelayError("not_found", `没有这个接口：${method} ${path}`);
    }

    // Devices (devices-protocol.ts): pairing requests and pairs, each call naming the calling device of this account.
    if (path === "/api/devices/pair" || path === "/api/devices/pairs" || path === "/api/devices/unpair" || path === "/api/devices/online" || path.startsWith("/api/devices/pair/")) {
      const body = method === "GET" || method === "DELETE" ? {} : await readJson(req);
      const device = checkDeviceId(method === "GET" || method === "DELETE" ? url.searchParams.get("device") : body.device);
      const self = { account: me, device };
      const named = () => ({ ...self, name: checkDeviceName(body.deviceName) });
      if (method === "POST" && path === "/api/devices/pair") return send(res, 200, { request: devices.requestPair(named(), body.to, body.toDevice) });
      // 远程页的配对弹窗 (2026-10-29): the account's other devices online now, to pick one to pair with.
      if (method === "GET" && path === "/api/devices/online") return send(res, 200, { devices: devices.onlineDevices(self) });
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
    // 待办 (todo-protocol.ts): the account's lists, each call naming the calling device.
    if (method === "GET" && path === "/api/todo") {
      const device = checkTodoDevice(url.searchParams.get("device"), url.searchParams.get("deviceName"));
      return send(res, 200, todo.snapshot(me, device, Number(url.searchParams.get("since") ?? 0)));
    }
    if (method === "POST" && path === "/api/todo/ops") {
      const body = await readJson(req);
      return send(res, 200, todo.apply(me, checkTodoDevice(body.device, body.deviceName), body.ops));
    }
    // 传文件 (transfer-protocol.ts, 2026-11-23): sends to chosen devices of chosen people, through the service.
    if (path === "/api/transfers" || path.startsWith("/api/transfers/") || path === "/api/transfer-devices") {
      if (method === "GET" && path === "/api/transfer-devices") return send(res, 200, { devices: transfers.devices(isMember, deviceOnline) });
      if (method === "GET" && path === "/api/transfers") return send(res, 200, { transfers: transfers.list(me) });
      if (method === "POST" && path === "/api/transfers") {
        const t = await transfers.create(me, await readJson(req), isMember);
        transferChanged(t);
        return send(res, 200, { transfer: t });
      }
      const xm = /^\/api\/transfers\/(x_[0-9a-f]{16})(?:\/(answer|progress|cancel)|\/files\/(\d+))?$/.exec(path);
      if (!xm) throw new RelayError("not_found", `没有这个接口：${method} ${path}`);
      const id = xm[1]!;
      if (method === "GET" && !xm[2] && !xm[3]) return send(res, 200, { transfer: transfers.get(id, me) });
      if (method === "POST" && xm[2]) {
        const body = await readJson(req);
        const t =
          xm[2] === "answer" ? transfers.answer(me, id, body.device, body.accept !== false) : xm[2] === "progress" ? transfers.progress(me, id, body.device, body.got, body.done === true) : transfers.cancel(me, id);
        transferChanged(t, xm[2] === "progress" && t.state === "open" && body.done !== true);
        return send(res, 200, { transfer: t });
      }
      // A piece of a file: the raw bytes, where it goes in the query (offset, the whole file's sha256, the device).
      if (method === "PUT" && xm[3]) {
        if (Number(req.headers["content-length"] ?? 0) > TRANSFER_CHUNK) throw new RelayError("bad_request", `一块最多 ${TRANSFER_CHUNK / 1024 / 1024} MB`);
        const data = await readRaw(req, TRANSFER_CHUNK);
        const out = await transfers.writePiece(me, id, xm[3], { device: url.searchParams.get("device"), offset: url.searchParams.get("offset"), sha256: url.searchParams.get("sha256") }, data);
        // Spaced out (a push carries the whole send) until the last file is complete.
        transferChanged({ id } as Transfer, !out.allDone);
        return send(res, 200, { file: out.file });
      }
      if (method === "GET" && xm[3]) {
        const got = transfers.download(me, id, xm[3], url.searchParams.get("device"));
        return sendRanged(req, res, got.path, got.size);
      }
      throw new RelayError("not_found", `没有这个接口：${method} ${path}`);
    }
    // 协作 (cowork-protocol.ts, 2026-11-23).
    if (path === "/api/cowork" || path.startsWith("/api/cowork/") || path === "/api/cowork-inbox" || path === "/api/cowork-inbox/ack") {
      if (method === "GET" && path === "/api/cowork") return send(res, 200, { coworks: cowork.list(me) });
      if (method === "POST" && path === "/api/cowork") {
        const out = cowork.create(me, (await readJson(req)) as never);
        announce(store.threadById(out.cowork.id), out.message);
        coworkChanged(out.cowork.id);
        coworkEvents(out.cowork.id, out.events);
        return send(res, 200, { cowork: out.cowork });
      }
      if (method === "POST" && path === "/api/cowork/agents/status") {
        const touched = cowork.reportStatus(me, await readJson(req));
        for (const a of touched) pushAgent(a.coworkId, a.agent);
        return send(res, 200, { agents: touched });
      }
      // The owner's Studio: what its agents have waiting. `wait` (ms): when nothing is, answer once something is queued.
      if (method === "GET" && path === "/api/cowork-inbox") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const wait = Math.max(0, Math.min(Number(url.searchParams.get("wait") ?? 0) || 0, COWORK_INBOX_MAX_WAIT));
        if (wait > 0 && !cowork.hasQueued(me, prefix)) {
          await new Promise<void>((resolve) => {
            const w = {
              owner: me,
              prefix,
              done: () => {
                clearTimeout(timer);
                inboxWaiters.delete(w);
                resolve();
              },
            };
            const timer = setTimeout(w.done, wait);
            inboxWaiters.add(w);
            req.on("close", w.done);
          });
          if (res.writableEnded || closing) return;
        }
        return send(res, 200, cowork.inbox(me, prefix));
      }
      if (method === "POST" && path === "/api/cowork-inbox/ack") {
        const moved = cowork.ack(me, (await readJson(req)).ids);
        deliveriesChanged(moved);
        return send(res, 200, { deliveries: moved });
      }
      const cm = /^\/api\/cowork\/(t_[0-9a-f]{16})((?:\/[a-z]+)*?)(?:\/(t_[0-9a-f]{16}|dr_[0-9a-f]{16})(\/conclude)?)?$/.exec(path);
      if (!cm) throw new RelayError("not_found", `没有这个接口：${method} ${path}`);
      const id = cm[1]!;
      const sub = cm[2] ?? "";
      const target = cm[3];
      if (!target) {
        if (method === "GET" && sub === "") return send(res, 200, cowork.detail(id, me));
        if (method === "PATCH" && sub === "") {
          const out = cowork.update(id, me, (await readJson(req)) as never);
          if (out.events.length) {
            coworkChanged(id);
            coworkEvents(id, out.events);
          }
          return send(res, 200, { cowork: out.cowork });
        }
        if (method === "GET" && sub === "/goals") return send(res, 200, { goals: cowork.goals(id, me) });
        if (method === "GET" && sub === "/events") return send(res, 200, { events: cowork.events(id, me, Number(url.searchParams.get("after") ?? 0) || 0) });
        if (method === "GET" && sub === "/feed") return send(res, 200, cowork.feed(id, me, Number(url.searchParams.get("after") ?? 0) || 0, url.searchParams.get("agent")));
        if (method === "GET" && sub === "/drafts") return send(res, 200, { drafts: cowork.drafts(id, me) });
        if (method === "GET" && sub === "/board") return send(res, 200, cowork.boardSnapshot(id, me, Number(url.searchParams.get("after") ?? 0) || 0));
        if (method === "GET" && sub === "/board/history") return send(res, 200, { ops: cowork.boardHistory(id, me, url.searchParams.get("card") ?? "") });
        const body = method === "POST" ? await readJson(req) : null;
        if (body && sub === "/events") {
          const out = cowork.addEvent(id, me, body as never);
          coworkEvents(id, [out.event, ...(out.board?.events ?? [])]);
          if (out.board) {
            boardPushed(id, out.board.result.applied);
            coworkChanged(id);
          }
          return send(res, 200, { event: out.event, board: out.board?.result ?? null });
        }
        if (body && sub === "/members") {
          const out = cowork.addMembers(id, me, body.add);
          for (const n of out.added) push([n], { type: "thread", thread: store.threadById(id) });
          announce(store.threadById(id), out.message);
          coworkChanged(id);
          coworkEvents(id, out.events);
          return send(res, 200, { cowork: out.cowork });
        }
        if (body && sub === "/leave") {
          const out = cowork.leave(id, me);
          push([me], { type: "cowork-left", coworkId: id });
          push([me], { type: "left", threadId: id });
          for (const l of cowork.board.releaseAll(me, id)) lockPushed(l.coworkId, l.card);
          cowork.board.setPresence(id, me, null);
          presencePushed(id);
          announce(store.threadById(id), out.message);
          coworkChanged(id);
          coworkEvents(id, out.events);
          deliveriesChanged(out.dropped);
          return send(res, 200, { ok: true });
        }
        if (body && sub === "/agents") {
          const out = cowork.joinAgent(id, me, body.mark, body.label);
          if (out.message) announce(store.threadById(id), out.message);
          coworkChanged(id);
          coworkEvents(id, out.events);
          return send(res, 200, { cowork: out.cowork, agent: out.agent });
        }
        if (body && sub === "/agents/leave") {
          const out = cowork.leaveAgent(id, me, body.mark);
          announce(store.threadById(id), out.message);
          coworkChanged(id);
          coworkEvents(id, out.events);
          deliveriesChanged(out.dropped);
          return send(res, 200, { cowork: out.cowork });
        }
        if (body && sub === "/messages") {
          const threadId = typeof body.threadId === "string" && body.threadId ? body.threadId : id;
          if (threadId !== id && store.thread(threadId, me).request?.coworkId !== id) throw new RelayError("bad_request", "threadId 要是这个协作的群聊或它的子会话");
          const out = cowork.post(threadId, me, body as never);
          if (out.draft) push([me], { type: "cowork-draft", coworkId: id, draft: out.draft });
          else coworkPosted(out);
          return send(res, 200, out);
        }
        if (body && sub === "/sessions") {
          const out = cowork.ask(id, me, body as never);
          if (out.draft) push([me], { type: "cowork-draft", coworkId: id, draft: out.draft });
          else {
            announce(out.thread, out.message);
            if (out.card) announce(out.card.thread, out.card.message);
            coworkChanged(id);
          }
          return send(res, 200, out.draft ? { draft: out.draft } : { thread: out.thread, message: out.message });
        }
        if (body && sub === "/board/ops") {
          const before = cowork.board.seq(id);
          const out = cowork.boardApply(id, me, body);
          // A repeated operation (its opId seen before) is answered again, not pushed again.
          const fresh = out.result.applied.filter((r) => r.seq > before);
          boardPushed(id, fresh);
          coworkEvents(id, out.events);
          return send(res, 200, out.result);
        }
        if (body && sub === "/board/lock") {
          const lock = cowork.boardLock(id, me, body);
          lockPushed(id, String(body.card));
          return send(res, 200, { lock });
        }
        if (body && sub === "/board/presence") {
          const presence = cowork.boardPresence(id, me, body);
          presencePushed(id);
          return send(res, 200, { presence });
        }
      } else if (method === "POST" && sub === "/sessions" && cm[4] === "/conclude") {
        const out = cowork.conclude(id, target, me, await readJson(req));
        announce(out.thread, out.message);
        coworkChanged(id);
        coworkEvents(id, [out.event]);
        return send(res, 200, { thread: out.thread, event: out.event });
      } else if (method === "POST" && sub === "/drafts" && !cm[4]) {
        const out = cowork.decideDraft(id, target, me, (await readJson(req)) as never);
        push([me], { type: "cowork-draft", coworkId: id, draft: out.draft });
        if (out.post?.thread) coworkPosted(out.post as { thread: Thread; message: Message; deliveries: CoworkDelivery[] });
        if (out.ask?.thread) {
          announce(out.ask.thread, out.ask.message!);
          if (out.ask.card) announce(out.ask.card.thread, out.ask.card.message);
          coworkChanged(id);
        }
        return send(res, 200, { draft: out.draft });
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
      // A 子会话 (协作): the cowork's way, so an agent's waits as a draft when it should.
      if (typeof body.coworkId === "string" && body.coworkId) {
        const out = cowork.ask(body.coworkId, me, body as never);
        if (out.draft) {
          push([me], { type: "cowork-draft", coworkId: body.coworkId, draft: out.draft });
          return send(res, 200, { draft: out.draft });
        }
        announce(out.thread, out.message);
        if (out.card) announce(out.card.thread, out.card.message);
        coworkChanged(body.coworkId);
        return send(res, 200, { thread: out.thread, message: out.message });
      }
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
      await writeFile(join(opts.filesDir, id), data);
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
      // A cowork's 群聊 and 子会话 go the cowork's way (its members, agents, deliveries, drafts).
      const known = store.thread(id, me);
      const cw = known.kind === "cowork" ? id : (known.request?.coworkId ?? null);
      if (cw && method === "POST" && m[2] === "/messages") {
        const out = cowork.post(id, me, (await readJson(req)) as never);
        if (out.draft) push([me], { type: "cowork-draft", coworkId: cw, draft: out.draft });
        else coworkPosted(out);
        return send(res, 200, out);
      }
      if (cw === id && method === "POST" && (m[2] === "/members" || m[2] === "/leave")) throw new RelayError("bad_request", "协作拉人、退出走 /api/cowork/:id/members、/api/cowork/:id/leave");
      if (cw === id && method === "PATCH" && !m[2]) {
        const out = cowork.update(id, me, { title: (await readJson(req)).title as string });
        coworkChanged(id);
        coworkEvents(id, out.events);
        return send(res, 200, { thread: store.thread(id, me) });
      }
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
        const out = store.sessionAction(id, me, body.action as SessionAction, { via: body.via as never, note: body.note, tellAi: body.tellAi === true });
        announce(out.thread, out.message);
        if (out.thread.request?.coworkId) {
          const event = cowork.afterSessionAction(out.thread, me, String(body.action), body.note, body.via);
          if (event) coworkEvents(out.thread.request.coworkId, [event]);
          coworkChanged(out.thread.request.coworkId);
        }
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
    // A desktop client with 传文件 says which device it is: kept, so it is offered to send to, and online while connected.
    let device: string | null = null;
    try {
      if (url.searchParams.get("device")) device = checkTransferDevice(url.searchParams.get("device"));
    } catch {
      device = null;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (device) {
        socketDevice.set(ws, device);
        transfers.seenDevice(name, device, cleanDeviceName(url.searchParams.get("deviceName")));
      }
      const set = sockets.get(name) ?? new Set();
      const wasOnline = set.size > 0;
      set.add(ws);
      sockets.set(name, set);
      ws.send(JSON.stringify({ type: "hello", me: name, client: clientVersion } satisfies RelayEvent));
      if (!wasOnline) pushMembers();
      // 协作's board presence (cowork-protocol.ts CoworkClientFrame): the only thing a client sends here. Bad frames are
      // ignored; ten a second per connection at most.
      let framesAt = 0;
      let frames = 0;
      ws.on("message", (data) => {
        const at = Date.now();
        if (at - framesAt > 1000) [framesAt, frames] = [at, 0];
        if (++frames > 10 || closing) return;
        try {
          const f = JSON.parse(String(data)) as CoworkClientFrame;
          if (f?.type !== "board-presence" || typeof f.coworkId !== "string") return;
          cowork.boardPresence(f.coworkId, name, f);
          presencePushed(f.coworkId);
        } catch {
          // not one of ours, or not in that cowork
        }
      });
      ws.on("close", () => {
        set.delete(ws);
        lastSeen.set(name, Date.now());
        if (device && !closing) {
          socketDevice.delete(ws);
          transfers.seenDevice(name, device, cleanDeviceName(url.searchParams.get("deviceName")));
        }
        if (!set.size) {
          sockets.delete(name);
          pushMembers();
          // Gone: their text locks and board presence go too (plans/cowork.md: 断线也放开).
          if (!closing) {
            for (const l of cowork.board.releaseAll(name)) lockPushed(l.coworkId, l.card);
            for (const id of cowork.board.dropPresence(name)) presencePushed(id);
          }
        }
      });
    });
  });

  const listen = (): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port ?? 0, opts.host ?? "0.0.0.0", () => {
        server.off("error", reject);
        resolve((server.address() as AddressInfo).port);
      });
    });
  let port = await listen();
  // A port the system picks (port 0, as every test does) can be one fetch refuses outright — 「fetch failed」, cause
  // 「bad port」 — and this machine hands out 1024–15000, where 5060 and the like are: 自动打包 (Studio 0.9.73, 2026-11-16)
  // stopped on todo.test.ts's relay at 127.0.0.1:5060. Take another one then; a port asked for by number stays as it is.
  for (let tries = 0; !opts.port && FETCH_BAD_PORTS.has(port) && tries < 10; tries++) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    port = await listen();
  }
  const shownHost = !opts.host || opts.host === "0.0.0.0" ? "127.0.0.1" : opts.host;
  return {
    url: `http://${shownHost}:${port}`,
    port,
    close: async () => {
      closing = true;
      clearInterval(watchClient);
      clearInterval(tick);
      clearInterval(pruneTimer);
      clearInterval(transferSweep);
      clearInterval(coworkSweep);
      for (const w of [...inboxWaiters]) w.done();
      for (const t of transferTimers.values()) clearTimeout(t);
      for (const w of [...waiters]) w.done([]);
      for (const set of sockets.values()) for (const ws of set) ws.terminate();
      devices.close();
      monitor.close();
      wss.close();
      deviceWss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
