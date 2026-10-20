import type { HostService } from "../../service.js";
import { route, type Route } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function maintenanceRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/maintenance", () => service.maintenance.info()),
    route("POST", "/api/maintenance/terminal", ({ body }) => service.maintenance.openTerminal(body)),
  ];
}
