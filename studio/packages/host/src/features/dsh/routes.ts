import type { HostService } from "../../service.js";
import { route, type Route, obj } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function dshRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/dsh", () => service.dsh.status()),
    route("PUT", "/api/dsh", ({ body }) => service.dsh.setPath(obj(body).path)),
    route("POST", "/api/dsh/check", () => service.dsh.check()),
  ];
}
