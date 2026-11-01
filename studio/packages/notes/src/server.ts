import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { Scratchpad, TodoOp, TodoView } from "@amo-studio/protocol";
import { NotesError, type NotesStore } from "./store.js";

// The 便签 program's own small server (2026-10-23), on 127.0.0.1 with a token. It answers the few Host routes the
// scratchpad window uses (so that window works unchanged against it), serves the UI build, and adds its own routes
// (/api/notes/...) for the settings window and for AMO Studio, which finds it through running.json.

/** What the program itself does when asked (windows, the shortcut, Windows' login items). */
export interface NotesShell {
  show(): void;
  openSettings(): void;
  /** Registers the shortcut in the settings; the error when another program holds it. */
  applyShortcut(): { active: string; error: string | null };
  shortcutStatus(): { wanted: string; active: string; error: string | null };
  setOpenAtLogin(on: boolean): void;
  /** The windows take the zoom in the settings. */
  applyLook(): void;
  openPath(path: string): Promise<void>;
  /** 待办 (2026-11-01): its copy and sync (todo.ts), its window, and 使用待办 turned on or off. */
  todo: { view(): TodoView; change(ops: TodoOp[]): TodoView; sync(): Promise<void> };
  showTodo(): void;
  applyTodo(): void;
  /** 在 AMO 平台里登录: opens the platform (programs.json); false when it is not installed. */
  openPlatform(): boolean;
}

export interface NotesServer {
  url: string;
  token: string;
  close(): Promise<void>;
  /** Tells every window the document changed (also used after a folder switch). */
  announce(): void;
  /** Tells every window 待办 changed. */
  announceTodo(view: TodoView): void;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".wasm": "application/wasm",
};
const STATUS: Record<NotesError["code"], number> = { bad_request: 400, not_found: 404, conflict: 409 };
const MAX_BODY = 25 * 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new NotesError("bad_request", "file too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readBody(req)).toString("utf8");
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    return o && typeof o === "object" ? (o as Record<string, unknown>) : {};
  } catch {
    throw new NotesError("bad_request", "the body is not JSON");
  }
}

export function startNotesServer(o: { store: NotesStore; shell: NotesShell; uiDir: string; port?: number }): Promise<NotesServer> {
  const { store, shell } = o;
  const token = randomBytes(24).toString("hex");
  const tokenBuf = Buffer.from(token);
  const sockets = new Set<WebSocket>();
  let seq = 0;

  const authorised = (req: IncomingMessage, url: URL): boolean => {
    const header = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token") ?? "";
    const given = Buffer.from(header);
    return given.length === tokenBuf.length && timingSafeEqual(given, tokenBuf);
  };

  const announce = (scratchpad: Scratchpad = store.scratchpad()) => {
    const msg = JSON.stringify({ type: "scratchpad.updated", scratchpad, seq: ++seq });
    for (const ws of sockets) ws.send(msg);
  };
  const changed = (s: Scratchpad) => {
    announce(s);
    return s;
  };

  /** The page the settings window shows. */
  const notesInfo = () => ({
    settings: store.settings(),
    home: store.home,
    settingsFile: store.settingsFile,
    folder: store.folder,
    defaultFolder: store.defaultFolder,
    cacheDir: store.cacheDir,
    usage: store.usage(),
    shortcut: shell.shortcutStatus(),
  });

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const m = req.method ?? "GET";
    const p = url.pathname;
    // The routes the scratchpad window uses, as the Host has them.
    if (m === "GET" && p === "/api/state") return send(res, 200, { workspaces: [], topics: [], tasks: [], sessions: [], profiles: [], eventSeq: seq });
    if (m === "GET" && p === "/api/scratchpad") return send(res, 200, store.scratchpad());
    if (m === "PATCH" && p === "/api/scratchpad") return send(res, 200, changed(store.update(await json(req))));
    const page = /^\/api\/scratchpad\/pages\/(\d+)$/.exec(p);
    if (m === "PUT" && page) return send(res, 200, changed(store.savePage(page[1]!, await json(req))));
    if (m === "POST" && p === "/api/attachments") {
      const data = await readBody(req);
      return send(res, 201, store.saveImage(data, { mime: url.searchParams.get("type") ?? req.headers["content-type"], name: url.searchParams.get("name") ?? undefined }));
    }
    const image = /^\/api\/attachments\/([^/]+)$/.exec(p);
    if (m === "GET" && image) {
      const a = store.image(decodeURIComponent(image[1]!));
      if (!existsSync(a.path)) throw new NotesError("not_found", "image file missing");
      res.writeHead(200, { "content-type": a.mime, "cache-control": "private, max-age=31536000, immutable" });
      res.end(readFileSync(a.path));
      return;
    }
    if (m === "GET" && p === "/api/settings") {
      const s = store.settings();
      return send(res, 200, { scratchpadSafeNewlines: s.safeNewlines, scratchpadShortcut: s.shortcut });
    }

    // The program's own.
    if (m === "GET" && p === "/api/notes") return send(res, 200, notesInfo());
    if (m === "PATCH" && p === "/api/notes/settings") {
      const body = await json(req);
      const before = store.settings();
      store.updateSettings({
        ...(body.shortcut !== undefined ? { shortcut: body.shortcut } : {}),
        ...(body.safeNewlines !== undefined ? { safeNewlines: body.safeNewlines } : {}),
        ...(body.openAtLogin !== undefined ? { openAtLogin: body.openAtLogin } : {}),
        ...(body.importNoticeSeen !== undefined ? { importNoticeSeen: body.importNoticeSeen } : {}),
        ...(body.uiScale !== undefined ? { uiScale: body.uiScale } : {}),
        ...(body.theme !== undefined ? { theme: body.theme } : {}),
        ...(body.useTodo !== undefined ? { useTodo: body.useTodo } : {}),
        ...(body.todoKeepDays !== undefined ? { todoKeepDays: body.todoKeepDays } : {}),
      });
      const after = store.settings();
      if (after.useTodo !== before.useTodo || after.todoKeepDays !== before.todoKeepDays) shell.applyTodo();
      if (after.shortcut !== before.shortcut) shell.applyShortcut();
      if (after.openAtLogin !== before.openAtLogin) shell.setOpenAtLogin(after.openAtLogin);
      if (after.uiScale !== before.uiScale || after.theme !== before.theme) shell.applyLook();
      announce();
      return send(res, 200, notesInfo());
    }
    if (m === "POST" && p === "/api/notes/folder") {
      const body = await json(req);
      if (typeof body.path !== "string" || !body.path.trim()) throw new NotesError("bad_request", "path is required");
      changed(store.changeFolder(body.path, body.move === true));
      return send(res, 200, notesInfo());
    }
    if (m === "POST" && p === "/api/notes/cache/clear") {
      const freed = store.clearCache();
      return send(res, 200, { freed, ...notesInfo() });
    }
    if (m === "POST" && p === "/api/notes/open") {
      const body = await json(req);
      const where = body.what === "folder" ? store.folder : body.what === "cache" ? store.cacheDir : body.what === "home" ? store.home : null;
      if (!where) throw new NotesError("bad_request", "what must be folder, cache or home");
      await shell.openPath(where);
      return send(res, 200, {});
    }
    if (m === "POST" && p === "/api/notes/show") {
      shell.show();
      return send(res, 200, {});
    }
    if (m === "POST" && p === "/api/notes/settings-window") {
      shell.openSettings();
      return send(res, 200, {});
    }
    // 待办 (2026-11-01): the copy with what is not sent yet, a change, a sync now, its window, the platform to log in.
    if (m === "GET" && p === "/api/todo") return send(res, 200, shell.todo.view());
    if (m === "POST" && p === "/api/todo/ops") {
      const body = await json(req);
      if (!Array.isArray(body.ops) || !body.ops.length) throw new NotesError("bad_request", "ops must be a list of changes");
      if (!store.settings().useTodo) throw new NotesError("conflict", "待办已关闭");
      if (!shell.todo.view().account) throw new NotesError("conflict", "没有登录，待办用不了");
      return send(res, 200, shell.todo.change(body.ops as TodoOp[]));
    }
    if (m === "POST" && p === "/api/todo/sync") {
      void shell.todo.sync();
      return send(res, 200, shell.todo.view());
    }
    if (m === "POST" && p === "/api/notes/todo-window") {
      shell.showTodo();
      return send(res, 200, {});
    }
    if (m === "POST" && p === "/api/notes/open-platform") return send(res, 200, { opened: shell.openPlatform() });
    if (m === "POST" && p === "/api/notes/import") {
      const body = await json(req);
      const result = store.importFromStudio(body as never);
      announce();
      return send(res, 200, result);
    }
    throw new NotesError("not_found", `no route ${m} ${p}`);
  }

  /** The UI build, as the Host serves it (index.html for the page itself). */
  function staticFile(res: ServerResponse, url: URL): void {
    const root = resolve(o.uiDir);
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = normalize(join(root, rel));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": rel === "index.html" ? "no-store" : "public, max-age=3600" });
    res.end(readFileSync(file));
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith("/api/")) return staticFile(res, url);
    if (!authorised(req, url)) return send(res, 401, { error: { code: "unauthorized", message: "token required" } });
    api(req, res, url).catch((err: unknown) => {
      if (err instanceof NotesError) send(res, STATUS[err.code], { error: { code: err.code, message: err.message } });
      else send(res, 500, { error: { code: "internal", message: err instanceof Error ? err.message : String(err) } });
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/api/events" || !authorised(req, url)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
    });
  });

  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(o.port ?? 0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      ok({
        url: `http://127.0.0.1:${port}`,
        token,
        announce: () => announce(),
        announceTodo: (view) => {
          const msg = JSON.stringify({ type: "todo.updated", todo: view, seq: ++seq });
          for (const ws of sockets) ws.send(msg);
        },
        close: () =>
          new Promise<void>((done) => {
            for (const ws of sockets) ws.terminate();
            wss.close();
            server.close(() => done());
          }),
      });
    });
  });
}
