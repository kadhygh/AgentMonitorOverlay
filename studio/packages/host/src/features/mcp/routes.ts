import type { HostService } from "../../service.js";
import { obj, route, type Route } from "../../http/route.js";
import { HostError } from "../../core/shared.js";

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
    // 新会话 / 新任务 (2026-11-17): a task's new session (a remote task's copy: read on the computer it runs on), or a new
    // task's in a project (none: the common folder).
    route("GET /api/mcp/offer", ({ query }) => {
      const profileId = query.get("profile") ?? "";
      const taskId = query.get("task");
      if (taskId) {
        const task = service.store.getTask(taskId);
        if (!task) throw new HostError("not_found", "任务已经不在了");
        return task.remote ? service.remote.copies.taskMcp(task, profileId) : service.mcp.offer(task.workspaceId, task.id, profileId);
      }
      return service.mcp.offer(query.get("workspace") || null, null, profileId);
    }),
    route("PUT /api/sessions/:id/mcp", ({ params, body }) => (service.store.getSession(params.id!)?.runtime === "remote" ? service.remote.copies.setSessionMcp(params.id!, obj(body)) : service.mcp.setSession(params.id!, obj(body))), { remoteCopy: "forward" }),
  ];
}
