import type { HostService } from "../../service.js";
import { route, type Route, obj } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function agyRoutes(service: HostService): Route[] {
  return [
    route("GET /api/agy", () => service.agy.status()),
    route("PUT /api/agy", ({ body }) => service.agy.update(obj(body))),
    route("POST /api/agy/check", () => service.agy.check()),
    route("POST /api/agy/login", () => service.agy.login()),
  ];
}
