import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { HostErrorBody, HostEvent } from "@amo-studio/protocol";
import { HostError, type HostService } from "../service.js";
import { handleMcpRequest } from "../mcp/amo-mcp.js";
import { listenInStudioRange } from "../net.js";
import { FEATURES } from "../features/index.js";
import { sessionMoving } from "../features/tasks/service.js";
import { FileReply, route, str, obj, type Route, type RouteContext } from "./route.js";

export type { RouteContext } from "./route.js";
import type { McpIdentities } from "../mcp/identity.js";

// Host API over HTTP (REST) and WebSocket (events). Binds 127.0.0.1 only; every /api call needs the host token
// (Authorization: Bearer for REST, ?token= for the event socket since browsers cannot set WS headers).

export interface HostServerOptions {
  service: HostService;
  token: string;
  /** Opens /mcp only (given to agent processes, which must not reach the writable REST API). */
  mcpToken?: string;
  /** Maps the per-thread session header on /mcp back to a session (stage 5 writes). */
  mcpIdentities?: McpIdentities;
  port?: number;
  /** Built UI to serve at / (same origin as the API, so no CORS in production). */
  uiDir?: string;
  /** Extra origins allowed to call the API, e.g. the Vite dev server. */
  allowedOrigins?: readonly string[];
  /** Extra routes, e.g. terminal attach (S1-07b). Return undefined to fall through. */
  extraRoutes?: RouteHandler[];
}


export type RouteHandler = (ctx: RouteContext) => Promise<unknown | typeof NOT_MATCHED> | unknown | typeof NOT_MATCHED;
export const NOT_MATCHED = Symbol("not matched");

export interface HostServer {
  port: number;
  url: string;
  close(): Promise<void>;
}


const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export async function startHostServer(options: HostServerOptions): Promise<HostServer> {
  const { service } = options;

  const routes: Route[] = [
    route("GET", "/api/state", () => service.snapshot()),
    // The shell's keepalive asks this (2026-10-27): it answers at once, without building the whole state. 2026-10-28: also
    // without the token, with how many sessions are at work (counted as the board's 进行中, sessionMoving), so the AMO
    // platform can ask before it updates Studio. A number only: no titles or other content.
    route("GET", "/api/health", () => ({ ok: true, pid: process.pid, running: service.store.listSessions().filter(sessionMoving).length }), { open: true }),
    ...FEATURES.flatMap((f) => f.routes(service)),
  ];

  const match = (method: string, path: string): { route: Route; params: Record<string, string> } | undefined => {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(path);
      if (!m) continue;
      return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)])) };
    }
    return undefined;
  };

  const same = (given: string, expected: string) => {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const tokenOk = (given: string | null | undefined) => !!given && same(given, options.token);
  const mcpTokenOk = (given: string | null | undefined) => !!given && (same(given, options.token) || (!!options.mcpToken && same(given, options.mcpToken)));

  const allowed = new Set(options.allowedOrigins ?? []);
  const cors = (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("Vary", "Origin");
    }
  };

  const send = (res: ServerResponse, status: number, payload: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(payload));
  };
  const fail = (res: ServerResponse, status: number, code: HostErrorBody["error"]["code"], message: string) =>
    send(res, status, { error: { code, message } } satisfies HostErrorBody);
  const statusOf: Record<HostErrorBody["error"]["code"], number> = {
    bad_request: 400,
    not_found: 404,
    conflict: 409,
    read_only: 409,
    runtime_error: 502,
    internal: 500,
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<unknown>((resolveBody, reject) => {
      let data = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => {
        data += c;
        if (data.length > 1_000_000) reject(new HostError("bad_request", "body too large"));
      });
      req.on("end", () => {
        if (!data) return resolveBody(undefined);
        try {
          resolveBody(JSON.parse(data));
        } catch {
          reject(new HostError("bad_request", "invalid JSON"));
        }
      });
      req.on("error", reject);
    });

  const readRaw = (req: IncomingMessage, max: number) =>
    new Promise<Buffer>((resolveBody, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > max) {
          reject(new HostError("bad_request", `file too large (at most ${Math.round(max / 1024 / 1024)} MB)`));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolveBody(Buffer.concat(chunks)));
      req.on("error", reject);
    });

  const sendFile = (res: ServerResponse, file: FileReply) => {
    if (!existsSync(file.path)) return fail(res, 404, "not_found", "file not found");
    res.writeHead(200, { "content-type": file.mime, "cache-control": "private, max-age=31536000, immutable" });
    createReadStream(file.path).pipe(res);
  };

  const serveUi = (req: IncomingMessage, res: ServerResponse, path: string) => {
    if (!options.uiDir || (req.method !== "GET" && req.method !== "HEAD")) return false;
    const root = resolve(options.uiDir);
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return false; // malformed escape: answer 404 instead of throwing inside the request handler
    }
    let file = normalize(join(root, decoded));
    if (!file.startsWith(root + sep) && file !== root) return false;
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
    if (!existsSync(file)) return false;
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
    return true;
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    cors(req, res);
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    const isMcp = url.pathname === "/mcp";
    if (!url.pathname.startsWith("/api/") && !isMcp) {
      if (serveUi(req, res, url.pathname)) return;
      return fail(res, 404, "not_found", "not found");
    }
    const auth = req.headers.authorization;
    const matched = isMcp ? undefined : match(req.method ?? "GET", url.pathname);
    // An <img> cannot send a header: routes that allow it take the token from the query (GET only).
    const given = auth?.startsWith("Bearer ") ? auth.slice(7) : matched?.route.queryToken && req.method === "GET" ? url.searchParams.get("token") : null;
    const open = !!matched?.route.open && req.method === "GET";
    if (!open && !(isMcp ? mcpTokenOk(given) : tokenOk(given))) return fail(res, 401, "bad_request", "missing or invalid host token");
    if (isMcp) {
      // AMO MCP (read-only): the same token as the REST API.
      try {
        return await handleMcpRequest(options.service, req, res, req.method === "POST" ? await readBody(req) : undefined, options.mcpIdentities);
      } catch (err) {
        if (!res.headersSent) return fail(res, err instanceof HostError ? statusOf[err.code] : 500, err instanceof HostError ? err.code : "internal", String((err as Error).message ?? err));
        return;
      }
    }
    try {
      const body =
        req.method === "GET" || req.method === "DELETE" ? undefined : matched?.route.rawBody ? await readRaw(req, matched.route.rawBody) : await readBody(req);
      if (matched) {
        const out = await matched.route.handle({ method: req.method!, path: url.pathname, params: matched.params, query: url.searchParams, body });
        return out instanceof FileReply ? sendFile(res, out) : send(res, 200, out);
      }
      for (const extra of options.extraRoutes ?? []) {
        const out = await extra({ method: req.method ?? "GET", path: url.pathname, params: {}, query: url.searchParams, body });
        if (out !== NOT_MATCHED) return send(res, 200, out);
      }
      return fail(res, 404, "not_found", `no route for ${req.method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof HostError) return fail(res, statusOf[err.code], err.code, err.message);
      return fail(res, 500, "internal", (err as Error).message ?? String(err));
    }
  });

  // Event stream: backlog after ?since=, then live events.
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const origin = req.headers.origin;
    const originOk = !origin || allowed.has(origin) || origin === `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (url.pathname !== "/api/events" || !tokenOk(url.searchParams.get("token")) || !originOk) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      service.liveWindows++;
      ws.on("close", () => {
        sockets.delete(ws);
        service.liveWindows--;
      });
      const since = Number(url.searchParams.get("since") ?? 0) || 0;
      let cursor = since;
      for (;;) {
        const batch = service.store.listEvents(cursor, 1000);
        for (const e of batch) ws.send(JSON.stringify(e));
        if (batch.length < 1000) break;
        cursor = batch.at(-1)!.seq;
      }
    });
  });
  const broadcast = (e: HostEvent) => {
    const payload = JSON.stringify(e);
    for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(payload);
  };
  service.on("event", broadcast);

  // Port 0 (tests, e2e): a free port in Studio's range, never an arbitrary one (red line 6).
  if (options.port) await new Promise<void>((r) => server.listen(options.port, "127.0.0.1", r));
  else await listenInStudioRange(server);
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        service.off("event", broadcast);
        for (const ws of sockets) ws.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
