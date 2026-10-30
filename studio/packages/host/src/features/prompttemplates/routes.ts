import type { HostService } from "../../service.js";
import { obj, route, type Route } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function promptTemplatesRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/prompt-templates", ({ query }) => service.promptTemplates.list(query.get("workspace") ?? undefined)),
    route("POST", "/api/prompt-templates", ({ body }) => service.promptTemplates.create(obj(body) as never)),
    route("PATCH", "/api/prompt-templates/:id", ({ params, body }) => service.promptTemplates.update(params.id!, obj(body) as never)),
    route("DELETE", "/api/prompt-templates/:id", ({ params }) => (service.promptTemplates.remove(params.id!), { ok: true })),
  ];
}
