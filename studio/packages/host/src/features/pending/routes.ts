import type { HostService } from "../../service.js";
import { route, type Route } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function pendingRoutes(service: HostService): Route[] {
  return [
    route("GET /api/pending", () => service.pending.snapshot()),
    route("POST /api/pending/mark", ({ body }) => service.pending.mark((body ?? {}) as never)),
    route("POST /api/pending/patrol", ({ body }) => service.pending.patrol((body as { sessionIds?: unknown } | null)?.sessionIds)),
  ];
}
