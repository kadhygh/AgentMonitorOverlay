import type { HostService } from "../../service.js";
import { route, type Route, str, obj } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function sessionsRoutes(service: HostService): Route[] {
  return [
    route("PATCH", "/api/sessions/:id/options", ({ params, body }) => service.sessions.updateSessionOptions(params.id!, body)),
    route("PATCH", "/api/sessions/:id", ({ params, body }) => service.sessions.renameSession(params.id!, obj(body).title)),
    route("GET", "/api/sessions/:id/items", ({ params, query }) => service.sessions.items(params.id!, Number(query.get("after") ?? 0) || 0)),
    route("POST", "/api/sessions/:id/messages", ({ params, body }) => service.sessions.sendMessage(params.id!, str(obj(body).text, "text"))),
    route("POST", "/api/sessions/:id/interrupt", async ({ params }) => (await service.sessions.interrupt(params.id!), { ok: true })),
    route("POST", "/api/sessions/:id/fork", ({ params, body }) => {
      const p = obj(body).profileId;
      return service.sessions.fork(params.id!, typeof p === "string" ? p : undefined);
    }),
    route("POST", "/api/sessions/:id/archive", ({ params }) => service.sessions.archive(params.id!)),
    route("POST", "/api/sessions/:id/unarchive", ({ params }) => service.sessions.unarchive(params.id!)),
    route("POST", "/api/sessions/:id/terminal", ({ params, body }) => service.sessions.terminal(params.id!, obj(body).launch === true)),
    route("POST", "/api/sessions/:id/reclaim", ({ params }) => service.sessions.reclaim(params.id!)),
    route("POST", "/api/approvals/:approvalId", async ({ params, body }) => {
      const b = obj(body);
      await service.sessions.respondApproval(str(b.sessionId, "sessionId"), params.approvalId!, b.decision as never);
      return { ok: true };
    }),
  ];
}
