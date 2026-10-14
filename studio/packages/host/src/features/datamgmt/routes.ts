import type { HostService } from "../../service.js";
import { route, type Route, obj } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function dataRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/data/archived", () => service.data.archived()),
    route("GET", "/api/data/purge", ({ query }) => service.data.preview(query.get("kind"), query.get("id"))),
    route("POST", "/api/data/purge", ({ body }) => {
      const b = obj(body);
      return service.data.purge(b.kind, b.id);
    }),
  ];
}
