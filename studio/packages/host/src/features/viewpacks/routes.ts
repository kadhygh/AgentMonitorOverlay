import type { HostService } from "../../service.js";
import { obj, route, type Route } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function viewPacksRoutes(service: HostService): Route[] {
  return [
    route("POST", "/api/viewpacks", ({ body }) => service.viewPacks.open(obj(body))),
    route("GET", "/api/viewpacks", ({ query }) => service.viewPacks.list(query.get("sessionId"))),
    route("GET", "/api/viewpacks/:id", ({ params }) => service.viewPacks.get(params.id!)),
    route("GET", "/api/viewpacks/:id/items/:itemId/diff", ({ params }) => service.viewPacks.diff(params.id!, params.itemId!)),
  ];
}
