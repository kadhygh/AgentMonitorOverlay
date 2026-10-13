import type { HostService } from "../../service.js";
import { route, type Route, obj } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function topicsRoutes(service: HostService): Route[] {
  return [
    route("POST", "/api/topics", ({ body }) => service.topics.createTopic(obj(body))),
    route("PATCH", "/api/topics/:id", ({ params, body }) => service.topics.updateTopic(params.id!, obj(body))),
    route("POST", "/api/topics/:id/archive", ({ params }) => service.topics.archiveTopic(params.id!)),
    route("POST", "/api/topics/:id/unarchive", ({ params }) => service.topics.unarchiveTopic(params.id!)),
    route("POST", "/api/topics/:id/sessions", ({ params, body }) => service.topics.addTopicSession(params.id!, obj(body) as never)),
  ];
}
