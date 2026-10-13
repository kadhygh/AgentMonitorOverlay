import type { HostService } from "../../service.js";
import { route, type Route, obj } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function scratchpadRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/scratchpad", () => service.scratchpad.scratchpad()),
    route("PATCH", "/api/scratchpad", ({ body }) => service.scratchpad.update(obj(body))),
    route("PUT", "/api/scratchpad/pages/:page", ({ params, body }) => service.scratchpad.savePage(params.page!, obj(body))),
  ];
}
