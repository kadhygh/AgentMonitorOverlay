import type { HostService } from "../../service.js";
import { route, type Route } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function teamRelayRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/teamrelay/sends", () => service.teamRelay.sends()),
    route("POST", "/api/teamrelay/sends/:id/send", ({ params }) => service.teamRelay.send(params.id!)),
    route("POST", "/api/teamrelay/sends/:id/dismiss", ({ params }) => service.teamRelay.dismiss(params.id!)),
    route("GET", "/api/teamrelay/threads", () => service.teamRelay.threads()),
  ];
}
