import type { HostService } from "../../service.js";
import { route, type Route } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function filesRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/workspaces/:id/files/recent", ({ params, query }) => service.files.recent(params.id!, query.get("limit"))),
    route("GET", "/api/workspaces/:id/files", ({ params, query }) => service.files.list(params.id!, query.get("q") ?? "", query.get("limit"))),
  ];
}
