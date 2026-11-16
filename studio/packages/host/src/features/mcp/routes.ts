import type { HostService } from "../../service.js";
import { obj, route, type Route } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function mcpRoutes(service: HostService): Route[] {
  return [
    route("GET /api/mcp", () => service.mcp.state()),
    route("PUT /api/mcp", ({ body }) => service.mcp.setGlobal(obj(body))),
    route("POST /api/mcp/servers", ({ body }) => service.mcp.create(obj(body))),
    route("PATCH /api/mcp/servers/:id", ({ params, body }) => service.mcp.update(params.id!, obj(body))),
    route("DELETE /api/mcp/servers/:id", ({ params }) => (service.mcp.remove(params.id!), { ok: true })),
    route("GET /api/mcp/projects/:id", ({ params }) => service.mcp.project(params.id!)),
    route("PUT /api/mcp/projects/:id", ({ params, body }) => service.mcp.setProject(params.id!, obj(body))),
    // A remote task's copy (2026-11-17): its session's MCP is the computer's it runs on, read and changed there.
    route("GET /api/sessions/:id/mcp", ({ params }) => (service.store.getSession(params.id!)?.runtime === "remote" ? service.remote.copies.sessionMcp(params.id!) : service.mcp.session(params.id!))),
    route("PUT /api/sessions/:id/mcp", ({ params, body }) => (service.store.getSession(params.id!)?.runtime === "remote" ? service.remote.copies.setSessionMcp(params.id!, obj(body)) : service.mcp.setSession(params.id!, obj(body))), { remoteCopy: "forward" }),
  ];
}
