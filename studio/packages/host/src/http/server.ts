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

export interface RouteContext {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export type RouteHandler = (ctx: RouteContext) => Promise<unknown | typeof NOT_MATCHED> | unknown | typeof NOT_MATCHED;
export const NOT_MATCHED = Symbol("not matched");

export interface HostServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

type Route = { method: string; pattern: RegExp; keys: string[]; handle: (ctx: RouteContext) => unknown };

function route(method: string, path: string, handle: (ctx: RouteContext) => unknown): Route {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:([A-Za-z]+)/g, (_, k: string) => (keys.push(k), "([^/]+)"))}$`);
  return { method, pattern, keys, handle };
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
  const str = (v: unknown, name: string) => {
    if (typeof v !== "string") throw new HostError("bad_request", `${name} must be a string`);
    return v;
  };
  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

  const routes: Route[] = [
    route("GET", "/api/state", () => service.snapshot()),
    route("POST", "/api/workspaces", ({ body }) => {
      const b = obj(body);
      return service.addWorkspace({ path: str(b.path, "path"), ...(typeof b.name === "string" ? { name: b.name } : {}) });
    }),
    route("DELETE", "/api/workspaces/:id", ({ params }) => (service.removeWorkspace(params.id!), { ok: true })),
    route("GET", "/api/workspaces/:id/packs", ({ params }) => service.packs(params.id!)),
    route("GET", "/api/workspaces/:id/packs/:pack/docs/:doc", ({ params }) => service.packDoc(params.id!, params.pack!, params.doc!)),
    route("POST", "/api/workspaces/:id/packs/:pack/presets/:preset/draft", ({ params, body }) => service.presetDraft(params.id!, params.pack!, params.preset!, obj(body).taskId)),
    route("POST", "/api/tasks", ({ body }) => service.createTask(obj(body) as never)),
    route("PATCH", "/api/tasks/:id", ({ params, body }) => service.updateTask(params.id!, obj(body) as never)),
    route("POST", "/api/tasks/:id/sessions", ({ params, body }) => service.addSession(params.id!, obj(body) as never)),
    route("GET", "/api/sessions/:id/items", ({ params, query }) => service.items(params.id!, Number(query.get("after") ?? 0) || 0)),
    route("POST", "/api/sessions/:id/messages", ({ params, body }) => service.sendMessage(params.id!, str(obj(body).text, "text"))),
    route("POST", "/api/sessions/:id/interrupt", async ({ params }) => (await service.interrupt(params.id!), { ok: true })),
    route("POST", "/api/sessions/:id/fork", ({ params, body }) => {
      const p = obj(body).profileId;
      return service.fork(params.id!, typeof p === "string" ? p : undefined);
    }),
    route("POST", "/api/sessions/:id/archive", ({ params }) => service.archive(params.id!)),
    route("POST", "/api/sessions/:id/unarchive", ({ params }) => service.unarchive(params.id!)),
    route("POST", "/api/sessions/:id/terminal", ({ params, body }) => service.terminal(params.id!, obj(body).launch === true)),
    route("POST", "/api/sessions/:id/reclaim", ({ params }) => service.reclaim(params.id!)),
    route("GET", "/api/todos", () => service.todos()),
    route("POST", "/api/todos", ({ body }) => service.addTodo(obj(body))),
    route("PATCH", "/api/todos/:id", ({ params, body }) => service.updateTodo(params.id!, obj(body))),
    route("POST", "/api/todos/:id/convert", ({ params, body }) => service.convertTodo(params.id!, obj(body))),
    route("DELETE", "/api/todos/:id", ({ params }) => (service.deleteTodo(params.id!), { ok: true })),
    route("GET", "/api/checklist", ({ query }) => service.checklist(query.get("taskId") ?? undefined)),
    route("PATCH", "/api/checklist/:id", ({ params, body }) => service.setChecklistDone(params.id!, obj(body).done)),
    route("GET", "/api/tasks/:id/notes", ({ params }) => service.taskNotes(params.id!)),
    route("POST", "/api/tasks/:id/notes", ({ params, body }) => service.addTaskNote(params.id!, obj(body))),
    route("GET", "/api/mail", ({ query }) =>
      service.mail({
        ...(query.get("sessionId") ? { sessionId: query.get("sessionId")! } : {}),
        ...(query.get("taskId") ? { taskId: query.get("taskId")! } : {}),
        ...(query.get("forTask") ? { forTaskId: query.get("forTask")! } : {}),
        ...(query.get("state") ? { states: query.get("state")!.split(",") as never } : {}),
      }),
    ),
    route("POST", "/api/mail", ({ body }) => service.sendMail(null, obj(body).to, obj(body).text)),
    route("PATCH", "/api/mail/:id", ({ params, body }) => service.updateMail(params.id!, obj(body).state)),
    route("POST", "/api/mail/:id/forward", ({ params, body }) => service.forwardMail(params.id!, obj(body))),
    route("GET", "/api/decisions", ({ query }) => service.decisions(query.get("state") ? { state: query.get("state") as never } : {})),
    route("POST", "/api/decisions/:id/answer", ({ params, body }) => service.answerDecision(params.id!, obj(body).answer)),
    route("GET", "/api/proposals", ({ query }) => service.proposals(query.get("state") ? { state: query.get("state") as never } : {})),
    route("POST", "/api/proposals", ({ body }) => service.propose(obj(body))),
    route("POST", "/api/proposals/:id/approve", ({ params, body }) => service.approveProposal(params.id!, obj(body))),
    route("POST", "/api/proposals/:id/reject", ({ params }) => service.rejectProposal(params.id!)),
    route("GET", "/api/canvas", () => service.canvas()),
    route("PUT", "/api/canvas", ({ body }) => service.saveCanvas(body)),
    route("GET", "/api/canvas/outline", () => service.canvasOutline()),
    route("GET", "/api/scratchpad", () => service.scratchpad()),
    route("PUT", "/api/scratchpad", ({ body }) => service.saveScratchpad(obj(body).text)),
    route("GET", "/api/sessions/:id/annotations", ({ params }) => service.annotations(params.id!)),
    route("POST", "/api/sessions/:id/annotations/send", ({ params }) => service.sendAnnotations(params.id!)),
    route("POST", "/api/sessions/:id/annotations", ({ params, body }) => service.addAnnotation(params.id!, obj(body) as never)),
    route("PATCH", "/api/annotations/:id", ({ params, body }) => service.updateAnnotation(params.id!, obj(body).note as string)),
    route("DELETE", "/api/annotations/:id", ({ params }) => (service.deleteAnnotation(params.id!), { ok: true })),
    route("POST", "/api/approvals/:approvalId", async ({ params, body }) => {
      const b = obj(body);
      await service.respondApproval(str(b.sessionId, "sessionId"), params.approvalId!, b.decision as never);
      return { ok: true };
    }),
  ];

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
    const given = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!(isMcp ? mcpTokenOk(given) : tokenOk(given))) return fail(res, 401, "bad_request", "missing or invalid host token");
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
      const body = req.method === "GET" || req.method === "DELETE" ? undefined : await readBody(req);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
        return send(res, 200, await r.handle({ method: req.method!, path: url.pathname, params, query: url.searchParams, body }));
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
      ws.on("close", () => sockets.delete(ws));
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
