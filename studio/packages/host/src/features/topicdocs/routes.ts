import type { HostService } from "../../service.js";
import { obj, route, type Route } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function topicDocsRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/topics/:id/docs", ({ params }) => service.topicDocs.list(params.id!)),
    route("POST", "/api/topics/:id/docs", ({ params, body }) => service.topicDocs.create(params.id!, obj(body) as never)),
    route("PATCH", "/api/topic-docs/:id", ({ params, body }) => service.topicDocs.update(params.id!, obj(body) as never)),
    route("DELETE", "/api/topic-docs/:id", ({ params }) => (service.topicDocs.remove(params.id!), { ok: true })),
  ];
}
