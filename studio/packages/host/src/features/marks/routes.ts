import type { HostService } from "../../service.js";
import { obj, route, type Route } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function marksRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/file-marks", ({ query }) => service.marks.list(query.get("workspace") ?? undefined)),
    route("POST", "/api/file-marks", ({ body }) => service.marks.create(obj(body) as never)),
    route("PATCH", "/api/file-marks/:id", ({ params, body }) => service.marks.update(params.id!, obj(body) as never)),
    route("DELETE", "/api/file-marks/:id", ({ params }) => (service.marks.remove(params.id!), { ok: true })),
    route("GET", "/api/bookmarks", ({ query }) => service.marks.bookmarks(query.get("topic") ?? undefined)),
    route("POST", "/api/chat-marks", ({ body }) => service.marks.createChat(obj(body) as never)),
    route("PATCH", "/api/bookmarks/:id", ({ params, body }) => service.marks.updateBookmark(params.id!, obj(body) as never)),
    route("DELETE", "/api/bookmarks/:id", ({ params }) => (service.marks.removeBookmark(params.id!), { ok: true })),
  ];
}
