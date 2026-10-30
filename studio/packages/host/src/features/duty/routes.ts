import type { HostService } from "../../service.js";
import { route, type Route, obj } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function dutyRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/duty", () => service.duty.state()),
    route("POST", "/api/duty/items", ({ body }) => service.duty.create(obj(body))),
    route("PATCH", "/api/duty/items/:id", ({ params, body }) => service.duty.update(params.id!, obj(body))),
    route("DELETE", "/api/duty/items/:id", ({ params }) => service.duty.remove(params.id!)),
    route("POST", "/api/duty/items/:id/run", ({ params }) => service.duty.runNow(params.id!)),
  ];
}
