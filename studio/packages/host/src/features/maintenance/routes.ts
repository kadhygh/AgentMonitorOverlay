import type { HostService } from "../../service.js";
import { obj, route, type Route } from "../../http/route.js";
import { HostError } from "../../core/shared.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function maintenanceRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/maintenance", () => service.maintenance.info()),
    route("POST", "/api/maintenance/terminal", ({ body }) => {
      const cli = obj(body).cli ?? "claude";
      if (cli !== "claude" && cli !== "codex") throw new HostError("bad_request", "cli must be claude or codex");
      return service.maintenance.openTerminal(cli);
    }),
  ];
}
