import type { HostService } from "../../service.js";
import { route, type Route } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function relaysRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/relays", () => service.relays.list()),
    route("POST", "/api/relays/:id/deliver", ({ params }) => service.relays.deliver(params.id!)),
    route("POST", "/api/relays/:id/dismiss", ({ params }) => service.relays.dismiss(params.id!)),
  ];
}
